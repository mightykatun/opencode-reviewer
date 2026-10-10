import { HistoryInvalid, rootID, sessionID } from "./history-records.js"
import type { HistoryScope } from "./history-records.js"
import type { HistoryDatabase } from "./history-schema.js"

export const HISTORY_DELETE_STEPS = 128
export const HISTORY_DELETE_MS = 40

/**
 * Within applyReady's transaction, after the conversation baseline is committed.
 * The tombstone immediately prevents resurrection by other writers. Remaining
 * indexed rows are the durable cursor; replay resumes them without subtracting
 * totals. No writer acknowledgement until the last slice. Explicitly remove
 * attempts before their review so one cascade cannot contain unlimited children.
 * The time limit is cooperative between rows, not an SQLite I/O deadline.
 */
export function deleteHistory(db: HistoryDatabase, context: HistoryScope): boolean {
  const root = rootID(context), session = sessionID(context), isRoot = context.root === context.session
  const owner = db.prepare("SELECT root FROM sessions WHERE id=?").get(session)
  if (owner && owner.root !== context.root) throw new HistoryInvalid("Conflicting session ownership")
  db.prepare("INSERT OR IGNORE INTO tombstones VALUES (?)").run(isRoot ? root : session)
  db.prepare("INSERT OR IGNORE INTO history_deletions VALUES (?,?,?,?)").run(session, context.scope, context.root, context.session)
  db.exec("UPDATE history_privacy SET generation=generation+1 WHERE id=1")
  const key = isRoot ? root : session, column = isRoot ? "root" : "session"
  const history = db.prepare(`SELECT id FROM history WHERE ${column}=? LIMIT 1`)
  const approval = db.prepare(`SELECT id FROM approvals WHERE ${column}=? LIMIT 1`)
  const review = db.prepare(`SELECT id FROM reviews WHERE ${column}=? LIMIT 1`)
  const attempt = db.prepare("SELECT id FROM attempts WHERE review=? LIMIT 1")
  const removeHistory = db.prepare("DELETE FROM history WHERE id=?")
  const removeApproval = db.prepare("DELETE FROM approvals WHERE id=?")
  const removeReview = db.prepare("DELETE FROM reviews WHERE id=?")
  const removeAttempt = db.prepare("DELETE FROM attempts WHERE id=?")
  const nextSession = db.prepare(isRoot ? "SELECT id FROM sessions WHERE scope=? AND root=? LIMIT 1" : "SELECT id FROM sessions WHERE id=?")
  const removeSession = db.prepare("DELETE FROM sessions WHERE id=?")
  const end = performance.now() + HISTORY_DELETE_MS
  for (let step = 0; step < HISTORY_DELETE_STEPS; step++) {
    const h = history.get(key)
    if (h) removeHistory.run(h.id) // Exactly one bounded payload, including overflow pages.
    else {
      const a = approval.get(key)
      if (a) removeApproval.run(a.id)
      else {
        const r = review.get(key)
        if (r) {
          const a = attempt.get(r.id)
          if (a) removeAttempt.run(a.id)
          else removeReview.run(r.id)
        } else {
          const s = isRoot ? nextSession.get(context.scope, context.root) : nextSession.get(session)
          if (s) removeSession.run(s.id)
          else {
            db.prepare("DELETE FROM history_deletions WHERE id=?").run(session)
            return true
          }
        }
      }
    }
    if (performance.now() >= end) break
  }
  return false
}
