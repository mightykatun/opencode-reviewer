import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, displayText, visibleReview, type ControllerOptions, type ReviewLifecycleFact } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { ReviewProgress, ReviewResult, ReviewTiming } from "../src/types.js"
import { SessionModes } from "../src/session-mode.js"
import { SessionAncestry } from "../src/session-ancestry.js"

const request = (id: string, sessionID = "root", action = "shell"): HostRequest => ({ id, sessionID, action,
  resources: [id], source: { assistantID: "assistant", id: "shared-call" } })
const safe: ReviewResult = { safe: true, desc: "Counts fruit." }
const options: ControllerOptions = { candidate: () => true, nativeFront: (_root, pending) => pending[0]?.id }
const session = (id: string) => ({ id })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function modes(read: () => Promise<boolean> = async () => true,
  lookup = async (id: string): Promise<{ id: string; parentID?: string } | undefined> =>
    ({ id, ...(id === "child" ? { parentID: "root" } : id === "deep" ? { parentID: "child" } : {}) })) {
  return new SessionModes({ read, write: async () => {}, flush: async () => {} }, new SessionAncestry(lookup))
}

test("deduplicates permission IDs, not shared tool calls, and binds concurrent assessments", async t => {
  const pending = new Map<string, ReturnType<typeof deferred<ReviewResult>>>()
  const controller = new Controller(req => { const result = deferred<ReviewResult>(); pending.set(req.id, result); return result.promise }, () => {}, options)
  t.after(() => controller.dispose())
  controller.asked(request("directory", "root", "external_directory")); controller.asked(request("shell")); controller.asked(request("shell"))
  await settle(); assert.equal(pending.size, 2)
  pending.get("shell")!.resolve({ safe: false, desc: "Deletes data." }); pending.get("directory")!.resolve(safe)
  await settle()
  assert.deepEqual(controller.views.map(v => [v.request.id, v.assessment?.safe]), [["directory", true], ["shell", false]])
})

test("only accepted final reviews contribute ratings, not previews, retries, errors, or republication", async t => {
  const ratings: boolean[] = []
  const controller = new Controller(async (req, _signal, identify, progress) => {
    identify(); progress({ attempt: 0, phase: "evaluating" }); progress({ attempt: 0, phase: "streaming", preview: { safe: true } })
    progress({ attempt: 1, phase: "retrying" }); progress({ attempt: 1, phase: "streaming", preview: { safe: false } })
    if (req.id === "error") throw Error("Unavailable")
    if (req.id === "unrelated") return null
    return { safe: req.id === "safe", desc: "Final review." }
  }, () => {}, { ...options, reviewOptions: { reviewBash: true, reviewEdits: true, stream: true }, onRating: value => { ratings.push(value) } })
  t.after(() => controller.dispose())
  const pending = ["safe", "unsafe", "error", "unrelated"].map(id => request(id))
  for (const req of pending) { controller.asked(req); controller.asked(req) }
  await settle(); assert.deepEqual(ratings, [true, false])
  controller.reconcile(pending, controller.revision); controller.refreshApprovalEligibility(); await settle()
  assert.deepEqual(ratings, [true, false])
})

test("review timing uses the accepted attempt's first rating and excludes approval time", async t => {
  let now = 100, progress!: (value: ReviewProgress) => void
  const result = deferred<ReviewResult>(), timings: ReviewTiming[] = []
  const controller = new Controller((_req, _signal, identify, onProgress) => {
    identify(); progress = onProgress; return result.promise
  }, () => {}, { ...options, reviewOptions: { reviewBash: true, reviewEdits: true, stream: true },
    clock: { now: () => now, after: () => () => {} }, onRating: (_safe, timing) => { timings.push(timing) } })
  t.after(() => controller.dispose())
  controller.asked(request("a")); await settle(); progress({ attempt: 0, phase: "evaluating" })
  now = 150; progress({ attempt: 0, phase: "streaming", preview: { desc: "Description first" } })
  now = 300; progress({ attempt: 0, phase: "streaming", preview: { safe: false } })
  now = 500; progress({ attempt: 1, phase: "retrying" })
  now = 700; progress({ attempt: 1, phase: "streaming", preview: { safe: true } })
  now = 900; progress({ attempt: 0, phase: "streaming", preview: { safe: false } })
  now = 1000; result.resolve(safe); await settle(); now = 5000; controller.refreshApprovalEligibility()
  assert.deepEqual(timings, [{ fullReportMs: 900, ratingMs: 600 }])
})

test("nonstream timing records full response latency for both measures", async t => {
  let now = 100
  const timings: ReviewTiming[] = []
  const controller = new Controller(async () => { now = 1100; return safe }, () => {}, { ...options,
    clock: { now: () => now, after: () => () => {} }, onRating: (_safe, timing) => { timings.push(timing) } })
  t.after(() => controller.dispose()); controller.asked(request("a")); await settle()
  assert.deepEqual(timings, [{ fullReportMs: 1000, ratingMs: 1000 }])
})

for (const action of ["reply", "delete", "disable", "dispose"] as const) for (const outcome of ["result", "error"] as const) {
  test(`${action} suppresses late identification, ${outcome}, rating and publication`, async () => {
    const gate = modes(), result = deferred<ReviewResult>(), ratings: boolean[] = []
    let identify!: () => void, signal!: AbortSignal, publications = 0
    const controller = new Controller((_req, parent, identified) => { signal = parent; identify = identified; return result.promise },
      () => { publications++ }, { ...options, modes: gate, onRating: value => { ratings.push(value) } })
    controller.asked(request("a")); await settle()
    if (action === "reply") controller.replied("a")
    if (action === "delete") controller.deleted("root")
    if (action === "disable") { await gate.set("root", false); controller.modeChanged("root") }
    const closing = action === "dispose" ? controller.dispose() : undefined
    assert.ok(signal.aborted); const before = publications; identify()
    if (outcome === "result") result.resolve(safe); else result.reject(Error("obsolete"))
    await settle(); await closing; assert.equal(publications, before); assert.deepEqual(ratings, [])
    await controller.dispose()
  })
}

for (const failure of ["throw", "reject"] as const) test(`observer ${failure} cannot change review acceptance`, async t => {
  const controller = new Controller(async () => safe, () => {}, { ...options,
    onRating: () => { if (failure === "throw") throw Error("storage"); return Promise.reject(Error("storage")) } })
  t.after(() => controller.dispose()); controller.asked(request("a")); await settle()
  assert.equal(controller.views[0]?.assessment, safe)
})

test("stale startup snapshots cannot resurrect resolved permissions or deleted unknown sessions", async t => {
  const controller = new Controller(async () => safe, () => {}, options)
  t.after(() => controller.dispose())
  const revision = controller.revision; controller.replied("a"); controller.deleted("deleted")
  controller.reconcile([request("a"), request("deleted", "deleted")], revision)
  assert.equal(controller.views.length, 0)
  controller.reconcile([request("fresh")], controller.revision); await settle()
  assert.equal(controller.views[0]?.assessment, safe)
})

test("deletion aborts all matching permissions without disturbing independent roots", async t => {
  const pending = new Map<string, { signal: AbortSignal; result: ReturnType<typeof deferred<ReviewResult>> }>()
  const controller = new Controller((req, signal) => {
    const result = deferred<ReviewResult>(); pending.set(req.id, { signal, result }); return result.promise
  }, () => {}, options)
  t.after(() => controller.dispose())
  for (const req of [request("directory", "deleted", "external_directory"), request("shell", "deleted"), request("survivor")]) controller.asked(req)
  await settle(); controller.deleted("deleted")
  for (const [id, worker] of pending) { assert.equal(worker.signal.aborted, id !== "survivor"); worker.result.resolve(safe) }
  await settle(); assert.deepEqual(controller.views.map(v => v.request.id), ["survivor"])
})

for (const identified of [false, true]) test(`${identified ? "identified" : "unidentified"} failures block later display without fabricating a rating`, async t => {
  let identify!: () => void
  const controller = new Controller(async (req, _signal, callback) => {
    if (req.id === "first") { identify = callback; if (identified) callback(); throw Error("Unavailable") }
    return safe
  }, () => {}, options)
  t.after(() => controller.dispose()); controller.asked(request("first")); controller.asked(request("later")); await settle()
  assert.equal(controller.views[0]?.status, identified ? "unavailable" : "unidentified")
  assert.equal(controller.views[0]?.assessment, undefined)
  const before = controller.views[0]; identify(); assert.equal(controller.views[0], before)
  assert.equal(visibleReview(controller.views, "root", session, options.nativeFront)?.request.id, identified ? "first" : undefined)
  controller.replied("first"); assert.equal(visibleReview(controller.views, "root", session, options.nativeFront)?.request.id, "later")
})

test("disabled kinds never evaluate but remain native blockers", async t => {
  const evaluated: string[] = []
  const controller = new Controller(async req => { evaluated.push(req.id); return safe }, () => {}, {
    ...options, candidate: req => req.action === "shell" })
  t.after(() => controller.dispose()); controller.asked(request("read", "root", "read")); controller.asked(request("shell")); await settle()
  assert.deepEqual(evaluated, ["shell"]); assert.equal(visibleReview(controller.views, "root", session, options.nativeFront), undefined)
  controller.replied("read"); assert.equal(visibleReview(controller.views, "root", session, options.nativeFront)?.request.id, "shell")
})

test("terminal controls and bidi text cannot manipulate displayed ratings", () => {
  assert.equal(displayText("x\x1b[2J\r\u202ey"), "x\\u001b[2J\\u000d\\u202ey")
  assert.equal(displayText("first\nsecond\tthird"), "first\nsecond\tthird")
  assert.equal(displayText("**Effects**\n- `\x1b[2J`\n- *\u202eRisk*"), "**Effects**\n- `\\u001b[2J`\n- *\\u202eRisk*")
})

test("disabled root and all descendants skip enrichment while independent roots review", async t => {
  const gate = modes(); await gate.set("root", false); const evaluated: string[] = []
  const controller = new Controller(async req => { evaluated.push(req.id); return safe }, () => {}, { ...options, modes: gate })
  t.after(() => controller.dispose())
  const pending = ["root", "child", "deep", "other"].map(id => request(id, id))
  controller.reconcile(pending, controller.revision); await settle(); controller.reconcile(pending, controller.revision); await settle()
  assert.deepEqual(evaluated, ["other"]); assert.ok(controller.views.slice(0, 3).every(v => v.status === "suspended"))
  const stale = controller.revision; await gate.set("root", true); controller.modeChanged("root")
  controller.reconcile(pending, stale); await settle(); assert.deepEqual(evaluated, ["other"])
  for (let i = 0; i < 2; i++) { controller.reconcile(pending, controller.revision); await settle() }
  assert.deepEqual(evaluated.toSorted(), ["child", "deep", "other", "root"])
})

test("disable then enable during unresolved ancestry requires a post-switch snapshot", async t => {
  const ancestry = deferred<{ id: string; parentID: string }>(), gate = modes(async () => true,
    async id => id === "child" ? ancestry.promise : { id })
  let calls = 0
  const controller = new Controller(async () => { calls++; return safe }, () => {}, { ...options, modes: gate })
  t.after(() => controller.dispose()); controller.asked(request("a", "child")); await settle()
  await gate.set("root", false); controller.modeChanged("root"); await gate.set("root", true); controller.modeChanged("root")
  ancestry.resolve({ id: "child", parentID: "root" }); await settle(); assert.equal(calls, 0)
  controller.reconcile([request("a", "child")], controller.revision); await settle(); assert.equal(calls, 1)
})

for (const enabled of [false, true]) test(`unavailable saved mode recovers to ${enabled} only through current reconciliation`, async t => {
  let available = false, reads = 0, calls = 0
  const gate = modes(async () => { reads++; if (!available) throw Error("unavailable"); return enabled })
  const controller = new Controller(async () => { calls++; return safe }, () => {}, { ...options, modes: gate })
  t.after(() => controller.dispose()); controller.asked(request("a")); await settle()
  assert.equal(controller.views[0]?.status, "suspended"); assert.equal(calls, 0)
  const stale = controller.revision; controller.replied("unknown"); available = true
  controller.reconcile([request("a")], stale); await settle(); assert.equal(reads, 1)
  controller.reconcile([request("a")], controller.revision); await settle(); assert.equal(reads, 2); assert.equal(calls, enabled ? 1 : 0)
  for (let i = 0; i < 3; i++) controller.reconcile([request("a")], controller.revision)
  await settle(); assert.equal(reads, 2)
})

test("expired saved-mode loading owns actual settlement and cannot replace recovered settings", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const held = deferred<boolean>(); let reads = 0, calls = 0, signal!: AbortSignal
  const gate = new SessionModes({ read: (_root, parent) => { signal = parent; return ++reads === 1 ? held.promise : Promise.resolve(true) },
    write: async () => {}, flush: async () => {} }, new SessionAncestry(async id => ({ id })))
  const controller = new Controller(async () => { calls++; return safe }, () => {}, { ...options, modes: gate })
  t.after(() => controller.dispose()); controller.asked(request("a")); await settle(); t.mock.timers.tick(5000); await settle()
  assert.ok(signal.aborted); controller.reconcile([request("a")], controller.revision); await settle(); assert.equal(reads, 1)
  held.resolve(false); await settle(); assert.equal(gate.enabled("root"), false)
  controller.reconcile([request("a")], controller.revision); await settle(); assert.equal(reads, 2); assert.equal(calls, 1)
})

for (const outcome of ["result", "error"] as const) test(`fresh enable rejects prior generation's late ${outcome}`, async t => {
  const gate = modes(), workers: ReturnType<typeof deferred<ReviewResult>>[] = []
  const controller = new Controller(() => { const worker = deferred<ReviewResult>(); workers.push(worker); return worker.promise }, () => {}, { ...options, modes: gate })
  t.after(() => controller.dispose()); controller.asked(request("a")); await settle()
  await gate.set("root", false); controller.modeChanged("root"); await gate.set("root", true); controller.modeChanged("root")
  controller.reconcile([request("a")], controller.revision); await settle()
  if (outcome === "result") workers[0]!.resolve({ safe: false, desc: "obsolete" }); else workers[0]!.reject(Error("obsolete"))
  await settle(); assert.equal(controller.views[0]?.assessment, undefined)
  workers[1]!.resolve(safe); await settle(); assert.equal(controller.views[0]?.assessment, safe)
})

test("disposal drains removed review finalizers before caller flush", async () => {
  const held = deferred<void>(), events: string[] = [], facts: ReviewLifecycleFact[] = []
  const controller = new Controller(async (_request, signal) => {
    try { await held.promise; return safe } finally { assert.ok(signal.aborted); events.push("usage-finalized") }
  }, () => {}, { ...options, onLifecycle: fact => { facts.push(fact) } })
  controller.asked(request("a")); await settle(); controller.replied("a")
  const closing = controller.dispose().then(() => { events.push("flush") }); await settle(); assert.deepEqual(events, [])
  held.resolve(); await closing; assert.deepEqual(events, ["usage-finalized", "flush"])
  assert.equal(facts.filter(f => f.type === "accepted").length, 0)
})

for (const outcome of ["resolve", "reject"] as const) test(`many reconciliation deadlines cap stalled mode reads across roots through late ${outcome} cleanup`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending: { root: string; signal: AbortSignal; value: ReturnType<typeof deferred<boolean>>; cleanup: ReturnType<typeof deferred<void>> }[] = []
  const readCalls = new Map<string, number>(), perRoot = new Map<string, number>(), evaluated: string[] = []
  let available = false, actual = 0, maximum = 0, maximumPerRoot = 0
  const gate = new SessionModes({ read: async (root, signal) => {
    readCalls.set(root, (readCalls.get(root) ?? 0) + 1)
    actual++; maximum = Math.max(maximum, actual); perRoot.set(root, (perRoot.get(root) ?? 0) + 1)
    maximumPerRoot = Math.max(maximumPerRoot, perRoot.get(root)!)
    const settled = () => { actual--; perRoot.set(root, perRoot.get(root)! - 1) }
    if (available) { settled(); return true }
    const value = deferred<boolean>(), cleanup = deferred<void>(); pending.push({ root, signal, value, cleanup })
    try { return await value.promise } finally { try { await cleanup.promise } finally { settled() } }
  }, write: async () => {}, flush: async () => {} }, new SessionAncestry(async id => ({ id })))
  const controller = new Controller(async req => { evaluated.push(req.id); return safe }, () => {}, { ...options, modes: gate })
  t.after(async () => {
    await controller.dispose()
    for (const read of pending) { read.value.resolve(false); read.cleanup.resolve() }
    await settle(); assert.equal(actual, 0); assert.ok(maximum <= 2); assert.ok(maximumPerRoot <= 1)
  })
  const requests = [request("a-first", "rootA"), request("a-second", "rootA"), request("b-first", "rootB"), request("c-disabled", "rootC"),
    ...["D", "E", "F", "G", "H"].map(id => request(`other-${id}`, `root${id}`))]
  controller.reconcile(requests, controller.revision); await settle()
  assert.deepEqual(pending.map(read => read.root), ["rootA", "rootB"])
  for (let cycle = 0; cycle < 40; cycle++) {
    controller.reconcile(requests, controller.revision); await settle(); t.mock.timers.tick(5000); await settle()
    assert.equal(actual, 2); assert.equal(pending.length, 2); assert.ok(controller.views.every(v => v.status === "suspended"))
    assert.deepEqual(evaluated, [])
  }
  assert.ok(pending.every(read => read.signal.aborted)); await gate.set("rootC", false); controller.modeChanged("rootC")
  for (let cycle = 0; cycle < 20; cycle++) {
    controller.reconcile(requests, controller.revision); await settle(); t.mock.timers.tick(5000); await settle()
    assert.equal(pending.length, 2); assert.equal(actual, 2)
  }
  if (outcome === "resolve") pending[0]!.value.resolve(true); else pending[0]!.value.reject(Error("late store failure"))
  await settle()
  for (let cycle = 0; cycle < 5; cycle++) {
    controller.reconcile(requests, controller.revision); await settle(); t.mock.timers.tick(5000); await settle()
    assert.equal(pending.length, 2); assert.equal(actual, 2, "settlement still owns its physical cleanup")
  }
  pending[0]!.cleanup.resolve(); await settle(); assert.equal(actual, 1); assert.equal(gate.enabled("rootA"), false)
  controller.reconcile(requests, controller.revision); await settle()
  assert.equal(pending.length, 3); assert.equal(pending[2]!.root, "rootA"); assert.equal(actual, 2)
  available = true; pending[2]!.value.resolve(true); pending[2]!.cleanup.resolve(); await settle()
  assert.deepEqual(evaluated.toSorted(), ["a-first", "a-second"])
  for (let cycle = 0; cycle < 12; cycle++) {
    controller.reconcile(requests, controller.revision); await settle(); assert.equal(actual, 1)
  }
  assert.equal(readCalls.get("rootC"), undefined); assert.equal(controller.views.find(v => v.request.id === "c-disabled")?.status, "suspended")
  pending[1]!.value.resolve(true); pending[1]!.cleanup.resolve(); await settle(); assert.equal(gate.enabled("rootB"), false)
  controller.reconcile(requests, controller.revision); await settle()
  assert.deepEqual(evaluated.toSorted(), requests.filter(req => req.id !== "c-disabled").map(req => req.id).toSorted())
  assert.equal(readCalls.get("rootA"), 2); assert.equal(readCalls.get("rootB"), 2)
  assert.equal(actual, 0); assert.equal(maximum, 2); assert.equal(maximumPerRoot, 1)
})

for (const stage of ["countdown", "checking", "failed", "allowing"] as const) test(`${stage} tombstone survives unavailable mode loading and a fresh review`, async t => {
  const gate = modes(), read = deferred<HostRequest[]>(), ack = deferred<{ status: "uncertain" }>()
  let unavailable = false, reads = 0, writes = 0
  const controller = new Controller(async () => safe, () => {}, { ...options,
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true }, approvalReady: () => true,
    clock: { now: () => 0, after: () => () => {} }, nativeApproval: {
      list: () => ++reads === 1 && stage === "checking" ? read.promise : Promise.resolve([request("a")]),
      once: async (_req, _signal, dispatch) => {
        if (!dispatch()) return { status: "unavailable" }; writes++
        if (stage === "failed") throw Error("uncertain invoked write")
        return ack.promise
      },
    }, modes: { root: (id, signal) => gate.root(id, signal),
      load: (root, signal) => unavailable ? Promise.reject(Error("mode unavailable")) : gate.load(root, signal),
      enabled: root => gate.enabled(root) },
  })
  t.after(async () => { read.resolve([request("a")]); ack.resolve({ status: "uncertain" }); await controller.dispose() })
  controller.asked(request("a")); await settle()
  const attempt = stage === "countdown" ? Promise.resolve() : controller.approveNow("a")
  await settle(); assert.equal(controller.views[0]?.autoApproval?.status, stage)
  await gate.set("root", false); controller.modeChanged("root"); await gate.set("root", true); controller.modeChanged("root")
  unavailable = true; controller.reconcile([request("a")], controller.revision); await settle(); assert.equal(controller.views[0]?.status, "suspended")
  unavailable = false; controller.reconcile([request("a")], controller.revision); await settle()
  controller.refreshApprovalEligibility(); await controller.approveNow("a")
  assert.equal(writes, stage === "failed" || stage === "allowing" ? 1 : 0)
  assert.equal(controller.views[0]?.autoApproval?.status, stage === "failed" || stage === "allowing" ? "failed" : "cancelled")
  read.resolve([request("a")]); ack.resolve({ status: "uncertain" }); await attempt
  controller.permissionReplied({ sessionID: "root", requestID: "a", decision: "reject" }); controller.asked(request("a")); await settle()
  assert.equal(controller.views[0]?.autoApproval?.status, "countdown", "exact native resolution clears the previous tombstone")
})
