import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { setupCompanion } from "../src/companion.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { readHostEvidence } from "../src/host-evidence-reader.js"
import { readHostEvidenceOptions } from "../src/host-evidence-options.js"
import type { HostEvidenceOptions } from "../src/host-evidence.js"
import type { FileIO } from "../src/file-access.js"
import { TransportOwnership, bindTransportOwnership } from "../src/transport-ownership.js"
import { withDeadline } from "../src/deadline.js"

const options: HostEvidenceOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewMcp: true, reviewCustomTools: true, reviewSkills: true, maxFiles: 6, maxEvidenceBytes: 131072 }
const location = { directory: "/server/project" }, project = { id: "project", directory: "/server", canonical: "/server" }
const source = { type: "tool", messageID: "assistant", id: "call" }
const request = { id: "request", sessionID: "session", action: "edit", resources: ["target.txt"], source,
  metadata: { files: [{ file: "target.txt", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } }
const input = { path: "target.txt", content: "new\n" }

async function fixture(pending = request, proposed: Record<string, string> = input, tool = "write") {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let handlers: any
  const reads: string[] = [], queries: any[] = [], calls: string[] = []
  const state = { current: structuredClone(pending), directory: location.directory, changeAfterCollection: false,
    epoch: "", durable: { id: "assistant", type: "assistant", content: [
      { id: "call", type: "tool", name: tool, state: { status: "running", input: proposed } },
    ] } }
  const server = {
    app: { version: "2.0.26" }, location: { ...location, project },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose() {} } } },
    permission: { get: async () => ({ ...state.current, save: undefined, message: undefined }) },
    session: { get: async () => ({ id: "session", projectID: "project", location: { directory: state.directory } }) },
  } as unknown as Plugin.Context
  const io = { realpath: async (path: string) => {
    reads.push(path)
    if (tool === "shell") return path
    throw Error("Edit must not inspect filesystem")
  }, open: async (path: string) => { reads.push(path); throw Error("Targets unavailable") } } as unknown as FileIO
  const handshake = await setupCompanion(server, lifecycle, io)
  state.epoch = handshake.epoch
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool, input: proposed })
  const client = {
    rpc: () => ({
      handshake: async () => { calls.push("handshake"); return { ...handshake, epoch: state.epoch } },
      invocation: async (query: any, { signal }: { signal: AbortSignal }) => {
        calls.push("capture")
        return handlers.invocation(query, { signal, error: () => { throw Error("Scope mismatch") } })
      },
      evidence: async (query: any, { signal }: { signal: AbortSignal }) => {
        calls.push("evidence")
        queries.push(query)
        const value = await handlers.evidence(query, { signal, error: () => { throw Error("Scope mismatch") } })
        if (state.changeAfterCollection) state.current.resources = ["other.txt"]
        return value
      },
    }),
    session: { get: async (...args: Parameters<typeof server.session.get>) => { calls.push("session"); return server.session.get(...args) },
      message: { get: async () => { calls.push("message"); return state.durable } } },
    message: { list: async () => { calls.push("user"); return { data: [{ id: "user", type: "user", text: "Update target.txt" }], cursor: {} } } },
    permission: { get: async () => { calls.push("permission"); return state.current } },
  }
  return { lifecycle, client: client as unknown as OpenCodeClient, raw: client, queries, state, reads, calls, scope: { epoch: handshake.epoch, location } }
}

test("server evidence RPC receives only owned identity and collection options, then CLI attaches root intent", async () => {
  const f = await fixture()
  try {
    const value = await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal)
    assert.equal(value?.result.status, "ready")
    assert.ok(value?.result.status === "ready" && value.result.evidence.kind === "edit")
    assert.equal(value.result.evidence.changes[0]?.patch, request.metadata.files[0]!.patch)
    assert.equal(value.result.evidence.userPrompt, "Update target.txt")
    assert.deepEqual(f.reads, [])
    assert.deepEqual(Object.keys(f.queries[0]).sort(), ["epoch", "location", "options", "requestID", "sessionID", "timeoutMs"])
    assert.ok(f.queries[0].timeoutMs > 0 && f.queries[0].timeoutMs <= 5000)
    assert.deepEqual(f.queries[0].options, options)
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence", "permission", "handshake"])
  } finally { await f.lifecycle.stop() }
})

test("unbound or ambiguous durable calls dispatch no evidence RPC or filesystem reads", async () => {
  const shell = { ...request, action: "shell", resources: ["python3 task.py"] }, proposed = { command: "python3 task.py" }
  // Prove this fixture really performs server filesystem work when binding succeeds.
  const bound = await fixture(shell, proposed, "shell")
  try {
    assert.equal((await readHostEvidence(bound.client, bound.scope, shell, options, new AbortController().signal))?.result.status, "ready")
    assert.ok(bound.reads.length > 0)
    assert.deepEqual(bound.calls, ["capture", "message", "session", "user", "evidence", "permission", "handshake"])
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
      assert.equal(await readHostEvidence(f.client, f.scope, shell, options, new AbortController().signal), undefined, change)
      assert.deepEqual(f.calls, ["capture", "message"], change)
      assert.deepEqual(f.queries, [], change)
      assert.deepEqual(f.reads, [], change)
    } finally { await f.lifecycle.stop() }
  }
})

test("full evidence transaction shares one outer signal and budget across capture, collection and finalization", async () => {
  const f = await fixture(), signals: AbortSignal[] = []
  try {
    const methods = f.raw.rpc(), permission = f.raw.permission.get
    f.raw.rpc = () => ({ ...methods,
      invocation: async (query: any, options: { signal: AbortSignal }) => {
        signals.push(options.signal)
        return methods.invocation(query, options)
      },
      evidence: async (query: any, options: { signal: AbortSignal }) => {
        signals.push(options.signal)
        return methods.evidence(query, options)
      },
      handshake: async (...args: any[]) => { signals.push(args[1].signal); return methods.handshake() },
    })
    f.raw.permission.get = async (...args: any[]) => { signals.push(args[1].signal); return permission() }
    await withDeadline(new AbortController().signal, 1000, async signal => {
      assert.equal((await readHostEvidence(f.client, f.scope, request, options, signal))?.result.status, "ready")
    })
    assert.equal(signals.length, 4)
    assert.ok(signals.every(signal => signal === signals[0]))
    assert.ok(f.queries[0].timeoutMs > 0 && f.queries[0].timeoutMs <= 1000, "Collection must inherit the original enclosing deadline")
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence", "permission", "handshake"])
  } finally { await f.lifecycle.stop() }
})

test("disabled edits bypass evidence work and pending mutation after collection invalidates returned evidence", async () => {
  const f = await fixture()
  try {
    const value = await readHostEvidence(f.client, f.scope, request, { ...options, reviewEdits: false }, new AbortController().signal)
    assert.equal(value?.result.status, "disabled")
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence", "permission", "handshake"])
    f.calls.length = 0
    f.state.changeAfterCollection = true
    assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal), undefined)
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence", "permission"])
    assert.deepEqual(f.reads, [])
  } finally { await f.lifecycle.stop() }
})

test("returned evidence cannot change mandatory source/targets or substitute a root prompt", async () => {
  for (const change of ["input", "request", "source", "project", "epoch", "location", "scope", "context", "patch-target"] as const) {
    const f = await fixture()
    try {
      const original = f.raw.rpc
      f.raw.rpc = () => {
        const methods = original()
        return { ...methods, evidence: async (...args: Parameters<typeof methods.evidence>) => {
          const result = structuredClone(await methods.evidence(...args))
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
        } }
      }
      assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal), undefined, change)
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence"], change)
    } finally { await f.lifecycle.stop() }
  }
})

test("collection options reject unknown paths, overflow, missing switches and getters without invoking them", () => {
  assert.deepEqual(readHostEvidenceOptions(options), options)
  for (const value of [{ ...options, path: "/caller-chosen" }, { ...options, maxFiles: 1001 }, { ...options, maxEvidenceBytes: Infinity },
    { ...options, reviewBash: undefined }]) assert.equal(readHostEvidenceOptions(value), undefined)
  let read = false
  const value = Object.defineProperty({ ...options }, "maxFiles", { get() { read = true; return 1 } })
  assert.equal(readHostEvidenceOptions(value), undefined)
  assert.equal(read, false)
})

test("large write content and optional preview cross both RPCs without a shared 16 MiB cap", async () => {
  const content = "x".repeat(9 * 1024 * 1024), patch = "+" + "p".repeat(9 * 1024 * 1024)
  const pending = { ...request, metadata: { files: [{ ...request.metadata.files[0]!, patch }] } }
  const f = await fixture(pending, { ...input, content })
  try {
    const value = await readHostEvidence(f.client, f.scope, pending, options, new AbortController().signal)
    assert.ok(value?.result.status === "ready" && value.result.evidence.kind === "edit")
    assert.equal(value.invocation.input.content, content)
    assert.deepEqual(value.snapshot.request.metadata, pending.metadata)
    assert.deepEqual(value.result.evidence.operation.input, { path: "target.txt" })
    assert.equal(value.result.evidence.changes[0]?.status, "omitted")
    assert.equal(value.result.evidence.changes[0]?.patch, undefined, "Optional previews are omitted whole, never truncated")
    assert.equal(value.result.evidence.partial, true)
    assert.equal(value.result.evidence.userPrompt, "Update target.txt")
    assert.deepEqual(f.reads, [])
  } finally { await f.lifecycle.stop() }
})

test("evidence RPC admits a separately bounded result larger than 16 MiB without weakening fresh proof", async () => {
  const f = await fixture(), reason = "r".repeat(18 * 1024 * 1024)
  try {
    const original = f.raw.rpc
    f.raw.rpc = () => {
      const methods = original()
      return { ...methods, evidence: async (...args: Parameters<typeof methods.evidence>) => {
        const value = await methods.evidence(...args)
        return { ...value, result: { status: "unsupported", reason } }
      } }
    }
    const value = await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal)
    assert.deepEqual(value?.result, { status: "unsupported", reason })
    assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence", "permission", "handshake"])
    f.state.changeAfterCollection = true
    assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal), undefined)
  } finally { await f.lifecycle.stop() }
})

test("evidence RPC rejects extra fields, accessors, proxies, over-cap components and invalid result framing", async () => {
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
      const original = f.raw.rpc
      f.raw.rpc = () => {
        const methods = original()
        return { ...methods, evidence: async (...args: Parameters<typeof methods.evidence>) => change(await methods.evidence(...args)) }
      }
      assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal), undefined)
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence"])
    } finally { await f.lifecycle.stop() }
  }
  assert.equal(accessed, 0)
})

test("companion replacement or cancellation after collection prevents final evidence admission", async () => {
  for (const change of ["epoch", "abort"] as const) {
    const f = await fixture(), abort = new AbortController()
    try {
      const methods = f.raw.rpc()
      f.raw.rpc = () => ({ ...methods, evidence: async (...args: Parameters<typeof methods.evidence>) => {
        const result = await methods.evidence(...args)
        assert.equal(result.result.status, "ready")
        if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
        else abort.abort(Error("Stop collected evidence"))
        return result
      } })
      const reading = readHostEvidence(f.client, f.scope, request, options, abort.signal)
      if (change === "epoch") assert.equal(await reading, undefined)
      else await assert.rejects(reading, /Stop collected evidence/)
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence", ...(change === "epoch" ? ["permission", "handshake"] : [])])
    } finally { await f.lifecycle.stop() }
  }
})

test("cancellation during evidence or final reads retains actual RPC ownership and prevents subsequent reads", async () => {
  for (const stage of ["evidence", "permission", "handshake"] as const) {
    const f = await fixture(), abort = new AbortController(), ownership = new TransportOwnership()
    bindTransportOwnership(abort.signal, ownership)
    let started!: () => void, resolve!: () => void
    const dispatched = new Promise<void>(yes => { started = yes }), pending = new Promise<void>(yes => { resolve = yes })
    try {
      const methods = f.raw.rpc()
      if (stage === "evidence") f.raw.rpc = () => ({ ...methods, evidence: async (...args: Parameters<typeof methods.evidence>) => {
        const value = await methods.evidence(...args)
        started()
        await pending
        return value
      } })
      if (stage === "permission") {
        const get = f.raw.permission.get
        f.raw.permission.get = async () => { const value = await get(); started(); await pending; return value }
      }
      if (stage === "handshake") f.raw.rpc = () => ({ ...methods, handshake: async () => {
        const value = await methods.handshake()
        started()
        await pending
        return value
      } })
      const reading = readHostEvidence(f.client, f.scope, request, options, abort.signal)
      await dispatched
      abort.abort(Error("Stop owned evidence read"))
      await assert.rejects(reading, /Stop owned evidence read/)
      let settled = false
      const actual = ownership.settled().then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false, stage)
      resolve()
      await actual
      assert.deepEqual(f.calls, ["capture", "message", "session", "user", "evidence",
        ...(stage !== "evidence" ? ["permission"] : []), ...(stage === "handshake" ? ["handshake"] : [])])
    } finally { resolve(); await ownership.settled(); await f.lifecycle.stop() }
  }
})
