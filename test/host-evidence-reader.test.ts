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

const options: HostEvidenceOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewMcp: true, reviewCustomTools: true, reviewSkills: true, maxFiles: 6, maxEvidenceBytes: 131072 }
const location = { directory: "/server/project" }, project = { id: "project", directory: "/server", canonical: "/server" }
const source = { type: "tool", messageID: "assistant", id: "call" }
const request = { id: "request", sessionID: "session", action: "edit", resources: ["target.txt"], source,
  metadata: { files: [{ file: "target.txt", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } }
const input = { path: "target.txt", content: "new\n" }

async function fixture() {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let handlers: any
  const reads: string[] = [], queries: any[] = []
  const state = { current: structuredClone(request), directory: location.directory, changeAfterCollection: false }
  const server = {
    app: { version: "2.0.26" }, location: { ...location, project },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose() {} } } },
    permission: { get: async () => ({ ...state.current, save: undefined, message: undefined }) },
    session: { get: async () => ({ id: "session", projectID: "project", location: { directory: state.directory } }) },
  } as unknown as Plugin.Context
  const io = { realpath: async (path: string) => { reads.push(path); throw Error("Edit must not inspect filesystem") },
    open: async () => { throw Error("Edit must not read targets") } } as unknown as FileIO
  const handshake = await setupCompanion(server, lifecycle, io)
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "write", input })
  const client = {
    rpc: () => ({
      handshake: async () => handshake,
      invocation: async (query: any, { signal }: { signal: AbortSignal }) => handlers.invocation(query, { signal, error: () => { throw Error("Scope mismatch") } }),
      evidence: async (query: any, { signal }: { signal: AbortSignal }) => {
        queries.push(query)
        const value = await handlers.evidence(query, { signal, error: () => { throw Error("Scope mismatch") } })
        if (state.changeAfterCollection) state.current.resources = ["other.txt"]
        return value
      },
    }),
    session: { get: server.session.get, message: { get: async () => ({ id: "assistant", type: "assistant", content: [
      { id: "call", type: "tool", name: "write", state: { status: "running", input } },
    ] }) } },
    message: { list: async () => ({ data: [{ id: "user", type: "user", text: "Update target.txt" }], cursor: {} }) },
    permission: { get: async () => state.current },
  }
  return { lifecycle, client: client as unknown as OpenCodeClient, raw: client, queries, state, reads, scope: { epoch: handshake.epoch, location } }
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
  } finally { await f.lifecycle.stop() }
})

test("disabled edits bypass evidence work and pending mutation after collection invalidates returned evidence", async () => {
  const f = await fixture()
  try {
    const value = await readHostEvidence(f.client, f.scope, request, { ...options, reviewEdits: false }, new AbortController().signal)
    assert.equal(value?.result.status, "disabled")
    f.state.changeAfterCollection = true
    assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal), undefined)
    assert.deepEqual(f.reads, [])
  } finally { await f.lifecycle.stop() }
})

test("returned evidence cannot change mandatory source/targets or substitute a root prompt", async () => {
  for (const change of ["input", "request", "scope", "context", "patch-target"] as const) {
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
          if (change === "scope") result.result.evidence.location.directory = "/terminal-local"
          if (change === "context") result.result.evidence.userPrompt = "Fabricated root intent"
          if (change === "patch-target") result.result.evidence.changes[0].file = "other.txt"
          return result
        } }
      }
      assert.equal(await readHostEvidence(f.client, f.scope, request, options, new AbortController().signal), undefined, change)
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
