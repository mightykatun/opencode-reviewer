import type { OpenCodeClient } from "@opencode/client"
import { remainingTime, withDeadline } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"

/** One question the native question tool showed the user. Option descriptions are omitted. */
export interface AskedQuestion {
  header: string
  question: string
  options: string[]
}

/** One native question call the user settled. An empty answer means the user left
 * that question unanswered. A dismissal with a typed message settles every question. */
export type QuestionCall =
  | { questions: Array<AskedQuestion & { answer: string[] }> }
  | { questions: AskedQuestion[]; dismissedWithMessage: string }

/** A settled question call and the time the user settled it. */
export interface RecordedQuestionCall {
  settledAt: number
  call: QuestionCall
}

export interface QuestionHistory {
  /** Settled calls, oldest first. */
  calls: RecordedQuestionCall[]
  limitations: string[]
}

export type QuestionReader = { message: Pick<OpenCodeClient["message"], "list"> }

/** The native question tool's registered name. It never runs inside Code Mode. */
const questionTool = "question"
/** OpenCode records a dismissal with a typed message as a plain tool execution
 * failure whose message is the user's text. Declines and plain dismissals are
 * recorded as aborted, and permission denials carry their own error type. */
const typedDismissalError = "tool.execution"
const pageSize = 100
const maxPages = 4

class InvalidQuestionHistory extends Error {}

type JSONRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JSONRecord => !!value && typeof value === "object" && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === "string"
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)

/** The native tool input, or undefined when it does not match the tool's schema.
 * Such a call never reached the user. */
function askedQuestions(input: unknown): AskedQuestion[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions) || !input.questions.length) return
  const questions: AskedQuestion[] = []
  for (const item of input.questions as unknown[]) {
    if (!isRecord(item) || !isString(item.question) || !isString(item.header) || !Array.isArray(item.options)
      || (item.multiple !== undefined && typeof item.multiple !== "boolean")) return
    const options: string[] = []
    for (const option of item.options as unknown[]) {
      if (!isRecord(option) || !isString(option.label) || !isString(option.description)) return
      options.push(option.label)
    }
    questions.push({ header: item.header, question: item.question, options })
  }
  return questions
}

type PartOutcome = { kind: "settled"; recorded: RecordedQuestionCall } | { kind: "ignored" } | { kind: "malformed" }

/** Classify one native question tool part. Unsettled, aborted and denied calls hold
 * no user statement and are ignored. Settled calls with inconsistent records are malformed. */
function questionPart(part: JSONRecord): PartOutcome {
  const state = part.state, time = part.time
  if (!isRecord(state) || !isRecord(time)) return { kind: "malformed" }
  if (state.status !== "completed" && state.status !== "error") return { kind: "ignored" }
  const asked = askedQuestions(state.input)
  if (!asked) return { kind: "ignored" }
  let call: QuestionCall
  if (state.status === "completed") {
    const answers = isRecord(state.metadata) ? state.metadata.answers : undefined
    if (!Array.isArray(answers) || answers.length !== asked.length || !answers.every(isStringArray)) return { kind: "malformed" }
    call = { questions: asked.map((question, index) => ({ ...question, answer: answers[index] as string[] })) }
  } else {
    const error = state.error
    if (!isRecord(error) || error.type !== typedDismissalError) return { kind: "ignored" }
    if (!isString(error.message) || !error.message.trim()) return { kind: "malformed" }
    call = { questions: asked, dismissedWithMessage: error.message.trim() }
  }
  if (typeof time.completed !== "number" || !Number.isFinite(time.completed)) return { kind: "malformed" }
  return { kind: "settled", recorded: { settledAt: time.completed, call } }
}

type AssistantMessage = { created: number; parts: JSONRecord[] }

function assistantMessage(message: unknown): AssistantMessage {
  if (!isRecord(message) || message.type !== "assistant" || !isString(message.id) || !message.id
    || !isRecord(message.time) || typeof message.time.created !== "number" || !Array.isArray(message.content)
    || !message.content.every(isRecord)) throw new InvalidQuestionHistory()
  return { created: message.time.created, parts: message.content as JSONRecord[] }
}

/** Settled question calls from the root session's assistant messages, newest
 * messages first, until a message predates `since` or the page limit. Calls
 * settled before `since` are outside the read prompt window and are skipped. */
async function collect(reader: QuestionReader, sessionID: string, since: number | undefined, signal: AbortSignal): Promise<QuestionHistory> {
  const calls: RecordedQuestionCall[] = []
  let malformed = 0, cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    signal.throwIfAborted()
    const pending = reader.message.list(cursor === undefined
      ? { sessionID, type: "assistant", order: "desc", limit: pageSize }
      : { sessionID, type: "assistant", cursor, limit: pageSize }, { signal })
    transportOwnership(signal)?.track(pending)
    const result = await pending
    signal.throwIfAborted()
    if (!result || !Array.isArray(result.data) || result.data.length > pageSize || !isRecord(result.cursor)) throw new InvalidQuestionHistory()
    let reachedSince = false
    for (const raw of result.data as unknown[]) {
      const message = assistantMessage(raw)
      for (const part of message.parts) {
        if (part.type !== "tool" || part.name !== questionTool) continue
        const outcome = questionPart(part)
        if (outcome.kind === "malformed") malformed++
        else if (outcome.kind === "settled" && (since === undefined || outcome.recorded.settledAt >= since)) calls.push(outcome.recorded)
      }
      if (since !== undefined && message.created < since) reachedSince = true
    }
    const next = result.cursor.next
    if (next !== undefined && next !== null && (!isString(next) || !next)) throw new InvalidQuestionHistory()
    if (reachedSince || !next || !result.data.length) return finish(calls, malformed, false)
    cursor = next
  }
  return finish(calls, malformed, true)
}

function finish(calls: RecordedQuestionCall[], malformed: number, truncated: boolean): QuestionHistory {
  const limitations: string[] = []
  if (truncated) limitations.push(`Questions were read only from the latest ${maxPages * pageSize} root assistant messages. Older questions are not included.`)
  if (malformed) limitations.push(`${malformed} settled question records were inconsistent and are not included.`)
  return { calls: calls.sort((a, b) => a.settledAt - b.settledAt), limitations }
}

/** Questions are optional context. Any failure other than a parent abort becomes
 * a factual omission and never fails the review. */
export async function readQuestionHistory(reader: QuestionReader, sessionID: string, since: number | undefined,
  signal: AbortSignal): Promise<QuestionHistory> {
  try {
    return await withDeadline(signal, remainingTime(signal) / 2,
      (readSignal) => collect(reader, sessionID, since, readSignal), "Root question lookup")
  } catch (error) {
    if (signal.aborted) throw error
    return { calls: [], limitations: ["Questions the agent asked in the root conversation could not be read and are not included."] }
  }
}
