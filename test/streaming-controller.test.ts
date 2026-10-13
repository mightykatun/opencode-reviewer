import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import type { HostRequest } from "../src/host-types.js"
import { Controller, displayText, visibleReview, type ApprovalClock } from "../src/controller.js"
import type { ReviewProgress, ReviewResult } from "../src/types.js"
import { SessionModes } from "../src/session-mode.js"

const request: HostRequest = { id: "a", sessionID: "root", action: "shell", resources: ["fixture"] }
const final: ReviewResult = { safe: true, desc: "Final report" }
class Clock implements ApprovalClock {
  nowMs = 0
  jobs = new Set<{ due: number; callback: () => void }>()
  now() { return this.nowMs }
  after(ms: number, callback: () => void) {
    const job = { due: this.nowMs + ms, callback }
    this.jobs.add(job)
    return () => { this.jobs.delete(job) }
  }
  dequeue(ms: number) {
    this.nowMs += ms
    const jobs = [...this.jobs].filter((job) => job.due <= this.nowMs)
    for (const job of jobs) this.jobs.delete(job)
    return jobs.map((job) => job.callback)
  }
  jump(ms: number) { for (const run of this.dequeue(ms)) run() }
}

async function fixture(options: { stream?: boolean; identify?: boolean; modes?: SessionModes } = {}) {
  const clock = new Clock()
  const workers: { progress: (progress: ReviewProgress) => void; identify: () => void; signal: AbortSignal;
    finish: (value: ReviewResult | null) => void; fail: (error: Error) => void }[] = []
  let publications = 0, writes = 0, reads = 0
  const controller = new Controller((_, signal, identify, progress) => new Promise((finish, fail) => {
    workers.push({ progress, identify, signal, finish, fail })
    if (options.identify !== false) identify()
  }), () => { publications++ }, { candidate: () => true, approvalReady: () => true, nativeFront: () => request.id,
  reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, stream: options.stream ?? true }, nativeApproval: {
    list: async () => { reads++; return [request] }, once: async (_request, _signal, dispatch) => {
      if (!dispatch()) return { status: "unavailable" }; writes++
      controller.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
      return { status: "submitted" }
    },
  }, clock, modes: options.modes })
  controller.asked(request)
  await settle()
  const view = () => controller.views[0]
  return { controller, clock, workers, view, counts: () => ({ publications, reads, writes }),
    dispose: async () => { const disposal = controller.dispose(); for (const worker of workers) worker.finish(null); await disposal } }
}

test("rating is immediate, text is latest-only at 40ms, and previews never arm approval", async () => {
  const f = await fixture()
  const worker = f.workers[0]!
  worker.progress({ attempt: 0, phase: "evaluating" })
  worker.progress({ attempt: 0, phase: "streaming", preview: { safe: true, desc: "first" } })
  assert.equal(f.view()?.progress?.preview?.safe, true)
  assert.equal(f.view()?.progress?.preview?.desc, undefined)
  assert.equal(f.view()?.assessment, undefined)
  f.controller.refreshApprovalEligibility()
  await f.controller.approveNow("a")
  assert.equal(f.view()?.autoApproval, undefined)
  const before = f.counts().publications
  for (let i = 0; i < 100; i++) worker.progress({ attempt: 0, phase: "streaming", preview: { safe: true, desc: `chunk ${i}` } })
  assert.equal(f.clock.jobs.size, 1)
  assert.equal(f.counts().publications, before)
  f.clock.jump(39)
  assert.equal(f.view()?.progress?.preview?.desc, undefined)
  f.clock.jump(1)
  assert.equal(f.view()?.progress?.preview?.desc, "chunk 99")
  assert.equal(f.counts().publications, before + 1)
  f.clock.jump(60_000)
  assert.deepEqual({ reads: f.counts().reads, writes: f.counts().writes }, { reads: 0, writes: 0 })
  await f.dispose()
})

test("retry clears provisional fields immediately and defeats dequeued old chunks and old attempts", async () => {
  const f = await fixture()
  const progress = f.workers[0]!.progress
  progress({ attempt: 0, phase: "evaluating" })
  progress({ attempt: 0, phase: "streaming", preview: { safe: true, desc: "old" } })
  const queued = f.clock.dequeue(40)
  progress({ attempt: 1, phase: "retrying" })
  assert.deepEqual(f.view()?.progress, { attempt: 1, phase: "retrying" })
  const before = f.counts().publications
  queued[0]!()
  progress({ attempt: 0, phase: "streaming", preview: { safe: true, desc: "late old" } })
  progress({ attempt: 0, phase: "evaluating" })
  assert.equal(f.counts().publications, before)
  progress({ attempt: 1, phase: "streaming", preview: { safe: false, desc: "new" } })
  assert.equal(f.view()?.progress?.preview?.safe, false)
  assert.equal(f.view()?.progress?.preview?.desc, undefined)
  f.clock.jump(40)
  assert.equal(f.view()?.progress?.preview?.desc, "new")
  progress({ attempt: 1, phase: "retrying" })
  assert.equal(f.view()?.progress?.preview?.desc, "new", "duplicate start cannot erase current chunks")
  await f.dispose()
})

test("validated completion flushes full final text without waiting for preview timer or allowing late progress", async () => {
  const f = await fixture()
  const worker = f.workers[0]!
  worker.progress({ attempt: 0, phase: "evaluating" })
  worker.progress({ attempt: 0, phase: "streaming", preview: { safe: true, desc: "pending" } })
  const queued = f.clock.dequeue(40)
  worker.finish(final)
  await settle()
  assert.equal(f.view()?.assessment, final)
  assert.equal(f.view()?.progress, undefined)
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 15 })
  const before = f.counts().publications
  queued[0]!()
  worker.progress({ attempt: 1, phase: "retrying" })
  assert.equal(f.counts().publications, before)
  f.controller.refreshApprovalEligibility()
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 15 })
  f.clock.jump(15_199)
  assert.equal(f.counts().writes, 0)
  f.clock.jump(1)
  await settle()
  assert.equal(f.counts().writes, 1)
  await f.dispose()
})

test("failed assessment removes preview and queued text without retaining a fabricated rating", async () => {
  const f = await fixture()
  const worker = f.workers[0]!
  worker.progress({ attempt: 0, phase: "evaluating" })
  worker.progress({ attempt: 0, phase: "streaming", preview: final })
  const queued = f.clock.dequeue(40)
  worker.fail(new Error("incomplete stream"))
  await settle()
  queued[0]!()
  assert.equal(f.view()?.status, "unavailable")
  assert.equal(f.view()?.assessment, undefined)
  assert.equal(f.view()?.progress, undefined)
  assert.equal(f.clock.jobs.size, 0)
  await f.dispose()
})

for (const action of ["reply", "delete", "dispose", "disable"] as const) test(`${action} defeats queued text, late progress and completion`, async () => {
  const modes = new SessionModes({ read: async () => true, write: async () => {}, flush: async () => {} }, async (id) => ({ id }))
  const f = await fixture({ modes })
  const worker = f.workers[0]!
  worker.progress({ attempt: 0, phase: "evaluating" })
  worker.progress({ attempt: 0, phase: "streaming", preview: final })
  const queued = f.clock.dequeue(40)
  if (action === "reply") f.controller.replied("a")
  if (action === "delete") f.controller.deleted("root")
  if (action === "dispose") void f.controller.dispose()
  if (action === "disable") { const write = modes.set("root", false); f.controller.modeChanged("root"); await write }
  assert.ok(worker.signal.aborted)
  const before = f.counts().publications
  queued[0]!()
  worker.progress({ attempt: 1, phase: "retrying" })
  worker.progress({ attempt: 1, phase: "streaming", preview: final })
  worker.finish(final)
  await settle()
  assert.equal(f.counts().publications, before)
  assert.equal(f.clock.jobs.size, 0)
  assert.equal(visibleReview(f.controller.views, "root", (id) => ({ id })), undefined)
  await f.dispose()
})

test("fresh enabled entry rejects prior entry callbacks even with the same attempt and request ID", async () => {
  const modes = new SessionModes({ read: async () => true, write: async () => {}, flush: async () => {} }, async (id) => ({ id }))
  const f = await fixture({ modes })
  const old = f.workers[0]!
  old.progress({ attempt: 0, phase: "evaluating" })
  old.progress({ attempt: 0, phase: "streaming", preview: final })
  const queued = f.clock.dequeue(40)
  await modes.set("root", false); f.controller.modeChanged("root")
  await modes.set("root", true); f.controller.modeChanged("root")
  f.controller.reconcile([request], f.controller.revision)
  await settle()
  const fresh = f.workers[1]!
  fresh.progress({ attempt: 0, phase: "evaluating" })
  old.progress({ attempt: 1, phase: "retrying" }); old.finish(final); queued[0]!()
  await settle()
  assert.deepEqual(f.view()?.progress, { attempt: 0, phase: "evaluating" })
  assert.equal(f.view()?.assessment, undefined)
  fresh.progress({ attempt: 0, phase: "streaming", preview: { safe: false, desc: "fresh" } })
  f.clock.jump(40)
  assert.equal(f.view()?.progress?.preview?.desc, "fresh")
  await f.dispose()
})

test("root mode is checked again when coalesced text is delivered", async () => {
  const modes = new SessionModes({ read: async () => true, write: async () => {}, flush: async () => {} }, async (id) => ({ id }))
  const f = await fixture({ modes })
  f.workers[0]!.progress({ attempt: 0, phase: "evaluating" })
  f.workers[0]!.progress({ attempt: 0, phase: "streaming", preview: { desc: "queued" } })
  await modes.set("root", false)
  f.clock.jump(40)
  assert.equal(f.view()?.progress?.preview, undefined)
  await f.dispose()
})

test("disabled streaming still reports evaluating/retrying but cannot display previews", async () => {
  const f = await fixture({ stream: false })
  const progress = f.workers[0]!.progress
  progress({ attempt: 0, phase: "evaluating" })
  progress({ attempt: 0, phase: "streaming", preview: final })
  progress({ attempt: 1, phase: "retrying" })
  assert.deepEqual(f.view()?.progress, { attempt: 1, phase: "retrying" })
  assert.equal(f.clock.jobs.size, 0)
  await f.dispose()
})

test("progress cannot identify a permission or create a newer attempt without its start", async () => {
  const f = await fixture({ identify: false })
  const worker = f.workers[0]!
  worker.progress({ attempt: 0, phase: "evaluating" })
  assert.equal(f.view()?.progress, undefined)
  worker.identify()
  for (const attempt of [-1, NaN, 0.5, 2]) worker.progress({ attempt, phase: "evaluating" })
  worker.progress({ attempt: 0, phase: "streaming", preview: final })
  assert.equal(f.view()?.progress, undefined)
  worker.progress({ attempt: 0, phase: "evaluating" })
  worker.progress({ attempt: 3, phase: "streaming", preview: final })
  assert.deepEqual(f.view()?.progress, { attempt: 0, phase: "evaluating" })
  await f.dispose()
})

test("prefixes are copied, absence clears queued fields, and displayed controls/bidi remain escaped", async () => {
  const f = await fixture()
  const progress = f.workers[0]!.progress
  progress({ attempt: 0, phase: "evaluating" })
  const preview = { safe: true, desc: "`\x1b[2J\u202e`\nnext" }
  progress({ attempt: 0, phase: "streaming", preview })
  preview.desc = "mutated"
  f.clock.jump(40)
  assert.equal(displayText(f.view()!.progress!.preview!.desc!), "`\\u001b[2J\\u202e`\nnext")
  progress({ attempt: 0, phase: "streaming", preview: final })
  const queued = f.clock.dequeue(40)
  progress({ attempt: 0, phase: "streaming" })
  queued[0]!()
  assert.deepEqual(f.view()?.progress, { attempt: 0, phase: "streaming" })
  await f.dispose()
})
