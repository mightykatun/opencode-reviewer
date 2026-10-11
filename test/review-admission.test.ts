import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller, visibleReview, type ControllerOptions } from "../src/controller.js"
import type { ReviewProgress, ReviewResult } from "../src/types.js"
import { ownedReview } from "../src/review-admission.js"

const request = (id: string, sessionID = "root", permission = "bash"): PermissionRequest =>
  ({ id, sessionID, permission, patterns: [id], metadata: {}, always: [] })
const report = { safe: true, desc: "Final admitted report." }
const id = (i: number) => `per_${String(i).padStart(3, "0")}`
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(t: TestContext, options: ControllerOptions = {}) {
  let actual = 0, maximum = 0, publications = 0
  const accepted: string[] = []
  const workers: { request: PermissionRequest; signal: AbortSignal; identify(): void; progress(p: ReviewProgress): void;
    result: ReturnType<typeof deferred<ReviewResult>>; cleanup: ReturnType<typeof deferred<void>> }[] = []
  const controller = new Controller(async (req, signal, identify, progress) => {
    actual++; maximum = Math.max(maximum, actual)
    const result = deferred<ReviewResult>(), cleanup = deferred<void>()
    workers.push({ request: req, signal, identify, progress, result, cleanup })
    identify()
    try { return await result.promise }
    finally { await cleanup.promise; actual-- }
  }, () => { publications++ }, { ...options, onLifecycle: fact => {
    if (fact.type === "accepted") accepted.push(fact.request.id)
    return options.onLifecycle?.(fact)
  } })
  t.after(async () => {
    const closing = controller.dispose()
    for (const worker of workers) { worker.result.resolve(report); worker.cleanup.resolve() }
    await closing
    assert.equal(actual, 0)
    assert.ok(maximum <= 4)
  })
  return { controller, workers, accepted, actual: () => actual, maximum: () => maximum, publications: () => publications,
    finish: (index: number) => { workers[index]!.result.resolve(report); workers[index]!.cleanup.resolve() } }
}
const gate = (root: (session: string) => string, enabled = () => true) => ({
  root: async (session: string) => root(session), load: async () => {}, enabled,
})

for (const children of [false, true]) test(`fanout64 ${children ? "root/child" : "same-root"}: four evaluators, native-front first and bounded progress`, async t => {
  const f = fixture(t, { modes: gate(() => "ses_Z_root") })
  const requests = Array.from({ length: 64 }, (_, i) => request(id(i), children && i % 2 ? "ses_A_child" : "ses_Z_root"))
  f.controller.reconcile(requests.toReversed(), f.controller.revision)
  assert.equal(f.publications(), 65, "native blockers publish synchronously, including reconciliation completion")
  await settle()
  const order = [...requests].sort((a, b) => a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : a.id < b.id ? -1 : 1)
  assert.deepEqual(f.workers.map(w => w.request.id), order.slice(0, 4).map(r => r.id))
  assert.equal(f.actual(), 4)
  assert.equal(f.publications(), 69, "waiting entries neither identify nor stream")
  for (let i = 0; i < 64; i++) {
    assert.equal(f.workers[i]?.request.id, order[i]!.id)
    f.finish(i); await settle()
    assert.equal(f.workers.length, Math.min(64, i + 5), "one physical completion admits at most one replacement")
  }
  assert.equal(f.maximum(), 4)
  assert.equal(f.actual(), 0)
  assert.equal(f.accepted.length, 64)
  assert.equal(new Set(f.accepted).size, 64)
  assert.ok(f.controller.views.every(view => view.status === "complete"))
})

test("native-front child arriving behind fanout64 is next in its root, without preempting active evidence", async t => {
  const f = fixture(t, { modes: gate(() => "ses_Z_root") })
  for (let i = 0; i < 64; i++) f.controller.asked(request(id(i), "ses_Z_root"))
  await settle()
  f.controller.asked(request("per_z", "ses_A_child"))
  await settle()
  assert.equal(f.workers.length, 4)
  assert.ok(f.workers.every(w => !w.signal.aborted))
  f.finish(0); await settle()
  assert.equal(f.workers[4]?.request.sessionID, "ses_A_child", "session priority precedes request ID")
  f.finish(1); await settle()
  assert.equal(f.workers[5]?.request.id, id(4))
})

test("actual native front outranks earlier-ID deep descendants using public session metadata", async t => {
  const f = fixture(t, { modes: gate(session => session === "busy" ? "busy" : "ses_Z_root"),
    session: session => ({ id: session, ...(session === "ses_A_child" ? { parentID: "ses_Z_root" }
      : session === "ses_0_deep" ? { parentID: "ses_A_child" } : {}) }) })
  for (let i = 0; i < 4; i++) f.controller.asked(request(`busy-${i}`, "busy"))
  await settle()
  for (let i = 0; i < 64; i++) f.controller.asked(request(id(i), "ses_0_deep"))
  f.controller.asked(request("per_z", "ses_A_child"))
  f.controller.asked(request("per_a", "ses_Z_root"))
  await settle()
  f.finish(0); await settle()
  assert.equal(f.workers[4]?.request.sessionID, "ses_A_child")
  f.controller.replied("per_z")
  f.finish(1); await settle()
  assert.equal(f.workers[5]?.request.sessionID, "ses_Z_root")
})

test("root round-robin bounds other-root latency despite fanout64 and continued arrivals", async t => {
  const f = fixture(t, { modes: gate(session => session) })
  const requests = ["A", "B", "C"].flatMap(root => Array.from({ length: root === "A" ? 64 : 8 }, (_, i) => request(`${root}-${id(i)}`, root)))
  f.controller.reconcile(requests, f.controller.revision)
  await settle()
  assert.deepEqual(f.workers.map(w => w.request.sessionID), ["A", "B", "C", "A"])
  f.controller.asked(request("D-front", "D"))
  await settle()
  for (let i = 0; i < 4; i++) {
    f.controller.asked(request(`A-later-${i}`, "A"))
    f.finish(i); await settle()
  }
  assert.deepEqual(f.workers.slice(4).map(w => w.request.sessionID), ["B", "C", "A", "D"])
  assert.equal(f.maximum(), 4)
})

for (const removal of ["reply", "delete", "disable", "dispose"] as const) {
  test(`fanout64 ${removal} cancels queued work immediately and retains noncooperative running capacity through cleanup`, async t => {
    let enabled = true
    const f = fixture(t, { modes: gate(() => "root", () => enabled) })
    const requests = Array.from({ length: 64 }, (_, i) => request(id(i)))
    f.controller.reconcile(requests, f.controller.revision)
    await settle()
    assert.equal(f.workers.length, 4)
    if (removal === "reply") for (const req of requests) f.controller.replied(req.id)
    if (removal === "delete") f.controller.deleted("root")
    if (removal === "disable") { enabled = false; f.controller.modeChanged("root") }
    const closing = removal === "dispose" ? f.controller.dispose() : undefined
    const publications = f.publications()
    assert.ok(f.workers.every(w => w.signal.aborted))
    if (removal === "disable") assert.ok(f.controller.views.every(v => v.status === "suspended"))
    else assert.equal(f.controller.views.length, 0)
    for (const worker of f.workers) {
      worker.identify()
      worker.progress({ attempt: 0, phase: "evaluating" })
      worker.result.resolve(report)
    }
    await settle()
    assert.equal(f.actual(), 4, "resolved body is not settled evaluator cleanup")
    assert.equal(f.workers.length, 4)
    assert.equal(f.publications(), publications)
    for (const worker of f.workers) worker.cleanup.resolve()
    await settle(); await closing
    assert.equal(f.workers.length, 4, "cancelled waiting requests never invoke evidence/model evaluation")
    assert.deepEqual(f.accepted, [])
    assert.equal(f.publications(), publications)
  })
}

for (const outcome of ["result", "error"] as const) test(`fanout64 re-enable waits for old physical ${outcome}/cleanup and admits only the fresh generation`, async t => {
  let enabled = true
  const f = fixture(t, { modes: gate(() => "root", () => enabled) })
  const requests = Array.from({ length: 64 }, (_, i) => request(id(i)))
  f.controller.reconcile(requests, f.controller.revision); await settle()
  enabled = false; f.controller.modeChanged("root")
  const stale = f.controller.revision
  enabled = true; f.controller.modeChanged("root")
  f.controller.reconcile(requests, stale); await settle()
  assert.ok(f.controller.views.every(v => v.status === "suspended"))
  f.controller.reconcile(requests, f.controller.revision); await settle()
  assert.equal(f.workers.length, 4, "a fresh enabled generation does not release aborted evaluators")
  const before = f.publications()
  for (const worker of f.workers) {
    worker.identify()
    worker.progress({ attempt: 0, phase: "streaming", preview: { safe: false, desc: "obsolete" } })
    if (outcome === "result") worker.result.resolve({ safe: false, desc: "obsolete" })
    else worker.result.reject(new Error("obsolete failure"))
  }
  await settle()
  assert.equal(f.workers.length, 4)
  assert.equal(f.publications(), before)
  assert.deepEqual(f.accepted, [])
  f.workers[0]!.cleanup.resolve(); await settle()
  assert.equal(f.workers.length, 5)
  assert.equal(f.workers[4]?.request.id, id(0))
  assert.equal(f.actual(), 4)
  f.finish(4); await settle()
  assert.deepEqual(f.accepted, [id(0)])
  assert.equal(f.controller.views[0]?.assessment, report)
  assert.equal(f.controller.views[1]?.error, undefined)
  assert.equal(f.workers.length, 6)
})

test("disabled kinds remain native blockers after all admitted reviews complete", async t => {
  const requests = [request("0-blocker", "root", "edit"), ...Array.from({ length: 8 }, (_, i) => request(id(i)))]
  let writes = 0
  const f = fixture(t, {
    reviewOptions: { reviewBash: true, reviewEdits: false, autoApprove: true },
    approval: { visibleID: () => visibleReview(f.controller.views, "root", id => ({ id }))?.request.id,
      list: async () => requests, once: async () => { writes++ } },
  })
  f.controller.reconcile(requests, f.controller.revision); await settle()
  for (let i = 0; i < 8; i++) { f.finish(i); await settle() }
  assert.equal(f.workers.length, 8)
  assert.equal(f.controller.views[0]?.status, "unrelated")
  assert.equal(visibleReview(f.controller.views, "root", id => ({ id })), undefined)
  f.controller.presented(id(0)); await f.controller.approveNow(id(0))
  assert.equal(writes, 0)
  requests.shift(); f.controller.replied("0-blocker")
  f.controller.presented(id(0)); await f.controller.approveNow(id(0))
  assert.equal(writes, 1)
})

test("retained fast report owns one of four slots across resolution, disable/re-enable and native handoff", async t => {
  let enabled = true, shown: string | undefined = "root"
  const requests = Array.from({ length: 64 }, (_, i) => request(id(i)))
  const writes: string[] = []
  const f = fixture(t, {
    modes: gate(() => "root", () => enabled),
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode: true, stream: true },
    approval: { visibleID: () => visibleReview(f.controller.views, shown, id => ({ id }))?.request.id,
      list: async () => requests, once: async req => { writes.push(req.id) } },
  })
  f.controller.reconcile(requests, f.controller.revision); await settle()
  f.controller.presented(id(0))
  f.workers[0]!.progress({ attempt: 0, phase: "evaluating" })
  f.workers[0]!.progress({ attempt: 0, phase: "streaming", preview: { safe: true, desc: "unfinished" } })
  await settle()
  assert.deepEqual(writes, [id(0)])
  assert.equal(f.controller.views[0]?.retained, true)
  assert.equal(f.controller.views[0]?.resolved, true)
  requests.shift(); f.controller.replied(id(0))
  shown = undefined; f.controller.presented()
  enabled = false; f.controller.modeChanged("root")
  enabled = true; f.controller.modeChanged("root")
  f.controller.reconcile(requests, f.controller.revision); await settle()
  assert.equal(f.workers.length, 4)
  assert.equal(f.workers[0]!.signal.aborted, false)
  assert.ok(f.workers.slice(1).every(w => w.signal.aborted))
  f.finish(1); await settle()
  assert.equal(f.workers.length, 5)
  assert.equal(f.workers[4]!.request.id, id(1))
  assert.equal(f.actual(), 4, "retained stream plus two old finalizers plus one fresh evaluator")
  shown = "root"
  f.controller.presented(visibleReview(f.controller.views, shown, id => ({ id }))?.request.id)
  f.workers[4]!.progress({ attempt: 0, phase: "evaluating" })
  f.workers[4]!.progress({ attempt: 0, phase: "streaming", preview: { safe: true, desc: "next" } })
  await settle()
  assert.deepEqual(writes, [id(0)], "retained physical presentation cannot approve the next native request")
  f.finish(0); await settle()
  assert.equal(f.workers.length, 6)
  assert.deepEqual(f.accepted, [id(0)])
  assert.equal(f.controller.views.some(v => v.request.id === id(0)), false)
  f.controller.presented(id(1)); await settle()
  assert.deepEqual(writes, [id(0), id(1)])
})

for (const stage of ["evidence", "model"] as const) test(`fanout64 ${stage} deadline publishes failure but retains physical slots and disposal ownership`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let evidence = 0, models = 0, actual = 0, maximum = 0, accepted = 0
  const physical: ReturnType<typeof deferred<void>>[] = []
  const controller = new Controller((req, parent, identified) => ownedReview(parent, 100, async signal => {
    evidence++; actual++; maximum = Math.max(maximum, actual)
    const held = deferred<void>(); physical.push(held)
    try {
      identified()
      if (stage === "evidence") await held.promise
      signal.throwIfAborted()
      models++
      if (stage === "model") await held.promise
      return report
    } finally { actual-- }
  }), () => {}, { onLifecycle: fact => { if (fact.type === "accepted") accepted++ } })
  t.after(async () => {
    const closing = controller.dispose()
    for (const held of physical) held.resolve()
    await closing
  })
  const requests = Array.from({ length: 64 }, (_, i) => request(id(i)))
  controller.reconcile(requests, controller.revision); await settle()
  assert.equal(evidence, 4)
  assert.equal(models, stage === "model" ? 4 : 0)
  for (let cycle = 0; cycle < 10; cycle++) {
    t.mock.timers.tick(100); await settle()
    controller.reconcile(requests, controller.revision); await settle()
    assert.equal(evidence, 4)
    assert.equal(actual, 4)
    assert.equal(controller.views.filter(v => v.status === "unavailable").length, 4)
    assert.equal(controller.views.filter(v => v.status === "identifying").length, 60)
  }
  physical[0]!.resolve(); await settle()
  assert.equal(evidence, 5)
  assert.equal(models, stage === "model" ? 5 : 0, "late evidence cannot reach model transport after timeout")
  assert.equal(actual, 4)
  let disposed = false
  const closing = controller.dispose().then(() => { disposed = true })
  await settle()
  assert.equal(disposed, false)
  for (const held of physical) held.resolve()
  await closing
  assert.equal(actual, 0)
  assert.equal(maximum, 4)
  assert.equal(evidence, 5)
  assert.equal(accepted, 0)
})

test("disable during the reserved dispatch turn prevents the remaining queued invocations", async t => {
  let enabled = true, calls = 0
  const controller = new Controller(async () => {
    calls++
    enabled = false; controller.modeChanged("root")
    return report
  }, () => {}, { modes: gate(() => "root", () => enabled) })
  t.after(() => controller.dispose())
  for (let i = 0; i < 64; i++) controller.asked(request(id(i)))
  await settle()
  assert.equal(calls, 1)
  assert.ok(controller.views.every(v => v.status === "suspended"))
})

test("synchronous evaluator throws release their owned slots and the queue continues", async t => {
  let calls = 0
  const controller = new Controller(() => { calls++; throw new Error("fixture evaluator failure") }, () => {})
  t.after(() => controller.dispose())
  for (let i = 0; i < 64; i++) controller.asked(request(id(i)))
  await settle()
  assert.equal(calls, 64)
  assert.ok(controller.views.every(v => v.status === "unidentified"))
})
