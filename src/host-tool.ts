import { types } from "node:util"
import { boundedHostJSON, hostJSONBytes } from "./host-request.js"
import { field, catalogText as text, selectDefinition } from "./host-catalog.js"
import type { HostLocation, JSONObject } from "./host-types.js"
import { boundedCopy } from "./tool-evidence.js"

export interface RegisteredTool {
  id: string
  name?: string
  description?: string
  input?: JSONObject
}
export interface ToolDefinitionRead { definition?: RegisteredTool; limitations: string[] }
export type ToolCatalogRead = (signal: AbortSignal) => Promise<unknown>

/** Read only the exact selected definition. Never copy or invoke an executor.
 * JSON Schema definitions are supported; executable codecs are omitted whole.
 * The accepted installation assumption keeps this definition stable and truthful.
 */
export function readRegisteredTool(value: unknown, location: HostLocation, id: string, maxBytes = hostJSONBytes, maxValues = 16384): ToolDefinitionRead {
  const unavailable = (reason: string): ToolDefinitionRead => ({ limitations: [`Tool definition unavailable: ${reason}.`] })
  try {
    const selection = selectDefinition(value, location, id)
    if ("reason" in selection) return unavailable(selection.reason)
    const selected = selection.entry
    const definition: RegisteredTool = { id }, limitations: string[] = []
    boundedCopy({ definition }, maxBytes, maxValues)
    for (const key of ["name", "description", "input"] as const) {
      try {
        const raw = field(selected, key)
        if (key !== "input" ? !text(raw) : !raw || typeof raw !== "object" || types.isProxy(raw)
          || Array.isArray(raw) || field(raw, "~standard") !== undefined || field(raw, "ast") !== undefined
          || field(raw, "type") !== "object") {
          limitations.push(`Tool ${key} omitted: missing, unreadable or unsupported ${key === "input" ? "JSON Schema" : "text"}.`)
          continue
        }
        // Copy fields independently, never truncating or discarding other usable
        // optional fields when a schema or description cannot be supplied.
        const copy = boundedHostJSON(raw)
        const next = boundedCopy({ definition: { ...definition, [key]: copy } }, maxBytes, maxValues)
        Object.assign(definition, (next.value as { definition: RegisteredTool }).definition)
      } catch {
        limitations.push(`Tool ${key} omitted: complete field is not bounded JSON or exceeds the remaining evidence byte budget.`)
      }
    }
    return { definition, limitations }
  } catch { return unavailable("registry data unreadable or definition identity exceeds remaining evidence byte budget") }
}
