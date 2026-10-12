import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller, visibleReview, type ApprovalClock } from "../src/controller.js"
import { conversationRoot, RouteHandoff, RouteSessions, routeCovered, type ApprovalPresentation, type RouteRegion, type SessionLocation } from "../src/route-approval.js"
import type { ReviewProgress, ReviewResult } from "../src/types.js"

const sessions = new Map<string, SessionLocation>([
  ["root", { id: "root" }], ["child", { id: "child", parentID: "root" }],
  ["sibling", { id: "sibling", parentID: "root" }], ["nested", { id: "nested", parentID: "child" }], ["other", { id: "other" }],
])
const get = (id: string) => sessions.get(id)
const request = (id = "b", sessionID = "root", permission = "bash"): PermissionRequest => ({ id, sessionID, permission, patterns: ["pwd"], always: [], metadata: { command: "pwd" } })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class Clock implements ApprovalClock {
  time = 0
  jobs = new Set<{ at: number; callback(): void }>()
  now() { return this.time }
  after(ms: number, callback: () => void) { const job = { at: this.time + ms, callback }; this.jobs.add(job); return () => { this.jobs.delete(job) } }
  jump(ms: number) {
    this.time += ms
    for (const job of [...this.jobs]) if (job.at <= this.time) { this.jobs.delete(job); job.callback() }
  }
}
function fixture(t: TestContext, options: { fastMode?: boolean; stream?: boolean; autoApproveDelaySeconds?: number } = {}) {
  let route = "root", physical: "visible" | "pending" | "lost" = "visible", blocked = false, enabled = true
  let pending: PermissionRequest[] = [], reads = 0
  const clock = new Clock(), writes: PermissionRequest[] = [], workers = new Map<string, {
    result: ReturnType<typeof deferred<ReviewResult>>; progress(p: ReviewProgress): void; signal: AbortSignal
  }>()
  let list = async () => structuredClone(pending), once = async (_req: PermissionRequest) => {}, allowing = () => {}
  const proof = (): ApprovalPresentation => {
    const root = conversationRoot(route, get), selected = visibleReview(controller.views, route, get)
    if (blocked || !root || !selected) return { state: "lost" }
    if (root !== route) return { state: "route-hidden", id: selected.request.id, root }
    return physical === "lost" ? { state: "lost" } : { state: physical, id: selected.request.id }
  }
  const controller = new Controller((req, signal, identify, progress) => {
    const result = deferred<ReviewResult>()
    workers.set(req.id, { result, progress, signal }); identify(); progress({ attempt: 0, phase: "evaluating" })
    signal.addEventListener("abort", () => result.reject(Error("aborted")), { once: true })
    return result.promise
  }, () => {
    if (controller.views.some(view => view.autoApproval?.status === "allowing")) allowing()
    // The app publishes route eligibility on review changes only when suppressed.
    if (route !== conversationRoot(route, get)) controller.presented(proof())
  }, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, stream: true, autoApproveDelaySeconds: 3, ...options },
    clock, session: get, modes: { root: async id => conversationRoot(id, get)!, load: async () => {}, enabled: () => enabled },
    approval: { visibleID: () => undefined, presentation: proof, list: () => { reads++; return list() },
      once: async req => { writes.push(req); await once(req); pending = pending.filter(p => p.id !== req.id) } } })
  t.after(() => controller.dispose())
  return { controller, clock, workers, writes, proof, reads: () => reads,
    add: async (req = request()) => { pending.push(req); controller.asked(req); await settle() },
    finish: async (id = "b", safe = true) => { workers.get(id)!.result.resolve({ safe, desc: "Fixture report" }); await settle() },
    rate: (safe = true, attempt = 0) => workers.get("b")!.progress({ attempt, phase: "streaming", preview: { safe } }),
    present: () => controller.presented(proof()),
    route: (value: string) => { route = value; controller.presented(proof()) },
    physical: (value: typeof physical) => { physical = value; controller.presented(proof()) },
    block: (value: boolean) => { blocked = value; controller.presented(proof()) },
    mode: (value: boolean) => { enabled = value; controller.modeChanged("root") },
    list: (value: typeof list) => { list = value }, once: (value: typeof once) => { once = value },
    allowing: (value: typeof allowing) => { allowing = value },
  }
}

test("root/child/sibling/nested navigation preserves the original countdown and one-time grace", async t => {
  const f = fixture(t)
  await f.add(); await f.finish(); f.present()
  f.clock.jump(1000); f.route("child"); f.clock.jump(1000); f.route("nested"); f.route("sibling")
  f.route("root"); f.physical("pending")
  assert.deepEqual(f.controller.views[0]?.autoApproval, { status: "countdown", seconds: 2 })
  f.physical("visible"); f.route("child"); f.clock.jump(1199); await settle()
  assert.equal(f.writes.length, 0)
  f.clock.jump(1); await settle()
  assert.equal(f.writes.length, 1); assert.equal(f.reads(), 1); assert.equal(f.workers.size, 1)
  f.route("root"); f.present(); f.clock.jump(5000); await settle()
  assert.equal(f.controller.views.length, 0); assert.equal(f.writes.length, 1)
})

for (const stream of [false, true]) for (const delay of [0, 3]) test(`normal completion already on a nested route: stream=${stream}, delay=${delay}`, async t => {
  const f = fixture(t, { stream, autoApproveDelaySeconds: delay })
  f.route("nested"); await f.add(); f.rate(); f.clock.jump(5000); await settle()
  assert.equal(f.writes.length, 0, "normal previews cannot approve")
  await f.finish()
  assert.deepEqual(f.controller.views[0]?.autoApproval, { status: "countdown", seconds: delay })
  if (delay) { f.clock.jump(3199); await settle(); assert.equal(f.writes.length, 0) }
  f.clock.jump(delay ? 1 : 0); await settle()
  assert.equal(f.writes.length, 1)
})

for (const stream of [false, true]) test(`fast same-root hidden approval retains mode-specific readiness: stream=${stream}`, async t => {
  const f = fixture(t, { fastMode: true, stream })
  f.route("child"); await f.add(); f.rate(false); await settle(); assert.equal(f.writes.length, 0)
  f.rate(); await settle()
  assert.equal(f.writes.length, stream ? 1 : 0)
  if (stream) {
    assert.equal(f.workers.get("b")!.signal.aborted, false)
    assert.equal(f.controller.views[0]?.autoApproval?.status, "approved")
    f.route("nested"); f.mode(false)
  }
  await f.finish(); await settle()
  assert.equal(f.writes.length, 1); assert.equal(f.controller.views.length, 0)
  assert.equal(f.clock.time, 0, "fast mode never falls back to a delay")
})

for (const fastMode of [false, true]) for (const boundary of ["read", "write"] as const)
  test(`same-root navigation at ${boundary} boundary does not cancel or duplicate: fast=${fastMode}`, async t => {
    const f = fixture(t, { fastMode, autoApproveDelaySeconds: 0 })
    const held = deferred<PermissionRequest[]>()
    f.list(() => held.promise)
    if (boundary === "write") f.allowing(() => queueMicrotask(() => f.route("nested")))
    f.once(async () => { assert.equal(f.proof().state, "route-hidden") })
    await f.add(); await f.finish(); f.present(); f.clock.jump(0); await settle()
    if (boundary === "read") f.route("nested")
    held.resolve([request()]); await settle()
    assert.equal(f.writes.length, 1)
  })

test("a rejected hidden fast preview waits for physical read settlement before using its replacement", async t => {
  const f = fixture(t, { fastMode: true }), held = deferred<PermissionRequest[]>()
  f.route("nested"); await f.add(); f.list(() => held.promise); f.rate(); await settle()
  f.workers.get("b")!.progress({ attempt: 1, phase: "retrying" })
  f.rate(false, 1); f.rate(true, 1); await settle()
  assert.equal(f.writes.length, 0); assert.equal(f.reads(), 1)
  f.list(async () => [request()]); held.resolve([request()]); await settle()
  assert.equal(f.writes.length, 1); assert.equal(f.reads(), 2)
  await f.finish()
})

test("same-ID argument changes while hidden fail approval before dispatch", async t => {
  const f = fixture(t, { autoApproveDelaySeconds: 0 })
  f.list(async () => [{ ...request(), metadata: { command: "changed" } }])
  f.route("child"); await f.add(); await f.finish(); f.clock.jump(0); await settle()
  f.route("root"); f.route("nested"); f.clock.jump(10000); await settle()
  assert.equal(f.writes.length, 0); assert.equal(f.controller.views[0]?.autoApproval?.status, "failed")
})

for (const fastMode of [false, true]) for (const loss of ["cover", "other", "unknown", "cancel", "disable", "delete"] as const)
  test(`route exception cannot bypass ${loss} or revive automation: fast=${fastMode}`, async t => {
    const f = fixture(t, { fastMode })
    await f.add(); await f.finish(); f.present(); f.route("nested")
    if (loss === "cover") f.block(true)
    if (loss === "other") f.route("other")
    if (loss === "unknown") f.route("missing")
    if (loss === "cancel") f.controller.cancelAutoApproval("b")
    if (loss === "disable") f.mode(false)
    if (loss === "delete") f.controller.deleted("root")
    f.block(false); f.route("child"); f.route("root"); f.present(); f.route("nested")
    f.clock.jump(10000); await settle()
    assert.equal(f.writes.length, 0)
    assert.ok(f.controller.views.length === 0 || ["cancelled", "suspended"].includes(f.controller.views[0]!.autoApproval?.status ?? f.controller.views[0]!.status))
  })

test("hidden native ordering includes disabled blockers but excludes deep-only permissions", async t => {
  const f = fixture(t, { autoApproveDelaySeconds: 0 })
  f.route("nested"); await f.add(request("a", "root", "read")); await f.add(); await f.finish()
  f.clock.jump(10000); await settle(); assert.equal(f.writes.length, 0)
  f.controller.replied("a"); f.list(async () => [request()]); f.clock.jump(0); await settle()
  assert.equal(f.writes.length, 1)
  await f.add(request("deep", "nested")); await f.finish("deep"); f.clock.jump(10000); await settle()
  assert.equal(f.writes.length, 1, "descendant browsing does not invent root native ownership")
})

test("uncertain hidden write remains manual across root/descendant navigation", async t => {
  const f = fixture(t, { autoApproveDelaySeconds: 0 })
  f.once(async () => { throw Error("uncertain") })
  f.route("child"); await f.add(); await f.finish(); f.clock.jump(0); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "failed")
  f.route("root"); f.present(); f.route("nested"); f.clock.jump(10000); await settle()
  assert.equal(f.writes.length, 1)
})

test("root ancestry is exact, bounded, cycle-safe and requires every public parent", () => {
  assert.equal(conversationRoot("nested", get), "root")
  assert.equal(conversationRoot("child", id => id === "child" ? get(id) : undefined), undefined)
  assert.equal(conversationRoot("child", () => ({ id: "wrong" })), undefined)
  assert.equal(conversationRoot("child", id => ({ id, parentID: id })), undefined)
  assert.equal(conversationRoot("0", id => ({ id, ...(Number(id) < 16 ? { parentID: String(Number(id) + 1) } : {}) })), "16")
  assert.equal(conversationRoot("0", id => ({ id, ...(Number(id) < 17 ? { parentID: String(Number(id) + 1) } : {}) })), undefined)
})

test("public session events bridge missing host route metadata but never conflicts or deletion", () => {
  const current = new Map<string, SessionLocation>([["root", { id: "root" }]])
  const metadata = new RouteSessions(id => current.get(id))
  metadata.remember({ id: "child", parentID: "root" }); metadata.remember({ id: "nested", parentID: "child" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), "root")
  current.set("child", { id: "child", parentID: "other" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), undefined)
  current.set("child", { id: "child", parentID: "root" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), "root")
  metadata.deleted("child")
  metadata.remember({ id: "child", parentID: "root" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), undefined)
})

test("root remount handoff defers to the next real frame and does not extend to other roots", () => {
  const proof = new RouteHandoff()
  proof.observe("nested", "root"); proof.observe("root", "root")
  assert.equal(proof.pending("root"), true)
  proof.observe("root", "root"); assert.equal(proof.pending("root"), true)
  proof.frame(); assert.equal(proof.pending("root"), false)
  proof.observe("nested", "root"); proof.observe("other", "other")
  assert.equal(proof.pending("other"), false)
})

test("native fullscreen coverage uses actual overflowing viewport layout, independently of report paint", () => {
  const region = (y: number, height: number, children: RouteRegion[] = []): RouteRegion => ({ x: 0, y, width: 160, height,
    visible: true, isDestroyed: false, getChildren: () => children })
  const permission = region(25, 15), frame = region(0, 40, [region(0, 40, [permission])])
  assert.equal(routeCovered(frame, 160, 40), false)
  const expanded = { ...region(1, 38), x: 2, width: 156 }
  permission.getChildren = () => [expanded]
  assert.equal(routeCovered(frame, 160, 40), true)
  permission.visible = false; assert.equal(routeCovered(frame, 160, 40), false)
})
