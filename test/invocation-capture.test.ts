import assert from "node:assert/strict"
import { test } from "node:test"
import { InvocationCapture } from "../src/invocation-capture.js"
import type { CompanionHandshake } from "../src/companion-protocol.js"

const handshake = (): CompanionHandshake => ({ protocol: 1, hostVersion: "2.0.26",
  epoch: "10000000-1000-4000-8000-100000000000", location: { directory: "/invocation", workspaceID: "workspace-a" },
  project: { id: "project-a", directory: "/project", canonical: "/canonical" } })
const event = (id: string, input = { command: "python3 task.py", workdir: "relative" }) => ({
  sessionID: "session", messageID: "assistant", id, tool: "shell", input,
})

test("parallel equal-resource calls retain exact independent source and invocation location across mutations", () => {
  const scope = handshake(), captures = new InvocationCapture(scope)
  const first = event("call-a"), second = event("call-b", { command: "python3 task.py B", workdir: "relative" })
  captures.before(first); captures.before(second)
  first.input.command = "rewritten after capture"
  scope.location.directory = "/moved"
  const found = captures.read("session", "assistant", "call-a")!
  assert.equal(found.input.command, "python3 task.py")
  assert.equal(found.scope.location.directory, "/invocation")
  assert.equal(found.scope.location.workspaceID, "workspace-a")
  found.input.command = "reader mutation"
  assert.equal(captures.read("session", "assistant", "call-a")!.input.command, "python3 task.py")
  assert.equal(captures.read("session", "assistant", "call-b")!.input.command, "python3 task.py B")
  assert.equal(captures.read("sibling", "assistant", "call-a"), undefined)
  assert.equal(captures.read("session", "other-assistant", "call-a"), undefined)
  captures.after(second)
  assert.equal(captures.read("session", "assistant", "call-b"), undefined)
  assert.ok(captures.read("session", "assistant", "call-a"))
})

test("duplicate identity remains manual rather than selecting a writer or blocking unrelated calls", () => {
  const captures = new InvocationCapture(handshake())
  captures.before(event("call")); captures.before(event("call"))
  assert.equal(captures.read("session", "assistant", "call"), undefined)
  captures.before(event("different"))
  assert.ok(captures.read("session", "assistant", "different"))
  captures.after(event("call"))
  captures.before(event("call"))
  assert.equal(captures.read("session", "assistant", "call"), undefined)
})

test("capacity failure cannot evict then resurrect a request; a new companion owns a separate epoch", () => {
  const captures = new InvocationCapture(handshake())
  for (let index = 0; index < 513; index++) captures.before(event(String(index)))
  captures.before(event("0"))
  assert.equal(captures.read("session", "assistant", "0"), undefined)
  const next = new InvocationCapture({ ...handshake(), epoch: "20000000-1000-4000-8000-100000000000" })
  next.before(event("0"))
  assert.equal(next.read("session", "assistant", "0")?.scope.epoch, "20000000-1000-4000-8000-100000000000")
  next.clear()
  assert.equal(next.read("session", "assistant", "0"), undefined)
})

test("long Code Mode sessions release completed ambiguous calls without admitting pending siblings", () => {
  const captures = new InvocationCapture(handshake())
  const held = event("held-direct")
  captures.before(held)
  for (let index = 0; index < 1024; index++) {
    const outer = { ...event(`code-${index}`), tool: "execute", input: { code: "nested calls" } }
    const nested = event(outer.id)
    captures.before(outer)
    captures.before(nested)
    captures.after(nested)
    assert.equal(captures.read("session", "assistant", outer.id), undefined)
    // A later sibling still shares the in-flight outer identity.
    captures.before(nested)
    captures.after(outer)
    assert.equal(captures.read("session", "assistant", outer.id), undefined)
    captures.after(nested)
    assert.ok(captures.read("session", "assistant", held.id))
    const direct = event(`direct-${index}`)
    captures.before(direct)
    assert.equal(captures.read("session", "assistant", direct.id)?.tool, "shell")
    captures.after(direct)
  }
})

test("completed invalid captures release capacity and bytes for later direct reviews", () => {
  const captures = new InvocationCapture(handshake())
  for (let index = 0; index < 1024; index++) {
    const invalid = { ...event(String(index)), input: { command: NaN } }
    captures.before(invalid)
    captures.after(invalid)
  }
  captures.before(event("valid"))
  assert.ok(captures.read("session", "assistant", "valid"))
})

test("invalid/oversized mandatory input stays unavailable without executing accessors or throwing into the tool", () => {
  let accessed = false
  const accessor = Object.defineProperty({}, "command", { enumerable: true, get() { accessed = true; throw Error("unexpected") } })
  for (const input of [accessor, { command: "x".repeat(16 * 1024 * 1024) }, { command: NaN }, { command: -0 }, { command: new Date() }]) {
    const captures = new InvocationCapture(handshake())
    assert.doesNotThrow(() => captures.before({ ...event("call"), input }))
    assert.equal(captures.read("session", "assistant", "call"), undefined)
  }
  assert.equal(accessed, false)
})

test("Code Mode retains candidates without selecting a permission owner and releases the entire group", () => {
  const captures = new InvocationCapture(handshake())
  const outer = { ...event("outer"), tool: "execute", input: { code: "opaque code, never parsed" } }
  const first = { ...event("outer"), tool: "account_lookup", input: { account: "A" } }
  const second = { ...first, input: { account: "B" } }
  captures.before(outer); captures.before(first); captures.before(second)
  first.input.account = "rewritten"
  assert.equal(captures.read("session", "assistant", "outer"), undefined)
  const group = captures.readCodeMode("session", "assistant", "outer")!
  assert.deepEqual(group.outer.input, outer.input)
  assert.deepEqual(group.candidates, { calls: [
    { tool: "account_lookup", input: { account: "A" } }, { tool: "account_lookup", input: { account: "B" } },
  ], omitted: 0 })
  captures.after(first)
  assert.deepEqual(captures.readCodeMode("session", "assistant", "outer"), group, "Completed sibling observations are retained factually")
  captures.after(outer)
  assert.equal(captures.readCodeMode("session", "assistant", "outer"), undefined, "A settled outer execution cannot authorize a new read")
  captures.before(outer)
  assert.equal(captures.readCodeMode("session", "assistant", "outer"), undefined, "Reused outer identity remains ambiguous until all hooks settle")
  captures.after(outer); captures.after(second)
  captures.before(outer); captures.before(second)
  assert.equal(captures.readCodeMode("session", "assistant", "outer")?.candidates.calls.length, 1)
  captures.after(second); captures.after(outer)
  assert.equal(captures.readCodeMode("session", "assistant", "outer"), undefined)
})

test("Code Mode candidate bounds omit whole calls without losing the exact outer input or running accessors", () => {
  const captures = new InvocationCapture(handshake())
  const outer = { ...event("outer"), tool: "execute", input: { code: "opaque" } }
  captures.before(outer)
  let accessed = false
  const input = Object.defineProperty({}, "secret", { enumerable: true, get() { accessed = true; throw Error("unreadable") } })
  captures.before({ ...event("outer"), tool: "lookup", input })
  for (let index = 0; index < 66; index++) captures.before({ ...event("outer"), tool: "lookup", input: { index } })
  const group = captures.readCodeMode("session", "assistant", "outer")!
  assert.equal(accessed, false)
  assert.equal(group.candidates.calls.length, 64)
  assert.equal(group.candidates.omitted, 3)
  assert.deepEqual(group.outer.input, outer.input)
  captures.clear()
  assert.equal(captures.readCodeMode("session", "assistant", "outer"), undefined)
})
