import assert from "node:assert/strict"
import { test } from "node:test"
import { collectHostEvidence, collectHostOperation, attachHostConversation, readHostOperationEvidence, type HostEvidenceOptions, type HostReviewEvidence } from "../src/host-evidence.js"
import type { HostInvocationRead } from "../src/host-reader.js"
import { readHostInvocation, snapshotRequest } from "../src/host-request.js"
import { FileAccess, type FileIO } from "../src/file-access.js"
import { withDeadline } from "../src/deadline.js"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"

const options: HostEvidenceOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewSkills: true, reviewTools: true, maxFiles: 6, maxEvidenceBytes: 131072 }
const signal = () => new AbortController().signal

test("missing tool evidence reaches the LLM, whose Safe or Unsafe decision is preserved", async () => {
  const call = owned("account_lookup", { account: "public" }, { ...nativeRequest, action: "account_lookup", resources: ["*"] })
  const files = io()
  const base = { id: "account_lookup", name: "lookup", description: "x".repeat(140000), input: { type: "object", properties: {} } }
  const emptyDataNote = "No registered tool data is available: name, description and input JSON Schema are unavailable. Exact tool ID, captured arguments and permission scope are retained for the reviewer to assess."
  const cases = [
    { noData: true, tools: undefined },
    { noData: true, tools: async () => { throw new Error("private registry error") } },
    { noData: true, tools: async () => ({ location, data: [] }) },
    { noData: true, tools: async () => ({ location, data: [{ id: "account_lookup" }] }) },
    { noData: true, tools: async () => ({ location, data: [{ id: "account_lookup", name: "", description: "", input: { "~standard": {} } }] }) },
    { noData: true, tools: async () => ({ location, data: [base, base] }) },
    { noData: true, tools: async () => ({ location: { directory: "/wrong" }, data: [base] }) },
    { noData: false, tools: async () => ({ location, data: [base] }) },
    { noData: false, tools: async () => ({ location, data: [{ ...base, description: "Public lookup", input: { "~standard": {} } }] }) },
  ]
  for (const { tools, noData } of cases) {
    const result = await collectHostEvidence(call, options, signal(), files.access, undefined, tools)
    assert.equal(result.status, "ready")
    if (result.status !== "ready") continue
    assert.ok(result.evidence.limitations.some(note => /unavailable|omitted/.test(note)))
    assert.ok(readHostOperationEvidence((await collectHostOperation(call, options, signal(), files.access, undefined, tools) as { evidence: unknown }).evidence, call, options, signal()))
    if (result.evidence.kind !== "tool") assert.fail("Expected tool evidence")
    assert.equal(result.evidence.limitations.includes(emptyDataNote), noData)
    if (!noData && result.evidence.definition?.description === undefined && result.evidence.definition) {
      assert.deepEqual(result.evidence.definition.input, base.input, "Oversized descriptions do not suppress usable schemas")
    }
    for (const safe of [true, false]) {
      const response = await review(result.evidence, parseConfig({ baseURL: "http://localhost/v1", model: "reviewer" }), signal(), {
        fetcher: async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          assert.match(body.messages[0].content, /Missing descriptions or schemas do not automatically mean Unsafe/)
          assert.match(body.messages[0].content, /Always produce a safety assessment, even when no registered tool data is available/)
          const evidence = JSON.parse(body.messages[1].content)
          assert.deepEqual(evidence.operation.input, call.invocation.input)
          assert.deepEqual(evidence.permission.resources, ["*"])
          assert.ok(evidence.limitations.some((note: string) => /unavailable|omitted/.test(note)))
          assert.equal(evidence.limitations.includes(emptyDataNote), noData)
          assert.doesNotMatch(body.messages[1].content, /private registry error/)
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ safe, desc: "Assessment based on available evidence." }) }, finish_reason: "stop" }] }))
        },
      })
      assert.equal(response.safe, safe)
    }
  }
  const parent = new AbortController()
  await assert.rejects(collectHostOperation(call, options, parent.signal, files.access, undefined, async () => {
    parent.abort(); throw new Error("not an optional omission")
  }), { name: "AbortError" })
  assert.deepEqual(files.calls, [])
})

test("registered tools retain exact definition, arguments and scope without inspecting executors", async () => {
  const call = owned("acme_lookup", { account: "public" }, { ...nativeRequest, action: "lookup", resources: ["public"] })
  const definition = { id: "acme_lookup", name: "lookup", description: "Look up a public account.",
    input: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } }
  const entry = { ...definition, get execute() { throw new Error("must never read executor") } }
  const files = io()
  const catalog = async () => ({ location, data: [entry] })
  for (const flags of [{ reviewTools: true }]) {
    const selected = { ...options, ...flags }
    const result = await collectHostOperation(call, selected, signal(), files.access, undefined, catalog)
    assert.equal(result.status, "ready")
    if (result.status !== "ready") continue
    assert.equal(result.evidence.kind, "tool")
    if (result.evidence.kind !== "tool") continue
    assert.deepEqual(result.evidence.definition, definition)
    assert.deepEqual(result.evidence.operation.input, call.invocation.input)
    assert.ok(readHostOperationEvidence(result.evidence, call, selected, signal()))
    assert.equal(attachHostConversation(call, result.evidence).userPrompt, call.conversation.userPrompt)
    assert.equal(readHostOperationEvidence({ ...result.evidence, definition: { ...definition, id: "other" } }, call, selected, signal()), undefined)
    assert.equal(readHostOperationEvidence({ ...result.evidence, operation: { input: {}, inputStatus: "changed" } }, call, selected, signal()), undefined)
    assert.equal(readHostOperationEvidence(result.evidence, call, { ...selected, maxEvidenceBytes: 10 }, signal()), undefined)
  }
  assert.deepEqual(files.calls, [])
  assert.equal((await collectHostOperation(call, { ...options, reviewTools: false }, signal(), files.access, undefined,
    async () => { throw new Error("disabled catalog must not be read") })).status, "disabled")
  for (const data of [[], [entry, entry], [{ ...definition, description: "" }], [{ ...definition, input: { "~standard": {} } }],
    [{ ...definition, input: { type: "object", unsupported: () => {} } }],
    [new Proxy(entry, { get() { throw new Error("proxy must not run") } })],
    [entry, { get id() { throw new Error("getter must not run") } }]]) {
    const result = await collectHostOperation(call, options, signal(), files.access, undefined, async () => ({ location, data }))
    assert.equal(result.status, "ready")
    if (result.status === "ready") {
      assert.ok(result.evidence.limitations.some(note => /unavailable|omitted/.test(note)))
      assert.ok(readHostOperationEvidence(result.evidence, call, options, signal()))
    }
  }
  assert.equal((await collectHostOperation(call, options, signal(), files.access, undefined,
    async () => ({ location: { directory: "/wrong" }, data: [entry] }))).status, "ready")
  await assert.rejects(collectHostOperation(call, { ...options, maxEvidenceBytes: 10 }, signal(), files.access, undefined, catalog))
  // Native category switches cannot be bypassed by the generic path.
  assert.equal((await collectHostOperation(shell("echo safe"), { ...options, reviewBash: false }, signal(), files.access, undefined, catalog)).status, "disabled")
})

// Offline literals copied from the pinned 2.0.26 observation at
// .runtime/v2-effective-evidence-edit-preview-HpMili/results.json.
// Tests never load runtime artifacts or start a host.
const location = { directory: "/tmp/opencode/reviewer-v2-effective-evidence-3k9U9T/project/A" }
const project = { id: "global", directory: "/tmp/opencode/reviewer-v2-effective-evidence-3k9U9T/project",
  canonical: "/tmp/opencode/reviewer-v2-effective-evidence-3k9U9T/project" }
const epoch = "10000000-1000-4000-8000-100000000000"
const nativeDiff = "Index: target.txt\n===================================================================\n--- target.txt\n+++ target.txt\n@@ -1,1 +1,1 @@\n-W3_BEFORE\n+W3_AFTER\n"
const nativeFile = { file: "target.txt", patch: nativeDiff, status: "modified", additions: 1, deletions: 1 }
const nativeRequest = { id: "per_130596ec9001CUXmf6k5NzIr0Z", sessionID: "ses_ecfa691eaffeRzV3RUZBJ9Qezr",
  action: "edit", resources: ["target.txt"], save: ["*"], metadata: { files: [nativeFile] },
  source: { type: "tool", messageID: "msg_130596e6c001KajkaF4NKNouCi", id: "w3-write-local" } }
const nativeInput = { path: "target.txt", content: "W3_AFTER\n" }
const externalRequest = { id: "per_130596ecb001Phb6TK6BjigtNP", sessionID: nativeRequest.sessionID,
  action: "external_directory", resources: ["/tmp/opencode/reviewer-v2-effective-evidence-3k9U9T/external/*"],
  save: ["/tmp/opencode/reviewer-v2-effective-evidence-3k9U9T/external/*"],
  source: { type: "tool", messageID: nativeRequest.source.messageID, id: "w3-write-external" } }
const externalInput = { path: "/tmp/opencode/reviewer-v2-effective-evidence-3k9U9T/external/target.txt", content: "W3_EXTERNAL_AFTER\n" }

function owned(tool = "write", input: object = nativeInput, request: object = nativeRequest): HostInvocationRead {
  const snapshot = snapshotRequest(request, { location, epoch })!
  assert.ok(snapshot)
  const invocation = readHostInvocation({ sessionID: snapshot.request.sessionID,
    assistantID: snapshot.request.source!.assistantID, callID: snapshot.request.source!.id,
    tool, input, location, project, epoch })!
  assert.ok(invocation)
  const current = { id: invocation.sessionID, projectID: project.id, location }
  return { snapshot, invocation, conversation: { current, root: current,
    userPrompt: "Run the isolated W3 evidence probe. Use w3-evidence only if requested by the fixture.", rootMessageID: "root-user", limitations: [] } }
}

function shell(command: string, workdir?: string): HostInvocationRead {
  const { metadata: _, ...request } = nativeRequest
  return owned("shell", { command, ...(workdir === undefined ? {} : { workdir }) },
    { ...request, action: "shell", resources: ["host parsed command"], save: ["host proposed pattern"] })
}

function io(contents: Record<string, string> = {}) {
  const calls: string[] = []
  let closed = 0
  const access = new FileAccess({
    realpath: async filename => { calls.push(`realpath:${filename}`); return filename },
    open: (async filename => {
      calls.push(`open:${filename}`)
      const value = contents[String(filename)]
      if (value === undefined) throw Object.assign(new Error("Missing"), { code: "ENOENT" })
      const bytes = Buffer.from(value)
      return { fd: 50, stat: async () => ({ isFile: () => true, size: bytes.length, mtimeMs: 0, ctimeMs: 0 }),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
          bytesRead: bytes.copy(buffer, offset, position, position + length), buffer,
        }), close: async () => { closed++ } }
    }) as FileIO["open"],
  })
  return { access, calls, get closed() { return closed } }
}

async function ready(value: HostInvocationRead, config = options, access = io().access): Promise<HostReviewEvidence> {
  const result = await collectHostEvidence(value, config, signal(), access)
  assert.equal(result.status, "ready")
  assert.ok(result.status === "ready")
  return result.evidence
}

test("operation RPC omits CLI context until validated attachment and rejects altered mandatory edit data", async () => {
  const value = owned(), files = io()
  const result = await collectHostOperation(value, options, signal(), files.access)
  assert.ok(result.status === "ready")
  const evidence = result.evidence
  assert.equal(Object.hasOwn(evidence, "userPrompt"), false)
  assert.equal(Object.hasOwn(evidence, "conversation"), false)
  assert.deepEqual(readHostOperationEvidence(evidence, value, options, signal()), evidence)
  assert.equal(attachHostConversation(value, evidence).userPrompt, value.conversation.userPrompt)
  for (const change of ["target", "patch", "partial", "operation", "source", "location", "context"] as const) {
    const altered: any = structuredClone(evidence)
    if (change === "target") altered.changes[0].file = "other.txt"
    if (change === "patch") altered.changes[0].patch = "truncated"
    if (change === "partial") altered.partial = true
    if (change === "operation") altered.operation.input.path = "other.txt"
    if (change === "source") altered.permission.source.id = "other"
    if (change === "location") altered.location.directory = "/terminal-local"
    if (change === "context") altered.userPrompt = "Unowned intent"
    assert.equal(readHostOperationEvidence(altered, value, options, signal()), undefined, change)
  }
  assert.deepEqual(files.calls, [])
  assert.throws(() => attachHostConversation({ ...value, conversation: { ...value.conversation,
    current: { ...value.conversation.current, projectID: "other" } } }, evidence), /scope mismatch/)
})

test("shell response validation preserves exact arguments, declared cwd, complete files and remaining byte allowance", async () => {
  const value = shell("python3 source.py", "inputs"), file = `${location.directory}/inputs/source.py`
  const source = "print('SERVER SNAPSHOT')\n", files = io({ [file]: source })
  const result = await collectHostOperation(value, options, signal(), files.access)
  assert.ok(result.status === "ready" && result.evidence.kind === "shell")
  assert.equal(result.evidence.files[0]?.contents, source)
  assert.deepEqual(readHostOperationEvidence(result.evidence, value, options, signal()), result.evidence)
  for (const change of ["command", "cwd", "execution", "file-budget", "file-status", "metadata"] as const) {
    const altered: any = structuredClone(result.evidence)
    if (change === "command") altered.command += " extra"
    if (change === "cwd") altered.cwd = "/terminal-local"
    if (change === "execution") altered.execution.requestedWorkdir = "/other"
    if (change === "file-budget") altered.files[0].contents = "x".repeat(options.maxEvidenceBytes)
    if (change === "file-status") altered.files[0].status = "invented"
    if (change === "metadata") altered.permission.metadata = { command: "invented" }
    assert.equal(readHostOperationEvidence(altered, value, options, signal()), undefined, change)
  }
})

test("source excerpts survive the companion boundary, reject false completeness/counts and reach the judge", async () => {
  const call = shell("python source.py"), files = io({ [`${location.directory}/source.py`]:
    "# context\n".repeat(1000) + "def entry():\n    return 1\n" })
  const selected = { ...options, maxEvidenceBytes: 1200 }
  const result = await collectHostOperation(call, selected, signal(), files.access)
  assert.ok(result.status === "ready" && result.evidence.kind === "shell")
  const file = result.evidence.files[0]!
  assert.equal(file.status, "excerpt")
  assert.equal(file.excerpt?.totalLines, 1002)
  assert.ok(readHostOperationEvidence(result.evidence, call, selected, signal()))
  for (const mutate of [
    (file: any) => { file.status = "captured" },
    (file: any) => { file.excerpt.totalLines++ },
    (file: any) => { file.contents = "x".repeat(1200) },
    (file: any) => { delete file.excerpt },
  ]) {
    const copy: any = structuredClone(result.evidence)
    mutate(copy.files[0])
    assert.equal(readHostOperationEvidence(copy, call, selected, signal()), undefined)
  }
  await review(attachHostConversation(call, result.evidence), parseConfig({ baseURL: "http://localhost/v1", model: "reviewer" }), signal(), {
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(JSON.parse(body.messages[1].content).files[0], file)
      assert.match(body.messages[0].content, /Excerpts are incomplete/)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ safe: false, desc: "Some executable source is missing." }) }, finish_reason: "stop" }] }))
    },
  })
})

test("large native diffs retain actual distant changes within budget and independently validate partial coverage", async () => {
  const patch = "--- target.txt\n+++ target.txt\n@@ -1,102 +1,102 @@\n" + " unchanged\n".repeat(50)
    + "-old behavior\n+new behavior\n" + " unchanged\n".repeat(50)
  const call = owned("write", nativeInput, { ...nativeRequest, metadata: { files: [{ ...nativeFile, patch }] } })
  const selected = { ...options, maxEvidenceBytes: 340 }, files = io()
  const result = await collectHostOperation(call, selected, signal(), files.access)
  assert.ok(result.status === "ready" && result.evidence.kind === "edit")
  const change = result.evidence.changes[0]!
  assert.equal(result.evidence.partial, true)
  assert.equal(change.status, "excerpt")
  assert.match(change.patch!, /L54: -old behavior\nL55: \+new behavior/)
  assert.equal(change.excerpt?.totalLines, 105)
  assert.ok(Buffer.byteLength(change.patch!) <= 340)
  assert.ok(readHostOperationEvidence(result.evidence, call, selected, signal()))
  for (const mutate of [
    (evidence: any) => { evidence.partial = false },
    (evidence: any) => { evidence.changes[0].status = "included" },
    (evidence: any) => { evidence.changes[0].patch += " invented" },
    (evidence: any) => { evidence.changes[0].excerpt.totalLines++ },
  ]) {
    const copy: any = structuredClone(result.evidence)
    mutate(copy)
    assert.equal(readHostOperationEvidence(copy, call, selected, signal()), undefined)
  }
  assert.deepEqual(files.calls, [], "Native diffs never cause full target reads")
})

test("pinned write preview retains native request identity and uses only pending diffs without target I/O", async () => {
  const value = owned(), files = io()
  const evidence = await ready(value, options, files.access)
  assert.equal(evidence.kind, "edit")
  assert.ok(evidence.kind === "edit")
  const { metadata: _, ...scope } = value.snapshot.request
  const { metadataStatus, ...actual } = evidence.permission
  assert.deepEqual(actual, scope)
  assert.match(metadataStatus, /metadata.files/)
  assert.deepEqual(evidence.changes, [{ file: "target.txt", hostStatus: "modified", status: "included", patch: nativeDiff }])
  assert.deepEqual(evidence.operation.input, { path: "target.txt" })
  assert.equal(evidence.tool, "write")
  assert.equal(evidence.partial, false)
  assert.deepEqual(evidence.location, location)
  assert.deepEqual(files.calls, [])
  assert.doesNotMatch(JSON.stringify(evidence), /"content":|assistant.path|"apply_patch"/)
})

test("shell resolves relative workdir from captured invocation, preserves V2 scope and captures bounded source", async () => {
  const value = shell("python3 task.py", "subdir")
  value.conversation.root = { ...value.conversation.root, id: "parent", location: { directory: "/different/root" } }
  const cwd = `${location.directory}/subdir`, files = io({ [`${cwd}/task.py`]: "print('captured on server')\n" })
  const evidence = await ready(value, options, files.access)
  assert.ok(evidence.kind === "shell")
  assert.equal(evidence.tool, "shell")
  assert.equal(evidence.cwd, cwd)
  assert.equal(evidence.execution.cwdSource, "tool.workdir relative to invocation.location.directory")
  assert.equal(evidence.files[0]?.contents, "print('captured on server')\n")
  assert.deepEqual(evidence.permission.resources, ["host parsed command"])
  assert.deepEqual(evidence.permission.save, ["host proposed pattern"])
  assert.equal(evidence.permission.source?.id, "w3-write-local")
  assert.equal(files.closed, 1)
  assert.equal(files.access.outstanding, 0)
  assert.doesNotMatch(JSON.stringify(evidence), /"bash"|assistant.path|different\/root\/subdir/)
})

test("commands above 64 KiB remain lossless, and mandatory budget failure precedes all files", async () => {
  const command = `printf '%s' '${"é".repeat(40000)}'\n`, files = io()
  const value = shell(command)
  const evidence = await ready(value, options, files.access)
  assert.ok(evidence.kind === "shell")
  assert.equal(evidence.command, command)
  assert.equal(evidence.operation.input.command, command)
  const blocked = io()
  await assert.rejects(ready(value, { ...options, maxEvidenceBytes: 65536 }, blocked.access), /configured byte budget/)
  assert.deepEqual(blocked.calls, [])
})

test("large shell operation responses survive duplicated mandatory arguments without weakening configured evidence limits", async () => {
  const command = ": #" + "x".repeat(9 * 1024 * 1024)
  const value = shell(command), files = io()
  const largeOptions = { ...options, maxEvidenceBytes: 16 * 1024 * 1024 }
  const result = await collectHostOperation(value, largeOptions, signal(), files.access)
  assert.ok(result.status === "ready" && result.evidence.kind === "shell")
  const evidence = result.evidence
  assert.equal(evidence.command, command)
  assert.equal(evidence.operation.input.command, command)
  assert.deepEqual(readHostOperationEvidence(evidence, value, largeOptions, signal()), evidence)
  assert.equal(readHostOperationEvidence(evidence, value, { ...largeOptions, maxEvidenceBytes: 8 * 1024 * 1024 }, signal()), undefined)
  assert.equal(readHostOperationEvidence({ ...evidence, files: [{ filename: "invented.py", path: location.directory + "/invented.py",
    status: "captured", contents: "x".repeat(9 * 1024 * 1024) }] }, value, largeOptions, signal()), undefined,
  "the larger preprocessing allowance cannot expand the configured file allowance")
  assert.equal(files.calls.some(call => call.startsWith("open:")), false)
})

test("changed source, session, epoch, location and conversation identities reject before I/O", async () => {
  for (const change of ["assistant", "call", "session", "epoch", "location", "workspace", "conversation"] as const) {
    const value = shell("cat file.txt"), files = io()
    if (change === "assistant") value.invocation = { ...value.invocation, assistantID: "other" }
    if (change === "call") value.invocation = { ...value.invocation, callID: "other" }
    if (change === "session") value.invocation = { ...value.invocation, sessionID: "other" }
    if (change === "epoch") value.invocation = { ...value.invocation, epoch: "other" }
    if (change === "location") value.invocation = { ...value.invocation, location: { directory: "/other" } }
    if (change === "workspace") value.invocation = { ...value.invocation, location: { ...location, workspaceID: "other" } }
    if (change === "conversation") value.conversation.current = { ...value.conversation.current, id: "other" }
    await assert.rejects(ready(value, options, files.access), /scope mismatch/, change)
    assert.deepEqual(files.calls, [], change)
  }
})

test("diffs below the minimum excerpt allowance are omitted with real counts, including count limits and invalid hunks", async () => {
  const files = io()
  const evidence = await ready(owned(), { ...options, maxEvidenceBytes: 1 }, files.access)
  assert.ok(evidence.kind === "edit")
  assert.equal(evidence.partial, true)
  assert.equal(evidence.changes[0]?.patch, undefined)
  assert.equal(evidence.changes[0]?.delta, '[Δ] "target.txt": +1 −1 lines')
  assert.equal(evidence.changes[0]?.reason, "complete diff exceeds remaining evidence byte budget")
  const other = { file: "other.txt", status: "added", patch: "@@ -0,0 +1,2 @@\n+one\n+two\n" }
  const value = owned("patch", { patchText: "*** Begin Patch\n*** Update File: target.txt\n@@\n-old\n+new\n*** Add File: other.txt\n+one\n+two\n*** End Patch" },
    { ...nativeRequest, resources: ["target.txt", "other.txt"], metadata: { files: [nativeFile, other] } })
  const limited = await ready(value, { ...options, maxFiles: 1 }, files.access)
  assert.ok(limited.kind === "edit")
  assert.equal(limited.changes[0]?.status, "included")
  assert.equal(limited.changes[1]?.reason, "file-count limit reached")
  assert.equal(limited.changes[1]?.delta, '[Δ] "other.txt": +2 −0 lines')
  const invalid = await ready(owned("write", nativeInput, { ...nativeRequest,
    metadata: { files: [{ file: "target.txt", status: "modified", patch: "@@ -1,1 +1,1 @@\n+broken\n" }] } }),
  { ...options, maxEvidenceBytes: 1 }, files.access)
  assert.ok(invalid.kind === "edit")
  assert.equal(invalid.changes[0]?.delta, undefined)
  const fallback = await ready(owned("write", nativeInput, { ...nativeRequest,
    metadata: { files: [{ ...nativeFile, patch: "not a diff", additions: 7, deletions: 3 }] } }),
  { ...options, maxEvidenceBytes: 1 }, files.access)
  assert.ok(fallback.kind === "edit")
  assert.equal(fallback.changes[0]?.delta, '[Δ] "target.txt": +7 −3 lines')
  assert.deepEqual(files.calls, [])
})

test("omitted native diffs prefer valid host counts and fall back only for invalid count pairs", async () => {
  const files = io()
  for (const counts of [
    { additions: 7, deletions: 3, expected: "+7 −3" },
    { additions: 0, deletions: 0, expected: "+0 −0" },
    { additions: -1, deletions: 3, expected: "+1 −1" },
    { additions: 1.5, deletions: 3, expected: "+1 −1" },
    { additions: 7, deletions: "3", expected: "+1 −1" },
    { additions: Number.MAX_SAFE_INTEGER + 1, deletions: 3, expected: "+1 −1" },
  ]) {
    const { expected, ...metadata } = counts
    const evidence = await ready(owned("write", nativeInput, { ...nativeRequest,
      metadata: { files: [{ ...nativeFile, ...metadata }] } }), { ...options, maxEvidenceBytes: 1 }, files.access)
    assert.ok(evidence.kind === "edit")
    assert.equal(evidence.changes[0]?.delta, `[Δ] "target.txt": ${expected} lines`)
  }
  const huge = await ready(owned("write", nativeInput, { ...nativeRequest,
    metadata: { files: [{ ...nativeFile, patch: "\n".repeat(65537), additions: 7, deletions: 3 }] } }),
  { ...options, maxEvidenceBytes: 1 }, files.access)
  assert.ok(huge.kind === "edit")
  assert.equal(huge.changes[0]?.delta, '[Δ] "target.txt": +7 −3 lines')
  assert.ok(!huge.limitations.some(value => value.includes("bounded counting allowance")), "valid counts do not spend omitted-diff parsing work")
  assert.deepEqual(files.calls, [])
})

test("edit has exact replacement scope and unavailable previews never trigger target reads", async () => {
  const { metadata: _, ...request } = nativeRequest, files = io()
  const evidence = await ready(owned("edit", { path: "target.txt", oldString: "old", newString: "new", replaceAll: true }, request), options, files.access)
  assert.ok(evidence.kind === "edit")
  assert.deepEqual(evidence.operation.input, { path: "target.txt", replaceAll: true })
  assert.equal(evidence.partial, true)
  assert.deepEqual(evidence.changes, [{ file: "target.txt", status: "omitted",
    reason: "pending host preview unavailable for this exact declared target", warning: '[!] File "target.txt" not included in context.' }])
  assert.match(evidence.limitations.join("\n"), /Pending host per-file diffs unavailable/)
  assert.deepEqual(files.calls, [])
  await assert.rejects(ready(owned("write", { ...nativeInput, unexpectedTarget: "/other" }), options, files.access), /unsupported fields/)
  await assert.rejects(ready(owned("write", nativeInput, { ...nativeRequest,
    metadata: { files: [{ ...nativeFile, file: "unrelated.txt" }] } }), options, files.access), /outside the exact permission scope/)
  await assert.rejects(ready(owned("read", {}, externalRequest), options, files.access), /requires exact path/)
  assert.deepEqual(files.calls, [])
})

test("absent patch previews are represented as incomplete at collection and independent validation boundaries", async () => {
  const patchText = "*** Begin Patch\n*** Update File: target.txt\n@@\n-old\n+new\n*** Add File: second.txt\n+new contents\n*** End Patch"
  const value = owned("patch", { patchText }, { ...nativeRequest, resources: ["target.txt", "second.txt"], metadata: { files: [nativeFile] } })
  const files = io()
  const result = await collectHostOperation(value, options, signal(), files.access)
  assert.ok(result.status === "ready" && result.evidence.kind === "edit")
  const evidence = result.evidence
  assert.equal(evidence.partial, true)
  assert.deepEqual(evidence.changes.map(change => [change.file, change.status]), [["target.txt", "included"], ["second.txt", "omitted"]])
  const missing = evidence.changes[1]!
  assert.equal(missing.hostStatus, undefined, "no preview status is invented from a patch header")
  assert.equal(missing.delta, undefined, "missing previews provide no line-count evidence")
  assert.equal(missing.patch, undefined)
  assert.match(missing.reason!, /pending host preview unavailable/)
  assert.match(evidence.limitations.join("\n"), /exact declared edit targets have no pending host preview/)
  assert.deepEqual(readHostOperationEvidence(evidence, value, options, signal()), evidence)
  assert.equal(readHostOperationEvidence({ ...evidence, partial: false }, value, options, signal()), undefined)
  assert.equal(readHostOperationEvidence({ ...evidence, changes: evidence.changes.slice(0, 1) }, value, options, signal()), undefined)
  assert.equal(readHostOperationEvidence({ ...evidence, changes: [...evidence.changes.slice(0, 1), { ...missing, delta: "+1 -0" }] }, value, options, signal()), undefined)
  const missingFirst = owned("patch", { patchText }, { ...nativeRequest, resources: ["second.txt", "target.txt"], metadata: { files: [nativeFile] } })
  const limited = await ready(missingFirst, { ...options, maxFiles: 1 }, files.access)
  assert.ok(limited.kind === "edit")
  assert.equal(limited.changes[0]!.status, "omitted", "an unavailable first declared target still consumes the file allowance")
  assert.equal(limited.changes[0]!.reason, "file-count limit reached")
  assert.deepEqual(files.calls, [])
})

test("missing write previews and both move declarations retain verbatim scope without filesystem alias guesses", async () => {
  const value = owned("patch", { patchText: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch" },
    { ...nativeRequest, resources: ["old.txt", "new.txt"], metadata: { files: [{ file: "new.txt", status: "added", patch: nativeDiff }] } })
  const files = io(), evidence = await ready(value, options, files.access)
  assert.ok(evidence.kind === "edit")
  assert.equal(evidence.partial, true)
  assert.deepEqual(evidence.changes.map(change => [change.file, change.status]), [["new.txt", "included"], ["old.txt", "omitted"]])
  assert.equal(evidence.changes[1]!.hostStatus, undefined)
  const alias = await ready(owned("write", { path: "./target.txt", content: "new" }), options, files.access)
  assert.ok(alias.kind === "edit")
  assert.equal(alias.partial, true, "lexically different declarations are not silently substituted")
  assert.equal(alias.changes[1]!.file, "./target.txt")
  assert.deepEqual(files.calls, [])
})

test("multibyte diff lines are not sliced to fit, and optional source failures retain a factual limitation", async () => {
  const patch = "@@ -0,0 +1,1 @@\n+éééééééééé\n"
  const evidence = await ready(owned("write", nativeInput, { ...nativeRequest,
    metadata: { files: [{ file: "target.txt", status: "added", patch }] } }), { ...options, maxEvidenceBytes: patch.length })
  assert.ok(evidence.kind === "edit")
  assert.equal(evidence.changes[0]?.patch, undefined)
  assert.equal(evidence.changes[0]?.delta, '[Δ] "target.txt": +1 −0 lines')
  const failing = new FileAccess({ realpath: async () => { throw Object.assign(new Error("not accessible"), { code: "EACCES" }) },
    open: (async () => { throw Error("must not open") }) as FileIO["open"] })
  const source = await ready(shell("python3 task.py"), options, failing)
  assert.ok(source.kind === "shell")
  assert.equal(source.execution.canonicalCwd, null)
  assert.equal(source.files[0]?.contents, undefined)
  assert.match(source.limitations.join("\n"), /Canonical invocation working directory unavailable \(EACCES\)/)
})

test("pinned external-directory stage retains access scope and operation target, independently of edit switch", async () => {
  const files = io()
  const evidence = await ready(owned("write", externalInput, externalRequest), { ...options, reviewEdits: false }, files.access)
  assert.ok(evidence.kind === "external-directory")
  assert.deepEqual(evidence.permission.resources, externalRequest.resources)
  assert.deepEqual(evidence.permission.save, externalRequest.save)
  assert.deepEqual(evidence.operation.input, { path: externalInput.path })
  assert.equal(evidence.permission.source?.id, "w3-write-external")
  assert.equal(evidence.partial, true)
  assert.doesNotMatch(JSON.stringify(evidence), /W3_EXTERNAL_AFTER/)
  assert.deepEqual(files.calls, [])
})

test("V2 patch summary preserves moves, CRLF/heredoc and native whitespace semantics without directory I/O", async () => {
  const patchText = "cat <<'PATCH'\r\n*** Begin Patch\r\n*** Environment ID: fixture\r\n  *** Update File: old.txt  \r\n*** End of File\r\n*** Move to: ../new.txt\r\n@@\r\n *** Update File: this-is-context-not-a-target\r\n-old\r\n+new\r\n*** Delete File: deleted.txt\r\n*** Add File: added.txt\r\n+hello\r\n*** End Patch\r\nPATCH"
  const files = io()
  const evidence = await ready(owned("patch", { patchText }, externalRequest), options, files.access)
  assert.ok(evidence.kind === "external-directory")
  assert.deepEqual(evidence.operation.patchOperations, [
    { operation: "move", path: "old.txt", movePath: "../new.txt" },
    { operation: "delete", path: "deleted.txt" }, { operation: "add", path: "added.txt" },
  ])
  assert.deepEqual(evidence.operation.input, {})
  assert.deepEqual(files.calls, [])
  await assert.rejects(ready(owned("patch", { patchText: "*** Begin Patch\n*** Update File: old.txt\n*** Move to:\n*** End Patch" }, externalRequest)), /move destination/)
})

test("directory declarations can be omitted whole, but mandatory scopes and operation inputs cannot", async () => {
  const files = io(), value = owned("read", { path: externalInput.path, offset: 1, limit: 20 },
    { ...externalRequest, metadata: { declared: "x".repeat(2000) } })
  const evidence = await ready(value, { ...options, maxEvidenceBytes: 1000 }, files.access)
  assert.ok(evidence.kind === "external-directory")
  assert.deepEqual(evidence.operation.input, { path: externalInput.path, offset: 1, limit: 20 })
  assert.equal(evidence.permission.metadata, undefined)
  assert.match(evidence.permission.metadataStatus, /omitted whole/)
  assert.equal(evidence.partial, true)
  await assert.rejects(ready(value, { ...options, maxEvidenceBytes: 10 }, files.access), /configured byte budget/)
  assert.deepEqual(files.calls, [])
})

test("root intent and factual unavailable immediate delegation survive evidence collection separately", async () => {
  const value = owned()
  value.conversation.current = { ...value.conversation.current, parentID: "parent" }
  value.conversation.root = { ...value.conversation.root, id: "root" }
  value.conversation.userPrompt = "Preserve this root request exactly."
  value.conversation.delegation = { sessionID: value.invocation.sessionID, parentSessionID: "parent", messageID: null, prompt: null }
  value.conversation.limitations = ["Exact immediate subagent delegation is unavailable from the public V2 invocation linkage; delegation text is omitted."]
  const evidence = await ready(value)
  assert.equal(evidence.userPrompt, "Preserve this root request exactly.")
  assert.deepEqual(evidence.delegation, value.conversation.delegation)
  assert.equal(evidence.conversation.rootMessageID, "root-user")
  assert.ok(evidence.limitations.includes(value.conversation.limitations[0]!))
  value.conversation.userPrompt = null
  value.conversation.limitations.push("Latest delivered root user message has no nonempty text; no older prompt was substituted.")
  assert.equal((await ready(value)).userPrompt, null)
})

test("category switches gate before files and remain independent; unknown source and unavailable skill instructions stay manual", async () => {
  const files = io()
  const cases: [HostInvocationRead, Partial<HostEvidenceOptions>][] = [
    [shell("cat source.py"), { reviewBash: false }], [owned(), { reviewEdits: false }],
    [owned("write", externalInput, externalRequest), { reviewExternalDirectories: false }],
    [owned("skill", { id: "opencode" }, { ...externalRequest, action: "skill" }), { reviewSkills: false }],
  ]
  for (const [value, disabled] of cases) {
    assert.equal((await collectHostEvidence(value, { ...options, ...disabled }, signal(), files.access)).status, "disabled")
  }
  for (const [tool, action] of [["custom_shell", "shell"], ["mcp_server_tool", "shell"], ["execute", "shell"],
    ["bash", "shell"], ["apply_patch", "edit"], ["custom_read", "external_directory"]]) {
    const result = await collectHostEvidence(owned(tool, {}, { ...externalRequest, action }), options, signal(), files.access)
    assert.equal(result.status, tool === "execute" ? "unsupported" : "ready", `${tool}/${action}`)
    if (result.status === "ready") {
      assert.equal(result.evidence.kind, "tool", "Native-looking actions never imply native tool origin")
      assert.ok(result.evidence.limitations.includes("Tool definition unavailable: scoped registry reader unavailable."))
    }
  }
  const skill = owned("skill", { id: "opencode" }, { ...externalRequest, action: "skill", resources: ["opencode"] })
  assert.equal((await collectHostEvidence(skill, options, signal(), files.access)).status, "unsupported",
    "Missing current registry instructions remain manual")
  assert.deepEqual(files.calls, [])
  const edit = await ready(owned(), { ...options, reviewBash: false, reviewExternalDirectories: false, reviewSkills: false, reviewTools: false }, files.access)
  assert.equal(edit.kind, "edit")
  const directory = await ready(owned("shell", { command: "python3 task.py" }, externalRequest), { ...options, reviewBash: false }, files.access)
  assert.equal(directory.kind, "external-directory")
  assert.deepEqual(files.calls, [])
})

test("collection and response validation honor exactly their own review-category switch", async () => {
  const disabled = { ...options, reviewBash: false, reviewEdits: false, reviewExternalDirectories: false, reviewSkills: false, reviewTools: false }
  const skill = owned("skill", { id: "fixture" }, { ...externalRequest, action: "skill", resources: ["fixture"] })
  const catalog = async () => ({ location, data: [{ id: "fixture", name: "Fixture", path: "/skills/fixture/SKILL.md", content: "Fixture instructions." }] })
  const cases = [
    { flag: "reviewBash", kind: "shell", value: shell("echo safe") },
    { flag: "reviewEdits", kind: "edit", value: owned() },
    { flag: "reviewExternalDirectories", kind: "external-directory", value: owned("write", externalInput, externalRequest) },
    { flag: "reviewSkills", kind: "skill", value: skill },
    { flag: "reviewTools", kind: "tool", value: owned("fixture_lookup", {}, { ...externalRequest, action: "lookup" }) },
  ] as const
  for (const { flag, kind, value } of cases) {
    const files = io(), enabled = { ...disabled, [flag]: true }
    const result = await collectHostOperation(value, enabled, signal(), files.access, catalog)
    assert.ok(result.status === "ready", kind)
    assert.equal(result.evidence.kind, kind)
    assert.deepEqual(readHostOperationEvidence(result.evidence, value, enabled, signal()), result.evidence)
    const before = [...files.calls]
    for (const other of [undefined, ...cases.filter(item => item.flag !== flag).map(item => item.flag)]) {
      const config = other ? { ...disabled, [other]: true } : disabled
      assert.deepEqual(await collectHostOperation(value, config, signal(), files.access, async () => assert.fail("Disabled catalog read")),
        { status: "disabled", reason: `${kind} review disabled` })
      assert.equal(readHostOperationEvidence(result.evidence, value, config, signal()), undefined)
    }
    assert.deepEqual(files.calls, before, "Disabled categories do not collect filesystem evidence")
  }
})

test("parent cancellation rejects rather than becoming an optional source omission and retains I/O ownership", async () => {
  let settle!: (value: string) => void, started!: () => void
  const pending = new Promise<string>(resolve => { settle = resolve })
  const acquiring = new Promise<void>(resolve => { started = resolve }), parent = new AbortController()
  const access = new FileAccess({ realpath: async () => { started(); return pending }, open: (async () => { throw Error("must not open") }) as FileIO["open"] })
  const work = withDeadline(parent.signal, 1000, s => collectHostEvidence(shell("cat source.py"), options, s, access))
  await acquiring
  // Cancel the actual parent while I/O is held. A short wall-clock race could
  // instead expire the optional file sub-budget first, which legitimately omits it.
  parent.abort(new Error("parent timed out"))
  await assert.rejects(work, /parent timed out/)
  assert.equal(access.outstanding, 1)
  settle(location.directory)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(access.outstanding, 0)
  const canceled = new AbortController(), files = io()
  canceled.abort(new Error("parent canceled"))
  await assert.rejects(collectHostEvidence(owned(), options, canceled.signal, files.access), /parent canceled/)
  assert.deepEqual(files.calls, [])
})
