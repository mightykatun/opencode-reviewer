import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistorySQL, type HistoryConversationTotals, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent, type HistoryEvent, type HistoryReview } from "../src/history-records.js"
import { add, empty, lifetimeReport } from "../src/lifetime.js"

const context: HistoryReview = { root: "root", session: "root", permission: "p", review: "r",
  category: "bash", configuredModel: "fixture", provider: "https://openrouter.ai/api/v1" }
function fixture(t: any) {
  const directory = mkdtempSync(path.join(tmpdir(), "conversation-statistics-")), file = path.join(directory, "history.sqlite")
  const db = new DatabaseSync(file), sql = new HistorySQL(db), clients = [sql]
  t.after(() => { clients.forEach(c => c.close()); rmSync(directory, { recursive: true, force: true }) })
  let sequence = 0
  return { db, sql, file, apply(e: HistoryEvent) { sql.apply("writer", ++sequence, encodeEvent(e)) },
    reopen() { const next = new HistorySQL(new DatabaseSync(file)); clients.push(next); return next } }
}
function seed(apply: (event: HistoryEvent) => void, c = context, tokens = 100, safe = true) {
  const events: HistoryEvent[] = [
    { type: "attemptDispatched", context: c, at: 1, attempt: "initial", retry: "initial" },
    { type: "attemptFinalized", context: c, at: 2, attempt: "initial", usage: { input: tokens, output: 10, cost: 0.01 } },
    { type: "attemptDispatched", context: c, at: 3, attempt: "retry", retry: "format" },
    { type: "attemptFinalized", context: c, at: 4, attempt: "retry", usage: { input: tokens + 20, output: 20, cost: 0.02 } },
    { type: "reviewAccepted", context: c, at: 5, accepted: { safe, completedAt: 5, timing: { fullReportMs: tokens, ratingMs: tokens / 2 } } },
    { type: "approvalConfirmed", context: c, at: 6, approval: "once", automatic: safe },
  ]
  events.forEach(apply)
  return events
}
const conversation = (sql: HistorySQL, root = "root") => sql.query({ type: "conversationTotals", root }) as HistoryConversationTotals

test("root, child and deep descendant contributions share persistent metrics while independent scopes stay isolated", t => {
  const f = fixture(t)
  seed(f.apply, context, 100)
  seed(f.apply, { ...context, session: "child", permission: "p2", review: "r2" }, 200, false)
  seed(f.apply, { ...context, session: "deep-child", permission: "p3", review: "r3" }, 300)
  const combined = conversation(f.sql)
  assert.equal(combined.partialHistory, false)
  assert.deepEqual({ reviews: combined.totals.activity.reviews, retries: combined.totals.activity.retries,
    input: combined.totals.input, output: combined.totals.output, safe: combined.totals.safe, unsafe: combined.totals.unsafe,
    auto: combined.totals.activity.autoApproved, full: combined.totals.activity.meanFullReportMs, rating: combined.totals.activity.meanRatingMs },
  { reviews: 3, retries: 3, input: 1260, output: 90, safe: 2, unsafe: 1, auto: 2, full: 200, rating: 100 })
  assert.deepEqual(combined.totals, (f.sql.query({ type: "totals" }) as HistoryTotals).totals)
  seed(f.apply, { ...context, root: "other", session: "other", review: "other", permission: "other" }, 400)
  seed(f.apply, { ...context, root: "different", session: "different", review: "elsewhere", permission: "elsewhere" }, 500)
  const reopened = f.reopen()
  assert.deepEqual(conversation(reopened).totals, combined.totals)
  assert.equal(conversation(reopened, "other").totals.input, 820)
  assert.equal(conversation(reopened, "different").totals.input, 1020)
  assert.deepEqual(conversation(reopened, "unknown").totals, empty())
  const total = (reopened.query({ type: "totals", conversation: { root: "root" } }) as HistoryTotals)
  assert.deepEqual(total.conversation?.totals, combined.totals)
  assert.deepEqual(total.totals, add(add(combined.totals, conversation(reopened, "other").totals), conversation(reopened, "different").totals))
  assert.match(lifetimeReport(combined.totals), /Safe: 2 \(66.7%\)/)
})

test("both scopes retain failed/interrupted received usage, exclude missing usage, and deduplicate event replay", t => {
  const f = fixture(t), events = seed(f.apply)
  f.apply({ type: "attemptDispatched", context, at: 7, attempt: "failed", retry: "transport" })
  f.apply({ type: "attemptFinalized", context, at: 8, attempt: "failed", usage: { input: 70, output: 5 } })
  f.apply({ type: "attemptDispatched", context, at: 9, attempt: "missing", retry: "transport" })
  f.apply({ type: "attemptFinalized", context, at: 10, attempt: "missing" })
  f.apply({ type: "attemptFinalized", context, at: 11, attempt: "cost-only", usage: { cost: 0.05 } })
  const before = conversation(f.sql).totals
  for (const [index, event] of events.entries()) f.sql.apply("second-writer", index + 1, encodeEvent(event))
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(conversation(f.sql).totals, before)
    assert.deepEqual((f.sql.query({ type: "totals" }) as HistoryTotals).totals, before)
  }
  assert.equal(before.input, 290); assert.equal(before.output, 35)
  assert.equal(before.requests, 4); assert.equal(before.tokenRequests, 3); assert.equal(before.priced, 3)
  assert.equal(before.activity.retries, 3); assert.equal(before.activity.reviews, 1)
  assert.match(lifetimeReport(before), /Tokens: 290 in 35 out \(partial coverage\)/)
})

test("deletion, rollback and restart cannot reduce or double-count conversation totals", t => {
  const f = fixture(t), events = seed(f.apply, { ...context, session: "child" })
  const before = conversation(f.sql).totals
  f.apply({ type: "sessionDeleted", context: { root: context.root, session: "child" }, at: 10 })
  assert.deepEqual(conversation(f.sql).totals, before)
  assert.equal(f.db.prepare("SELECT count(*) n FROM reviews").get()!.n, 1)
  const reopened = f.reopen()
  events.forEach((event, index) => reopened.apply("replay", index + 1, encodeEvent(event)))
  assert.deepEqual(conversation(reopened).totals, before)
  const next: HistoryEvent = { type: "attemptFinalized", context: { ...context, session: "child", review: "new" }, at: 11, attempt: "post", usage: { input: 50, output: 5 } }
  assert.throws(() => reopened.apply("rollback", 1, encodeEvent(next), () => { throw new Error("rollback") }))
  assert.deepEqual(conversation(reopened).totals, before)
  reopened.apply("rollback", 1, encodeEvent(next))
  assert.equal(conversation(reopened).totals.input, before.input + 50)
})
