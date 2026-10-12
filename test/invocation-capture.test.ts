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
