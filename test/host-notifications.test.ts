import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import type { FormInfo, OpenCodeEvent, PermissionRequest, SessionInfo, ShellInfo, PersistentPtyInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { CliPluginState } from "../src/cli-plugin.js"
import type { HostRequest } from "../src/host-types.js"
import type { View } from "../src/controller.js"
import type { AncestryReader } from "../src/session-ancestry.js"
import type { HistoryTarget } from "../src/history-records.js"
import type { NotificationBackend, NotificationClick, NotificationMessage } from "../src/notification-types.js"
import { HostNotifications, setupHostNotifications, type HostNotificationCheckpoint } from "../src/host-notifications.js"
import { hostQueueSnapshot, type HostQueueSnapshot } from "../src/host-queue.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import type { PluginDependencies } from "../src/plugin-dependencies.js"

const request = (id: string, sessionID = "root"): HostRequest => ({ id, sessionID, action: "shell", resources: ["pwd"] })
const runningShell = (id: string, sessionID: string): ShellInfo => ({ id, status: "running", metadata: { sessionID },
  command: "fixture", cwd: "/project", shell: "bash", file: "/unused", time: { started: 1 } })
type WireForm = Extract<OpenCodeEvent, { type: "form.created" }>["data"]["form"]
const form = (id: string, sessionID = "root"): WireForm => ({ id, sessionID, title: "Question", fields: [{ type: "string", key: "answer" }] })
type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>

function fixture(options: Record<string, unknown> = {}, resolveRoot: AncestryReader = async id => id,
  backend?: NotificationBackend, dependencies?: PluginDependencies) {
  const sessions = new Map<string, { id: string; parentID?: string; title: string }>([
    ["root", { id: "root", title: "Root title" }], ["child", { id: "child", parentID: "root", title: "Child" }],
    ["deep", { id: "deep", parentID: "child", title: "Deep" }], ["other", { id: "other", title: "Other" }],
  ])
  const permissions = new Map<string, HostRequest[] | undefined>()
  const forms = new Map<string, FormInfo[] | undefined>()
  const active = new Set<string>(), shells: ShellInfo[] = [], terminals: PersistentPtyInfo[] = []
  const work = { active: async () => Object.fromEntries([...active].map(id => [id, { type: "running" }])),
    shells: async () => ({ location: { directory: "/project" }, data: shells }),
    terminals: async (id: string) => terminals.filter(value => value.sessionID === id) }
  const banners: NotificationMessage[] = [], signals: AbortSignal[] = [], navigated: string[] = []
  const opened: { sessionID: string; target: HistoryTarget }[] = []
  let family = ["child", "deep"], mode = "base", current = "root", now = 0, serial = 0
  let nativeOverride: string | undefined, override = false
  let observedQueue: ((root: string) => HostQueueSnapshot) | undefined
  let clicked!: NotificationClick
  const abort = new AbortController()
  const timers = new Set<{ at: number; callback: () => void }>()
  const clock = { now: () => now, after(ms: number, callback: () => void) {
    const timer = { at: now + ms, callback }; timers.add(timer); return () => { timers.delete(timer) }
  } }
  const context = {
    location: { directory: "/project" },
    client: { session: { active: () => work.active() }, shell: { list: () => work.shells() },
      experimental: { persistentPty: { list: ({ sessionID }: { sessionID: string }) => work.terminals(sessionID) } } },
    data: { session: {
      get: (id: string) => sessions.get(id) as SessionInfo | undefined,
      family: (root: string) => root === "root" ? family : [],
      status: (id: string) => active.has(id) ? "running" : "idle",
      permission: { list: (id: string) => (permissions.has(id) ? permissions.get(id) : []) as PermissionRequest[] | undefined },
      form: { list: (id: string) => forms.has(id) ? forms.get(id) : [] },
    }, location: { default: () => ({ directory: "/project" }) } },
    ui: { router: {
      current: () => ({ type: "session", sessionID: current }),
      navigate: (destination: { type: string; sessionID: string }) => { current = destination.sessionID; navigated.push(current) },
    } },
    keymap: { mode: { current: () => mode }, dispatch: () => { throw new Error("Must not toggle sidebar blindly") } },
  } as unknown as Plugin.Context
  const state: CliPluginState = {
    config: parseConfig({ baseURL: "http://localhost", model: "fixture", autoApprove: true, notifySound: false,
      staleReminderSeconds: 0, ...options }), prompts: BUILTIN_PROMPTS, stateRoot: "/unused",
    dependencies: dependencies ?? { notifications: click => {
      clicked = click
      return backend ?? { async show(message, signal) { banners.push(message); signals.push(signal); return { close() {} } }, dispose() {} }
    } },
  }
  const nativeQueue = (root: string): HostQueueSnapshot => {
    if (observedQueue) return observedQueue(root)
    const queue = hostQueueSnapshot(root, {
      session: id => context.data.session.get(id), family: id => context.data.session.family(id),
      permissions: id => context.data.session.permission.list(id),
    })
    if (!override || queue.state === "unknown") return queue
    if (!nativeOverride) return queue.state === "empty" ? queue : { state: "unknown" }
    const value = queue.family.flatMap(id => permissions.get(id) ?? []).find(value => value.id === nativeOverride)
    return value ? { state: "front", family: queue.family, request: { id: value.id, sessionID: value.sessionID } } : { state: "unknown" }
  }
  const host = new HostNotifications(context, state, { resolveRoot, nativeQueue, signal: abort.signal, clock,
    openHistory: (sessionID, target) => { opened.push({ sessionID, target }) } })
  const resume = (checkpoint: HostNotificationCheckpoint, current = context) => new HostNotifications(current, state,
    { resolveRoot, nativeQueue, signal: abort.signal, clock, checkpoint })
  function emit<T extends OpenCodeEvent["type"]>(type: T, data: EventOf<T>["data"], seq = ++serial, eventID = `event-${serial}`) {
    const sessionID = (data as { sessionID?: string }).sessionID
    const event = { type, id: eventID, created: serial, data, location: { directory: "/project" },
      durable: { aggregateID: sessionID, seq, version: 1 } } as unknown as EventOf<T>
    host.event(event)
  }
  const ask = (value: HostRequest) => emit("permission.asked", { ...value, resources: [...value.resources],
    ...(value.source ? { source: { type: "tool", messageID: value.source.assistantID, id: value.source.id } } : {}) } as EventOf<"permission.asked">["data"])
  const reply = (value: HostRequest) => {
    permissions.set(value.sessionID, (permissions.get(value.sessionID) ?? []).filter(item => item.id !== value.id))
    emit("permission.replied", { sessionID: value.sessionID, requestID: value.id, reply: "once" })
  }
  const formBirth = (value: WireForm) => emit("form.created", { form: value })
  const formReply = (value: FormInfo, cancel = false) => {
    forms.set(value.sessionID, (forms.get(value.sessionID) ?? []).filter(item => item.id !== value.id))
    if (cancel) emit("form.cancelled", { id: value.id, sessionID: value.sessionID })
    else emit("form.replied", { id: value.id, sessionID: value.sessionID, answer: {} })
  }
  async function advance(ms: number) {
    now += ms
    for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.callback()
    await settle()
  }
  return { host, state, context, abort, banners, signals, sessions, permissions, forms, active, shells, terminals, work, opened, navigated, timers,
    emit, ask, reply, formBirth, formReply, advance, resume, clicked: () => clicked,
    mode: (value: string) => { mode = value }, route: (value: string) => { current = value; host.routeChanged() },
    family: (ids: string[]) => { family = ids }, native: (value?: string) => { override = true; nativeOverride = value },
    nativeQueue: (read: (root: string) => HostQueueSnapshot) => { observedQueue = read } }
}

test("the CLI constructs the process embedding seam only for its real Linux backend and owns disposal", async () => {
  let constructed = 0, disposed = 0, started!: () => void
  const dispatched = new Promise<void>(resolve => { started = resolve })
  const calls: { command: string; args: readonly string[] }[] = []
  const f = fixture({}, undefined, undefined, { notificationProcesses: () => {
    constructed++
    return {
      start(command, args, _ms, signal, line) {
        assert.equal(signal.aborted, false)
        calls.push({ command, args })
        if (command === "notify-send") { line?.("41"); started() }
        return { result: Promise.resolve({ code: 0, stdout: "41\n" }), cancel() {} }
      },
      dispose() { disposed++ },
    }
  } })
  try {
    assert.equal(constructed, 1)
    f.host.visit("root")
    const value = request("manual")
    f.permissions.set("root", [value])
    f.host.snapshot([{ request: value, status: "suspended" }], true)
    f.ask(value)
    await dispatched
    const banner = calls.find(value => value.command === "notify-send")!
    assert.ok(banner.args.includes("--transient"))
    assert.equal(banner.args.at(-1), "Session needs attention")
    assert.equal(constructed, 1)
  } finally { await f.host.dispose() }
  assert.equal(disposed, 1)
})

test("an explicit notification backend does not construct the lower-level process seam", async () => {
  const f = fixture({}, undefined, undefined, {
    notifications: () => ({ async show() { return undefined }, dispose() {} }),
    notificationProcesses: () => { throw Error("Explicit backend takes precedence") },
  })
  await f.host.dispose()
})

test("V2 event births, not startup/retained snapshots, authorize root-family attention", async () => {
  const f = fixture(); f.host.visit("root")
  const old = request("startup"), fresh = request("fresh", "deep")
  f.permissions.set("root", [old]); f.permissions.set("deep", [fresh])
  f.host.snapshot([{ request: old, status: "unrelated" }, { request: fresh, status: "suspended" }], true)
  await settle(); assert.equal(f.banners.length, 0)
  f.ask(fresh); await settle(); assert.equal(f.banners.length, 0, "disabled snapshot-only native head still blocks")
  f.reply(old)
  f.host.snapshot([{ request: fresh, status: "suspended" }], true)
  await settle()
  assert.deepEqual(f.banners.map(value => [value.kind, value.sessionID, value.body]), [["attention", "root", "Root title"]])
  f.ask(fresh); f.host.snapshot([{ request: fresh, status: "suspended" }], true)
  await settle(); assert.equal(f.banners.length, 1)
  f.reply(fresh); f.host.snapshot([{ request: fresh, status: "complete", retained: true }], true)
  f.ask(fresh); await settle(); assert.equal(f.banners.length, 1)
  const other = request("unvisited", "other")
  f.permissions.set("other", [other]); f.ask(other); f.host.visit("other")
  f.host.snapshot([{ request: other, status: "unavailable" }], true)
  await settle(); assert.equal(f.banners.length, 1, "visiting later cannot replay old births")
  await f.host.dispose()
})

test("inactive conversation visits cannot exhaust notification tracking, while a live interaction remains pinned", async () => {
  const f = fixture()
  try {
    f.host.visit("root")
    const first = request("still-pending")
    f.permissions.set("root", [first]); f.ask(first)
    f.host.snapshot([{ request: first, status: "unavailable" }], true)
    await settle(); assert.equal(f.banners.length, 1)
    for (let index = 0; index < 300; index++) {
      const id = "visited-" + index
      f.sessions.set(id, { id, title: "Visited" })
      f.host.visit(id)
    }
    const latest = request("newest", "visited-299")
    f.permissions.set(latest.sessionID, [latest]); f.ask(latest)
    f.host.snapshot([{ request: first, status: "unavailable" }, { request: latest, status: "unavailable" }], true)
    await settle()
    assert.deepEqual(f.banners.map(value => value.sessionID), ["root", "visited-299"])
    assert.equal(f.signals[0]!.aborted, false, "Inactive eviction must not withdraw the still-pending interaction")
    f.host.visit("visited-0")
    const old = request("before-revisit", "visited-0")
    f.permissions.set(old.sessionID, [old]); f.host.snapshot([{ request: old, status: "unavailable" }], true)
    await settle(); assert.equal(f.banners.length, 2, "Revisiting cannot invent an event birth from a baseline snapshot")
  } finally { await f.host.dispose() }
})

test("proven question continuity resumes reminders only after fresh family health, never from constructor or stale snapshots", async () => {
  const f = fixture({ staleReminderSeconds: 1 }); f.host.visit("root")
  const question = form("pending")
  f.forms.set("root", [question]); f.formBirth(question); f.host.snapshot([], true)
  await settle(); assert.equal(f.banners.length, 1)
  const checkpoint = f.host.checkpoint()
  await f.host.dispose()
  const resumed = f.resume(checkpoint)
  try {
    resumed.snapshot([], false); await f.advance(2000)
    assert.equal(f.banners.length, 1)
    resumed.snapshot([], true); await settle()
    assert.equal(f.banners.length, 1, "No replayed initial after recovery")
    await f.advance(999); assert.equal(f.banners.length, 1)
    await f.advance(1); assert.equal(f.banners.length, 2)
    f.forms.set("root", []); resumed.snapshot([], true)
    await f.advance(2000); assert.equal(f.banners.length, 2, "A missed form resolution is reconciled silently")
  } finally { await resumed.dispose() }
})

test("notification continuity cannot cross a replaced public client or location, and cannot mutate its saved facts", async () => {
  for (const boundary of ["client", "directory", "workspace"] as const) {
    const f = fixture({ staleReminderSeconds: 1 }); f.host.visit("root")
    const pending = request("pending")
    f.permissions.set("root", [pending]); f.ask(pending); f.host.snapshot([{ request: pending, status: "unavailable" }], true)
    await settle()
    const checkpoint = f.host.checkpoint(), saved = checkpoint.permissions.get(pending.id)
    await f.host.dispose()
    const context = { ...f.context, ...(boundary === "client" ? { client: { ...f.context.client } }
      : { location: boundary === "directory" ? { directory: "/other" } : { directory: "/project", workspaceID: "other" } }) }
    const resumed = f.resume(checkpoint, context)
    try {
      resumed.visit("root"); resumed.snapshot([{ request: pending, status: "unavailable" }], true)
      await f.advance(2000)
      assert.equal(f.banners.length, 1, boundary)
      assert.deepEqual(checkpoint.permissions.get(pending.id), saved)
      assert.equal(checkpoint.permissions.get(pending.id)?.target, undefined)
    } finally { await resumed.dispose() }
  }
})

test("permissions precede the public root-first family form queue, independent of event order", async () => {
  const f = fixture(); f.host.visit("root"); f.family(["deep", "child"])
  const p = request("disabled"), baseline = form("baseline"), deep = form("deep-form", "deep"), child = form("child-form", "child")
  f.permissions.set("root", [p]); f.forms.set("root", [baseline]); f.forms.set("deep", [deep]); f.forms.set("child", [child])
  f.host.snapshot([{ request: p, status: "unrelated" }], true)
  f.formBirth(child); f.formBirth(deep); await settle(); assert.equal(f.banners.length, 0)
  f.reply(p); f.host.snapshot([], true); await settle(); assert.equal(f.banners.length, 0, "snapshot-only form remains a blocker")
  f.formReply(baseline); await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["question"])
  assert.equal(f.banners[0]?.sessionID, "root")
  f.formReply(deep, true); await settle(); assert.equal(f.banners.length, 2)
  f.formReply(child); f.formBirth(child); await settle(); assert.equal(f.banners.length, 2)
  await f.host.dispose()
})

test("supplied native permission ownership includes unsupported blockers and unreadable queues fail closed", async () => {
  const f = fixture(); f.host.visit("root")
  const first = request("first"), second = request("second", "child")
  f.permissions.set("root", [first]); f.permissions.set("child", [second]); f.native("first")
  f.ask(second); f.host.snapshot([{ request: second, status: "unavailable" }], true)
  await settle(); assert.equal(f.banners.length, 0)
  f.native("second"); f.host.snapshot([{ request: second, status: "unavailable" }])
  await settle(); assert.equal(f.banners.length, 1, "bridge uses supplied ownership, not event order")
  f.permissions.set("root", undefined); f.host.snapshot([{ request: second, status: "unavailable" }])
  assert.equal(f.signals[0]?.aborted, true)
  f.permissions.set("root", []); f.native(); f.host.snapshot([{ request: second, status: "unavailable" }])
  await settle(); assert.equal(f.banners.length, 1, "undefined native front is not empty while native permissions remain")
  await f.host.dispose()
})

test("native fixture overrides cannot conceal unhealthy later queues or duplicated permission identities", async () => {
  for (const change of ["missing", "owner", "duplicate", "ancestry"] as const) {
    const f = fixture(); f.host.visit("root")
    const front = request("front")
    f.permissions.set("root", [front]); f.native("front"); f.ask(front)
    f.host.snapshot([{ request: front, status: "unavailable" }], true); await settle()
    assert.equal(f.banners.length, 1)
    if (change === "missing") f.permissions.set("deep", undefined)
    if (change === "owner") f.permissions.set("deep", [request("later", "other")])
    if (change === "duplicate") f.permissions.set("deep", [request("front", "deep")])
    if (change === "ancestry") f.sessions.delete("child")
    f.host.snapshot([{ request: front, status: "unavailable" }], true)
    assert.equal(f.signals[0]?.aborted, true, change)
    await f.host.dispose()
  }
})

test("bridge trusts explicit queue observations without independently scanning family or permission caches", async () => {
  const f = fixture(); f.host.visit("root")
  const value = request("front")
  f.nativeQueue(() => ({ state: "front", family: ["root", "deep", "child"], request: value }))
  f.context.data.session.family = () => { throw Error("Bridge must not rescan native family") }
  f.context.data.session.permission.list = () => { throw Error("Bridge must not rescan permissions") }
  f.ask(value); f.host.snapshot([{ request: value, status: "unavailable" }], true); await settle()
  assert.equal(f.banners.length, 1)
  f.nativeQueue(() => ({ state: "empty", family: ["root", "deep", "child"] }))
  f.reply(value); f.host.snapshot([], true)
  f.emit("session.execution.started", { sessionID: "root" }, 10)
  f.emit("session.execution.succeeded", { sessionID: "root" }, 11)
  await settle(); assert.deepEqual(f.banners.map(value => value.kind), ["attention", "ended"])
  await f.host.dispose()
})

test("unknown permission observations never authorize forms or queued terminal notifications", async () => {
  const f = fixture(); f.host.visit("root")
  const question = form("question")
  f.forms.set("root", [question]); f.nativeQueue(() => ({ state: "unknown" }))
  f.formBirth(question); f.host.snapshot([], true)
  f.emit("session.execution.started", { sessionID: "root" }, 10)
  f.emit("session.execution.succeeded", { sessionID: "root" }, 11)
  await settle(); assert.equal(f.banners.length, 0)
  f.nativeQueue(() => ({ state: "empty", family: ["root", "deep", "child"] }))
  f.host.snapshot([], true); await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["question"])
  f.formReply(question); await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["question", "ended"])
  await f.host.dispose()
})

test("malformed and over-budget optional form identities cannot prove an empty queue", async () => {
  for (const change of ["missing", "owner", "duplicate", "empty-id", "budget"] as const) {
    const f = fixture(); f.host.visit("root")
    if (change === "missing") f.forms.set("deep", undefined)
    if (change === "owner") f.forms.set("deep", [form("wrong", "other")])
    if (change === "duplicate") { f.forms.set("deep", [form("shared", "deep")]); f.forms.set("global", [form("shared", "global")]) }
    if (change === "empty-id") f.forms.set("deep", [form("", "deep")])
    if (change === "budget") f.forms.set("deep", Array.from({ length: 16385 }, (_, index) => form(`form-${index}`, "deep")))
    f.host.snapshot([], true)
    f.emit("session.execution.started", { sessionID: "root" }, 10)
    f.emit("session.execution.succeeded", { sessionID: "root" }, 11)
    await settle(); assert.equal(f.banners.length, 0, change)
    f.forms.clear(); f.host.snapshot([], true); await settle()
    assert.deepEqual(f.banners.map(value => value.kind), ["ended"], change)
    await f.host.dispose()
  }
})

test("a known earlier form owns attention while an unreadable later form still cannot prove empty", async () => {
  const f = fixture(); f.host.visit("root")
  const first = form("root-question")
  f.forms.set("root", [first]); f.forms.set("child", undefined)
  f.host.snapshot([], true); f.formBirth(first)
  await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["question"])
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.succeeded", { sessionID: "root" })
  f.formReply(first)
  await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["question"])
  f.forms.set("child", []); f.host.snapshot([], true)
  await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["question", "ended"])
  await f.host.dispose()
})

test("Safe automation waits silently, mode suspension needs attention, and reminders retain native ownership", async () => {
  const f = fixture({ staleReminderSeconds: 1 }); f.host.visit("root")
  const p = request("safe"), disabled = request("disabled")
  f.permissions.set("root", [p]); f.ask(p)
  const safe: View<HostRequest> = { request: p, status: "complete", assessment: { safe: true, desc: "ok" } }
  f.host.snapshot([safe], true); await f.advance(5000); assert.equal(f.banners.length, 0)
  f.host.snapshot([{ ...safe, autoApproval: { status: "countdown", seconds: 1 } }]); await settle(); assert.equal(f.banners.length, 0)
  f.host.snapshot([{ request: p, status: "suspended" }]); await settle(); assert.equal(f.banners.length, 1)
  f.permissions.set("root", [disabled, p]); f.host.snapshot([{ request: p, status: "suspended" }])
  assert.equal(f.signals[0]?.aborted, true)
  await f.advance(3000); assert.equal(f.banners.length, 1)
  f.reply(disabled); await settle(); assert.equal(f.banners.length, 1, "handoff does not replay permission initial attention")
  await f.advance(999); assert.equal(f.banners.length, 1)
  await f.advance(1); assert.equal(f.banners.length, 2)
  f.host.snapshot([{ request: p, status: "suspended" }], false)
  assert.equal(f.signals[1]?.aborted, true)
  await f.host.dispose()
})

test("automatic approval requires matching confirmed dispatch and preserves the child's exact history target", async () => {
  const f = fixture(); f.host.visit("root")
  const automatic = request("auto", "deep"), manual = request("manual"), uncertain = request("uncertain")
  for (const [value, auto] of [[automatic, true], [manual, false], [uncertain, true]] as const) {
    f.host.approval({ type: "confirmed", request: value, automatic: auto })
    f.host.approval({ type: "dispatched", request: value, automatic: auto, approval: value.id })
    assert.equal(f.banners.length, 0, "process delivery is not on the approval critical path")
    f.reply(value); f.host.snapshot([], true)
    f.host.approval({ type: "confirmed", request: { ...value, sessionID: "other" }, automatic: auto, approval: value.id })
    f.host.approval({ type: value === uncertain ? "settled" : "confirmed", request: value, automatic: auto,
      approval: value.id, ...(value === uncertain ? { result: "uncertain" as const } : {}) })
    f.host.approval({ type: "confirmed", request: value, automatic: auto, approval: value.id })
  }
  await settle()
  assert.deepEqual(f.banners.map(value => [value.kind, value.sessionID, value.history]), [
    ["approved", "root", { session: "deep", permission: "auto" }],
  ])
  f.clicked()("root", f.banners[0]?.history)
  assert.deepEqual(f.opened, [{ sessionID: "root", target: { session: "deep", permission: "auto" } }])
  await f.host.dispose()
})

test("only fresh root execution identities notify once; descendants, aborted and interrupted turns stay silent", async () => {
  const f = fixture(); f.host.visit("root"); f.host.snapshot([], true)
  f.emit("session.execution.succeeded", { sessionID: "root" }, 1)
  await settle(); assert.equal(f.banners.length, 0, "no completion replay for an unobserved startup execution")
  f.emit("session.execution.started", { sessionID: "root" }, 10, "root-execution")
  f.emit("session.execution.failed", { sessionID: "deep", error: { type: "api", message: "child failed" } }, 11)
  f.emit("session.execution.succeeded", { sessionID: "root" }, 20)
  f.emit("session.execution.succeeded", { sessionID: "root" }, 20, "duplicate-outcome")
  f.emit("session.execution.failed", { sessionID: "root", error: { type: "api", message: "duplicate failed" } }, 21)
  await settle(); assert.deepEqual(f.banners.map(value => value.kind), ["ended"])
  f.emit("session.execution.started", { sessionID: "root" }, 30)
  f.emit("session.execution.failed", { sessionID: "root", error: { type: "aborted", message: "stopped" } }, 31)
  f.emit("session.execution.succeeded", { sessionID: "root" }, 32)
  f.emit("session.execution.started", { sessionID: "root" }, 40)
  f.emit("session.execution.interrupted", { sessionID: "root", reason: "user" }, 41)
  f.emit("session.execution.failed", { sessionID: "root", error: { type: "api", message: "late" } }, 42)
  await settle(); assert.equal(f.banners.length, 1)
  f.emit("session.execution.started", { sessionID: "root" }, 50)
  f.emit("session.execution.failed", { sessionID: "root", error: { type: "api", message: "root failed" } }, 51)
  await settle(); assert.deepEqual(f.banners.map(value => value.kind), ["ended", "error"])
  await f.host.dispose()
})

test("terminal execution delivery waits for healthy public permission/form reconciliation", async () => {
  const f = fixture(); f.host.visit("root")
  f.permissions.set("deep", [request("baseline", "deep")])
  f.emit("session.execution.started", { sessionID: "root" }, 1)
  f.emit("session.execution.succeeded", { sessionID: "root" }, 2)
  f.host.snapshot([], true); await settle(); assert.equal(f.banners.length, 0)
  f.permissions.set("deep", []); f.forms.set("global", [form("global", "global")])
  f.host.snapshot([], true); await settle(); assert.equal(f.banners.length, 0)
  f.forms.set("global", []); f.host.snapshot([], false); await settle(); assert.equal(f.banners.length, 0)
  f.host.snapshot([], true); f.host.snapshot([], true); await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["ended"])
  await f.host.dispose()
})

test("finished notifications wait for all root-family agents, shells and persistent terminals", async t => {
  for (const kind of ["agent", "shell", "terminal"] as const) {
    const f = fixture(); t.after(() => f.host.dispose())
    f.host.visit("root"); f.host.snapshot([], true)
    // Already running before this root execution: event-only bookkeeping would miss it.
    if (kind === "agent") f.active.add("deep")
    if (kind === "shell") f.shells.push(runningShell("background", "deep"))
    if (kind === "terminal") f.terminals.push({ id: "terminal", sessionID: "child", status: "running" } as PersistentPtyInfo)
    f.emit("session.execution.started", { sessionID: "root" })
    f.emit("session.execution.succeeded", { sessionID: "root" })
    await settle(); await f.advance(5000)
    f.host.snapshot([], true); await settle()
    assert.equal(f.banners.length, 0, kind)
    f.active.clear(); f.shells.length = 0; f.terminals.length = 0
    f.host.snapshot([], true); await settle()
    assert.deepEqual(f.banners.map(value => value.kind), ["ended"], kind)
    f.host.snapshot([], true); await settle()
    assert.equal(f.banners.length, 1, "completion is delivered only once")
  }
})

test("server activity blocks completion even when the native status cache says idle; unrelated work does not", async t => {
  const f = fixture(); t.after(() => f.host.dispose())
  f.context.data.session.status = () => "idle"
  f.active.add("deep")
  f.active.add("other")
  f.shells.push(runningShell("other-shell", "other"))
  f.terminals.push({ id: "other-terminal", sessionID: "other", status: "running" } as PersistentPtyInfo)
  f.host.visit("root"); f.host.snapshot([], true)
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.succeeded", { sessionID: "root" })
  await settle(); assert.equal(f.banners.length, 0)
  f.active.delete("deep"); f.host.snapshot([], true); await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["ended"])
})

test("unavailable background observations suppress only completion, not manual attention or errors", async t => {
  for (const kind of ["active", "shells", "terminals"] as const) {
    const f = fixture(); t.after(() => f.host.dispose())
    f.work[kind] = async () => { throw Error("Background state unavailable") }
    f.host.visit("root"); f.host.snapshot([], true)
    f.emit("session.execution.started", { sessionID: "root" })
    f.emit("session.execution.succeeded", { sessionID: "root" })
    await settle(); assert.equal(f.banners.length, 0, kind)
    const value = request("manual")
    f.permissions.set("root", [value]); f.ask(value)
    f.host.snapshot([{ request: value, status: "unavailable" }], true)
    await settle(); assert.deepEqual(f.banners.map(value => value.kind), ["attention"])
    f.emit("session.execution.started", { sessionID: "root" })
    f.emit("session.execution.failed", { sessionID: "root", error: { type: "api", message: "failed" } })
    f.reply(value); f.host.snapshot([], true); await settle()
    assert.deepEqual(f.banners.map(value => value.kind), ["attention", "error"])
  }
})

test("malformed activity, shell scope and terminal ownership cannot prove completion", async t => {
  for (const change of ["active", "shell-scope", "shell-status", "terminal-owner", "terminal-status"] as const) {
    const f = fixture(); t.after(() => f.host.dispose())
    if (change === "active") f.work.active = async () => ({ deep: { type: "unknown" } })
    if (change === "shell-scope") f.work.shells = async () => ({ location: { directory: "/elsewhere" }, data: [] })
    if (change === "shell-status") f.shells.push({ ...runningShell("bad", "root"), status: "unknown" } as unknown as ShellInfo)
    if (change === "terminal-owner") f.work.terminals = async () => [{ id: "bad", sessionID: "other", status: "exited" } as PersistentPtyInfo]
    if (change === "terminal-status") f.terminals.push({ id: "bad", sessionID: "root", status: "unknown" } as unknown as PersistentPtyInfo)
    f.host.visit("root"); f.host.snapshot([], true)
    f.emit("session.execution.started", { sessionID: "root" })
    f.emit("session.execution.succeeded", { sessionID: "root" })
    await settle(); assert.equal(f.banners.length, 0, change)
  }
})

test("completion checks retain physical ownership after timeout and fence activity, new turns and disposal", async t => {
  for (const change of ["activity", "turn", "timeout", "dispose"] as const) {
    const f = fixture(); t.after(() => f.host.dispose())
    let release!: (value: PersistentPtyInfo[]) => void, calls = 0
    f.work.terminals = () => { calls++; return new Promise(resolve => { release = resolve }) }
    f.host.visit("root"); f.host.snapshot([], true)
    f.emit("session.execution.started", { sessionID: "root" })
    f.emit("session.execution.succeeded", { sessionID: "root" })
    await settle(); assert.equal(calls, 1)
    let disposed = false, disposal: Promise<void> | undefined
    if (change === "activity") f.emit("session.shell.started", { sessionID: "deep", shell: { id: "new" } as ShellInfo })
    if (change === "turn") f.emit("session.execution.started", { sessionID: "root" })
    if (change === "timeout") {
      await new Promise(resolve => setTimeout(resolve, 5100))
      f.host.snapshot([], true); await settle()
      assert.equal(calls, 1, "timeout does not release physical read ownership")
    }
    if (change === "dispose") {
      disposal = f.host.dispose().then(() => { disposed = true })
      await settle(); assert.equal(disposed, false)
    }
    // Only the first transaction is held; subsequent family reads settle normally.
    f.work.terminals = async () => []
    release([]); await settle()
    assert.equal(f.banners.length, 0, change)
    if (disposal) { await disposal; assert.equal(disposed, true) }
  }
})

test("latest action lease waits for native keymap mode, clones targets and never blindly toggles sidebar", async () => {
  const f = fixture(); f.mode("modal")
  const old = f.host.beginClick("root", { session: "child", permission: "old" }); old.commit()
  const target = { session: "deep", permission: "new" }
  const current = f.host.beginClick("other", target); target.permission = "mutated"; current.commit()
  assert.equal(old.current(), false); assert.equal(old.signal.aborted, true)
  await f.advance(100); assert.deepEqual(f.navigated, [])
  f.mode("base"); await f.advance(100)
  assert.deepEqual(f.navigated, ["other"])
  assert.deepEqual(f.opened, [{ sessionID: "other", target: { session: "deep", permission: "new" } }])
  current.commit(); await f.advance(100); assert.equal(f.opened.length, 1)
  f.route("root"); assert.equal(current.current(), false)
  await f.host.dispose()
})

test("route changes, new ordinary actions, deletion and lifecycle shutdown revoke late clicks", async () => {
  for (const action of ["route", "ordinary", "root", "child", "shutdown"] as const) {
    const f = fixture(); f.mode("modal")
    const lease = f.host.beginClick("root", { session: "child", permission: "p" }); lease.commit()
    if (action === "route") f.route("other")
    else if (action === "ordinary") f.host.click("other")
    else if (action === "shutdown") f.abort.abort()
    else f.host.deleted(action)
    f.mode("base"); await f.advance(100)
    assert.deepEqual(f.opened, [])
    assert.deepEqual(f.navigated, action === "ordinary" ? ["other"] : [])
    assert.equal(lease.current(), false)
    await f.host.dispose()
  }
})

test("bounded ancestry slots retain actual settled ownership after caller failure and disposal", async () => {
  let calls = 0, release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  const f = fixture({}, () => { calls++; return Object.assign(Promise.reject(new Error("bounded caller failure")), { settled }) })
  f.host.visit("unknown1"); f.host.visit("unknown2"); await settle()
  await f.advance(2000); f.host.visit("unknown3"); await settle()
  assert.equal(calls, 2, "timed-out/read-failed physical work still owns both slots")
  let disposed = false
  const disposal = f.host.dispose().then(() => { disposed = true })
  await settle(); assert.equal(disposed, false)
  release(); await disposal; assert.equal(disposed, true)
})

test("failed initial visit retries on healthy publications with its original birth boundary", async t => {
  let calls = 0
  const f = fixture({}, async () => {
    calls++
    if (calls === 1) throw new Error("initial ancestry unavailable")
    return "root"
  })
  t.after(() => f.host.dispose())
  const old = request("before-visit"), fresh = request("after-visit")
  f.permissions.set("root", [old, fresh]); f.ask(old)
  const root = f.sessions.get("root")!
  f.sessions.delete("root"); f.host.visit("root")
  f.ask(fresh)
  const views: View<HostRequest>[] = [old, fresh].map(request => ({ request, status: "unavailable" }))
  f.host.snapshot(views, true); await settle()
  assert.equal(calls, 1)
  assert.equal(f.banners.length, 0)
  for (let i = 0; i < 5; i++) f.host.snapshot(views, true)
  f.host.visit("root"); await settle()
  assert.equal(calls, 1, "repeated publication/re-entry cannot bypass failure backoff")
  await f.advance(2000)
  f.host.snapshot(views, true); await settle()
  assert.equal(calls, 2, "healthy publication retries without another route visit")
  assert.equal(f.banners.length, 0, "resolved ancestry alone does not prove a native queue")
  f.sessions.set("root", root); f.host.snapshot(views, true); await settle()
  assert.equal(f.banners.length, 0, "the pre-visit birth remains silent and blocks the queue")
  f.reply(old); f.host.snapshot([views[1]!], true); await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["attention"], "post-visit birth survives the failed lookup and later re-entry")
  f.host.visit("other"); f.host.visit("root")
  f.ask(old); f.ask(fresh); f.host.snapshot([views[1]!], true); await settle()
  assert.equal(f.banners.length, 1, "re-entry and duplicate births cannot replay attention")
  assert.equal(calls, 2)
})

test("a visit denied by saturated physical slots retries only after actual settlement", async t => {
  const releases = new Map<string, () => void>(), calls: string[] = []
  let active = 0, maximum = 0
  const f = fixture({}, id => {
    calls.push(id); active++; maximum = Math.max(maximum, active)
    if (id === "root") {
      const value = Promise.resolve("root")
      return Object.assign(value, { settled: value.then(() => { active-- }) })
    }
    const settled = new Promise<void>(resolve => { releases.set(id, resolve) }).then(() => { active-- })
    return Object.assign(Promise.reject(new Error("logical lookup failure")), { settled })
  })
  t.after(async () => { for (const release of releases.values()) release(); await f.host.dispose() })
  const old = request("saturated-before-visit"), fresh = request("saturated-after-visit")
  f.permissions.set("root", [old, fresh]); f.ask(old)
  const root = f.sessions.get("root")!
  f.host.visit("unknown1"); f.host.visit("unknown2"); await settle()
  f.sessions.delete("root"); f.host.visit("root")
  f.ask(fresh)
  const views: View<HostRequest>[] = [old, fresh].map(request => ({ request, status: "unavailable" }))
  f.host.snapshot(views, true); await settle()
  assert.deepEqual(calls, ["unknown1", "unknown2"])
  await f.advance(2000)
  f.host.visit("root")
  for (let i = 0; i < 5; i++) f.host.snapshot(views, true)
  await settle()
  assert.equal(calls.length, 2, "logical failure and elapsed backoff never free physical slots")
  // Recover the first visit from native metadata so its own failed read need not
  // retry ahead of the capacity-denied root when the physical slot becomes free.
  f.sessions.set("unknown1", { id: "unknown1", title: "Recovered visit" })
  releases.get("unknown1")!(); await settle()
  assert.deepEqual(calls, ["unknown1", "unknown2", "root"], "settlement publication retries the retained root visit")
  assert.equal(maximum, 2)
  assert.equal(active, 1, "the second failed read still owns its cleanup lease")
  f.sessions.set("root", root); f.host.snapshot(views, true); await settle()
  assert.equal(f.banners.length, 0, "capacity recovery does not replay the pre-visit birth")
  f.reply(old); f.host.snapshot([views[1]!], true); await settle()
  assert.deepEqual(f.banners.map(value => value.kind), ["attention"])
  f.host.visit("other"); f.host.visit("root")
  f.host.snapshot([views[1]!], true); await settle()
  assert.equal(f.banners.length, 1)
  assert.equal(calls.length, 3)
})

test("event births during asynchronous root registration survive, but missing native ancestry never grants ownership", async () => {
  const releases = new Map<string, (root: string) => void>()
  const f = fixture({}, id => new Promise(resolve => { releases.set(id, resolve) }))
  const root = f.sessions.get("root")!
  f.sessions.delete("root"); f.host.visit("root")
  const value = request("during-visit", "deep")
  f.permissions.set("deep", [value]); f.ask(value)
  f.host.snapshot([{ request: value, status: "unavailable" }], true)
  await settle(); assert.equal(f.banners.length, 0)
  f.sessions.set("root", root)
  f.host.visit("root")
  for (const release of releases.values()) release("root")
  await settle(); f.host.snapshot([{ request: value, status: "unavailable" }], true)
  await settle(); assert.equal(f.banners.length, 1)
  f.sessions.delete("child"); f.host.snapshot([{ request: value, status: "unavailable" }], true)
  assert.equal(f.signals[0]?.aborted, true)
  f.abort.abort(); await f.host.dispose()
})

test("a failed public metadata observer revokes attention without throwing into approval observers", async () => {
  const f = fixture(); f.host.visit("root")
  const value = request("observer")
  f.permissions.set("root", [value]); f.ask(value)
  f.host.snapshot([{ request: value, status: "unavailable" }], true); await settle()
  assert.equal(f.banners.length, 1)
  f.context.data.session.get = () => { throw new Error("native metadata unavailable") }
  assert.doesNotThrow(() => f.host.snapshot([{ request: value, status: "unavailable" }], true))
  assert.equal(f.signals[0]?.aborted, true)
  assert.doesNotThrow(() => f.host.approval({ type: "dispatched", request: value, automatic: true }))
  assert.doesNotThrow(() => f.host.approval({ type: "confirmed", request: value, automatic: true }))
  await f.host.dispose()
})

test("optional notification factory failures and disabled config cannot stop runtime setup", () => {
  const f = fixture()
  f.state.dependencies.notifications = () => { throw new Error("observer failure") }
  assert.equal(setupHostNotifications(f.context, f.state, { resolveRoot: async id => id, nativeQueue: () => ({ state: "unknown" }),
    signal: f.abort.signal }), undefined)
  f.state.config!.notify = false
  assert.equal(setupHostNotifications(f.context, f.state, { resolveRoot: async id => id, nativeQueue: () => ({ state: "unknown" }),
    signal: f.abort.signal }), undefined)
  void f.host.dispose()
})
