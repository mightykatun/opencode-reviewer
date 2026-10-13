import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin/tui"
import { setupHostRuntime } from "../src/host-runtime.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import type { NotificationBackend } from "../src/notification-types.js"

const location = { directory: "/server/project" }
const companion = { protocol: 1 as const, hostVersion: "2.0.26", epoch: "10000000-1000-4000-8000-100000000000", location,
  project: { id: "project", directory: "/server", canonical: "/server" } }
const pending = (id: string) => ({ id, sessionID: "root", action: "unknown", resources: ["scope"] })
async function fixture(options: { notify?: boolean; formSync?: () => Promise<void>; sessionSync?: () => Promise<void>;
  backend?: NotificationBackend } = {}) {
  const life = new PluginLifecycle(), calls: string[] = []
  const commands: { id: string; run: () => Promise<void> }[] = []
  let listen!: (event: any) => void
  const state = { requests: [pending("first")], epoch: companion.epoch, list: async () => ({ location, data: state.requests }),
    nativeRequests: undefined as ReturnType<typeof pending>[] | undefined,
    route: { type: "home" } as { type: "home" } | { type: "session"; sessionID: string } }
  const ctx = {
    location,
    client: { rpc: () => ({ handshake: async () => ({ ...companion, epoch: state.epoch }) }),
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location }) },
      permission: { request: { list: () => state.list() } } },
    data: { listen: (callback: typeof listen) => { listen = callback; return () => calls.push("off") },
      session: { get: (id: string) => ({ id, location }), family: () => ["root"],
        sync: async (id: string) => { calls.push("session:" + id); await options.sessionSync?.() },
        permission: { invalidate: (id: string) => calls.push("invalidate:" + id), sync: async (id: string) => { calls.push("sync:" + id) },
           list: () => state.nativeRequests ?? state.requests }, form: { sync: async () => { calls.push("form"); await options.formSync?.() }, list: () => [] } } },
    keymap: { mode: { current: () => "base" }, layer: (factory: () => { commands: typeof commands }) => { commands.push(...factory().commands) } },
    renderer: { on: () => {}, off: () => {}, width: 140, height: 40 },
    ui: { slot: () => () => {}, router: { current: () => state.route }, toast: { show: () => {} } },
  } as unknown as Plugin.Context
  const root = await mkdtemp("/tmp/opencode/reviewer-runtime-source-")
  const runtime = setupHostRuntime(ctx, { config: parseConfig({ baseURL: "http://localhost:40999", model: "unused", notify: options.notify ?? false }),
    companion, stateRoot: root, prompts: BUILTIN_PROMPTS,
    dependencies: { notifications: () => options.backend ?? ({ show: async () => undefined, dispose: () => {} }) } }, life)!
  let sequence = 0
  return { life, runtime, state, calls, commands, event: (type: string, data: unknown) => {
    sequence++
    listen({ details: { type, data, location, id: `event-${sequence}`, created: sequence,
      durable: { aggregateID: (data as { sessionID?: string }).sessionID, seq: sequence, version: 1 } } })
  } }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

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
