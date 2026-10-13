import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, visibleReview, type NativeApproval, type ControllerOptions, type Evaluate, type NativeFront,
  type ReviewLifecycleFact, type View } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { HostPermissionTransport, NativeApprovalTransport } from "../src/host-permissions.js"
import { PendingRefresh } from "../src/pending-refresh.js"
import { ReviewAdmission } from "../src/review-admission.js"

const safe = { safe: true, desc: "Reads fixture data." }
const request = (id: string, sessionID = "root", action = "shell", source = true): HostRequest => Object.freeze({
  id, sessionID, action, resources: Object.freeze(["pwd"]),
  ...(source ? { source: Object.freeze({ assistantID: "assistant", id: `call-${id}` }) } : {}) })
const sessions = new Map([["root", { id: "root" }], ["child", { id: "child", parentID: "root" }],
  ["deep", { id: "deep", parentID: "child" }]])
const session = (id: string) => sessions.get(id)
const candidate: NonNullable<ControllerOptions["candidate"]> = (value, options) => value.action === "shell" && !!value.source && options.reviewBash

test("controller default types and native submission retain native acknowledgement results", () => {
  const scoped: HostPermissionTransport["once"] extends NativeApproval["once"] ? true : false = false
  const compatible: NativeApprovalTransport<HostRequest>["once"] extends NativeApproval["once"] ? true : false = true
  const voidResult: ReturnType<HostPermissionTransport["once"]> extends Promise<void> ? true : false = false
  const value: View["request"] = request("native")
  assert.equal(value.action, "shell"); assert.equal(scoped, false); assert.equal(compatible, true); assert.equal(voidResult, false)
})
test("readonly native requests retain exact types through advisory evaluation and lifecycle facts", async t => {
  const values: HostRequest[] = [], facts: ReviewLifecycleFact[] = [], publications: View[][] = []
  const evaluate: Evaluate = async (value, _signal, identified) => { values.push(value); identified(); return safe }
  const controller = new Controller(evaluate, views => { publications.push(views) }, { candidate, session,
    reviewOptions: { reviewBash: true, reviewEdits: false, autoApprove: true }, onLifecycle: fact => { facts.push(fact) } })
  t.after(() => controller.dispose())
  const native = request("shell"), custom = request("custom", "root", "shell", false), edit = request("edit", "root", "edit")
  for (const value of [native, custom, edit]) { controller.asked(value); controller.asked(value) }
  await settle(); assert.deepEqual(values, [native]); assert.equal(values[0], native)
  assert.deepEqual(controller.views.map(v => [v.request.id, v.status]), [["shell", "complete"], ["custom", "unrelated"], ["edit", "unrelated"]])
  assert.ok(publications.every(views => views.every(v => typeof v.request.action === "string")))
  controller.refreshApprovalEligibility(); assert.equal(controller.views[0]?.autoApproval, undefined)
  assert.equal(facts[0]?.request, native); controller.replied(native.id); assert.equal(facts[1]?.type, "removed")
})
test("candidate classification must be supplied explicitly", async t => {
  let evaluated = 0
  const controller = new Controller(async () => { evaluated++; return safe }, () => {})
  t.after(() => controller.dispose()); controller.asked(request("native")); await settle()
  assert.equal(evaluated, 0); assert.equal(controller.views[0]?.status, "unrelated")
})
test("native reconciliation rejects same-ID changed nested evidence", async t => {
  const native = { ...request("identity"), metadata: { scope: { directory: "/fixture" } } }
  const controller = new Controller(async () => safe, () => {}, { candidate, reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true } })
  t.after(() => controller.dispose()); controller.asked(native); await settle()
  const view = () => controller.views[0]
  controller.reconcile([structuredClone(native)], controller.revision); assert.equal(view()?.autoApproval, undefined)
  controller.reconcile([{ ...native, metadata: { scope: { directory: "/changed" } } }], controller.revision)
  assert.equal(view()?.autoApproval?.status, "failed"); assert.equal(view()?.request, native)
})
test("native front honors external root/family order, including disabled blockers, not lexical or arrival order", async t => {
  const deep = request("a-deep", "deep"), child = request("a-child", "child"), root = request("z-root"), blocker = request("disabled", "root", "edit")
  const queue = [root, child, deep, blocker], snapshots: HostRequest[][] = [], started: string[] = []
  const front: NativeFront = (rootID, pending) => { assert.equal(rootID, "root"); snapshots.push([...pending]); return queue[0]?.id }
  const controller = new Controller(async value => { started.push(value.id); return safe }, () => {}, { candidate, session, nativeFront: front,
    modes: { root: async () => "root", load: async () => {}, enabled: () => true } })
  t.after(() => controller.dispose()); for (const value of [deep, child, root, blocker]) controller.asked(value)
  await settle(); assert.deepEqual(started, [root.id, deep.id, child.id]); assert.ok(snapshots.some(values => values.includes(blocker)))
  assert.equal(visibleReview(controller.views, "deep", session, front)?.request, root)
  queue.splice(0, queue.length, blocker, deep, child, root); assert.equal(visibleReview(controller.views, "root", session, front), undefined)
  controller.replied(blocker.id); assert.equal(visibleReview(controller.views, "root", session, front), undefined)
  queue.shift(); assert.equal(visibleReview(controller.views, "root", session, front)?.request, deep)
})
test("native selection retains an approved descendant response without making it a pending blocker", () => {
  const deep = request("deep", "deep"), root = request("root")
  const views: View[] = [{ request: deep, status: "analyzing", retained: true, resolved: true }, { request: root, status: "complete", assessment: safe }]
  const front: NativeFront = (_root, pending) => { assert.deepEqual(pending, [root]); return root.id }
  assert.equal(visibleReview(views, "deep", session, front)?.request, deep)
  assert.equal(visibleReview(views, "missing", session, front), undefined)
  assert.equal(visibleReview(views, "root", session), undefined, "missing queue observation cannot invent priority")
  assert.equal(visibleReview(views, "root", session, () => { throw Error("unavailable") }), undefined)
})
test("PendingRefresh carries immutable native snapshots and rejects intervening event revisions", async t => {
  const controller = new Controller(async () => safe, () => {}, { candidate }), parent = new AbortController()
  let finish!: (values: readonly HostRequest[]) => void, reads = 0
  let pending = Object.freeze([request("snapshot")])
  const refresh = new PendingRefresh(controller, () => ++reads === 1 ? new Promise<readonly HostRequest[]>(resolve => { finish = resolve }) : Promise.resolve(pending), parent.signal)
  t.after(async () => { refresh.dispose(); await controller.dispose() })
  const initial = refresh.refresh(); await settle(); const event = request("event"); controller.asked(event)
  finish(pending); await initial; await settle(); assert.deepEqual(controller.views.map(v => v.request), [event])
  pending = Object.freeze([event, request("fresh")]); await refresh.refresh(); await settle(); assert.deepEqual(controller.views.map(v => v.request), pending)
})
test("generic ReviewAdmission only requires an ID and uses supplied native-front ordering", async () => {
  const admission = new ReviewAdmission(() => "front"), signal = new AbortController().signal, started: string[] = []
  await Promise.all([{ id: "first" }, { id: "front" }].map(value => admission.run(value, "root", signal, async () => { started.push(value.id); return value.id })))
  assert.deepEqual(started, ["front", "first"]); await admission.settled()
})
