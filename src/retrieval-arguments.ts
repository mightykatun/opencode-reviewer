import type { JSONObject } from "./host-types.js"
import { retrievalToolNames } from "./companion-protocol.js"

export type RetrievalToolName = typeof retrievalToolNames[number]
export const maxRetrievalEntries = 500

/** Pure shared validation before terminal accounting and companion execution. */
export function retrievalArguments(tool: string, value: unknown): { ok: true; args: JSONObject } | { ok: false; reason: string } {
  if (!retrievalToolNames.includes(tool as RetrievalToolName)) return { ok: false, reason: "unknown tool" }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid arguments: expected an object" }
  const args = value as JSONObject
  const allowed: Record<RetrievalToolName, Record<string, "string" | "integer" | "boolean">> = {
    read: { path: "string", offset: "integer", limit: "integer" },
    list: { path: "string", limit: "integer" },
    glob: { pattern: "string", path: "string", limit: "integer" },
    grep: { pattern: "string", path: "string", include: "string", ignoreCase: "boolean", limit: "integer" },
  }
  const schema = allowed[tool as RetrievalToolName]
  for (const [key, item] of Object.entries(args)) {
    const type = schema[key]
    if (!type) return { ok: false, reason: `invalid arguments: unknown field ${JSON.stringify(key)}` }
    if (type === "integer" ? !Number.isSafeInteger(item) || (item as number) < 1 : typeof item !== type)
      return { ok: false, reason: `invalid arguments: ${key} must be ${type === "integer" ? "a positive integer" : `a ${type}`}` }
    if (key === "limit" && tool !== "read" && (item as number) > maxRetrievalEntries)
      return { ok: false, reason: `invalid arguments: limit must be at most ${maxRetrievalEntries}` }
    if (type === "string" && (!(item as string) || (item as string).includes("\0") || (item as string).length > 16384))
      return { ok: false, reason: `invalid arguments: ${key} must be a nonempty string without NUL` }
  }
  const required = tool === "read" || tool === "list" ? "path" : "pattern"
  if (typeof args[required] !== "string") return { ok: false, reason: `invalid arguments: ${required} is required` }
  return { ok: true, args }
}
