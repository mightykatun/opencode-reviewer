import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { CompanionBusyError, createCompanionServer } from "../src/companion-reads.js"
import { directCompanionAccess, type CompanionAccess } from "../src/companion-access.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { readHostEvidence } from "../src/host-evidence-reader.js"
import { readHostEvidenceOptions } from "../src/host-evidence-options.js"
import type { HostEvidenceOptions } from "../src/host-evidence.js"
import type { FileIO } from "../src/file-access.js"
import { TransportOwnership, bindTransportOwnership } from "../src/transport-ownership.js"
import { withDeadline } from "../src/deadline.js"

const options: HostEvidenceOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewTools: true, reviewSkills: true, maxFiles: 6, maxEvidenceBytes: 131072 }
const location = { directory: "/server/project" }, project = { id: "project", directory: "/server", canonical: "/server" }
const source = { type: "tool", messageID: "assistant", id: "call" }
const request = { id: "request", sessionID: "session", action: "edit", resources: ["target.txt"], source,
  metadata: { files: [{ file: "target.txt", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } }
const input = { path: "target.txt", content: "new\n" }

async function fixture(pending = request, proposed: Record<string, string> = input, tool = "write") {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  const reads: string[] = [], queries: any[] = [], calls: string[] = []
  const state = { current: structuredClone(pending), directory: location.directory, changeAfterCollection: false,
    epoch: "", durable: { id: "assistant", type: "assistant", content: [
      { id: "call", type: "tool", name: tool, state: { status: "running", input: proposed } },
    ] } }
  const server = {
    app: { version: "2.0.26" }, location: { ...location, project },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    permission: { get: async () => ({ ...state.current, save: undefined, message: undefined }) },
    session: { get: async () => ({ id: "session", projectID: "project", location: { directory: state.directory } }) },
  } as unknown as Plugin.Context
  const io = { realpath: async (path: string) => {
    reads.push(path)
    if (tool === "shell") return path
    throw Error("Edit must not inspect filesystem")
  }, open: async (path: string) => { reads.push(path); throw Error("Targets unavailable") } } as unknown as FileIO
  const companion = await createCompanionServer(server, lifecycle, io)
  const { handshake } = companion
  state.epoch = handshake.epoch
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool, input: proposed })
  const direct = directCompanionAccess(companion)
  const access: CompanionAccess = { ...direct,
    epoch: async () => { calls.push("epoch"); return state.epoch },
    invocation: async (...args) => {
      calls.push("capture")
      return direct.invocation(...args)
    },
    evidence: async (...args) => {
      calls.push("evidence")
      const [sessionID, requestID, options, timeoutMs] = args
      queries.push({ sessionID, requestID, options, timeoutMs })
      const value = await direct.evidence(...args)
      if (state.changeAfterCollection) state.current.resources = ["other.txt"]
      return value
    },
  }
  const client = {
    session: { get: async (...args: Parameters<typeof server.session.get>) => { calls.push("session"); return server.session.get(...args) },
      message: { get: async () => { calls.push("message"); return state.durable } } },
    message: { list: async (input: { type?: string }) => {
      calls.push(input.type === "assistant" ? "questions" : "user")
      return { data: input.type === "assistant" ? [] : [{ id: "user", type: "user", text: "Update target.txt" }], cursor: {} }
    } },
    permission: { get: async () => { calls.push("permission"); return state.current } },
  }
  return { lifecycle, companion, access, client: client as unknown as OpenCodeClient, raw: client, queries, state, reads, calls, scope: { epoch: handshake.epoch, location } }
}

test("in-process evidence receives only owned identity and collection options, then evaluation attaches root intent", async () => {
  const f = await fixture()
  try {
    const value = await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal, f.access)
    assert.equal(value?.result.status, "ready")
    assert.ok(value?.result.status === "ready" && value.result.evidence.kind === "edit")
    assert.equal(value.result.evidence.changes[0]?.patch, request.metadata.files[0]!.patch)
    assert.equal(value.result.evidence.userPrompt, "Update target.txt")
    assert.deepEqual(f.reads, [])
    assert.deepEqual(Object.keys(f.queries[0]).sort(), ["options", "requestID", "sessionID", "timeoutMs"])
    assert.ok(f.queries[0].timeoutMs > 0 && f.queries[0].timeoutMs <= 5000)
    assert.deepEqual(f.queries[0].options, options)
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence", "permission", "epoch"])
  } finally { await f.lifecycle.stop() }
})

test("unbound or ambiguous durable calls dispatch no evidence collection or filesystem reads", async () => {
  const shell = { ...request, action: "shell", resources: ["python3 task.py"] }, proposed = { command: "python3 task.py" }
  // Prove this fixture really performs server filesystem work when binding succeeds.
  const bound = await fixture(shell, proposed, "shell")
  try {
    assert.equal((await readHostEvidence(bound.client, bound.scope, shell, options, new AbortController().signal, bound.access))?.result.status, "ready")
    assert.ok(bound.reads.length > 0)
    assert.deepEqual(bound.calls, ["capture", "message", "session", "user", "questions", "evidence", "permission", "epoch"])
  } finally { await bound.lifecycle.stop() }
  for (const change of ["missing", "duplicate", "nested", "input", "name", "status", "message"] as const) {
    const f = await fixture(shell, proposed, "shell")
    try {
      const entry = f.state.durable.content[0]!
      if (change === "missing") f.state.durable.content = []
      if (change === "duplicate") f.state.durable.content.push(structuredClone(entry))
      if (change === "nested") {
        entry.name = "execute"
        entry.state.input = { code: 'await tools.shell({ command: "python3 task.py" })' }
      }
      if (change === "input") entry.state.input = { command: "python3 other.py" }
      if (change === "name") entry.name = "custom_shell"
      if (change === "status") entry.state.status = "completed"
      if (change === "message") f.state.durable.id = "other-assistant"
      assert.equal(await readHostEvidence(f.client, f.scope, shell, options, new AbortController().signal, f.access), undefined, change)
      assert.deepEqual(f.calls, ["capture", "message"], change)
      assert.deepEqual(f.queries, [], change)
      assert.deepEqual(f.reads, [], change)
    } finally { await f.lifecycle.stop() }
  }
})

test("full evidence transaction shares one outer signal and budget across capture, collection and finalization", async () => {
  const f = await fixture(), signals: AbortSignal[] = []
  try {
    const methods = { ...f.access }, permission = f.raw.permission.get
    Object.assign(f.access, {
      invocation: async (...args: Parameters<typeof methods.invocation>) => {
        signals.push(args[2])
        return methods.invocation(...args)
      },
      evidence: async (...args: Parameters<typeof methods.evidence>) => {
        signals.push(args[4])
        return methods.evidence(...args)
      },
      epoch: async (signal: AbortSignal) => { signals.push(signal); return methods.epoch(signal) },
    })
    f.raw.permission.get = async (...args: any[]) => { signals.push(args[1].signal); return permission() }
    await withDeadline(new AbortController().signal, 1000, async signal => {
      assert.equal((await readHostEvidence(f.client, f.scope, request, options, signal, f.access))?.result.status, "ready")
    })
    assert.equal(signals.length, 4)
    assert.ok(signals.every(signal => signal === signals[0]))
    assert.ok(f.queries[0].timeoutMs > 0 && f.queries[0].timeoutMs <= 1000, "Collection must inherit the original enclosing deadline")
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence", "permission", "epoch"])
  } finally { await f.lifecycle.stop() }
})

test("disabled edits bypass evidence work and pending mutation after collection invalidates returned evidence", async () => {
  const f = await fixture()
  try {
    const value = await readHostEvidence(f.client, f.scope, request, { ...options, reviewEdits: false }, new AbortController().signal, f.access)
    assert.equal(value?.result.status, "disabled")
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence", "permission", "epoch"])
    f.calls.length = 0
    f.state.changeAfterCollection = true
    assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal, f.access), undefined)
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence", "permission"])
    assert.deepEqual(f.reads, [])
  } finally { await f.lifecycle.stop() }
})

test("returned evidence cannot change mandatory source/targets or substitute a root prompt", async () => {
  for (const change of ["input", "request", "source", "project", "epoch", "location", "scope", "context", "patch-target"] as const) {
    const f = await fixture()
    try {
      const evidence = f.access.evidence
      f.access.evidence = async (...args) => {
        const result = structuredClone(await evidence(...args)) as any
        assert.equal(result.result.status, "ready")
        if (change === "input") result.invocation.input.path = "other.txt"
        if (change === "request") result.request.resources = ["other.txt"]
        if (change === "source") result.request.source.id = "other-call"
        if (change === "project") result.invocation.project.id = "other-project"
        if (change === "epoch") result.invocation.epoch = "20000000-1000-4000-8000-100000000000"
        if (change === "location") result.invocation.location.directory = "/other-project"
        if (change === "scope") result.result.evidence.location.directory = "/terminal-local"
        if (change === "context") result.result.evidence.userPrompt = "Fabricated root intent"
        if (change === "patch-target") result.result.evidence.changes[0].file = "other.txt"
        return result
      }
      assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal, f.access), undefined, change)
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence"], change)
    } finally { await f.lifecycle.stop() }
  }
})

test("collection options reject unknown paths, overflow, missing switches and getters without invoking them", () => {
  assert.deepEqual(readHostEvidenceOptions(options), options)
  for (const value of [{ ...options, path: "/caller-chosen" }, { ...options, maxFiles: 1001 }, { ...options, maxEvidenceBytes: Infinity },
    { ...options, reviewBash: undefined }, { ...options, includeShellArgumentFiles: false },
    { ...options, reviewBash: "true" }]) assert.equal(readHostEvidenceOptions(value), undefined)
  let read = false
  const value = Object.defineProperty({ ...options }, "maxFiles", { get() { read = true; return 1 } })
  assert.equal(readHostEvidenceOptions(value), undefined)
  assert.equal(read, false)
})

test("large write content and optional preview cross both reads without a shared 16 MiB cap", async () => {
  const content = "x".repeat(9 * 1024 * 1024), patch = "+" + "p".repeat(9 * 1024 * 1024)
  const pending = { ...request, metadata: { files: [{ ...request.metadata.files[0]!, patch }] } }
  const f = await fixture(pending, { ...input, content })
  try {
    const value = await readHostEvidence(f.client, f.scope, pending, options, new AbortController().signal, f.access)
    assert.ok(value?.result.status === "ready" && value.result.evidence.kind === "edit")
    assert.equal(value.invocation.input.content, content)
    assert.deepEqual(value.snapshot.request.metadata, pending.metadata)
    assert.deepEqual(value.result.evidence.operation.input, { path: "target.txt" })
    assert.equal(value.result.evidence.changes[0]?.status, "omitted")
    assert.equal(value.result.evidence.changes[0]?.patch, undefined, "A budget below the minimum excerpt allowance omits the preview")
    assert.equal(value.result.evidence.partial, true)
    assert.equal(value.result.evidence.userPrompt, "Update target.txt")
    assert.deepEqual(f.reads, [])
  } finally { await f.lifecycle.stop() }
})

test("evidence access admits a separately bounded result larger than 16 MiB without weakening fresh proof", async () => {
  const f = await fixture(), reason = "r".repeat(18 * 1024 * 1024)
  try {
    const evidence = f.access.evidence
    f.access.evidence = async (...args) => {
      const value = await evidence(...args) as any
      return { ...value, result: { status: "unsupported", reason } }
    }
    const value = await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal, f.access)
    assert.deepEqual(value?.result, { status: "unsupported", reason })
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence", "permission", "epoch"])
    f.state.changeAfterCollection = true
    assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal, f.access), undefined)
  } finally { await f.lifecycle.stop() }
})

test("evidence access rejects extra fields, accessors, proxies, over-cap components and invalid result framing", async () => {
  let accessed = 0
  for (const change of [
    (value: any) => ({ ...value, extra: true }),
    (value: any) => Object.defineProperty(value, "result", { get() { accessed++; return {} } }),
    (value: any) => new Proxy(value, { ownKeys() { accessed++; throw Error("Must not run") } }),
    (value: any) => ({ ...value, request: { ...value.request, metadata: { preview: "x".repeat(16 * 1024 * 1024) } } }),
    (value: any) => ({ ...value, invocation: { ...value.invocation, input: { content: "x".repeat(16 * 1024 * 1024) } } }),
    (value: any) => ({ ...value, result: { status: "unsupported", reason: "x".repeat(32 * 1024 * 1024 + 65536) } }),
    (value: any) => ({ ...value, result: { ...value.result, extra: true } }),
    (value: any) => ({ ...value, result: { status: "ready", reason: "Wrong fields" } }),
  ]) {
    const f = await fixture()
    try {
      const evidence = f.access.evidence
      f.access.evidence = async (...args) => change(await evidence(...args))
      assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal, f.access), undefined)
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence"])
    } finally { await f.lifecycle.stop() }
  }
  assert.equal(accessed, 0)
})

test("companion replacement or cancellation after collection prevents final evidence admission", async () => {
  for (const change of ["epoch", "abort"] as const) {
    const f = await fixture(), abort = new AbortController()
    try {
      const evidence = f.access.evidence
      f.access.evidence = async (...args) => {
        const result = await evidence(...args) as any
        assert.equal(result.result.status, "ready")
        if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
        else abort.abort(Error("Stop collected evidence"))
        return result
      }
      const reading = readHostEvidence(f.client, f.scope, request, options, abort.signal, f.access)
      if (change === "epoch") assert.equal(await reading, undefined)
      else await assert.rejects(reading, /Stop collected evidence/)
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence", ...(change === "epoch" ? ["permission", "epoch"] : [])])
    } finally { await f.lifecycle.stop() }
  }
})

test("evidence contention regenerates its budget and retains invalid-data and companion-epoch checks", async () => {
  for (const change of ["none", "invalid", "epoch"] as const) {
    const f = await fixture(), read = f.companion.read, timeouts: number[] = []
    try {
      f.companion.read = async (...args) => {
        if (!args[2]) return read(...args)
        timeouts.push(args[2].timeoutMs)
        if (timeouts.length === 1) throw new CompanionBusyError("Read capacity occupied")
        const value = await read(...args) as any
        if (change === "invalid") return { ...value, request: { ...value.request, resources: ["other.txt"] } }
        if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
        return value
      }
      const value = await withDeadline(new AbortController().signal, 1000,
        signal => readHostEvidence(f.client, f.scope, request, options, signal, f.access))
      assert.equal(value?.result.status, change === "none" ? "ready" : undefined)
      assert.equal(timeouts.length, 2, "Invalid data and replaced companions are not retried")
      assert.ok(timeouts[0]! <= 1000 && timeouts[1]! > 0 && timeouts[1]! < timeouts[0]!)
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence",
        ...(change === "invalid" ? [] : ["permission", "epoch"])])
    } finally { await f.lifecycle.stop() }
  }
})

test("cancellation during evidence or final reads retains physical ownership and prevents subsequent reads", async () => {
  for (const stage of ["evidence", "permission", "epoch"] as const) {
    const f = await fixture(), abort = new AbortController(), ownership = new TransportOwnership()
    bindTransportOwnership(abort.signal, ownership)
    let started!: () => void, resolve!: () => void
    const dispatched = new Promise<void>(yes => { started = yes }), pending = new Promise<void>(yes => { resolve = yes })
    try {
      const read = f.companion.read
      if (stage === "evidence") f.companion.read = async (...args) => {
        const value = await read(...args)
        if (args[2]) {
          started()
          await pending
        }
        return value
      }
      if (stage === "permission") {
        const get = f.raw.permission.get
        f.raw.permission.get = async () => { const value = await get(); started(); await pending; return value }
      }
      const epoch = f.access.epoch
      if (stage === "epoch") f.access.epoch = async signal => {
        const value = await epoch(signal)
        started()
        await pending
        return value
      }
      const reading = readHostEvidence(f.client, f.scope, request, options, abort.signal, f.access)
      await dispatched
      abort.abort(Error("Stop owned evidence read"))
      await assert.rejects(reading, /Stop owned evidence read/)
      let settled = false
      const actual = ownership.settled().then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false, stage)
      resolve()
      await actual
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "questions", "evidence",
        ...(stage !== "evidence" ? ["permission"] : []), ...(stage === "epoch" ? ["epoch"] : [])])
    } finally { resolve(); await ownership.settled(); await f.lifecycle.stop() }
  }
})
