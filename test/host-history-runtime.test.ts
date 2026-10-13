import assert from "node:assert/strict"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import path from "node:path"
import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { hostHistoryScope, setupHostHistoryOnly } from "../src/host-history-runtime.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import { parseConfig } from "../src/config.js"
import { empty } from "../src/lifetime.js"
import { entryID, snapshotQuery, type HistoryQuery } from "../src/history-records.js"
import type { HistorySelection } from "../src/history-schema.js"
import type { HistoryTransport } from "../src/history-store.js"

const location = { directory: "/server/project", workspaceID: "workspace" }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const config = () => parseConfig({ baseURL: "http://fixture.invalid/v1", model: "unused" })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture(unavailable: "configuration" | "companion" = "configuration", observeHistoryInput = false) {
  const life = new PluginLifecycle(), commands: NonNullable<KeymapLayer["commands"]>[number][] = []
  const slots: { prepend?: string; append?: string; render: unknown; removed?: boolean }[] = []
  const wire: Record<string, unknown>[] = [], serverReads: string[] = [], unexpected: string[] = []
  const renderer = Object.assign(new EventEmitter(), { width: 140, height: 40, useMouse: false })
  const sessions = new Map([
    ["root", { id: "root", location }],
    ["child", { id: "child", parentID: "root", location }],
    ["other", { id: "other", location: { ...location, directory: "/server/other" } }],
  ])
  let route: { type: "session"; sessionID: string } | { type: "home" } = { type: "session", sessionID: "root" }
  let listener: ((event: any) => void) | undefined, dialogClose: (() => void) | undefined
  let terminated = 0
  const scope = hostHistoryScope(location.directory)
  const context = { scope, root: "root", session: "root", permission: "saved-permission", review: "saved-review",
    category: "bash" as const, configuredModel: "saved-model", provider: "https://fixture.invalid/v1" }
  const sample: HistorySelection = { revision: 7, total: 1, rank: 1, entry: entryID(context),
    record: { context, payload: { safe: true, desc: "Saved assessment", completedAt: 1 }, outcome: "manual" } }
  const totals = { ...empty(), requests: 2 }
  const transport: HistoryTransport = {
    async call(message) {
      wire.push(message)
      if (message.type === "open") return { cleanup: false }
      assert.equal(message.type, "query", "read-only history must not write, bootstrap or maintain stored detail")
      const query = message.query as HistoryQuery
      if (query.type === "history") return sample
      assert.equal(query.type, "totals")
      return { revision: 7, totals, ...("conversation" in query && query.conversation
        ? { conversation: { totals, partialHistory: false } } : {}) }
    },
    async terminate() { terminated++ },
  }
  const server = { read: async (id: string) => sessions.get(id)! }
  const ctx = {
    location,
    client: { session: { get: async ({ sessionID }: { sessionID: string }) => { serverReads.push(sessionID); return server.read(sessionID) } },
      rpc: () => { unexpected.push("companion"); throw Error("unavailable") },
      permission: { request: { list: () => { unexpected.push("permissions"); throw Error("unavailable") } } },
      model: { list: () => { unexpected.push("models"); throw Error("unavailable") } } },
    data: { listen: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
      session: { get: (id: string) => sessions.get(id) }, location: { default: () => location } },
    keymap: { layer: (factory: () => KeymapLayer) => { commands.push(...factory().commands ?? []) } },
    renderer,
    ui: { slot: (slot: typeof slots[number]) => { slots.push(slot); return () => { slot.removed = true } },
      router: { current: () => route }, dialog: { show: (_render: unknown, close: () => void) => { dialogClose = close },
        clear: () => { dialogClose?.(); dialogClose = undefined } } },
  } as unknown as Plugin.Context
  const state = { stateRoot: "/tmp/opencode/reviewer-history-source", prompts: BUILTIN_PROMPTS,
    dependencies: observeHistoryInput ? { historyProbe: { observe: () => {} } } : {},
    ...(unavailable === "configuration" ? { configError: "Invalid review configuration", companion: {
      protocol: 1 as const, hostVersion: "2.0.26", epoch: "10000000-1000-4000-8000-100000000000", location,
      project: { id: "project", directory: "/server", canonical: "/server" },
    } }
      : { config: config() }) }
  const runtime = setupHostHistoryOnly(ctx, state, life, { transport: () => transport })
  return { life, runtime, commands, slots, renderer, sessions, wire, serverReads, unexpected, server,
    sample, totals, terminated: () => terminated, listening: () => !!listener,
    route: (value: typeof route) => { route = value },
    event: (type: string, data: unknown, eventLocation?: typeof location) => listener?.({ details: { type, data,
      ...(eventLocation ? { location: eventLocation } : {}) } }),
    command: (id: string) => {
      const command = commands.find(value => value.id === id)!
      assert.equal(typeof command.enabled, "function")
      return { ...command, enabled: command.enabled as () => boolean }
    },
  }
}

test("V2 history uses the existing absolute normalized directory index, independently of ownership", () => {
  const directory = "/server/project/../project"
  const scope = hostHistoryScope(directory)
  assert.equal(scope, path.join("/", "opencode-reviewer-v2", createHash("sha256").update("/server/project").digest("hex")))
  assert.equal(scope, hostHistoryScope("/server/project"))
  assert.notEqual(scope, hostHistoryScope("/server/other"))
  assert.equal(path.isAbsolute(scope), true)
  assert.deepEqual(snapshotQuery({ type: "history", scope, root: "root" }), { type: "history", scope, root: "root" })
  assert.throws(() => hostHistoryScope("relative"), /absolute/)
  assert.throws(() => hostHistoryScope("/server/\0project"), /absolute/)
})

test("history input observation is opt-in and logical browsing never fabricates mounted input ownership", async t => {
  const production = fixture(), observed = fixture("configuration", true)
  t.after(async () => { await Promise.all([production.life.stop(), observed.life.stop()]) })
  assert.equal(production.runtime.records.historyInput, undefined, "ordinary production composition creates no observation seam")
  const input = observed.runtime.records.historyInput
  assert.ok(input)
  assert.equal(input.interactive(), false, "unmounted history starts disabled")
  input.scroll(1, false)
  assert.equal(observed.runtime.records.browser.scroll, 0)
  observed.command("reviewer.history").run()
  await tick(); await tick()
  assert.equal(observed.runtime.records.state().status, "ready")
  assert.equal(observed.runtime.records.state().open, true)
  assert.equal(observed.runtime.records.historyInput, input, "the observation object stays stable across history state changes")
  observed.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(input.interactive(), false, "real FRAME without a mounted view cannot grant keyboard ownership")
  input.scroll(1, true)
  assert.equal(observed.runtime.records.browser.scroll, 0)
  assert.equal(observed.renderer.useMouse, false)
  assert.deepEqual(observed.unexpected, [])
  observed.runtime.records.browser.close()
  assert.equal(input.interactive(), false)
})

for (const unavailable of ["configuration", "companion"] as const) {
  test(`history/statistics remain available without review ${unavailable}, using current indexed samples`, async t => {
    const f = fixture(unavailable)
    t.after(async () => { await f.life.stop(); await f.life.settled() })
    assert.deepEqual(f.commands.map(value => value.id), ["reviewer.lifetime", "reviewer.history"])
    assert.deepEqual(f.slots.map(slot => slot.prepend ?? slot.append), ["sidebar.content", "app"])
    assert.equal(f.command("reviewer.history").enabled!(), true)
    assert.equal(f.command("reviewer.lifetime").enabled!(), true)
    f.command("reviewer.history").run()
    await tick(); await tick()
    assert.equal(f.runtime.records.state().status, "ready")
    assert.deepEqual(f.runtime.records.state().selection, f.sample)
    assert.deepEqual(f.wire.filter(value => (value.query as HistoryQuery | undefined)?.type === "history")
      .map(value => value.query), [{ type: "history", scope: hostHistoryScope(location.directory), root: "root" }])
    assert.deepEqual(f.serverReads, ["root"])
    f.route({ type: "session", sessionID: "child" })
    assert.equal(f.runtime.rootRoute(), undefined)
    assert.equal(f.command("reviewer.history").enabled!(), false)
    f.command("reviewer.lifetime").run()
    f.runtime.records.statistics.select("conversation")
    await tick(); await tick()
    assert.equal(f.runtime.records.statisticsState().ancestry, "ready")
    assert.deepEqual(f.runtime.records.statisticsState().conversation?.totals, f.totals)
    assert.ok(f.wire.some(value => JSON.stringify(value.query) === JSON.stringify({ type: "totals",
      conversation: { scope: hostHistoryScope(location.directory), root: "root" } })))
    assert.deepEqual(f.unexpected, [], "no model, review or companion reads")
    assert.equal(f.renderer.useMouse, false)
  })
}

test("history-only route identity uses known native scoped ancestry, not review modes or remembered paint", async t => {
  const f = fixture()
  t.after(() => f.life.stop())
  assert.equal(f.runtime.rootRoute(), "root")
  f.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(f.runtime.geometry(), undefined, "a root route alone cannot manufacture sidebar geometry")
  for (const sessionID of ["child", "missing", "other"]) {
    f.route({ type: "session", sessionID })
    assert.equal(f.runtime.rootRoute(), undefined)
    assert.equal(f.command("reviewer.history").enabled!(), false)
  }
  f.route({ type: "home" })
  assert.equal(f.runtime.rootRoute(), undefined)
  assert.equal(f.command("reviewer.lifetime").enabled!(), true)
  assert.deepEqual(f.serverReads, [])
})

test("known scoped live deletion invalidates only volatile history, never persistent rows or maintenance", async t => {
  const f = fixture()
  t.after(() => f.life.stop())
  f.command("reviewer.history").run()
  await tick(); await tick()
  f.event("session.deleted", { sessionID: "missing" })
  f.event("session.deleted", { sessionID: "other" })
  f.event("session.deleted", { sessionID: "root" }, { ...location, workspaceID: "other-workspace" })
  assert.equal(f.runtime.records.state().open, true)
  assert.equal(f.runtime.rootRoute(), "root")
  f.event("session.deleted", { sessionID: "root" }, location)
  assert.equal(f.runtime.records.state().open, false)
  assert.equal(f.runtime.rootRoute(), undefined, "native stale cache cannot resurrect the known deleted root")
  assert.equal(f.runtime.records.store.maintenanceDirty, false)
  assert.equal(f.runtime.records.store.pendingOperations, 0)
  assert.ok(f.wire.every(value => value.type === "open" || value.type === "query"))
})

test("server replacement permanently revokes commands and ignores subsequent deletion events", async t => {
  const f = fixture()
  t.after(() => f.life.stop())
  f.command("reviewer.history").run()
  await tick(); await tick()
  f.event("server.connected", {})
  assert.equal(f.runtime.records.state().open, false)
  assert.equal(f.command("reviewer.history").enabled!(), false)
  assert.equal(f.command("reviewer.lifetime").enabled!(), false)
  const reads = f.serverReads.length, queries = f.wire.length
  f.command("reviewer.history").run()
  f.command("reviewer.lifetime").run()
  f.event("session.deleted", { sessionID: "root" }, location)
  await tick()
  assert.equal(f.runtime.routes.get("root")?.id, "root", "a replacement stream cannot invalidate old client facts")
  assert.equal(f.serverReads.length, reads)
  assert.equal(f.wire.length, queries)
})

test("history-only signal cleanup removes owned listeners/slots and drains actual ancestry settlement", async () => {
  const f = fixture(), late = deferred<{ id: string; location: typeof location }>()
  f.server.read = () => late.promise
  const root = f.runtime.records.history.root("root", new AbortController().signal)
  void root.catch(() => {})
  await tick()
  assert.deepEqual(f.serverReads, ["root"])
  let settled = false
  const stop = f.life.stop()
  const physical = f.life.settled().then(() => { settled = true })
  await tick()
  assert.equal(f.life.signal.aborted, true)
  assert.equal(f.listening(), false)
  assert.equal(f.renderer.listenerCount(CliRenderEvents.FRAME), 0)
  assert.ok(f.slots.every(slot => slot.removed))
  assert.equal(f.runtime.sidebar(), undefined)
  assert.equal(f.runtime.geometry(), undefined)
  assert.equal(settled, false, "logical ancestry abort does not release the underlying client read")
  late.resolve({ id: "root", location })
  await stop; await physical
  assert.equal(settled, true)
  assert.equal(f.terminated(), 1)
  assert.deepEqual(f.unexpected, [])
})
