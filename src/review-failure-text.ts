import { DeadlineError } from "./deadline.js"
import { uiText } from "./ui-text.js"

type Failures = typeof uiText.review.failures
type FixedFailure = { [K in keyof Failures]: Failures[K] extends string ? K : never }[keyof Failures]
type Stage = keyof typeof uiText.review.stages

/** Internal error messages that can end a review, keyed to their panel copy.
 * The messages are fixed identifiers: they also reach model limitations, tool
 * results and tests, so wording changes belong in ui-text.ts, not here. */
export const reviewFailureMessages: ReadonlyMap<string, FixedFailure> = new Map([
  ["Reviewer network request failed", "network"],
  ["Reviewer response read failed", "responseRead"],
  ["Reviewer returned an empty HTTP response", "emptyResponse"],
  ["Reviewer HTTP response exceeds 64 KiB", "responseTooLarge"],
  ["Reviewer HTTP response contains invalid UTF-8", "responseEncoding"],
  ["Reviewer returned invalid API JSON", "invalidJson"],
  ["Reviewer API must return one completion", "completionCount"],
  ["Reviewer API did not return a text assessment", "noTextAssessment"],
  ["Reviewer expected an SSE response", "expectedStream"],
  ["Reviewer API did not return a text assessment stream", "noTextStream"],
  ["Reviewer returned invalid SSE API JSON", "invalidStreamJson"],
  ["Reviewer stream ended without stop and DONE", "streamIncomplete"],
  ["Reviewer SSE wire exceeds 4 MiB", "streamTooLarge"],
  ["Reviewer SSE event exceeds 64 KiB", "streamEventTooLarge"],
  ["Reviewer SSE exceeds 65536 events", "streamEventCount"],
  ["Reviewer SSE ended mid-event", "streamEndedMidEvent"],
  ["Reviewer SSE contains invalid UTF-8", "streamEncoding"],
  ["Reviewer SSE parser already ended", "streamParserEnded"],
  ["Reviewer output token limit reached. Increase maxOutputTokens", "outputLimit"],
  ["Reviewer assessment exceeds 64 KiB", "assessmentTooLarge"],
  ["Reviewer response format invalid after configured attempts", "formatInvalid"],
  ["Captured conversation scope unavailable", "conversationScope"],
  ["Conversation session unavailable or mismatched", "conversationSession"],
  ["Conversation location differs from captured invocation scope", "conversationLocation"],
  ["Conversation ancestry incomplete: cycle or 16-edge limit", "conversationAncestry"],
  ["Root-user history response unavailable or invalid", "rootHistory"],
  ["Root-user history message invalid", "rootMessage"],
  ["Registered invocation project metadata unavailable or ambiguous", "project"],
  ["Evidence request or invocation scope mismatch", "invocationScope"],
  ["Evidence conversation scope mismatch", "conversationMismatch"],
  ["Evidence operation or conversation scope mismatch", "operationScope"],
])

/** Internal deadline stage labels on the review path, keyed to their copy. */
export const reviewStageLabels: ReadonlyMap<string, Stage> = new Map([
  ["Review", "review"],
  ["Host evidence lookup", "hostEvidence"],
  ["Companion evidence lookup", "companionEvidence"],
  ["Conversation context lookup", "conversationContext"],
  ["Evidence collection", "evidenceCollection"],
  ["Evidence validation", "evidenceValidation"],
  ["Retrieval", "retrieval"],
  ["Retrieval response", "retrievalResponse"],
  ["Reviewer response", "reviewerResponse"],
  ["Reviewer response body", "reviewerResponseBody"],
  ["Assessment validation", "assessmentValidation"],
])

/** Em dashes, semicolons and middle dots never appear in interface text. */
export const forbiddenErrorPunctuation = /[—;·‧∙⋅・]/
const forbiddenSeparators = /\s*[—;·‧∙⋅・]+\s*/g
/** Host and client messages are not ours to edit, so normalize them for display. */
const plain = (text: string) => text.replace(forbiddenSeparators, ", ").replace(/^, |,\s*$/g, "").trim()

const http = /^Reviewer HTTP (\d{3})$/
const apiKey = /^API key environment variable ([A-Za-z_][A-Za-z_0-9]*) is unset or empty$/

/** Panel detail for a failed review. Unrecognized errors (host and client
 * failures) keep their own message without forbidden punctuation. The panel
 * also sanitizes control characters for display. */
export function reviewFailureText(error: unknown): string {
  const failures = uiText.review.failures
  if (error instanceof DeadlineError) {
    const stage = reviewStageLabels.get(error.stage)
    return failures.timedOut(stage ? uiText.review.stages[stage] : plain(error.stage))
  }
  if (!(error instanceof Error)) return uiText.review.failed
  const key = reviewFailureMessages.get(error.message)
  if (key) return failures[key]
  let match = http.exec(error.message)
  if (match) return failures.http(Number(match[1]))
  match = apiKey.exec(error.message)
  if (match) return failures.apiKeyMissing(match[1]!)
  return plain(error.message) || uiText.review.failed
}
