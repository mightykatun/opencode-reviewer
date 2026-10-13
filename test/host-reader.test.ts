import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { preparePendingInvocation, finalizePendingInvocation, readPendingInvocation } from "../src/host-reader.js"
import { snapshotRequest } from "../src/host-request.js"
import { TransportOwnership, bindTransportOwnership } from "../src/transport-ownership.js"
import { withDeadline } from "../src/deadline.js"

const scope = { epoch: "10000000-1000-4000-8000-100000000000", location: { directory: "/server/project" } }
const request = () => ({ id: "request", sessionID: "session", action: "shell", resources: ["python3 task.py"],
  source: { type: "tool", messageID: "assistant", id: "call" } })
const invocation = () => ({ sessionID: "session", assistantID: "assistant", callID: "call", tool: "shell",
  input: { command: "python3 task.py", workdir: "subdir" }, ...scope,
  project: { id: "project", directory: "/server", canonical: "/canonical" } })

function fixture() {
  const calls: string[] = []
  const state = { response: { request: request(), invocation: invocation() }, current: request(), epoch: scope.epoch,
    input: invocation().input, messageSession: "session" }
  const client = {
    rpc: () => ({
      invocation: async (query: unknown, options: { location: unknown }) => {
        calls.push("capture")
        assert.deepEqual(query, { ...scope, sessionID: "session", requestID: "request" })
        assert.deepEqual(options.location, scope.location)
        return state.response
      },
      handshake: async () => {
        calls.push("handshake")
        return { protocol: 1, hostVersion: "2.0.26", epoch: state.epoch, location: scope.location, project: invocation().project }
      },
    }),
    permission: { get: async (input: unknown) => {
      assert.deepEqual(input, { sessionID: "session", requestID: "request" }); calls.push("permission"); return state.current
    } },
    session: {
      message: { get: async (input: unknown) => {
        assert.deepEqual(input, { sessionID: state.messageSession, messageID: "assistant" }); calls.push("message")
        return { id: "assistant", type: "assistant", content: [{ id: "call", type: "tool", name: "shell", state: { status: "running", input: state.input } }] }
      } },
      get: async () => { calls.push("session"); return { id: "session", projectID: "project", location: scope.location } },
    },
    message: { list: async () => { calls.push("user"); return { data: [{ id: "user", type: "user", text: "Inspect the task" }], cursor: {} } } },
  }
  return { client: client as unknown as OpenCodeClient, rawClient: client, state, calls }
}

test("reader joins actual source and root intent, then rechecks pending identity and connected epoch", async () => {
  const f = fixture()
  const result = await readPendingInvocation(f.client, scope, request(), new AbortController().signal)
  assert.equal(result?.invocation.input.command, "python3 task.py")
  assert.equal(result?.conversation.userPrompt, "Inspect the task")
  assert.equal(result?.conversation.rootMessageID, "user")
  assert.deepEqual(f.calls, ["capture", "message", "session", "user", "permission", "handshake"])
})

test("preparation owns capture binding and conversation, while explicit finalization performs only fresh identity and epoch checks", async () => {
  const f = fixture(), abort = new AbortController(), snapshot = snapshotRequest(request(), scope)!
  const prepared = await preparePendingInvocation(f.client, snapshot, abort.signal)
  assert.ok(prepared)
  assert.equal(prepared.snapshot, snapshot)
  assert.equal(prepared.conversation.userPrompt, "Inspect the task")
  assert.deepEqual(f.calls, ["capture", "message", "session", "user"])
  assert.equal(await finalizePendingInvocation(f.client, prepared, abort.signal), prepared)
  assert.deepEqual(f.calls, ["capture", "message", "session", "user", "permission", "handshake"])
})

test("missing source and changed capture request cannot dispatch message/context lookups", async () => {
  const f = fixture(), { source: _, ...unlinked } = request()
  assert.equal(await readPendingInvocation(f.client, scope, unlinked, new AbortController().signal), undefined)
  assert.deepEqual(f.calls, [])
  f.state.response.request.resources = ["different"]
  assert.equal(await readPendingInvocation(f.client, scope, request(), new AbortController().signal), undefined)
  assert.deepEqual(f.calls, ["capture"])
})

test("argument rewrites, late permission mutation and companion replacement reject the result", async () => {
  for (const change of ["arguments", "permission", "epoch"] as const) {
    const f = fixture()
    if (change === "arguments") f.state.input.command = "different"
    if (change === "permission") f.state.current.resources = ["different"]
    if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
    assert.equal(await readPendingInvocation(f.client, scope, request(), new AbortController().signal), undefined, change)
  }
})

test("captured source, session, epoch and location mismatches stop before conversation or final reads", async () => {
  for (const change of ["assistant", "call", "session", "epoch", "location"] as const) {
    const f = fixture(), captured = f.state.response.invocation
    if (change === "assistant") captured.assistantID = "other-assistant"
    if (change === "call") captured.callID = "other-call"
    if (change === "session") captured.sessionID = "other-session"
    if (change === "epoch") captured.epoch = "20000000-1000-4000-8000-100000000000"
    if (change === "location") captured.location = { directory: "/other-project" }
    assert.equal(await readPendingInvocation(f.client, scope, request(), new AbortController().signal), undefined, change)
    assert.deepEqual(f.calls, ["capture", "message"], change)
  }
})

test("request previews and invocation arguments each receive their own 16 MiB RPC allowance", async () => {
  const f = fixture(), command = "x".repeat(9 * 1024 * 1024)
  const pending = { ...request(), metadata: { preview: "p".repeat(9 * 1024 * 1024) } }
  f.state.response.request = pending
  f.state.current = pending
  f.state.response.invocation.input.command = command
  f.state.input.command = command
  const result = await readPendingInvocation(f.client, scope, pending, new AbortController().signal)
  assert.equal(result?.invocation.input.command, command)
  assert.deepEqual(result?.snapshot.request.metadata, pending.metadata)
  assert.deepEqual(f.calls, ["capture", "message", "session", "user", "permission", "handshake"])
})

test("invalid invocation envelope framing and over-cap components stop before source/context reads", async () => {
  let accessed = 0
  for (const change of [
    (value: unknown) => ({ ...(value as object), extra: true }),
    (value: unknown) => Object.defineProperty(value, "invocation", { get() { accessed++; return invocation() } }),
    (value: unknown) => new Proxy(value as object, { ownKeys() { accessed++; throw Error("Must not run") } }),
    (value: unknown) => ({ ...(value as object), request: { ...request(), metadata: { preview: "x".repeat(16 * 1024 * 1024) } } }),
    (value: unknown) => ({ ...(value as object), invocation: { ...invocation(), input: { command: "x".repeat(16 * 1024 * 1024) } } }),
  ]) {
    const f = fixture(), methods = f.rawClient.rpc()
    f.rawClient.rpc = () => ({ ...methods, invocation: async (...args: Parameters<typeof methods.invocation>) =>
      change(await methods.invocation(...args)) as typeof f.state.response })
    assert.equal(await readPendingInvocation(f.client, scope, request(), new AbortController().signal), undefined)
    assert.deepEqual(f.calls, ["capture"])
  }
  assert.equal(accessed, 0)
})

test("deadline expiry keeps the actual capture RPC owned until late settlement and prevents subsequent reads", async () => {
  const f = fixture(), abort = new AbortController(), ownership = new TransportOwnership()
  bindTransportOwnership(abort.signal, ownership)
  let resolve!: (value: typeof f.state.response) => void
  const pending = new Promise<typeof f.state.response>(yes => { resolve = yes })
  f.rawClient.rpc = () => ({ invocation: async () => { f.calls.push("capture"); return pending }, handshake: async () => {
    throw Error("Must not dispatch handshake after timeout")
  } })
  await assert.rejects(withDeadline(abort.signal, 10,
    signal => readPendingInvocation(f.client, scope, request(), signal)), /timed out/)
  let settled = false
  const actual = ownership.settled().then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  resolve(f.state.response)
  await actual
  assert.deepEqual(f.calls, ["capture"])
})

test("standalone final reads remain owned through cancellation and cannot yield a late result", async () => {
  for (const stage of ["permission", "handshake"] as const) {
    const f = fixture(), abort = new AbortController(), ownership = new TransportOwnership()
    bindTransportOwnership(abort.signal, ownership)
    let started!: () => void, resolve!: (value: any) => void
    const dispatched = new Promise<void>(yes => { started = yes })
    const pending = new Promise<any>(yes => { resolve = yes })
    if (stage === "permission") f.rawClient.permission.get = async () => { f.calls.push("permission"); started(); return pending }
    else {
      const methods = f.rawClient.rpc()
      f.rawClient.rpc = () => ({ ...methods, handshake: async () => { f.calls.push("handshake"); started(); return pending } })
    }
    const reading = readPendingInvocation(f.client, scope, request(), abort.signal)
    await dispatched
    abort.abort(Error("Stop standalone read"))
    await assert.rejects(reading, /Stop standalone read/)
    let settled = false
    const actual = ownership.settled().then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, stage)
    resolve(stage === "permission" ? f.state.current
      : { protocol: 1, epoch: scope.epoch, location: scope.location, project: invocation().project })
    await actual
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "permission", ...(stage === "handshake" ? ["handshake"] : [])])
  }
})
