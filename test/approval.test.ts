import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { remainingTime } from "../src/deadline.js"
import { parseConfig } from "../src/config.js"
import { Controller, type ApprovalClock, type ApprovalFact, type ControllerOptions, type View } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { OnceSubmission } from "../src/host-permissions.js"

const safe = { safe: true, desc: "Reads the requested fixture." }
const request = (id = "review", sessionID = "root"): HostRequest => ({ id, sessionID, action: "shell", resources: ["pwd"],
  save: ["pwd *"], metadata: { command: "pwd", scope: { files: ["fixture"] } }, source: { assistantID: "assistant", id: "shared-call" } })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class Clock implements ApprovalClock {
  value = 0
  jobs = new Set<{ due: number; run(): void }>()
  now() { return this.value }
  after(ms: number, run: () => void) {
    assert.ok(Number.isFinite(ms) && ms >= 0)
    const job = { due: this.value + ms, run }; this.jobs.add(job); return () => { this.jobs.delete(job) }
  }
  dequeue(ms: number) {
    this.value += ms
    const due = [...this.jobs].filter(job => job.due <= this.value).sort((a, b) => a.due - b.due)
    for (const job of due) this.jobs.delete(job)
    return due.map(job => job.run)
  }
  jump(ms: number) { for (const run of this.dequeue(ms)) run() }
}
function fixture(t: TestContext, overrides: ControllerOptions = {}, changed?: (views: View[], controller: Controller) => void) {
  const clock = new Clock(), reads: AbortSignal[] = [], writes: AbortSignal[] = [], facts: ApprovalFact[] = []
  const state = { pending: [request()], ready: true, enabled: true,
    read: async (_signal: AbortSignal): Promise<HostRequest[]> => structuredClone(state.pending),
    write: async (_signal: AbortSignal): Promise<OnceSubmission> => ({ status: "submitted" }) }
  const controller: Controller = new Controller(async (_req, _signal, identify) => { identify(); return safe }, views => changed?.(views, controller), {
    candidate: () => true, nativeFront: () => state.pending[0]?.id, approvalReady: () => state.ready, clock,
    modes: { root: async () => "root", load: async () => {}, enabled: () => state.enabled },
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 2 },
    nativeApproval: { list: signal => { reads.push(signal); return state.read(signal) },
      once: async (req, signal, dispatch) => {
        if (!dispatch()) return { status: "unavailable" }; writes.push(signal)
        const result = await state.write(signal)
        if (result.status === "submitted") {
          state.pending = state.pending.filter(value => value.id !== req.id)
          controller.permissionReplied({ sessionID: req.sessionID, requestID: req.id, decision: "once" })
        }
        return result
      } }, onApproval: fact => { facts.push(fact) }, ...overrides,
  })
  t.after(() => controller.dispose())
  return { controller, clock, state, reads, writes, facts,
    async add(req = request()) { controller.asked(req); await settle() }, view: () => controller.views[0],
    wake: () => controller.refreshApprovalEligibility() }
}

test("approval configuration defaults to disabled and a bounded integer 15-second delay", () => {
  const config = { baseURL: "http://fixture.invalid/v1", model: "fixture" }
  assert.equal(parseConfig(config).autoApprove, false); assert.equal(parseConfig(config).autoApproveDelaySeconds, 15)
  for (const delay of [0, 1, 15, 3600]) assert.equal(parseConfig({ ...config, autoApproveDelaySeconds: delay }).autoApproveDelaySeconds, delay)
  for (const delay of [-1, 3601, 0.5, NaN, Infinity, "15", null]) assert.throws(() => parseConfig({ ...config, autoApproveDelaySeconds: delay }), /autoApproveDelaySeconds/)
  for (const autoApprove of ["true", 1, null]) assert.throws(() => parseConfig({ ...config, autoApprove }), /autoApprove/)
})
for (const missing of ["writer", "queue", "policy"] as const) test(`missing ${missing} waits closed without automation`, async t => {
  const f = fixture(t, { ...(missing === "writer" ? { nativeApproval: undefined } : missing === "queue" ? { nativeFront: undefined } : { approvalReady: undefined }) })
  await f.add(); f.wake(); f.clock.jump(60_000); await f.controller.approveNow("review")
  assert.equal(f.view()?.autoApproval, undefined); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
})
for (const autoApprove of [false, undefined]) test(`autoApprove ${autoApprove} never arms`, async t => {
  const f = fixture(t, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove } }); await f.add(); f.wake(); f.clock.jump(60_000)
  assert.equal(f.view()?.autoApproval, undefined); assert.equal(f.writes.length, 0)
})
for (const delay of [0, 1, 5, 3600]) test(`${delay}-second countdown uses the original monotonic deadline and exactly 200ms grace`, async t => {
  const f = fixture(t, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: delay } })
  await f.add(); assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: delay })
  if (delay > 0) { f.clock.jump(delay * 1000 + 199); assert.equal(f.writes.length, 0); f.wake(); f.clock.jump(1) }
  else { assert.equal(f.reads.length, 0); f.clock.jump(0) }
  await settle(); assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.clock.jobs.size, 0)
})
for (const removal of ["cancel", "reply", "delete", "dispose"] as const) test(`${removal} defeats already-dequeued countdown callbacks`, async t => {
  const f = fixture(t); await f.add(); const queued = f.clock.dequeue(2200); assert.equal(queued.length, 1)
  if (removal === "cancel") f.controller.cancelAutoApproval("review")
  if (removal === "reply") f.controller.permissionReplied({ sessionID: "root", requestID: "review", decision: "reject" })
  if (removal === "delete") f.controller.deleted("root")
  if (removal === "dispose") void f.controller.dispose()
  queued[0]!(); await settle(); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
})
for (const effect of ["cancel", "dispose"] as const) test(`synchronous ${effect} during countdown publication leaves no timer`, async t => {
  const f = fixture(t, {}, (views, controller) => {
    if (views.some(v => v.autoApproval?.status === "countdown")) {
      if (effect === "cancel") controller.cancelAutoApproval("review"); else void controller.dispose()
    }
  })
  await f.add(); assert.equal(f.clock.jobs.size, 0); assert.equal(f.reads.length, 0)
})
test("explicit cancellation is durable across duplicate asks, reconciliation and eligibility wakes", async t => {
  const f = fixture(t); await f.add(); f.controller.cancelAutoApproval("review")
  for (let i = 0; i < 3; i++) {
    f.controller.asked(structuredClone(request())); f.controller.reconcile([request()], f.controller.revision); f.wake()
    await f.controller.approveNow("review"); f.clock.jump(60_000)
  }
  assert.equal(f.view()?.autoApproval?.status, "cancelled"); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
})
test("zero delay verifies structural identity and shares the verification/ACK budget", async t => {
  const f = fixture(t, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 0 } })
  const read = deferred<HostRequest[]>(), ack = deferred<OnceSubmission>(); f.state.read = () => read.promise; f.state.write = () => ack.promise
  await f.add(); f.clock.jump(0); await settle(); assert.equal(f.view()?.autoApproval?.status, "checking")
  const { metadata, ...rest } = structuredClone(request()); read.resolve([{ metadata, ...rest }]); await settle()
  assert.equal(f.writes.length, 1); assert.equal(f.view()?.autoApproval?.status, "allowing")
  assert.ok(remainingTime(f.writes[0]!) <= remainingTime(f.reads[0]!) + 1)
  ack.resolve({ status: "submitted" }); await settle(); assert.equal(f.controller.views.length, 0)
})
test("duplicate clicks racing expiry remain single-flight during checking and actual invocation", async t => {
  const f = fixture(t), read = deferred<HostRequest[]>(), ack = deferred<OnceSubmission>()
  f.state.read = () => read.promise; f.state.write = () => ack.promise
  await f.add(); const queued = f.clock.dequeue(2200); const attempt = f.controller.approveNow("review", true); queued[0]!()
  await Promise.all([f.controller.approveNow("review"), f.controller.approveNow("review")]); assert.equal(f.reads.length, 1)
  read.resolve([request()]); await settle(); f.controller.cancelAutoApproval("review"); queued[0]!(); await f.controller.approveNow("review")
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]?.aborted, false)
  ack.resolve({ status: "submitted" }); await attempt; assert.equal(f.facts.filter(f => f.type === "confirmed").length, 1)
})
test("fresh-list disappearance removes review without invoking once", async t => {
  const f = fixture(t); f.state.read = async () => []; await f.add(); await f.controller.approveNow("review")
  assert.equal(f.controller.views.length, 0); assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0)
})
const changed: [string, HostRequest][] = [
  ["resources", { ...request(), resources: ["unreviewed"] }], ["metadata", { ...request(), metadata: { scope: { files: ["secret"] } } }],
  ["save patterns", { ...request(), save: ["*"] }], ["action", { ...request(), action: "edit" }],
  ["session", { ...request(), sessionID: "child" }], ["source", { ...request(), source: { assistantID: "new", id: "new" } }],
]
for (const [name, altered] of changed) test(`same-ID changed ${name} invalidates approval without retry`, async t => {
  const f = fixture(t); f.state.read = async () => [altered]; await f.add(); await f.controller.approveNow("review")
  assert.equal(f.view()?.autoApproval?.status, "failed"); assert.equal(f.view()?.assessment, safe); assert.deepEqual(f.view()?.request, request())
  f.controller.reconcile([request()], f.controller.revision); f.wake(); f.clock.jump(60_000); await f.controller.approveNow("review")
  assert.equal(f.writes.length, 0)
})
for (const event of ["new request", "unknown reply", "unknown deletion"] as const) test(`${event} invalidates stale verification and retries within three reads`, async t => {
  const f = fixture(t), first = deferred<HostRequest[]>(), second = deferred<HostRequest[]>(), third = deferred<HostRequest[]>()
  let reads = 0; f.state.read = () => [first, second, third][reads++]!.promise
  await f.add(); const attempt = f.controller.approveNow("review", true); await settle()
  if (event === "new request") f.controller.asked(request("later"))
  if (event === "unknown reply") f.controller.replied("unknown")
  if (event === "unknown deletion") f.controller.deleted("unknown")
  first.resolve([request()]); await settle(); assert.equal(reads, 2); assert.equal(f.writes.length, 0)
  f.controller.asked(request("recovery-event")); second.resolve([request()]); await settle(); assert.equal(reads, 3)
  third.resolve(f.controller.views.map(v => v.request)); await attempt
  assert.equal(f.writes.length, 1); assert.ok(f.controller.views.some(v => v.request.id === "recovery-event"))
})
for (const removal of ["cancel", "reply", "delete", "dispose"] as const) for (const outcome of ["resolve", "reject"] as const) {
  test(`${removal} aborts noncooperative verification and ignores late ${outcome}`, async t => {
    const f = fixture(t), held = deferred<HostRequest[]>(); f.state.read = () => held.promise
    await f.add(); const attempt = f.controller.approveNow("review"); await settle()
    if (removal === "cancel") f.controller.cancelAutoApproval("review")
    if (removal === "reply") f.controller.replied("review")
    if (removal === "delete") f.controller.deleted("root")
    if (removal === "dispose") void f.controller.dispose()
    assert.equal(f.reads[0]?.aborted, true); await attempt
    if (outcome === "resolve") held.resolve([request()]); else held.reject(Error("late private read"))
    await settle(); f.wake(); f.clock.jump(60_000); assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0)
  })
}
test("verification timeout retains physical ownership, recovers only after settlement, and preserves expired countdown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t), held = deferred<HostRequest[]>(), recovery = deferred<HostRequest[]>(); let reads = 0, actual = 0, maximum = 0
  f.state.read = async () => {
    maximum = Math.max(maximum, ++actual)
    try { return await (++reads === 1 ? held.promise : reads === 2 ? recovery.promise : Promise.resolve([request()])) }
    finally { actual-- }
  }
  await f.add(); f.clock.jump(2200); await settle(); t.mock.timers.tick(5000); await settle()
  assert.equal(f.reads[0]?.aborted, true)
  for (let i = 0; i < 20; i++) { f.controller.reconcile([request()], f.controller.revision); f.wake() }
  assert.equal(reads, 1); held.resolve([request()]); await settle(); assert.equal(reads, 2)
  recovery.resolve([request()]); await settle(); f.wake(); f.clock.jump(0); await settle()
  assert.equal(reads, 3); assert.equal(maximum, 1); assert.equal(f.writes.length, 1)
})
test("stale-read retry shares the original five-second budget and never overlaps unsettled I/O", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t), first = deferred<HostRequest[]>(), second = deferred<HostRequest[]>(); let reads = 0
  f.state.read = () => ++reads === 1 ? first.promise : reads === 2 ? second.promise : Promise.resolve([request()])
  await f.add(); const attempt = f.controller.approveNow("review"); await settle(); t.mock.timers.tick(4000)
  f.controller.replied("unrelated"); first.resolve([request()]); await settle()
  assert.equal(reads, 2); assert.equal(f.reads[0], f.reads[1]); t.mock.timers.tick(1000); await attempt
  assert.equal(reads, 2); assert.equal(f.reads[1]?.aborted, true); assert.equal(f.writes.length, 0)
  second.resolve([request()]); await settle(); assert.equal(reads, 3)
})
test("fresh read and native ACK share one deadline; late acknowledgement never retries or confirms", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t), read = deferred<HostRequest[]>(), ack = deferred<OnceSubmission>(); let reads = 0
  f.state.read = () => ++reads === 1 ? read.promise : Promise.resolve([request()]); f.state.write = () => ack.promise
  await f.add(); const attempt = f.controller.approveNow("review"); await settle(); t.mock.timers.tick(4000)
  read.resolve([request()]); await settle(); assert.equal(f.writes.length, 1)
  t.mock.timers.tick(1000); await attempt; assert.equal(f.writes[0]?.aborted, true); assert.equal(f.view()?.autoApproval?.status, "failed")
  ack.resolve({ status: "submitted" }); await settle(); f.wake(); await f.controller.approveNow("review"); assert.equal(f.writes.length, 1)
  assert.equal(f.facts.filter(f => f.type === "confirmed").length, 0)
})
for (const failure of ["throw", "reject"] as const) test(`${failure} after actual invocation is uncertain and permanently manual`, async t => {
  const f = fixture(t); f.state.write = () => { if (failure === "throw") throw Error("private"); return Promise.reject(Error("private")) }
  await f.add(); await f.controller.approveNow("review"); f.controller.reconcile([request()], f.controller.revision); f.wake(); await f.controller.approveNow("review")
  assert.equal(f.writes.length, 1); assert.equal(f.view()?.autoApproval?.status, "failed")
  assert.deepEqual(f.facts.map(f => [f.type, f.result]), [["dispatched", undefined], ["settled", "uncertain"]])
})

for (const outcome of ["resolve", "reject"] as const) test(`cancelled old verification owns the read slot across a newer approval until late ${outcome}`, async t => {
  const f = fixture(t), oldRead = deferred<HostRequest[]>(); let reads = 0, actual = 0, maximum = 0
  f.state.read = async () => {
    maximum = Math.max(maximum, ++actual)
    try { return ++reads === 1 ? await oldRead.promise : [request("new")] } finally { actual-- }
  }
  await f.add(); const old = f.controller.approveNow("review", true); await settle(); f.controller.replied("review"); await old
  f.state.pending = [request("new")]; await f.add(request("new")); const next = f.controller.approveNow("new", true); await settle()
  assert.equal(reads, 1); assert.equal(actual, 1)
  if (outcome === "resolve") oldRead.resolve([request()]); else oldRead.reject(Error("late old read"))
  await next; await settle(); assert.equal(reads, 2); assert.equal(maximum, 1); assert.equal(actual, 0); assert.equal(f.writes.length, 1)
})
test("old resolved read-slot timeout recovers a newer request only after the old I/O settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t), oldRead = deferred<HostRequest[]>(); let reads = 0, actual = 0, maximum = 0
  f.state.read = async () => {
    maximum = Math.max(maximum, ++actual)
    try { return ++reads === 1 ? await oldRead.promise : [request("new")] } finally { actual-- }
  }
  await f.add(); const old = f.controller.approveNow("review", true); await settle(); f.controller.replied("review"); await old
  f.state.pending = [request("new")]; await f.add(request("new")); const next = f.controller.approveNow("new", true)
  await settle(); t.mock.timers.tick(5000); await next
  assert.equal(reads, 1); assert.equal(f.writes.length, 0)
  for (let i = 0; i < 20; i++) { f.controller.reconcile([request("new")], f.controller.revision); f.wake() }
  assert.equal(reads, 1); oldRead.resolve([request()]); await settle(); assert.equal(reads, 2); assert.equal(maximum, 1)
  f.wake(); await f.controller.approveNow("new", true); await settle(); assert.equal(reads, 3); assert.equal(f.writes.length, 1)
})
