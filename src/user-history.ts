import type { SessionMessageUser } from "@opencode/client"
import type { QuestionCall, RecordedQuestionCall } from "./host-questions.js"
import { leadingLines, lineCount } from "./truncate.js"

/** One earlier delivered root-user message. Text is exact (trimmed), an exact
 * leading-line prefix when truncated, or null with a factual reason. */
export interface PromptEntry {
  type: "prompt"
  text: string | null
  truncated?: { includedLines: number; omittedLines: number }
  reason?: string
}
/** Position of the latest root-user message, whose text is userPrompt. */
export interface LatestPromptEntry { type: "latest-prompt" }
/** One native question call the user settled, or a factual omission in its place.
 * optionsOmitted means the option labels were dropped to fit the per-entry limit. */
export type QuestionsEntry = { type: "questions" } & ((QuestionCall & { optionsOmitted?: true }) | { omitted: string })
export type UserHistoryEntry = PromptEntry | LatestPromptEntry | QuestionsEntry

const earlierPromptBytes = 8192
const earlierBytes = 65536
const questionEntryBytes = 4096
const questionBytes = 32768

type Placed<T> = { entry: T; at: number }
type Unplaced<T> = { entry: T; at: number | undefined }

const entryBytes = (entry: QuestionsEntry) => Buffer.byteLength(JSON.stringify(entry))
const createdAt = (message: SessionMessageUser) => Number.isFinite(message.time?.created) ? message.time.created : undefined
const isPlaced = <T>(item: Unplaced<T>): item is Placed<T> => item.at !== undefined

/** Newest-first earlier messages into newest-first, byte-bounded prompt entries. */
function boundedPrompts(messages: SessionMessageUser[], limitations: string[]): Array<Unplaced<PromptEntry>> {
  const kept: Array<Unplaced<PromptEntry>> = []
  let remaining = earlierBytes, index = 0
  for (; index < messages.length; index++) {
    const message = messages[index]!, at = createdAt(message)
    const text = message.text.trim()
    if (!text) { kept.push({ at, entry: { type: "prompt", text: null, reason: "No nonempty text (empty or attachment-only message)." } }); continue }
    const size = Buffer.byteLength(text)
    const cap = Math.min(earlierPromptBytes, remaining)
    if (size <= cap) { kept.push({ at, entry: { type: "prompt", text } }); remaining -= size; continue }
    const prefix = leadingLines(text, cap)
    if (prefix.lines) {
      kept.push({ at, entry: { type: "prompt", text: prefix.text,
        truncated: { includedLines: prefix.lines, omittedLines: lineCount(text) - prefix.lines } } })
      remaining -= prefix.bytes
    } else if (cap === earlierPromptBytes) {
      kept.push({ at, entry: { type: "prompt", text: null, reason: "Omitted whole: its first line exceeds the 8 KiB per-prompt limit." } })
    } else break
  }
  if (kept.some(({ entry }) => entry.truncated)) {
    limitations.push("Some earlier root user prompts exceed the 8 KiB per-prompt or 64 KiB total limit. They keep exact leading lines with omitted line counts.")
  }
  if (index < messages.length) {
    limitations.push(`The ${messages.length - index} oldest earlier root user prompts that were read are omitted because earlier prompts exceed the 64 KiB total limit.`)
  }
  return kept
}

function withoutOptionLabels(call: QuestionCall): QuestionCall {
  return "dismissedWithMessage" in call
    ? { ...call, questions: call.questions.map(question => ({ ...question, options: [] })) }
    : { ...call, questions: call.questions.map(question => ({ ...question, options: [] })) }
}

/** The entry for one call within the per-entry limit: complete, then without
 * option labels, then a factual omission. Questions and answers are never cut. */
function questionsEntry(call: QuestionCall): QuestionsEntry {
  const full: QuestionsEntry = { type: "questions", ...call }
  if (entryBytes(full) <= questionEntryBytes) return full
  const reduced: QuestionsEntry = { type: "questions", ...withoutOptionLabels(call), optionsOmitted: true }
  if (entryBytes(reduced) <= questionEntryBytes) return reduced
  return { type: "questions", omitted: "Omitted whole: its questions and answers exceed the 4 KiB per-entry limit." }
}

/** Oldest-first settled calls into newest-first entries within the total budget. */
function boundedQuestions(calls: RecordedQuestionCall[], limitations: string[]): Array<Placed<QuestionsEntry>> {
  const kept: Array<Placed<QuestionsEntry>> = []
  let remaining = questionBytes, index = calls.length - 1
  for (; index >= 0; index--) {
    const { call, settledAt } = calls[index]!
    const entry = questionsEntry(call), size = entryBytes(entry)
    if (size > remaining) break
    kept.push({ entry, at: settledAt })
    remaining -= size
  }
  if (kept.some(({ entry }) => "optionsOmitted" in entry)) {
    limitations.push("Some settled question entries exceed the 4 KiB per-entry limit and omit their option labels.")
  }
  if (index >= 0) {
    limitations.push(`The ${index + 1} oldest settled question calls that were read are omitted because questions exceed the 32 KiB total limit.`)
  }
  return kept
}

/** Merge two oldest-first sequences. Prompts keep their delivered order, and each
 * question call goes before the first prompt created after the user settled it. */
function interleave(prompts: Array<Placed<UserHistoryEntry>>, questions: Array<Placed<QuestionsEntry>>): UserHistoryEntry[] {
  const timeline: UserHistoryEntry[] = []
  let next = 0
  for (const prompt of prompts) {
    for (; next < questions.length && questions[next]!.at <= prompt.at; next++) timeline.push(questions[next]!.entry)
    timeline.push(prompt.entry)
  }
  for (const question of questions.slice(next)) timeline.push(question.entry)
  return timeline
}

/** One oldest-first timeline of earlier prompts, the latest prompt's position and
 * the settled question calls, each bounded by its own byte budget. */
export function buildUserHistory(latest: SessionMessageUser | undefined, earlier: SessionMessageUser[],
  calls: RecordedQuestionCall[], limitations: string[]): UserHistoryEntry[] {
  const prompts: Array<Unplaced<UserHistoryEntry>> = boundedPrompts(earlier, limitations).reverse()
  if (latest) prompts.push({ entry: { type: "latest-prompt" }, at: createdAt(latest) })
  if (!calls.length) return prompts.map(({ entry }) => entry)
  const placed = prompts.filter(isPlaced)
  if (placed.length < prompts.length) {
    limitations.push("Settled questions are not included because some root user messages lack a creation time to order them by.")
    return prompts.map(({ entry }) => entry)
  }
  return interleave(placed, boundedQuestions(calls, limitations).reverse())
}
