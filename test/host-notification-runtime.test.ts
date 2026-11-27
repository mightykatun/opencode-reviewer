import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import type { FormInfo, OpenCodeEvent, PermissionRequest, SessionInfo, ShellInfo, PersistentPtyInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { ViewerNotifications } from "../src/host-notifications.js"
import type { HostRequest } from "../src/host-types.js"
import type { NotificationMessage } from "../src/notification-types.js"
import type { AncestryReader } from "../src/session-ancestry.js"
import { setupHostNotificationOnly } from "../src/host-notification-runtime.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { parseNotificationConfig } from "../src/notification-config.js"

const location = { directory: "/server/project", workspaceID: "workspace" }
const permission = (id: string, sessionID = "root"): PermissionRequest => ({ id, sessionID,
  action: "shell", resources: ["pwd"], source: { type: "tool", messageID: "assistant", id: "call" } })
type WireForm = Extract<OpenCodeEvent, { type: "form.created" }>["data"]["form"]
const form = (id: string, sessionID = "root"): WireForm => ({ id, sessionID, title: "Question",
  fields: [{ type: "string", key: "answer" }] })
type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function contextFixture(unavailable: "configuration" | "companion" = "configuration", initial: PermissionRequest[] = [],
  connectionID?: string, notificationOptions: Record<string, unknown> = {}) {
  const life = new PluginLifecycle(), banners: NotificationMessage[] = [], signals: AbortSignal[] = []
  const sessions = new Map<string, Pick<SessionInfo, "id" | "parentID" | "title" | "location">>([
    ["root", { id: "root", title: "Root title", location }],
    ["child", { id: "child", parentID: "root", title: "Child", location }],
    ["deep", { id: "deep", parentID: "child", title: "Deep", location }],
    ["unvisited", { id: "unvisited", title: "Unvisited", location }],
    ["foreign", { id: "foreign", title: "Foreign", location: { ...location, workspaceID: "foreign" } }],
  ])
  const permissions = new Map<string, PermissionRequest[] | undefined>([["root", initial]])
  const forms = new Map<string, FormInfo[] | undefined>()
  const background = { active: new Set<string>(), shells: [] as ShellInfo[], terminals: [] as PersistentPtyInfo[] }
  const syncs: string[] = [], unexpected: string[] = []
  /** Further members of root's native family, such as a subagent in a worktree. */
  const family: string[] = []
  let listener: ((event: { details: OpenCodeEvent }) => void) | undefined
  let native: ((event: OpenCodeEvent) => void) | undefined
  let current = "root", serial = 0, backendDisposed = 0
  const hooks = { sync: async (_id: string) => {}, ancestry: (async (id: string) => {
    const value = sessions.get(id)
    if (!value) throw Error("Ancestry unavailable")
    return value.parentID ? "root" : id
  }) as AncestryReader }
  const ctx = {
    location,
    client: { event: { async *subscribe({ signal }: { signal: AbortSignal }) {
      // Native-only unit fixture: no independent fresh marker can admit a replacement.
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
    } }, session: { active: async () => Object.fromEntries([...background.active].map(id => [id, { type: "running" }])) },
      shell: { list: async () => ({ location, data: background.shells }) },
      experimental: { persistentPty: { list: async ({ sessionID }: { sessionID: string }) => background.terminals.filter(value => value.sessionID === sessionID) },
        job: { list: async () => [] } } },
    data: {
      on: (_type: string, callback: typeof native) => { native = callback; return () => { native = undefined } },
      location: { default: () => location },
      listen: (callback: NonNullable<typeof listener>) => { listener = callback; return () => { listener = undefined } },
      session: {
        list: () => [...sessions.values()], get: (id: string) => sessions.get(id),
        family: (root: string) => root === "root" ? ["deep", "child", ...family] : [],
        status: (id: string) => background.active.has(id) ? "running" : "idle",
        sync: async (id: string) => { syncs.push(`session:${id}`); await hooks.sync(id) },
        permission: {
          list: (id: string) => permissions.has(id) ? permissions.get(id) : [],
          invalidate: (id: string) => { syncs.push(`invalidate:${id}`) },
          sync: async (id: string) => { syncs.push(`permission:${id}`) },
        },
        form: {
          list: (id: string) => forms.has(id) ? forms.get(id) : [],
          sync: async (id: string, scope?: typeof location) => {
            if (id === "global") assert.deepEqual(scope, location)
            syncs.push(`form:${id}`)
          },
        },
      },
    },
    ui: { router: { current: () => ({ type: "session", sessionID: current }), navigate: () => {} },
      slot: () => { unexpected.push("slot"); throw Error("Caller owns UI") } },
    keymap: { mode: { current: () => "base" } },
  } as unknown as Plugin.Context
  const options = { notifySound: false, staleReminderSeconds: 0, ...notificationOptions }
  const state: ViewerNotifications = {
    notificationConfig: parseNotificationConfig(options), dependencies: { notifications: () => ({
      async show(message, signal) { banners.push(message); signals.push(signal); return { close() {} } },
      dispose() { backendDisposed++ },
    }) } }
  const records = { location, root: (id: string, signal: AbortSignal) => hooks.ancestry(id, signal),
    project: (request: HostRequest) => ({ request, status: unavailable === "configuration" ? "unavailable" as const : "suspended" as const }) }
  let runtime: NonNullable<ReturnType<typeof setupHostNotificationOnly>>
  const compose = (pluginState: ViewerNotifications) => {
    runtime = setupHostNotificationOnly(ctx, pluginState, life, records)!
    assert.ok(runtime)
    return runtime
  }
  const emit = <T extends OpenCodeEvent["type"]>(type: T, data: EventOf<T>["data"], scope: typeof location | undefined = location, eventID?: string) => {
    serial++
    const details = { type, data, id: eventID ?? `event-${serial}`, created: serial, ...(scope ? { location: scope } : {}),
      durable: { aggregateID: (data as { sessionID?: string }).sessionID, seq: serial, version: 1 } } as unknown as EventOf<T>
    if (type === "server.connected") native?.(details)
    listener?.({ details })
  }
  const ask = (value: PermissionRequest, scope = location) => emit("permission.asked", value, scope)
  const reply = (value: PermissionRequest) => {
    permissions.set(value.sessionID, (permissions.get(value.sessionID) ?? []).filter(item => item.id !== value.id))
    emit("permission.replied", { sessionID: value.sessionID, requestID: value.id, reply: "once" })
  }
  const formReply = (value: WireForm) => {
    forms.set(value.sessionID, (forms.get(value.sessionID) ?? []).filter(item => item.id !== value.id))
    emit("form.replied", { id: value.id, sessionID: value.sessionID, answer: {} })
  }
  const flush = async () => { await tick(); await runtime.refresh.refresh(); await tick() }
  return { life, compose, state, ctx, sessions, family, permissions, forms, background, banners, signals, syncs, unexpected, hooks,
    emit, ask, reply, formReply, flush, listening: () => !!listener, backendDisposed: () => backendDisposed,
    route: (id: string) => { current = id; runtime.visit(id) } }
}

function fixture(unavailable: "configuration" | "companion" = "configuration", initial: PermissionRequest[] = [],
  connectionID?: string, notificationOptions: Record<string, unknown> = {}) {
  const f = contextFixture(unavailable, initial, connectionID, notificationOptions)
  return { ...f, runtime: f.compose(f.state) }
}

test("fallback completion reads shells at fresh family locations without companion membership", async t => {
  const f = fixture(); t.after(() => f.life.stop())
  const remote = { directory: "/server/worktree", workspaceID: "workspace" }
  f.sessions.get("child")!.location = remote
  const reads: string[] = []
  let running = true
  f.ctx.client.shell.list = async input => {
    const scope = input!.location!
    reads.push(scope.directory!)
    return { location: scope, data: scope.directory === remote.directory && running
      ? [{ id: "remote-shell", status: "running", metadata: { sessionID: "child" },
        command: "fixture", cwd: "/unrelated", shell: "bash", file: "/unused", time: { started: 1 } }] : [] } as any
  }
  await f.flush()
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.succeeded", { sessionID: "root" })
  await f.flush()
  assert.ok(reads.includes(remote.directory))
  assert.equal(f.banners.length, 0, "remote shell blocks completion even with idle sessions and no jobs")
  running = false
  await f.flush()
  assert.deepEqual(f.banners.map(value => value.kind), ["ended"])
})

test("fallback ignores unrelated text without extra reads and scopes current job activity to its owner", async t => {
  for (const jobSession of ["unvisited", "child"]) {
    const f = fixture(); t.after(() => f.life.stop())
    await f.flush()
    const pending = deferred<never[]>()
    let reads = 0
    const job = { kind: "image" as const, id: "job", sessionID: jobSession,
      status: "running" as const, time: { started: 1 }, path: "/image", model: "model" }
    f.ctx.client.experimental.job.list = async () => ++reads === 1 ? pending.promise : [job]
    f.emit("session.execution.started", { sessionID: "root" })
    f.emit("session.execution.succeeded", { sessionID: "root" })
    await f.flush()
    assert.equal(reads, 1)
    const syncs = f.syncs.length
    for (let ordinal = 0; ordinal < 100; ordinal++) f.emit("session.text.delta", {
      sessionID: "unvisited", assistantMessageID: "message", ordinal, delta: "text",
    })
    assert.equal(f.syncs.length, syncs)
    assert.equal(reads, 1, "unrelated deltas do not start another completion read")
    f.emit("experimental.job.updated", { info: job }, undefined)
    pending.resolve([])
    await tick()
    assert.deepEqual(f.banners.map(value => value.kind), jobSession === "unvisited" ? ["ended"] : [])
    if (jobSession === "unvisited") assert.equal(reads, 1, "another conversation's job leaves this completion intact")
  }
})

test("notification-only fallback isolates an unreadable independent conversation instead of silencing the current root", async t => {
  const f = fixture(); t.after(() => f.life.stop())
  await f.flush()
  f.hooks.sync = async id => { if (id === "unvisited") throw Error("Independent metadata unavailable") }
  const other = permission("other", "unvisited")
  f.permissions.set("unvisited", [other]); f.ask(other)
  const question = form("healthy-question")
  f.forms.set("root", [question]); f.emit("form.created", { form: question })
  await f.flush(); await f.flush()
  assert.deepEqual(f.banners.map(value => value.kind), ["question"])
})

test("notification-only fallback retires inactive visits without losing a live root or inventing baseline births", async t => {
  const f = fixture(); t.after(() => f.life.stop()); await f.flush()
  const first = permission("still-pending")
  f.permissions.set("root", [first]); f.ask(first); await f.flush()
  for (let index = 0; index < 300; index++) {
    const id = "visited-" + index
    f.sessions.set(id, { id, title: "Visited", location })
    f.permissions.set(id, []); f.forms.set(id, [])
    f.route(id)
  }
  await f.flush()
  const latest = permission("latest", "visited-299")
  f.permissions.set(latest.sessionID, [latest]); f.ask(latest); await f.flush()
  assert.deepEqual(f.banners.map(value => value.sessionID), ["root", "visited-299"])
  assert.ok(f.runtime.views().some(view => view.request.id === first.id))
  assert.equal(f.runtime.notifications.trackedSessions().size, 256)
})


for (const soundOnly of [false, true]) {
  test(`delivered ${soundOnly ? "sound-only" : "banner"} question stays silent after unrelated shell activity with reminders disabled`, async t => {
    const f = fixture("configuration", [], undefined, { notifySound: soundOnly,
      notifications: { question: { banner: !soundOnly, sound: soundOnly } } })
    t.after(() => f.life.stop())
    await f.flush()
    const question = form("question")
    f.forms.set("root", [question]); f.emit("form.created", { form: question }); await f.flush()
    assert.deepEqual(f.banners.map(value => value.title), ["Agent has a question"])
    assert.deepEqual([f.banners[0]?.banner, f.banners[0]?.sound], [!soundOnly, soundOnly])
    f.emit("shell.deleted", { id: "unrelated-shell" })
    assert.equal(f.signals[0]?.aborted, true, "health withdrawal must still cancel the old channel")
    await f.flush(); await f.flush()
    assert.equal(f.banners.length, 1, "healthy reconciliation cannot replay a dispatched initial")
    f.forms.set("root", undefined); await f.flush()
    f.forms.set("root", [question]); await f.flush()
    assert.equal(f.banners.length, 1, "failed form observations also preserve the announcement")
  })
}

test("notification-only fallback waits for background family work and handles location-scoped shell events", async t => {
  const f = fixture(); t.after(() => f.life.stop())
  await f.flush()
  f.background.active.add("deep")
  f.background.shells.push({ id: "background", status: "running", metadata: { sessionID: "deep" },
    command: "fixture", cwd: location.directory, shell: "bash", file: "/unused", time: { started: 1 } })
  f.background.terminals.push({ id: "terminal", sessionID: "child", status: "running" } as PersistentPtyInfo)
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.succeeded", { sessionID: "root" })
  await f.flush(); assert.equal(f.banners.length, 0)
  f.background.active.clear()
  f.emit("session.execution.succeeded", { sessionID: "deep" })
  await f.flush(); assert.equal(f.banners.length, 0)
  f.background.shells.length = 0
  f.emit("shell.deleted", { id: "background" })
  await f.flush(); assert.equal(f.banners.length, 0)
  f.background.terminals.length = 0
  f.emit("persistent-pty.removed", { sessionID: "child", ptyID: "terminal" })
  await f.flush(); assert.deepEqual(f.banners.map(value => value.kind), ["ended"])
  await f.flush(); assert.equal(f.banners.length, 1)
})

for (const unavailable of ["configuration", "companion"] as const) {
  test(`notification-only event births notify without review ${unavailable}; baselines stay silent`, async t => {
    const baseline = permission("baseline"), f = fixture(unavailable, [baseline])
    t.after(() => f.life.stop())
    await f.flush()
    assert.equal(f.banners.length, 0)
    assert.equal(f.runtime.views()[0]?.status, unavailable === "configuration" ? "unavailable" : "suspended")
    assert.deepEqual(f.runtime.views()[0]?.request, { id: "baseline", sessionID: "root", action: "shell", resources: ["pwd"],
      source: { assistantID: "assistant", id: "call" } })
    assert.ok(f.syncs.includes("permission:deep")); assert.ok(f.syncs.includes("form:global"))
    assert.ok(!f.syncs.some(value => value.endsWith(":unvisited") || value.endsWith(":foreign")))
    const fresh = permission("fresh", "deep")
    f.permissions.set("deep", [fresh]); f.ask(fresh); await f.flush()
    assert.equal(f.banners.length, 0, "root native head blocks descendants regardless of birth order")
    f.reply(baseline); await f.flush()
    assert.deepEqual(f.banners.map(value => [value.kind, value.sessionID]), [["attention", "root"]])
    f.ask(fresh); await f.flush(); assert.equal(f.banners.length, 1)
    assert.deepEqual(f.unexpected, [], "no companion, client transport, controller or second app surface")
  })
}

test("native permissions precede root-first full-family forms; terminal notification waits for clear queues", async t => {
  const baseline = permission("baseline"), f = fixture("configuration", [baseline])
  t.after(() => f.life.stop())
  await f.flush()
  const root = form("root-form"), child = form("child-form", "child"), deep = form("deep-form", "deep")
  f.forms.set("root", [root]); f.forms.set("child", [child]); f.forms.set("deep", [deep])
  // The root baseline must block both descendants without notifying itself.
  f.emit("form.created", { form: child }); f.emit("form.created", { form: deep })
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.succeeded", { sessionID: "root" })
  await f.flush(); assert.equal(f.banners.length, 0)
  f.reply(baseline); await f.flush()
  assert.equal(f.banners.length, 0)
  f.formReply(root); await f.flush()
  assert.deepEqual(f.banners.map(value => value.kind), ["question"])
  f.formReply(deep); await f.flush()
  assert.deepEqual(f.banners.map(value => value.kind), ["question", "question"], "public deep-before-child order, not event order")
  f.forms.set("global", [form("global-form", "global")])
  f.formReply(child); await f.flush()
  assert.deepEqual(f.banners.map(value => value.kind), ["question", "question"])
  f.forms.set("global", []); await f.flush()
  assert.deepEqual(f.banners.map(value => value.kind), ["question", "question", "ended"])
  f.emit("session.execution.succeeded", { sessionID: "root" }); await f.flush()
  assert.equal(f.banners.length, 3)
})

test("unknown native queues suspend delivery and cannot be mistaken for empty queues", async t => {
  const f = fixture(); t.after(() => f.life.stop()); await f.flush()
  const fresh = permission("fresh", "deep")
  f.permissions.set("deep", [fresh]); f.permissions.set("root", undefined)
  f.ask(fresh); await f.flush(); assert.equal(f.banners.length, 0)
  f.permissions.set("root", []); await f.flush(); assert.equal(f.banners.length, 1)
  f.permissions.set("child", undefined); await f.flush()
  assert.equal(f.signals[0]?.aborted, true)
  f.permissions.set("child", []); await f.flush()
  assert.equal(f.banners.length, 1, "refresh does not replay an initial permission alert")
})

test("a periodic refresh reconciles visited-family native caches silently", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const f = fixture(); t.after(() => f.life.stop()); await f.flush()
  const baseline = permission("periodic", "deep")
  f.permissions.set("deep", [baseline])
  t.mock.timers.tick(2000); await tick(); await tick()
  assert.equal(f.runtime.views().find(value => value.request.id === baseline.id)?.status, "unavailable")
  assert.equal(f.banners.length, 0, "native cache reconciliation cannot manufacture a birth")
})

test("full-family metadata synchronization handles a deep member listed before its missing parent", async t => {
  const f = fixture(); t.after(() => f.life.stop()); await f.flush()
  const child = f.sessions.get("child")!
  f.sessions.delete("child")
  f.hooks.sync = async id => { if (id === "child") f.sessions.set("child", child) }
  const fresh = permission("fresh", "deep")
  f.permissions.set("deep", [fresh]); f.ask(fresh); await f.flush()
  assert.deepEqual(f.banners.map(value => value.kind), ["attention"])
})

test("another home's events are ignored wherever they occur, and later visits cannot replay earlier births", async t => {
  const f = fixture(); t.after(() => f.life.stop()); await f.flush()
  const foreign = permission("foreign", "foreign")
  f.permissions.set("foreign", [foreign])
  for (const scope of [location, { ...location, workspaceID: "foreign" }]) {
    f.ask(foreign, scope)
    await f.flush(); assert.equal(f.banners.length, 0, "The root's location decides, not the event's")
  }
  const unknown = permission("unknown", "uncached")
  f.permissions.set("uncached", [unknown]); f.ask(unknown, { ...location, workspaceID: "other" })
  await f.flush(); assert.equal(f.banners.length, 0, "An uncached session at another location is not this home's")
  const early = permission("early", "unvisited")
  f.permissions.set("unvisited", [early]); f.ask(early); await f.flush()
  f.route("unvisited"); await f.flush(); assert.equal(f.banners.length, 0)
  f.reply(early); await f.flush()
  const fresh = permission("fresh", "unvisited")
  f.permissions.set("unvisited", [fresh]); f.ask(fresh); await f.flush()
  assert.deepEqual(f.banners.map(value => [value.kind, value.sessionID]), [["attention", "unvisited"]])
})


test("server.connected permanently shuts down the old notification generation", async () => {
  const f = fixture(); await f.flush()
  f.emit("server.connected", { url: "http://replacement.invalid" } as EventOf<"server.connected">["data"])
  await f.runtime.dispose()
  assert.equal(f.listening(), false); assert.equal(f.backendDisposed(), 1)
  const before = f.syncs.length
  f.permissions.set("root", [permission("late")]); f.ask(permission("late")); f.runtime.visit("root")
  await f.flush()
  assert.equal(f.syncs.length, before); assert.equal(f.banners.length, 0)
  await f.life.stop(); await f.life.settled()
})

test("shutdown owns non-cooperative native synchronization through actual settlement", async () => {
  const f = fixture(); await f.flush()
  const late = deferred<void>(), entered = deferred<void>()
  f.hooks.sync = async () => { entered.resolve(); await late.promise }
  const refresh = f.runtime.refresh.refresh(); await entered.promise
  let disposed = false
  const disposal = f.life.stop().then(() => { disposed = true })
  await tick(); assert.equal(disposed, false)
  assert.equal(f.listening(), false)
  const calls = f.syncs.length
  late.resolve(); await disposal; await refresh
  assert.equal(f.syncs.length, calls, "abort cannot start another cache read after the physical read settles")
  await f.life.stop(); await f.life.settled()
})

test("root fallback cleanup remains owned after its ancestry caller rejects", async () => {
  const f = fixture(); await f.flush()
  const physical = deferred<void>(), entered = deferred<void>()
  f.hooks.ancestry = () => {
    entered.resolve()
    return Object.assign(Promise.reject(Error("Caller ended")), { settled: physical.promise })
  }
  f.route("unknown"); await entered.promise
  let disposed = false
  const disposal = f.runtime.dispose().then(() => { disposed = true })
  await tick(); assert.equal(disposed, false)
  physical.resolve(); await disposal
  await f.life.stop(); await f.life.settled()
})

test("descendant failures and interrupted/aborted executions do not produce terminal alerts", async t => {
  const f = fixture("companion"); t.after(() => f.life.stop()); await f.flush()
  f.emit("session.execution.succeeded", { sessionID: "root" }); await f.flush()
  assert.equal(f.banners.length, 0, "snapshot completion has no observed execution birth")
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.failed", { sessionID: "deep", error: { type: "api", message: "Child failed" } })
  f.emit("session.execution.interrupted", { sessionID: "root", reason: "user" })
  await f.flush(); assert.equal(f.banners.length, 0)
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.failed", { sessionID: "root", error: { type: "aborted", message: "Stopped" } })
  await f.flush(); assert.equal(f.banners.length, 0)
  f.emit("session.execution.started", { sessionID: "root" })
  f.emit("session.execution.failed", { sessionID: "root", error: { type: "api", message: "Failed" } })
  await f.flush(); assert.deepEqual(f.banners.map(value => value.kind), ["error"])
})

test("notification backend setup failure does not acquire listeners, polling or UI", async t => {
  const f = fixture(); t.after(() => f.life.stop()); await f.runtime.dispose()
  f.state.dependencies.notifications = () => { throw Error("Desktop unavailable") }
  const records = { location, root: async (id: string) => id, project: (request: HostRequest) => ({ request, status: "unavailable" as const }) }
  assert.equal(setupHostNotificationOnly(f.ctx, f.state, f.life, records), undefined)
  assert.equal(f.listening(), false)
  assert.deepEqual(f.unexpected, [])
})

test("a subagent's permission at another location belongs to its conversation's home", async t => {
  const f = fixture(); t.after(() => f.life.stop()); await f.flush()
  const worktree = { ...location, directory: "/server/project-worktree" }
  f.sessions.set("tree", { id: "tree", parentID: "root", title: "Tree", location: worktree })
  f.family.push("tree")
  const moved = permission("moved", "tree")
  f.permissions.set("tree", [moved]); f.ask(moved, worktree); await f.flush()
  assert.deepEqual(f.banners.map(value => [value.kind, value.sessionID]), [["attention", "root"]],
    "A family spanning locations stays healthy and notifies its root")
})
