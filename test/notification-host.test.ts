import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import type { Event, Message, Session, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { NotificationHost } from "../src/notification-host.js"
import { NotificationPolicy } from "../src/notification-policy.js"
import { parseNotificationConfig } from "../src/notification-config.js"
import type { NotificationBackend, NotificationMessage } from "../src/notification-types.js"
import type { HistoryTarget } from "../src/history-records.js"
import type { View } from "../src/controller.js"
import { Controller } from "../src/controller.js"
import { PendingRefresh } from "../src/pending-refresh.js"
import { SessionModes, type AncestryReader } from "../src/session-mode.js"

const request = (id = "p", sessionID = "root"): PermissionRequest => ({ id, sessionID, permission: "bash", patterns: [], always: [], metadata: {} })
function fixture(resolve: AncestryReader = async id => id, options: Record<string, unknown> = {},
  readQuestions?: (signal: AbortSignal) => Promise<readonly QuestionRequest[]>, backend?: NotificationBackend) {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const sessions = new Map<string, { id: string; parentID?: string; title: string }>([
    ["root", { id: "root", title: "Root title" }], ["child", { id: "child", parentID: "root", title: "Child" }],
    ["deep", { id: "deep", parentID: "child", title: "Deep" }], ["other", { id: "other", title: "Other" }],
  ])
  const messages = new Map<string, Message[]>(), pending = new Map<string, PermissionRequest[]>()
  const banners: NotificationMessage[] = [], navigated: string[] = []
  const opened: { sessionID: string; history: HistoryTarget }[] = []
  const timers = new Set<{ at: number; callback: () => void }>()
  let now = 1, dialog = false, status: "idle" | "busy" | "retry" = "idle"
  let current = "root"
  const clock = { now: () => now, after(ms: number, callback: () => void) {
    const timer = { at: now + ms, callback }; timers.add(timer); return () => { timers.delete(timer) }
  } }
  const api = {
    event: { on(type: string, handler: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(handler)
      return () => { listeners.get(type)!.delete(handler) }
    } },
    state: { session: {
      get: (id: string) => sessions.get(id) as Session | undefined,
      messages: (id: string) => messages.get(id) ?? [],
      permission: (id: string) => pending.get(id) ?? [],
      question: () => [], status: () => ({ type: status }),
    } },
    route: { get current() { return { name: "session", params: { sessionID: current } } },
      navigate(_name: string, params: { sessionID: string }) { current = params.sessionID; navigated.push(params.sessionID) } },
    ui: { dialog: { get open() { return dialog } } }, lifecycle: { signal: new AbortController().signal },
  } as unknown as TuiPluginApi
  const questions = new Map<string, { id: string; sessionID: string; questions: [] }>()
  const policy = new NotificationPolicy(parseNotificationConfig({ notifySound: false, staleReminderSeconds: 0, ...options }), true, backend ?? {
    async show(message) { banners.push(message); return { close() {} } }, dispose() {},
  }, clock)
  const host = new NotificationHost(api, policy, resolve, readQuestions ?? (async () => [...questions.values()]), clock,
    (sessionID, history) => opened.push({ sessionID, history }))
  function emit(type: string, properties: unknown, id = "event") {
    const value = properties as { id: string; sessionID: string; questions: []; requestID: string }
    if (type === "question.asked") questions.set(value.id, value)
    if (type === "question.replied" || type === "question.rejected") questions.delete(value.requestID)
    for (const listener of listeners.get(type) ?? []) listener({ type, properties, id } as Event)
  }
  function message(value: Partial<Message> & { role: Message["role"]; id: string }, sessionID = "root") {
    const m = { sessionID, time: { created: 1 }, ...value } as Message
    const list = messages.get(sessionID) ?? []
    const index = list.findIndex(v => v.id === m.id)
    if (index < 0) list.push(m); else list[index] = m
    messages.set(sessionID, list); emit("message.updated", { info: m })
  }
  async function advance(ms: number) {
    now += ms
    for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.callback()
    await settle()
  }
  return { host, policy, banners, navigated, opened, listeners, sessions, pending, questions, timers, emit, message, advance,
    route: (session: string) => { current = session },
    dialog: (value: boolean) => { dialog = value }, status: (value: typeof status) => { status = value },
    tick: () => advance(2000) }
}

test("only event-born requests in visited roots notify; baseline snapshots and unrelated roots stay silent", async () => {
  const f = fixture(); f.host.snapshot([], true); f.host.visit("root")
  const old: View = { request: request("old"), status: "unavailable" }
  f.host.snapshot([old]); await settle(); assert.equal(f.banners.length, 0)
  f.emit("permission.asked", request("new"))
  f.host.snapshot([old, { request: request("new"), status: "unrelated" }]); await settle()
  assert.equal(f.banners.length, 1)
  f.emit("question.asked", { id: "unrelated", sessionID: "other", questions: [] })
  await settle(); assert.equal(f.banners.length, 1)
  f.host.visit("other"); await settle(); assert.equal(f.banners.length, 1)
  f.emit("question.asked", { id: "new-question", sessionID: "child", questions: [] }); await settle()
  assert.equal(f.banners.length, 1, "questions wait behind all native permissions")
  for (const requestID of ["new", "old"]) f.emit("permission.replied", { requestID, sessionID: "root", reply: "once" })
  f.host.snapshot([]); await settle()
  assert.equal(f.banners[1]?.body, "Root title"); assert.equal(f.banners[1]?.sessionID, "root")
  f.emit("question.asked", { id: "deep-question", sessionID: "deep", questions: [] }); await settle()
  assert.equal(f.banners.length, 2, "deep descendants have no native root input prompt in the pinned host")
  f.emit("question.replied", { requestID: "new-question", sessionID: "child", answers: [] })
  f.emit("question.asked", { id: "new-question", sessionID: "child", questions: [] }); await settle()
  assert.equal(f.banners.length, 2); f.host.dispose()
})

test("request events arriving during root visitation survive asynchronous baseline registration", async () => {
  let release!: (value: string) => void
  const f = fixture(() => new Promise(resolve => { release = resolve }))
  f.host.snapshot([], true)
  f.sessions.delete("root"); f.host.visit("root")
  f.emit("question.asked", { id: "during-visit", sessionID: "root", questions: [] })
  await settle(); assert.equal(f.banners.length, 0)
  f.sessions.set("root", { id: "root", title: "Root title" }); release("root")
  await f.tick()
  await settle(); assert.equal(f.banners.length, 1)
  assert.equal(f.banners[0]?.body, "Root title"); f.host.dispose()
})

test("zero-delay confirmation retains dispatched attribution after native resolution; manual footer stays silent", async () => {
  const f = fixture(); f.host.visit("root")
  for (const automatic of [true, false]) {
    const req = request(automatic ? "automatic" : "manual")
    f.emit("permission.asked", req); f.host.snapshot([{ request: req, status: "complete", assessment: { safe: true, desc: "fixture" }, autoApproval: { status: "allowing" } }])
    f.host.fact({ type: "dispatched", request: req, automatic })
    f.emit("permission.replied", { requestID: req.id, sessionID: "root", reply: "once" })
    f.host.snapshot([])
    f.host.fact({ type: "confirmed", request: req, automatic })
    f.host.fact({ type: "settled", request: req, automatic })
  }
  await settle(); assert.deepEqual(f.banners.map(m => m.title), ["Reviewer approved a permission"])
  assert.deepEqual(f.banners[0]?.history, { session: "root", permission: "automatic" })
  f.host.dispose()
})

test("approval notifications retain each child's permission target after native resolution", async () => {
  const f = fixture(); f.host.visit("root")
  for (const session of ["root", "child", "deep"]) {
    const req = request("approved-" + session, session)
    f.emit("permission.asked", req)
    f.host.snapshot([{ request: req, status: "complete", assessment: { safe: true, desc: "fixture" } }])
    f.host.fact({ type: "dispatched", request: req, automatic: true })
    f.emit("permission.replied", { requestID: req.id, sessionID: session, reply: "once" })
    f.host.snapshot([])
    f.host.fact({ type: "confirmed", request: req, automatic: true })
  }
  await settle()
  assert.deepEqual(f.banners.map(m => [m.sessionID, m.history]), ["root", "child", "deep"].map(session =>
    ["root", { session, permission: "approved-" + session }]))
  const first = f.banners[0]!
  f.host.click(first.sessionID, first.history)
  assert.deepEqual(f.opened, [{ sessionID: "root", history: { session: "root", permission: "approved-root" } }])
  f.host.dispose()
})

test("latest approval click waits for dialogs, keeps its own target, and opens once", async () => {
  const f = fixture(); f.dialog(true)
  f.host.click("root", { session: "child", permission: "old" })
  const staleClick = [...f.timers].find(timer => timer.at === 101)!
  await f.advance(1000)
  assert.deepEqual(f.navigated, []); assert.deepEqual(f.opened, [])
  const target = { session: "other", permission: "new" }
  f.host.click("other", target); target.permission = "mutated"
  f.dialog(false); staleClick.callback(); assert.deepEqual(f.navigated, [])
  await f.advance(100)
  assert.deepEqual(f.navigated, ["other"])
  assert.deepEqual(f.opened, [{ sessionID: "other", history: { session: "other", permission: "new" } }])
  await f.advance(1000); assert.equal(f.opened.length, 1)
  f.host.dispose()
})

test("deleted roots/children, route changes, newer ordinary clicks, and disposal cancel deferred history navigation", async () => {
  for (const action of ["root", "child", "route", "ordinary", "dispose"]) {
    const f = fixture(); f.dialog(true)
    f.host.click("root", { session: "child", permission: "p" })
    if (action === "dispose") f.host.dispose()
    else if (action === "route") f.route("other")
    else if (action === "ordinary") f.host.click("other")
    else f.emit("session.deleted", { info: { id: action } })
    f.dialog(false); await f.advance(1000)
    assert.deepEqual(f.navigated, []); assert.deepEqual(f.opened, [])
    f.host.dispose()
  }
})

test("root completion requires a new turn and final message; retries, question pauses, tool steps and children stay silent", async () => {
  const f = fixture()
  f.host.snapshot([], true)
  f.message({ id: "old", role: "user" }); f.host.visit("root")
  f.emit("session.idle", { sessionID: "root" }); await f.tick(); assert.equal(f.banners.length, 0)
  f.message({ id: "user", role: "user" })
  f.status("busy"); f.emit("session.status", { sessionID: "root", status: { type: "busy" } })
  f.message({ id: "a1", role: "assistant", parentID: "user", finish: "tool-calls", time: { created: 2, completed: 3 } })
  f.status("idle"); f.emit("session.idle", { sessionID: "root" }); await f.tick(); assert.equal(f.banners.length, 0)
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] }); await settle()
  f.message({ id: "a2", role: "assistant", parentID: "user", finish: "stop", time: { created: 4, completed: 5 } })
  f.emit("session.idle", { sessionID: "root" }); await f.tick(); assert.equal(f.banners.length, 1)
  f.emit("question.replied", { requestID: "q", sessionID: "root", answers: [] })
  f.emit("session.idle", { sessionID: "root" }); await f.tick()
  f.emit("session.idle", { sessionID: "root" }); await f.tick()
  assert.deepEqual(f.banners.map(m => m.kind), ["question", "ended"])
  f.message({ id: "child-user", role: "user" }, "child")
  f.message({ id: "child-a", role: "assistant", parentID: "child-user", finish: "stop", time: { created: 6, completed: 7 } }, "child")
  f.emit("session.idle", { sessionID: "child" }); await f.tick(); assert.equal(f.banners.length, 2)
  f.host.dispose()
})

test("fatal errors notify once; aborted turns and recovered retry/overflow errors do not become failures", async () => {
  const f = fixture(); f.host.snapshot([], true); f.host.visit("root")
  f.message({ id: "u1", role: "user" })
  f.status("retry"); f.emit("session.error", { sessionID: "root", error: { name: "ContextOverflowError" } })
  await f.tick(); assert.equal(f.banners.length, 0)
  f.message({ id: "a1", role: "assistant", parentID: "u1", error: { name: "APIError" } } as never)
  f.status("idle"); f.emit("session.idle", { sessionID: "root" }); await f.tick()
  f.emit("session.idle", { sessionID: "root" }); await f.tick(); assert.equal(f.banners[0]?.kind, "error")
  f.message({ id: "u2", role: "user" })
  f.emit("session.error", { sessionID: "root", error: { name: "MessageAbortedError" } })
  f.emit("session.idle", { sessionID: "root" }); await f.tick(); assert.equal(f.banners.length, 1)
  f.message({ id: "u3", role: "user" })
  f.emit("session.error", { sessionID: "root", error: { name: "ContextOverflowError" } })
  f.message({ id: "a3", role: "assistant", parentID: "u3", finish: "stop", time: { created: 8, completed: 9 } })
  f.emit("session.idle", { sessionID: "root" }); await f.tick()
  assert.deepEqual(f.banners.map(m => m.kind), ["error", "ended"]); f.host.dispose()
})

test("click respects native dialogs and deleted targets; disposal removes event subscriptions", () => {
  const f = fixture(); f.host.visit("root")
  f.dialog(true); f.host.click("root"); assert.equal(f.navigated.length, 0)
  f.dialog(false); f.host.click("root"); assert.deepEqual(f.navigated, ["root"])
  f.host.click("missing"); assert.equal(f.navigated.length, 1)
  f.emit("session.deleted", { info: { id: "root" } })
  f.host.click("root"); assert.equal(f.navigated.length, 1, "deletion defeats stale public metadata")
  f.host.dispose(); f.host.click("root"); assert.equal(f.navigated.length, 1)
  assert.ok([...f.listeners.values()].every(set => !set.size))
})

test("native priority includes silent baseline blockers and hands reminders off after a full interval", async () => {
  const f = fixture(undefined, { staleReminderSeconds: 10 })
  f.host.snapshot([], true)
  f.questions.set("baseline", { id: "baseline", sessionID: "child", questions: [] })
  f.host.visit("root"); await settle()
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] }); await settle()
  await f.advance(10000)
  assert.equal(f.banners.length, 0, "an older child question blocks initial notifications and reminders without replay")
  f.emit("question.replied", { requestID: "baseline", sessionID: "child", answers: [] })
  await settle(); assert.equal(f.banners[0]?.title, "Agent has a question")
  await f.advance(9999); assert.equal(f.banners.length, 1)
  await f.advance(1); assert.equal(f.banners[1]?.title, "Agent has a question (Reminder)")
  const p = request("p")
  f.emit("permission.asked", p)
  f.host.snapshot([{ request: p, status: "complete", assessment: { safe: false, desc: "fixture" } }]); await settle()
  f.host.click("root"); f.host.visit("other")
  f.emit("question.asked", { id: "other", sessionID: "other", questions: [] }); await settle()
  await f.advance(10000)
  assert.deepEqual(f.banners.slice(-2).map(m => [m.kind, m.sessionID]), [["unsafe", "root"], ["question", "other"]])
  f.emit("permission.replied", { requestID: "p", sessionID: "root", reply: "once" }); f.host.snapshot([])
  f.emit("question.rejected", { requestID: "other", sessionID: "other" })
  await settle() // Returning to the front starts a new actionable question episode.
  const before = f.banners.length
  await f.advance(9999); assert.equal(f.banners.length, before)
  await f.advance(1); assert.equal(f.banners.at(-1)?.title, "Agent has a question (Reminder)")
  f.emit("session.deleted", { info: { id: "root" } })
  await f.advance(20000); assert.equal(f.banners.length, before + 1)
  await f.host.dispose(); assert.equal(f.timers.size, 0)
})

test("public question reconciliation stops missed resolutions, never admits baseline notifications", async () => {
  const f = fixture(undefined, { staleReminderSeconds: 10 })
  f.host.snapshot([], true)
  f.host.visit("root"); await settle()
  f.emit("question.asked", { id: "q", sessionID: "child", questions: [] }); await settle()
  await f.advance(10000); assert.equal(f.banners.length, 2)
  f.questions.delete("q") // Native resolution without the public event reaching this instance.
  await f.advance(2000)
  await f.advance(10000); assert.equal(f.banners.length, 2)
  f.questions.set("backlog", { id: "backlog", sessionID: "root", questions: [] })
  await f.advance(2000); await f.advance(10000); assert.equal(f.banners.length, 2)
  await f.host.dispose()
})

test("pending question reads retain ownership and event-raced results cannot resurrect resolved questions", async () => {
  let calls = 0, resolve!: (questions: QuestionRequest[]) => void
  const f = fixture(undefined, { staleReminderSeconds: 10 }, async () => {
    calls++
    return new Promise(yes => { resolve = yes })
  })
  f.host.snapshot([], true)
  f.host.visit("root"); await settle()
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] }); await settle()
  await f.advance(10000); assert.equal(calls, 1); assert.equal(f.banners.length, 0)
  f.emit("question.rejected", { requestID: "q", sessionID: "root" })
  resolve([{ id: "q", sessionID: "root", questions: [] }]); await settle()
  await f.advance(2000); assert.equal(calls, 2)
  await f.host.dispose()
  resolve([{ id: "q", sessionID: "root", questions: [] }]); await settle()
  await f.advance(10000); assert.equal(f.banners.length, 0); assert.equal(f.timers.size, 0)
})

test("question read outages withdraw question delivery and recovery restarts the reminder interval", async () => {
  let fail = false
  const f = fixture(undefined, { staleReminderSeconds: 10 }, async () => {
    if (fail) throw new Error("public list unavailable")
    return [{ id: "q", sessionID: "root", questions: [] }]
  })
  f.host.snapshot([], true)
  f.host.visit("root"); f.host.visit("other"); await settle()
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] })
  const p = request("p", "other")
  f.emit("permission.asked", p); f.host.snapshot([{ request: p, status: "unavailable" }]); await settle()
  fail = true; await f.advance(2000)
  await f.advance(10000)
  assert.equal(f.banners.filter(m => m.kind === "question").length, 1)
  assert.equal(f.banners.filter(m => m.kind === "attention").length, 2)
  fail = false; await f.advance(2000)
  assert.equal(f.banners.filter(m => m.kind === "question").length, 2)
  await f.advance(9999); assert.equal(f.banners.filter(m => m.kind === "question").length, 2)
  await f.advance(1); assert.equal(f.banners.filter(m => m.kind === "question").length, 3)
  await f.host.dispose()
})

test("question deadline expiry retains the actual read slot through late settlement", async () => {
  let calls = 0, release!: (value: QuestionRequest[]) => void, signal!: AbortSignal
  const f = fixture(undefined, { staleReminderSeconds: 1 }, async current => {
    calls++; signal = current
    return new Promise(resolve => { release = resolve })
  })
  f.host.snapshot([], true)
  f.host.visit("root"); await settle()
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] }); await settle()
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
  await settle(); assert.equal(signal.aborted, true)
  await f.advance(10000); assert.equal(calls, 1); assert.equal(f.banners.length, 0)
  release([{ id: "q", sessionID: "root", questions: [] }]); await settle()
  await f.advance(2000); assert.equal(calls, 2)
  await f.host.dispose(); release([]); await settle()
  assert.equal(f.banners.length, 0); assert.equal(f.timers.size, 0)
})

test("host publishes queue and review outcomes atomically across a snapshot-only handoff", async () => {
  const f = fixture(undefined, { staleReminderSeconds: 1 })
  f.host.snapshot([], true); f.host.visit("root"); await settle()
  const a = request("a"), b = request("b")
  f.emit("permission.asked", a); f.emit("permission.asked", b)
  f.host.snapshot([{ request: a, status: "analyzing" }, { request: b, status: "complete", assessment: { safe: false, desc: "old report" } }])
  await f.advance(5000); assert.equal(f.banners.length, 0)
  // Reconciliation removes a as a new mode revision starts b's replacement review.
  f.host.snapshot([{ request: b, status: "identifying", autoApproval: { status: "cancelled" } }])
  await f.advance(5000); assert.equal(f.banners.length, 0)
  f.host.snapshot([{ request: b, status: "complete", assessment: { safe: true, desc: "replacement" }, autoApproval: { status: "cancelled" } }])
  await settle(); assert.deepEqual(f.banners.map(m => m.title), ["Session needs attention"])
  f.host.snapshot([{ request: b, status: "analyzing", autoApproval: { status: "cancelled" } }])
  await f.advance(5000); assert.equal(f.banners.length, 1)
  await f.host.dispose()
})

test("W4: questions cannot outrun an unknown initial permission baseline", async () => {
  const f = fixture()
  f.host.visit("root"); await settle()
  f.pending.set("child", [request("baseline", "child")])
  f.emit("question.asked", { id: "fresh", sessionID: "root", questions: [] })
  await settle()
  assert.deepEqual(f.banners, [])
  await f.host.dispose()
})

test("W4: event-born question admission recovers on healthy polling after ancestry failure", async () => {
  let calls = 0
  const f = fixture(async () => { calls++; throw new Error("metadata temporarily unavailable") })
  f.host.snapshot([], true)
  f.host.visit("root"); await settle()
  f.sessions.delete("child")
  f.emit("question.asked", { id: "recover", sessionID: "child", questions: [] })
  await settle(); assert.equal(calls, 1)
  f.sessions.set("child", { id: "child", parentID: "root", title: "Child" })
  await f.tick(); await settle()
  assert.deepEqual(f.banners.map(m => m.kind), ["question"])
  await f.host.dispose()
})

for (const session of ["root", "child"]) test(`permission baseline integration: held/failed/raced reads preserve ${session} silent blockers`, async t => {
  const f = fixture(undefined, { staleReminderSeconds: 10 })
  const controller = new Controller(async () => null, () => {
    if (!controller.reconciling) f.host.snapshot(controller.pendingViews)
  }, { reviewOptions: { reviewBash: false, reviewEdits: false } })
  let resolve!: (requests: PermissionRequest[]) => void, reject!: (error: Error) => void
  const refresh = new PendingRefresh(controller, () => new Promise((yes, no) => { resolve = yes; reject = no }), new AbortController().signal,
    healthy => f.host.snapshot(controller.pendingViews, healthy))
  t.after(async () => { refresh.dispose(); await controller.dispose(); await f.host.dispose() })
  f.host.visit("root"); await settle()
  let wait = refresh.refresh(); await settle()
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] }); await settle()
  assert.equal(f.banners.length, 0)
  reject(new Error("offline")); await wait
  wait = refresh.refresh(); await settle()
  controller.deleted("unknown") // Invalidates this read, including an empty result.
  resolve([]); await wait; assert.equal(f.banners.length, 0)
  wait = refresh.refresh(); await settle()
  resolve([request("silent", session)]); await wait; await settle()
  await f.advance(10000); assert.equal(f.banners.length, 0)
  wait = refresh.refresh(); await settle(); resolve([]); await wait; await settle()
  assert.deepEqual(f.banners.map(m => m.title), ["Agent has a question"])
  await f.advance(9999); assert.equal(f.banners.length, 1)
  await f.advance(1); assert.equal(f.banners[1]?.title, "Agent has a question (Reminder)")
})

test("reconciliation notification batching cannot expose a question between permission removal and insertion", async t => {
  const f = fixture()
  const controller = new Controller(async () => null, () => {
    if (!controller.reconciling) f.host.snapshot(controller.pendingViews)
  }, { reviewOptions: { reviewBash: false, reviewEdits: false } })
  t.after(async () => { await controller.dispose(); await f.host.dispose() })
  controller.reconcile([request("old")], controller.revision)
  f.host.snapshot(controller.pendingViews, true); f.host.visit("root"); await settle()
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] })
  controller.reconcile([request("new", "child")], controller.revision)
  await settle(); assert.deepEqual(f.banners, [])
})

test("capacity release readmits a third event-born question without extra births", async () => {
  const releases = new Map<string, (root: string) => void>()
  const f = fixture(id => new Promise(resolve => releases.set(id, resolve)))
  f.host.snapshot([], true); f.host.visit("root"); await settle()
  for (const id of ["a", "b", "c"]) f.emit("question.asked", { id, sessionID: id, questions: [] })
  await settle(); assert.equal(releases.size, 2)
  f.sessions.set("a", { id: "a", title: "A", parentID: "root" }); releases.get("a")!("root")
  await settle(); assert.equal(releases.size, 3)
  f.emit("question.rejected", { requestID: "b", sessionID: "b" })
  f.sessions.set("c", { id: "c", title: "C", parentID: "root" }); releases.get("c")!("root")
  releases.get("b")!("root"); await settle()
  assert.equal(f.banners.length, 1)
  f.emit("question.replied", { requestID: "a", sessionID: "a" }); await settle()
  assert.equal(f.banners.length, 2)
  await f.host.dispose()
})

test("action-time leases immediately invalidate old work, including route away and back", () => {
  const f = fixture(), aborted: string[] = []
  const first = f.host.beginClick("root", { session: "child", permission: "first" })
  first.signal.addEventListener("abort", () => aborted.push("first"))
  const second = f.host.beginClick("other")
  assert.deepEqual(aborted, ["first"])
  first.commit(); assert.deepEqual(f.navigated, [])
  f.route("other"); f.host.routeChanged(); f.route("root"); f.host.routeChanged()
  second.commit(); assert.deepEqual(f.navigated, [])
  f.host.dispose()
})

test("notification ancestry admission owns actual metadata reads after deadline and disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending: { id: string; signal: AbortSignal; release: (v: { id: string }) => void }[] = []
  const modes = new SessionModes({ read: async () => true, write: async () => {}, flush: async () => {} },
    (id, signal) => new Promise(resolve => pending.push({ id, signal, release: resolve })))
  let admissions = 0
  const f = fixture((id, signal) => { admissions++; return modes.root(id, signal) })
  try {
    f.host.visit("unknown-a"); f.host.visit("unknown-b"); await settle()
    t.mock.timers.tick(5000); await settle()
    for (let n = 0; n < 30; n++) { f.host.visit(`unknown-${n}`); await settle() }
    assert.equal(pending.length, 2)
    assert.equal(admissions, 2, "host capacity remains occupied, not merely rejected by the lower layer")
    pending[0]!.release({ id: "unknown-a" }); await settle()
    f.host.visit("recovered"); await settle()
    assert.equal(admissions, 3); assert.equal(pending.length, 3)
    await f.host.dispose()
    assert.equal(pending[2]!.signal.aborted, true)
    assert.equal(f.banners.length, 0)
  } finally {
    await f.host.dispose()
    for (const p of pending) p.release({ id: p.id })
    await settle()
  }
})

for (const session of ["root", "child"]) test(`fresh permission waits for authoritative ${session} baseline through held, failed and incomplete publications`, async t => {
  const f = fixture(undefined, { staleReminderSeconds: 10 })
  const controller = new Controller(async () => null, () => {
    if (!controller.reconciling) f.host.snapshot(controller.pendingViews)
  }, { reviewOptions: { reviewBash: false, reviewEdits: false } })
  let resolve!: (requests: PermissionRequest[]) => void, reject!: (error: Error) => void
  const refresh = new PendingRefresh(controller, () => new Promise((yes, no) => { resolve = yes; reject = no }), new AbortController().signal,
    healthy => f.host.snapshot(controller.pendingViews, healthy))
  t.after(async () => { refresh.dispose(); await controller.dispose(); await f.host.dispose() })
  f.host.visit("root"); await settle()
  let wait = refresh.refresh(); await settle()
  const fresh = request("z-fresh"), baseline = request("a-baseline", session)
  f.emit("permission.asked", fresh); controller.asked(fresh)
  await f.advance(10000); assert.equal(f.banners.length, 0, "a stalled startup read cannot establish native priority")
  reject(new Error("offline")); await wait
  // An incomplete publication must not consume the event birth in host or policy.
  f.host.snapshot([], false); f.host.snapshot(controller.pendingViews)
  await f.advance(10000); assert.equal(f.banners.length, 0)
  wait = refresh.refresh(); await settle(); resolve([baseline, fresh]); await wait
  await f.advance(10000); assert.equal(f.banners.length, 0, "snapshot-only baseline blocks silently")
  wait = refresh.refresh(); await settle(); resolve([fresh]); await wait; await settle()
  assert.deepEqual(f.banners.map(m => m.title), ["Session needs attention"])
  await f.advance(9999); assert.equal(f.banners.length, 1)
  await f.advance(1); assert.equal(f.banners[1]?.title, "Session needs attention (Reminder)")
})

test("fresh permission waits for the entire baseline ancestry and recovers without another birth", async () => {
  const f = fixture()
  f.host.visit("root"); await settle()
  f.sessions.set("a-child", { id: "a-child", parentID: "missing-parent", title: "Child" })
  const fresh: View = { request: request("fresh"), status: "unavailable" }
  const baseline: View = { request: request("baseline", "a-child"), status: "unrelated" }
  f.emit("permission.asked", fresh.request)
  f.host.snapshot([baseline, fresh], true); await settle()
  assert.equal(f.banners.length, 0, "a present session with missing parent is still unknown ancestry")
  f.sessions.set("missing-parent", { id: "missing-parent", parentID: "root", title: "Parent" })
  f.emit("session.updated", { info: f.sessions.get("missing-parent") }); await settle()
  assert.deepEqual(f.banners.map(m => m.kind), ["attention"], "resolved deep descendant does not own the native root queue")
  await f.host.dispose()
})

for (const soundOnly of [false, true]) test(`permission health and queue loss cancel pending ${soundOnly ? "sound" : "banner"} delivery without consuming recovery eligibility`, async () => {
  const attempts: { message: NotificationMessage; signal: AbortSignal; release: () => void }[] = []
  const delivered: NotificationMessage[] = []
  const f = fixture(undefined, { notifySound: soundOnly, staleReminderSeconds: 1,
    notifications: { attention: { banner: !soundOnly, sound: soundOnly } } }, undefined, {
    async show(message, signal) {
      await new Promise<void>(resolve => attempts.push({ message, signal, release: resolve }))
      if (!signal.aborted) delivered.push(message)
      return { close() {} }
    }, dispose() {},
  })
  const fresh: View = { request: request("z-fresh"), status: "unavailable" }
  f.host.snapshot([], true); f.host.visit("root"); await settle()
  f.emit("permission.asked", fresh.request); f.host.snapshot([fresh]); await settle()
  assert.equal(attempts.length, 1)
  f.host.snapshot([], false)
  assert.equal(attempts[0]!.signal.aborted, true)
  attempts[0]!.release(); await settle(); await f.advance(2000)
  assert.deepEqual(delivered, []); assert.equal(attempts.length, 1)
  f.host.snapshot([fresh], true); await settle(); assert.equal(attempts.length, 2)
  f.host.snapshot([{ request: request("a-baseline"), status: "unrelated" }, fresh], true)
  assert.equal(attempts[1]!.signal.aborted, true)
  attempts[1]!.release(); await settle()
  f.emit("permission.replied", { requestID: fresh.request.id, sessionID: "root", reply: "once" })
  f.host.snapshot([], true); await f.advance(10000)
  assert.equal(attempts.length, 2); assert.deepEqual(delivered, [], "resolved queued request never replays")
  await f.host.dispose()
})

for (const kind of ["question", "permission"] as const) for (const baseline of [false, true]) {
  test(`healthy ${kind} removal recovers one completed turn behind ${baseline ? "snapshot-only" : "event-born"} child blocker`, async () => {
    let fail = false
    const f = fixture(undefined, {}, async () => {
      if (fail) throw new Error("question list unavailable")
      return [...f.questions.values()]
    })
    f.host.snapshot([], true); f.host.visit("root"); await settle()
    if (kind === "question") {
      const q = { id: "blocker", sessionID: "child", questions: [] as [] }
      if (baseline) { f.questions.set(q.id, q); await f.tick() }
      else f.emit("question.asked", q)
    } else {
      if (!baseline) f.emit("permission.asked", request("blocker", "child"))
      f.host.snapshot([{ request: request("blocker", "child"), status: "unrelated" }], true)
    }
    await settle()
    assert.equal(f.banners.length, baseline ? 0 : 1)
    f.message({ id: "user", role: "user" })
    f.message({ id: "final", role: "assistant", parentID: "user", finish: "stop", time: { created: 2, completed: 3 } })
    f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
    assert.equal(f.banners.filter(m => m.kind === "ended").length, 0)
    if (kind === "question") {
      f.questions.delete("blocker"); fail = true; await f.tick(); await f.advance(100)
      assert.equal(f.banners.filter(m => m.kind === "ended").length, 0, "failed list is not a resolution")
      fail = false; await f.tick()
    } else {
      f.host.snapshot([], false); await f.advance(100)
      assert.equal(f.banners.filter(m => m.kind === "ended").length, 0, "unhealthy omission is not a resolution")
      f.host.snapshot([], true)
    }
    await f.advance(100)
    assert.equal(f.banners.filter(m => m.kind === "ended").length, 1, "healthy removal needs no repeated idle event")
    for (let n = 0; n < 3; n++) { f.host.snapshot([], true); await f.tick(); await f.advance(100) }
    f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
    assert.equal(f.banners.filter(m => m.kind === "ended").length, 1)
    await f.host.dispose()
  })
}

for (const condition of ["busy", "retry", "cancelled", "aborted-message", "tool-calls", "incomplete", "baseline-turn", "new-turn", "permission", "question", "unknown", "unhealthy-permissions"]) {
  test(`question reconciliation cannot manufacture completion with ${condition}`, async () => {
    const f = fixture()
    f.host.snapshot([], true)
    if (condition === "baseline-turn") f.message({ id: "user", role: "user" })
    f.host.visit("root"); await settle()
    if (condition !== "baseline-turn") f.message({ id: "user", role: "user" })
    f.emit("question.asked", { id: "remove", sessionID: "child", questions: [] })
    f.message({ id: "final", role: "assistant", parentID: "user", finish: condition === "tool-calls" ? "tool-calls" : "stop",
      time: condition === "incomplete" ? { created: 2 } : { created: 2, completed: 3 },
      ...(condition === "aborted-message" ? { error: { name: "MessageAbortedError", data: { message: "cancelled" } } } : {}) })
    f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
    if (condition === "busy" || condition === "retry") f.status(condition)
    if (condition === "cancelled") f.emit("session.error", { sessionID: "root", error: { name: "MessageAbortedError" } })
    if (condition === "new-turn") f.message({ id: "new-user", role: "user" })
    if (condition === "permission") f.host.snapshot([{ request: request("remaining", "deep"), status: "unavailable" }], true)
    if (condition === "question" || condition === "unknown") f.questions.set("remaining", { id: "remaining", sessionID: condition === "question" ? "deep" : "unknown", questions: [] })
    if (condition === "unhealthy-permissions") f.host.snapshot([], false)
    f.questions.delete("remove")
    for (let n = 0; n < 3; n++) { await f.tick(); await f.advance(100) }
    assert.deepEqual(f.banners.filter(m => m.kind === "ended" || m.kind === "error"), [])
    await f.host.dispose()
  })
}

test("reconciliation recovers final errors and deduplicates by the actual turn across later idle and ended outcomes", async () => {
  const f = fixture(); f.host.snapshot([], true); f.host.visit("root"); await settle()
  f.message({ id: "user", role: "user" })
  f.emit("question.asked", { id: "q", sessionID: "root", questions: [] })
  f.message({ id: "final", role: "assistant", parentID: "user", error: { name: "APIError" } } as never)
  f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
  f.questions.delete("q"); await f.tick(); await f.advance(100)
  assert.deepEqual(f.banners.map(m => m.kind), ["question", "error"])
  f.message({ id: "final", role: "assistant", parentID: "user", finish: "stop", time: { created: 2, completed: 3 } })
  await f.tick(); await f.advance(100)
  f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
  assert.deepEqual(f.banners.map(m => m.kind), ["question", "error"])
  f.message({ id: "next-user", role: "user" })
  f.message({ id: "next-final", role: "assistant", parentID: "next-user", finish: "stop", time: { created: 4, completed: 5 } })
  f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
  assert.deepEqual(f.banners.map(m => m.kind), ["question", "error", "ended"])
  await f.host.dispose()
})

test("missing and malformed question baselines defer final outcomes until healthy recovery", async () => {
  let release!: (value: QuestionRequest[]) => void, malformed = false
  const f = fixture(undefined, {}, () => malformed ? Promise.resolve(null as never) : new Promise(resolve => { release = resolve }))
  f.host.snapshot([], true); f.host.visit("root"); await settle()
  f.message({ id: "user", role: "user" })
  f.message({ id: "final", role: "assistant", parentID: "user", finish: "stop", time: { created: 2, completed: 3 } })
  f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
  assert.equal(f.banners.length, 0)
  release(null as never); await settle(); malformed = true
  await f.tick(); await f.advance(100); assert.equal(f.banners.length, 0)
  malformed = false; await f.tick(); release([]); await settle(); await f.advance(100)
  assert.deepEqual(f.banners.map(m => m.kind), ["ended"])
  await f.host.dispose()
})

test("healthy question removal cancels pending attention before delivering the actual completed outcome", async () => {
  let release!: () => void, questionSignal!: AbortSignal
  const delivered: NotificationMessage[] = []
  const f = fixture(undefined, { staleReminderSeconds: 1 }, undefined, {
    async show(message, signal) {
      if (message.kind === "question") {
        questionSignal = signal
        await new Promise<void>(resolve => { release = resolve })
      }
      if (!signal.aborted) delivered.push(message)
      return { close() {} }
    }, dispose() {},
  })
  f.host.snapshot([], true); f.host.visit("root"); await settle()
  f.emit("question.asked", { id: "q", sessionID: "child", questions: [] }); await settle()
  f.message({ id: "user", role: "user" })
  f.message({ id: "final", role: "assistant", parentID: "user", finish: "stop", time: { created: 2, completed: 3 } })
  f.emit("session.idle", { sessionID: "root" }); await f.advance(100)
  f.questions.delete("q"); await f.tick()
  assert.equal(questionSignal.aborted, true)
  release(); await settle(); await f.advance(100)
  assert.deepEqual(delivered.map(m => m.kind), ["ended"])
  await f.advance(10000); assert.deepEqual(delivered.map(m => m.kind), ["ended"])
  await f.host.dispose()
})
