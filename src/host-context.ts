import type { OpenCodeClient, SessionInfo, SessionMessageUser } from "@opencode/client"
import { remainingTime, withDeadline } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"

/** Bind this reader to the invocation's captured connection, never a mutable active client. */
export interface HostContextReader {
  session: Pick<OpenCodeClient["session"], "get">
  message: Pick<OpenCodeClient["message"], "list">
}

export type HostContextScope = { sessionID: string; location: SessionInfo["location"] }
export type HostContextSession = Pick<SessionInfo, "id" | "parentID" | "projectID" | "location">
export interface HostConversationContext {
  current: HostContextSession
  root: HostContextSession
  userPrompt: string | null
  rootMessageID?: string
  delegation?: { sessionID: string; parentSessionID: string; messageID: null; prompt: null }
  limitations: string[]
}

function sessionSnapshot(info: SessionInfo, expectedID: string): HostContextSession {
  if (!info || info.id !== expectedID || !info.projectID || typeof info.location?.directory !== "string"
    || !info.location.directory || (info.parentID !== undefined && (typeof info.parentID !== "string" || !info.parentID))) {
    throw new Error("Conversation session unavailable or mismatched")
  }
  return { id: info.id, ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
    projectID: info.projectID, location: { directory: info.location.directory } }
}

async function latestDeliveredUser(reader: HostContextReader, sessionID: string, signal: AbortSignal): Promise<SessionMessageUser | undefined> {
  signal.throwIfAborted()
  // The delivered projection filters before pagination and orders by durable
  // sequence, not timestamps or IDs. Pending inbox inputs are not user intent.
  const pending = reader.message.list({ sessionID, type: "user", order: "desc", limit: 1 }, { signal })
  transportOwnership(signal)?.track(pending)
  const result = await pending
  signal.throwIfAborted()
  if (!result || !Array.isArray(result.data) || result.data.length > 1 || !result.cursor
    || typeof result.cursor !== "object" || Array.isArray(result.cursor)) throw new Error("Root-user history response unavailable or invalid")
  const message = result.data[0]
  if (message === undefined) return
  if (!message || message.type !== "user" || typeof message.id !== "string" || !message.id
    || typeof message.text !== "string") throw new Error("Root-user history message invalid")
  // An empty/attachment-only latest user message still blocks every older ask.
  return message
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
    const message = await latestDeliveredUser(reader, root.id, contextSignal)
    const limitations: string[] = []
    let userPrompt: string | null = null
    if (!message) limitations.push("No delivered root user message is available.")
    else if (message.text.length > 65536 || Buffer.byteLength(message.text, "utf8") > 65536) {
      limitations.push("Latest delivered root user prompt omitted because it exceeds the 64 KiB context limit; no older prompt was substituted.")
    } else {
      userPrompt = message.text.trim() || null
      if (userPrompt === null) limitations.push("Latest delivered root user message has no nonempty text; no older prompt was substituted.")
    }
    const delegation = current.parentID === undefined ? undefined
      : { sessionID: current.id, parentSessionID: current.parentID, messageID: null, prompt: null }
    if (delegation) limitations.push("Exact immediate subagent delegation is unavailable from the public V2 invocation linkage; delegation text is omitted.")
    contextSignal.throwIfAborted()
    return { current, root, userPrompt, ...(message ? { rootMessageID: message.id } : {}),
      ...(delegation ? { delegation } : {}), limitations }
  }, "Conversation context lookup")
}
