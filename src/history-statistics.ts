import { empty, validate, type LifetimeTotals } from "./lifetime.js"
import { count, HistoryInvalid, type HistoryEvent, type HistoryOutcome } from "./history-records.js"

export type PermissionStatistic = "manual" | "rejected" | "other"
export const permissionStatistic = (outcome: HistoryOutcome | undefined): PermissionStatistic =>
  outcome === "manual" || outcome === "rejected" ? outcome : "other"

// Opaque permission identity is retained with accounting, including after detail
// deletion. Reclassification and both aggregate scopes commit in one transaction.
export const permissionStatisticsSchema = `CREATE TABLE IF NOT EXISTS permission_statistics (
  id TEXT PRIMARY KEY, root TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS permission_statistics_root ON permission_statistics(root,id);`

export function validatePermissionStatistic(row: { id: string; root: string; outcome: PermissionStatistic; at: number }) {
  if (!/^[a-f0-9]{64}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.root)
    || !["manual", "rejected", "other"].includes(row.outcome) || !count(row.at) || row.at > 8.64e15)
    throw new HistoryInvalid("Invalid permission statistics")
}

/** Replace one permission's counted outcome, never count each saved re-review.
 * Unattributed native once remains uncounted until genuine attribution arrives. */
export function replacePermissionStatistic(totals: LifetimeTotals, previous: PermissionStatistic,
  next: PermissionStatistic, at: number): LifetimeTotals {
  const activity = { ...totals.activity,
    manuallyApproved: totals.activity.manuallyApproved + Number(next === "manual") - Number(previous === "manual"),
    rejected: totals.activity.rejected + Number(next === "rejected") - Number(previous === "rejected") }
  if (!(activity.reviews || activity.usageRequests || activity.retries || activity.autoApproved || activity.manuallyApproved || activity.rejected))
    activity.since = null
  else if (next !== "other") activity.since = activity.since === null ? at : Math.min(activity.since, at)
  return validate({ ...totals, activity })
}

/** The same contribution drives both scopes, including received usage from
 * rejected/interrupted attempts and retries dispatched without received usage. */
export function historyDelta(e: HistoryEvent): LifetimeTotals {
  const delta = empty(), activity = delta.activity
  if (e.type === "attemptDispatched" && e.retry !== "initial") {
    activity.retries = 1; activity.since = e.at
  } else if (e.type === "attemptFinalized" && e.usage) {
    delta.requests = activity.usageRequests = 1; delta.since = activity.since = e.at
    if (e.usage.input !== undefined) { delta.tokenRequests = 1; delta.input = e.usage.input; delta.output = e.usage.output! }
    if (e.usage.cost !== undefined) { delta.priced = 1; delta.cost = e.usage.cost }
  } else if (e.type === "reviewAccepted") {
    delta.safe = e.accepted.safe ? 1 : 0; delta.unsafe = e.accepted.safe ? 0 : 1; delta.ratingsSince = e.accepted.completedAt
    activity.reviews = 1; activity.since = e.accepted.completedAt
    if (e.accepted.timing) { activity.timedReviews = 1; activity.meanFullReportMs = e.accepted.timing.fullReportMs; activity.meanRatingMs = e.accepted.timing.ratingMs }
  } else if (e.type === "approvalConfirmed" && e.automatic) {
    activity.autoApproved = 1; activity.since = e.at
  }
  return delta
}
