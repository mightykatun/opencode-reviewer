import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import type { FormInfo, OpenCodeEvent, PermissionRequest, SessionInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { CliPluginState } from "../src/cli-plugin.js"
import type { setupHostHistory } from "../src/host-history-runtime.js"
import type { NotificationMessage } from "../src/notification-types.js"
import type { AncestryReader } from "../src/session-mode.js"
import { setupHostNotificationOnly } from "../src/host-notification-runtime.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { parseConfig } from "../src/config.js"
import { parseNotificationConfig } from "../src/notification-config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"

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

function fixture(unavailable: "configuration" | "companion" = "configuration", initial: PermissionRequest[] = []) {
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
  const syncs: string[] = [], unexpected: string[] = []
  let listener: ((event: { details: OpenCodeEvent }) => void) | undefined
  let current = "root", serial = 0, backendDisposed = 0
  const hooks = { sync: async (_id: string) => {}, ancestry: (async (id: string) => {
    const value = sessions.get(id)
    if (!value) throw Error("Ancestry unavailable")
    return value.parentID ? "root" : id
  }) as AncestryReader }
  const ctx = {
    location,
    client: new Proxy({}, { get: (_target, key) => { unexpected.push(String(key)); throw Error("No client transport") } }),
    data: {
      location: { default: () => location },
      listen: (callback: NonNullable<typeof listener>) => { listener = callback; return () => { listener = undefined } },
      session: {
        list: () => [...sessions.values()], get: (id: string) => sessions.get(id),
        family: (root: string) => root === "root" ? ["deep", "child"] : [],
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
  const options = { notifySound: false, staleReminderSeconds: 0 }
  const state: CliPluginState = { stateRoot: "/unused", prompts: BUILTIN_PROMPTS,
    notificationConfig: parseNotificationConfig(options), dependencies: { notifications: () => ({
      async show(message, signal) { banners.push(message); signals.push(signal); return { close() {} } },
      dispose() { backendDisposed++ },
    }) }, ...(unavailable === "configuration" ? { configError: "Invalid review configuration" }
      : { config: parseConfig({ baseURL: "http://fixture.invalid/v1", model: "unused", autoApprove: true, ...options }) }) }
  const records = { location, history: { root: (id: string, signal: AbortSignal) => hooks.ancestry(id, signal) } } as unknown as ReturnType<typeof setupHostHistory>
  const runtime = setupHostNotificationOnly(ctx, state, life, records)!
  assert.ok(runtime)
  const emit = <T extends OpenCodeEvent["type"]>(type: T, data: EventOf<T>["data"], scope: typeof location | undefined = location) => {
    serial++
    listener?.({ details: { type, data, id: `event-${serial}`, created: serial, ...(scope ? { location: scope } : {}),
      durable: { aggregateID: (data as { sessionID?: string }).sessionID, seq: serial, version: 1 } } as unknown as EventOf<T> })
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
  return { life, runtime, state, ctx, sessions, permissions, forms, banners, signals, syncs, unexpected, hooks,
    emit, ask, reply, formReply, flush, listening: () => !!listener, backendDisposed: () => backendDisposed,
    route: (id: string) => { current = id; runtime.visit(id) } }
}

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

test("off-scope events are ignored and later visits cannot replay earlier births", async t => {
  const f = fixture(); t.after(() => f.life.stop()); await f.flush()
  const wrong = permission("wrong")
  f.permissions.set("root", [wrong]); f.ask(wrong, { ...location, workspaceID: "other" })
  await f.flush(); assert.equal(f.banners.length, 0)
  const foreign = permission("foreign", "foreign")
  f.permissions.set("foreign", [foreign]); f.ask(foreign)
  await f.flush(); assert.equal(f.banners.length, 0)
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
  const records = { location } as ReturnType<typeof setupHostHistory>
  assert.equal(setupHostNotificationOnly(f.ctx, f.state, f.life, records), undefined)
  assert.equal(f.listening(), false)
  assert.deepEqual(f.unexpected, [])
})
