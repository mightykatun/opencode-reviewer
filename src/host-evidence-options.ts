import { boundedHostJSON } from "./host-request.js"
import type { HostEvidenceOptions } from "./host-evidence.js"

const switches = ["reviewBash", "reviewEdits", "reviewExternalDirectories", "reviewSkills", "reviewMcp", "reviewCustomTools"] as const
export const evidenceOptionsSchema = {
  type: "object", properties: {
    ...Object.fromEntries(switches.map(key => [key, { type: "boolean" }])),
    maxFiles: { type: "integer", minimum: 1, maximum: 1000 },
    maxEvidenceBytes: { type: "integer", minimum: 1, maximum: 16 * 1024 * 1024 },
  }, required: [...switches, "maxFiles", "maxEvidenceBytes"], additionalProperties: false,
} as const

/** This boundary accepts collection limits, never paths or caller-supplied tool arguments. */
export function readHostEvidenceOptions(raw: unknown): HostEvidenceOptions | undefined {
  const value = boundedHostJSON(raw)
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== switches.length + 2 || switches.some(key => typeof item[key] !== "boolean")
    || !Number.isInteger(item.maxFiles) || Number(item.maxFiles) < 1 || Number(item.maxFiles) > 1000
    || !Number.isInteger(item.maxEvidenceBytes) || Number(item.maxEvidenceBytes) < 1 || Number(item.maxEvidenceBytes) > 16 * 1024 * 1024) return
  return item as unknown as HostEvidenceOptions
}

export function hostEvidenceOptions(config: HostEvidenceOptions): HostEvidenceOptions {
  return { reviewBash: config.reviewBash, reviewEdits: config.reviewEdits, reviewExternalDirectories: config.reviewExternalDirectories,
    reviewSkills: config.reviewSkills, reviewMcp: config.reviewMcp, reviewCustomTools: config.reviewCustomTools,
    maxFiles: config.maxFiles, maxEvidenceBytes: config.maxEvidenceBytes }
}
