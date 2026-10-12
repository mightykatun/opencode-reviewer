import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller, visibleReview, type Approval, type ApprovalClock, type ControllerOptions, type Evaluate,
  type NativeFront, type ReviewLifecycleFact, type View } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { HostPermissionTransport } from "../src/host-permissions.js"
import { PendingRefresh } from "../src/pending-refresh.js"
import { ReviewAdmission } from "../src/review-admission.js"
import type { ApprovalPresentation } from "../src/route-approval.js"
import type { ReviewResult } from "../src/types.js"

const safe: ReviewResult = { safe: true, desc: "Reads fixture data." }
const request = (id: string, sessionID = "root", action = "shell", source = true): HostRequest => Object.freeze({
  id, sessionID, action, resources: Object.freeze(["pwd"]),
  ...(source ? { source: Object.freeze({ assistantID: "assistant", id: `call-${id}` }) } : {}),
})
const sessions = new Map([
  ["root", { id: "root" }],
  ["child", { id: "child", parentID: "root" }],
  ["deep", { id: "deep", parentID: "child" }],
])
const session = (id: string) => sessions.get(id)
const candidate: NonNullable<ControllerOptions<HostRequest>["candidate"]> = (value, options) =>
  value.action === "shell" && value.source !== undefined && options.reviewBash

test("native submission cannot satisfy the legacy confirmed-void approval contract", () => {
  const compatibleWriter: HostPermissionTransport["once"] extends Approval<HostRequest>["once"] ? true : false = false
  const compatibleResult: ReturnType<HostPermissionTransport["once"]> extends Promise<void> ? true : false = false
  assert.equal(compatibleWriter, false)
  assert.equal(compatibleResult, false)
})

test("readonly native requests retain their exact types through advisory evaluation and lifecycle facts", async t => {
  const values: HostRequest[] = [], publications: View<HostRequest>[][] = [], facts: ReviewLifecycleFact<HostRequest>[] = []
  const evaluate: Evaluate<HostRequest> = async (value, _signal, identified) => {
    values.push(value); identified(); assert.equal(value.action, "shell"); return safe
  }
  const controller: Controller<HostRequest> = new Controller<HostRequest>(evaluate, views => publications.push(views), {
    candidate, allowHiddenRoute: false, session,
    reviewOptions: { reviewBash: true, reviewEdits: false, autoApprove: true },
    onLifecycle: fact => { facts.push(fact) },
  })
  t.after(() => controller.dispose())
  const native = request("shell"), custom = request("custom", "root", "shell", false), edit = request("edit", "root", "edit")
  for (const value of [native, custom, edit]) { controller.asked(value); controller.asked(value) }
  await settle()
  assert.deepEqual(values, [native])
  assert.equal(values[0], native)
  assert.deepEqual(controller.views.map(view => [view.request.id, view.status]), [["shell", "complete"], ["custom", "unrelated"], ["edit", "unrelated"]])
  assert.ok(publications.every(views => views.every(view => typeof view.request.action === "string")))
  controller.presented("shell")
  assert.equal(controller.views[0]!.autoApproval, undefined, "no writer means advisory even with autoApprove configured")
  assert.equal(facts.length, 1)
  assert.equal(facts[0]!.request, native)
  controller.reconcile([native, custom, edit], controller.revision - 1)
  assert.equal(controller.views.length, 3)
  controller.replied(native.id)
  assert.equal(facts[1]!.type, "removed")
})

test("native action names do not enter the legacy candidate policy without an injected predicate", async t => {
  let evaluated = 0
  const controller = new Controller<HostRequest>(async () => { evaluated++; return safe }, () => {})
  t.after(() => controller.dispose())
  controller.asked(request("native")); await settle()
  assert.equal(evaluated, 0)
  assert.equal(controller.views[0]!.status, "unrelated")
})

test("native reconciliation keeps full request equality and rejects same-ID changed nested evidence", async t => {
  const native: HostRequest = Object.freeze({ ...request("identity"), metadata: Object.freeze({ scope: Object.freeze({ directory: "/fixture" }) }) })
  const controller = new Controller<HostRequest>(async () => safe, () => {}, {
    candidate, allowHiddenRoute: false, reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true },
  })
  t.after(() => controller.dispose())
  const view = () => controller.views[0]
  controller.asked(native); await settle()
  controller.reconcile([structuredClone(native)], controller.revision)
  assert.equal(view()?.autoApproval, undefined)
  controller.reconcile([{ ...native, metadata: { scope: { directory: "/changed" } } }], controller.revision)
  assert.equal(view()?.autoApproval?.status, "failed")
  assert.equal(controller.views[0]!.request, native)
})

test("native front seam receives disabled blockers and honors external root/family order, not arrival or lexical order", async t => {
  const deep = request("a-deep", "deep"), child = request("a-child", "child"), root = request("z-root")
  const blocker = request("disabled", "root", "edit")
  const queue = [root, child, deep, blocker]
  const snapshots: HostRequest[][] = []
  const started: string[] = []
  const front: NativeFront<HostRequest> = (rootID, pending) => {
    assert.equal(rootID, "root")
    snapshots.push([...pending]); return queue[0]?.id
  }
  const controller = new Controller<HostRequest>(async value => { started.push(value.id); return safe }, () => {}, {
    candidate, session, nativeFront: front, allowHiddenRoute: false,
    modes: { root: async () => "root", load: async () => {}, enabled: () => true },
  })
  t.after(() => controller.dispose())
  for (const value of [deep, child, root, blocker]) controller.asked(value)
  await settle()
  assert.deepEqual(started, [root.id, deep.id, child.id])
  assert.ok(snapshots.some(values => values.includes(blocker)), "disabled requests remain native blockers")
  assert.equal(visibleReview(controller.views, "deep", session, front)?.request, root)
  queue.splice(0, queue.length, blocker, deep, child, root)
  assert.equal(visibleReview(controller.views, "root", session, front), undefined)
  controller.replied(blocker.id)
  assert.equal(visibleReview(controller.views, "root", session, front), undefined, "external public blocker absent from entries still owns the queue")
  queue.shift()
  assert.equal(visibleReview(controller.views, "root", session, front)?.request, deep)
})

test("native selection retains an approved descendant response without making it a pending blocker", () => {
  const deep = request("deep", "deep"), root = request("root")
  const views: View<HostRequest>[] = [
    { request: deep, status: "analyzing", retained: true, resolved: true },
    { request: root, status: "complete", assessment: safe },
  ]
  const front: NativeFront<HostRequest> = (_root, pending) => {
    assert.deepEqual(pending, [root]); return root.id
  }
  assert.equal(visibleReview(views, "deep", session, front)?.request, deep)
  assert.equal(visibleReview(views, "missing", session, front), undefined)
})

test("generic PendingRefresh carries immutable native snapshots and rejects an intervening event revision", async t => {
  const controller = new Controller<HostRequest>(async () => safe, () => {}, { candidate, allowHiddenRoute: false })
  const parent = new AbortController()
  let finish!: (values: readonly HostRequest[]) => void
  let pending: readonly HostRequest[] = Object.freeze([request("snapshot")])
  let reads = 0
  const refresh: PendingRefresh<HostRequest> = new PendingRefresh<HostRequest>(controller, () => {
    if (++reads === 1) return new Promise(resolve => { finish = resolve })
    return Promise.resolve(pending)
  }, parent.signal)
  t.after(async () => { refresh.dispose(); await controller.dispose() })
  const initial = refresh.refresh(); await settle()
  const event = request("event")
  controller.asked(event)
  finish(pending); await initial; await settle()
  assert.deepEqual(controller.views.map(view => view.request), [event])
  pending = Object.freeze([event, request("fresh")])
  await refresh.refresh(); await settle()
  assert.deepEqual(controller.views.map(view => view.request), pending)
})

test("ReviewAdmission needs only a request ID, retaining native-front admission ordering", async () => {
  const admission = new ReviewAdmission(() => "front")
  const signal = new AbortController().signal, started: string[] = []
  const values = [{ id: "first" }, { id: "front" }]
  await Promise.all(values.map(value => admission.run(value, "root", signal, async () => { started.push(value.id); return value.id })))
  assert.deepEqual(started, ["front", "first"])
  await admission.settled()
})

class Clock implements ApprovalClock {
  private value = 0
  private timers = new Set<{ at: number; run: () => void }>()
  now() { return this.value }
  after(ms: number, run: () => void) {
    const timer = { at: this.value + ms, run }; this.timers.add(timer)
    return () => { this.timers.delete(timer) }
  }
  jump(ms: number) {
    const end = this.value + ms
    while (true) {
      const next = [...this.timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.value = next.at; this.timers.delete(next); next.run()
    }
    this.value = end
  }
}

// These exercise the shared presentation policy with the legacy confirmed-void
// writer seam only. No native HTTP response is adapted or treated as confirmed.
function presentationFixture() {
  const native: PermissionRequest = { id: "permission", sessionID: "root", permission: "bash", patterns: ["pwd"], always: [], metadata: {} }
  const clock = new Clock(), facts: ReviewLifecycleFact[] = []
  let proof: ApprovalPresentation = { state: "route-hidden", root: "root", id: native.id }
  let front = native.id, writes = 0, finish!: (value: ReviewResult) => void
  const approval: Approval = {
    visibleID: () => proof.state === "visible" ? proof.id : undefined,
    presentation: () => proof, list: async () => [native], once: async () => { writes++ },
  }
  const controller = new Controller((_request, _signal, identified) => {
    identified(); return new Promise(resolve => { finish = resolve })
  }, () => {}, { clock, approval, allowHiddenRoute: false, session,
    nativeFront: () => front,
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 2 },
    onLifecycle: fact => { facts.push(fact) },
  })
  const present = (value: ApprovalPresentation) => { proof = value; controller.presented(proof) }
  return { native, clock, controller, facts, present, finish: () => finish(safe), writes: () => writes,
    view: () => controller.views[0],
    front: (id: string) => { front = id } }
}

test("allowHiddenRoute false makes an armed normal countdown permanently manual on descendant navigation", async t => {
  const f = presentationFixture(); t.after(() => f.controller.dispose())
  f.controller.asked(f.native); await settle(); f.finish(); await settle()
  f.present({ state: "visible", id: f.native.id })
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 2 })
  f.present({ state: "route-hidden", root: "root", id: f.native.id })
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  f.clock.jump(10_000)
  f.present({ state: "visible", id: f.native.id })
  f.controller.reconcile([f.native], f.controller.revision)
  f.clock.jump(10_000); await settle()
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  assert.equal(f.writes(), 0)
  assert.equal(f.facts.filter(fact => fact.type === "cancelled").length, 1)
})

test("allowHiddenRoute false leaves never-armed hidden completions eligible only after physical root presentation", async t => {
  const f = presentationFixture(); t.after(() => f.controller.dispose())
  f.controller.asked(f.native); await settle()
  f.present({ state: "route-hidden", root: "root", id: f.native.id })
  f.finish(); await settle()
  f.present({ state: "route-hidden", root: "root", id: f.native.id }); f.clock.jump(10_000)
  assert.equal(f.view()?.autoApproval, undefined)
  assert.equal(f.writes(), 0)
  f.present({ state: "pending", id: f.native.id }); f.clock.jump(10_000)
  assert.equal(f.view()?.autoApproval, undefined, "root mounting/pending paint is insufficient")
  f.present({ state: "visible", id: f.native.id })
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 2 })
  f.clock.jump(2199); await settle(); assert.equal(f.writes(), 0)
  f.clock.jump(1); await settle(); assert.equal(f.writes(), 1)
})

test("supplied native priority independently blocks stale physical proof and cancels an armed countdown", async t => {
  const f = presentationFixture(); t.after(() => f.controller.dispose())
  f.controller.asked(f.native); await settle(); f.finish(); await settle()
  f.front("external-disabled")
  f.present({ state: "visible", id: f.native.id })
  assert.equal(f.view()?.autoApproval, undefined)
  f.front(f.native.id); f.present({ state: "visible", id: f.native.id })
  assert.equal(f.view()?.autoApproval?.status, "countdown")
  f.front("external-disabled"); f.clock.jump(200)
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  f.front(f.native.id); f.present({ state: "visible", id: f.native.id }); f.clock.jump(10_000)
  await settle(); assert.equal(f.writes(), 0)
})
