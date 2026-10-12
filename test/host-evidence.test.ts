import assert from "node:assert/strict"
import { test } from "node:test"
import { collectHostEvidence, collectHostOperation, attachHostConversation, readHostOperationEvidence, type HostEvidenceOptions, type HostReviewEvidence } from "../src/host-evidence.js"
import type { HostInvocationRead } from "../src/host-reader.js"
import { readHostInvocation, snapshotRequest } from "../src/host-request.js"
import { FileAccess, type FileIO } from "../src/file-access.js"
import { withDeadline } from "../src/deadline.js"

const options: HostEvidenceOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewSkills: true, reviewMcp: true, reviewCustomTools: true, maxFiles: 6, maxEvidenceBytes: 131072 }
const signal = () => new AbortController().signal

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

test("optional diffs are omitted whole with real counts, including count limits and invalid hunks", async () => {
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

test("edit has exact replacement scope and unavailable previews never trigger target reads", async () => {
  const { metadata: _, ...request } = nativeRequest, files = io()
  const evidence = await ready(owned("edit", { path: "target.txt", oldString: "old", newString: "new", replaceAll: true }, request), options, files.access)
  assert.ok(evidence.kind === "edit")
  assert.deepEqual(evidence.operation.input, { path: "target.txt", replaceAll: true })
  assert.equal(evidence.partial, true)
  assert.deepEqual(evidence.changes, [])
  assert.match(evidence.limitations.join("\n"), /Pending host per-file diffs unavailable/)
  assert.deepEqual(files.calls, [])
  await assert.rejects(ready(owned("write", { ...nativeInput, unexpectedTarget: "/other" }), options, files.access), /unsupported fields/)
  await assert.rejects(ready(owned("write", nativeInput, { ...nativeRequest,
    metadata: { files: [{ ...nativeFile, file: "unrelated.txt" }] } }), options, files.access), /outside the exact permission scope/)
  await assert.rejects(ready(owned("read", {}, externalRequest), options, files.access), /requires exact path/)
  assert.deepEqual(files.calls, [])
})

test("multibyte diffs are never sliced to fit, and optional source failures retain a factual limitation", async () => {
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

test("category switches gate before files and remain independent; unknown source and skills stay unsupported", async () => {
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
    ["bash", "shell"], ["apply_patch", "edit"], ["custom_read", "external_directory"], ["skill", "skill"]]) {
    const result = await collectHostEvidence(owned(tool, {}, { ...externalRequest, action }), options, signal(), files.access)
    assert.equal(result.status, "unsupported", `${tool}/${action}`)
  }
  assert.deepEqual(files.calls, [])
  const edit = await ready(owned(), { ...options, reviewBash: false, reviewExternalDirectories: false, reviewSkills: false, reviewMcp: false, reviewCustomTools: false }, files.access)
  assert.equal(edit.kind, "edit")
  const directory = await ready(owned("shell", { command: "python3 task.py" }, externalRequest), { ...options, reviewBash: false }, files.access)
  assert.equal(directory.kind, "external-directory")
  assert.deepEqual(files.calls, [])
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
