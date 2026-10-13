import type { HostDirectoryEvidence, HostEditEvidence, HostShellEvidence } from "../src/host-evidence.js"
import type { HostInvocationRead } from "../src/host-reader.js"
import { readHostInvocation, snapshotRequest } from "../src/host-request.js"
import type { JSONObject } from "../src/host-types.js"
import type { OpenCodeClient } from "@opencode/client"
import { collectHostOperation } from "../src/host-evidence.js"
import { hostRequestWire } from "../src/host-request.js"
import type { FileAccess } from "../src/file-access.js"

/** Complete native evidence for transport tests that do not exercise collection. */
export function shellEvidence(overrides: Partial<HostShellEvidence> = {}): HostShellEvidence {
  const command = overrides.command ?? "pwd"
  const cwd = overrides.cwd ?? "/fixture"
  const location = { directory: cwd }
  const current = { id: "root", projectID: "project", location }
  return {
    kind: "shell", tool: "shell", command, cwd, files: [], limitations: [],
    permission: { id: "request", sessionID: "root", action: "shell", resources: [command], save: [],
      source: { assistantID: "assistant", id: "call" }, metadataStatus: "Exact native request scope" },
    operation: { input: { command }, inputStatus: "Complete captured invocation arguments" },
    location, project: { id: "project", directory: cwd, canonical: cwd },
    conversation: { current, root: current, rootMessageID: "user" }, userPrompt: "Show cwd",
    execution: { tool: "shell", requestedWorkdir: null, canonicalCwd: cwd, cwdSource: "invocation.location.directory" },
    ...overrides,
  }
}

export function editEvidence(overrides: Partial<HostEditEvidence> = {}): HostEditEvidence {
  const { command: _, cwd: __, files: ___, execution: ____, ...base } = shellEvidence()
  return { ...base, kind: "edit", tool: "edit", operation: { input: { path: "note", oldString: "old", newString: "new" },
    inputStatus: "Edit text omitted; exact pending native diffs supplied below" },
  permission: { ...base.permission, action: "edit", resources: ["note"] },
  changes: [{ file: "note", status: "included", patch: "@@ -1 +1 @@\n-old\n+new\n" }], partial: false, ...overrides }
}

export function directoryEvidence(overrides: Partial<HostDirectoryEvidence> = {}): HostDirectoryEvidence {
  const { command: _, cwd: __, files: ___, execution: ____, ...base } = shellEvidence()
  return { ...base, kind: "external-directory", tool: "read", operation: { input: { path: "/outside" }, inputStatus: "Complete captured invocation arguments" },
    permission: { ...base.permission, action: "external_directory", resources: ["/outside/*"] }, partial: false, ...overrides }
}

/** Native request/invocation for exercising the production operation collector. */
export function nativeInvocation(tool: string, input: JSONObject, metadata?: JSONObject,
  directory = "/fixture", resources: string[] = []): HostInvocationRead {
  const scope = { location: { directory }, epoch: "10000000-1000-4000-8000-100000000000" }
  const action = tool === "shell" ? "shell" : "edit"
  const request = { id: "request", sessionID: "root", action, resources, save: [],
    source: { type: "tool", messageID: "assistant", id: "call" }, ...(metadata ? { metadata } : {}) }
  const snapshot = snapshotRequest(request, scope)
  const invocation = readHostInvocation({ sessionID: "root", assistantID: "assistant", callID: "call", tool, input,
    ...scope, project: { id: "project", directory, canonical: directory } })
  if (!snapshot || !invocation) throw Error("Invalid native test fixture")
  const current = { id: "root", projectID: "project", location: scope.location }
  return { snapshot, invocation, conversation: { current, root: current, userPrompt: "Inspect the fixture", rootMessageID: "user", limitations: [] } }
}

/** Offline public-client seam with the real server operation collector. */
export function nativeClient(owned: HostInvocationRead, files: FileAccess): OpenCodeClient {
  const { snapshot, invocation, conversation } = owned
  const request = hostRequestWire(snapshot)
  const { scope } = snapshot
  return {
    rpc: () => ({
      handshake: async () => ({ protocol: 1, hostVersion: "2.0.26", ...scope, project: invocation.project }),
      invocation: async () => ({ request, invocation }),
      evidence: async (query: any, options: { signal: AbortSignal }) => ({ request, invocation,
        result: await collectHostOperation(owned, query.options, options.signal, files) }),
    }),
    permission: { get: async () => request },
    session: {
      get: async () => conversation.current,
      message: { get: async () => ({ id: invocation.assistantID, type: "assistant", content: [
        { id: invocation.callID, type: "tool", name: invocation.tool, state: { status: "running", input: invocation.input } },
      ] }) },
    },
    message: { list: async () => ({ data: [{ id: "user", type: "user", text: conversation.userPrompt ?? "" }], cursor: {} }) },
  } as unknown as OpenCodeClient
}
