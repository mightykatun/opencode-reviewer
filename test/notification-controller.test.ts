import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, type ApprovalFact, type ApprovalClock } from "../src/controller.js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { NotificationPolicy } from "../src/notification-policy.js"
import { parseNotificationConfig } from "../src/notification-config.js"
import { notificationBlockers } from "../src/notification-order.js"
import type { NotificationMessage } from "../src/notification-types.js"

const request: PermissionRequest = { id: "p", sessionID: "root", permission: "bash", patterns: [], metadata: {}, always: [] }

test("confirmation fact survives native resolution before HTTP acknowledgement and retains automatic origin", async () => {
  const facts: ApprovalFact[] = []
  let callback: (() => void) | undefined
  const controller = new Controller(async () => ({ safe: true, desc: "fixture" }), () => {},
    { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 0 }, approval: {
      visibleID: () => "p", list: async () => [request],
      once: async () => { controller.replied("p") },
    }, clock: { now: () => 0, after: (_ms, cb) => { callback = cb; return () => { callback = undefined } } },
    onApproval: fact => { facts.push(fact) } })
  controller.asked(request); await settle(); controller.presented("p"); callback!(); await settle()
  assert.deepEqual(facts.map(f => [f.type, f.automatic]), [["dispatched", true], ["confirmed", true], ["settled", true]])
  assert.equal(controller.views.length, 0); await controller.dispose()
})

for (const scope of ["root", "children"] as const) {
  test(`overlapping ${scope} permissions that both auto-approve never need human attention`, async t => {
    let now = 0, presented: string | undefined
    const timers = new Set<{ at: number; run: () => void }>()
    const clock: ApprovalClock = { now: () => now, after(ms, run) {
      const timer = { at: now + ms, run }; timers.add(timer)
      return () => { timers.delete(timer) }
    } }
    const messages: NotificationMessage[] = [], approved: string[] = []
    const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 1 }), true, {
      async show(message) { messages.push(message); return { close() {} } }, dispose() {},
    }, clock)
    const controller: Controller = new Controller(async (_request, _signal, identified) => {
      identified(); return { safe: true, desc: "Harmless fixture command." }
    }, views => {
      policy.snapshot(views)
      policy.pending(notificationBlockers(new Set(["root"]), views.map(v => ({ ...v.request, kind: "permission" as const })),
        id => ({ id, ...(id === "root" ? {} : { parentID: "root" }) })))
    }, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 3 }, approval: {
      visibleID: () => presented,
      list: async () => controller.views.map(v => v.request),
      once: async permission => { approved.push(permission.id); controller.replied(permission.id) },
    }, clock })
    t.after(async () => { await controller.dispose(); await policy.dispose() })
    for (const id of ["a", "b"]) {
      const permission = { ...request, id, sessionID: scope === "root" ? "root" : `child-${id}` }
      controller.asked(permission)
      policy.permission(permission, { root: "root", sessionID: "root", title: "Fixture root" }, true)
    }
    await settle()
    assert.ok(controller.views.every(v => v.status === "complete" && v.assessment?.safe))
    const advance = async (ms: number) => {
      now += ms
      for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.run()
      await settle()
    }
    presented = "a"; controller.presented("a")
    await advance(1500) // b is Safe but cannot start until a leaves the native queue.
    assert.equal(controller.views.find(v => v.request.id === "b")?.autoApproval, undefined)
    await advance(2500)
    assert.deepEqual(approved, ["a"])
    presented = "b"; controller.presented("b")
    await advance(4000)
    assert.deepEqual(approved, ["a", "b"])
    assert.equal(controller.views.length, 0)
    assert.deepEqual(messages, [], "a Safe queued request is awaiting automation, not human action")
  })
}

test("disabling review during an approval write preserves uncertain outcome until pending reconciliation", async t => {
  let enabled = true, finish!: () => void, writes = 0
  const messages: NotificationMessage[] = []
  const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 0 }), true, {
    async show(message) { messages.push(message); return { close() {} } }, dispose() {},
  })
  const blockers = new Map([["root", { kind: "permission" as const, id: "p" }]])
  const controller: Controller = new Controller(async () => ({ safe: true, desc: "fixture" }),
    views => policy.snapshot(views, blockers), { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true }, approval: {
      visibleID: () => "p", list: async () => [request],
      once: () => { writes++; return new Promise(resolve => { finish = resolve }) },
    }, modes: { root: async () => "root", load: async () => {}, enabled: () => enabled } })
  t.after(async () => { finish?.(); await controller.dispose(); await policy.dispose() })
  controller.asked(request)
  policy.permission(request, { root: "root", sessionID: "root", title: "Fixture" }, true)
  await settle(); controller.presented("p")
  const approving = controller.approveNow("p", true)
  await settle(); assert.equal(writes, 1); assert.equal(controller.views[0]?.autoApproval?.status, "allowing")
  enabled = false; controller.modeChanged("root")
  await settle()
  assert.equal(controller.views[0]?.status, "suspended")
  assert.equal(messages.length, 0, "disabling analysis does not establish that an in-flight write left the request pending")
  controller.reconcile([request], controller.revision); await settle()
  assert.deepEqual(messages.map(m => m.title), ["Session needs attention"])
  assert.equal(writes, 1)
  finish(); await approving
})

test("failed approval confirms pending state only through successful reconciliation; observer failures are isolated", async () => {
  let reads = 0, writes = 0
  const controller = new Controller(async () => ({ safe: true, desc: "fixture" }), () => {},
    { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 15 }, approval: {
      visibleID: () => "p", list: async () => { reads++; return [request] },
      once: async () => { writes++; throw new Error("uncertain") },
    }, onApproval: () => Promise.reject(new Error("observer")) })
  controller.asked(request); await settle(); controller.presented("p"); await controller.approveNow("p")
  assert.equal(reads, 2); assert.equal(writes, 1)
  assert.equal(controller.views[0]?.autoApproval?.status, "failed")
  assert.equal(controller.views[0]?.approvalPendingConfirmed, true)
  await controller.approveNow("p"); assert.equal(writes, 1); await controller.dispose()
})

test("manual footer confirmation is tagged manual, and a rejected acknowledgement never reports success", async () => {
  for (const failure of [false, true]) {
    const facts: ApprovalFact[] = []
    const controller = new Controller(async () => ({ safe: true, desc: "fixture" }), () => {},
      { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true }, approval: {
        visibleID: () => "p", list: async () => [request],
        once: async () => { if (failure) throw new Error("no acknowledgement") },
      }, onApproval: fact => { facts.push(fact) } })
    controller.asked(request); await settle(); controller.presented("p"); await controller.approveNow("p")
    assert.deepEqual(facts.map(f => f.type), failure ? ["dispatched", "settled"] : ["dispatched", "confirmed", "settled"])
    assert.ok(facts.every(f => f.automatic === false)); await controller.dispose()
  }
})

for (const fastMode of [false, true]) for (const event of ["unrelated root", "later same root"] as const) {
  test(`${fastMode ? "fast" : "normal"} ${event} during verification recovers once without an attention episode`, async t => {
    let release!: (requests: PermissionRequest[]) => void, reads = 0, writes = 0
    const messages: NotificationMessage[] = [], facts: ApprovalFact[] = []
    const target = { root: "root", sessionID: "root", title: "Fixture" }
    const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 0 }), true, {
      async show(message) { messages.push(message); return { close() {} } }, dispose() {},
    })
    const pending = [request]
    const controller = new Controller(async () => ({ safe: true, desc: "fixture" }),
      views => policy.snapshot(views, new Map([["root", { kind: "permission", id: "p" }]])),
      { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode }, approval: {
        visibleID: () => "p",
        list: () => ++reads === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve([...pending]),
        once: async () => { writes++ },
      }, onApproval: fact => {
        facts.push(fact)
        if (fact.type === "confirmed") policy.approved(fact.request, target)
      } })
    t.after(async () => { await controller.dispose(); await policy.dispose() })
    controller.asked(request); policy.permission(request, target, true)
    await settle(); controller.presented("p")
    const operation = controller.approveNow("p", true)
    await settle()
    const other = { ...request, id: "z", sessionID: event === "unrelated root" ? "other" : "root" }
    pending.push(other); controller.asked(other)
    release([request]); await operation; await settle()
    assert.equal(reads, 2)
    assert.equal(writes, 1)
    assert.deepEqual(messages.map(message => message.kind), ["approved"], "no transient attention sound/banner")
    assert.deepEqual(facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
    assert.ok(controller.views.some(view => view.request.id === "z"), "stale list must not erase new work")
  })
}

for (const fastMode of [false, true]) test(`${fastMode ? "fast" : "normal"} sustained unrelated churn caps verification reads, stays silent, and fresh reconciliation can rearm`, async t => {
  let churn = true, reads = 0, writes = 0
  const messages: NotificationMessage[] = []
  const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 0 }), true, {
    async show(message) { messages.push(message); return { close() {} } }, dispose() {},
  })
  const controller = new Controller(async () => ({ safe: true, desc: "fixture" }),
    views => policy.snapshot(views, new Map([["root", { kind: "permission", id: "p" }]])),
    { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode }, approval: {
      visibleID: () => "p",
      list: async () => { reads++; if (churn) controller.replied("unrelated"); return [request] },
      once: async () => { writes++ },
    }, clock: { now: () => 0, after: () => () => {} } })
  t.after(async () => { await controller.dispose(); await policy.dispose() })
  controller.asked(request)
  policy.permission(request, { root: "root", sessionID: "root", title: "Fixture" }, true)
  await settle(); controller.presented("p"); await controller.approveNow("p", true); await settle()
  assert.equal(reads, 3, "bounded sequential verification, with no extra failure recovery read")
  assert.equal(writes, 0)
  assert.equal(controller.views[0]?.autoApproval?.status, "checking")
  for (let frame = 0; frame < 20; frame++) {
    controller.presented("p"); await controller.approveNow("p", true)
  }
  assert.equal(reads, 3, "frames and clicks cannot replenish the exhausted reservation")
  assert.deepEqual(messages, [])
  const revision = controller.revision
  controller.replied("unknown")
  controller.reconcile([request], revision)
  assert.equal(controller.views[0]?.autoApproval?.status, "checking", "a stale poll cannot release the reservation")
  churn = false
  controller.reconcile([request], controller.revision)
  controller.presented("p"); await controller.approveNow("p", true); await settle()
  assert.equal(reads, 4)
  assert.equal(writes, 1, "read churn did not install a manual tombstone")
  assert.deepEqual(messages, [])
})

for (const fastMode of [false, true]) for (const failure of ["GET 503", "GET timeout"] as const) {
  test(`${fastMode ? "fast" : "normal"} ${failure} remains silent through settlement and bounded reconciliation`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let reads = 0, writes = 0, release!: (pending: PermissionRequest[]) => void
    let recover!: (pending: PermissionRequest[]) => void
    const first = new Promise<PermissionRequest[]>(resolve => { release = resolve })
    const recovery = new Promise<PermissionRequest[]>(resolve => { recover = resolve })
    const messages: NotificationMessage[] = [], facts: ApprovalFact[] = []
    const target = { root: "root", sessionID: "root", title: "Fixture" }
    const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 1 }), true, {
      async show(message) { messages.push(message); return { close() {} } }, dispose() {},
    })
    const controller = new Controller(async () => ({ safe: true, desc: "Fixture" }),
      views => policy.snapshot(views, new Map([["root", { kind: "permission", id: "p" }]])), {
        reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode },
        clock: { now: () => 0, after: () => () => {} }, approval: {
          visibleID: () => "p",
          list: () => ++reads === 1 ? failure === "GET 503" ? Promise.reject(Error("503")) : first
            : reads === 2 ? recovery : Promise.resolve([request]),
          once: async () => { writes++ },
        }, onApproval: fact => {
          facts.push(fact)
          if (fact.type === "confirmed") policy.approved(fact.request, target)
        },
      })
    t.after(async () => { await controller.dispose(); await policy.dispose() })
    controller.asked(request); policy.permission(request, target, true)
    await settle(); controller.presented("p")
    const operation = controller.approveNow("p", true)
    await settle()
    if (failure === "GET timeout") {
      t.mock.timers.tick(5000); await operation
      assert.equal(reads, 1)
      for (let i = 0; i < 20; i++) {
        controller.reconcile([request], controller.revision); controller.presented("p")
      }
      t.mock.timers.tick(10000); await settle()
      assert.equal(reads, 1); assert.equal(messages.length, 0)
      release([request]); await settle()
    }
    assert.equal(reads, 2); assert.equal(writes, 0)
    assert.equal(controller.views[0]?.autoApproval?.status, "checking")
    assert.equal(messages.length, 0, "read-only recovery cannot create an attention episode")
    recover([structuredClone(request)]); await operation; await settle()
    controller.presented("p"); await controller.approveNow("p", true); await settle()
    assert.equal(reads, 3); assert.equal(writes, 1)
    assert.deepEqual(messages.map(message => message.kind), ["approved"])
    assert.deepEqual(facts.map(fact => [fact.type, fact.result]), [
      ["settled", "not-sent"], ["dispatched", undefined], ["confirmed", undefined], ["settled", undefined],
    ])
  })
}
