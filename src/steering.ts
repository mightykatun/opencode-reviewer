import type { AssessmentPreview } from "./types.js"

/** Prefix of the native reject message the requesting agent reads. The prefix
 * avoids native muted-denial phrases. Model text is preserved, so the host may
 * still render a message muted when that text contains a denial phrase. */
export const STEERING_PREFIX = "Rejected by opencode-reviewer:"

/** One line: whitespace runs, including newlines, collapse to single spaces. */
export function steeringMessage(reason: string, steering: string): string {
  const clean = (text: string) => text.replace(/\s+/g, " ").trim()
  const why = clean(reason), how = clean(steering)
  return `${STEERING_PREFIX} ${/[.!?]$/.test(why) ? why : `${why}.`} ${how}`
}

/** A Unsafe rating whose reason and steering are complete and nonempty. */
export function steeringReady(value: AssessmentPreview | undefined, complete: boolean): { reason: string; steering: string } | undefined {
  if (value?.safe !== false || !value.reason?.trim() || !value.steering?.trim()) return
  if (!complete && (!value.reasonComplete || !value.steeringComplete)) return
  return { reason: value.reason.trim(), steering: value.steering.trim() }
}
