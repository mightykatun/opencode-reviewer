import type { AssessmentPreview, ReviewKind } from "./types.js"

/** Prefix of the native reject message the requesting agent reads. The prefix
 * avoids native muted-denial phrases. Model text is preserved, so the host may
 * still render a message muted when that text contains a denial phrase. */
export const STEERING_PREFIX = "Rejected by opencode-reviewer:"

const calls: Record<ReviewKind, string> = { shell: "shell tool call", edit: "edit tool call",
  "external-directory": "external directory tool call", skill: "skill tool call", tool: "registered tool call" }

/** Fixed closing sentence sent only to the requesting agent, never shown in the UI. */
export function steeringFollowUpSentence(category?: ReviewKind): string {
  const call = `next ${category ? calls[category] : "tool call of the same type"}`
  return `Please start by resolving this. Ideally, the ${call} you execute should fix this review issue. You may gather additional context before.`
}

/** One line: whitespace runs, including newlines, collapse to single spaces. */
export function steeringMessage(reason: string, steering: string, category?: ReviewKind): string {
  const clean = (text: string) => text.replace(/\s+/g, " ").trim()
  const why = clean(reason), how = clean(steering)
  return `${STEERING_PREFIX} ${/[.!?]$/.test(why) ? why : `${why}.`} ${/[.!?]$/.test(how) ? how : `${how}.`} ${steeringFollowUpSentence(category)}`
}

/** A Unsafe rating whose reason and steering are complete and nonempty. */
export function steeringReady(value: AssessmentPreview | undefined, complete: boolean): { reason: string; steering: string } | undefined {
  if (value?.safe !== false || !value.reason?.trim() || !value.steering?.trim()) return
  if (!complete && (!value.reasonComplete || !value.steeringComplete)) return
  return { reason: value.reason.trim(), steering: value.steering.trim() }
}
