import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { Controller, visibleReview, type ApprovalFact, type View } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import { parseConfig } from "../src/config.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"
import { HistorySQL, type HistorySelection, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent, type HistoryEvent } from "../src/history-records.js"
import { NotificationPolicy } from "../src/notification-policy.js"
import type { NotificationMessage } from "../src/notification-types.js"
import type { ReviewProgress, ReviewResult } from "../src/types.js"

const request = (id = "a", sessionID = "root"): HostRequest => ({ id, sessionID, action: "shell", resources: [id],
  source: { assistantID: "assistant", id: `call-${id}` } })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function fixture(t: TestContext, options: Record<string, unknown> = {}, hooks: {
  changed?: (views: View[]) => void; approval?: (fact: ApprovalFact) => void
} = {}) {
  const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", stream: true, autoApprove: true,
    fastMode: true, autoApproveDelaySeconds: 999, notifySound: false, staleReminderSeconds: 0, ...options })
  const sql = new HistorySQL(new DatabaseSync(":memory:")), events: HistoryEvent[] = [], banners: NotificationMessage[] = [], facts: ApprovalFact[] = []
  let sequence = 0, enabled = true, ready = true, failedStorage = false
  const history = new HistoryCoordinator("/host", {
    admit: event => { if (failedStorage) return false; events.push(event); sql.apply("fixture", ++sequence, encodeEvent(event)); return true },
    query: query => Promise.resolve(sql.query(query)), onCommit: () => () => {},
  }, async () => "root")
  const target = { root: "root", sessionID: "root", title: "Fixture" }
  const policy = new NotificationPolicy(config, config.autoApprove, {
    async show(message) { banners.push(message); return { close() {} } }, dispose() {},
  })
  const workers = new Map<string, { signal: AbortSignal; progress(p: ReviewProgress): void; finish(safe?: boolean): void; fail(): void }>()
  let pending: HostRequest[] = []
  const writes: { request: HostRequest; signal: AbortSignal; ack: ReturnType<typeof deferred<void>> }[] = []
  let list: (signal: AbortSignal) => Promise<HostRequest[]> = async () => pending
  const controller: Controller = new Controller((req, signal, identify, progress, execution) => {
    const observation = history.observation(req, "shell", config, execution!), result = deferred<ReviewResult>()
    observation.observe!({ type: "dispatched", review: execution!.review, attempt: "one", retry: "initial" })
    signal.addEventListener("abort", () => result.reject(Error("aborted")), { once: true })
    identify(); progress({ attempt: 0, phase: "evaluating" })
    const finalized = () => observation.observe!({ type: "finalized", review: execution!.review, attempt: "one", usage: { input: 10, output: 5 } })
    workers.set(req.id, { signal, progress,
      finish(safe = true) { finalized(); result.resolve({ safe, desc: "Complete " + req.id, usage: { input: 10, output: 5 },
        metadata: { review: execution!.review, kind: "shell", provider: config.baseURL, configuredModel: config.model } }) },
      fail() { finalized(); result.reject(Error("invalid remainder")) },
    })
    return result.promise
  }, () => {
    policy.snapshot(controller.pendingViews, pending[0] ? new Map([["root", { kind: "permission", id: pending[0].id }]]) : new Map())
    hooks.changed?.(controller.views)
  }, { candidate: () => true, approvalReady: () => ready, nativeFront: () => pending[0]?.id,
    reviewOptions: config, nativeApproval: {
      list: signal => list(signal), once: async (req, signal, dispatch) => {
        if (!dispatch()) return { status: "unavailable" }
        const ack = deferred<void>(); writes.push({ request: req, signal, ack }); await ack.promise; return { status: "submitted" }
      },
    }, modes: { root: async () => "root", load: async () => {}, enabled: () => enabled }, onApproval: fact => {
      facts.push(fact); history.approval(fact)
      if (fact.type === "confirmed" && fact.automatic) policy.approved(fact.request, target)
      hooks.approval?.(fact)
    }, onLifecycle: history.lifecycle })
  const ask = async (req: HostRequest) => { pending.push(req); policy.permission(req, target, true); controller.asked(req); await settle() }
  const resolved = (id = "a", decision: "once" | "reject" = "once") => {
    const req = pending.find(value => value.id === id) ?? request(id)
    pending = pending.filter(value => value.id !== id)
    history.reply({ requestID: id, sessionID: req.sessionID, reply: decision })
    controller.permissionReplied({ requestID: id, sessionID: req.sessionID, decision })
  }
  t.after(async () => {
    for (const write of writes) write.ack.reject(Error("cleanup"))
    await controller.dispose(); history.dispose(); await policy.dispose(); sql.close()
  })
  await ask(request())
  return { controller, workers, writes, facts, events, banners, ask, resolved,
    rate: (safe = true, id = "a", attempt = 0) => workers.get(id)!.progress({ attempt, phase: "streaming", preview: { safe, desc: "Partial " + id } }),
    mode: (value: boolean) => { enabled = value; controller.modeChanged("root") },
    ready: (value: boolean) => { ready = value; controller.refreshApprovalEligibility() },
    list: (fn: typeof list) => { list = fn }, failStorage: () => { failedStorage = true },
    saved: () => sql.query({ type: "history", scope: "/host", root: "root" }) as HistorySelection,
    totals: () => (sql.query({ type: "totals" }) as HistoryTotals).totals }
}

test("fast Safe dispatches without countdown, retains across resolution, and saves only final acceptance", async t => {
  const f = await fixture(t); f.rate(); await settle(); assert.equal(f.writes.length, 1)
  assert.equal(f.controller.views[0]?.assessment, undefined); assert.equal(f.saved().total, 0); assert.equal(f.totals().safe, 0)
  f.resolved(); assert.equal(f.workers.get("a")!.signal.aborted, false); assert.equal(f.controller.pendingViews.length, 0)
  assert.equal(f.banners.length, 0); f.writes[0]!.ack.resolve(); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "approved"); assert.equal(f.totals().activity.autoApproved, 1)
  assert.equal(f.saved().total, 0); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.controller.views.length, 0); assert.equal(f.saved().total, 1); assert.equal(f.totals().safe, 1)
  assert.deepEqual(f.banners.map(m => [m.kind, m.history]), [["approved", { session: "root", permission: "a" }]])
})
test("retained report stays displayed but never gates next native approval or notification order", async t => {
  const f = await fixture(t); f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  await f.ask(request("b")); f.rate(true, "b"); await settle(); assert.equal(f.writes.length, 2)
  assert.equal(visibleReview(f.controller.views, "root", id => ({ id }), () => "b")?.request.id, "a")
  assert.deepEqual(f.controller.pendingViews.map(v => v.request.id), ["b"])
  f.resolved("b"); f.writes[1]!.ack.resolve(); f.workers.get("b")!.finish(); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.saved().total, 2)
})
test("confirmed fast approval survives policy waits and disable, retries and saves final Unsafe", async t => {
  const f = await fixture(t); f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.ready(false); f.mode(false); const worker = f.workers.get("a")!; assert.equal(worker.signal.aborted, false)
  worker.progress({ attempt: 1, phase: "retrying" }); worker.progress({ attempt: 1, phase: "streaming", preview: { safe: false } })
  worker.finish(false); await settle(); assert.equal(f.controller.views.length, 0); assert.equal(f.saved().total, 1)
  assert.equal(f.totals().unsafe, 1); assert.equal(f.totals().activity.autoApproved, 1)
})
test("failed remainder counts received usage and confirmed approval, but saves no report", async t => {
  const f = await fixture(t); f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.workers.get("a")!.fail(); await settle(); assert.equal(f.controller.views.length, 0); assert.equal(f.saved().total, 0)
  assert.equal(f.totals().activity.autoApproved, 1); assert.equal(f.totals().safe, 0)
})
test("history save failure cannot retain completed report or alter approval", async t => {
  const f = await fixture(t); f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.failStorage(); f.workers.get("a")!.finish(); await settle(); assert.equal(f.controller.views.length, 0)
  assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 1)
})
test("stream:false ignores previews, waits for validation, then skips delay", async t => {
  const f = await fixture(t, { stream: false }); f.rate(); await settle(); assert.equal(f.writes.length, 0)
  f.workers.get("a")!.finish(); await settle(); assert.equal(f.writes.length, 1)
  f.resolved(); f.writes[0]!.ack.resolve(); await settle(); assert.equal(f.saved().total, 1)
})
for (const option of [{ fastMode: false }, { autoApprove: false }]) test(`fast preview automation remains opt-in: ${JSON.stringify(option)}`, async t => {
  const f = await fixture(t, option); f.rate(); await settle(); assert.equal(f.writes.length, 0); assert.equal(f.controller.views[0]?.autoApproval, undefined)
})
test("Safe previews on ineligible routes wait and Unsafe previews never approve", async t => {
  const f = await fixture(t); f.ready(false); f.rate(); await settle(); assert.equal(f.writes.length, 0)
  f.rate(false); f.ready(true); await settle(); assert.equal(f.writes.length, 0)
  f.rate(); await settle(); assert.equal(f.writes.length, 1)
})
for (const invalidation of ["retry", "clear", "unsafe"] as const) for (const ordering of ["before", "after"] as const) {
  test(`fast ${invalidation}: replacement Safe ${ordering} old GET settlement uses a fresh reservation`, async t => {
    const f = await fixture(t), old = deferred<HostRequest[]>(); let reads = 0
    f.list(() => ++reads === 1 ? old.promise : Promise.resolve([request()])); f.rate(); await settle(); assert.equal(reads, 1)
    const worker = f.workers.get("a")!
    if (invalidation === "retry") worker.progress({ attempt: 1, phase: "retrying" })
    else if (invalidation === "clear") worker.progress({ attempt: 0, phase: "streaming" })
    else f.rate(false)
    if (ordering === "after") { old.resolve([request()]); await settle(); assert.equal(f.writes.length, 0) }
    f.rate(true, "a", invalidation === "retry" ? 1 : 0); await settle()
    if (ordering === "before") { assert.equal(f.writes.length, 0); old.resolve([request()]); await settle() }
    assert.equal(reads, 2); assert.equal(f.writes.length, 1); assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0)
    f.resolved(); f.writes[0]!.ack.resolve(); f.workers.get("a")!.finish(); await settle(); assert.equal(f.saved().total, 1)
  })
}
for (const effect of ["cancel", "disable", "changed evidence"] as const) for (const settled of [false, true]) {
  test(`rating pause retains ${effect} tombstone ${settled ? "after" : "before"} physical read settlement`, async t => {
    const f = await fixture(t), held = deferred<HostRequest[]>(); f.list(() => held.promise); f.rate(); await settle()
    f.workers.get("a")!.progress({ attempt: 0, phase: "streaming" })
    if (settled) { held.resolve([request()]); await settle() }
    if (effect === "cancel") f.controller.cancelAutoApproval("a")
    if (effect === "disable") f.mode(false)
    if (effect === "changed evidence") f.controller.reconcile([{ ...request(), resources: ["changed"] }], f.controller.revision)
    held.resolve([request()]); await settle(); if (effect === "disable") f.mode(true)
    f.controller.reconcile([request()], f.controller.revision); await settle(); f.rate(); f.ready(true); await settle()
    assert.equal(f.writes.length, 0); assert.equal(f.controller.views[0]?.autoApproval?.status, effect === "changed evidence" ? "failed" : "cancelled")
  })
}
for (const terminal of ["unsafe", "failure"] as const) test(`terminal ${terminal} after verification timeout needs attention without releasing physical read`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = await fixture(t), held = deferred<HostRequest[]>(); let reads = 0
  f.list(() => { reads++; return held.promise }); f.rate(); await settle(); t.mock.timers.tick(5000); await settle()
  if (terminal === "unsafe") f.workers.get("a")!.finish(false); else f.workers.get("a")!.fail()
  await settle(); assert.equal(f.controller.views[0]?.autoApproval, undefined); assert.equal(reads, 1)
  assert.equal(f.banners.length, 1); held.resolve([request()]); await settle(); f.ready(true)
  assert.equal(reads, 1); assert.equal(f.writes.length, 0)
})
test("report completion before native ACK waits for confirmation and persists once", async t => {
  const f = await fixture(t); f.rate(); await settle(); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.saved().total, 0); assert.equal(f.controller.views[0]?.status, "complete")
  f.resolved(); assert.equal(f.saved().total, 0); f.writes[0]!.ack.resolve(); await settle()
  assert.equal(f.saved().total, 1); assert.equal(f.controller.views.length, 0)
})
test("native resolution before dispatch cannot attribute or save automatic approval", async t => {
  const f = await fixture(t), held = deferred<HostRequest[]>(); f.list(() => held.promise); f.rate(); await settle()
  f.resolved(); held.resolve([request()]); await settle(); assert.equal(f.writes.length, 0)
  assert.equal(f.saved().total, 0); assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0)
})
test("deletion aborts retained review and cannot recreate history from late completion", async t => {
  const f = await fixture(t); f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.controller.deleted("root"); assert.equal(f.workers.get("a")!.signal.aborted, true)
  f.workers.get("a")!.finish(); await settle(); assert.equal(f.saved().total, 0); assert.equal(f.controller.views.length, 0)
})
for (const submitted of [false, true]) test(`disable after fast dispatch retains only confirmed ACK (${submitted})`, async t => {
  const f = await fixture(t); f.rate(); await settle(); f.mode(false); assert.equal(f.workers.get("a")!.signal.aborted, false)
  if (submitted) { f.resolved(); f.writes[0]!.ack.resolve() } else f.writes[0]!.ack.reject(Error("uncertain"))
  await settle(); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, submitted ? 1 : 0)
  assert.equal(f.saved().total, submitted ? 1 : 0); assert.equal(f.writes.length, 1)
})
test("fast ACK timeout remains single-shot through late success, resolution and mode re-enable", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = await fixture(t); f.rate(); await settle(); t.mock.timers.tick(5000); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "failed")
  f.writes[0]!.ack.resolve(); await settle(); f.mode(false); f.mode(true); f.controller.reconcile([request()], f.controller.revision); await settle()
  f.rate(); f.ready(true); await settle(); assert.equal(f.writes.length, 1)
  f.resolved(); await settle(); assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0); assert.equal(f.saved().total, 0)
})
test("disappearance before rejected fast ACK preserves manual reappearance without history or approval notification", async t => {
  const f = await fixture(t); f.rate(); await settle()
  const original = f.workers.get("a")!
  f.list(async () => []); f.controller.reconcile([], f.controller.revision)
  assert.equal(original.signal.aborted, false)
  f.writes[0]!.ack.reject(Error("native acknowledgement rejected")); await settle()
  assert.equal(f.controller.views.length, 0)
  assert.equal(original.signal.aborted, true)
  original.finish(); await settle()
  assert.equal(f.saved().total, 0); assert.equal(f.totals().safe, 0)
  f.list(async () => [request()]); f.controller.reconcile([request()], f.controller.revision); await settle()
  f.rate(); f.ready(true); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "failed")
  assert.equal(f.writes.length, 1)
  f.workers.get("a")!.finish(); await settle()
  assert.equal(f.saved().total, 0)
  assert.equal(f.totals().activity.autoApproved, 0)
  assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0)
  assert.equal(f.banners.some(message => message.kind === "approved"), false)
})
test("dispatch observer runs after invocation; navigation and disable cannot cancel the retained confirmed remainder", async t => {
  let f!: Awaited<ReturnType<typeof fixture>>
  f = await fixture(t, {}, { approval: fact => {
    if (fact.type === "dispatched") { assert.equal(f.writes.length, 1); f.mode(false); f.ready(false) }
  } })
  f.rate(); await settle(); assert.equal(f.workers.get("a")!.signal.aborted, false)
  f.resolved(); f.writes[0]!.ack.resolve(); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.saved().total, 1); assert.equal(f.controller.views.length, 0)
})
