import { uiText } from "./ui-text.js"

export interface LifetimeActivity {
  reviews: number
  usageRequests: number
  retries: number
  autoApproved: number
  manuallyApproved: number
  rejected: number
  timedReviews: number
  meanFullReportMs: number
  meanRatingMs: number
  since: number | null
}
const emptyActivity = (): LifetimeActivity => ({ reviews: 0, usageRequests: 0, retries: 0, autoApproved: 0, manuallyApproved: 0, rejected: 0,
  timedReviews: 0, meanFullReportMs: 0, meanRatingMs: 0, since: null })

export interface LifetimeTotals {
  requests: number
  tokenRequests: number
  input: number
  output: number
  priced: number
  cost: number
  since: number | null
  safe: number
  unsafe: number
  ratingsSince: number | null
  activity: LifetimeActivity
}
const empty = (): LifetimeTotals => ({ requests: 0, tokenRequests: 0, input: 0, output: 0, priced: 0, cost: 0, since: null,
  safe: 0, unsafe: 0, ratingsSince: null, activity: emptyActivity() })
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

export function validate(value: LifetimeTotals): LifetimeTotals {
  if (!value || ![value.requests, value.tokenRequests, value.input, value.output, value.priced, value.safe, value.unsafe, value.safe + value.unsafe].every(count)
    || !amount(value.cost) || value.priced > value.requests || value.tokenRequests > value.requests
    || value.requests > value.tokenRequests + value.priced
    || (!value.tokenRequests && (value.input !== 0 || value.output !== 0))
    || (value.requests > 0 ? !count(value.since) || value.since > 8.64e15 : value.since !== null || value.input !== 0 || value.output !== 0)
    || (!value.priced && value.cost !== 0)
    || (value.safe + value.unsafe > 0 ? !count(value.ratingsSince) || value.ratingsSince > 8.64e15 : value.ratingsSince !== null)) {
    throw new Error("Invalid lifetime usage totals")
  }
  // Older accumulators predate permission-outcome accounting. Normalize only the
  // absent pair; malformed or partially written counters remain unavailable.
  if (value.activity && !Object.hasOwn(value.activity, "manuallyApproved") && !Object.hasOwn(value.activity, "rejected"))
    value = { ...value, activity: { ...value.activity, manuallyApproved: 0, rejected: 0 } }
  const activity = value.activity
  if (!activity || ![activity.reviews, activity.usageRequests, activity.retries, activity.autoApproved,
    activity.manuallyApproved, activity.rejected, activity.timedReviews].every(count)
    || activity.reviews > value.safe + value.unsafe || activity.usageRequests > value.requests || activity.timedReviews > activity.reviews
    || ![activity.meanFullReportMs, activity.meanRatingMs].every(amount) || activity.meanRatingMs > activity.meanFullReportMs
    || (!activity.timedReviews && (activity.meanFullReportMs !== 0 || activity.meanRatingMs !== 0))
    || (activity.reviews || activity.usageRequests || activity.retries || activity.autoApproved || activity.manuallyApproved || activity.rejected
      ? !count(activity.since) || activity.since > 8.64e15 : activity.since !== null)) throw new Error("Invalid lifetime activity totals")
  return value
}

/** Merge online means using their weights, never a history of individual timings. */
function mean(left: number, leftCount: number, right: number, rightCount: number): number {
  if (!leftCount) return right
  if (!rightCount) return left
  return left + (right - left) * (rightCount / (leftCount + rightCount))
}

export function add(left: LifetimeTotals, right: LifetimeTotals): LifetimeTotals {
  return validate({
    requests: left.requests + right.requests, input: left.input + right.input, output: left.output + right.output,
    tokenRequests: left.tokenRequests + right.tokenRequests,
    priced: left.priced + right.priced, cost: left.cost + right.cost,
    since: left.since === null ? right.since : right.since === null ? left.since : Math.min(left.since, right.since),
    safe: left.safe + right.safe, unsafe: left.unsafe + right.unsafe,
    ratingsSince: left.ratingsSince === null ? right.ratingsSince : right.ratingsSince === null ? left.ratingsSince : Math.min(left.ratingsSince, right.ratingsSince),
    activity: {
      reviews: left.activity.reviews + right.activity.reviews,
      usageRequests: left.activity.usageRequests + right.activity.usageRequests,
      retries: left.activity.retries + right.activity.retries,
      autoApproved: left.activity.autoApproved + right.activity.autoApproved,
      manuallyApproved: left.activity.manuallyApproved + right.activity.manuallyApproved,
      rejected: left.activity.rejected + right.activity.rejected,
      timedReviews: left.activity.timedReviews + right.activity.timedReviews,
      meanFullReportMs: mean(left.activity.meanFullReportMs, left.activity.timedReviews, right.activity.meanFullReportMs, right.activity.timedReviews),
      meanRatingMs: mean(left.activity.meanRatingMs, left.activity.timedReviews, right.activity.meanRatingMs, right.activity.timedReviews),
      since: left.activity.since === null ? right.activity.since : right.activity.since === null ? left.activity.since : Math.min(left.activity.since, right.activity.since),
    },
  })
}

export { empty }

export function lifetimeCost(totals: LifetimeTotals): string {
  if (!totals.requests) return uiText.lifetime.empty
  if (!totals.priced) return uiText.lifetime.costUnavailable
  return uiText.lifetime.cost(totals.cost.toFixed(4), totals.priced < totals.requests)
}

export interface LifetimeReportPart { text: string; rating?: "safe" | "unsafe" }

/** Preserve the plain report contract while exposing only rating values for styling. */
export function lifetimeReportParts(totals: LifetimeTotals): LifetimeReportPart[] {
  const reviews = totals.safe + totals.unsafe, activity = totals.activity
  const percentage = (count: number) => reviews ? (count / reviews * 100).toFixed(1) : undefined
  return [{ text: [uiText.lifetime.dialogReviews(reviews), uiText.lifetime.dialogRetries(activity.retries),
    totals.tokenRequests ? uiText.lifetime.dialogTokens(totals.input, totals.output, totals.tokenRequests < totals.requests) : uiText.lifetime.dialogTokensUnavailable,
    uiText.lifetime.dialogCost(totals.priced ? totals.cost.toFixed(4) : undefined, totals.priced < totals.requests),
    "", uiText.lifetime.dialogSafeLabel].join("\n") },
    { text: uiText.lifetime.dialogRating(totals.safe, percentage(totals.safe)), rating: "safe" },
    { text: `\n${uiText.lifetime.dialogUnsafeLabel}` },
    { text: uiText.lifetime.dialogRating(totals.unsafe, percentage(totals.unsafe)), rating: "unsafe" },
    { text: ["",
    uiText.lifetime.dialogAutoApproved(activity.autoApproved, percentage(activity.autoApproved)),
    uiText.lifetime.dialogManuallyApproved(activity.manuallyApproved, percentage(activity.manuallyApproved)),
    uiText.lifetime.dialogRejected(activity.rejected, percentage(activity.rejected)),
    "", uiText.lifetime.averageFullReport(activity.timedReviews ? (activity.meanFullReportMs / 1000).toFixed(2) : undefined),
    uiText.lifetime.averageRating(activity.timedReviews ? (activity.meanRatingMs / 1000).toFixed(2) : undefined),
  ].join("\n") }]
}

export function lifetimeReport(totals: LifetimeTotals): string {
  return lifetimeReportParts(totals).map(part => part.text).join("")
}
