import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin/tui"
import { setupHostRuntime } from "../src/host-runtime.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"

const location = { directory: "/server/project" }
const companion = { protocol: 1 as const, hostVersion: "2.0.26", epoch: "10000000-1000-4000-8000-100000000000", location,
  project: { id: "project", directory: "/server", canonical: "/server" } }
const pending = (id: string) => ({ id, sessionID: "root", action: "unknown", resources: ["scope"] })
async function fixture() {
  const life = new PluginLifecycle(), calls: string[] = []
  const commands: { id: string; run: () => Promise<void> }[] = []
  let listen!: (event: any) => void
  const state = { requests: [pending("first")], epoch: companion.epoch, list: async () => ({ location, data: state.requests }),
    route: { type: "home" } as { type: "home" } | { type: "session"; sessionID: string } }
  const ctx = {
    client: { rpc: () => ({ handshake: async () => ({ ...companion, epoch: state.epoch }) }),
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location }) },
      permission: { request: { list: () => state.list() } } },
    data: { listen: (callback: typeof listen) => { listen = callback; return () => calls.push("off") },
      session: { get: (id: string) => ({ id, location }), family: () => ["root"],
        sync: async (id: string) => { calls.push("session:" + id) },
        permission: { invalidate: (id: string) => calls.push("invalidate:" + id), sync: async (id: string) => { calls.push("sync:" + id) },
          list: () => state.requests } } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands.push(...factory().commands) } },
    renderer: { on: () => {}, off: () => {}, width: 140, height: 40 },
    ui: { slot: () => () => {}, router: { current: () => state.route }, toast: { show: () => {} } },
  } as unknown as Plugin.Context
  const root = await mkdtemp("/tmp/opencode/reviewer-runtime-source-")
  const runtime = setupHostRuntime(ctx, { config: parseConfig({ baseURL: "http://localhost:40999", model: "unused", notify: false }),
    companion, stateRoot: root, prompts: BUILTIN_PROMPTS, dependencies: {} }, life)!
  return { life, runtime, state, calls, commands, event: (type: string, data: unknown) => listen({ details: { type, data } }) }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
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
