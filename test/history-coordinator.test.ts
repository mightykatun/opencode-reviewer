import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as settle } from "node:timers/promises"
import type { HostRequest } from "../src/host-types.js"
import { HistoryCoordinator, drainHistory } from "../src/history-coordinator.js"
import { HistorySQL, type HistorySelection, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent, reviewID, type HistoryEvent, type HistoryQuery } from "../src/history-records.js"
import type { HistoryRead } from "../src/history-store.js"
import { Controller, type ReviewLifecycleFact } from "../src/controller.js"
import type { ReviewResult } from "../src/types.js"
import { parseConfig } from "../src/config.js"

const request: HostRequest = { id: "permission", sessionID: "child", action: "shell", resources: ["secret command"],
  source: { assistantID: "message", id: "call" } }
const config = parseConfig({ model: "configured", baseURL: "https://openrouter.ai/api/v1", notify: false })
const result = (review = "review", safe = true): ReviewResult => ({ safe, desc: `private report ${review}`,
  metadata: { review, kind: "shell", configuredModel: config.model, provider: config.baseURL, reportedModel: "reported" }, usage: { cost: 0 } })
const accepted = (value = result(), req = request, completedAt = 100): ReviewLifecycleFact => ({ type: "accepted", request: req,
  result: value, root: "root", review: value.metadata!.review, completedAt, timing: { fullReportMs: 10, ratingMs: 5 } })
const removed = (req = request): ReviewLifecycleFact => ({ type: "removed", request: req, reason: "reconciled" })

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:"), sql = new HistorySQL(db)
  const events: HistoryEvent[] = [], commits = new Set<() => unknown>()
  let sequence = 0, admit = true, now = 1000, monotonic = 0
  let query: (q: HistoryQuery) => HistoryRead = q => Promise.resolve(sql.query(q))
  const store = { admit(e: HistoryEvent) {
    if (!admit) return false
    const serialized = encodeEvent(e)
    events.push(JSON.parse(serialized)); sql.apply("writer", ++sequence, serialized); return true
  }, query: (q: HistoryQuery) => query(q), onCommit: (fn: () => unknown) => { commits.add(fn); return () => { commits.delete(fn) } } }
  const make = (ancestry = async () => "root") => new HistoryCoordinator("/host", store, ancestry, () => now, () => monotonic)
  const h = make()
  t.after(() => { h.dispose(); sql.close() })
  return { h, make, events, store, db,
    query: (fn: typeof query) => { query = fn }, advance: (ms: number) => { now += ms; monotonic += ms },
    jumpWall: (ms: number) => { now += ms }, wall: () => now,
    admission: (value: boolean) => { admit = value }, commit: () => { for (const fn of commits) fn() },
    history: () => sql.query({ type: "history", scope: "/host", root: "root" }) as HistorySelection,
    totals: () => (sql.query({ type: "totals" }) as HistoryTotals).totals }
}

test("accepted bodies remain memory-only; actual evidence category and invocation scope drive attempt context", async t => {
  const f = fixture(t)
  const observer = f.h.observation(request, "external-directory", config, { review: "execution", root: "root" })
  observer.observe!({ type: "dispatched", review: "execution", attempt: "post", retry: "initial" })
  observer.observe!({ type: "finalized", review: "execution", attempt: "post", reportedModel: "failed-model", usage: { cost: 0 } })
  const value = result("execution"); value.metadata!.kind = "external-directory"
  f.h.lifecycle(accepted(value))
  assert.equal(f.history().total, 0)
  assert.ok(f.events.every(e => !JSON.stringify(e).includes("private report")))
  assert.ok(f.events.every(e => !JSON.stringify(e).includes("secret command")))
  assert.ok(f.events.every(e => "category" in e.context && e.context.category === "external_directory" && e.context.scope === "/host"))
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  assert.equal(f.totals().requests, 1)
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "always" }); f.h.lifecycle(removed())
  assert.equal(f.history().record?.payload.desc, value.desc)
  assert.equal(f.history().record?.outcome, "manual")
  assert.equal(await f.h.root("child", new AbortController().signal), "root")
})

test("all completed reviews of one rejected permission survive independently of accepted accounting", async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted()); f.h.lifecycle(accepted(result("second", false), request, 200))
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "reject" }); f.h.lifecycle(removed())
  assert.equal(f.history().record?.payload.desc, "private report second")
  assert.equal(f.history().record?.outcome, "rejected")
  assert.equal(f.history().total, 2)
  const older = await f.store.query({ type: "history", scope: "/host", root: "root", entry: f.history().older })
  assert.equal((older as HistorySelection).record?.payload.desc, "private report review")
  assert.equal((f.db.prepare("SELECT count(*) n FROM payloads").get()!).n, 2)
  assert.equal(f.totals().safe, 1); assert.equal(f.totals().unsafe, 1)
})

for (const automatic of [false, true]) test(`all completed reviews save on confirmed ${automatic ? "automatic" : "manual"} approval`, async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted())
  f.h.lifecycle(accepted(result("second", false), request, 200))
  const fact = { request, automatic, approval: "write", review: "review" }
  f.h.approval({ ...fact, type: "dispatched" })
  f.h.approval({ ...fact, type: "confirmed" })
  f.h.approval({ ...fact, type: "confirmed" })
  f.h.lifecycle(removed())
  assert.equal(f.history().total, 2)
  assert.equal(f.history().record?.outcome, automatic ? "auto" : "manual")
  const earlier = await f.store.query({ type: "history", scope: "/host", root: "root", entry: f.history().older }) as HistorySelection
  assert.equal(earlier.record?.payload.safe, true)
  assert.equal(earlier.record?.outcome, automatic ? "auto" : "manual")
  assert.equal(f.events.filter(e => e.type === "permissionResolved").length, 2)
  assert.equal(f.totals().activity.autoApproved, automatic ? 1 : 0)
  assert.equal(f.totals().activity.reviews, 2)
})

test("duplicate completion and native reply observations never duplicate stored reviews or statistics", t => {
  const f = fixture(t)
  f.h.lifecycle(accepted()); f.h.lifecycle(accepted())
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "once" })
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "once" })
  f.h.lifecycle(accepted())
  assert.equal(f.history().total, 1)
  assert.equal(f.totals().activity.reviews, 1)
  assert.equal(f.totals().safe, 1)
})

for (const reason of ["explicit", "mode"] as const) test(`${reason} cancellation and removal alone never save a report`, async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted()); f.h.lifecycle({ type: "cancelled", request, reason })
  assert.equal(f.history().total, 0)
  f.h.lifecycle(removed()); f.h.lifecycle(removed())
  await settle()
  assert.equal(f.history().total, 0)
  assert.equal(f.events.filter(e => e.type === "permissionResolved").length, 0)
})

test("a native decision after cancellation saves its report without guessing contradictory outcomes", async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted()); f.h.lifecycle({ type: "cancelled", request, reason: "explicit" }); f.h.lifecycle(removed())
  await settle()
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "always" })
  assert.equal(f.history().record?.outcome, "manual")
  assert.equal(f.events.filter(e => e.type === "permissionResolved").length, 1)
  assert.equal(f.events.at(-1)?.type, "permissionResolved")
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "reject" })
  assert.equal(f.history().total, 0, "contradictory explicit outcomes remain omitted")
})

test("native once saves a report without guessing manual or automatic attribution", async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted()); f.h.lifecycle({ type: "cancelled", request, reason: "explicit" })
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "once" }); f.h.lifecycle(removed())
  await settle()
  assert.equal(f.history().record?.outcome, "approved")
  assert.equal(f.events.filter(e => e.type === "permissionResolved").length, 1)
  assert.equal(f.totals().activity.autoApproved, 0)
})

for (const automatic of [true, false]) test(`native approval saves before ack; ${automatic ? "automatic" : "footer manual"} attribution waits for confirmation`, async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted())
  const fact = { request, automatic, approval: "approval", review: "review" }
  f.h.approval({ ...fact, type: "dispatched" })
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "once" }); f.h.lifecycle(removed())
  await settle(); assert.equal(f.history().record?.outcome, "approved")
  assert.equal(f.totals().activity.autoApproved, 0)
  f.h.approval({ ...fact, type: "confirmed" }); f.h.approval({ ...fact, type: "settled" })
  assert.equal(f.history().record?.outcome, automatic ? "auto" : "manual")
  assert.equal(f.totals().activity.autoApproved, automatic ? 1 : 0)
})

test("uncertain dispatched writes suppress both auto-cancel and confirmed stop attribution", async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted())
  const fact = { request, automatic: true, approval: "approval", review: "review" }
  f.h.approval({ ...fact, type: "dispatched" }); f.h.approval({ ...fact, type: "settled", result: "uncertain" })
  f.h.lifecycle({ type: "cancelled", request, reason: "mode" }); f.h.lifecycle(removed())
  await settle()
  assert.equal(f.history().total, 0); assert.equal(f.totals().activity.autoApproved, 0)
})

test("not-sent settlement and cancellation never fabricate permission resolution", async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted())
  const fact = { request, automatic: true, approval: "approval", review: "review" }
  f.h.approval({ ...fact, type: "dispatched" }); f.h.approval({ ...fact, type: "settled", result: "not-sent" })
  f.h.lifecycle({ type: "cancelled", request, reason: "mode" }); f.h.lifecycle(removed())
  await settle()
  assert.equal(f.history().total, 0); assert.equal(f.totals().activity.autoApproved, 0)
})

for (const safe of [true, false]) for (const reply of ["once", "always", "reject"] as const)
test(`${safe ? "Safe" : "Unsafe"} report saves on exact native ${reply}, without relying on removal`, t => {
  const f = fixture(t)
  f.h.lifecycle(accepted(result("review", safe)))
  f.h.reply({ requestID: request.id, sessionID: "other", reply })
  assert.equal(f.history().total, 0)
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply })
  assert.equal(f.history().record?.payload.safe, safe)
  assert.equal(f.history().record?.outcome, reply === "reject" ? "rejected" : reply === "always" ? "manual" : "approved")
  f.h.lifecycle(removed())
  assert.equal(f.events.filter(e => e.type === "permissionResolved").length, 1)
})

test("two coordinators reconcile delayed remote confirmation with latest Unsafe payload", async t => {
  const f = fixture(t), second = f.make(); t.after(() => second.dispose())
  f.h.lifecycle(accepted()); second.lifecycle(accepted(result("newer", false), request, 200))
  const fact = { request, automatic: true, approval: "approval", review: "review" }
  f.h.approval({ ...fact, type: "dispatched" })
  for (const h of [f.h, second]) { h.reply({ requestID: request.id, sessionID: "child", reply: "once" }); h.lifecycle(removed()) }
  await settle(); assert.equal(f.history().total, 2)
  assert.equal(f.history().record?.outcome, "approved")
  f.h.approval({ ...fact, type: "confirmed" }); f.h.approval({ ...fact, type: "settled" })
  f.advance(2000); f.commit(); await settle()
  assert.equal(f.history().record?.payload.safe, false)
  assert.equal(f.history().record?.context.review, "newer")
  assert.equal(f.history().record?.outcome, "auto")
  assert.equal(f.history().record?.approvingReview, reviewID(f.events[0]!.context as any))
  assert.equal(f.totals().activity.autoApproved, 1)
})

test("observed remote uncertainty suppresses cancellation bodies until shared confirmation", async t => {
  const f = fixture(t), second = f.make(); t.after(() => second.dispose())
  f.h.lifecycle(accepted()); second.lifecycle(accepted(result("newer", false), request, 200))
  const fact = { request, automatic: true, approval: "approval", review: "review" }
  f.h.approval({ ...fact, type: "dispatched" })
  second.lifecycle({ type: "cancelled", request, reason: "explicit" }); second.lifecycle(removed())
  await settle()
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  f.h.approval({ ...fact, type: "confirmed" }); f.h.approval({ ...fact, type: "settled" })
  f.advance(2000); f.commit(); await settle()
  assert.equal(f.history().record?.context.review, "newer")
  assert.equal(f.history().record?.outcome, "auto")
})

test("live child deletion after restart uses stored ownership when public ancestry is already gone", async t => {
  const f = fixture(t)
  f.h.lifecycle(accepted()); f.h.reply({ requestID: request.id, sessionID: "child", reply: "always" }); f.h.lifecycle(removed())
  f.h.dispose()
  const resumed = f.make(async () => { throw new Error("session missing") }); t.after(() => resumed.dispose())
  await resumed.sessionDeleted({ id: "child", parentID: "root" })
  assert.equal(f.history().total, 0); assert.equal(f.totals().safe, 1)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
})

test("missing, unavailable, late and wrong-session facts never invent outcomes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t)
  f.query(() => Promise.reject(new Error("unavailable")))
  f.h.lifecycle(accepted()); f.h.reply({ requestID: request.id, sessionID: "other", reply: "always" }); f.h.lifecycle(removed())
  await settle(); assert.equal(f.history().total, 0)
  f.advance(7000); t.mock.timers.tick(7000); await settle()
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "always" })
  assert.equal(f.history().total, 0, "expired candidate is dropped, not queued elsewhere")
})

for (const jump of [-60000, 60000]) test(`wall-clock jump ${jump} cannot suppress polling or prematurely discard attribution`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t)
  f.jumpWall(1000000)
  let reads = 0
  f.query(() => { reads++; return Promise.resolve({ uncertain: false, conflict: false, deleted: false }) })
  f.h.lifecycle(accepted()); f.h.lifecycle(removed()); await settle()
  assert.equal(reads, 1)
  f.jumpWall(jump); f.commit(); await settle()
  assert.equal(reads, 1, "wall-clock advancement cannot trigger an early poll")
  f.advance(1999); t.mock.timers.tick(1999); await settle()
  assert.equal(reads, 1)
  f.advance(1); t.mock.timers.tick(1); f.commit(); await settle()
  assert.equal(reads, 2, "the two-second monotonic backoff survives rollback and forward jumps")
  f.advance(4499); t.mock.timers.tick(4499); await settle()
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "always" })
  assert.equal(f.history().record?.outcome, "manual", "the candidate remains attributable through 6,499 elapsed milliseconds")
  assert.equal(f.events.find(event => event.type === "permissionResolved")?.at, f.wall(), "stored event time follows the wall clock")
})

for (const jump of [-60000, 60000]) for (const event of ["reply", "confirmation", "shared-read"] as const)
  test(`${event} at monotonic expiry after wall-clock jump ${jump} omits the body before timer delivery`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture(t)
    f.jumpWall(1000000)
    let resolve!: (value: any) => void
    if (event === "shared-read") f.query(() => new Promise(yes => { resolve = yes }))
    f.h.lifecycle(accepted())
    const fact = { request, automatic: true, approval: "approval", review: "review" }
    if (event === "confirmation") f.h.approval({ ...fact, type: "dispatched" })
    f.h.lifecycle(removed()); await settle()
    f.jumpWall(jump); f.advance(6500) // Deliberately do not deliver the expiry timer.
    if (event === "reply") f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "always" })
    else if (event === "confirmation") {
      f.h.approval({ ...fact, type: "confirmed" }); f.h.approval({ ...fact, type: "settled" })
      assert.equal(f.totals().activity.autoApproved, 1, "received confirmation accounting still persists")
      assert.equal(f.events.find(value => value.type === "approvalConfirmed")?.at, f.wall())
    } else { resolve({ outcome: "manual", uncertain: false, conflict: false, deleted: false }); await settle() }
    assert.equal(f.history().total, 0)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM payloads").get()!.n, 0)
    assert.equal(f.events.filter(value => value.type === "permissionResolved").length, 0)
    assert.equal(f.totals().safe, 1, "expiry never discards accepted accounting")
  })

test("the attribution timer expires on monotonic time despite a wall-clock rollback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t)
  f.jumpWall(1000000)
  f.h.lifecycle(accepted()); f.h.lifecycle(removed()); await settle()
  f.jumpWall(-60000); f.advance(6500); t.mock.timers.tick(6500); await settle()
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "always" })
  assert.equal(f.history().total, 0)
})

test("expired attribution retains actual read cleanup ownership through a new candidate and disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t)
  let release!: () => void, complete!: (value: any) => void, calls = 0
  const settled = new Promise<void>(resolve => { release = resolve })
  f.query(() => { calls++; return Object.assign(new Promise<any>(resolve => { complete = resolve }), { settled }) })
  f.h.lifecycle(accepted()); f.h.lifecycle(removed())
  f.advance(6500)
  complete({ outcome: "manual", uncertain: false, conflict: false, deleted: false }); await settle()
  const other = { ...request, id: "another" }
  f.h.lifecycle(accepted(result("another"), other)); f.h.lifecycle(removed(other))
  f.advance(2000); f.commit(); await settle()
  assert.equal(calls, 1, "visible expiry does not release the physical read")
  f.h.dispose(); release(); await settle()
  assert.equal(calls, 1); assert.equal(f.history().total, 0)
})

test("removed attribution window is capped at 128 candidates without a resolved-body side queue", t => {
  const f = fixture(t)
  f.query(() => new Promise(() => {}))
  for (let i = 0; i < 130; i++) {
    const req = { ...request, id: `permission-${i}` }
    f.h.lifecycle(accepted(result(`review-${i}`), req)); f.h.lifecycle(removed(req))
  }
  f.h.reply({ requestID: "permission-129", sessionID: "child", reply: "always" })
  assert.equal(f.history().total, 0, "overflow candidate was dropped")
  f.h.reply({ requestID: "permission-0", sessionID: "child", reply: "always" })
  assert.equal(f.history().total, 1, "older waiting candidates were retained")
})

test("timed-out shared read retains ownership until actual settlement and cannot publish after disposal", async t => {
  const f = fixture(t)
  let release!: () => void, calls = 0
  const settled = new Promise<void>(resolve => { release = resolve })
  f.query(() => { calls++; return Object.assign(Promise.reject(new Error("caller timeout")), { settled }) })
  f.h.lifecycle(accepted()); f.h.lifecycle(removed()); await settle()
  f.advance(2500); f.commit(); await settle(); assert.equal(calls, 1)
  f.h.dispose(); release(); await settle()
  assert.equal(f.history().total, 0)
})

test("saturated resolved admission drops bodies, deletion invalidates candidates and preserves totals", t => {
  const f = fixture(t)
  f.h.lifecycle(accepted()); f.admission(false)
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "always" }); f.h.lifecycle(removed())
  f.admission(true); f.h.lifecycle(removed()); f.h.reply({ requestID: request.id, sessionID: "child", reply: "always" })
  assert.equal(f.history().total, 0)
  const other = { ...request, id: "other" }
  f.h.lifecycle(accepted(result("other"), other))
  f.h.deleted({ scope: "/host", root: "root", session: "root" }); f.h.lifecycle(removed(other))
  assert.equal(f.history().total, 0); assert.equal(f.totals().safe, 2)
  assert.equal(f.db.prepare("SELECT count(*) n FROM reviews").get()!.n, 0)
})

test("real controller preserves completed candidate through disabled mode and failed replacement", async t => {
  const f = fixture(t)
  let enabled = true, calls = 0
  const modes = { root: async () => "root", load: async () => {}, enabled: () => enabled }
  const controller = new Controller(async (_req, _signal, identified, _progress, execution) => {
    identified(); calls++
    if (calls > 1) throw new Error("replacement failed")
    return result(execution!.review)
  }, () => {}, { modes, candidate: () => true, nativeFront: () => request.id,
    onApproval: f.h.approval, onLifecycle: f.h.lifecycle })
  t.after(() => controller.dispose())
  controller.asked(request); await settle()
  const original = controller.views[0]!.assessment!.desc
  enabled = false; controller.modeChanged("root")
  enabled = true; controller.modeChanged("root"); controller.reconcile([request], controller.revision); await settle()
  assert.equal(controller.views[0]!.status, "unavailable")
  f.h.reply({ requestID: request.id, sessionID: "child", reply: "always" }); controller.replied(request.id)
  assert.equal(f.history().record?.payload.desc, original)
  assert.equal(f.totals().safe, 1)
})

test("shutdown admits real received finalizers before closing storage with the original abort timestamp", async t => {
  const f = fixture(t), observer = f.h.observation(request, "shell", config, { root: "root", review: "execution" })
  observer.observe!({ type: "dispatched", review: "execution", attempt: "post", retry: "initial" })
  f.h.dispose()
  const abortAt = performance.now()
  const finalizers = Promise.resolve().then(() => observer.observe!({ type: "finalized", review: "execution", attempt: "post", usage: { cost: 0.1 } }))
  await drainHistory({ dispose: async at => { assert.equal(at, abortAt); assert.equal(f.totals().cost, 0.1) } }, finalizers, abortAt)
  assert.equal(f.history().total, 0)
})

test("already spent cleanup budget never waits for a hung review finalizer", async () => {
  const abortAt = performance.now() - 4000
  let closed = false
  await drainHistory({ dispose: async at => { assert.equal(at, abortAt); closed = true } }, new Promise(() => {}), abortAt)
  assert.equal(closed, true)
})
