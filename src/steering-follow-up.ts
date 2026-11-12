import type { OpenCodeClient } from "@opencode/client"
import { remainingTime, withDeadline } from "./deadline.js"
import type { HostReviewEvidence } from "./host-evidence.js"
import type { HostRequest, JSONValue } from "./host-types.js"
import { codeModeToolAction } from "./host-tool-kind.js"
import { transportOwnership } from "./transport-ownership.js"
import { lineCount, trailingLines } from "./truncate.js"
import type { ReviewKind } from "./types.js"

/** Review category of a native permission action, matching the host candidate
 * classification. Native actions without their own review category have none. */
export function followUpCategory(action: string): ReviewKind | undefined {
  return action === "shell" ? "shell" : action === "edit" ? "edit" : action === "external_directory" ? "external-directory"
    : action === "skill" ? "skill" : codeModeToolAction(action) ? "tool" : undefined
}

/** Compact summary of a rejected operation: category, tool and its main input. */
export interface RejectedOperation {
  category: ReviewKind
  tool: string
  input: JSONValue
}

interface ReviewedOperation {
  rejected: RejectedOperation
  /** The steered request belongs to the root conversation session. */
  root: boolean
  rootMessageID?: string
}

/** One confirmed steering rejection waiting for the agent's corrected request. */
export interface SteeringRecord extends ReviewedOperation {
  sessionID: string
  assistantID: string
  callID: string
  message: string
}

interface Seen { sessionID: string; assistantID: string; callID: string; category?: ReviewKind; paired?: SteeringRecord }

const summaryInputBytes = 8192
const maxReviewed = 256
const maxCalls = 1024
const maxSeen = 16384

function summaryInput(value: JSONValue): JSONValue {
  return Buffer.byteLength(JSON.stringify(value)) <= summaryInputBytes ? value
    : { omitted: "Input exceeds the 8 KiB summary limit." }
}

/** Compact summary of reviewed evidence, never diffs, descriptions or schemas. */
export function rejectedOperation(evidence: HostReviewEvidence): RejectedOperation {
  const input = evidence.kind === "shell" ? { command: evidence.command, cwd: evidence.cwd }
    : evidence.kind === "edit" ? { ...evidence.operation.input,
      ...(evidence.operation.patchOperations ? { patchOperations: evidence.operation.patchOperations as unknown as JSONValue } : {}) }
    : evidence.kind === "external-directory" ? { ...evidence.operation.input, directories: evidence.permission.resources }
    : evidence.operation.input
  return { category: evidence.kind, tool: evidence.tool, input: summaryInput(input) }
}

const callKey = (sessionID: string, assistantID: string, callID: string) => `${sessionID}\0${assistantID}\0${callID}`

/** In-memory steering follow-up state for one review composition. Nothing is
 * persisted or carried across reconnection. Pairing follows request arrival order. */
export class SteeringFollowUps {
  private reviewed = new Map<string, ReviewedOperation>()
  private open = new Map<string, SteeringRecord[]>()
  private calls = new Map<string, SteeringRecord>()
  private seen = new Map<string, Seen>()

  /** Summary of a validated review's evidence, keyed by review ID. */
  observe(review: string, evidence: HostReviewEvidence) {
    this.reviewed.delete(review)
    this.reviewed.set(review, { rejected: rejectedOperation(evidence),
      root: evidence.conversation.current.id === evidence.conversation.root.id,
      ...(evidence.conversation.rootMessageID ? { rootMessageID: evidence.conversation.rootMessageID } : {}) })
    for (const key of this.reviewed.keys()) { if (this.reviewed.size <= maxReviewed) break; this.reviewed.delete(key) }
  }

  /** A confirmed native steering rejection opens a record for its session. */
  steered(request: HostRequest, review: string, message: string) {
    const reviewed = this.reviewed.get(review)
    this.reviewed.delete(review)
    if (!reviewed || !request.source) return
    const queue = (this.open.get(request.sessionID) ?? []).filter(record =>
      // A newer root user message ends older root-session steerings.
      !(reviewed.root && record.root && record.rootMessageID !== reviewed.rootMessageID))
    queue.push({ ...reviewed, sessionID: request.sessionID, assistantID: request.source.assistantID, callID: request.source.id, message })
    this.open.set(request.sessionID, queue)
  }

  /** Pair a newly seen request: the same tool call shares one steering, otherwise
   * the oldest open steering of the same category from an earlier assistant step. */
  asked(request: HostRequest) {
    if (this.seen.has(request.id) || !request.source) return
    const { sessionID } = request, { assistantID, id: callID } = request.source
    const category = followUpCategory(request.action)
    const key = callKey(sessionID, assistantID, callID)
    let paired = this.calls.get(key)
    if (!paired && category) {
      const queue = this.open.get(sessionID) ?? []
      const index = queue.findIndex(record => record.assistantID !== assistantID && record.rejected.category === category)
      if (index >= 0) {
        paired = queue.splice(index, 1)[0]!
        if (!queue.length) this.open.delete(sessionID)
        this.calls.set(key, paired)
        for (const old of this.calls.keys()) { if (this.calls.size <= maxCalls) break; this.calls.delete(old) }
      }
    }
    this.seen.set(request.id, { sessionID, assistantID, callID, ...(category ? { category } : {}), ...(paired ? { paired } : {}) })
    for (const old of this.seen.keys()) { if (this.seen.size <= maxSeen) break; this.seen.delete(old) }
  }

  paired(requestID: string): SteeringRecord | undefined { return this.seen.get(requestID)?.paired }

  /** An approval of an unpaired request from a later assistant step drops the
   * session's open steerings of its category. Every reply ends request tracking. */
  replied(sessionID: string, requestID: string, decision: string) {
    const seen = this.seen.get(requestID)
    this.seen.delete(requestID)
    if (!seen || seen.sessionID !== sessionID || seen.paired || !seen.category || (decision !== "once" && decision !== "always")) return
    const queue = this.open.get(sessionID)?.filter(record => record.assistantID === seen.assistantID || record.rejected.category !== seen.category)
    if (queue?.length) this.open.set(sessionID, queue)
    else this.open.delete(sessionID)
  }

  deleted(sessionID: string) {
    this.open.delete(sessionID)
    for (const [id, seen] of this.seen) if (seen.sessionID === sessionID) this.seen.delete(id)
    for (const [key, record] of this.calls) if (record.sessionID === sessionID) this.calls.delete(key)
  }

  clear() { this.reviewed.clear(); this.open.clear(); this.calls.clear(); this.seen.clear() }

  /** Open records, oldest first, for tests and diagnostics. */
  pending(sessionID: string): readonly SteeringRecord[] { return [...this.open.get(sessionID) ?? []] }
}

export type AgentOutputItem =
  | { type: "text" | "reasoning"; text: string; truncated?: { includedLines: number; omittedLines: number } }
  | { type: "tool"; tool: string; input: JSONValue; inputOmitted?: string }

export interface SteeringFollowUpEvidence {
  steeringMessage: string
  rejectedOperation: RejectedOperation
  /** Agent output from just after the rejected call to just before this call, oldest first. */
  agentOutput: AgentOutputItem[]
  /** Older output items dropped by the 16 KiB limit. */
  omittedOlderItems?: number
}

export type FollowUpReader = { message: Pick<OpenCodeClient["message"], "list"> }

const outputBytes = 16384
const pageSize = 100
const maxPages = 4

class InvalidOutput extends Error {}

type Part = AgentOutputItem & { id?: string }

function parts(message: unknown): { id: string; content: Part[] } {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new InvalidOutput()
  const value = message as Record<string, unknown>
  if (value.type !== "assistant" || typeof value.id !== "string" || !value.id || !Array.isArray(value.content)) throw new InvalidOutput()
  const content: Part[] = []
  for (const part of value.content as unknown[]) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new InvalidOutput()
    const item = part as Record<string, unknown>
    if (item.type === "text" || item.type === "reasoning") {
      if (typeof item.text !== "string") throw new InvalidOutput()
      if (item.text.trim()) content.push({ type: item.type, text: item.text.trim() })
    } else if (item.type === "tool") {
      const state = item.state as Record<string, unknown> | undefined
      if (typeof item.id !== "string" || typeof item.name !== "string" || !state || typeof state !== "object"
        || !Object.hasOwn(state, "input")) throw new InvalidOutput()
      content.push({ type: "tool", id: item.id, tool: item.name, input: state.input as JSONValue })
    }
  }
  return { id: value.id, content }
}

/** Keep the newest output within the byte limit, cutting one item to its trailing lines. */
export function boundAgentOutput(items: AgentOutputItem[]): Pick<SteeringFollowUpEvidence, "agentOutput" | "omittedOlderItems"> {
  const kept: AgentOutputItem[] = []
  let remaining = outputBytes, index = items.length - 1
  for (; index >= 0; index--) {
    const item = items[index]!, size = Buffer.byteLength(JSON.stringify(item))
    if (size <= remaining) { kept.push(item); remaining -= size; continue }
    if (item.type === "tool") {
      const reduced: AgentOutputItem = { type: "tool", tool: item.tool, input: null, inputOmitted: "Input exceeds the remaining 16 KiB output limit." }
      const reducedSize = Buffer.byteLength(JSON.stringify(reduced))
      if (reducedSize <= remaining) { kept.push(reduced); index-- }
    } else {
      // JSON escaping can grow text, so shrink the raw budget until the item fits.
      const total = lineCount(item.text)
      for (let budget = remaining; budget > 0;) {
        const tail = trailingLines(item.text, budget)
        if (!tail.lines) break
        const cut: AgentOutputItem = { type: item.type, text: tail.text, truncated: { includedLines: tail.lines, omittedLines: total - tail.lines } }
        const excess = Buffer.byteLength(JSON.stringify(cut)) - remaining
        if (excess <= 0) { kept.push(cut); index--; break }
        budget = Math.min(tail.bytes, budget) - excess
      }
    }
    break
  }
  const omitted = index + 1
  return { agentOutput: kept.reverse(), ...(omitted > 0 ? { omittedOlderItems: omitted } : {}) }
}

/** Agent output between the steered call and this call, read through the public
 * session messages. Any unavailable or inconsistent read yields no follow-up. */
export async function readSteeringFollowUp(reader: FollowUpReader, record: SteeringRecord, request: HostRequest,
  signal: AbortSignal): Promise<SteeringFollowUpEvidence | undefined> {
  if (!request.source || request.sessionID !== record.sessionID) return
  const source = request.source
  try {
    return await withDeadline(signal, Math.min(5000, remainingTime(signal) / 3), async readSignal => {
      const between: Part[][] = []
      let cursor: string | undefined, foundCurrent = false
      for (let page = 0; page < maxPages; page++) {
        readSignal.throwIfAborted()
        const pending = reader.message.list(cursor === undefined
          ? { sessionID: record.sessionID, type: "assistant", order: "desc", limit: pageSize }
          : { sessionID: record.sessionID, type: "assistant", cursor, limit: pageSize }, { signal: readSignal })
        transportOwnership(readSignal)?.track(pending)
        const result = await pending
        readSignal.throwIfAborted()
        if (!result || !Array.isArray(result.data) || result.data.length > pageSize) throw new InvalidOutput()
        for (const raw of result.data as unknown[]) {
          const message = parts(raw)
          if (!foundCurrent) {
            if (message.id !== source.assistantID) continue
            foundCurrent = true
            const at = message.content.findIndex(part => part.type === "tool" && part.id === source.id)
            if (at < 0) throw new InvalidOutput()
            if (message.id === record.assistantID) throw new InvalidOutput()
            between.push(message.content.slice(0, at))
            continue
          }
          if (message.id === record.assistantID) {
            const at = message.content.findIndex(part => part.type === "tool" && part.id === record.callID)
            if (at < 0) throw new InvalidOutput()
            between.push(message.content.slice(at + 1))
            const items = between.reverse().flat().map(({ id: _, ...item }) => item as AgentOutputItem)
            return { steeringMessage: record.message, rejectedOperation: record.rejected, ...boundAgentOutput(items) }
          }
          between.push(message.content)
        }
        const next = result.cursor?.next
        if (typeof next !== "string" || !next || !result.data.length) return undefined
        cursor = next
      }
      return undefined
    }, "Steering follow-up lookup")
  } catch {
    // Parent cancellation still propagates. Every other failure means no follow-up.
    signal.throwIfAborted()
    return undefined
  }
}
