import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import type { HostRequest } from "../src/host-types.js"
import { PendingRefresh } from "../src/pending-refresh.js"
import { Controller, visibleReview } from "../src/controller.js"
import { SessionModes } from "../src/session-mode.js"
import { SessionAncestry } from "../src/session-ancestry.js"

const request = (id: string, action = "shell"): HostRequest => ({
  id, action, sessionID: "root", resources: [id],
})
const safe = { safe: true, desc: "Reads the fixture." }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t: TestContext, pending?: Pick<Controller, "revision" | "reconcile">) {
  const parent = new AbortController()
  const state = { revision: 0, snapshots: [] as { requests: readonly HostRequest[]; revision: number }[] }
  const calls: (ReturnType<typeof deferred<HostRequest[]>> & { signal: AbortSignal })[] = []
  const refresh = new PendingRefresh(pending ?? {
    get revision() { return state.revision },
    reconcile: (requests, revision) => { state.snapshots.push({ requests, revision }) },
  }, (signal) => {
    const call = { ...deferred<HostRequest[]>(), signal }
    calls.push(call)
    return call.promise
  }, parent.signal)
  t.after(async () => { refresh.dispose(); await settle() })
  return { refresh, calls, state, parent }
}

test("a successful bounded refresh reconciles its exact snapshot and captured revision", async (t) => {
  const f = fixture(t)
  f.state.revision = 12
  const operation = f.refresh.refresh()
  await settle()
  const requests = [request("a")]
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.signal.aborted, false)
  f.calls[0]!.resolve(requests)
  await operation
  assert.deepEqual(f.state.snapshots, [{ requests, revision: 12 }])
  assert.equal(f.state.snapshots[0]!.requests, requests)
})

test("refresh bursts coalesce into one follow-up without discarding a valid active result", async (t) => {
  const f = fixture(t)
  const first = f.refresh.refresh()
  await settle()
  await Promise.all(Array.from({ length: 100 }, () => f.refresh.refresh()))
  assert.equal(f.calls.length, 1)
  f.calls[0]!.resolve([request("first")])
  await first
  await settle()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.state.snapshots.map((value) => value.requests[0]?.id), ["first"])
  f.calls[1]!.resolve([request("fresh")])
  await settle()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.state.snapshots.map((value) => value.requests[0]?.id), ["first", "fresh"])
})

for (const outcome of ["resolve", "reject"] as const) test(`expired noncooperative read owns capacity until late ${outcome}, then coalesces recovery`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t)
  const first = f.refresh.refresh()
  await settle()
  await f.refresh.refresh()
  t.mock.timers.tick(4999)
  await settle()
  assert.equal(f.calls[0]!.signal.aborted, false)
  assert.equal(f.calls.length, 1)
  t.mock.timers.tick(1)
  await first
  await settle()
  assert.equal(f.calls[0]!.signal.aborted, true)
  assert.equal(f.calls.length, 1, "a caller deadline cannot free the physical read slot")
  if (outcome === "resolve") f.calls[0]!.resolve([request("expired")])
  else f.calls[0]!.reject(new Error("late read failure"))
  await settle()
  assert.equal(f.state.snapshots.length, 0)
  assert.equal(f.calls.length, 2)
  await f.refresh.refresh()
  assert.equal(f.calls.length, 2, "late completion cannot release a newer generation's single-flight state")
  f.calls[1]!.resolve([request("current")])
  await settle()
  assert.deepEqual(f.state.snapshots.map((value) => value.requests[0]?.id), ["current"])
  assert.equal(f.calls.length, 3)
  f.calls[2]!.resolve([])
  await settle()
  assert.deepEqual(f.state.snapshots.map((value) => value.requests.length), [1, 0])
})

test("an elapsed deadline rejects a result before reconciliation even before timer delivery", async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const f = fixture(t)
  const operation = f.refresh.refresh()
  await settle()
  now = 5000
  f.calls[0]!.resolve([request("expired")])
  await operation
  assert.deepEqual(f.state.snapshots, [])
  assert.equal(f.calls[0]!.signal.aborted, true)
})

for (const event of ["ask", "reply", "delete", "mode"] as const) test(`${event} revision invalidates an outstanding snapshot before controller reconciliation`, async (t) => {
  let evaluations = 0
  const modes = new SessionModes({ read: async () => true, write: async () => {}, flush: async () => {} }, new SessionAncestry(async (id) => ({ id })))
  const controller = new Controller(async () => { evaluations++; return safe }, () => {}, { modes, candidate: req => req.action === "shell" })
  t.after(() => controller.dispose())
  controller.asked(request("b"))
  await settle()
  const f = fixture(t, controller)
  const operation = f.refresh.refresh()
  await settle()
  const revision = controller.revision
  if (event === "ask") controller.asked(request("a", "read"))
  if (event === "reply") controller.replied("b")
  if (event === "delete") controller.deleted("root")
  if (event === "mode") { await modes.set("root", false); controller.modeChanged("root") }
  assert.ok(controller.revision > revision)
  const current = controller.views
  f.calls[0]!.resolve([request("b")])
  await operation
  assert.deepEqual(controller.views, current)
  assert.equal(evaluations, 1)
  if (event === "ask" || event === "mode") assert.equal(visibleReview(controller.views, "root", (id) => ({ id })), undefined)
})

test("queued mode refresh takes a post-switch revision and recovers only the fresh pending request", async (t) => {
  const evaluated: string[] = []
  const modes = new SessionModes({ read: async () => false, write: async () => {}, flush: async () => {} }, new SessionAncestry(async (id) => ({ id })))
  const controller = new Controller(async (req) => { evaluated.push(req.id); return safe }, () => {}, { modes, candidate: () => true })
  t.after(() => controller.dispose())
  controller.asked(request("old"))
  await settle()
  assert.equal(controller.views[0]?.status, "suspended")
  const f = fixture(t, controller)
  const first = f.refresh.refresh()
  await settle()
  await modes.set("root", true)
  controller.modeChanged("root")
  await f.refresh.refresh()
  f.calls[0]!.resolve([request("old")])
  await first
  await settle()
  assert.deepEqual(evaluated, [])
  assert.equal(f.calls.length, 2)
  f.calls[1]!.resolve([request("fresh")])
  await settle()
  assert.deepEqual(evaluated, ["fresh"])
  assert.deepEqual(controller.views.map((view) => view.request.id), ["fresh"])
})

test("a valid empty list resolves tracked requests, while read errors preserve them and permit recovery", async (t) => {
  const controller = new Controller(async () => safe, () => {}, { candidate: () => true })
  t.after(() => controller.dispose())
  controller.asked(request("a"))
  await settle()
  const f = fixture(t, controller)
  const failed = f.refresh.refresh()
  await settle()
  f.calls[0]!.reject(new Error("pending permissions unavailable"))
  await failed
  assert.deepEqual(controller.views.map((view) => view.request.id), ["a"])
  const successful = f.refresh.refresh()
  await settle()
  f.calls[1]!.resolve([])
  await successful
  assert.equal(controller.views.length, 0)
})

for (const stop of ["dispose", "parent abort"] as const) for (const outcome of ["resolve", "reject"] as const) {
  test(`${stop} aborts a noncooperative refresh, suppresses queued work and ignores late ${outcome}`, async (t) => {
    const f = fixture(t)
    const operation = f.refresh.refresh()
    await settle()
    await f.refresh.refresh()
    if (stop === "dispose") f.refresh.dispose()
    else f.parent.abort()
    assert.equal(f.calls[0]!.signal.aborted, true)
    await operation
    if (outcome === "resolve") f.calls[0]!.resolve([request("late")])
    else f.calls[0]!.reject(new Error("late read failure"))
    await settle()
    await f.refresh.refresh()
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.state.snapshots, [])
  })
}

test("disposal before read dispatch prevents the scheduled reader from starting", async (t) => {
  const f = fixture(t)
  const operation = f.refresh.refresh()
  f.refresh.dispose()
  await operation
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.state.snapshots, [])
})

test("already aborted lifecycle starts no pending read", async (t) => {
  const f = fixture(t)
  f.parent.abort()
  await f.refresh.refresh()
  assert.equal(f.calls.length, 0)
})
