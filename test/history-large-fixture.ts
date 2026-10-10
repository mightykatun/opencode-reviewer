import type { DatabaseSync } from "node:sqlite"
import { entryID, opaque, reviewID, rootID, sessionID, type HistoryReview } from "../src/history-records.js"

export const largeContext: HistoryReview = { scope: "/large", root: "legacy", session: "legacy", permission: "p0", review: "r0",
  category: "bash", configuredModel: "fixture", provider: "https://example.com/v1" }

/** Real valid v1 rows, seeded in one transaction to exclude per-event fsync cost. */
export function seedLarge(db: DatabaseSync, reviews: number, attempts = 0, history = false, approvals = 0) {
  const c = largeContext, root = rootID(c), session = sessionID(c)
  db.exec("BEGIN IMMEDIATE")
  db.prepare("INSERT INTO roots VALUES (?,1)").run(root)
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run(session, c.scope, c.root, c.session)
  const insert = db.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,?)")
  const insertHistory = db.prepare("INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  const insertPayload = db.prepare("INSERT INTO payloads VALUES (?,?)")
  for (let n = 0; n < reviews; n++) {
    const context = { ...c, review: `r${n}`, permission: `p${n}` }, id = reviewID(context), entry = entryID(context)
    insert.run(id, entry, root, session, JSON.stringify(context), JSON.stringify({ safe: true, completedAt: n + 1 }))
    if (history) {
      insertHistory.run(entry, c.scope, root, session, context.permission, n + 1, context.review, id, "manual", "manual", null, n + 1)
      insertPayload.run(entry, JSON.stringify({ safe: true, completedAt: n + 1, desc: `report ${n}` }))
    }
  }
  const insertAttempt = db.prepare("INSERT INTO attempts VALUES (?,?,?,?)")
  for (let n = 0; n < attempts; n++) insertAttempt.run(opaque(reviewID(c), `a${n}`), reviewID(c),
    JSON.stringify({ at: 1, retry: "transport" }), JSON.stringify({ at: 2, usage: { input: 1, output: 2 } }))
  const insertApproval = db.prepare("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)")
  for (let n = 0; n < approvals; n++) insertApproval.run(opaque(entryID(c), `ap${n}`), entryID(c), root, session, reviewID(c), "confirmed", 1, 3)
  db.exec("COMMIT")
}
