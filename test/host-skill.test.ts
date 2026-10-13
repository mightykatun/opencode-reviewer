import assert from "node:assert/strict"
import { test } from "node:test"
import { readRegisteredSkill, requestedSkill } from "../src/host-skill.js"
import { collectHostEvidence, readHostOperationEvidence, type HostEvidenceOptions } from "../src/host-evidence.js"
import { nativeInvocation } from "./review-fixtures.js"
import { FileAccess } from "../src/file-access.js"
import { snapshotRequest } from "../src/host-request.js"
import type { JSONObject } from "../src/host-types.js"

const location = { directory: "/project" }
const entry = { id: "review", name: "Review", path: "/project/.opencode/skills/review.md", content: "Summarize the requested changes.\n" }
const catalog = (data: unknown = [entry], scope: unknown = location) => ({ location: scope, data })
const options: HostEvidenceOptions = { reviewBash: false, reviewEdits: false, reviewExternalDirectories: false,
  reviewSkills: true, reviewMcp: true, reviewCustomTools: true, maxFiles: 1, maxEvidenceBytes: 131072 }
function owned() {
  const value = nativeInvocation("skill", { id: entry.id }, undefined, location.directory, [entry.id])
  const snapshot = snapshotRequest({ id: "request", sessionID: value.invocation.sessionID, action: "skill", resources: [entry.id],
    source: { type: "tool", messageID: value.invocation.assistantID, id: value.invocation.callID } }, value.snapshot.scope)!
  return { ...value, snapshot }
}
const signal = () => new AbortController().signal
const noFiles = () => new FileAccess({ open: () => { assert.fail("Skill collection must not open files") },
  realpath: () => { assert.fail("Skill collection must not resolve target paths") } } as any)

test("skill selection uses exact scoped IDs and full current registry instructions, not names or fresh files", () => {
  const other = { id: "other", get content() { return assert.fail("Other skill bodies are optional and must not be read") } }
  assert.deepEqual(readRegisteredSkill(catalog([other, entry]), location, "review"), entry)
  assert.equal(readRegisteredSkill(catalog(), location, "Review"), undefined)
  assert.equal(readRegisteredSkill(catalog(), { directory: "/elsewhere" }, "review"), undefined)
  assert.equal(readRegisteredSkill(catalog(), { ...location, workspaceID: "other" }, "review"), undefined)
})

test("skill catalog selection rejects missing, duplicate, malformed and accessor/proxy identities or mandatory text", () => {
  for (const data of [[], [entry, entry], [{ ...entry, content: " " }], [{ ...entry, content: "bad\0body" }],
    [{ ...entry, path: "relative" }], [{ ...entry, name: "" }], [{ ...entry, content: undefined }],
    [entry, {}], new Array(16385), new Proxy([entry], { get() { assert.fail("Proxy must not be read") } })]) {
    assert.equal(readRegisteredSkill(catalog(data), location, entry.id), undefined)
  }
  const accessor = { ...entry }
  Object.defineProperty(accessor, "content", { enumerable: true, get() { assert.fail("Getter must not execute") } })
  assert.equal(readRegisteredSkill(catalog([accessor]), location, entry.id), undefined)
  assert.equal(readRegisteredSkill(new Proxy(catalog(), { get() { assert.fail("Proxy must not execute") } }), location, entry.id), undefined)
})

test("skill collector retains whole main instructions as mandatory evidence and validates the CLI response independently", async () => {
  const current = owned()
  let calls = 0
  const result = await collectHostEvidence(current, options, signal(), noFiles(), async () => { calls++; return catalog() })
  assert.equal(calls, 1); assert.equal(result.status, "ready")
  if (result.status !== "ready") assert.fail("Expected skill evidence")
  const evidence = result.evidence
  assert.equal(evidence.kind, "skill")
  if (evidence.kind !== "skill") assert.fail("Expected native skill")
  assert.deepEqual(evidence.skill, entry)
  assert.deepEqual(evidence.operation.input, { id: entry.id })
  assert.match(evidence.limitations.join("\n"), /current scoped host registry, not an invocation-time snapshot/)
  const { conversation: _, userPrompt: __, delegation: ___, ...operation } = evidence
  assert.ok(readHostOperationEvidence(operation, current, options, signal()))
  for (const changed of [{ ...operation, skill: { ...entry, id: "other" } },
    { ...operation, skill: { ...entry, content: "" } }, { ...operation, skill: { ...entry, content: "x".repeat(131073) } },
    { ...operation, operation: { ...operation.operation, input: { id: "other" } } }]) {
    assert.equal(readHostOperationEvidence(changed, current, options, signal()), undefined)
  }
})

test("disabled skills and non-native origins skip registry reads; missing instructions never become an assessment", async () => {
  const current = owned()
  const forbidden = async () => { assert.fail("Catalog read should be gated") }
  assert.equal((await collectHostEvidence(current, { ...options, reviewSkills: false }, signal(), noFiles(), forbidden)).status, "disabled")
  const request = snapshotRequest({ id: "request", sessionID: current.invocation.sessionID, action: "skill", resources: [entry.id],
    source: { type: "tool", messageID: current.invocation.assistantID, id: current.invocation.callID } }, current.snapshot.scope)!
  const custom = { ...current, snapshot: request, invocation: { ...current.invocation, tool: "custom_skill" } }
  assert.equal((await collectHostEvidence(custom, options, signal(), noFiles(), forbidden)).status, "unsupported")
  assert.equal((await collectHostEvidence(current, options, signal(), noFiles())).status, "unsupported")
  assert.equal((await collectHostEvidence(current, options, signal(), noFiles(), async () => catalog([]))).status, "unsupported")
})

test("skill ID/scope mismatch and oversized whole main instructions fail before any model or filesystem work", async () => {
  const current = owned()
  const inputs: JSONObject[] = [{ id: "other" }, { id: entry.id, extra: true }, { id: "" }]
  for (const input of inputs) {
    assert.throws(() => requestedSkill(current.snapshot.request, { ...current.invocation, input }), /Exact native skill ID/)
  }
  await assert.rejects(collectHostEvidence(current, { ...options, maxEvidenceBytes: 64 }, signal(), noFiles(), async () => catalog()))
  const abort = new AbortController()
  await assert.rejects(collectHostEvidence(current, options, abort.signal, noFiles(), async () => { abort.abort(); return catalog() }), { name: "AbortError" })
})
