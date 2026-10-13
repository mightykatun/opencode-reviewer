import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, type ApprovalFact, type NativeApproval, type ReviewLifecycleFact } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { OnceSubmission } from "../src/host-permissions.js"
import type { ApprovalPresentation } from "../src/route-approval.js"
import type { ReviewResult } from "../src/types.js"

const request: HostRequest = Object.freeze({ id: "request", sessionID: "root", action: "shell", resources: Object.freeze(["pwd"]),
  source: Object.freeze({ assistantID: "assistant", id: "call" }) })
const safe: ReviewResult = { safe: true, desc: "Reads the current directory." }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(fast = false, held: { preparation?: boolean; acknowledgement?: boolean; unavailable?: boolean } = {}) {
  const preparation = deferred<void>(), acknowledgement = deferred<OnceSubmission>(), assessment = deferred<ReviewResult>()
  if (!held.preparation) preparation.resolve()
  if (!held.acknowledgement) acknowledgement.resolve({ status: "submitted" })
  let proof: ApprovalPresentation = { state: "visible", id: request.id }, front: string | undefined = request.id
  let enabled = true, writes = 0, preparations = 0, reviewSignal!: AbortSignal
  let insideReply: (() => void) | undefined
  let pending: HostRequest[] = [request]
  const facts: ApprovalFact<HostRequest>[] = [], lifecycle: ReviewLifecycleFact<HostRequest>[] = []
  const approval: NativeApproval<HostRequest> = {
    list: async () => pending,
    visibleID: () => proof.state === "visible" ? proof.id : undefined,
    presentation: () => proof,
    async once(value, signal, dispatch) {
      assert.equal(value, request, "host closure receives the admitted native request, not a V1 projection")
      preparations++
      await preparation.promise
      if (held.unavailable || signal.aborted) return { status: "unavailable" }
      if (!dispatch()) return { status: "unavailable" }
      writes++
      insideReply?.()
      return acknowledgement.promise
    },
  }
  const controller = new Controller<HostRequest>(async (_value, signal, identified, progress) => {
    reviewSignal = signal; identified()
    if (!fast) return safe
    progress({ attempt: 0, phase: "evaluating" })
    progress({ attempt: 0, phase: "streaming", preview: safe })
    return assessment.promise
  }, () => {}, { nativeApproval: approval, candidate: () => true, nativeFront: () => front,
    // Native approval never inherits the historical hidden-route exception.
    allowHiddenRoute: true,
    modes: { root: async () => "root", load: async () => {}, enabled: () => enabled },
    clock: { now: () => 0, after: () => () => {} },
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode: fast, stream: true, autoApproveDelaySeconds: 15 },
    onApproval: fact => { facts.push(fact) }, onLifecycle: fact => { lifecycle.push(fact) },
  })
  controller.asked(request); await settle()
  return { controller, facts, lifecycle, preparation, acknowledgement, assessment,
    start() { controller.presented(proof); return fast ? Promise.resolve() : controller.approveNow(request.id, true) },
    reply(decision = "once", sessionID = request.sessionID, requestID = request.id) {
      if (sessionID === request.sessionID && requestID === request.id) pending = []
      controller.permissionReplied({ sessionID, requestID, decision })
    },
    view: () => controller.views[0], writes: () => writes, preparations: () => preparations, signal: () => reviewSignal,
    proof(value: ApprovalPresentation) { proof = value; controller.presented(value) },
    front(value: string | undefined) { front = value },
    disable() { enabled = false; controller.modeChanged("root") },
    insideReply(value: () => void) { insideReply = value },
    async dispose() {
      preparation.resolve(); acknowledgement.resolve({ status: "uncertain" }); assessment.resolve(safe)
      await controller.dispose()
    },
  }
}

for (const fast of [false, true]) {
  const mode = fast ? "fast" : "normal"
  test(`${mode}: submitted acknowledgement alone is not confirmation; exact once event confirms`, async t => {
    const f = await fixture(fast); t.after(() => f.dispose())
    const attempt = f.start(); await settle()
    assert.equal(f.writes(), 1)
    assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched"])
    assert.equal(f.view()?.autoApproval?.status, "allowing")
    f.reply("once", "another-session"); f.reply("once", "root", "another-request"); await settle()
    assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched"])
    f.reply(); await attempt; await settle()
    assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
    assert.ok(f.facts.every(fact => fact.request === request && fact.automatic && fact.approval === f.facts[0]!.approval))
    if (fast) {
      assert.equal(f.view()?.retained, true)
      assert.equal(f.view()?.autoApproval?.status, "approved")
      assert.equal(f.controller.pendingViews.length, 0)
      f.assessment.resolve(safe); await settle()
    }
    assert.equal(f.controller.views.length, 0)
  })

  test(`${mode}: reply inside actual native invocation waits for local ack and keeps fast remainder alive`, async t => {
    const f = await fixture(fast, { acknowledgement: true }); t.after(() => f.dispose())
    f.insideReply(() => f.reply())
    const attempt = f.start(); await settle()
    assert.equal(f.writes(), 1)
    assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched"])
    if (fast) {
      assert.equal(f.signal().aborted, false)
      assert.equal(f.view()?.retained, true)
      assert.equal(f.view()?.resolved, true)
      f.disable(); f.proof({ state: "lost" })
      assert.equal(f.signal().aborted, false)
      f.assessment.resolve(safe); await settle()
      assert.equal(f.view()?.status, "complete", "completion before ack is retained too")
    }
    f.acknowledgement.resolve({ status: "submitted" }); await attempt; await settle()
    assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
    assert.equal(f.controller.views.length, 0)
  })

  test(`${mode}: unavailable preparation has no dispatch, retention, confirmation or retry tombstone`, async t => {
    const f = await fixture(fast, { unavailable: true }); t.after(() => f.dispose())
    await f.start(); await settle()
    assert.equal(f.writes(), 0)
    assert.equal(f.view()?.retained, undefined)
    assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"]])
    f.controller.presented(request.id); await f.controller.approveNow(request.id, true); await settle()
    assert.equal(f.preparations(), 1, "unavailable waits for reconciliation, not a repeated frame/write loop")
    // An external once event does not supply attribution for an unavailable write.
    f.reply(); await settle()
    assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0)
  })

  for (const guard of ["presentation", "priority", "identity", "cancel", "mode"] as const) {
    test(`${mode}: ${guard} loss during native preparation blocks actual invocation`, async t => {
      const f = await fixture(fast, { preparation: true }); t.after(() => f.dispose())
      const attempt = f.start(); await settle()
      assert.equal(f.preparations(), 1)
      assert.equal(f.view()?.autoApproval?.status, "checking", "unsent native preparation must retain the Cancel controls")
      assert.equal(f.view()?.retained, undefined, "async preparation is not fast retention")
      assert.equal(f.facts.length, 0)
      if (guard === "presentation") f.proof({ state: "route-hidden", root: "root", id: request.id })
      if (guard === "priority") f.front("external-blocker")
      if (guard === "identity") f.controller.reconcile([{ ...request, source: { assistantID: "changed", id: "call" } }], f.controller.revision)
      if (guard === "cancel") f.controller.cancelAutoApproval(request.id)
      if (guard === "mode") f.disable()
      f.preparation.resolve(); await attempt; await settle()
      assert.equal(f.writes(), 0)
      assert.equal(f.view()?.retained, undefined)
      assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"]])
    })
  }

  test(`${mode}: uncertain ack never confirms or retries, including a subsequent external once`, async t => {
    const f = await fixture(fast, { acknowledgement: true }); t.after(() => f.dispose())
    const attempt = f.start(); await settle()
    assert.equal(f.writes(), 1)
    f.acknowledgement.resolve({ status: "uncertain" }); await attempt; await settle()
    assert.equal(f.view()?.autoApproval?.status, "failed")
    assert.equal(f.view()?.retained, undefined)
    assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["dispatched", undefined], ["settled", "uncertain"]])
    f.controller.reconcile([request], f.controller.revision); f.controller.presented(request.id)
    await f.controller.approveNow(request.id, true); await settle()
    assert.equal(f.writes(), 1)
    f.reply(); await settle()
    assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0)
  })

  test(`${mode}: early once event followed by uncertain ack is not an automatic approval`, async t => {
    const f = await fixture(fast, { acknowledgement: true }); t.after(() => f.dispose())
    f.insideReply(() => f.reply())
    const attempt = f.start(); await settle()
    if (fast) assert.equal(f.signal().aborted, false)
    f.acknowledgement.resolve({ status: "uncertain" }); await attempt; await settle()
    assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["dispatched", undefined], ["settled", "uncertain"]])
    assert.equal(f.controller.views.length, 0)
  })

  test(`${mode}: acknowledgement timeout cannot gain confirmation from a late successful ack/event`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = await fixture(fast, { acknowledgement: true }); t.after(() => f.dispose())
    const attempt = f.start(); await settle()
    assert.equal(f.writes(), 1)
    t.mock.timers.tick(5000); await attempt; await settle()
    assert.equal(f.view()?.autoApproval?.status, "failed")
    f.controller.reconcile([request], f.controller.revision); await settle()
    await f.start(); await settle()
    assert.equal(f.writes(), 1)
    f.reply(); f.acknowledgement.resolve({ status: "submitted" }); await settle()
    assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0)
  })

  test(`${mode}: unavailable preparation can recover only after fresh reconciliation`, async t => {
    const held = { unavailable: true }
    const f = await fixture(fast, held); t.after(() => f.dispose())
    await f.start(); await settle()
    assert.equal(f.writes(), 0)
    held.unavailable = false
    f.controller.reconcile([request], f.controller.revision)
    const attempt = f.start(); await settle()
    assert.equal(f.writes(), 1, "unavailable never installed the once-only dispatch tombstone")
    f.reply(); await attempt; await settle()
    assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 1)
  })

  test(`${mode}: read-only disappearance cannot replace an exact native reply event`, async t => {
    const f = await fixture(fast); t.after(() => f.dispose())
    const attempt = f.start(); await settle()
    f.controller.reconcile([], f.controller.revision); await settle()
    assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched"])
    f.reply("once", "wrong-session"); await settle()
    assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched"])
    if (fast) assert.equal(f.signal().aborted, false)
    f.reply(); await attempt; await settle()
    assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 1)
  })

  test(`${mode}: non-once resolution and external resolution before dispatch cannot confirm`, async t => {
    const f = await fixture(fast, { preparation: true }); t.after(() => f.dispose())
    const attempt = f.start(); await settle()
    f.reply(); f.preparation.resolve(); await attempt; await settle()
    assert.equal(f.writes(), 0)
    assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"]])

    const other = await fixture(fast); t.after(() => other.dispose())
    const otherAttempt = other.start(); await settle()
    other.reply("reject"); await otherAttempt; await settle()
    assert.equal(other.facts.filter(fact => fact.type === "confirmed").length, 0)
    assert.equal(other.facts.at(-1)?.result, "uncertain")
  })
}

test("native Allowing publication happens after actual invocation, never during cancellable preparation", async t => {
  const preparation = deferred<void>(), acknowledgement = deferred<OnceSubmission>()
  let calls = 0
  const publications: { status: string | undefined; calls: number }[] = []
  const controller = new Controller<HostRequest>(async () => safe, views => {
    publications.push({ status: views[0]?.autoApproval?.status, calls })
  }, { candidate: () => true, allowHiddenRoute: false,
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 15 },
    clock: { now: () => 0, after: () => () => {} }, nativeApproval: {
      visibleID: () => request.id, list: async () => [request],
      async once(_request, signal, dispatch) {
        await preparation.promise
        if (signal.aborted || !dispatch()) return { status: "unavailable" }
        calls++
        return acknowledgement.promise
      },
    },
  })
  t.after(async () => { preparation.resolve(); acknowledgement.resolve({ status: "uncertain" }); await controller.dispose() })
  controller.asked(request); await settle(); controller.presented(request.id)
  const attempt = controller.approveNow(request.id, true); await settle()
  assert.equal(controller.views[0]?.autoApproval?.status, "checking")
  assert.equal(publications.some(value => value.status === "allowing"), false)
  preparation.resolve(); await settle()
  assert.equal(calls, 1)
  assert.ok(publications.filter(value => value.status === "allowing").every(value => value.calls === 1))
  assert.equal(controller.views[0]?.autoApproval?.status, "allowing")
  controller.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
  acknowledgement.resolve({ status: "submitted" }); await attempt
})

test("native dispatch tombstones survive read-only disappearance and reappearance", async t => {
  const f = await fixture(false, { acknowledgement: true }); t.after(() => f.dispose())
  const attempt = f.start(); await settle()
  f.acknowledgement.resolve({ status: "uncertain" }); await attempt; await settle()
  f.controller.reconcile([], f.controller.revision)
  f.reply("once", "wrong-session")
  f.controller.reconcile([request], f.controller.revision); await settle()
  assert.equal(f.view()?.autoApproval?.status, "failed")
  await f.start(); await settle()
  assert.equal(f.writes(), 1)
})

test("external once without a local invocation has no automatic attribution", async t => {
  const f = await fixture(); t.after(() => f.dispose())
  f.reply(); await settle()
  assert.deepEqual(f.facts, [])
  assert.equal(f.writes(), 0)
  assert.equal(f.controller.views.length, 0)
})
