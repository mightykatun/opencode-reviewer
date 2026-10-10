import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller, type ApprovalClock, type View } from "../src/controller.js"
import { ReviewGeometryProof, type ReviewRegion } from "../src/review-geometry.js"
import { SidebarPresentation, type ReviewPresentation } from "../src/review-presentation.js"

const request: PermissionRequest = { id: "geometry", sessionID: "root", permission: "bash", patterns: ["pwd"], always: [], metadata: {} }
const region = (y: number, height: number): ReviewRegion => ({ x: 120, y, width: 38, height, visible: true, isDestroyed: false })
const layout = () => ({ width: 160, height: 40, fast: false, panel: { ...region(0, 40), x: 118, width: 42 },
  heading: region(1, 1), rating: region(3, 1), report: region(5, 29), footer: region(35, 3) })
class Clock implements ApprovalClock {
  value = 0
  jobs = new Set<{ at: number; run(): void }>()
  now() { return this.value }
  after(ms: number, run: () => void) {
    const job = { at: this.value + ms, run }; this.jobs.add(job)
    return () => { this.jobs.delete(job) }
  }
  advance(ms: number) {
    this.value += ms
    for (const job of [...this.jobs]) if (job.at <= this.value) { this.jobs.delete(job); job.run() }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function fixture(t: TestContext, fast = false, changed?: (views: View[]) => void) {
  const input = { ...layout(), fast }, geometry = new ReviewGeometryProof(), sidebar = new SidebarPresentation(), clock = new Clock()
  let owner = sidebar.mount("root", input.width), selected = true, dialog = false, covered = false, reads = 0, writes = 0
  let list = async () => [request]
  const proof = (frame = false): ReviewPresentation => {
    if (frame) sidebar.frame()
    const side = sidebar.state("root")
    if (!selected || dialog || side === "lost") return { state: "lost" }
    const state = geometry.state({ ...input, owner }, frame)
    if (state === "lost") return { state }
    if (state === "pending" || side === "pending") return { state: "pending", id: request.id }
    return covered ? { state: "lost" } : { state: "visible", id: request.id }
  }
  const controller = new Controller(async (_request, _signal, identified) => { identified(); return { safe: true, desc: "Requested pwd" } },
    views => changed?.(views), { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode: fast, autoApproveDelaySeconds: 2 },
      clock, approval: { presentation: () => proof(), visibleID: () => { throw Error("explicit proof must be authoritative") },
        list: () => { reads++; return list() }, once: async () => { writes++ } } })
  t.after(() => controller.dispose())
  controller.asked(request); await settle()
  const present = (frame = false) => controller.presented(proof(frame))
  const resize = (width: number) => { input.width = width; geometry.invalidate() }
  const paint = () => {
    const dx = input.width - input.panel.x - input.panel.width
    for (const item of [input.panel, input.heading, input.rating, input.report, input.footer]) item.x += dx
    present(true)
  }
  return { controller, input, geometry, sidebar, clock, present, resize, paint, proof,
    get reads() { return reads }, get writes() { return writes }, get view() { return controller.views[0] },
    list(value: typeof list) { list = value },
    release(hidden = false, session: string | undefined = "root") { sidebar.unmount(owner, session, input.width, hidden); present() },
    mount() { owner = sidebar.mount("root", input.width); present() },
    lose(kind: string) {
      if (kind === "dialog") dialog = true
      if (kind === "fullscreen") covered = true
      if (kind === "preemption") selected = false
      if (kind === "short") input.height = 8
      if (kind === "hide") sidebar.unmount(owner, "root", input.width, true)
    } }
}

for (const resume of [1500, 5000]) test(`RESIZE -> timer -> FRAME at ${resume}ms preserves the original deadline and grace`, async t => {
  const f = await fixture(t)
  f.paint(); f.clock.advance(1200)
  f.resize(161)
  f.clock.advance(resume - 1200)
  assert.equal(f.proof().state, "pending")
  f.present(); await settle()
  assert.equal(f.writes, 0); assert.equal(f.reads, 0)
  assert.equal(f.view?.autoApproval?.status, "countdown")
  f.paint()
  if (resume < 2200) {
    f.clock.advance(2199 - resume); await settle(); assert.equal(f.writes, 0)
    f.clock.advance(1)
  } else f.clock.advance(0)
  await settle()
  assert.equal(f.writes, 1, "renewal does not reset the two-second delay or its 200ms grace")
  assert.equal(f.reads, 1)
})

for (const fast of [false, true]) test(`post-list callback between resize and frame blocks ${fast ? "fast" : "normal"} dispatch`, async t => {
  const f = await fixture(t, fast), read = deferred<PermissionRequest[]>()
  f.list(() => read.promise); f.paint(); f.clock.advance(2200); await settle()
  assert.equal(f.reads, 1)
  f.resize(161); read.resolve([request]); await settle()
  assert.equal(f.writes, 0)
  assert.notEqual(f.view?.autoApproval?.status, "cancelled")
  for (let i = 0; i < 5; i++) { f.present(); f.clock.advance(1000) }
  assert.equal(f.reads, 1, "unproven effects/timers cannot spin verification")
  f.paint(); f.clock.advance(0); await settle()
  assert.equal(f.writes, 1); assert.equal(f.reads, 2, "renewed paint needs a fresh identical pending snapshot")
})

test("resize in deferred Allowing callback revokes the write and retains the original deadline", async t => {
  let resize: (() => void) | undefined
  const f = await fixture(t, false, views => {
    if (views[0]?.autoApproval?.status === "allowing" && resize) {
      const run = resize; resize = undefined; queueMicrotask(run)
    }
  })
  resize = () => f.resize(161)
  f.paint(); f.clock.advance(2200); await settle()
  assert.equal(f.writes, 0); assert.equal(f.reads, 1)
  assert.equal(f.view?.autoApproval?.status, "countdown")
  f.paint(); f.clock.advance(0); await settle()
  assert.equal(f.writes, 1); assert.equal(f.reads, 2)
})

test("explicit-open wide/overlay owner handoff waits for actual replacement paint in both directions", async t => {
  const f = await fixture(t)
  f.paint(); f.clock.advance(1000)
  for (const width of [120, 160]) {
    f.resize(width); f.release()
    assert.equal(f.proof().state, "pending")
    f.clock.advance(600); await settle(); assert.equal(f.writes, 0)
    f.mount()
    assert.equal(f.proof().state, "pending", "a new slot cannot inherit the old paint proof")
    f.paint()
    assert.equal(f.view?.autoApproval?.status, "countdown")
  }
  f.clock.advance(0); await settle()
  assert.equal(f.writes, 1)
})

test("default-auto narrow cleanup has no replacement: the next actual frame proves loss", async t => {
  const f = await fixture(t)
  f.paint(); f.resize(120); f.release()
  assert.equal(f.proof().state, "pending")
  f.clock.advance(3000); await settle(); assert.equal(f.writes, 0)
  f.paint()
  assert.equal(f.view?.autoApproval?.status, "cancelled")
  f.resize(160); f.mount(); f.paint(); f.clock.advance(5000); await settle()
  assert.equal(f.writes, 0)
})

for (const kind of ["hide", "short", "dialog", "fullscreen", "preemption"]) {
  test(`real ${kind} after paint renewal blocks fresh-list callback and stays manual`, async t => {
    const f = await fixture(t), held = deferred<PermissionRequest[]>()
    f.list(() => held.promise); f.paint(); f.clock.advance(2200); await settle()
    f.resize(161); f.paint(); f.lose(kind)
    held.resolve([request]); await settle()
    assert.equal(f.writes, 0); assert.equal(f.view?.autoApproval?.status, "cancelled")
    f.present(); f.clock.advance(10000); await settle(); assert.equal(f.writes, 0)
  })
}

test("explicit Cancel during unproven paint is durable", async t => {
  const f = await fixture(t)
  f.paint(); f.resize(161); f.controller.cancelAutoApproval(request.id)
  f.paint(); f.clock.advance(5000); await settle()
  assert.equal(f.writes, 0); assert.equal(f.view?.autoApproval?.status, "cancelled")
})

for (const kind of ["hide", "short", "dialog", "preemption"]) test(`pending renewed paint cannot defer proven ${kind}`, async t => {
  const f = await fixture(t)
  f.paint(); f.resize(161); f.present()
  assert.equal(f.proof().state, "pending")
  f.lose(kind); f.present()
  assert.equal(f.view?.autoApproval?.status, "cancelled", "loss cancels synchronously, without waiting for another frame")
  f.clock.advance(10000); await settle(); assert.equal(f.writes, 0)
})

test("a real fullscreen paint during resize cannot renew physical proof", async t => {
  const f = await fixture(t)
  f.paint(); f.resize(161); f.lose("fullscreen"); f.paint()
  assert.equal(f.view?.autoApproval?.status, "cancelled")
  f.clock.advance(10000); await settle(); assert.equal(f.writes, 0)
})

test("synchronous presentation publications keep one timer and the original expiry", async t => {
  let present: (() => void) | undefined
  const f = await fixture(t, false, () => present?.())
  present = () => f.present()
  f.paint()
  for (const ms of [200, 1000]) {
    f.clock.advance(ms)
    assert.equal(f.clock.jobs.size, 1)
  }
  f.resize(161); f.clock.advance(1000); await settle()
  assert.equal(f.writes, 0); assert.equal(f.clock.jobs.size, 0)
  f.paint(); f.clock.advance(0); await settle()
  assert.equal(f.writes, 1); assert.equal(f.clock.jobs.size, 0)
})
