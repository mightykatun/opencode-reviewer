import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistorySQL, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent, rootID, type HistoryEvent, type HistoryOutcome, type HistoryReview } from "../src/history-records.js"
import { HISTORY_BOOTSTRAP_STEPS } from "../src/history-migration.js"
import { empty } from "../src/lifetime.js"

const context: HistoryReview = { scope: "/project", root: "root", session: "child", permission: "permission", review: "review",
  category: "bash", configuredModel: "fixture", provider: "https://example.com/v1" }
const resolved = (outcome: HistoryOutcome, c = context): HistoryEvent => ({ type: "permissionResolved", context: c,
  at: 2, outcome, payload: { safe: false, completedAt: 1, desc: "Resolved report" } })
const deleted = (): HistoryEvent => ({ type: "sessionDeleted", at: 4,
  context: { scope: context.scope, root: context.root, session: context.session } })

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "history-outcomes-")), file = path.join(directory, "history.sqlite")
  const db = new DatabaseSync(file), sql = new HistorySQL(db), clients = [sql]
  t.after(() => { clients.forEach(client => client.close()); rmSync(directory, { recursive: true, force: true }) })
  let sequence = 0
  const totals = (client = sql, c = context) => client.query({ type: "totals", conversation: { scope: c.scope, root: c.root } }) as HistoryTotals
  return { db, sql, totals, apply: (event: HistoryEvent) => sql.apply("writer", ++sequence, encodeEvent(event)),
    reopen() {
      const connection = new DatabaseSync(file)
      try { const next = new HistorySQL(connection); clients.push(next); return next }
      catch (error) { connection.close(); throw error }
    } }
}
function outcomes(result: HistoryTotals) {
  const pick = (activity: HistoryTotals["totals"]["activity"]) => [activity.manuallyApproved, activity.rejected]
  return { lifetime: pick(result.totals.activity), conversation: pick(result.conversation!.totals.activity) }
}

test("permission outcomes deduplicate across reports, writers and restart while retaining scoped totals through deletion", t => {
  const f = fixture(t), rejected = { ...context, permission: "rejected", review: "rejected" }
  f.apply(resolved("manual"))
  f.apply(resolved("manual", { ...context, review: "second-review" }))
  f.apply(resolved("rejected", rejected))
  const second = f.reopen()
  second.apply("second", 1, encodeEvent(resolved("manual")))
  second.apply("second", 2, encodeEvent(resolved("rejected", rejected)))
  // A separate approval confirmation proves the same permission, not another approval.
  f.apply({ type: "approvalConfirmed", context, at: 3, approval: "confirmation", automatic: false })
  assert.deepEqual(outcomes(f.totals(second)), { lifetime: [1, 1], conversation: [1, 1] })
  const other = { ...context, scope: "/other-host" }
  f.apply(resolved("manual", other))
  assert.deepEqual(outcomes(f.totals(second)), { lifetime: [2, 1], conversation: [1, 1] })
  assert.deepEqual(outcomes(f.totals(second, other)), { lifetime: [2, 1], conversation: [1, 0] })
  const before = f.totals(second)
  f.apply(deleted())
  f.apply(resolved("manual")); f.apply(resolved("rejected", rejected))
  assert.deepEqual(f.totals(f.reopen()), before)
})

test("unattributed approval and cancellation never count as manual, and late confirmation reconciles both scopes", t => {
  const f = fixture(t)
  f.apply(resolved("approved"))
  f.apply(resolved("cancelled"))
  f.apply({ type: "approvalDispatched", context, at: 3, approval: "write", automatic: true })
  f.apply({ type: "approvalSettled", context, at: 4, approval: "write", result: "uncertain" })
  assert.deepEqual(outcomes(f.totals()), { lifetime: [0, 0], conversation: [0, 0] })
  f.apply({ type: "approvalConfirmed", context, at: 5, approval: "write", automatic: true })
  assert.deepEqual(outcomes(f.totals()), { lifetime: [0, 0], conversation: [0, 0] })
  assert.equal(f.totals().totals.activity.autoApproved, 1)
  const late = { ...context, permission: "late", review: "late" }
  f.apply(resolved("manual", late))
  assert.deepEqual(outcomes(f.totals()), { lifetime: [1, 0], conversation: [1, 0] })
  f.apply({ type: "approvalConfirmed", context: late, at: 6, approval: "late-write", automatic: true })
  f.apply(resolved("manual", late))
  assert.deepEqual(outcomes(f.totals(f.reopen())), { lifetime: [0, 0], conversation: [0, 0] })
  assert.equal(f.totals().totals.activity.autoApproved, 2)
})

test("late native rejection is counted once, rollback is atomic, and contradictory outcomes lose attribution", t => {
  const f = fixture(t)
  f.apply(resolved("cancelled"))
  const event: HistoryEvent = { type: "permissionOutcome", context, at: 3, outcome: "rejected" }
  const before = f.totals()
  assert.throws(() => f.sql.apply("rollback", 1, encodeEvent(event), () => { throw new Error("rollback") }))
  assert.deepEqual(f.totals(), before)
  f.sql.apply("rollback", 1, encodeEvent(event))
  assert.equal(f.totals().revision, before.revision + 1)
  f.apply(event)
  assert.equal(f.totals().revision, before.revision + 1, "duplicate outcomes cannot advance aggregate revision")
  assert.deepEqual(outcomes(f.totals()), { lifetime: [0, 1], conversation: [0, 1] })
  f.apply(resolved("manual"))
  assert.deepEqual(outcomes(f.totals()), { lifetime: [0, 0], conversation: [0, 0] })
  assert.equal(f.totals().totals.activity.since, null)
  f.apply(event)
  assert.deepEqual(outcomes(f.totals()), { lifetime: [0, 0], conversation: [0, 0] })
})

test("manual confirmation before a report is counted once when the final report arrives", t => {
  const f = fixture(t)
  f.apply({ type: "approvalConfirmed", context, at: 1, approval: "write", automatic: false })
  assert.deepEqual(outcomes(f.totals()), { lifetime: [1, 0], conversation: [1, 0] })
  f.apply(resolved("approved"))
  f.apply({ type: "approvalConfirmed", context, at: 1, approval: "write", automatic: false })
  assert.deepEqual(outcomes(f.totals()), { lifetime: [1, 0], conversation: [1, 0] })
})

test("older aggregate records gain counters internally without reconstructing lifetime history", t => {
  const f = fixture(t)
  f.apply(resolved("manual"))
  const legacy = { ...empty(), safe: 3200, ratingsSince: 1,
    activity: { ...empty().activity, reviews: 3200, autoApproved: 2610, since: 1 } }
  delete (legacy.activity as any).manuallyApproved; delete (legacy.activity as any).rejected
  f.db.prepare("UPDATE meta SET totals=?").run(JSON.stringify(legacy))
  f.db.prepare("UPDATE conversation_totals SET totals=?").run(JSON.stringify(legacy))
  f.db.exec("DROP TABLE permission_statistics")
  const migrated = f.reopen(), result = f.totals(migrated)
  assert.deepEqual(result.totals, { ...legacy, activity: { ...legacy.activity, manuallyApproved: 0, rejected: 0 } })
  assert.deepEqual(result.conversation!.totals, result.totals)
  migrated.apply("new", 1, encodeEvent(resolved("rejected", { ...context, permission: "new", review: "new" })))
  assert.deepEqual(outcomes(f.totals(migrated)), { lifetime: [0, 1], conversation: [0, 1] })
  assert.equal(f.totals(migrated).totals.safe, 3200)
  f.db.prepare("UPDATE meta SET totals=?").run(JSON.stringify({ ...legacy, activity: { ...legacy.activity, rejected: 1 } }))
  assert.throws(() => f.reopen(), /Invalid lifetime activity totals/)
})

test("conversation bootstrap pages permission accounting and leaves lifetime totals untouched", t => {
  const f = fixture(t)
  for (let i = 0; i < 300; i++) f.apply(resolved(i % 2 ? "manual" : "rejected",
    { ...context, permission: `p-${i}`, review: `r-${i}` }))
  const before = f.totals()
  // All details can disappear while aggregate accounting remains attributable.
  f.apply(deleted())
  f.db.exec("DELETE FROM conversation_totals")
  const root = rootID(context)
  assert.deepEqual(f.sql.queryReady({ type: "totals", conversation: { scope: context.scope, root: context.root } }), { pending: root })
  let slices = 0
  for (;;) {
    const result = f.sql.bootstrap(root)
    assert.ok(result.steps <= HISTORY_BOOTSTRAP_STEPS)
    slices++
    if (result.done) break
  }
  assert.ok(slices >= 3)
  const after = f.totals(f.reopen())
  assert.deepEqual(after.totals, before.totals)
  assert.deepEqual(outcomes(after), { lifetime: [150, 150], conversation: [150, 150] })
})
