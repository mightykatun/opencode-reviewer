import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { Config } from "./config.js"
import type { Invocation } from "./context.js"
import type { ReviewKind } from "./types.js"

export type ReviewOptions = Pick<Config, "reviewBash" | "reviewEdits"> & Partial<Pick<Config, "reviewSkills" | "reviewMcp" | "reviewCustomTools" | "reviewExternalDirectories">>
// Native registry IDs in the supported host, not a heuristic list of tool names.
const nativeTools = new Set(["invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch", "execute", "lsp", "plan_exit"])
const resources = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])
const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

export function enabledKind(kind: ReviewKind, options: ReviewOptions): boolean {
  if (kind === "skill") return options.reviewSkills !== false
  return (kind === "shell" ? options.reviewBash : kind === "edit" ? options.reviewEdits
    : kind === "mcp" ? options.reviewMcp : kind === "custom" ? options.reviewCustomTools : options.reviewExternalDirectories) === true
}

/** A native permission string can also be raised by a custom tool. */
export function candidateEnabled(request: PermissionRequest, options: ReviewOptions): boolean {
  if (request.permission === "external_directory") return options.reviewExternalDirectories === true
  return (request.permission === "bash" && options.reviewBash) || (request.permission === "edit" && options.reviewEdits)
    || (request.permission === "skill" && options.reviewSkills !== false)
    || (!!request.tool && (options.reviewMcp === true || options.reviewCustomTools === true))
}

export interface Classification { kind: ReviewKind; native: boolean; server: string | null }

/** Cross-check host registry membership and native MCP routing, never a name alone. */
export function classify(request: PermissionRequest, invocation: Invocation, ids: readonly string[] | undefined,
  servers: readonly { name: string; status: string }[]): Classification | undefined {
  const id = invocation.tool
  const count = ids?.filter((item) => item === id).length
  const native = nativeTools.has(id) && count === 1
  if (request.permission === "external_directory") return { kind: "external-directory", native, server: null }
  if (!ids || (count ?? 0) > 1) return
  if (nativeTools.has(id)) {
    if (!native) return
    if (id === "bash" && request.permission === "bash") return { kind: "shell", native, server: null }
    if (["edit", "write", "apply_patch"].includes(id) && request.permission === "edit") return { kind: "edit", native, server: null }
    if (id === "skill" && request.permission === "skill" && typeof invocation.input.name === "string" && invocation.input.name.length > 0
      && request.patterns.length === 1 && request.patterns[0] === invocation.input.name
      && request.always.length === 1 && request.always[0] === invocation.input.name && Object.keys(request.metadata).length === 0)
      return { kind: "skill", native, server: null }
    return
  }
  if (resources.has(id)) {
    if (count || request.permission !== "read") return
    const rawServer = invocation.input.server
    if (rawServer != null && typeof rawServer !== "string") return
    // Pinned resource wrappers treat null/empty server as omitted, but preserve
    // every nonempty string verbatim, including whitespace in names and URIs.
    const server = typeof rawServer === "string" && rawServer !== "" ? rawServer : undefined
    const uri = typeof invocation.input.uri === "string" ? invocation.input.uri : undefined
    const names = servers.filter((entry) => entry.status === "connected").map((entry) => entry.name)
    if (server !== undefined && !names.includes(server)) return
    if (id === "read_mcp_resource") {
      if (typeof server !== "string" || typeof uri !== "string" || !uri || request.metadata.server !== server || request.metadata.uri !== uri
        || Object.keys(request.metadata).length !== 2
        || request.patterns.length !== 1 || request.patterns[0] !== `mcp:${server}:${uri}`
        || request.always.length !== 1 || request.always[0] !== `mcp:${server}:*`) return
    } else {
      const allowed = typeof server === "string" ? [`mcp:${server}:*`] : names.map((name) => `mcp:${name}:*`)
      if (!request.patterns.length || request.patterns.some((pattern) => !allowed.includes(pattern))
        || new Set(request.patterns).size !== request.patterns.length
        || request.always.length !== request.patterns.length || request.always.some((pattern, index) => pattern !== request.patterns[index])) return
      if (typeof server === "string" ? request.metadata.server !== server || Object.keys(request.metadata).length !== 1 : Object.keys(request.metadata).length !== 0) return
    }
    return { kind: "mcp", native: false, server: typeof server === "string" ? server : null }
  }
  // Include disconnected/configured names when detecting ambiguous sanitized IDs.
  const matches = servers.filter((entry) => id.startsWith(`${sanitize(entry.name)}_`) && id.length > sanitize(entry.name).length + 1)
  if (count === 1) return matches.length ? undefined : { kind: "custom", native: false, server: null }
  if (matches.length !== 1 || matches[0]!.status !== "connected" || request.permission !== id
    || request.patterns.length !== 1 || request.patterns[0] !== "*" || request.always.length !== 1 || request.always[0] !== "*"
    || Object.keys(request.metadata).length !== 0) return
  return { kind: "mcp", native: false, server: matches[0]!.name }
}
