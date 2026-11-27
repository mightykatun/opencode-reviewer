import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { CliRenderEvents } from "@opentui/core"
import { viewerFixture } from "./viewer-fixture.js"

test("history reads indexed RPC records with review disabled and refreshes on changes", async t => {
  const f = viewerFixture()
  t.after(() => f.life.stop())
  f.snapshot.review = { enabled: false, reason: "no-policy" }
  f.command("reviewer.history").run()
  await tick()
  assert.deepEqual(f.runtime.records.state().selection, f.sample)
  assert.deepEqual(f.calls.find(call => call.method === "history")?.location, f.home.feed.location)
  assert.ok(f.calls.every(call => call.method === "history" || call.method === "statistics"))
  f.handlers.history = async () => { throw Error("Unavailable") }
  f.runtime.changed(f.home)
  await tick()
  assert.equal(f.runtime.records.state().status, "error")
})

test("history input observations stay opt-in and unmounted history never owns input", async t => {
  const f = viewerFixture({ historyProbe: { observe() {} } })
  const production = viewerFixture()
  t.after(() => Promise.all([f.life.stop(), production.life.stop()]))
  assert.equal(production.runtime.records.historyInput, undefined)
  const input = f.runtime.records.historyInput!
  f.command("reviewer.history").run()
  await tick()
  assert.equal(f.runtime.records.state().status, "ready")
  f.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(input.interactive(), false)
  input.scroll(1, true)
  assert.equal(f.runtime.records.browser.scroll, 0)
  assert.equal(f.renderer.useMouse, false)
})

test("Alt+H toggles in base mode on roots and palette and slash always open newest", async t => {
  const f = viewerFixture()
  t.after(() => f.life.stop())
  const toggle = f.command("reviewer.history.toggle")
  const layer = f.layers.find(layer => layer.commands?.includes(toggle))!
  assert.equal(layer.mode, "global")
  assert.equal(layer.priority, 100)
  assert.equal(toggle.title, "Reviewer: Report history")
  assert.equal(toggle.bind, "alt+h")
  assert.equal(toggle.palette, true)
  assert.equal(toggle.slash, undefined)
  const slash = f.command("reviewer.history")
  assert.equal(slash.palette, undefined)
  assert.equal(slash.bind, undefined)
  assert.deepEqual(slash.slash, { name: "reviewer-history" })
  assert.ok(f.layers.flatMap(layer => layer.commands ?? []).every(command => !["ctrl+h", "backspace", "ctrl+backspace"].includes(String(command.bind))))
  const press = () => toggle.run(undefined, { sequence: "\x1bh" } as never)
  press()
  assert.equal(f.runtime.records.state().open, true)
  press()
  await tick()
  assert.equal(f.runtime.records.state().open, false)
  press()
  await tick()
  assert.equal(f.runtime.records.state().status, "ready")
  f.mode("modal")
  assert.equal(press(), false)
  assert.equal(f.runtime.records.state().open, true)
  f.mode("base")
  toggle.run()
  assert.equal(f.runtime.records.state().open, true)
  toggle.run(undefined, { sequence: "" } as never)
  assert.equal(f.runtime.records.state().open, true)
  press()
  for (const route of [{ type: "home" }, ...["child", "missing", "other"].map(sessionID => ({ type: "session", sessionID } as const))] as const) {
    f.route(route)
    assert.equal((layer.enabled as () => boolean)(), false)
    press()
    assert.equal(f.runtime.records.state().open, false)
  }
  f.route({ type: "session", sessionID: "root" })
  f.available(false)
  assert.equal((layer.enabled as () => boolean)(), false)
  assert.equal(f.renderer.useMouse, false)
})

test("a targeted click opens only its own report on a real root frame", async t => {
  const f = viewerFixture()
  t.after(() => f.life.stop())
  const abort = new AbortController()
  const lease = { current: () => !abort.signal.aborted, signal: abort.signal, cancel() {}, commit() {} }
  f.runtime.openHistory("root", { session: "child", permission: "missing" }, lease)
  await tick()
  assert.equal(f.runtime.records.state().open, false)
  assert.deepEqual(f.dispatched, [])
  f.runtime.openHistory("root", { session: "child", permission: "saved" }, lease)
  await tick()
  assert.equal(f.runtime.records.state().selection?.entry, f.sample.entry)
  assert.deepEqual(f.dispatched, [])
  f.renderer.emit(CliRenderEvents.FRAME)
  assert.deepEqual(f.dispatched, ["session.sidebar.toggle"])
  assert.deepEqual(f.calls.filter(call => call.method === "history").map(call => call.input), [
    { sessionID: "root", permission: { session: "child", permission: "missing" } },
    { sessionID: "root", permission: { session: "child", permission: "saved" } },
  ])
})
