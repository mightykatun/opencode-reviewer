import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { readPendingInvocation } from "../src/host-reader.js"
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
      get: async () => ({ id: "session", projectID: "project", location: scope.location }),
    },
    message: { list: async () => ({ data: [{ id: "user", type: "user", text: "Inspect the task" }], cursor: {} }) },
  }
  return { client: client as unknown as OpenCodeClient, rawClient: client, state, calls }
}

test("reader joins actual source and root intent, then rechecks pending identity and connected epoch", async () => {
  const f = fixture()
  const result = await readPendingInvocation(f.client, scope, request(), new AbortController().signal)
  assert.equal(result?.invocation.input.command, "python3 task.py")
  assert.equal(result?.conversation.userPrompt, "Inspect the task")
  assert.equal(result?.conversation.rootMessageID, "user")
  assert.deepEqual(f.calls, ["capture", "message", "permission", "handshake"])
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
