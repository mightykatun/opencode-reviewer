import { add, empty, validate, type LifetimeTotals } from "./lifetime.js"
import { HISTORY_RECORD_BYTES as bytes, HistoryInvalid, rootID, reviewID, sessionID, validateEvent, validateReview, type HistoryEvent } from "./history-records.js"
import { historyDelta, replacePermissionStatistic, validatePermissionStatistic } from "./history-statistics.js"
import type { HistoryDatabase } from "./history-schema.js"

export const HISTORY_BOOTSTRAP_STEPS = 128
export const HISTORY_BOOTSTRAP_MS = 40
export const migrationSchema = `CREATE TABLE IF NOT EXISTS conversation_bootstrap (
  id TEXT PRIMARY KEY, review TEXT NOT NULL, phase INTEGER NOT NULL, after TEXT NOT NULL,
  totals TEXT NOT NULL, partial INTEGER NOT NULL CHECK(partial IN (0,1)));`

/** Called only under BEGIN IMMEDIATE. All clients gate root mutations on readiness.
 * A cursor and its accumulator commit together; no event/writer cursor is advanced
 * by bootstrap. Even a single review with millions of attempts yields every slice.
 * No legacy fact is ever applied to the lifetime accumulator or contribution ledger.
 */
export function bootstrap(db: HistoryDatabase, root: string): { done: boolean; steps: number } {
  if (!/^[a-f0-9]{64}$/.test(root)) throw new HistoryInvalid("Invalid bootstrap root")
  // Reuse only this slice's fixed SQL. Preparing on every retained row adds
  // avoidable CPU work; keeping the cache transaction-local also avoids retaining
  // statements across concurrent legacy table rebuilds or worker replacement.
  const statements = new Map<string, ReturnType<HistoryDatabase["prepare"]>>()
  const statement = (sql: string) => {
    let result = statements.get(sql)
    if (!result) { result = db.prepare(sql); statements.set(sql, result) }
    return result
  }
  const get = (sql: string, ...args: any[]) => statement(sql).get(...args)
  const run = (sql: string, ...args: any[]) => statement(sql).run(...args)
  if (get("SELECT id FROM conversation_totals WHERE id=?", root)) return { done: true, steps: 0 }
  const saved = get(`SELECT review,phase,after,partial,CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals
    FROM conversation_bootstrap WHERE id=?`, root)
  let review = saved?.review ?? "", phase = saved?.phase ?? 0, after = saved?.after ?? ""
  let totals: LifetimeTotals = saved ? validate(JSON.parse(saved.totals)) : empty()
  let partial = saved?.partial ?? Number(!!get("SELECT id FROM roots WHERE id=?", root))
  if (![0, 1, 2, 3].includes(phase) || ![0, 1].includes(partial) || !/^(?:[a-f0-9]{64})?$/.test(review)
    || !/^(?:[a-f0-9]{64})?$/.test(after)) throw new HistoryInvalid("Invalid bootstrap cursor")
  const include = (event: HistoryEvent) => { validateEvent(event); totals = add(totals, historyDelta(event)) }
  const end = performance.now() + HISTORY_BOOTSTRAP_MS
  let steps = 0, done = false
  do {
    steps++
    if (phase === 0) {
      const row = get(`SELECT id,CASE WHEN length(CAST(context AS BLOB))<=${bytes.context} THEN context END AS context,
        CASE WHEN length(CAST(accepted AS BLOB))<=${bytes.accepted} THEN accepted END AS accepted,accepted IS NOT NULL AS hasAccepted
        FROM reviews WHERE root=? AND id>? ORDER BY id LIMIT 1`, root, review)
      if (!row) { phase = 3; after = ""; continue }
      const context = JSON.parse(row.context); validateReview(context)
      if (rootID(context) !== root || reviewID(context) !== row.id) throw new HistoryInvalid("Invalid conversation ownership")
      if (row.hasAccepted) {
        const accepted = JSON.parse(row.accepted)
        include({ type: "reviewAccepted", context, at: accepted?.completedAt, accepted })
      }
      partial = 1; review = row.id; phase = 1; after = ""
      continue
    }
    if (phase === 3) {
      // These are recorded accounting facts, not reconstructed lifetime history.
      // Keep the same bounded cursor even when a permission has many re-reviews.
      const fact = get("SELECT id,root,outcome,at FROM permission_statistics WHERE root=? AND id>? ORDER BY id LIMIT 1", root, after)
      if (!fact) { done = true; break }
      validatePermissionStatistic(fact)
      if (fact.root !== root) throw new HistoryInvalid("Invalid conversation outcome ownership")
      totals = replacePermissionStatistic(totals, "other", fact.outcome, fact.at)
      after = fact.id
      continue
    }
    const row = get(`SELECT CASE WHEN length(CAST(context AS BLOB))<=${bytes.context} THEN context END AS context
      FROM reviews WHERE id=? AND root=?`, review, root)
    const context = JSON.parse(row?.context); validateReview(context)
    if (rootID(context) !== root || reviewID(context) !== review) throw new HistoryInvalid("Invalid conversation ownership")
    if (phase === 1) {
      const fact = get(`SELECT id,CASE WHEN length(CAST(dispatched AS BLOB))<=${bytes.dispatched} THEN dispatched END AS dispatched,
        CASE WHEN length(CAST(finalized AS BLOB))<=${bytes.finalized} THEN finalized END AS finalized,
        dispatched IS NOT NULL AS hasDispatched,finalized IS NOT NULL AS hasFinalized
        FROM attempts WHERE review=? AND id>? ORDER BY id LIMIT 1`, review, after)
      if (!fact) { phase = 2; after = ""; continue }
      if (!/^[a-f0-9]{64}$/.test(fact.id)) throw new HistoryInvalid("Invalid conversation attempt")
      if (fact.hasDispatched) include({ ...JSON.parse(fact.dispatched), type: "attemptDispatched", context, attempt: fact.id })
      if (fact.hasFinalized) include({ ...JSON.parse(fact.finalized), type: "attemptFinalized", context, attempt: fact.id })
      after = fact.id
    } else {
      const fact = get("SELECT id,root,session,at,state,automatic FROM approvals WHERE review=? AND id>? ORDER BY id LIMIT 1", review, after)
      if (!fact) { phase = 0; after = ""; continue }
      if (!/^[a-f0-9]{64}$/.test(fact.id) || fact.root !== root || fact.session !== sessionID(context) || ![-1, 0, 1].includes(fact.automatic)
        || !["pending", "uncertain", "not-sent", "confirmed"].includes(fact.state)) throw new HistoryInvalid("Invalid conversation approval")
      if (fact.state === "confirmed") {
        if (fact.automatic === -1) throw new HistoryInvalid("Invalid conversation approval")
        include({ type: "approvalConfirmed", context, at: fact.at, approval: fact.id, automatic: fact.automatic === 1 })
      }
      after = fact.id
    }
  } while (steps < HISTORY_BOOTSTRAP_STEPS && performance.now() < end)
  if (done) {
    run("INSERT INTO conversation_totals VALUES (?,?,?)", root, JSON.stringify(totals), partial)
    run("DELETE FROM conversation_bootstrap WHERE id=?", root)
  } else run(`INSERT INTO conversation_bootstrap VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    review=excluded.review,phase=excluded.phase,after=excluded.after,totals=excluded.totals,partial=excluded.partial`,
  root, review, phase, after, JSON.stringify(totals), partial)
  return { done, steps }
}
