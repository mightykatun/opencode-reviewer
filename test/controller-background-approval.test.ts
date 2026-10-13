import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, type ApprovalClock, type ApprovalFact, type ReviewLifecycleFact } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { ReviewProgress, ReviewResult } from "../src/types.js"

const request: HostRequest = { id: "request", sessionID: "root", action: "shell", resources: ["pwd"],
  source: { assistantID: "assistant", id: "call" } }
const safe: ReviewResult = { safe: true, desc: "Reads the current directory." }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
class Clock implements ApprovalClock {
  private value = 0
  private timers = new Set<{ at: number; run(): void }>()
  now() { return this.value }
  after(ms: number, run: () => void) {
    const timer = { at: this.value + ms, run }; this.timers.add(timer)
    return () => { this.timers.delete(timer) }
  }
  jump(ms: number) {
    const end = this.value + ms
    for (;;) {
      const next = [...this.timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.value = next.at; this.timers.delete(next); next.run()
    }
    this.value = end
  }
}
async function fixture(fast = false, heldPreparation = false, heldVerification = false, delay = 2) {
  const clock = new Clock(), assessment = deferred<ReviewResult>(), preparation = deferred<void>()
  const verification = deferred<HostRequest[]>()
  if (!heldPreparation) preparation.resolve()
  if (!heldVerification) verification.resolve([request])
  let publishProgress!: (value: ReviewProgress) => void
  const state = { ready: true, front: request.id as string | undefined, frontError: false, enabled: true, writes: 0, preparations: 0, listErrors: 0,
    pending: [request], uncertain: false }
  const facts: ApprovalFact<HostRequest>[] = [], lifecycle: ReviewLifecycleFact<HostRequest>[] = []
  const controller = new Controller<HostRequest>(async (_request, _signal, identified, progress) => {
    publishProgress = progress
    identified()
    if (fast) {
      progress({ attempt: 0, phase: "evaluating" })
      progress({ attempt: 0, phase: "streaming", preview: safe })
    }
    return assessment.promise
  }, () => {}, { clock, candidate: () => true, nativeFront: () => { if (state.frontError) throw Error("Cache unavailable"); return state.front },
    approvalReady: () => state.ready,
    modes: { root: async () => "root", load: async () => {}, enabled: () => state.enabled },
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode: fast, stream: true, autoApproveDelaySeconds: delay },
    nativeApproval: {
      visibleID: () => undefined, presentation: () => ({ state: "lost" }),
      list: async () => { if (state.listErrors-- > 0) throw Error("Temporary read failure"); await verification.promise; return state.pending },
      once: async (_request, signal, dispatch) => {
        state.preparations++
        await preparation.promise
        if (signal.aborted || !dispatch()) return { status: "unavailable" }
        state.writes++
        if (state.uncertain) return { status: "uncertain" }
        queueMicrotask(() => {
          state.pending = []
          controller.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
        })
        return { status: "submitted" }
      },
    }, onApproval: fact => { facts.push(fact) }, onLifecycle: fact => { lifecycle.push(fact) },
  })
  controller.asked(request); await settle()
  return { controller, state, clock, assessment, preparation, verification, facts, lifecycle,
    progress: (value: ReviewProgress) => publishProgress(value),
    view: () => controller.views[0], wake: () => controller.refreshApprovalEligibility(),
    async complete() { assessment.resolve(safe); await settle() },
    async dispose() { preparation.resolve(); verification.resolve([request]); assessment.resolve(safe); await controller.dispose() } }
}

test("normal: Safe completion starts without any panel, mouse, Markdown or painted frame", async t => {
  const f = await fixture(); t.after(() => f.dispose())
  await f.complete()
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 2 })
  f.controller.presented({ state: "lost" }); f.clock.jump(2199); await settle()
  assert.equal(f.state.writes, 0)
  f.clock.jump(1); await settle()
  assert.equal(f.state.writes, 1)
  assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 1)
  assert.equal(f.lifecycle.filter(fact => fact.type === "accepted").length, 1)
  assert.equal(f.lifecycle.filter(fact => fact.type === "cancelled").length, 0)
})

test("normal: zero delay still uses cancellable, once-only verification without UI presentation", async t => {
  const f = await fixture(false, false, false, 0); t.after(() => f.dispose()); await f.complete()
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 0 })
  f.clock.jump(0); await settle()
  assert.equal(f.state.writes, 1)
  f.wake(); f.clock.jump(0); await settle(); assert.equal(f.state.writes, 1)
})

test("advisory: supplying an eligibility policy without a writer never arms approval", async t => {
  const controller = new Controller<HostRequest>(async () => safe, () => {}, { candidate: () => true, approvalReady: () => true,
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true } })
  t.after(() => controller.dispose())
  controller.asked(request); await settle(); controller.refreshApprovalEligibility()
  assert.equal(controller.views[0]?.autoApproval, undefined)
})

test("normal: throwing native cache reads wait and recover rather than cancelling a Safe countdown", async t => {
  const f = await fixture(); t.after(() => f.dispose()); await f.complete()
  f.state.frontError = true; f.wake(); f.clock.jump(10_000); await settle()
  assert.equal(f.state.writes, 0)
  assert.equal(f.view()?.autoApproval?.status, "waiting")
  f.state.frontError = false; f.wake(); f.clock.jump(0); await settle()
  assert.equal(f.state.writes, 1)
})

for (const blocker of ["route", "native decision", "native priority", "unreadable queue"] as const) {
  test(`normal: ${blocker} waits past the original deadline, resumes once without a new delay`, async t => {
    const f = await fixture(); t.after(() => f.dispose()); await f.complete()
    f.clock.jump(1000)
    if (blocker === "native priority") f.state.front = "disabled"
    else if (blocker === "unreadable queue") f.state.front = undefined
    else f.state.ready = false
    f.controller.presented({ state: "lost" })
    f.clock.jump(10_000); await settle()
    assert.equal(f.state.writes, 0)
    assert.equal(f.view()?.autoApproval?.status, "waiting")
    assert.equal(f.lifecycle.filter(fact => fact.type === "cancelled").length, 0)
    f.state.front = request.id; f.state.ready = true
    f.wake(); f.clock.jump(0); await settle()
    assert.equal(f.state.writes, 1)
    f.wake(); f.clock.jump(10_000); await settle()
    assert.equal(f.state.writes, 1)
  })
}

test("normal: a never-armed review on another route starts its delay only when the conversation is visited", async t => {
  const f = await fixture(); t.after(() => f.dispose())
  f.state.ready = false; await f.complete(); f.clock.jump(10_000); f.wake()
  assert.equal(f.view()?.autoApproval, undefined)
  f.state.ready = true; f.wake(); f.clock.jump(2199); await settle()
  assert.equal(f.state.writes, 0)
  f.clock.jump(1); await settle(); assert.equal(f.state.writes, 1)
})

for (const fast of [false, true]) {
  test(`${fast ? "fast" : "normal"}: a route/form change during awaited preparation blocks the synchronous write and recovers`, async t => {
    const f = await fixture(fast, true); t.after(() => f.dispose())
    if (!fast) { await f.complete(); f.clock.jump(2200) }
    await settle(); assert.equal(f.state.preparations, 1)
    f.state.ready = false; f.controller.presented({ state: "lost" })
    f.preparation.resolve(); await settle()
    assert.equal(f.state.writes, 0)
    assert.notEqual(f.view()?.autoApproval?.status, "cancelled")
    f.state.ready = true
    f.controller.reconcile([request], f.controller.revision); f.wake(); f.clock.jump(0); await settle()
    assert.equal(f.state.writes, 1)
    await f.complete()
    assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 1)
  })

  for (const stop of ["cancel", "disable", "reject", "delete"] as const) {
    test(`${fast ? "fast" : "normal"}: explicit ${stop} stops an unsent approval despite later eligibility`, async t => {
      const f = await fixture(fast, true); t.after(() => f.dispose())
      if (!fast) { await f.complete(); f.clock.jump(2200) }
      await settle()
      if (stop === "cancel") f.controller.cancelAutoApproval(request.id)
      if (stop === "disable") { f.state.enabled = false; f.controller.modeChanged("root") }
      if (stop === "reject") { f.state.pending = []; f.controller.permissionReplied({ sessionID: "root", requestID: request.id, decision: "reject" }) }
      if (stop === "delete") f.controller.deleted("root")
      f.preparation.resolve(); await settle(); f.wake(); f.clock.jump(10_000); await settle()
      assert.equal(f.state.writes, 0)
      if (stop === "cancel" || stop === "disable") {
        f.state.enabled = true; f.controller.reconcile([request], f.controller.revision); await settle(); f.wake(); f.clock.jump(10_000)
        assert.equal(f.state.writes, 0)
      }
    })
  }

  test(`${fast ? "fast" : "normal"}: uncertain writes stay manual and changed requests cannot inherit a Safe rating`, async t => {
    const f = await fixture(fast, true); t.after(() => f.dispose())
    if (!fast) { await f.complete(); f.clock.jump(2200) }
    await settle()
    f.controller.reconcile([{ ...request, resources: ["changed"] }], f.controller.revision)
    f.preparation.resolve(); await settle(); f.wake(); f.clock.jump(10_000)
    assert.equal(f.state.writes, 0)
    assert.equal(f.view()?.autoApproval?.status, "failed")
    assert.equal(f.lifecycle.filter(fact => fact.type === "cancelled").length, 0)

    const other = await fixture(fast, true); t.after(() => other.dispose())
    other.state.uncertain = true
    if (!fast) { await other.complete(); other.clock.jump(2200) }
    other.preparation.resolve(); await settle()
    other.controller.reconcile([request], other.controller.revision); other.wake(); other.clock.jump(10_000); await settle()
    assert.equal(other.state.writes, 1)
    assert.equal(other.view()?.autoApproval?.status, "failed")
  })
}

test("normal: a pre-write read error recovers without restarting the completed countdown", async t => {
  const f = await fixture(); t.after(() => f.dispose()); await f.complete()
  f.state.listErrors = 1; f.clock.jump(2200); await settle()
  f.controller.reconcile([request], f.controller.revision); f.wake(); f.clock.jump(0); await settle()
  assert.equal(f.state.writes, 1)
  assert.equal(f.lifecycle.filter(fact => fact.type === "cancelled").length, 0)
})

test("normal: a route change during the verification read cannot strand the expired countdown", async t => {
  const f = await fixture(false, false, true); t.after(() => f.dispose()); await f.complete()
  f.clock.jump(2200); await settle()
  f.state.ready = false; f.verification.resolve([request]); await settle()
  assert.equal(f.state.writes, 0)
  assert.notEqual(f.view()?.autoApproval?.status, "cancelled")
  f.state.ready = true; f.wake(); f.clock.jump(0); await settle()
  assert.equal(f.state.writes, 1)
})

test("fast: rejected preview revokes an unsent approval without turning hidden UI into cancellation", async t => {
  const f = await fixture(true, true); t.after(() => f.dispose())
  f.progress({ attempt: 0, phase: "streaming" })
  f.controller.presented({ state: "lost" })
  f.preparation.resolve(); await settle()
  assert.equal(f.state.writes, 0)
  f.progress({ attempt: 1, phase: "retrying" })
  f.progress({ attempt: 1, phase: "streaming", preview: safe })
  await settle()
  assert.equal(f.state.writes, 1)
  assert.equal(f.lifecycle.filter(fact => fact.type === "cancelled").length, 0)
})

test("fast: hidden Safe preview is retained and accepted without ever presenting the report", async t => {
  const f = await fixture(true); t.after(() => f.dispose()); await settle()
  assert.equal(f.state.writes, 1)
  assert.equal(f.view()?.retained, true)
  f.state.ready = false; f.controller.presented({ state: "lost" })
  await f.complete()
  assert.equal(f.controller.views.length, 0)
  assert.equal(f.lifecycle.filter(fact => fact.type === "accepted").length, 1)
})

test("fast: a hidden retained report is not a native blocker for the next Safe request", async t => {
  const second: HostRequest = { ...request, id: "second", source: { assistantID: "assistant", id: "second-call" } }
  const assessments = [deferred<ReviewResult>(), deferred<ReviewResult>()], writes: string[] = [], pending = [request, second]
  const facts: ApprovalFact<HostRequest>[] = []
  const controller = new Controller<HostRequest>(async (value, _signal, identified, progress) => {
    identified(); progress({ attempt: 0, phase: "evaluating" }); progress({ attempt: 0, phase: "streaming", preview: safe })
    return assessments[value.id === request.id ? 0 : 1]!.promise
  }, () => {}, { candidate: () => true, approvalReady: () => true, nativeFront: () => pending[0]?.id,
    modes: { root: async () => "root", load: async () => {}, enabled: () => true },
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode: true, stream: true },
    onApproval: fact => { facts.push(fact) }, nativeApproval: {
      visibleID: () => undefined, list: async () => pending,
      async once(value, _signal, dispatch) {
        if (!dispatch()) return { status: "unavailable" }
        assert.equal(pending[0]?.id, value.id)
        writes.push(value.id); pending.shift()
        queueMicrotask(() => controller.permissionReplied({ sessionID: value.sessionID, requestID: value.id, decision: "once" }))
        return { status: "submitted" }
      },
    },
  })
  t.after(async () => { for (const result of assessments) result.resolve(safe); await controller.dispose() })
  controller.asked(request); controller.asked(second); await settle()
  controller.refreshApprovalEligibility(); await settle()
  assert.deepEqual(writes, [request.id, second.id])
  assert.equal(controller.pendingViews.length, 0)
  assert.equal(controller.views.filter(view => view.retained).length, 2)
  for (const result of assessments) result.resolve(safe)
  await settle()
  assert.equal(controller.views.length, 0)
  assert.equal(facts.filter(fact => fact.type === "confirmed").length, 2)
})
