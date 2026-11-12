import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HistorySQL, type HistorySelection, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent, type HistoryEvent, type HistoryReview } from "../src/history-records.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"
import { parseConfig } from "../src/config.js"
import { historyOutcome } from "../src/review-lines.js"
import type { HostRequest } from "../src/host-types.js"

const context: HistoryReview = { scope: "/project", root: "root", session: "child", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const accepted = (c = context, reason?: string): HistoryEvent => ({ type: "reviewAccepted", context: c, at: 100,
  accepted: { safe: false, completedAt: 100 }, ...(reason ? { reason } : {}) })
const rejection = (c = context, steering = "Please narrow it."): HistoryEvent => ({ type: "rejectionConfirmed", context: c, at: 110, approval: "a", steering })
const resolved = (c = context): HistoryEvent => ({ type: "permissionResolved", context: c, at: 120, outcome: "rejected",
  payload: { safe: false, completedAt: 100, desc: "Removes everything." } })
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-steering-")), file = path.join(dir, "history.sqlite")
  const db = new DatabaseSync(file), sql = new HistorySQL(db), clients = [sql]
  t.after(() => { clients.forEach(client => client.close()); rmSync(dir, { recursive: true, force: true }) })
  let sequence = 0
  return { db, sql, apply: (e: HistoryEvent) => sql.apply("writer", ++sequence, encodeEvent(e)),
    open: () => { const client = new HistorySQL(new DatabaseSync(file)); clients.push(client); return client } }
}
const totals = (sql: HistorySQL, c = context) => sql.query({ type: "totals", conversation: { scope: c.scope, root: c.root } }) as HistoryTotals
const selection = (sql: HistorySQL) => sql.query({ type: "history", scope: context.scope, root: context.root }) as HistorySelection

test("reasons and confirmed steering are side-table details, the payload keeps its shape and the outcome label is Auto rejected", t => {
  const f = fixture(t)
  f.apply(accepted(context, "Deletes the whole tree.")); f.apply(rejection()); f.apply(resolved())
  const record = selection(f.sql).record!
  assert.equal(record.reason, "Deletes the whole tree.")
  assert.equal(record.steering, "Please narrow it.")
  assert.equal(record.outcome, "rejected", "stored outcome stays readable by older workers")
  assert.deepEqual(Object.keys(JSON.parse(String(f.db.prepare("SELECT body FROM payloads").get()!.body))).sort(), ["completedAt", "desc", "safe"])
  assert.deepEqual(Object.keys(JSON.parse(String(f.db.prepare("SELECT accepted FROM reviews").get()!.accepted))).sort(), ["completedAt", "safe"])
  assert.equal(historyOutcome(record.outcome, record.steering), "Auto rejected")
  assert.equal(historyOutcome("rejected"), "Rejected")
  const manual = { ...context, permission: "manual", review: "manual-review" }
  f.apply(accepted(manual)); f.apply(resolved(manual))
  const older = f.sql.query({ type: "history", scope: context.scope, root: context.root, permission: { session: manual.session, permission: manual.permission } }) as HistorySelection
  assert.equal(older.record!.reason, undefined, "a report without a reason shows desc only")
  assert.equal(older.record!.steering, undefined)
})

test("the automatic rejection ledger counts once per permission in both scopes and never shrinks on deletion", t => {
  const f = fixture(t), second = f.open()
  f.apply(accepted()); f.apply(rejection())
  second.apply("second", 1, encodeEvent(rejection())) // the same fact from another writer
  f.apply(rejection(context, "Please do something else.")) // a repeated confirmation of the same permission
  const other = { ...context, root: "other-root", session: "other", permission: "p2", review: "r2" }
  f.apply(accepted(other)); f.apply(rejection(other))
  const value = totals(f.open())
  assert.equal(value.totals.activity.autoRejected, 2)
  assert.equal(value.conversation!.totals.activity.autoRejected, 1)
  assert.equal(totals(f.sql, other).conversation!.totals.activity.autoRejected, 1)
  f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.session }, at: 300 })
  assert.equal(f.db.prepare("SELECT count(*) n FROM auto_rejections").get()!.n, 1, "only the deleted conversation's details are removed")
  assert.equal(f.db.prepare("SELECT count(*) n FROM review_reasons").get()!.n, 0)
  assert.equal(totals(f.sql).totals.activity.autoRejected, 2, "deletion never reduces recorded totals")
  f.apply(rejection())
  assert.equal(totals(f.sql).totals.activity.autoRejected, 2, "replay after deletion cannot count again")
})

test("invalid steering events are rejected and old databases gain the tables on open", t => {
  for (const steering of ["", " ", 7, null]) assert.throws(() => encodeEvent({ ...rejection(), steering } as any))
  assert.throws(() => encodeEvent({ ...accepted(), reason: "" } as any))
  const f = fixture(t)
  f.db.exec("DROP TABLE review_reasons; DROP TABLE auto_rejections; DROP TABLE auto_rejection_totals")
  const reopened = f.open()
  assert.equal(totals(reopened).totals.activity.autoRejected, undefined, "no ledger row reads as zero without changing the shape")
  reopened.apply("reopened", 1, encodeEvent(accepted(context, "Reason.")))
  assert.equal(f.db.prepare("SELECT reason FROM review_reasons").get()!.reason, "Reason.")
})

test("the coordinator saves the reason and records a confirmed steering rejection without approval accounting", t => {
  const f = fixture(t), events: HistoryEvent[] = []
  const coordinator = new HistoryCoordinator(context.scope, {
    admit(event) { events.push(event); f.apply(event); return true }, query: async query => f.sql.query(query), onCommit: () => () => {},
  }, async () => context.root, () => 100)
  t.after(() => coordinator.dispose())
  const request = { id: context.permission, sessionID: context.session, action: "shell", resources: ["rm -rf build"] } as HostRequest
  const config = parseConfig({ baseURL: context.provider, model: context.configuredModel, autoRejectSteering: true })
  coordinator.observation(request, "shell", config, { review: context.review, root: context.root })
  const result = { safe: false, reason: "Deletes too much.", steering: "Please narrow it.", desc: "Removes everything.",
    metadata: { review: context.review, kind: "shell" as const, configuredModel: context.configuredModel, provider: context.provider } }
  coordinator.lifecycle({ type: "accepted", request, root: context.root, review: context.review, result, completedAt: 100, timing: { fullReportMs: 1, ratingMs: 1 } })
  const fact = { request, automatic: true, approval: "steer-1", review: context.review, decision: "reject" as const, steering: "Please narrow it." }
  coordinator.approval({ ...fact, type: "dispatched" })
  coordinator.reply({ requestID: request.id, sessionID: request.sessionID, reply: "reject" })
  coordinator.approval({ ...fact, type: "confirmed" })
  coordinator.approval({ ...fact, type: "settled" })
  assert.deepEqual(events.map(event => event.type), ["reviewAccepted", "permissionResolved", "rejectionConfirmed"])
  assert.equal((events[0] as Extract<HistoryEvent, { type: "reviewAccepted" }>).reason, "Deletes too much.")
  const value = totals(f.sql)
  assert.equal(value.totals.activity.autoApproved, 0)
  assert.equal(value.totals.activity.autoRejected, 1)
  assert.equal(value.totals.activity.rejected, 1)
  const record = selection(f.sql).record!
  assert.equal(historyOutcome(record.outcome, record.steering), "Auto rejected")
})
