import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, type ApprovalFact, type ControllerOptions } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { OnceSubmission } from "../src/host-permissions.js"
import { NotificationPolicy } from "../src/notification-policy.js"
import { parseNotificationConfig } from "../src/notification-config.js"
import type { NotificationMessage } from "../src/notification-types.js"

const request: HostRequest = { id: "p", sessionID: "root", action: "shell", resources: [] }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(t: TestContext, fastMode = false, overrides: ControllerOptions = {}) {
  const messages: NotificationMessage[] = [], facts: ApprovalFact[] = [], target = { root: "root", sessionID: "root", title: "Fixture" }
  const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 0 }), true, {
    async show(message) { messages.push(message); return { close() {} } }, dispose() {},
  })
  const state = { pending: [request], enabled: true, reads: 0, writes: 0, time: 0,
    list: async (): Promise<HostRequest[]> => state.pending,
    ack: async (): Promise<OnceSubmission> => ({ status: "submitted" }) }
  const timers = new Set<{ at: number; run(): void }>()
  const controller: Controller = new Controller(async (_req, _signal, identify) => { identify(); return { safe: true, desc: "Harmless fixture command." } },
    views => policy.snapshot(views, state.pending[0] ? new Map([["root", { kind: "permission", id: state.pending[0].id }]]) : new Map()), {
      candidate: () => true, nativeFront: () => state.pending[0]?.id, approvalReady: () => true,
      reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode, autoApproveDelaySeconds: 3 },
      modes: { root: async () => "root", load: async () => {}, enabled: () => state.enabled },
      clock: { now: () => state.time, after(ms, run) {
        const timer = { at: state.time + ms, run }; timers.add(timer); return () => { timers.delete(timer) }
      } },
      nativeApproval: { list: async () => { state.reads++; return state.list() },
        once: async (req, _signal, dispatch) => {
          if (!dispatch()) return { status: "unavailable" }; state.writes++
          const ack = await state.ack()
          if (ack.status === "submitted") {
            state.pending = state.pending.filter(value => value.id !== req.id)
            controller.permissionReplied({ sessionID: req.sessionID, requestID: req.id, decision: "once" })
          }
          return ack
        } }, onApproval: fact => { facts.push(fact); if (fact.type === "confirmed" && fact.automatic) policy.approved(fact.request, target) },
      ...overrides,
    })
  t.after(async () => { await controller.dispose(); await policy.dispose() })
  const add = (req = request) => { controller.asked(req); policy.permission(req, target, true) }
  return { controller, policy, state, messages, facts, add,
    async advance(ms: number) {
      state.time += ms
      for (const timer of [...timers]) if (timer.at <= state.time && timers.delete(timer)) timer.run()
      await settle()
    }, wake: () => controller.refreshApprovalEligibility() }
}

test("native resolution before local acknowledgement retains exact automatic confirmation", async t => {
  const f = fixture(t), ack = deferred<OnceSubmission>()
  f.state.ack = () => ack.promise; f.add(); await settle(); const attempt = f.controller.approveNow("p", true); await settle()
  f.controller.permissionReplied({ sessionID: "root", requestID: "p", decision: "once" }); await attempt
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched"])
  ack.resolve({ status: "submitted" }); await settle()
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.automatic]), [["dispatched", true], ["confirmed", true], ["settled", true]])
  assert.equal(f.controller.views.length, 0); assert.deepEqual(f.messages.map(m => m.kind), ["approved"])
})
for (const descendants of [false, true]) test(`overlapping ${descendants ? "descendant" : "root"} Safe permissions never need attention`, async t => {
  const f = fixture(t)
  f.state.pending = ["a", "b"].map(id => ({ ...request, id, sessionID: descendants ? `child-${id}` : "root" }))
  for (const req of f.state.pending) f.add(req)
  await settle(); await f.advance(1500); assert.equal(f.controller.views.find(v => v.request.id === "b")?.autoApproval, undefined)
  await f.advance(2500); assert.equal(f.state.writes, 1)
  f.wake(); await f.advance(4000); assert.equal(f.state.writes, 2)
  assert.equal(f.controller.views.length, 0); assert.deepEqual(f.messages.map(m => m.kind), ["approved", "approved"])
  assert.ok(f.messages.every(m => m.kind === "approved"), "Safe queue waits cannot create manual attention")
})
test("disabling during a write preserves uncertainty until fresh pending reconciliation", async t => {
  const f = fixture(t), ack = deferred<OnceSubmission>(); f.state.ack = () => ack.promise
  f.add(); await settle(); const attempt = f.controller.approveNow("p", true); await settle(); assert.equal(f.state.writes, 1)
  f.state.enabled = false; f.controller.modeChanged("root"); await attempt; await settle()
  assert.equal(f.controller.views[0]?.status, "suspended"); assert.equal(f.messages.length, 0)
  f.controller.reconcile([request], f.controller.revision); await settle(); assert.deepEqual(f.messages.map(m => m.title), ["Session needs attention"])
  ack.resolve({ status: "uncertain" }); await settle(); assert.equal(f.state.writes, 1)
})
test("failed approval confirms pending only through reconciliation and isolates observer errors", async t => {
  const f = fixture(t, false, { onApproval: () => Promise.reject(Error("observer")) })
  f.state.ack = async () => { throw Error("uncertain") }; f.add(); await settle(); await f.controller.approveNow("p")
  assert.equal(f.state.reads, 2); assert.equal(f.state.writes, 1); assert.equal(f.controller.views[0]?.approvalPendingConfirmed, true)
  await f.controller.approveNow("p"); assert.equal(f.state.writes, 1)
})
for (const failure of [false, true]) test(`manual footer request is attributed manual only with native ACK and exact once (${failure})`, async t => {
  const f = fixture(t); if (failure) f.state.ack = async () => { throw Error("uncertain") }
  f.add(); await settle(); await f.controller.approveNow("p"); await settle()
  assert.deepEqual(f.facts.map(fact => fact.type), failure ? ["dispatched", "settled"] : ["dispatched", "confirmed", "settled"])
  assert.ok(f.facts.every(fact => !fact.automatic)); assert.equal(f.messages.some(m => m.kind === "approved"), false)
})
for (const fastMode of [false, true]) for (const event of ["unrelated root", "later same root"] as const) {
  test(`${fastMode ? "fast" : "normal"} ${event} during verification recovers without an attention episode`, async t => {
    const f = fixture(t, fastMode), held = deferred<HostRequest[]>(); let reads = 0
    f.state.list = () => ++reads === 1 ? held.promise : Promise.resolve([...f.state.pending])
    f.add(); await settle(); const attempt = f.controller.approveNow("p", true); await settle()
    const other = { ...request, id: "z", sessionID: event === "unrelated root" ? "other" : "root" }
    f.state.pending.push(other); f.controller.asked(other); held.resolve([request]); await attempt; await settle()
    assert.equal(reads, 2); assert.equal(f.state.writes, 1); assert.deepEqual(f.messages.map(m => m.kind), ["approved"])
    assert.ok(f.controller.views.some(v => v.request.id === "z"))
  })
}
for (const fastMode of [false, true]) test(`${fastMode ? "fast" : "normal"} sustained churn caps reads, stays silent, and fresh reconciliation can rearm`, async t => {
  const f = fixture(t, fastMode); let churn = true
  f.state.list = async () => { if (churn) f.controller.replied("unrelated"); return [request] }
  f.add(); await settle(); await f.controller.approveNow("p", true); await settle()
  assert.equal(f.state.reads, 3); assert.equal(f.state.writes, 0)
  for (let i = 0; i < 20; i++) { f.wake(); await f.controller.approveNow("p", true) }
  assert.equal(f.state.reads, 3); assert.equal(f.messages.length, 0)
  const stale = f.controller.revision; f.controller.replied("unknown"); f.controller.reconcile([request], stale)
  assert.equal(f.controller.views[0]?.autoApproval?.status, "checking")
  churn = false; f.controller.reconcile([request], f.controller.revision); f.wake(); await f.controller.approveNow("p", true); await settle()
  assert.equal(f.state.reads, 4); assert.equal(f.state.writes, 1); assert.deepEqual(f.messages.map(m => m.kind), ["approved"])
})
for (const fastMode of [false, true]) for (const failure of ["GET 503", "GET timeout"] as const) {
  test(`${fastMode ? "fast" : "normal"} ${failure} stays silent through actual settlement and bounded recovery`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture(t, fastMode), held = deferred<HostRequest[]>(), recovery = deferred<HostRequest[]>(); let reads = 0
    f.state.list = () => ++reads === 1 ? failure === "GET 503" ? Promise.reject(Error("503")) : held.promise
      : reads === 2 ? recovery.promise : Promise.resolve([request])
    f.add(); await settle(); const attempt = f.controller.approveNow("p", true); await settle()
    if (failure === "GET timeout") {
      t.mock.timers.tick(5000); await attempt
      for (let i = 0; i < 20; i++) { f.controller.reconcile([request], f.controller.revision); f.wake() }
      assert.equal(reads, 1); assert.equal(f.messages.length, 0); held.resolve([request]); await settle()
    }
    assert.equal(reads, 2); assert.equal(f.state.writes, 0); assert.equal(f.messages.length, 0)
    recovery.resolve([request]); await attempt; await settle(); f.wake(); await f.controller.approveNow("p", true); await settle()
    assert.equal(reads, 3); assert.equal(f.state.writes, 1); assert.deepEqual(f.messages.map(m => m.kind), ["approved"])
    assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"], ["dispatched", undefined], ["confirmed", undefined], ["settled", undefined]])
  })
}
