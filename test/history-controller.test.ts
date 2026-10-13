import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, type ReviewLifecycleFact, type ApprovalFact } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { ReviewResult } from "../src/types.js"

const request: HostRequest = { id: "permission", sessionID: "child", action: "bash", resources: [], save: [], metadata: {} }
const result: ReviewResult = { safe: true, desc: "report" }
const modes = { root: async () => "root", load: async () => {}, enabled: () => true }

test("accepted execution/root/timing and lifecycle reasons precede view clearing", async () => {
  const facts: ReviewLifecycleFact[] = [], ids: string[] = []
  let now = 100
  const c: Controller = new Controller(async (_req, _signal, identified, progress, execution) => {
    ids.push(execution!.review); assert.equal(execution!.root, "root"); identified()
    progress({ phase: "evaluating", attempt: 0 }); now = 150
    progress({ phase: "streaming", attempt: 0, preview: { safe: true } }); now = 200
    return result
  }, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true, stream: true, autoApprove: true },
  candidate: () => true, nativeFront: root => root === "root" ? request.id : undefined, approvalReady: () => true,
  nativeApproval: { list: async () => [request], once: async (value, _signal, dispatch) => {
    assert.equal(dispatch(), true)
    c.permissionReplied({ sessionID: value.sessionID, requestID: value.id, decision: "once" })
    return { status: "submitted" }
  } },
  clock: { now: () => now, after: () => () => {} }, modes, onLifecycle: fact => {
    facts.push(fact)
    if (fact.type !== "accepted") assert.equal(c.views[0]!.assessment, result, "observer runs before clearing")
  } })
  c.asked(request); await settle(); c.refreshApprovalEligibility(); c.modeChanged("root")
  assert.equal(facts[0]!.type, "accepted")
  assert.deepEqual(facts[0]!.type === "accepted" && facts[0]!.timing, { fullReportMs: 100, ratingMs: 50 })
  assert.equal(facts[1]!.type, "cancelled")
  assert.equal(facts[1]!.type === "cancelled" && facts[1]!.reason, "mode")
  c.reconcile([request], c.revision); await settle()
  assert.notEqual(ids[0], ids[1]); assert.match(ids[0]!, /^[0-9a-f-]{36}$/)
  c.reconcile([], c.revision)
  const last = facts.at(-1)!
  assert.equal(last.type === "removed" && last.reason, "reconciled")
  await c.dispose()
})

for (const action of ["reply", "delete", "dispose", "mode"] as const) test(`late completion after ${action} is not accepted for history`, async () => {
  let finish!: (r: ReviewResult) => void
  const facts: ReviewLifecycleFact[] = []
  const c = new Controller(() => new Promise(resolve => { finish = resolve }), () => {},
    { modes, candidate: () => true, nativeFront: root => root === "root" ? request.id : undefined,
      nativeApproval: { list: async () => [request], once: async () => ({ status: "unavailable" }) },
      onLifecycle: fact => facts.push(fact) })
  c.asked(request); await settle()
  if (action === "reply") c.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
  if (action === "delete") c.deleted("root")
  if (action === "mode") c.modeChanged("root")
  const disposing = action === "dispose" ? c.dispose() : undefined
  finish(result); await settle(); await disposing
  assert.ok(!facts.some(f => f.type === "accepted"))
  assert.ok(!facts.some(f => f.type === "cancelled"), "unstarted countdown is not a cancellation")
  await c.dispose()
})

for (const behavior of ["throw", "reject"] as const) test(`lifecycle observer ${behavior} leaves approval unchanged`, async () => {
  let writes = 0
  const c = new Controller(async () => result, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true },
    candidate: () => true, nativeFront: root => root === "root" ? request.id : undefined, approvalReady: () => true,
    nativeApproval: { list: async () => [request], once: async (value, _signal, dispatch) => {
      assert.equal(dispatch(), true); writes++
      c.permissionReplied({ sessionID: value.sessionID, requestID: value.id, decision: "once" })
      return { status: "submitted" }
    } },
    clock: { now: () => 0, after: () => () => {} }, modes, onLifecycle: () => {
      if (behavior === "throw") throw new Error("observer")
      return Promise.reject(new Error("observer"))
    } })
  c.asked(request); await settle(); c.refreshApprovalEligibility(); await c.approveNow(request.id)
  assert.equal(writes, 1); assert.equal(c.views.length, 0); await c.dispose()
})

test("approval facts share one identity through event-before-ack and retain automatic classification", async () => {
  const facts: ApprovalFact[] = []
  let release!: () => void
  const ack = new Promise<void>(resolve => { release = resolve })
  const c = new Controller(async () => result, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true },
    candidate: () => true, nativeFront: root => root === "root" ? request.id : undefined, approvalReady: () => true,
    nativeApproval: { list: async () => [request], once: async (value, _signal, dispatch) => {
      assert.equal(dispatch(), true)
      c.permissionReplied({ sessionID: value.sessionID, requestID: value.id, decision: "once" })
      await ack; return { status: "submitted" }
    } },
    clock: { now: () => 0, after: () => () => {} }, modes, onApproval: fact => facts.push(fact) })
  c.asked(request); await settle(); c.refreshApprovalEligibility()
  const approving = c.approveNow(request.id, true); await settle()
  assert.equal(c.views.length, 0); assert.deepEqual(facts.map(f => f.type), ["dispatched"])
  release(); await approving; await settle()
  assert.deepEqual(facts.map(f => f.type), ["dispatched", "confirmed", "settled"])
  assert.equal(new Set(facts.map(f => f.approval)).size, 1); assert.ok(facts.every(f => f.automatic && f.review))
  await c.dispose()
})
