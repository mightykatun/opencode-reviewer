import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller, type ApprovalClock, type ReviewLifecycleFact } from "../src/controller.js"
import { SessionModes, type ModeStore } from "../src/session-mode.js"
import { sessionModeCommands } from "../src/session-mode-commands.js"
import type { Assessment } from "../src/types.js"

const assessment: Assessment = { safe: true, desc: "Reads the requested fixture." }
const request: PermissionRequest = { id: "a", sessionID: "child", permission: "bash", patterns: ["cat fixture"],
  metadata: {}, always: [], tool: { callID: "call", messageID: "message" } }

class Clock implements ApprovalClock {
  private time = 0
  private jobs = new Set<{ due: number; callback: () => void }>()
  now() { return this.time }
  after(ms: number, callback: () => void) {
    const job = { due: this.time + ms, callback }
    this.jobs.add(job)
    return () => { this.jobs.delete(job) }
  }
  jump(ms: number) {
    this.time += ms
    for (const job of [...this.jobs]) if (job.due <= this.time) { this.jobs.delete(job); job.callback() }
  }
}

function fixture(t: TestContext, store: Partial<ModeStore> = {}, failApproval = false) {
  const modeWrites: boolean[] = [], approvalWrites: string[] = [], transitions: string[] = []
  const toasts: { message: string; variant: string }[] = [], facts: ReviewLifecycleFact[] = []
  const pending: { signal: AbortSignal; finish: (value: Assessment) => void }[] = []
  const modes = new SessionModes({ read: async () => true, flush: async () => {}, ...store,
    write: async (root, enabled) => { modeWrites.push(enabled); await store.write?.(root, enabled) } },
  async id => ({ id, ...(id === "child" ? { parentID: "root" } : {}) }))
  const clock = new Clock()
  const controller = new Controller((_request, signal, identified) => {
    identified()
    return new Promise(resolve => pending.push({ signal, finish: resolve }))
  }, () => {}, { modes, clock, reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 2 },
    approval: { visibleID: () => request.id, list: async () => [request], once: async req => {
      approvalWrites.push(req.id)
      if (failApproval) throw new Error("uncertain approval write")
    } },
    onLifecycle: fact => { facts.push(fact) } })
  let commands!: { run: () => Promise<void> }[]
  const lifecycle = new AbortController()
  const api = { route: { current: { name: "session", params: { sessionID: "child" } } }, lifecycle,
    ui: { toast: (value: typeof toasts[number]) => toasts.push(value) },
    keymap: { registerLayer: (layer: { commands: typeof commands }) => { commands = layer.commands; return () => {} } },
  } as unknown as TuiPluginApi
  sessionModeCommands(api, modes, root => {
    transitions.push(root)
    controller.modeChanged(root)
    // Match the production callback's fresh pending refresh after invalidation.
    controller.reconcile([request], controller.revision)
  })
  t.after(async () => {
    lifecycle.abort()
    for (const work of pending) work.finish(assessment)
    await controller.dispose()
  })
  const add = async () => { controller.asked(request); await settle() }
  const complete = async () => { pending.at(-1)!.finish(assessment); await settle() }
  return { controller, modes, clock, pending, modeWrites, approvalWrites, transitions, toasts, facts, add, complete,
    enable: () => commands[0]!.run(), disable: () => commands[1]!.run() }
}

for (const stage of ["evaluation", "complete", "countdown"] as const) {
  test(`registered repeated Enable preserves ${stage} and the original automatic approval`, async t => {
    const f = fixture(t)
    await f.add()
    if (stage !== "evaluation") await f.complete()
    if (stage === "countdown") { f.controller.presented(request.id); f.clock.jump(1000) }
    const before = f.controller.views[0], revision = f.controller.revision
    for (let i = 0; i < 3; i++) await f.enable()
    await settle()
    assert.equal(f.controller.views[0], before, "the live report is not discarded or replaced")
    assert.equal(f.controller.revision, revision, "unchanged mode must not invalidate pending snapshots")
    assert.deepEqual(f.transitions, [])
    assert.equal(f.pending.length, 1)
    assert.equal(f.pending[0]!.signal.aborted, false)
    assert.deepEqual(f.facts.filter(fact => fact.type === "cancelled"), [])
    if (stage === "evaluation") await f.complete()
    f.controller.presented(request.id)
    f.clock.jump(stage === "countdown" ? 1200 : 2200)
    await settle()
    assert.deepEqual(f.approvalWrites, [request.id], "unchanged Enable neither restarts the deadline nor adds a tombstone")
    assert.equal(f.pending.length, 1)
  })
}

test("registered Enable retries failed persistence without suspending or duplicating the newly enabled review", async t => {
  let fail = true
  const f = fixture(t, { read: async () => false, write: async () => { if (fail) throw new Error("private failure") } })
  await f.add()
  assert.equal(f.pending.length, 0)
  await f.enable()
  await settle()
  assert.equal(f.modes.enabled("root"), true)
  assert.equal(f.pending.length, 1)
  assert.match(f.toasts.at(-1)!.message, /enabled locally, but saving failed/)
  await f.complete()
  f.controller.presented(request.id)
  f.clock.jump(1000)
  const view = f.controller.views[0]
  fail = false
  await f.enable()
  assert.deepEqual(f.modeWrites, [true, true])
  assert.deepEqual(f.transitions, ["root"])
  assert.equal(f.controller.views[0], view)
  assert.equal(f.toasts.at(-1)!.message, "Reviewer enabled for this conversation.")
  assert.equal(f.toasts.at(-1)!.variant, "success")
  f.clock.jump(1200)
  await settle()
  assert.deepEqual(f.approvalWrites, [request.id])
  assert.equal(f.pending.length, 1)
})

test("registered Enable leaves failed saved-mode reads suspended until an explicit local disable", async t => {
  let reads = 0
  const f = fixture(t, { read: async () => { reads++; throw new Error("unreadable saved mode") } })
  await f.add()
  await f.enable(); await f.enable()
  assert.equal(f.controller.views[0]?.status, "suspended")
  assert.equal(f.modes.enabled("root"), false)
  assert.equal(f.pending.length, 0)
  assert.deepEqual(f.modeWrites, [])
  assert.deepEqual(f.transitions, [])
  assert.equal(reads, 3)
  assert.match(f.toasts.at(-1)!.message, /saved mode could not be read/)
  await f.disable()
  assert.deepEqual(f.transitions, ["root"])
  await f.enable(); await settle()
  assert.equal(reads, 3, "an explicit local mode switch replaces the unread saved choice")
  assert.equal(f.pending.length, 1)
  assert.deepEqual(f.modeWrites, [false, true])
})

for (const stage of ["countdown", "failed"] as const) {
  test(`registered disable/re-enable preserves the ${stage} approval tombstone`, async t => {
    const f = fixture(t, {}, stage === "failed")
    await f.add(); await f.complete()
    f.controller.presented(request.id)
    if (stage === "failed") {
      // A dispatched write with no acknowledgement must remain uncertain.
      await f.controller.approveNow(request.id)
      assert.equal(f.controller.views[0]?.autoApproval?.status, "failed")
    }
    await f.disable()
    assert.equal(f.controller.views[0]?.status, "suspended")
    assert.equal(f.pending[0]!.signal.aborted, true)
    await f.enable(); await settle(); await f.complete()
    await f.enable()
    f.controller.presented(request.id)
    await f.controller.approveNow(request.id)
    assert.deepEqual(f.transitions, ["root", "root"])
    assert.equal(f.pending.length, 2)
    assert.equal(f.controller.views[0]?.assessment, assessment)
    assert.equal(f.controller.views[0]?.autoApproval?.status, stage === "failed" ? "failed" : "cancelled")
    assert.deepEqual(f.approvalWrites, stage === "failed" ? [request.id] : [])
  })
}
