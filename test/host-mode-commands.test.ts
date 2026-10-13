import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import { SessionModes, type ModeStore } from "../src/session-mode.js"
import { setupHostModeCommands } from "../src/host-mode-commands.js"

const memory = (): ModeStore => ({ read: async () => true, write: async () => {}, flush: async () => {} })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>
type Command = { id: string; title: string; group: string; palette: boolean; slash: { name: string }; run(): Promise<void> }
function fixture(modes: SessionModes, initial: Route = { type: "session", sessionID: "root" }) {
  const toasts: { message: string; variant: string }[] = [], changes: string[] = [], refreshes: boolean[] = []
  let route = initial, active = true, layer!: { mode: string; commands: Command[] }
  const abort = new AbortController()
  const context = {
    ui: { router: { current: () => route }, toast: { show: (value: typeof toasts[number]) => toasts.push(value) } },
    keymap: { layer: (factory: () => typeof layer) => { layer = factory() } },
  } as unknown as Plugin.Context
  setupHostModeCommands(context, modes, abort.signal, { active: () => active,
    onChanged: root => changes.push(root), onRefresh: () => refreshes.push(modes.enabled("root")) })
  return { layer, toasts, changes, refreshes, abort, route: (value: Route) => { route = value }, active: (value: boolean) => { active = value } }
}

test("local palette/slash commands capture session, persist, report failures and do nothing on home", async () => {
  const writes: boolean[] = []
  let fail = false
  const modes = new SessionModes({ ...memory(), write: async (_, enabled) => { writes.push(enabled); if (fail) throw new Error("private") } },
    async id => ({ id, ...(id === "child" ? { parentID: "root" } : {}) }))
  const f = fixture(modes, { type: "home" }), commands = f.layer.commands
  assert.equal(f.layer.mode, "global")
  assert.deepEqual(commands.map(c => [c.id, c.title, c.group, c.palette, c.slash.name]), [
    ["reviewer.enable", "Reviewer: Enable for conversation", "Reviewer", true, "reviewer-enable"],
    ["reviewer.disable", "Reviewer: Disable for conversation", "Reviewer", true, "reviewer-disable"],
  ])
  await commands[0]!.run()
  assert.deepEqual(writes, []); assert.deepEqual(f.refreshes, []); assert.equal(f.toasts.length, 0)
  f.route({ type: "session", sessionID: "child" })
  await commands[1]!.run()
  assert.equal(modes.enabled("root"), false)
  assert.equal(f.toasts.at(-1)!.message, "Reviewer disabled for this conversation.")
  fail = true
  await commands[0]!.run()
  assert.equal(modes.enabled("root"), true)
  assert.deepEqual(f.changes, ["root", "root"])
  assert.deepEqual(writes, [false, true]); assert.deepEqual(f.refreshes, [false, true])
  assert.match(f.toasts.at(-1)!.message, /enabled locally, but saving failed/)
  assert.equal(f.toasts.at(-1)!.variant, "error")
  assert.doesNotMatch(JSON.stringify(f.toasts), /private/)
})

test("enable cannot bypass corrupt persisted mode", async () => {
  let writes = 0
  const modes = new SessionModes({ ...memory(), read: async () => { throw new Error("private record") }, write: async () => { writes++ } }, async id => ({ id }))
  const f = fixture(modes)
  await f.layer.commands[0]!.run()
  assert.equal(modes.enabled("root"), false)
  assert.equal(writes, 0); assert.deepEqual(f.changes, []); assert.deepEqual(f.refreshes, [])
  assert.match(f.toasts[0]!.message, /saved mode could not be read/)
  assert.doesNotMatch(JSON.stringify(f.toasts), /private record/)
})

test("newer root command defeats an older descendant lookup and pending persistence does not delay the local switch", async () => {
  const lookup = deferred<{ id: string; parentID: string }>(), persistence = deferred<void>()
  const writes: boolean[] = []
  const modes = new SessionModes({ ...memory(), write: async (_, enabled) => { writes.push(enabled); await persistence.promise } },
    async id => id === "child" ? lookup.promise : { id })
  const f = fixture(modes, { type: "session", sessionID: "child" })
  const oldEnable = f.layer.commands[0]!.run()
  f.route({ type: "session", sessionID: "root" })
  const disable = f.layer.commands[1]!.run()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(modes.enabled("root"), false)
  assert.deepEqual(f.changes, ["root"]); assert.deepEqual(f.refreshes, [false])
  lookup.resolve({ id: "child", parentID: "root" })
  await oldEnable
  assert.deepEqual(writes, [false])
  persistence.resolve(); await disable
})

test("unchanged Enable still supersedes an older descendant Disable awaiting ancestry", async () => {
  const lookup = deferred<{ id: string; parentID: string }>(), writes: boolean[] = []
  const modes = new SessionModes({ ...memory(), write: async (_, enabled) => { writes.push(enabled) } },
    async id => id === "child" ? lookup.promise : { id })
  const f = fixture(modes, { type: "session", sessionID: "child" })
  const disable = f.layer.commands[1]!.run()
  f.route({ type: "session", sessionID: "root" })
  await f.layer.commands[0]!.run()
  lookup.resolve({ id: "child", parentID: "root" }); await disable
  assert.equal(modes.enabled("root"), true)
  assert.deepEqual(writes, [true])
  assert.deepEqual(f.changes, [], "ordering metadata changes without invalidating enabled reviews")
  assert.deepEqual(f.refreshes, [true], "unchanged Enable still refreshes native pending requests")
})

for (const action of ["abort", "disconnect"] as const) test(`${action} prevents an in-flight ancestry command from switching locally`, async () => {
  const lookup = deferred<{ id: string }>(), writes: boolean[] = []
  const modes = new SessionModes({ ...memory(), write: async (_, enabled) => { writes.push(enabled) } }, () => lookup.promise)
  const f = fixture(modes)
  const disable = f.layer.commands[1]!.run()
  if (action === "abort") f.abort.abort()
  else f.active(false)
  lookup.resolve({ id: "root" }); await disable
  assert.deepEqual(writes, []); assert.deepEqual(f.changes, []); assert.deepEqual(f.refreshes, [])
  assert.deepEqual(f.toasts, [])
})
