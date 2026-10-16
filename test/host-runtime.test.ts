import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { CliRenderEvents } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { setupHostRuntime, setupHostRecovery } from "../src/host-runtime.js"
import { createRoot, getOwner, onCleanup } from "solid-js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import type { NotificationBackend } from "../src/notification-types.js"
import { SessionModeStore } from "../src/session-mode.js"
import path from "node:path"
import { setupCli, type CliPluginState } from "../src/cli-plugin.js"
import type { FormInfo } from "@opencode/client"

const location = { directory: "/server/project" }
const companion = { protocol: 1 as const, hostVersion: "2.0.26", epoch: "10000000-1000-4000-8000-100000000000", location,
  project: { id: "project", directory: "/server", canonical: "/server" } }
const pending = (id: string) => ({ id, sessionID: "root", action: "unknown", resources: ["scope"] })
async function fixture(options: { notify?: boolean; formSync?: () => Promise<void>; sessionSync?: () => Promise<void>;
  backend?: NotificationBackend; unavailable?: "configuration" | "companion"; connectionID?: string;
  startupFailure?: "companion" | "configuration" | "unobserved" | "conflicting"; recovery?: boolean;
  location?: { directory: string; workspaceID?: string }; reverseEvents?: boolean } = {}) {
  const location: { directory: string; workspaceID?: string } = options.location ?? companion.location
  const scopedCompanion = { ...companion, location: { directory: location.directory,
    ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}) } }
  const life = new PluginLifecycle(), calls: string[] = [], ancestryReads: string[] = []
  const commands: { id: string; run: () => Promise<void>; enabled?: () => boolean }[] = []
  const renderer = Object.assign(new EventEmitter(), { width: 140, height: 40, requestRender: () => calls.push("render") })
  const listeners = new Set<(event: any) => void>()
  const slots = new Set<unknown>(), markers: string[] = []
  let markerAvailable = () => {}
  const state = { requests: [pending("first")], epoch: companion.epoch, list: async () => ({ location, data: state.requests }),
    nativeRequests: undefined as ReturnType<typeof pending>[] | undefined,
    forms: [] as FormInfo[],
    route: { type: "home" } as { type: "home" } | { type: "session"; sessionID: string } }
  const ctx = {
    location,
    client: { event: { async *subscribe({ signal }: { signal: AbortSignal }) {
      yield { type: "server.connected", id: "event-initial" }
      while (!signal.aborted) {
        if (!markers.length) {
          const aborted = () => markerAvailable()
          try { await new Promise<void>(resolve => { markerAvailable = resolve; signal.addEventListener("abort", aborted, { once: true }) }) }
          finally { signal.removeEventListener("abort", aborted) }
        }
        signal.throwIfAborted()
        const id = markers.shift()
        if (id) yield { type: "server.connected", id }
      }
    } }, rpc: () => ({ handshake: async () => ({ ...scopedCompanion, epoch: state.epoch }) }),
      session: { get: async ({ sessionID }: { sessionID: string }) => { ancestryReads.push(sessionID);
        return { id: sessionID, location, ...(sessionID === "child" ? { parentID: "root" } : {}) } } },
      permission: { request: { list: () => state.list() } } },
    data: { listen: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback); calls.push("off") } },
      on: (type: string, callback: (event: any) => void) => {
        const listen = ({ details }: { details: { type: string } }) => { if (details.type === type) callback(details) }
        listeners.add(listen); return () => { listeners.delete(listen) }
      },
      session: { list: () => [{ id: "root", location }],
        get: (id: string) => ({ id, location, ...(id === "child" ? { parentID: "root" } : {}) }), family: () => ["root"],
        sync: async (id: string) => { calls.push("session:" + id); await options.sessionSync?.() },
        permission: { invalidate: (id: string) => calls.push("invalidate:" + id), sync: async (id: string) => { calls.push("sync:" + id) },
           list: () => state.nativeRequests ?? state.requests }, form: { sync: async () => { calls.push("form"); await options.formSync?.() },
             list: (id: string) => id === "root" ? state.forms : [] } } },
    keymap: { mode: { current: () => "base" }, layer: (factory: () => { commands: typeof commands }) => {
      const owned = factory().commands
      commands.push(...owned)
      if (getOwner()) onCleanup(() => { for (const command of owned) commands.splice(commands.indexOf(command), 1) })
    },
      commands: () => [{ id: "session.sidebar.toggle" }], dispatch: (id: string) => calls.push("dispatch:" + id) },
    renderer,
    ui: { slot: (value: { render: () => unknown }) => {
      slots.add(value)
      // Exercise only the null command-owner component, not source-test JSX or
      // simulated terminal presentation. Real panel mounting stays host-tested.
      let dispose = () => {}
      if (options.recovery && value.render.name === "registerCommands")
        createRoot(stop => { dispose = stop; assert.equal(value.render(), null) })
      return () => { dispose(); slots.delete(value) }
    }, router: { current: () => state.route,
      navigate: (route: typeof state.route) => { state.route = route } }, toast: { show: () => {} } },
  } as unknown as Plugin.Context
  // Saved modes need a nonreplaceable namespace, just like the history fixture.
  const root = await mkdtemp("/tmp/reviewer-runtime-source-")
  const dependencies = { notifications: () => options.backend ?? ({ show: async () => undefined, dispose: () => {} }) }
  let pluginState: CliPluginState = { ...(options.unavailable === "configuration" ? { configError: "Invalid configuration" }
    : { config: parseConfig({ baseURL: "http://localhost:40999", model: "unused", notify: options.notify ?? false }) }),
    ...(options.unavailable === "companion" ? {} : { companion: scopedCompanion }), connectionID: options.connectionID ?? (options.recovery ? "event-initial" : undefined), stateRoot: root, prompts: BUILTIN_PROMPTS,
    dependencies }
  if (options.startupFailure) {
    state.route = { type: "session", sessionID: "root" }
    const cli = { ...ctx, options: { baseURL: "http://fixture.invalid/v1", model: options.startupFailure === "configuration" ? "" : "unused",
      notifySound: false, staleReminderSeconds: 0 },
      client: { ...ctx.client, event: { async *subscribe() {
        if (options.startupFailure !== "unobserved") yield { type: "server.connected", id: "event-initial" }
      } }, rpc: () => ({ handshake: async () => { throw Error("Companion unavailable") } }) },
      data: { ...ctx.data, on: (_type: string, listener: (event: { id: string }) => void) => {
        if (options.startupFailure === "conflicting") listener({ id: "event-conflict" })
        return () => {}
      } },
    } as unknown as Plugin.Context
    pluginState = { ...await setupCli(cli, life, { ...dependencies, adapterOnly: true }), stateRoot: root }
  }
  const recovery = options.recovery ? setupHostRecovery(ctx, pluginState, life) : undefined
  const runtime = recovery ? recovery.current()! : setupHostRuntime(ctx, pluginState, life)!
  let sequence = 0
  return { life, runtime, recovery, slots, listeners, pluginState, state, calls, ancestryReads, commands, renderer, stateRoot: root,
    clientMarker: (id: string) => { markers.push(id); markerAvailable() }, event: (type: string, data: unknown, eventID?: string) => {
    sequence++
    for (const listen of options.reverseEvents ? [...listeners].reverse() : listeners) listen({ details: { type, data, location, id: eventID ?? `event-${sequence}`, created: sequence,
      durable: { aggregateID: (data as { sessionID?: string }).sessionID, seq: sequence, version: 1 } } })
  } }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test("production reconnect admits permissions while an aborted optional native form read remains owned", async t => {
  let release!: () => void, forms = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ recovery: true, notify: true, formSync: async () => { if (++forms === 1) await held } })
  t.after(async () => { release(); await f.life.stop(); await f.life.settled() })
  await tick(); await tick()
  assert.equal(forms, 1)
  f.state.requests = [pending("after-form-stall")]
  f.event("server.connected", {}, "event-next"); f.clientMarker("event-next")
  let next
  for (let turn = 0; turn < 50; turn++) {
    await tick(); next = f.recovery!.current()
    if (next?.controller.pendingViews[0]?.request.id === "after-form-stall") break
  }
  assert.ok(next); assert.notEqual(next, f.runtime)
  assert.equal(next.controller.pendingViews[0]?.request.id, "after-form-stall")
  const stopped = f.life.stop()
  let settled = false
  const drained = f.life.settled().then(() => { settled = true })
  await tick(); assert.equal(settled, false, "Retired optional work is still physically owned")
  release(); await stopped; await drained
  assert.equal(f.listeners.size, 0); assert.equal(f.slots.size, 0); assert.equal(f.commands.length, 0)
})

test("production reconnect cannot mix generations across a physically held mandatory native-cache refresh", async t => {
  let release!: () => void, syncs = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ recovery: true, sessionSync: async () => { if (++syncs === 1) await held } })
  t.after(async () => { release(); await f.life.stop(); await f.life.settled() })
  await tick(); assert.equal(syncs, 1)
  f.state.requests = [pending("after-mandatory-stall")]
  f.event("server.connected", {}, "event-next"); f.clientMarker("event-next")
  await tick(); await tick()
  assert.equal(f.recovery!.current(), undefined)
  assert.equal(f.calls.filter(call => call.startsWith("sync:")).length, 0)
  release()
  let next
  for (let turn = 0; turn < 50; turn++) {
    await tick(); next = f.recovery!.current()
    if (next?.controller.pendingViews[0]?.request.id === "after-mandatory-stall") break
  }
  assert.equal(next?.controller.pendingViews[0]?.request.id, "after-mandatory-stall")
  assert.deepEqual(f.calls.filter(call => call.startsWith("sync:")), ["sync:root"], "Only the fresh transaction may reach permission cache synchronization")
})

test("fresh production generations recover pending queues without accumulating commands, slots, frames or listeners", async t => {
  const f = await fixture({ recovery: true }); t.after(() => f.life.stop())
  await tick(); await tick()
  const initialCommands = f.commands.map(command => command.id).sort()
  assert.equal(new Set(initialCommands).size, initialCommands.length)
  const slots = f.slots.size, listeners = f.listeners.size, frames = f.renderer.listenerCount(CliRenderEvents.FRAME)
  let previous = f.runtime
  for (let index = 0; index < 3; index++) {
    f.state.requests = [pending("fresh-" + index)]
    f.event("server.connected", {}, "event-next-" + index)
    assert.equal(f.recovery!.current(), undefined, "Native reconnect fences the old runtime synchronously")
    // Deliver the independent client observation through its subscriber.
    f.clientMarker("event-next-" + index)
    let next
    for (let turn = 0; turn < 50; turn++) {
      await tick()
      next = f.recovery!.current()
      if (next?.controller.pendingViews[0]?.request.id === "fresh-" + index) break
    }
    assert.ok(next); assert.notEqual(next.controller, previous.controller)
    assert.equal(next.controller.pendingViews[0]?.request.id, "fresh-" + index)
    assert.deepEqual(previous.controller.views, [])
    assert.deepEqual(f.commands.map(command => command.id).sort(), initialCommands)
    assert.equal(f.slots.size, slots); assert.equal(f.listeners.size, listeners)
    assert.equal(f.renderer.listenerCount(CliRenderEvents.FRAME), frames)
    previous = next
  }
  await f.life.stop(); await f.life.settled()
  assert.equal(f.commands.length, 0); assert.equal(f.slots.size, 0); assert.equal(f.listeners.size, 0)
  assert.equal(f.renderer.listenerCount(CliRenderEvents.FRAME), 0)
})

test("reconnect continuity is location-value based and checkpointing precedes disposal regardless of listener order", async t => {
  const f = await fixture({ recovery: true, reverseEvents: true, location: { workspaceID: "workspace", directory: location.directory } })
  t.after(() => f.life.stop())
  await tick(); await tick()
  let checkpoints = 0
  f.runtime.controller.checkpoint = () => {
    assert.equal(f.runtime.controller.views[0]?.request.id, "first", "The old listener must not dispose entries before checkpointing")
    checkpoints++
    return { manual: new Map([["first", "cancelled"]]), pending: new Map() }
  }
  f.event("server.connected", {}, "event-next"); f.clientMarker("event-next")
  let next
  for (let turn = 0; turn < 50; turn++) {
    await tick(); next = f.recovery!.current()
    if (next?.controller.views.length) break
  }
  assert.equal(checkpoints, 1)
  assert.equal(next?.controller.views[0]?.autoApproval?.status, "cancelled", "Location property order cannot erase a cancellation")
})

for (const failure of ["companion", "configuration", "unobserved", "conflicting"] as const) {
  test(`failed CLI ${failure} composes history and attention without fallback promotion`, async t => {
    const banners: string[] = []
    const f = await fixture({ startupFailure: failure, backend: {
      async show(message) { banners.push(message.kind); return { close() {} } }, dispose() {},
    } })
    t.after(() => f.life.stop())
    const verified = failure === "companion" || failure === "configuration"
    assert.equal(f.runtime, undefined, "fallback does not construct a reviewer")
    assert.equal(f.pluginState.companion, undefined)
    assert.equal(f.pluginState.connectionID, verified ? "event-initial" : undefined)
    await tick(); await tick()
    f.event("server.connected", {}, "event-initial")
    assert.equal(f.commands.find(command => command.id === "reviewer.history")!.enabled!(), verified)
    assert.equal(f.commands.find(command => command.id === "reviewer.lifetime")!.enabled!(), verified)
    f.state.requests = [pending("fresh")]; f.event("permission.asked", pending("fresh"))
    await tick(); await tick(); await tick()
    assert.deepEqual(banners, verified ? ["attention"] : [])
    const store = new SessionModeStore(path.join(f.stateRoot, "session-mode-v2"), JSON.stringify(location))
    if (verified) {
      await f.commands.find(command => command.id === "reviewer.disable")!.run()
      assert.equal(await store.read("root", f.life.signal), false)
    }
    f.event("server.connected", {}, "event-distinct")
    f.event("server.connected", {}, "event-initial")
    assert.equal(f.commands.find(command => command.id === "reviewer.history")!.enabled!(), false)
    assert.equal(f.commands.find(command => command.id === "reviewer.lifetime")!.enabled!(), false)
    if (verified) {
      await f.commands.find(command => command.id === "reviewer.enable")!.run()
      assert.equal(await store.read("root", f.life.signal), false, "revoked local controls cannot revive fallback")
    }
    f.state.requests = [pending("late")]; f.event("permission.asked", pending("late"))
    await tick(); await tick()
    assert.deepEqual(banners, verified ? ["attention"] : [])
  })
}

test("full runtime preserves a delivered question initial across unrelated shell health withdrawal", async t => {
  const banners: string[] = []
  const f = await fixture({ notify: true, backend: {
    async show(message) { banners.push(message.title); return { close() {} } }, dispose() {},
  } })
  t.after(() => f.life.stop())
  await tick(); await tick()
  f.state.requests = []; await f.runtime.refresh.refresh()
  f.state.route = { type: "session", sessionID: "root" }
  f.runtime.notifications!.visit("root")
  const question: FormInfo = { id: "question", sessionID: "root", title: "Question", fields: [{ type: "string", key: "answer" }] }
  f.state.forms = [question]; f.event("form.created", { form: question })
  await tick(); await tick(); await tick()
  assert.deepEqual(banners, ["Agent has a question"])
  f.event("shell.deleted", { id: "unrelated-shell" })
  await tick(); await tick(); await tick()
  assert.deepEqual(banners, ["Agent has a question"])
})

for (const unavailable of ["configuration", "companion"] as const) {
  test(`local enable/disable commands stay registered without review ${unavailable} and persist the same conversation namespace`, async t => {
    const f = await fixture({ unavailable }); t.after(() => f.life.stop())
    assert.equal(f.runtime, undefined, "local preferences cannot create a review runtime")
    const enable = f.commands.find(command => command.id === "reviewer.enable")!
    const disable = f.commands.find(command => command.id === "reviewer.disable")!
    assert.ok(enable); assert.ok(disable)
    f.state.route = { type: "session", sessionID: "child" }
    const store = new SessionModeStore(path.join(f.stateRoot, "session-mode-v2"), JSON.stringify(location))
    await disable.run()
    assert.equal(await store.read("root", f.life.signal), false)
    await enable.run()
    assert.equal(await store.read("root", f.life.signal), true)
    assert.deepEqual(f.ancestryReads, ["child", "root"], "both commands share owned, scoped history ancestry")
    assert.equal(f.calls.some(call => call.startsWith("sync:")), false, "local commands make no permission replies or model calls")
    f.event("server.connected", {})
    await disable.run()
    assert.equal(await store.read("root", f.life.signal), true, "reconnect cannot reuse an old scoped generation")
  })
}

test("review and history share bounded metadata ancestry without history loading saved review modes", async () => {
  const f = await fixture()
  try {
    await tick(); await tick()
    let loads = 0
    f.runtime.modes.load = async () => { loads++; throw Error("History must not load saved mode") }
    const signal = new AbortController().signal
    assert.equal(await f.runtime.records.history.root("root", signal), "root")
    assert.equal(await f.runtime.modes.root("root", signal), "root")
    assert.deepEqual(f.ancestryReads, ["root"], "both consumers reuse the same verified metadata cache")
    assert.equal(loads, 0)
    assert.equal(f.runtime.modes.enabled("root"), false)
    f.runtime.records.invalidateSession("root")
    assert.equal(await f.runtime.modes.root("root", signal), "root")
    assert.deepEqual(f.ancestryReads, ["root", "root"], "history invalidation also revokes review's ancestry cache")
  } finally { await f.life.stop() }
})

test("a retained approval click reveals an absent sidebar only on a genuine root frame, without history lookup", async () => {
  const f = await fixture({ notify: true })
  try {
    await tick(); await tick()
    f.state.route = { type: "session", sessionID: "root" }
    f.runtime.controller.retained = () => ({ request: pending("first"), status: "analyzing", retained: true })
    f.runtime.records.browser.openPermission = () => { assert.fail("Retained report must not open saved history") }
    f.runtime.notifications!.click("root", { session: "root", permission: "first" })
    assert.equal(f.calls.includes("dispatch:session.sidebar.toggle"), false, "Click alone is not a painted absence observation")
    f.renderer.emit(CliRenderEvents.FRAME)
    f.renderer.emit(CliRenderEvents.FRAME)
    assert.equal(f.calls.filter(call => call === "dispatch:session.sidebar.toggle").length, 1)
    assert.equal(f.runtime.records.state().open, false)
  } finally { await f.life.stop() }
})

test("navigation invalidates a retained approval click before its sidebar reveal frame", async () => {
  const f = await fixture({ notify: true })
  try {
    await tick(); await tick()
    f.state.route = { type: "session", sessionID: "root" }
    f.runtime.controller.retained = () => ({ request: pending("first"), status: "analyzing", retained: true })
    f.runtime.notifications!.click("root", { session: "root", permission: "first" })
    f.state.route = { type: "home" }
    f.runtime.notifications!.routeChanged()
    f.state.route = { type: "session", sessionID: "root" }
    f.renderer.emit(CliRenderEvents.FRAME)
    assert.equal(f.calls.includes("dispatch:session.sidebar.toggle"), false)
  } finally { await f.life.stop() }
})

test("a retained report finishing before the click's reveal frame cannot reveal an empty sidebar or open history", async () => {
  const f = await fixture({ notify: true })
  try {
    await tick(); await tick()
    f.state.route = { type: "session", sessionID: "root" }
    f.runtime.controller.retained = () => ({ request: pending("first"), status: "analyzing", retained: true })
    f.runtime.records.browser.openPermission = () => { assert.fail("A live click cannot become a later history click") }
    f.runtime.notifications!.click("root", { session: "root", permission: "first" })
    f.runtime.controller.retained = () => undefined
    f.renderer.emit(CliRenderEvents.FRAME)
    assert.equal(f.calls.includes("dispatch:session.sidebar.toggle"), false)
    assert.equal(f.runtime.records.state().open, false)
  } finally { await f.life.stop() }
})

for (const invalidation of ["interruption", "permission churn"] as const) test(`scoped ${invalidation} revokes deferred notification delivery before held native reconciliation`, async () => {
  let releasePreparation!: () => void, releaseSync!: () => void, started!: () => void
  const preparation = new Promise<void>(resolve => { releasePreparation = resolve })
  const synchronization = new Promise<void>(resolve => { releaseSync = resolve })
  const deliveryStarted = new Promise<void>(resolve => { started = resolve })
  let deliverySignal!: AbortSignal, dispatched = 0
  const options = { notify: true, sessionSync: async () => {}, backend: {
    async show(_message: unknown, signal: AbortSignal) {
      deliverySignal = signal; started()
      await preparation
      signal.throwIfAborted()
      dispatched++
      return { close() {} }
    }, dispose() { releasePreparation() },
  } }
  const f = await fixture(options)
  try {
    await tick(); await tick(); await tick()
    f.state.route = { type: "session", sessionID: "root" }
    f.runtime.notifications!.visit("root")
    f.event("permission.asked", pending("first"))
    await deliveryStarted
    assert.equal(deliverySignal.aborted, false)
    f.state.nativeRequests = [...f.state.requests]
    f.state.requests = invalidation === "interruption" ? [] : [pending("second")]
    options.sessionSync = () => synchronization
    if (invalidation === "interruption") {
      f.event("session.step.failed", { sessionID: "root", assistantMessageID: "assistant", error: { type: "aborted", message: "Stopped" } })
    } else f.event("permission.asked", pending("second"))
    assert.equal(deliverySignal.aborted, true, "stale queue ownership must be revoked synchronously, before cache synchronization")
    releasePreparation(); await tick()
    assert.equal(dispatched, 0, "deferred banner/audio preparation cannot dispatch from the old healthy snapshot")
    f.state.requests = []
    f.state.nativeRequests = []
    if (invalidation === "permission churn") f.event("permission.replied", { sessionID: "root", requestID: "second", reply: "once" })
    releaseSync(); await f.runtime.refresh.refresh(); await tick(); await tick()
    assert.equal(dispatched, 0)
  } finally { releasePreparation(); releaseSync(); await f.life.stop() }
})
test("production runtime keeps disabled requests as blockers and reconciles actual native caches before admission", async () => {
  const f = await fixture()
  try {
    await tick(); await tick()
    assert.equal(f.runtime.controller.pendingViews[0]?.request.id, "first")
    assert.deepEqual(f.calls.slice(0, 3), ["session:root", "invalidate:root", "sync:root"])
    assert.equal(f.runtime.front("root"), "first")
    f.state.requests = []
    await f.runtime.refresh.refresh()
    assert.equal(f.runtime.controller.pendingViews.length, 0)
  } finally { await f.life.stop() }
  assert.ok(f.calls.includes("off"))
})
test("a replaced companion cannot reconcile old controller scope", async () => {
  const f = await fixture()
  try {
    await tick(); await tick()
    f.state.epoch = "20000000-1000-4000-8000-100000000000"
    f.state.requests = []
    await f.runtime.refresh.refresh()
    assert.equal(f.runtime.controller.pendingViews[0]?.request.id, "first")
  } finally { await f.life.stop() }
})

test("permission events invalidate an outstanding location snapshot before controller admission", async () => {
  const f = await fixture()
  try {
    await tick(); await tick()
    let resolve!: (value: { location: typeof location; data: ReturnType<typeof pending>[] }) => void
    let started!: () => void
    const dispatched = new Promise<void>(yes => { started = yes })
    f.state.list = async () => { started(); return new Promise(yes => { resolve = yes }) }
    const refresh = f.runtime.refresh.refresh()
    await dispatched
    f.state.requests = [pending("fresh")]
    f.state.list = async () => ({ location, data: f.state.requests })
    f.event("permission.asked", pending("fresh"))
    resolve({ location, data: [pending("stale")] })
    await refresh
    await tick(); await tick()
    assert.equal(f.runtime.controller.pendingViews[0]?.request.id, "fresh")
    assert.equal(f.runtime.controller.views.some(view => view.request.id === "stale"), false)
  } finally { await f.life.stop() }
})

test("local mode commands persist conversation state without model calls, and repeated Enable leaves controller revision intact", async () => {
  const f = await fixture()
  try {
    await tick(); await tick()
    f.state.route = { type: "session", sessionID: "root" }
    await f.commands.find(command => command.id === "reviewer.disable")!.run()
    assert.equal(f.runtime.modes.enabled("root"), false)
    await f.commands.find(command => command.id === "reviewer.enable")!.run()
    assert.equal(f.runtime.modes.enabled("root"), true)
    await tick(); await tick()
    const revision = f.runtime.controller.revision
    await f.commands.find(command => command.id === "reviewer.enable")!.run()
    assert.equal(f.runtime.controller.revision, revision)
  } finally { await f.life.stop() }
})

test("a delayed initial marker preserves the active reviewer while a distinct connection still permanently revokes it", async () => {
  const f = await fixture({ connectionID: "event-initial" })
  try {
    await tick(); await tick()
    assert.equal(f.runtime.views()[0]?.request.id, "first")
    f.event("server.connected", {}, "event-initial")
    f.state.requests = [pending("after-initial-echo")]
    f.event("permission.asked", pending("after-initial-echo"))
    await tick(); await tick()
    await f.runtime.refresh.refresh()
    assert.equal(f.runtime.views()[0]?.request.id, "after-initial-echo")
    f.event("server.connected", {}, "event-new-connection")
    f.state.requests = [pending("after-reconnect")]
    f.event("permission.asked", pending("after-reconnect"))
    f.event("server.connected", {}, "event-initial")
    await f.runtime.refresh.refresh()
    assert.equal(f.runtime.views().length, 0, "An old initial marker cannot revive a revoked generation")
  } finally { await f.life.stop() }
})

test("a reconnected event stream cannot use a controller bound to the previous client generation", async () => {
  const f = await fixture()
  try {
    await tick(); await tick()
    assert.equal(f.runtime.views().length, 1)
    f.event("server.connected", {})
    f.state.requests = [pending("new-server")]
    f.event("permission.asked", pending("new-server"))
    await f.runtime.refresh.refresh()
    assert.equal(f.runtime.views().length, 0)
  } finally { await f.life.stop() }
})

test("Enable cannot bypass an unreadable saved conversation mode", async () => {
  const f = await fixture()
  try {
    await tick(); await tick()
    f.state.route = { type: "session", sessionID: "root" }
    f.runtime.modes.load = async () => { throw Error("Invalid saved mode") }
    await f.commands.find(command => command.id === "reviewer.enable")!.run()
    assert.equal(f.runtime.modes.enabled("root"), false)
  } finally { await f.life.stop() }
})

test("notification form failures cannot prevent valid permission admission", async () => {
  const f = await fixture({ notify: true, formSync: async () => { throw Error("Unavailable forms") } })
  try {
    await tick(); await tick(); await tick()
    assert.ok(f.calls.includes("form"))
    assert.equal(f.runtime.controller.pendingViews[0]?.request.id, "first")
    f.state.requests = [pending("next")]
    await f.runtime.refresh.refresh()
    assert.equal(f.runtime.controller.pendingViews[0]?.request.id, "next")
  } finally { await f.life.stop() }
})

test("stalled optional form work remains owned without blocking permission refresh", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ notify: true, formSync: () => held })
  try {
    await tick(); await tick(); await tick()
    assert.ok(f.calls.includes("form"))
    f.state.requests = [pending("next")]
    await f.runtime.refresh.refresh()
    assert.equal(f.runtime.controller.pendingViews[0]?.request.id, "next")
    let stopped = false
    const stopping = f.life.stop().then(() => { stopped = true })
    await tick()
    assert.equal(stopped, false, "Actual observer transaction remains owned")
    const before = f.calls.filter(call => call === "form").length
    release(); await stopping
    assert.equal(f.calls.filter(call => call === "form").length, before, "Abort cannot dispatch a later global read")
  } finally { release(); await f.life.stop() }
})

test("shutdown owns complete native refresh and cannot start permission sync after held session sync", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ sessionSync: () => held })
  try {
    await tick(); await tick()
    assert.ok(f.calls.includes("session:root"))
    let stopped = false
    const stopping = f.life.stop().then(() => { stopped = true })
    await tick()
    assert.equal(stopped, false)
    release(); await stopping
    assert.equal(f.calls.some(call => call.startsWith("sync:") || call.startsWith("invalidate:")), false)
  } finally { release(); await f.life.stop() }
})

test("a deleted observed session cannot poison later notification form reconciliation", async () => {
  const f = await fixture({ notify: true })
  try {
    await tick(); await tick(); await tick()
    f.event("session.execution.started", { sessionID: "gone" })
    await tick(); await tick(); await tick()
    f.event("session.deleted", { sessionID: "gone" })
    const lookedUp: string[] = []
    f.runtime.records.history.root = (id: string) => {
      lookedUp.push(id)
      return id === "gone" ? Promise.reject(Error("Session removed")) : Promise.resolve(id)
    }
    await f.runtime.refresh.refresh()
    await tick(); await tick(); await tick()
    assert.ok(lookedUp.includes("root"))
    assert.equal(lookedUp.includes("gone"), false)
    assert.equal(f.runtime.controller.pendingViews[0]?.request.id, "first")
  } finally { await f.life.stop() }
})
