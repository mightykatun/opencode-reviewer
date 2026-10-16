import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { deleteHistory, HISTORY_DELETE_MS } from "../src/history-deletion.js"
import { HistorySQL, type HistoryDatabase } from "../src/history-schema.js"
import { encodeEvent, entryID, reviewID, rootID, sessionID, type HistoryReview } from "../src/history-records.js"

for (const session of ["child", "root"]) test(`${session} deletion preserves row order and checks the time budget after every row`, t => {
  const db = new DatabaseSync(":memory:"), sql = new HistorySQL(db)
  t.after(() => sql.close())
  const context: HistoryReview = { scope: "/deletion", root: "root", session, permission: "permission", review: "review",
    category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
  sql.apply("seed", 1, encodeEvent({ type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } }))
  sql.apply("seed", 2, encodeEvent({ type: "permissionResolved", context, at: 2, outcome: "manual",
    payload: { safe: true, completedAt: 1, desc: "Saved report" } }))
  db.prepare("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)").run("approval", entryID(context), rootID(context),
    sessionID(context), reviewID(context), "pending", 0, 3)
  const attempt = db.prepare("INSERT INTO attempts VALUES (?,?,NULL,NULL)")
  for (const id of ["first", "second"]) attempt.run(id, reviewID(context))
  const conversation = { scope: context.scope, root: context.root }
  const totals = sql.query({ type: "totals", conversation })
  const deleted: string[] = []
  const measured: HistoryDatabase = { exec: text => db.exec(text), close: () => db.close(), prepare(text) {
    const statement = db.prepare(text)
    return { get: (...args) => statement.get(...args), all: (...args) => statement.all(...args), run: (...args) => {
      const table = /^DELETE FROM (\w+) WHERE id=\?$/.exec(text)?.[1]
      if (table) deleted.push(table)
      return statement.run(...args)
    } }
  } }
  let reads = 0
  t.mock.method(performance, "now", () => reads++ * HISTORY_DELETE_MS)
  const order = ["history", "approvals", "attempts", "attempts", "reviews", "sessions"]
  db.exec("BEGIN IMMEDIATE")
  for (let index = 0; index < order.length; index++) {
    assert.equal(deleteHistory(measured, context), false)
    assert.deepEqual(deleted, order.slice(0, index + 1), "Exactly one row removed before the elapsed-budget check")
    assert.equal(reads, (index + 1) * 2, "Each incomplete slice measures its start and its one completed row")
  }
  assert.equal(deleteHistory(measured, context), true)
  assert.deepEqual(deleted, [...order, "history_deletions"])
  assert.equal(reads, order.length * 2 + 1, "Completion does not add another budget check")
  db.exec("COMMIT")
  assert.deepEqual(sql.query({ type: "totals", conversation }), totals)
  assert.equal(db.prepare("SELECT count(*) AS n FROM tombstones").get()!.n, 1)
})
