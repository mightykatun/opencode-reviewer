import { test } from "node:test"
import assert from "node:assert/strict"
import type { PermissionRequest } from "@opencode/client"
import { boundedHostJSON, hostJSONBytes, readHostInvocation, readHostRequest, readHostScope, sameRequest, snapshotRequest, serverRequestJSON, hostRequestWire } from "../src/host-request.js"

const at = () => ({ location: { directory: "/project/A", workspaceID: "workspace-A" }, epoch: "connection-A" })

// Independent literals from the 2.0.26 effective-evidence shell/edit/skill probes.
// No runtime artifact or filesystem is needed to run these tests.
const shell = () => ({
  id: "per_shell", sessionID: "ses_root", action: "shell", resources: ["python3 fixture.py"], save: ["python3 *"],
  source: { type: "tool", messageID: "msg_assistant", id: "w3-shell-A" },
} satisfies PermissionRequest)

const invocation = () => ({
  sessionID: "ses_root", assistantID: "msg_assistant", callID: "w3-shell-A", tool: "shell",
  input: { command: "python3 fixture.py # W3 model A", workdir: "/project/A/inputs" },
  ...at(), project: { id: "global", directory: "/project", canonical: "/canonical" },
})

test("direct server request encoding omits only known optional undefined fields", () => {
  const native = { ...shell(), metadata: undefined, message: undefined }
  assert.equal(readHostRequest(native), undefined, "Unencoded values cannot cross the wire projection")
  assert.deepEqual(serverRequestJSON(native), shell())
  assert.equal(serverRequestJSON({ ...native, unknown: undefined }), undefined)
  assert.equal(serverRequestJSON({ ...shell(), metadata: { omitted: undefined } }), undefined)
  let accessed = false
  const getter = Object.defineProperty({ ...shell() }, "message", { enumerable: true, get() { accessed = true; throw Error("unexpected") } })
  assert.equal(serverRequestJSON(getter), undefined)
  assert.equal(accessed, false)
})

test("owned request wire round-trip restores only native source spelling and cannot admit a forged snapshot", () => {
  const raw = shell(), snapshot = snapshotRequest(raw, at())!
  assert.deepEqual(hostRequestWire(snapshot), raw)
  assert.ok(sameRequest(snapshot, snapshotRequest(hostRequestWire(snapshot), at())!))
  assert.equal(hostRequestWire({ request: snapshot.request, scope: snapshot.scope }), undefined)
})

test("pinned tool source maps exact assistant and call IDs without renaming shell", () => {
  assert.deepEqual(readHostRequest(shell()), {
    id: "per_shell", sessionID: "ses_root", action: "shell", resources: ["python3 fixture.py"], save: ["python3 *"],
    source: { assistantID: "msg_assistant", id: "w3-shell-A" },
  })
  const minimal = { id: "per_custom", sessionID: "ses_root", action: "shell", resources: [] }
  assert.deepEqual(readHostRequest(minimal), minimal)
  assert.equal(Object.hasOwn(readHostRequest(minimal)!, "source"), false)
  assert.equal(Object.hasOwn(readHostRequest(minimal)!, "metadata"), false)
  assert.equal(Object.hasOwn(readHostRequest(minimal)!, "save"), false)
  assert.equal(Object.hasOwn(readHostRequest(minimal)!, "message"), false)
})

test("pending edit, directory and skill shapes retain exact mandatory data", () => {
  const requests: PermissionRequest[] = [
    { ...shell(), action: "edit", resources: ["target.txt"], save: ["*"], metadata: { files: [{
      file: "target.txt", patch: "Index: target.txt\n===================================================================\n--- target.txt\n+++ target.txt\n@@ -1,1 +1,1 @@\n-W3_BEFORE\n+W3_AFTER\n",
      status: "modified", additions: 1, deletions: 1,
    }] }, source: { type: "tool", messageID: "msg_assistant", id: "w3-write-local" } },
    { ...shell(), action: "external_directory", resources: ["/external/*"], save: ["/external/*"] },
    { ...shell(), action: "skill", resources: ["w3-evidence"], save: ["w3-evidence"] },
  ]
  for (const raw of requests) {
    const result = readHostRequest(raw)!
    assert.deepEqual(result.resources, raw.resources)
    assert.deepEqual(result.save, raw.save)
    assert.deepEqual(result.metadata, raw.metadata)
    assert.equal(result.action, raw.action)
  }
})

test("identity ignores object field order but includes every request field and array position", () => {
  const raw = { ...shell(), resources: ["a", "b", "a"], save: ["x", "y", "x"], message: "", metadata: { z: [1, { b: 2, a: true }], a: null } }
  const first = snapshotRequest(raw, at())!
  const reordered = { metadata: { a: null, z: [1, { a: true, b: 2 }] }, message: "", save: ["x", "y", "x"],
    resources: ["a", "b", "a"], source: { id: "w3-shell-A", messageID: "msg_assistant", type: "tool" },
    action: "shell", sessionID: "ses_root", id: "per_shell" }
  assert.equal(sameRequest(first, snapshotRequest(reordered, { epoch: "connection-A", location: { workspaceID: "workspace-A", directory: "/project/A" } })!), true)
  for (const change of [
    { id: "other" }, { sessionID: "other" }, { action: "bash" }, { resources: ["b", "a", "a"] }, { resources: ["a", "b"] },
    { save: ["y", "x", "x"] }, { save: ["x", "y"] }, { metadata: { z: [1, { b: 3, a: true }], a: null } }, { message: "changed" },
    { source: { ...raw.source, id: "another-call" } }, { source: { ...raw.source, messageID: "another-assistant" } },
  ]) assert.equal(sameRequest(first, snapshotRequest({ ...raw, ...change }, at())!), false, JSON.stringify(change))
  assert.deepEqual(first.request.resources, ["a", "b", "a"])
  assert.deepEqual(first.request.save, ["x", "y", "x"])
})

test("absence differs from empty optional fields and all scope changes", () => {
  const minimal = { id: "per", sessionID: "ses", action: "custom", resources: [] }
  const first = snapshotRequest(minimal, at())!
  for (const change of [{ metadata: {} }, { save: [] }, { message: "" }, { source: shell().source }]) {
    assert.equal(sameRequest(first, snapshotRequest({ ...minimal, ...change }, at())!), false)
  }
  for (const changed of [
    { ...at(), epoch: "connection-B" },
    { ...at(), location: { directory: "/project/B", workspaceID: "workspace-A" } },
    { ...at(), location: { directory: "/project/A", workspaceID: "workspace-B" } },
    { ...at(), location: { directory: "/project/A" } },
    { ...at(), location: { directory: "/project/A/", workspaceID: "workspace-A" } },
  ]) assert.equal(sameRequest(first, snapshotRequest(minimal, changed)!), false)
})

test("projection is immutable and detached from later host mutations", () => {
  const raw = { ...shell(), metadata: { files: [{ patch: "before" }] } }, scope = at()
  const first = snapshotRequest(raw, scope)!
  raw.resources[0] = "changed"; raw.save.push("*"); raw.source.id = "changed"
  raw.metadata.files[0]!.patch = "after"; scope.location.directory = "/elsewhere"; scope.epoch = "new"
  assert.equal(first.request.resources[0], "python3 fixture.py")
  assert.equal(first.request.source!.id, "w3-shell-A")
  assert.deepEqual(first.request.metadata, { files: [{ patch: "before" }] })
  assert.deepEqual(first.scope, at())
  assert.throws(() => { (first.request.resources as string[]).push("changed") }, TypeError)
  assert.equal(Object.isFrozen(first.request.metadata!.files), true)
  assert.equal(sameRequest(first, snapshotRequest(raw, scope)!), false)
})

test("unknown request/source/scope fields fail instead of silently narrowing", () => {
  for (const extra of [{ futureScope: ["*"] }, { location: { directory: "/other" } }, { permission: "bash" }]) {
    assert.equal(readHostRequest({ ...shell(), ...extra }), undefined)
  }
  for (const source of [
    { type: "tool", messageID: "msg", id: "call", extra: "scope" },
    { type: "other", messageID: "msg", id: "call" }, { assistantID: "msg", id: "call" },
    { type: "tool", messageID: "", id: "call" }, { type: "tool", messageID: "msg", id: "" },
    { type: "tool", id: "call" }, null, undefined,
  ]) assert.equal(readHostRequest({ ...shell(), source }), undefined)
  for (const scope of [
    { ...at(), extra: true }, { ...at(), location: { ...at().location, project: "extra" } },
    { ...at(), epoch: undefined }, { ...at(), location: { directory: "relative" } },
    { ...at(), location: { directory: "/project", workspaceID: undefined } },
  ]) assert.equal(readHostScope(scope), undefined)
})

test("invalid scalars and explicit undefined never become missing optional fields", () => {
  for (const raw of [null, [], 1, "request", {},
    { ...shell(), resources: "*" }, { ...shell(), resources: [1] }, { ...shell(), save: [null] },
    { ...shell(), metadata: [] }, { ...shell(), metadata: null }, { ...shell(), message: 1 },
    { ...shell(), id: "" }, { ...shell(), sessionID: "" }, { ...shell(), action: "" },
  ]) assert.equal(readHostRequest(raw), undefined)
  for (const key of ["save", "metadata", "source", "message"]) {
    assert.equal(readHostRequest({ ...shell(), [key]: undefined }), undefined)
  }
})

test("accessors, proxies, sparse arrays and non-JSON fields never run or disappear", () => {
  let evaluated = 0
  const getter = { get command() { evaluated++; return "do not run" } }
  const top = Object.defineProperty(shell(), "message", { enumerable: true, get() { evaluated++; return "do not run" } })
  const arrayGetter = Object.defineProperty(["a"], "0", { enumerable: true, get() { evaluated++; return "do not run" } })
  const proxy = new Proxy({}, { ownKeys() { evaluated++; throw new Error("do not run") }, get() { evaluated++; return null } })
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  for (const invalid of [getter, proxy, cyclic, { x: undefined }, { x: NaN }, { x: Infinity }, { x: 1n }, { x: Symbol() },
    { x() {} }, new Date(), new Map(), Object.create({ inherited: "evidence" }),
    Object.defineProperty({}, "hidden", { value: "evidence" }), { [Symbol("scope")]: "evidence" },
    { values: [, "b"] }, { values: arrayGetter }, { values: Object.assign(["a"], { extra: "evidence" }) },
  ]) assert.equal(readHostRequest({ ...shell(), metadata: invalid }), undefined)
  assert.equal(readHostRequest(top), undefined)
  assert.equal(evaluated, 0)
})

test("JSON special keys and scalar values survive without prototype effects", () => {
  const metadata = JSON.parse('{"__proto__":{"scope":"exact"},"constructor":"literal","values":[null,false,0,"",-1.5]}')
  const result = readHostRequest({ ...shell(), metadata })!
  assert.deepEqual(result.metadata, metadata)
  assert.equal(Object.getPrototypeOf(result.metadata), Object.prototype)
  assert.equal(Object.hasOwn(result.metadata!, "__proto__"), true)
  assert.ok(readHostRequest({ ...shell(), metadata: Object.assign(Object.create(null), { scope: "exact" }) }))
})

test("preprocessing uses one finite byte ceiling without truncating large commands or names", () => {
  assert.equal(hostJSONBytes, 16 * 1024 * 1024)
  const command = "é".repeat(128 * 1024)
  const captured = readHostInvocation({ ...invocation(), input: { command } })!
  assert.equal(captured.input.command, command)
  const name = "n".repeat(128 * 1024)
  assert.equal(readHostRequest({ ...shell(), action: name })!.action, name)
  assert.equal(boundedHostJSON("x".repeat(hostJSONBytes - 2)), "x".repeat(hostJSONBytes - 2))
  assert.equal(boundedHostJSON("x".repeat(hostJSONBytes - 1)), undefined)
  assert.equal(boundedHostJSON("é".repeat(hostJSONBytes / 2)), undefined)
  assert.equal(readHostInvocation({ ...invocation(), input: { command: "x".repeat(hostJSONBytes) } }), undefined)
})

test("depth and value limits reject whole mandatory structures", () => {
  let deep: unknown = null
  for (let index = 0; index < 33; index++) deep = { child: deep }
  assert.equal(boundedHostJSON(deep), undefined)
  assert.equal(readHostRequest({ ...shell(), metadata: { values: Array(16384).fill(null) } }), undefined)
  const accepted = boundedHostJSON(Array(16383).fill(null))
  assert.ok(Array.isArray(accepted))
  assert.equal(accepted.length, 16383)
})

test("captured invocation retains independent location, project, epoch, input and IDs", () => {
  const raw = invocation(), captured = readHostInvocation(raw)!
  assert.deepEqual(captured, raw)
  raw.input.command = "changed"; raw.project.canonical = "/elsewhere"; raw.location.directory = "/other"
  assert.equal(captured.input.command, "python3 fixture.py # W3 model A")
  assert.equal(captured.location.directory, "/project/A")
  assert.equal(captured.project.directory, "/project")
  assert.equal(captured.project.canonical, "/canonical")
  assert.equal(captured.assistantID, "msg_assistant")
  assert.equal(captured.callID, "w3-shell-A")
  assert.equal(Object.isFrozen(captured.input), true)
  for (const change of [
    { input: [] }, { input: undefined }, { assistantID: "" }, { callID: "" }, { sessionID: "" }, { epoch: "" },
    { project: { id: "global", directory: "/project" } }, { project: { ...raw.project, canonical: "relative" } },
    { project: { ...raw.project, extra: true } }, { location: { directory: "/project", extra: true } }, { extra: true },
  ]) assert.equal(readHostInvocation({ ...invocation(), ...change }), undefined)
})
