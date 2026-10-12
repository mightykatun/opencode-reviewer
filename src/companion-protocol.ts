import { Rpc } from "@opencode/plugin/rpc"
import path from "node:path"
import { evidenceOptionsSchema } from "./host-evidence-options.js"

export const companionProtocol = 1
export const supportedHostVersion = "2.0.26"
const text = { type: "string", minLength: 1, maxLength: 16384 } as const
const location = {
  type: "object", properties: { directory: text, workspaceID: text }, required: ["directory"], additionalProperties: false,
} as const

/** Transport identity only. An epoch is never durable history/deletion authority. */
export interface CompanionHandshake {
  protocol: 1
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
      output: {
        type: "object",
        properties: {
          protocol: { const: companionProtocol }, hostVersion: text, epoch: { type: "string", format: "uuid" }, location,
          project: { type: "object", properties: { id: text, directory: text, canonical: text },
            required: ["id", "directory", "canonical"], additionalProperties: false },
        },
        required: ["protocol", "hostVersion", "epoch", "location", "project"], additionalProperties: false,
      },
      errors: { scope: { type: "object", properties: {}, additionalProperties: false } },
    },
    invocation: {
      input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text },
        required: ["location", "epoch", "sessionID", "requestID"], additionalProperties: false },
      output: { anyOf: [{ type: "null" }, { type: "object", properties: {
        request: { type: "object" }, invocation: { type: "object" },
      }, required: ["request", "invocation"], additionalProperties: false }] },
      errors: { scope: { type: "object", properties: {}, additionalProperties: false } },
    },
    evidence: {
      input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text,
        options: evidenceOptionsSchema, timeoutMs: { type: "number", exclusiveMinimum: 0, maximum: 5000 } },
        required: ["location", "epoch", "sessionID", "requestID", "options", "timeoutMs"], additionalProperties: false },
      output: { anyOf: [{ type: "null" }, { type: "object", properties: {
        request: { type: "object" }, invocation: { type: "object" }, result: { type: "object" },
      }, required: ["request", "invocation", "result"], additionalProperties: false }] },
      errors: { scope: { type: "object", properties: {}, additionalProperties: false } },
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
  if (record.protocol !== companionProtocol || record.hostVersion !== supportedHostVersion
    || typeof record.epoch !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(record.epoch)
    || !sameLocation(record.location, expected) || !record.project || typeof record.project !== "object") return
  const project = record.project as Record<string, unknown>
  const validText = (item: unknown): item is string => typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 16384 && !item.includes("\0")
  if (![expected.directory, project.id, project.directory, project.canonical].every(validText)
    || (expected.workspaceID !== undefined && !validText(expected.workspaceID))
    || ![expected.directory, project.directory, project.canonical].every(item => path.isAbsolute(item as string))) return
  return { protocol: companionProtocol, hostVersion: supportedHostVersion, epoch: record.epoch,
    location: { ...expected }, project: { id: project.id as string, directory: project.directory as string, canonical: project.canonical as string } }
}
