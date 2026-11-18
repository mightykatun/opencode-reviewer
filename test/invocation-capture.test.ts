import assert from "node:assert/strict"
import { test } from "node:test"
import { InvocationCapture } from "../src/invocation-capture.js"
import type { CompanionHandshake } from "../src/companion-protocol.js"

const handshake = (): CompanionHandshake => ({ protocol: 2, hostVersion: "2.0.26",
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

test("distinct-ID inner calls become possible candidates of the running outer and keep their own capture", () => {
  const captures = new InvocationCapture(handshake())
  const outer = { ...event("outer"), tool: "execute", input: { code: "opaque" } }
  const inner = { ...event("inner"), tool: "account_lookup", input: { account: "A" } }
  const otherMessage = { ...inner, id: "elsewhere", messageID: "other-assistant", input: { account: "M" } }
  const otherSession = { ...inner, id: "elsewhere", sessionID: "other-session", input: { account: "S" } }
  const before = { ...inner, id: "before-outer", input: { account: "early" } }
  captures.before(before)
  captures.before(outer)
  captures.before(inner); captures.before(otherMessage); captures.before(otherSession)
  inner.input.account = "rewritten"
  assert.deepEqual(captures.readCodeMode("session", "assistant", "outer")?.candidates,
    { calls: [{ tool: "account_lookup", input: { account: "A" } }], omitted: 0 }, "Only same session and message, while running")
  assert.deepEqual(captures.read("session", "assistant", "inner")?.input, { account: "A" }, "The inner call keeps an exact direct capture")
  assert.ok(captures.read("session", "assistant", "outer"), "Distinct IDs leave the outer capture exact")
  captures.after(inner)
  assert.equal(captures.read("session", "assistant", "inner"), undefined)
  assert.equal(captures.readCodeMode("session", "assistant", "outer")?.candidates.calls.length, 1, "Completed calls stay possible candidates")
  // A nested execute is never a candidate of another program.
  captures.before({ ...outer, id: "nested-execute" })
  assert.equal(captures.readCodeMode("session", "assistant", "outer")?.candidates.calls.length, 1)
  captures.after(outer)
  assert.equal(captures.readCodeMode("session", "assistant", "outer"), undefined)
  captures.before({ ...inner, id: "after-outer" })
  assert.equal(captures.readCodeMode("session", "assistant", "nested-execute")?.candidates.calls.length, 1)
  captures.after({ sessionID: outer.sessionID, messageID: outer.messageID, id: "nested-execute" })
  // Released outers leave no index behind: a reused message starts empty.
  captures.before({ ...outer, id: "next" })
  captures.before({ ...inner, id: "late" })
  assert.equal(captures.readCodeMode("session", "assistant", "next")?.candidates.calls.length, 1)
})

test("overlapping outers in one message each get every possible candidate, with no parent chosen", () => {
  const captures = new InvocationCapture(handshake())
  const first = { ...event("outer-a"), tool: "execute", input: { code: "program A" } }
  const second = { ...event("outer-b"), tool: "execute", input: { code: "program B" } }
  const direct = { ...event("direct"), tool: "account_lookup", input: { account: "direct" } }
  captures.before(first)
  captures.before({ ...event("a-1"), tool: "account_lookup", input: { account: "A" } })
  captures.before(second)
  captures.before({ ...event("b-1"), tool: "account_lookup", input: { account: "B" } })
  captures.before(direct)
  const inputs = (id: string) => captures.readCodeMode("session", "assistant", id)?.candidates.calls.map(call => call.input)
  assert.deepEqual(inputs("outer-a"), [{ account: "A" }, { account: "B" }, { account: "direct" }])
  assert.deepEqual(inputs("outer-b"), [{ account: "B" }, { account: "direct" }], "Calls before an outer started are not its candidates")
  assert.ok(captures.read("session", "assistant", "direct"), "Direct sibling captures stay exact")
  captures.after(first)
  captures.before({ ...event("b-2"), tool: "account_lookup", input: { account: "B2" } })
  assert.equal(captures.readCodeMode("session", "assistant", "outer-a"), undefined)
  assert.deepEqual(inputs("outer-b"), [{ account: "B" }, { account: "direct" }, { account: "B2" }])
  captures.after(second)
  assert.equal(captures.readCodeMode("session", "assistant", "outer-b"), undefined)
})

test("distinct-ID candidates respect slot and byte bounds without losing outers or direct captures", () => {
  const captures = new InvocationCapture(handshake())
  const outer = { ...event("outer"), tool: "execute", input: { code: "opaque" } }
  captures.before(outer)
  let accessed = false
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { accessed = true; throw Error("unreadable") } })
  captures.before({ ...event("bad"), tool: "lookup", input: accessor })
  for (let index = 0; index < 66; index++) {
    const call = { ...event(`inner-${index}`), tool: "lookup", input: { index } }
    captures.before(call); captures.after(call)
  }
  const group = captures.readCodeMode("session", "assistant", "outer")!
  assert.equal(accessed, false)
  assert.equal(group.candidates.calls.length, 64)
  assert.equal(group.candidates.omitted, 3)
  assert.deepEqual(group.outer.input, outer.input)
  // Each overlapping outer pays for its own copy within the shared byte bound.
  const big = new InvocationCapture(handshake())
  for (const id of ["a", "b"]) big.before({ ...event(id), tool: "execute", input: { code: id } })
  big.before({ ...event("large"), tool: "lookup", input: { blob: "x".repeat(6 * 1024 * 1024) } })
  assert.ok(big.read("session", "assistant", "large"), "Optional sibling evidence never displaces this call's mandatory capture")
  big.before({ ...event("larger"), tool: "lookup", input: { blob: "y".repeat(6 * 1024 * 1024) } })
  const counts = ["a", "b"].map(id => big.readCodeMode("session", "assistant", id)!.candidates)
  assert.deepEqual(counts.map(value => value.calls.length + value.omitted), [2, 2])
  assert.ok(counts.some(value => value.omitted > 0), "Copies past the byte bound are omitted whole")
  big.after({ ...event("a"), tool: "execute" }); big.after({ ...event("b"), tool: "execute" })
  big.after({ ...event("large"), tool: "lookup" }); big.after({ ...event("larger"), tool: "lookup" })
  big.before(event("fresh"))
  assert.ok(big.read("session", "assistant", "fresh"), "Released groups return their bytes")
})

test("shared-ID hosts keep exact outer grouping and are not fanned out to other outers", () => {
  const captures = new InvocationCapture(handshake())
  captures.before({ ...event("outer-a"), tool: "execute", input: { code: "A" } })
  captures.before({ ...event("outer-b"), tool: "execute", input: { code: "B" } })
  captures.before({ ...event("outer-a"), tool: "lookup", input: { shared: "A" } })
  assert.deepEqual(captures.readCodeMode("session", "assistant", "outer-a")?.candidates.calls.map(call => call.input), [{ shared: "A" }])
  assert.deepEqual(captures.readCodeMode("session", "assistant", "outer-b")?.candidates.calls, [])
  assert.equal(captures.read("session", "assistant", "outer-a"), undefined, "A shared identity stays ambiguous for direct reads")
})
