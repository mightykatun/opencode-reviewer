import { boundedCopy } from "./tool-evidence.js"
import type { CompanionHandshake } from "./companion-protocol.js"
import { boundedHostJSON } from "./host-request.js"
import type { CodeModeCandidates, JSONObject } from "./host-types.js"

export interface CapturedCall {
  sessionID: string
  assistantID: string
  callID: string
  tool: string
  input: Record<string, unknown>
  scope: Pick<CompanionHandshake, "epoch" | "location">
  project: CompanionHandshake["project"]
}

type HookCall = { sessionID: string; messageID: string; id: string; tool: string; input: unknown }
const maxBytes = 16 * 1024 * 1024
const maxCalls = 512
const maxOverflow = 16384
const maxCandidates = 64
const identity = (session: string, assistant: string, call: string) => JSON.stringify([session, assistant, call])
const validID = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
const wireExact = (value: unknown): boolean => typeof value === "number" ? !Object.is(value, -0)
  : value !== null && typeof value === "object" ? Object.values(value).every(wireExact) : true

type Capture = { value?: CapturedCall; bytes: number; pending: number; ambiguous?: boolean;
  codeMode?: { calls: { tool: string; input: JSONObject }[]; omitted: number; active: boolean; message: string } }

/** Live observation, never reconstruction from permission arrival or outer code.
 * Duplicate keys never identify an inner call. Code Mode retains bounded candidate
 * observations for a judge to assess uncertainty. Overflow retains identity tombstones,
 * never evicts a pending capture and never admits a still-running rejected sibling.
 * Native execution never depends on these observations.
 *
 * Older hosts give inner Code Mode calls the outer call's ID. Newer hosts give each
 * inner call its own ID and expose no parent link. A distinct-ID call is therefore
 * recorded as a possible candidate of every Code Mode call still running in the same
 * session and assistant message, never as a chosen parent. It also keeps its own
 * capture for direct review.
 */
export class InvocationCapture {
  private readonly calls = new Map<string, Capture>()
  /** Running Code Mode captures by session and assistant message. */
  private readonly outers = new Map<string, Set<string>>()
  private readonly overflow = new Map<string, number>()
  private bytes = 0
  private available = true
  private readonly handshake: CompanionHandshake

  constructor(handshake: CompanionHandshake) {
    this.handshake = structuredClone(handshake)
  }

  before(event: HookCall): void {
    if (!this.available) return
    let key: string | undefined
    let observeDistinct = false
    try {
      if (![event.sessionID, event.messageID, event.id, event.tool].every(validID)) return
      key = identity(event.sessionID, event.messageID, event.id)
      const rejected = this.overflow.get(key)
      if (rejected !== undefined) { this.overflow.set(key, rejected + 1); return }
      const existing = this.calls.get(key)
      if (existing) {
        existing.pending++
        if (existing.codeMode?.active && event.tool !== "execute") {
          existing.ambiguous = true
          return this.candidates([key], event)
        }
        return this.ambiguous(key)
      }
      observeDistinct = event.tool !== "execute"
      if (this.calls.size >= maxCalls) {
        // Only exhausting the separate bounded tombstone namespace is terminal.
        // Never replace exact identity tracking with an unowned global counter.
        if (this.overflow.size >= maxOverflow) return this.clear()
        this.overflow.set(key, 1)
        return
      }
      if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return this.ambiguous(key)
      const input = boundedHostJSON(event.input)
      if (!input || !wireExact(input)) return this.ambiguous(key)
      const { epoch, location, project } = this.handshake
      const copied = boundedCopy({ sessionID: event.sessionID, assistantID: event.messageID,
        callID: event.id, tool: event.tool, input: input as Record<string, unknown>, scope: { epoch, location }, project }, maxBytes - this.bytes)
      const message = identity(event.sessionID, event.messageID, "")
      const codeMode = event.tool === "execute" && typeof (input as JSONObject).code === "string"
      this.calls.set(key, { value: copied.value, bytes: copied.bytes, pending: 1,
        ...(codeMode ? { codeMode: { calls: [], omitted: 0, active: true, message } } : {}) })
      this.bytes += copied.bytes
      if (codeMode) this.outers.set(message, (this.outers.get(message) ?? new Set<string>()).add(key))
    } catch { if (key !== undefined) this.ambiguous(key) }
    finally {
      const groups = observeDistinct && this.outers.get(identity(event.sessionID, event.messageID, ""))
      if (groups) this.candidates(groups, event)
    }
  }

  after(event: Pick<HookCall, "sessionID" | "messageID" | "id"> & { tool?: string }): void {
    const key = identity(event.sessionID, event.messageID, event.id)
    const rejected = this.overflow.get(key)
    if (rejected !== undefined) {
      if (rejected > 1) this.overflow.set(key, rejected - 1)
      else this.overflow.delete(key)
      return
    }
    const found = this.calls.get(key)
    if (found?.codeMode && event.tool === "execute") {
      found.codeMode.active = false
      this.detach(key, found)
    }
    // On older hosts Code Mode's outer call and nested calls share an identity.
    // Keep it ambiguous until *all* observed executions settle, including failures.
    // Lifetime tombstones would fill the live-call bound in long sessions.
    if (!found || --found.pending > 0) return
    this.detach(key, found)
    this.calls.delete(key)
    this.bytes -= found.bytes
  }

  read(sessionID: string, assistantID: string, callID: string): CapturedCall | undefined {
    const found = this.calls.get(identity(sessionID, assistantID, callID))
    return found?.value && !found.ambiguous ? structuredClone(found.value) : undefined
  }

  /** Only the outer execute invocation is exact. No candidate is selected. */
  readCodeMode(sessionID: string, assistantID: string, callID: string): { outer: CapturedCall; candidates: CodeModeCandidates } | undefined {
    const found = this.calls.get(identity(sessionID, assistantID, callID))
    if (!found?.value || !found.codeMode?.active) return
    return structuredClone({ outer: found.value, candidates: { calls: found.codeMode.calls, omitted: found.codeMode.omitted } })
  }

  private candidates(running: Iterable<string>, event: HookCall): void {
    // Reserve the direct capture first. Validate a candidate once per event,
    // even when several opaque programs could own it. Charge each retained
    // reference in full so every group can release its bytes independently.
    let copy: { value: { tool: string; input: JSONObject }; bytes: number } | undefined
    try {
      const input = boundedHostJSON(event.input)
      if (input && typeof input === "object" && !Array.isArray(input) && wireExact(input))
        copy = boundedCopy({ tool: event.tool, input: input as JSONObject }, maxBytes - this.bytes)
    } catch { /* An unavailable observation still counts toward omissions. */ }
    for (const key of running) {
      const found = this.calls.get(key)!, group = found.codeMode!
      if (!copy || group.calls.length >= maxCandidates || copy.bytes > maxBytes - this.bytes) group.omitted++
      else {
        group.calls.push(copy.value)
        found.bytes += copy.bytes
        this.bytes += copy.bytes
      }
    }
  }

  private detach(key: string, found?: Capture): void {
    if (!found?.codeMode) return
    const message = found.codeMode.message, running = this.outers.get(message)
    if (running?.delete(key) && !running.size) this.outers.delete(message)
  }

  private ambiguous(key: string): void {
    const found = this.calls.get(key)
    this.bytes -= found?.bytes ?? 0
    this.calls.set(key, { bytes: 0, pending: found?.pending ?? 1 })
    this.detach(key, found)
  }

  clear(): void {
    this.available = false
    this.calls.clear()
    this.outers.clear()
    this.overflow.clear()
    this.bytes = 0
  }
}
