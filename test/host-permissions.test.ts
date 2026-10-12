import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { hostPermissionTransport } from "../src/host-permissions.js"
import { snapshotRequest } from "../src/host-request.js"

const location = { directory: "/invocation", workspaceID: "workspace" }, scope = { location, epoch: "10000000-1000-4000-8000-100000000000" }
const raw = () => ({ id: "request", sessionID: "session", action: "shell", resources: ["python3 fixture.py"], save: ["python3 *"] })
const signal = () => new AbortController().signal
function fixture() {
  const state = { epoch: scope.epoch, directory: location.directory, request: raw(), calls: [] as unknown[], reject: false }
  const client = {
    rpc: () => ({ handshake: async () => ({ protocol: 1, hostVersion: "2.0.26", epoch: state.epoch, location,
      project: { id: "project", directory: "/project", canonical: "/canonical" } }) }),
    session: { get: async () => ({ id: "session", location: { directory: state.directory } }) },
    permission: {
      request: { list: async () => ({ location: { directory: state.directory }, data: [state.request, { ...state.request, id: "child-request", sessionID: "child" }] }) },
      get: async () => state.request,
      list: async () => [state.request],
      reply: async (input: unknown, options: unknown) => { state.calls.push({ input, options }); if (state.reject) throw Error("uncertain delivery") },
    },
  }
  return { state, transport: hostPermissionTransport(client as unknown as OpenCodeClient, scope) }
}

test("permission transport retains exact ordered pending data and only submits once in invocation scope", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
  assert.deepEqual(await f.transport.list("session", signal()), [snapshot])
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "submitted")
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "unavailable")
  assert.equal(f.state.calls.length, 1)
  assert.deepEqual((f.state.calls[0] as any).input, { sessionID: "session", requestID: "request", decision: "once" })
  assert.deepEqual((f.state.calls[0] as any).options.location, location)
})

test("location reconciliation retains root and descendant requests instead of mistaking one session for a complete snapshot", async () => {
  const f = fixture()
  const all = await f.transport.listScope(signal())
  assert.deepEqual(all.map(item => [item.request.sessionID, item.request.id]), [["session", "request"], ["child", "child-request"]])
  f.state.directory = "/other"
  await assert.rejects(f.transport.listScope(signal()), /location unavailable/)
})

test("epoch/location/identity/presentation loss blocks dispatch without gaining a retry tombstone", async () => {
  for (const change of ["epoch", "location", "identity", "eligible"] as const) {
    const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
    if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
    if (change === "location") f.state.directory = "/tool-workdir"
    if (change === "identity") f.state.request.resources = ["changed"]
    assert.equal((await f.transport.once(snapshot, signal(), () => change !== "eligible")).status, "unavailable")
    assert.deepEqual(f.state.calls, [])
    f.state.epoch = scope.epoch; f.state.directory = location.directory; f.state.request = raw()
    assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "submitted")
  }
})

test("parallel attempts are single-flight and uncertain writes cannot be retried", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
  f.state.reject = true
  const results = await Promise.all([f.transport.once(snapshot, signal(), () => true), f.transport.once(snapshot, signal(), () => true)])
  assert.deepEqual(results.map(item => item.status).sort(), ["unavailable", "uncertain"])
  f.state.reject = false
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "unavailable")
  assert.equal(f.state.calls.length, 1)
})

test("a snapshot from another connection cannot write, including metadata-only mutations", async () => {
  const f = fixture()
  const other = snapshotRequest(raw(), { ...scope, epoch: "20000000-1000-4000-8000-100000000000" })!
  assert.equal((await f.transport.once(other, signal(), () => true)).status, "unavailable")
  const withMetadata = snapshotRequest({ ...raw(), metadata: { command: "different" } }, scope)!
  assert.equal((await f.transport.once(withMetadata, signal(), () => true)).status, "unavailable")
  assert.deepEqual(f.state.calls, [])
})

test("actual-dispatch guard runs only after preparation and immediately before native invocation", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!, order: string[] = []
  const pending = f.transport.once(snapshot, signal(), () => {
    assert.equal(f.state.calls.length, 0)
    order.push("dispatch")
    queueMicrotask(() => { assert.equal(f.state.calls.length, 1); order.push("after invocation") })
    return true
  })
  assert.deepEqual(order, [], "async host preparation is not dispatch")
  assert.equal((await pending).status, "submitted")
  assert.deepEqual(order, ["dispatch", "after invocation"])
})

test("failed epoch/source checks and aborted preparation never invoke the dispatch callback", async () => {
  for (const change of ["epoch", "source", "abort"] as const) {
    const f = fixture(), controller = new AbortController()
    const snapshot = snapshotRequest({ ...raw(), ...(change === "source" ? { source: { type: "tool", messageID: "assistant", id: "call" } } : {}) }, scope)!
    if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
    if (change === "abort") controller.abort()
    let dispatched = 0
    assert.equal((await f.transport.once(snapshot, controller.signal, () => { dispatched++; return true })).status, "unavailable")
    assert.equal(dispatched, 0)
    assert.deepEqual(f.state.calls, [])
  }
})
