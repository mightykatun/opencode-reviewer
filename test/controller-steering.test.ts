import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, type ApprovalFact, type NativeApproval } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { ReviewProgress, ReviewResult } from "../src/types.js"
import { steeringMessage } from "../src/steering.js"

const make = (id: string, sessionID = "root"): HostRequest => Object.freeze({ id, sessionID, action: "shell", resources: Object.freeze(["rm -rf build"]),
  source: Object.freeze({ assistantID: "assistant", id: `call-${id}` }) })
const steered: ReviewResult = { safe: false, reason: "Deletes the whole build tree.", steering: "Please remove only build/cache.", desc: "Removes everything." }
const message = steeringMessage(steered.reason!, steered.steering!)

function fixture(options: { result?: ReviewResult; autoApprove?: boolean; steering?: boolean; fast?: boolean; cap?: number; reject?: boolean } = {}) {
  const writes: { kind: string; id: string; message?: string }[] = []
  const facts: ApprovalFact<HostRequest>[] = []
  let pending: HostRequest[] = []
  let front: (root: string) => string | undefined = () => pending[0]?.id
  const streams = new Map<string, (progress: ReviewProgress) => void>()
  const finals = new Map<string, (result: ReviewResult) => void>()
  const approval: NativeApproval<HostRequest> = {
    list: async () => pending,
    async once(value, _signal, dispatch) { if (!dispatch()) return { status: "unavailable" }; writes.push({ kind: "once", id: value.id }); return { status: "submitted" } },
    ...(options.reject === false ? {} : { async reject(value: HostRequest, _signal: AbortSignal, dispatch: () => boolean, text: string) {
      if (!dispatch()) return { status: "unavailable" as const }
      writes.push({ kind: "reject", id: value.id, message: text }); return { status: "submitted" as const }
    } }),
  }
  const controller = new Controller<HostRequest>(async (value, _signal, identified, progress) => {
    identified()
    if (!options.fast) return options.result ?? steered
    streams.set(value.id, progress)
    progress({ attempt: 0, phase: "evaluating" })
    return new Promise<ReviewResult>(resolve => finals.set(value.id, resolve))
  }, () => {}, { nativeApproval: approval, candidate: () => true, nativeFront: root => front(root),
    approvalReady: () => true, modes: { root: async () => "root", load: async () => {}, enabled: () => true },
    clock: { now: () => 0, after: () => () => {} },
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: options.autoApprove ?? false, autoRejectSteering: options.steering ?? true,
      maxSteeringRejections: options.cap ?? 1, fastMode: options.fast ?? false, stream: true, autoApproveDelaySeconds: 15 },
    onApproval: fact => { facts.push(fact) },
  })
  return {
    controller, writes, facts,
    async ask(request: HostRequest) { pending = [...pending, request]; controller.asked(request); await settle(); await settle() },
    view: (id: string) => controller.views.find(view => view.request.id === id),
    reply(request: HostRequest, decision: string) {
      pending = pending.filter(value => value.id !== request.id)
      controller.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision })
    },
    stream: (id: string, progress: ReviewProgress) => streams.get(id)!(progress),
    finish: (id: string, result: ReviewResult) => finals.get(id)!(result),
    front(value: (root: string) => string | undefined) { front = value },
  }
}

test("Unsafe steering arms the shared countdown, rejects natively with the exact message and confirms only on reject", async t => {
  const f = fixture()
  t.after(() => f.controller.dispose())
  const request = make("a")
  await f.ask(request)
  assert.equal(f.view("a")?.autoApproval?.status, "countdown")
  assert.equal(f.view("a")?.autoDecision, "reject")
  assert.equal(f.view("a")?.steering, steered.steering)
  assert.equal(f.view("a")?.steerable, true, "notifications stay silent while a rejection can still run")
  const work = f.controller.approveNow("a", true)
  await settle(); await settle()
  assert.deepEqual(f.writes, [{ kind: "reject", id: "a", message }])
  assert.equal(message, "Rejected by opencode-reviewer: Deletes the whole build tree. Please remove only build/cache.")
  assert.equal(f.view("a")?.autoApproval?.status, "allowing")
  f.reply(request, "reject"); await work; await settle()
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.decision, fact.steering]),
    [["dispatched", "reject", steered.steering], ["confirmed", "reject", steered.steering], ["settled", "reject", steered.steering]])
})

test("the per-session cap stops consecutive rejections until an approval in that session resets it", async t => {
  const f = fixture()
  t.after(() => f.controller.dispose())
  const first = make("first"), second = make("second"), third = make("third"), other = make("other", "child")
  await f.ask(first)
  const work = f.controller.approveNow("first", true); await settle(); await settle()
  f.reply(first, "reject"); await work
  await f.ask(second)
  assert.equal(f.view("second")?.autoApproval, undefined, "cap reached: plain Unsafe waits with no status")
  assert.equal(f.view("second")?.autoDecision, undefined)
  assert.equal(f.view("second")?.steering, undefined, "steering is hidden unless armed or sent")
  assert.equal(f.view("second")?.steerable, undefined, "cap reached: normal Unsafe attention")
  f.front(() => "other")
  await f.ask(other)
  assert.equal(f.view("other")?.autoDecision, "reject", "another session has its own counter")
  f.reply(other, "reject")
  f.front(() => "third")
  f.reply(second, "once")
  await f.ask(third)
  assert.equal(f.view("third")?.autoDecision, "reject", "an approval in the session resets the run")
})

test("no steering, no reject transport, a disabled option or a Safe rating never arms a rejection", async t => {
  for (const [name, options] of [
    ["no steering", { result: { safe: false, reason: "r", desc: "d" } }],
    ["disabled", { steering: false }],
    ["no reject transport", { reject: false }],
    ["safe without autoApprove", { result: { safe: true, reason: "r", desc: "d" } }],
  ] as const) {
    const f = fixture(options)
    await f.ask(make("a"))
    assert.equal(f.view("a")?.autoApproval, undefined, name)
    assert.equal(f.view("a")?.autoDecision, undefined, name)
    await f.controller.approveNow("a", true)
    assert.deepEqual(f.writes, [], name)
    await f.controller.dispose()
  }
  const f = fixture({ autoApprove: true, result: { safe: true, reason: "r", desc: "d" } })
  t.after(() => f.controller.dispose())
  await f.ask(make("a"))
  assert.equal(f.view("a")?.autoDecision, "once", "Safe still approves with steering on")
})

test("Cancel tombstones an armed rejection and the native queue front gates it", async t => {
  const f = fixture()
  t.after(() => f.controller.dispose())
  f.front(() => undefined)
  await f.ask(make("a"))
  assert.equal(f.view("a")?.autoApproval, undefined, "not the native front: nothing armed")
  f.front(() => "a")
  f.controller.refreshApprovalEligibility()
  assert.equal(f.view("a")?.autoApproval?.status, "countdown")
  f.controller.cancelAutoApproval("a")
  assert.equal(f.view("a")?.autoApproval?.status, "cancelled")
  await f.controller.approveNow("a", true)
  f.controller.refreshApprovalEligibility()
  assert.deepEqual(f.writes, [])
})

test("fast mode rejects once reason and steering are closed in the preview, before desc completes", async t => {
  const f = fixture({ fast: true })
  t.after(() => f.controller.dispose())
  await f.ask(make("a"))
  f.stream("a", { attempt: 0, phase: "streaming", preview: { safe: false, reason: "Too broad.", reasonComplete: true, steering: "Please narr" } })
  await settle()
  assert.deepEqual(f.writes, [], "an unfinished steering string never rejects")
  assert.equal(f.view("a")?.autoApproval, undefined)
  f.stream("a", { attempt: 0, phase: "streaming", preview: { safe: false, reason: "Too broad.", reasonComplete: true,
    steering: "Please narrow it.", steeringComplete: true, desc: "Partial" } })
  for (let i = 0; i < 6; i++) await settle()
  assert.deepEqual(f.writes, [{ kind: "reject", id: "a", message: "Rejected by opencode-reviewer: Too broad. Please narrow it." }])
  assert.equal(f.view("a")?.retained, true, "the report keeps running after a fast rejection")
  f.reply(make("a"), "reject"); await settle(); await settle()
  assert.equal(f.view("a")?.autoApproval?.status, "approved")
  assert.equal(f.view("a")?.autoDecision, "reject")
  f.finish("a", { safe: false, reason: "Too broad.", steering: "Please narrow it.", desc: "Full report." }); await settle(); await settle()
  assert.equal(f.view("a"), undefined, "the retained report ends after completion")
})
