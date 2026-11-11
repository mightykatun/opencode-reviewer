import type { OpenCodeClient, SessionInfo, SessionMessageUser } from "@opencode/client"
import { remainingTime, withDeadline } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"
import { leadingLines, lineCount } from "./truncate.js"

/** Bind this reader to the invocation's captured connection, never a mutable active client. */
export interface HostContextReader {
  session: Pick<OpenCodeClient["session"], "get">
  message: Pick<OpenCodeClient["message"], "list">
}

export type HostContextScope = { sessionID: string; location: SessionInfo["location"] }
export type HostContextSession = Pick<SessionInfo, "id" | "parentID" | "projectID" | "location">
/** One earlier delivered root-user message. Text is exact (trimmed), an exact
 * leading-line prefix when truncated, or null with a factual reason. */
export interface EarlierUserPrompt {
  text: string | null
  truncated?: { includedLines: number; omittedLines: number }
  reason?: string
}
export interface HostConversationContext {
  current: HostContextSession
  root: HostContextSession
  userPrompt: string | null
  /** Earlier delivered root-user messages, oldest first, excluding the latest. */
  earlierUserPrompts: EarlierUserPrompt[]
  rootMessageID?: string
  delegation?: { sessionID: string; parentSessionID: string; messageID: null; prompt: null }
  limitations: string[]
}

const latestBytes = 65536
/** Page size, page count and byte budgets for earlier root-user prompts. */
const pageSize = 100
const maxPages = 4
const earlierBytes = 65536
const earlierPromptBytes = 8192

class InvalidHistory extends Error {}

function sessionSnapshot(info: SessionInfo, expectedID: string): HostContextSession {
  if (!info || info.id !== expectedID || !info.projectID || typeof info.location?.directory !== "string"
    || !info.location.directory || (info.parentID !== undefined && (typeof info.parentID !== "string" || !info.parentID))) {
    throw new Error("Conversation session unavailable or mismatched")
  }
  return { id: info.id, ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
    projectID: info.projectID, location: { directory: info.location.directory } }
}

type UserPage = { messages: SessionMessageUser[]; next?: string }

async function deliveredUserPage(reader: HostContextReader, sessionID: string, cursor: string | undefined,
  signal: AbortSignal): Promise<UserPage> {
  signal.throwIfAborted()
  // The delivered projection filters before pagination and orders by durable
  // sequence, not timestamps or IDs. Pending inbox inputs are not user intent.
  // The first page is newest first; cursor.next keeps that order across pages.
  const pending = reader.message.list(cursor === undefined
    ? { sessionID, type: "user", order: "desc", limit: pageSize }
    : { sessionID, type: "user", cursor, limit: pageSize }, { signal })
  transportOwnership(signal)?.track(pending)
  const result = await pending
  signal.throwIfAborted()
  if (!result || !Array.isArray(result.data) || result.data.length > pageSize || !result.cursor
    || typeof result.cursor !== "object" || Array.isArray(result.cursor)) throw new InvalidHistory("Root-user history response unavailable or invalid")
  const next = result.cursor.next
  if (next !== undefined && next !== null && (typeof next !== "string" || !next)) throw new InvalidHistory("Root-user history cursor invalid")
  for (const message of result.data) {
    if (!message || message.type !== "user" || typeof message.id !== "string" || !message.id
      || typeof message.text !== "string") throw new InvalidHistory("Root-user history message invalid")
  }
  return { messages: result.data as SessionMessageUser[], ...(next && result.data.length ? { next } : {}) }
}

/** Newest-first earlier messages into an oldest-first, byte-bounded list. */
function earlierPrompts(messages: SessionMessageUser[], limitations: string[]): EarlierUserPrompt[] {
  const kept: EarlierUserPrompt[] = []
  let remaining = earlierBytes, index = 0
  for (; index < messages.length; index++) {
    const text = messages[index]!.text.trim()
    if (!text) { kept.push({ text: null, reason: "No nonempty text (empty or attachment-only message)." }); continue }
    const size = Buffer.byteLength(text)
    const cap = Math.min(earlierPromptBytes, remaining)
    if (size <= cap) { kept.push({ text }); remaining -= size; continue }
    const prefix = leadingLines(text, cap)
    if (prefix.lines) {
      kept.push({ text: prefix.text, truncated: { includedLines: prefix.lines, omittedLines: lineCount(text) - prefix.lines } })
      remaining -= prefix.bytes
    } else if (cap === earlierPromptBytes) {
      kept.push({ text: null, reason: "Omitted whole: its first line exceeds the 8 KiB per-prompt limit." })
    } else break
  }
  if (kept.some(prompt => prompt.truncated)) {
    limitations.push("Some earlier root user prompts exceed the 8 KiB per-prompt or 64 KiB total limit; they keep exact leading lines with omitted line counts.")
  }
  if (index < messages.length) {
    limitations.push(`The ${messages.length - index} oldest earlier root user prompts that were read are omitted because earlier prompts exceed the 64 KiB total limit.`)
  }
  return kept.reverse()
}

/** Read only public, session-scoped metadata and delivered root intent.
 * Scope/ancestry/history failures reject; optional prompt omissions are factual.
 * The existing deadline carries physical ownership through late client settlement.
 */
export async function loadHostConversationContext(scope: HostContextScope, reader: HostContextReader, signal: AbortSignal): Promise<HostConversationContext> {
  signal.throwIfAborted()
  const sessionID = scope.sessionID
  const directory = scope.location.directory
  if (!sessionID || !directory) throw new Error("Captured conversation scope unavailable")
  return withDeadline(signal, Math.min(5000, remainingTime(signal) / 3), async (contextSignal) => {
    const readSession = async (id: string) => {
      contextSignal.throwIfAborted()
      const pending = reader.session.get({ sessionID: id }, { signal: contextSignal })
      transportOwnership(contextSignal)?.track(pending)
      const info = await pending
      contextSignal.throwIfAborted()
      return sessionSnapshot(info, id)
    }
    const current = await readSession(sessionID)
    if (current.location.directory !== directory) throw new Error("Conversation location differs from captured invocation scope")
    let root = current
    const seen = new Set([current.id])
    for (let edges = 0; root.parentID !== undefined; edges++) {
      if (edges >= 16 || seen.has(root.parentID)) throw new Error("Conversation ancestry incomplete: cycle or 16-edge limit")
      root = await readSession(root.parentID)
      seen.add(root.id)
    }
    // Parents can legitimately belong to a different location on this connection.
    // V2 messages have no sessionID; ownership comes from the scoped list request.
    // The first page holds the latest message and is mandatory.
    const first = await deliveredUserPage(reader, root.id, undefined, contextSignal)
    const messages = [...first.messages]
    const limitations: string[] = []
    let next = first.next
    for (let pages = 1; next !== undefined; pages++) {
      if (pages >= maxPages) {
        limitations.push(`Only the latest ${messages.length} delivered root user messages were read; older ones exist and are not included.`)
        break
      }
      const cursor = next
      try {
        // Earlier pages are optional: a stall or transport failure keeps what was read.
        const page = await withDeadline(contextSignal, remainingTime(contextSignal) / 2,
          (pageSignal) => deliveredUserPage(reader, root.id, cursor, pageSignal), "Conversation history lookup")
        messages.push(...page.messages)
        next = page.next
      } catch (error) {
        if (contextSignal.aborted || error instanceof InvalidHistory) throw error
        limitations.push(`Older root user messages beyond the latest ${messages.length} could not be read and are not included.`)
        break
      }
    }
    if (new Set(messages.map(message => message.id)).size !== messages.length) throw new Error("Root-user history repeats a message")
    const [message, ...older] = messages
    let userPrompt: string | null = null
    if (!message) limitations.push("No delivered root user message is available.")
    else if (message.text.length > latestBytes || Buffer.byteLength(message.text, "utf8") > latestBytes) {
      limitations.push("Latest delivered root user prompt omitted because it exceeds the 64 KiB context limit; no older prompt was substituted.")
    } else {
      // An empty/attachment-only latest user message is still the latest request.
      userPrompt = message.text.trim() || null
      if (userPrompt === null) limitations.push("Latest delivered root user message has no nonempty text; no older prompt was substituted.")
    }
    const earlierUserPrompts = earlierPrompts(older, limitations)
    const delegation = current.parentID === undefined ? undefined
      : { sessionID: current.id, parentSessionID: current.parentID, messageID: null, prompt: null }
    if (delegation) limitations.push("Exact immediate subagent delegation is unavailable from the public V2 invocation linkage; delegation text is omitted.")
    contextSignal.throwIfAborted()
    return { current, root, userPrompt, earlierUserPrompts, ...(message ? { rootMessageID: message.id } : {}),
      ...(delegation ? { delegation } : {}), limitations }
  }, "Conversation context lookup")
}
