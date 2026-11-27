import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { CliRenderEvents } from "@opentui/core"
import { viewerFixture } from "./viewer-fixture.js"
import type { ViewerRow } from "../src/viewer-feed.js"
import type { HostRequest } from "../src/host-types.js"
import type { View } from "../src/controller.js"

function row(id: string, sessionID: string): ViewerRow & { view: View<HostRequest> } {
  return { root: "root", attempt: `attempt-${id}`, head: true,
    view: { review: `attempt-${id}`, request: { id, sessionID, action: "shell", resources: [] },
      status: "complete", assessment: { safe: true, desc: "Test report" }, autoApproval: { status: "countdown", seconds: 3 } } }
}

test("the native family front selects by root, session and permission even when a child completes first", async t => {
  const f = viewerFixture()
  t.after(() => f.life.stop())
  const parent = row("a", "root"), child = row("b", "child")
  f.snapshot.views = [child, parent]
  for (const queue of [f.pending, f.native]) {
    queue.set("root", [parent.view.request])
    queue.set("child", [child.view.request])
  }
  await f.refresh()
  assert.equal(f.runtime.selected(), parent)
  f.snapshot.views = [child]
  assert.equal(f.runtime.selected(), undefined)
  f.pending.delete("root")
  await f.refresh()
  assert.equal(f.runtime.selected(), undefined)
  f.native.delete("root")
  await f.refresh()
  assert.equal(f.runtime.selected(), child)
  f.runtime.control("b", "old-attempt", "expedite")
  f.runtime.control("a", child.attempt, "cancel")
  assert.equal(f.calls.some(call => call.method === "control"), false)
  f.runtime.control("b", child.attempt, "cancel")
  assert.deepEqual(f.calls.filter(call => call.method === "control"), [
    { method: "control", location: f.home.feed.location, input: { permissionID: "b", sessionID: "child",
      attempt: child.attempt, action: "cancel" } },
  ])
  f.snapshot.views = [{ ...child, head: false }]
  assert.equal(f.runtime.selected(), undefined)
  f.route({ type: "session", sessionID: "child" })
  assert.equal(f.runtime.rootRoute(), undefined)
  assert.equal(f.runtime.selected(), undefined)
  f.runtime.control("b", child.attempt, "expedite")
  assert.equal(f.calls.filter(call => call.method === "control").length, 1)
})

for (const condition of ["present", "finished", "navigated"] as const) {
  test(`retained click with report ${condition} uses a genuine frame and never looks up a different report`, async t => {
    const f = viewerFixture()
    t.after(() => f.life.stop())
    const value = row("a", "child")
    value.view.retained = true
    value.view.resolved = true
    f.snapshot.views = [value]
    await f.refresh()
    const abort = new AbortController()
    f.runtime.openHistory("root", { session: "child", permission: "a" },
      { signal: abort.signal, current: () => !abort.signal.aborted, cancel: () => abort.abort(), commit() {} })
    assert.deepEqual(f.dispatched, [])
    if (condition === "finished") f.snapshot.views = []
    if (condition === "navigated") {
      f.route({ type: "home" })
      abort.abort()
      f.route({ type: "session", sessionID: "root" })
    }
    f.renderer.emit(CliRenderEvents.FRAME)
    f.renderer.emit(CliRenderEvents.FRAME)
    assert.deepEqual(f.dispatched, condition === "present" ? ["session.sidebar.toggle"] : [])
    assert.ok(!f.calls.some(call => call.method === "history"))
    assert.equal(f.runtime.records.state().open, false)
  })
}

test("a reviewer RPC outage keeps the native observer and the last delivery settings until a snapshot changes them", async t => {
  let created = 0, disposed = 0
  const f = viewerFixture({ notifications: () => { created++; return { show: async () => undefined, dispose() { disposed++ } } } })
  t.after(() => f.life.stop())
  const tui = { notify: true, notifySound: false, customSounds: false, staleReminderSeconds: 60, notifications: {}, soundGeneration: 0 }
  f.snapshot.tui = tui as never
  await f.refresh()
  assert.deepEqual([created, disposed], [1, 0], "validated tui settings start delivery once")
  // The reviewer RPC fails while the native connection stays alive: nothing is torn down.
  f.available(false); f.runtime.changed(f.home); await tick()
  assert.deepEqual([created, disposed], [1, 0])
  f.available(true); f.runtime.changed(f.home); await tick()
  assert.deepEqual([created, disposed], [1, 0], "the same settings after the gap change nothing")
  // Only a received snapshot changes delivery: new settings replace it, a snapshot without tui ends it.
  f.snapshot.tui = { ...tui, staleReminderSeconds: 120 } as never; f.runtime.changed(f.home); await tick()
  assert.deepEqual([created, disposed], [2, 1])
  delete (f.snapshot as { tui?: unknown }).tui; f.runtime.changed(f.home); await tick()
  assert.deepEqual([created, disposed], [2, 2])
})
