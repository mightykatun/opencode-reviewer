import assert from "node:assert/strict"
import { test } from "node:test"
import { bindHostInvocation } from "../src/host-invocation.js"
import { readHostInvocation, snapshotRequest } from "../src/host-request.js"

const scope = { epoch: "epoch-a", location: { directory: "/invocation", workspaceID: "workspace-a" } }
const raw = { id: "permission", sessionID: "session", action: "shell", resources: ["python3 task.py"],
  source: { type: "tool", messageID: "assistant", id: "call" } }
const input = { command: "python3 task.py", workdir: "relative" }
const capture = () => readHostInvocation({ sessionID: "session", assistantID: "assistant", callID: "call", tool: "shell",
  input, ...scope, project: { id: "project", directory: "/project", canonical: "/canonical" } })!
const tool = () => ({ type: "tool", id: "call", name: "shell", state: { status: "running", input: { ...input } } })
const message = () => ({ id: "assistant", type: "assistant", content: [tool()] })

test("exact pending source binds only its scoped direct durable call, independent of other content", () => {
  const snapshot = snapshotRequest(raw, scope)!, captured = capture(), value = message()
  assert.equal(bindHostInvocation(snapshot, "session", value, captured), captured)
  const unrelated = Object.defineProperty({ type: "reasoning", id: "reasoning" }, "text", { get() { throw Error("Unrelated text must not be read") } })
  assert.equal(bindHostInvocation(snapshot, "session", { ...value, content: [unrelated, tool()] }, captured), captured)
  assert.equal(bindHostInvocation(snapshot, "sibling", value, captured), undefined)
  for (const altered of [{ ...captured, epoch: "old" }, { ...captured, sessionID: "sibling" },
    { ...captured, assistantID: "other" }, { ...captured, callID: "other" },
    { ...captured, location: { ...scope.location, workspaceID: "other" } }])
    assert.equal(bindHostInvocation(snapshot, "session", value, altered), undefined)
})

test("changed arguments, duplicate calls, terminal states and unobserved calls never bind", () => {
  const snapshot = snapshotRequest(raw, scope)!, captured = capture()
  for (const value of [
    { ...message(), id: "other" }, { ...message(), type: "user" },
    { ...message(), content: [tool(), tool()] },
    { ...message(), content: [{ ...tool(), state: { status: "completed", input } }] },
    { ...message(), content: [{ ...tool(), state: { status: "running", input: { ...input, command: "different" } } }] },
  ]) assert.equal(bindHostInvocation(snapshot, "session", value, captured), undefined)
  assert.equal(bindHostInvocation(snapshot, "session", message(), undefined), undefined)
  const { source: _, ...unlinked } = raw
  assert.equal(bindHostInvocation(snapshotRequest(unlinked, scope)!, "session", message(), captured), undefined)
})

test("native Code Mode outer calls cannot be substituted for nested tool identity or reviewed as direct calls", () => {
  const snapshot = snapshotRequest(raw, scope)!, captured = capture()
  const outer = { ...message(), content: [{ ...tool(), name: "execute" }] }
  assert.equal(bindHostInvocation(snapshot, "session", outer, captured), undefined)
  assert.equal(bindHostInvocation(snapshot, "session", outer, { ...captured, tool: "execute" }), undefined)
})

test("mandatory item accessors are not executed", () => {
  let read = false
  const item = Object.defineProperty(tool(), "state", { get() { read = true; throw Error("unexpected") } })
  assert.equal(bindHostInvocation(snapshotRequest(raw, scope)!, "session", { ...message(), content: [item] }, capture()), undefined)
  assert.equal(read, false)
})
