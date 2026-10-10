import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller, visibleReview, type ApprovalFact, type View } from "../src/controller.js"
import { parseConfig } from "../src/config.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"
import { HistorySQL, type HistorySelection, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent, type HistoryEvent } from "../src/history-records.js"
import { NotificationPolicy } from "../src/notification-policy.js"
import type { NotificationMessage } from "../src/notification-types.js"
import type { ReviewProgress, ReviewResult } from "../src/types.js"

const request = (id = "a", sessionID = "root"): PermissionRequest => ({ id, sessionID, permission: "bash", patterns: [id], always: [], metadata: {} })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function fixture(t: TestContext, options: Record<string, unknown> = {}, hooks: {
  changed?: (views: View[]) => void; approval?: (fact: ApprovalFact) => void; presentation?: () => boolean
} = {}) {
  const config = parseConfig({ baseURL: "https://example.com/v1", model: "fixture", stream: true, autoApprove: true,
    fastMode: true, autoApproveDelaySeconds: 999, notifySound: false, staleReminderSeconds: 0, ...options })
  const db = new DatabaseSync(":memory:"), sql = new HistorySQL(db)
  let sequence = 0, enabled = true, shown: string | undefined = "root", failedStorage = false
  const events: HistoryEvent[] = [], banners: NotificationMessage[] = [], facts: ApprovalFact[] = []
  const history = new HistoryCoordinator("/host", {
    admit: e => { if (failedStorage) return false; events.push(e); sql.apply("fixture", ++sequence, encodeEvent(e)); return true },
    query: q => Promise.resolve(sql.query(q)), onCommit: () => () => {},
  }, async () => "root")
  const target = { root: "root", sessionID: "root", title: "Fixture" }
  const policy = new NotificationPolicy(config, config.autoApprove, {
    show: async message => { banners.push(message); return { close() {} } }, dispose() {},
  })
  const workers = new Map<string, { signal: AbortSignal; progress: (p: ReviewProgress) => void;
    finish(safe?: boolean): void; fail(): void }>()
  let pending: PermissionRequest[] = []
  const writes: { request: PermissionRequest; signal: AbortSignal; ack: ReturnType<typeof deferred<void>> }[] = []
  let list: (signal: AbortSignal) => Promise<PermissionRequest[]> = async () => pending
  const controller: Controller = new Controller((req, signal, identify, progress, execution) => {
    const observer = history.observation(req, "shell", config, execution!)
    observer.observe!({ type: "dispatched", review: execution!.review, attempt: "one", retry: "initial" })
    const result = deferred<ReviewResult>()
    signal.addEventListener("abort", () => result.reject(Error("aborted")), { once: true })
    identify(); progress({ attempt: 0, phase: "evaluating" })
    workers.set(req.id, { signal, progress,
      finish(safe = true) {
        observer.observe!({ type: "finalized", review: execution!.review, attempt: "one", usage: { input: 10, output: 5 } })
        result.resolve({ safe, desc: "Complete " + req.id, usage: { input: 10, output: 5 },
          metadata: { review: execution!.review, kind: "shell", provider: config.baseURL, configuredModel: config.model } })
      },
      fail() { observer.observe!({ type: "finalized", review: execution!.review, attempt: "one", usage: { input: 10, output: 5 } }); result.reject(Error("invalid remainder")) },
    })
    return result.promise
  }, () => {
    const views = controller.pendingViews
    const first = pending[0]
    policy.snapshot(views, first ? new Map([["root", { kind: "permission", id: first.id }]]) : new Map())
    hooks.changed?.(controller.views)
  }, { reviewOptions: config, approval: {
    visibleID: () => shown && (hooks.presentation?.() ?? true) ? visibleReview(controller.views, shown, id => ({ id }))?.request.id : undefined,
    list: signal => list(signal),
    once: (req, signal) => { const ack = deferred<void>(); writes.push({ request: req, signal, ack }); return ack.promise },
  }, modes: { root: async () => "root", load: async () => {}, enabled: () => enabled }, onApproval: fact => {
    facts.push(fact); history.approval(fact)
    if (fact.type === "confirmed" && fact.automatic) policy.approved(fact.request, target)
    hooks.approval?.(fact)
  }, onLifecycle: history.lifecycle })
  const ask = async (req: PermissionRequest) => {
    pending.push(req); policy.permission(req, target, true); controller.asked(req); await settle()
  }
  const resolved = (id = "a") => {
    pending = pending.filter(p => p.id !== id)
    history.reply({ requestID: id, sessionID: "root", reply: "once" })
    controller.replied(id)
  }
  t.after(async () => {
    for (const write of writes) write.ack.reject(Error("cleanup"))
    await controller.dispose(); history.dispose(); await policy.dispose(); sql.close()
  })
  await ask(request())
  controller.presented("a")
  return { controller, config, workers, writes, facts, events, banners, ask, resolved,
    rate: (safe = true, id = "a", attempt = 0) => workers.get(id)!.progress({ attempt, phase: "streaming", preview: { safe, desc: "Partial " + id } }),
    mode: (value: boolean) => { enabled = value; controller.modeChanged("root") },
    hide: () => { shown = undefined; controller.presented() },
    show: () => { shown = "root"; controller.presented(visibleReview(controller.views, "root", id => ({ id }))?.request.id) },
    list: (fn: typeof list) => { list = fn }, failStorage: () => { failedStorage = true },
    saved: () => sql.query({ type: "history", scope: "/host", root: "root" }) as HistorySelection,
    totals: () => (sql.query({ type: "totals" }) as HistoryTotals).totals,
  }
}

test("fast Safe dispatches once without countdown, retains response across resolution, and saves only after final acceptance", async t => {
  const f = await fixture(t)
  f.rate(); await settle()
  assert.equal(f.writes.length, 1)
  assert.equal(f.controller.views[0]?.assessment, undefined)
  assert.equal(f.saved().total, 0); assert.equal(f.totals().safe, 0)
  f.resolved(); assert.equal(f.workers.get("a")!.signal.aborted, false)
  assert.equal(f.controller.pendingViews.length, 0); assert.equal(f.controller.views.length, 1)
  assert.equal(f.banners.length, 0)
  f.writes[0]!.ack.resolve(); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "approved")
  assert.equal(f.totals().activity.autoApproved, 1)
  assert.equal(f.saved().total, 0)
  assert.deepEqual(f.banners.map(m => [m.kind, m.history]), [["approved", { session: "root", permission: "a" }]])
  f.controller.reconcile([], f.controller.revision); f.rate(); f.show(); await settle()
  assert.equal(f.writes.length, 1)
  assert.equal(f.controller.retained("root", { session: "root", permission: "a" })?.request.id, "a")
  f.workers.get("a")!.finish(); await settle()
  assert.equal(f.controller.views.length, 0)
  assert.equal(f.controller.retained("root", { session: "root", permission: "a" }), undefined)
  assert.equal(f.saved().record?.payload.desc, "Complete a")
  assert.equal(f.saved().record?.outcome, "auto")
  assert.equal(f.totals().safe, 1); assert.equal(f.totals().requests, 1)
  assert.equal(f.events.filter(e => e.type === "permissionResolved").length, 1)
})

test("retained approved report stays ahead of the next permission without blocking native notification order", async t => {
  const f = await fixture(t)
  f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  await f.ask(request("b")); f.rate(true, "b"); f.show(); await settle()
  assert.equal(visibleReview(f.controller.views, "root", id => ({ id }))?.request.id, "a")
  assert.deepEqual(f.controller.pendingViews.map(v => v.request.id), ["b"])
  assert.equal(f.writes.length, 1); assert.deepEqual(f.banners.map(m => m.kind), ["approved"])
  f.workers.get("a")!.finish(); await settle(); f.show(); await settle()
  assert.equal(f.writes[1]?.request.id, "b")
  f.resolved("b"); f.writes[1]!.ack.resolve(); f.workers.get("b")!.finish(); await settle()
  assert.equal(f.saved().total, 2); assert.equal(f.controller.views.length, 0)
})

test("fast approval survives hidden UI and disable, continues retries, and can save a final Unsafe report", async t => {
  const f = await fixture(t)
  f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.hide(); f.mode(false)
  assert.equal(f.workers.get("a")!.signal.aborted, false)
  f.workers.get("a")!.progress({ attempt: 1, phase: "retrying" })
  f.rate(false, "a", 1); await settle()
  assert.equal(f.controller.views[0]?.progress?.preview?.safe, false)
  assert.equal(f.controller.views[0]?.autoApproval?.status, "approved")
  f.workers.get("a")!.finish(false); await settle()
  assert.equal(f.saved().record?.payload.safe, false); assert.equal(f.saved().record?.outcome, "auto")
  assert.equal(f.totals().unsafe, 1); assert.equal(f.totals().activity.autoApproved, 1)
  assert.deepEqual(f.banners.map(m => m.kind), ["approved"])
})

test("failed remainder retains received usage and confirmed approval accounting but saves no report", async t => {
  const f = await fixture(t)
  f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.workers.get("a")!.fail(); await settle()
  assert.equal(f.controller.views.length, 0); assert.equal(f.saved().total, 0)
  assert.equal(f.totals().requests, 1); assert.equal(f.totals().safe, 0)
  assert.equal(f.totals().activity.autoApproved, 1); assert.equal(f.banners.length, 1)
})

test("save failure never keeps a completed fast report on screen or changes approval", async t => {
  const f = await fixture(t)
  f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.failStorage(); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.controller.views.length, 0); assert.equal(f.writes.length, 1); assert.equal(f.banners.length, 1)
})

test("nonstream fast mode respects stream:false and waits for validation, then skips the delay", async t => {
  const f = await fixture(t, { stream: false })
  f.rate(); f.show(); await settle(); assert.equal(f.writes.length, 0)
  f.workers.get("a")!.finish(); await settle(); f.show(); await settle()
  assert.equal(f.writes.length, 1)
  f.writes[0]!.ack.resolve(); await settle()
  assert.equal(f.controller.views.length, 0); assert.equal(f.saved().total, 1)
})

for (const options of [{ fastMode: false }, { autoApprove: false }]) test(`fast approval remains opt-in: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options)
  f.rate(); f.show(); await settle(); assert.equal(f.writes.length, 0)
  f.workers.get("a")!.finish(); await settle(); f.show(); await settle()
  assert.equal(f.writes.length, 0)
  assert.equal(f.controller.views[0]?.autoApproval?.status, options.autoApprove === false ? undefined : "countdown")
})

test("hidden Safe and visible Unsafe previews never approve, but visible Safe can later become eligible", async t => {
  const f = await fixture(t)
  f.rate(false); await settle(); assert.equal(f.writes.length, 0)
  f.hide(); f.rate(); await settle(); assert.equal(f.writes.length, 0)
  f.show(); await settle(); assert.equal(f.writes.length, 1)
})

for (const cancel of ["hide", "cancel", "retry", "unsafe", "disable"] as const) test(`fast verification rechecks eligibility after ${cancel}`, async t => {
  const f = await fixture(t), read = deferred<PermissionRequest[]>()
  f.list(() => read.promise)
  f.rate(); await settle()
  if (cancel === "hide") f.hide()
  if (cancel === "cancel") f.controller.cancelAutoApproval("a")
  if (cancel === "retry") f.workers.get("a")!.progress({ attempt: 1, phase: "retrying" })
  if (cancel === "unsafe") f.rate(false)
  if (cancel === "disable") f.mode(false)
  read.resolve([request()]); await settle()
  assert.equal(f.writes.length, 0)
})

for (const invalidation of ["clear", "retry", "unsafe"] as const) {
  for (const ordering of ["Safe before GET", "Safe after GET"] as const) {
    for (const replacement of ["preview", "final"] as const) {
      test(`fast ${invalidation}: ${replacement} ${ordering} rearms only a fresh reservation`, async t => {
        const f = await fixture(t), old = deferred<PermissionRequest[]>(), fresh = deferred<PermissionRequest[]>()
        let reads = 0
        f.list(() => ++reads === 1 ? old.promise : fresh.promise)
        f.rate(); await settle(); assert.equal(reads, 1)
        const worker = f.workers.get("a")!
        if (invalidation === "retry") worker.progress({ attempt: 1, phase: "retrying" })
        else if (invalidation === "unsafe") f.rate(false)
        else worker.progress({ attempt: 0, phase: "streaming" })
        const nextSafe = async () => {
          if (replacement === "final") worker.finish()
          else f.rate(true, "a", invalidation === "retry" ? 1 : 0)
          await settle(); f.show()
        }
        if (ordering === "Safe before GET") await nextSafe()
        for (let i = 0; i < 20; i++) f.show()
        assert.equal(reads, 1); assert.equal(f.writes.length, 0, "rejected preview never writes")
        old.resolve([request()]); await settle()
        if (ordering === "Safe after GET") {
          assert.equal(reads, 1, "no read is admitted without a current Safe rating")
          assert.equal(f.writes.length, 0)
          await nextSafe(); await settle()
        }
        assert.equal(reads, 2, "replacement rating must get a new verification")
        assert.equal(f.writes.length, 0)
        assert.equal(f.banners.length, 0, "rating invalidation is not a manual-attention episode")
        fresh.resolve([structuredClone(request())]); await settle()
        assert.equal(f.writes.length, 1)
        if (replacement === "preview") worker.finish()
        f.resolved(); f.writes[0]!.ack.resolve(); await settle()
        f.show(); f.controller.reconcile([], f.controller.revision); await settle()
        assert.equal(f.writes.length, 1)
        assert.equal(f.facts.filter(fact => fact.type === "dispatched").length, 1)
        assert.ok(f.facts.some(fact => fact.type === "settled" && fact.result === "not-sent"))
        assert.deepEqual(f.banners.map(message => message.kind), ["approved"])
        assert.equal(f.saved().record?.outcome, "auto")
      })
    }
  }
}

for (const settled of [false, true]) for (const effect of ["hide", "preemption", "cancel", "disable"] as const) {
  test(`fast rating pause keeps ${effect} durable ${settled ? "after" : "before"} old GET settlement`, async t => {
    const f = await fixture(t), old = deferred<PermissionRequest[]>()
    let reads = 0
    f.list(() => { reads++; return old.promise })
    f.rate(); await settle()
    const worker = f.workers.get("a")!
    worker.progress({ attempt: 1, phase: "retrying" }); await settle()
    if (settled) { old.resolve([request()]); await settle() }
    if (effect === "hide") f.hide()
    if (effect === "preemption") { await f.ask({ ...request("0"), permission: "read" }); f.show() }
    if (effect === "cancel") f.controller.cancelAutoApproval("a")
    if (effect === "disable") f.mode(false)
    if (!settled) { old.resolve([request()]); await settle() }
    if (effect === "preemption") f.resolved("0")
    if (effect === "disable") {
      f.mode(true); f.controller.reconcile([request()], f.controller.revision); await settle()
    }
    f.workers.get("a")!.finish(); await settle(); f.show()
    f.controller.reconcile([request()], f.controller.revision); f.show(); await settle()
    assert.equal(f.controller.views[0]?.autoApproval?.status, "cancelled")
    assert.equal(reads, 1); assert.equal(f.writes.length, 0)
    assert.equal(f.banners.some(message => message.kind === "approved"), false)
  })
}

test("fast rejected preview followed by final Unsafe never writes and legitimately requests attention", async t => {
  const f = await fixture(t), old = deferred<PermissionRequest[]>()
  let reads = 0
  f.list(() => { reads++; return old.promise })
  f.rate(); await settle()
  f.workers.get("a")!.progress({ attempt: 1, phase: "retrying" })
  old.resolve([request()]); await settle()
  assert.equal(f.banners.length, 0)
  f.workers.get("a")!.finish(false); await settle(); f.show()
  f.controller.reconcile([request()], f.controller.revision); f.show(); await settle()
  assert.equal(reads, 1); assert.equal(f.writes.length, 0)
  assert.equal(f.controller.views[0]?.assessment?.safe, false)
  assert.equal(f.controller.views[0]?.autoApproval, undefined)
  assert.deepEqual(f.banners.map(message => message.kind), ["unsafe"])
})

for (const ordering of ["Safe before settlement", "Safe after settlement"] as const) {
  for (const hide of [false, true]) {
    test(`rating-clear publication invalidates hit owners until FRAME: ${ordering}, ${hide ? "real hide" : "same panel"}`, async t => {
      let painted = true, hadReservation = false, cleared = false, reads = 0
      const old = deferred<PermissionRequest[]>(), replacement = deferred<PermissionRequest[]>()
      const f = await fixture(t, {}, {
        presentation: () => painted,
        changed: views => {
          const view = views.find(view => view.request.id === "a")
          if (view?.autoApproval?.status === "checking") hadReservation = true
          if (hadReservation && !cleared && view?.status === "analyzing" && !view.autoApproval) {
            // Removing ReviewFooter destroys the old lower probe owner. The hit
            // grid still describes that owner until the next actual FRAME.
            cleared = true; painted = false
          }
        },
      })
      f.list(() => ++reads === 1 ? old.promise : replacement.promise)
      f.rate(); await settle(); assert.equal(reads, 1)
      const worker = f.workers.get("a")!
      worker.progress({ attempt: 0, phase: "streaming" })
      assert.equal(cleared, true); assert.equal(painted, false)
      worker.progress({ attempt: 0, phase: "streaming" })
      worker.progress({ attempt: 1, phase: "retrying" })
      worker.progress({ attempt: 1, phase: "streaming" })
      if (hide) f.hide() // A missing presentation observation remains authoritative.
      if (ordering === "Safe before settlement") f.rate(true, "a", 1)
      old.resolve([request()]); await settle()
      if (ordering === "Safe after settlement") {
        // Repeat the empty notification after the read slot has been released.
        worker.progress({ attempt: 1, phase: "streaming" })
        f.rate(true, "a", 1); await settle()
      }
      assert.equal(f.controller.views[0]?.autoApproval?.status, hide ? "cancelled" : undefined)
      assert.equal(reads, 1); assert.equal(f.writes.length, 0, "unpainted layout cannot admit replacement verification")
      assert.equal(f.banners.length, 0)
      painted = true; f.show(); await settle()
      assert.equal(reads, hide ? 1 : 2)
      assert.equal(f.writes.length, 0)
      replacement.resolve([request()]); await settle()
      assert.equal(f.writes.length, hide ? 0 : 1)
      worker.finish(); await settle()
      if (!hide) { f.resolved(); f.writes[0]!.ack.resolve(); await settle() }
      assert.deepEqual(f.banners.map(message => message.kind), [hide ? "attention" : "approved"])
    })
  }
}

test("replacement verification still cancels on a physical hide after rating-clear layout has repainted", async t => {
  let painted = true, reads = 0
  const old = deferred<PermissionRequest[]>(), replacement = deferred<PermissionRequest[]>()
  const f = await fixture(t, {}, { presentation: () => painted })
  f.list(() => ++reads === 1 ? old.promise : replacement.promise)
  f.rate(); await settle()
  f.workers.get("a")!.progress({ attempt: 0, phase: "streaming" })
  painted = false
  f.workers.get("a")!.progress({ attempt: 1, phase: "retrying" })
  old.resolve([request()]); await settle(); f.rate(true, "a", 1)
  painted = true; f.show(); await settle()
  assert.equal(reads, 2); assert.equal(f.writes.length, 0)
  painted = false // No FRAME callback: the fresh pre-write getter must catch this.
  replacement.resolve([request()]); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "cancelled")
  painted = true; f.show(); f.workers.get("a")!.finish(); await settle(); f.show()
  assert.equal(f.writes.length, 0); assert.equal(reads, 2)
})

test("rating clear can revoke deferred timeout recovery before its old read settles during unpainted layout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let painted = true, reads = 0
  const old = deferred<PermissionRequest[]>()
  const f = await fixture(t, {}, { presentation: () => painted })
  f.list(() => ++reads === 1 ? old.promise : Promise.resolve([request()]))
  f.rate(); await settle(); t.mock.timers.tick(5000); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "checking")
  f.workers.get("a")!.progress({ attempt: 0, phase: "streaming" })
  painted = false
  f.workers.get("a")!.progress({ attempt: 1, phase: "retrying" })
  old.resolve([request()]); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "checking")
  assert.equal(reads, 1); assert.equal(f.writes.length, 0)
  f.rate(true, "a", 1); painted = true; f.show(); await settle()
  assert.equal(reads, 1, "the read-error reservation still requires fresh reconciliation")
  f.controller.reconcile([request()], f.controller.revision); f.show(); await settle()
  assert.equal(reads, 2); assert.equal(f.writes.length, 1)
  f.workers.get("a")!.finish(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  assert.deepEqual(f.banners.map(message => message.kind), ["approved"])
})

for (const terminal of ["Unsafe", "unavailable"] as const) {
  for (const retry of [false, true]) for (const settlement of ["resolve", "reject"] as const) {
    test(`terminal ${terminal} after verification timeout notifies before late ${settlement}, ${retry ? "after retry clear" : "direct result"}`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] })
      const f = await fixture(t), held = deferred<PermissionRequest[]>()
      let reads = 0, active = 0
      f.list(async () => {
        reads++; active++
        try { return await held.promise } finally { active-- }
      })
      f.rate(); await settle()
      t.mock.timers.tick(5000); await settle()
      assert.equal(f.controller.views[0]?.autoApproval?.status, "checking")
      assert.equal(active, 1); assert.equal(f.banners.length, 0)
      const worker = f.workers.get("a")!
      if (retry) {
        worker.progress({ attempt: 0, phase: "streaming" })
        worker.progress({ attempt: 1, phase: "retrying" })
        await settle()
        assert.equal(f.banners.length, 0, "an unfinished retry is still silent")
      }
      if (terminal === "Unsafe") worker.finish(false)
      else worker.fail()
      await settle()
      const final = f.controller.views[0]!
      assert.equal(final.status, terminal === "Unsafe" ? "complete" : "unavailable")
      assert.equal(final.autoApproval, undefined, "terminal analysis must not display approval checking")
      const expected = [[terminal === "Unsafe" ? "unsafe" : "attention",
        terminal === "Unsafe" ? "Unsafe permission needs human approval" : "Session needs attention"]]
      assert.deepEqual(f.banners.map(message => [message.kind, message.title]), expected)
      assert.equal(active, 1, "attention cannot wait for a noncooperative read to settle")
      for (let i = 0; i < 20; i++) {
        f.controller.reconcile([request()], f.controller.revision); f.show()
        await f.controller.approveNow("a", true)
      }
      t.mock.timers.tick(60000); await settle()
      assert.equal(reads, 1); assert.equal(active, 1); assert.equal(f.writes.length, 0)
      assert.equal(f.banners.length, 1, "polls and frames cannot replay terminal attention")
      if (settlement === "resolve") held.resolve([request()])
      else held.reject(Error("late GET failure"))
      await settle()
      worker.progress({ attempt: retry ? 1 : 0, phase: "streaming", preview: { safe: true } })
      f.controller.reconcile([request()], f.controller.revision); f.show(); await settle()
      assert.equal(active, 0); assert.equal(reads, 1); assert.equal(f.writes.length, 0)
      assert.equal(f.controller.views[0]?.status, final.status)
      assert.equal(f.controller.views[0]?.assessment, final.assessment)
      assert.equal(f.controller.views[0]?.error, final.error)
      assert.equal(f.controller.views[0]?.autoApproval, undefined)
      assert.deepEqual(f.banners.map(message => [message.kind, message.title]), expected)
      assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"]])
      f.resolved(); await settle(); f.show()
      assert.equal(f.controller.views.length, 0); assert.equal(f.banners.length, 1)
    })
  }
}

test("terminal attention releases the display but not the timed-out verification slot for the next request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = await fixture(t), old = deferred<PermissionRequest[]>()
  let reads = 0, active = 0, maximum = 0
  f.list(async () => {
    maximum = Math.max(maximum, ++active)
    try { return ++reads === 1 ? await old.promise : [request("b")] }
    finally { active-- }
  })
  f.rate(); await settle(); t.mock.timers.tick(5000); await settle()
  f.workers.get("a")!.progress({ attempt: 1, phase: "retrying" })
  f.workers.get("a")!.finish(false); await settle()
  assert.deepEqual(f.banners.map(message => message.kind), ["unsafe"])
  f.resolved(); await f.ask(request("b")); f.rate(true, "b"); f.show(); await settle()
  assert.equal(reads, 1); assert.equal(active, 1); assert.equal(f.writes.length, 0)
  old.resolve([request()]); await settle()
  assert.equal(reads, 2); assert.equal(maximum, 1)
  assert.equal(f.controller.views.some(view => view.request.id === "a"), false, "late old GET cannot resurrect its review")
  assert.deepEqual(f.writes.map(write => write.request.id), ["b"])
  f.workers.get("b")!.finish(); f.resolved("b"); f.writes[0]!.ack.resolve(); await settle()
  assert.deepEqual(f.banners.map(message => message.kind), ["unsafe", "approved"])
})

for (const effect of ["hide", "cancel", "disable"] as const) {
  test(`terminal attention keeps ${effect} durable after the checking display is cleared`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = await fixture(t), held = deferred<PermissionRequest[]>()
    let reads = 0
    f.list(() => { reads++; return held.promise })
    f.rate(); await settle(); t.mock.timers.tick(5000); await settle()
    f.workers.get("a")!.finish(false); await settle()
    const terminal = f.controller.views[0]!
    assert.equal(terminal.autoApproval, undefined)
    assert.deepEqual(f.banners.map(message => message.kind), ["unsafe"])
    if (effect === "hide") f.hide()
    if (effect === "cancel") f.controller.cancelAutoApproval("a")
    if (effect === "disable") {
      f.mode(false); f.mode(true)
      f.controller.reconcile([request()], f.controller.revision); await settle()
      f.workers.get("a")!.finish(); await settle()
    }
    held.resolve([request()]); await settle()
    f.controller.reconcile([request()], f.controller.revision); f.show(); await settle()
    assert.equal(f.controller.views[0]?.autoApproval?.status, "cancelled")
    assert.equal(reads, 1); assert.equal(f.writes.length, 0)
    assert.equal(f.banners.some(message => message.kind === "approved"), false)
  })
}

test("fast rating rejection in the deferred write gap revokes that reservation even if Safe immediately returns", async t => {
  let queued = false, reads = 0
  const replacement = deferred<PermissionRequest[]>()
  const f = await fixture(t, {}, { changed: views => {
    if (queued || !views.some(view => view.autoApproval?.status === "allowing")) return
    queued = true
    queueMicrotask(() => {
      const worker = f.workers.get("a")!
      worker.progress({ attempt: 1, phase: "retrying" })
      f.rate(true, "a", 1)
      worker.progress({ attempt: 0, phase: "streaming", preview: { safe: false, desc: "Stale attempt" } })
    })
  } })
  f.list(() => ++reads === 1 ? Promise.resolve([request()]) : replacement.promise)
  f.rate(); await settle()
  assert.equal(queued, true); assert.equal(reads, 2)
  assert.equal(f.writes.length, 0, "deferred invocation must belong to the replacement verification")
  assert.equal(f.controller.views[0]?.progress?.attempt, 1)
  assert.equal(f.controller.views[0]?.progress?.preview?.safe, true)
  replacement.resolve([request()]); await settle()
  assert.equal(f.writes.length, 1)
  f.workers.get("a")!.finish(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  assert.deepEqual(f.banners.map(message => message.kind), ["approved"])
})

test("fast acknowledgement timeout stays single-shot through late success, native resolution and re-enable", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = await fixture(t)
  f.rate(); await settle(); assert.equal(f.writes.length, 1)
  t.mock.timers.tick(5000); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "failed")
  assert.equal(f.writes[0]!.signal.aborted, true)
  f.mode(false); f.mode(true); f.controller.reconcile([request()], f.controller.revision); await settle()
  f.workers.get("a")!.finish(); await settle(); f.show()
  f.controller.reconcile([request()], f.controller.revision); f.show(); await settle()
  assert.equal(f.controller.views[0]?.autoApproval?.status, "failed")
  f.resolved(); f.writes[0]!.ack.resolve(); await settle(); f.show()
  assert.equal(f.writes.length, 1)
  assert.equal(f.facts.some(fact => fact.type === "confirmed"), false)
  assert.equal(f.banners.some(message => message.kind === "approved"), false)
})

test("native resolution before dispatch remains manual, while an uncertain early write never retries or saves a report", async t => {
  const f = await fixture(t), read = deferred<PermissionRequest[]>()
  f.list(() => read.promise); f.rate(); await settle(); f.resolved(); read.resolve([]); await settle()
  assert.equal(f.writes.length, 0); assert.equal(f.controller.views.length, 0)
  const g = await fixture(t)
  g.rate(); await settle(); g.resolved(); g.writes[0]!.ack.reject(Error("acknowledgement lost")); await settle()
  assert.equal(g.controller.views.length, 0); assert.equal(g.workers.get("a")!.signal.aborted, true)
  assert.equal(g.saved().total, 0); assert.equal(g.banners.length, 0); assert.equal(g.writes.length, 1)
})

test("report completion before acknowledgement waits for confirmed approval and persists exactly once", async t => {
  const f = await fixture(t)
  f.rate(); await settle(); f.resolved(); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.saved().total, 0); assert.equal(f.controller.views.length, 1)
  f.writes[0]!.ack.resolve(); await settle()
  assert.equal(f.saved().total, 1); assert.equal(f.controller.views.length, 0)
  assert.equal(f.events.filter(e => e.type === "permissionResolved").length, 1)
})

test("session deletion cancels retained work and late completion cannot recreate history", async t => {
  const f = await fixture(t)
  f.rate(); await settle(); f.resolved(); f.writes[0]!.ack.resolve(); await settle()
  f.controller.deleted("root"); f.workers.get("a")!.finish(); await settle()
  assert.equal(f.controller.views.length, 0); assert.equal(f.saved().total, 0)
})

test("disable while a dispatched fast write settles retains only confirmed approvals", async t => {
  for (const confirmed of [true, false]) {
    const f = await fixture(t)
    f.rate(); await settle(); f.mode(false)
    assert.equal(f.workers.get("a")!.signal.aborted, false)
    if (confirmed) f.writes[0]!.ack.resolve()
    else f.writes[0]!.ack.reject(Error("write failed"))
    await settle()
    assert.equal(f.workers.get("a")!.signal.aborted, !confirmed)
    if (confirmed) {
      f.workers.get("a")!.finish(); await settle(); assert.equal(f.saved().total, 1)
    } else {
      assert.equal(f.controller.views[0]?.status, "suspended")
      assert.equal(f.saved().total, 0); assert.equal(f.banners.filter(m => m.kind === "approved").length, 0)
    }
  }
})

for (const effect of ["hide", "blocker", "disable", "resolve", "delete", "dispose", "cancel"] as const) {
  test(`fast dispatch reservation: microtask ${effect} produces no write, retained report, history attribution or approval banner`, async t => {
    let queued = false
    const f = await fixture(t, {}, { changed: views => {
      if (queued || !views.some(view => view.autoApproval?.status === "allowing")) return
      queued = true
      queueMicrotask(() => {
        if (effect === "hide") f.hide()
        if (effect === "blocker") void f.ask({ ...request("0"), permission: "read" })
        if (effect === "disable") f.mode(false)
        if (effect === "resolve") f.resolved()
        if (effect === "delete") f.controller.deleted("root")
        if (effect === "dispose") void f.controller.dispose()
        if (effect === "cancel") f.controller.cancelAutoApproval("a")
      })
    } })
    f.rate(); await settle()
    for (const write of f.writes) write.ack.resolve()
    await settle()
    assert.equal(queued, true)
    assert.equal(f.writes.length, 0)
    assert.equal(f.facts.some(fact => fact.type === "dispatched" || fact.type === "confirmed"), false)
    assert.ok(f.facts.every(fact => fact.type === "settled" && fact.result === "not-sent"))
    assert.ok(f.controller.views.every(view => !view.retained))
    f.workers.get("a")!.finish(); await settle()
    assert.equal(f.saved().total, 0)
    assert.equal(f.events.some(event => ["approvalDispatched", "approvalConfirmed", "permissionResolved"].includes(event.type)), false)
    assert.equal(f.totals().activity.autoApproved, 0)
    assert.equal(f.banners.some(message => message.kind === "approved"), false)
  })
}

test("fast dispatch observer reentrancy follows actual once and retains post-dispatch disable/navigation lifecycle", async t => {
  const observed: number[] = []
  const f = await fixture(t, {}, { approval: fact => {
    if (fact.type !== "dispatched") return
    observed.push(f.writes.length)
    f.hide(); f.mode(false); f.resolved()
  } })
  f.rate(); await settle()
  assert.deepEqual(observed, [1])
  assert.equal(f.workers.get("a")!.signal.aborted, false)
  assert.equal(f.writes[0]!.signal.aborted, false)
  f.writes[0]!.ack.resolve(); await settle()
  f.workers.get("a")!.finish(); await settle()
  assert.equal(f.saved().record?.outcome, "auto")
  assert.equal(f.saved().total, 1)
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
  assert.deepEqual(f.banners.map(message => message.kind), ["approved"])
})
