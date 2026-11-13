import { Rpc } from "@opencode/plugin/rpc"
import path from "node:path"
import { evidenceOptionsSchema } from "./host-evidence-options.js"
import { boundedHostJSON } from "./host-request.js"

export const companionProtocol = 2
/** Model-chosen read-only operations the companion executes for retrieval. */
export const retrievalToolNames = ["read", "list", "glob", "grep"] as const
export const companionBusy = "capacity_busy"
const readErrors = {
  scope: { type: "object", properties: {}, additionalProperties: false },
  [companionBusy]: { type: "object", properties: {}, additionalProperties: false },
} as const
const text = { type: "string", minLength: 1, maxLength: 16384 } as const
const location = {
  type: "object", properties: { directory: text, workspaceID: text }, required: ["directory"], additionalProperties: false,
} as const
const handshakeSchema = {
  type: "object",
  properties: {
    protocol: { const: companionProtocol }, hostVersion: text, epoch: { type: "string", format: "uuid" }, location,
    project: { type: "object", properties: { id: text, directory: text, canonical: text },
      required: ["id", "directory", "canonical"], additionalProperties: false },
  },
  required: ["protocol", "hostVersion", "epoch", "location", "project"], additionalProperties: false,
} as const
const scopeErrors = { scope: { type: "object", properties: {}, additionalProperties: false } } as const

/** Transport identity only. An epoch is never durable history/deletion authority. */
export interface CompanionHandshake {
  protocol: 2
  hostVersion: string
  epoch: string
  location: { directory: string; workspaceID?: string }
  project: { id: string; directory: string; canonical: string }
}

export const companionRpc = Rpc.define({
  id: "opencode-reviewer",
  methods: {
    handshake: {
      input: location,
      output: handshakeSchema,
      errors: scopeErrors,
    },
    // Native TUI discovery loads the package but does not forward its options.
    // Configuration is separate from evidence and bound to the owning epoch.
    configuration: {
      input: location,
      output: {
        type: "object", properties: { handshake: handshakeSchema, options: { type: "object" } },
        required: ["handshake", "options"], additionalProperties: false,
      },
      errors: scopeErrors,
    },
    invocation: {
      input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text },
        required: ["location", "epoch", "sessionID", "requestID"], additionalProperties: false },
      output: { anyOf: [{ type: "null" }, { type: "object", properties: {
        request: { type: "object" }, invocation: { type: "object" },
      }, required: ["request", "invocation"], additionalProperties: false }] },
      errors: readErrors,
    },
    evidence: {
      input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text,
        options: evidenceOptionsSchema, timeoutMs: { type: "number", exclusiveMinimum: 0, maximum: 5000 } },
        required: ["location", "epoch", "sessionID", "requestID", "options", "timeoutMs"], additionalProperties: false },
      output: { anyOf: [{ type: "null" }, { type: "object", properties: {
        request: { type: "object" }, invocation: { type: "object" }, result: { type: "object" },
      }, required: ["request", "invocation", "result"], additionalProperties: false }] },
      errors: readErrors,
    },
    retrieve: {
      input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text, base: text,
        call: { type: "object", properties: { tool: { enum: [...retrievalToolNames] }, arguments: { type: "object" } },
          required: ["tool", "arguments"], additionalProperties: false },
        timeoutMs: { type: "number", exclusiveMinimum: 0, maximum: 3600000 },
        maxBytes: { type: "integer", minimum: 1, maximum: 16 * 1024 * 1024 } },
        required: ["location", "epoch", "sessionID", "requestID", "base", "call", "timeoutMs", "maxBytes"], additionalProperties: false },
      output: { anyOf: [{ type: "null" }, { type: "object" }] },
      errors: readErrors,
    },
  },
  events: {},
})

export function sameLocation(value: unknown, expected: CompanionHandshake["location"]): boolean {
  if (!value || typeof value !== "object") return false
  const location = value as Record<string, unknown>
  return location.directory === expected.directory && location.workspaceID === expected.workspaceID
}

/** Validate even injected/late responses before making their scope available. */
export function readHandshake(value: unknown, expected: CompanionHandshake["location"]): CompanionHandshake | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  // Host version is descriptive metadata, never evidence or admission authority.
  // The companion protocol and actual scoped public API contracts govern access.
  const validText = (item: unknown): item is string => typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 16384 && !item.includes("\0")
  if (record.protocol !== companionProtocol || !validText(record.hostVersion)
    || typeof record.epoch !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(record.epoch)
    || !sameLocation(record.location, expected) || !record.project || typeof record.project !== "object") return
  const project = record.project as Record<string, unknown>
  if (![expected.directory, project.id, project.directory, project.canonical].every(validText)
    || (expected.workspaceID !== undefined && !validText(expected.workspaceID))
    || ![expected.directory, project.directory, project.canonical].every(item => path.isAbsolute(item as string))) return
  return { protocol: companionProtocol, hostVersion: record.hostVersion, epoch: record.epoch,
    location: { ...expected }, project: { id: project.id as string, directory: project.directory as string, canonical: project.canonical as string } }
}

/** Keep configuration validation separate from transport and operation evidence. */
export function readCompanionConfiguration(value: unknown, expected: CompanionHandshake["location"]) {
  const record = boundedHostJSON(value)
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== 2
    || !("handshake" in record) || !("options" in record)) return
  const options = record.options
  if (!options || typeof options !== "object" || Array.isArray(options)) return
  const companion = readHandshake(record.handshake, expected)
  if (companion) return { companion, options: options as Record<string, unknown> }
}
