import type { OpenCodeClient } from "@opencode/client"
import { retrievalEnabled, type Config } from "./config.js"
import type { HostReviewEvidence } from "./host-evidence.js"
import type { JSONObject, JSONValue } from "./host-types.js"
import { transportOwnership } from "./transport-ownership.js"
import { leadingLines, lineCount } from "./truncate.js"

export const askContextTool = "ask_context"
const maxQuestionBytes = 8192

/** Transient generation from a conversation's own context and model: the
 * public backend of OpenCode's /btw. It adds nothing to session history. */
export interface ContextAsker {
  ask(prompt: string, signal: AbortSignal): Promise<string>
}

/** Bind generation to the review's captured connection and root session. */
export function sessionContextAsker(client: Pick<OpenCodeClient, "session">, sessionID: string): ContextAsker {
  return { async ask(prompt, signal) {
    signal.throwIfAborted()
    const pending = client.session.generate({ sessionID, prompt }, { signal })
    transportOwnership(signal)?.track(pending)
    const result: unknown = await pending
    signal.throwIfAborted()
    const text = result && typeof result === "object" ? (result as { text?: unknown }).text : undefined
    if (typeof text !== "string") throw new Error("Session context answer invalid")
    return text
  } }
}

/** Only root conversations under an enabled retrieval stage may be asked.
 * Subagent sessions never receive the tool. */
export function clarificationEnabled(config: Pick<Config, "retrieval" | "retrievalKinds" | "retrievalClarification">,
  evidence: HostReviewEvidence): boolean {
  const { current, root } = evidence.conversation
  return config.retrievalClarification && retrievalEnabled(config, evidence.kind)
    && current.parentID === undefined && current.id === root.id
}

/** The single questions argument, or undefined when invalid. */
export function clarificationQuestions(args: JSONValue): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return
  const value = args as JSONObject
  if (Object.keys(value).some(key => key !== "questions")) return
  const questions = typeof value.questions === "string" ? value.questions.trim() : ""
  return questions && Buffer.byteLength(questions) <= maxQuestionBytes ? questions : undefined
}
export const invalidQuestions = `invalid arguments: ${askContextTool} requires questions (nonempty string up to ${maxQuestionBytes / 1024} KiB)`

/** The session model sees the exact pending operation, never review guidance,
 * session instructions or conversation fields it already holds. */
function clarificationPrompt(template: string, evidence: HostReviewEvidence, questions: string): string {
  const { conversation: _, userPrompt: __, earlierUserPrompts: ___, delegation: ____, limitations: _____, ...pendingOperation } = evidence
  return `${template}\n\n${JSON.stringify({ pendingOperation, questions })}`
}

/** One clarification as a retrieval tool result. Ordinary failures and empty
 * answers (such as a tool call instead of text) are factual results; the
 * answer keeps exact leading lines within maxBytes. Cancellation propagates. */
export async function askContext(asker: ContextAsker, template: string, evidence: HostReviewEvidence, questions: string,
  maxBytes: number, signal: AbortSignal): Promise<JSONObject> {
  const result = { tool: askContextTool, questions }
  let answer: string
  try { answer = (await asker.ask(clarificationPrompt(template, evidence, questions), signal)).trim() }
  catch {
    signal.throwIfAborted()
    return { ...result, status: "error", reason: "session context answer unavailable" }
  }
  signal.throwIfAborted()
  if (!answer) return { ...result, status: "error", reason: "the session model returned no answer text" }
  if (Buffer.byteLength(answer) <= maxBytes) return { ...result, status: "ok", content: answer }
  const prefix = leadingLines(answer, maxBytes)
  if (!prefix.lines) return { ...result, status: "error", reason: "answer exceeds the size limit" }
  return { ...result, status: "ok", content: prefix.text, truncated: { omittedLines: lineCount(answer) - prefix.lines } }
}
