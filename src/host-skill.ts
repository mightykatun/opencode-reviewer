import path from "node:path"
import { boundedHostJSON } from "./host-request.js"
import { field, catalogText as text, selectDefinition } from "./host-catalog.js"
import type { HostInvocation, HostLocation, HostRequest } from "./host-types.js"

export interface RegisteredSkill {
  id: string
  name: string
  path: string
  content: string
}
export type SkillCatalogRead = (signal: AbortSignal) => Promise<unknown>

/** Native skill IDs are exact resources, not display names, paths or patterns. */
export function requestedSkill(request: HostRequest, invocation: HostInvocation): string {
  const id = invocation.input.id
  if (request.action !== "skill" || invocation.tool !== "skill" || Object.keys(invocation.input).length !== 1
    || !text(id) || request.resources.length !== 1 || request.resources[0] !== id) throw new Error("Exact native skill ID and permission scope unavailable")
  return id
}

/** Current scoped registry data, never claimed to be an invocation-time snapshot.
 * The accepted installation assumption keeps the selected definition unchanged
 * while its permission is pending. No file reads or catalog mutation occur here.
 */
export function readRegisteredSkill(value: unknown, location: HostLocation, id: string): RegisteredSkill | undefined {
  try {
    const selection = selectDefinition(value, location, id)
    if ("reason" in selection) return
    const selected = selection.entry
    // Only the matched main instructions and their registered identity are copied.
    // Other bodies and optional descriptions are neither traversed nor forwarded.
    const copy = boundedHostJSON({ id: field(selected, "id"), name: field(selected, "name"),
      path: field(selected, "path"), content: field(selected, "content") }) as unknown as RegisteredSkill | undefined
    if (!copy || copy.id !== id || !text(copy.name) || !text(copy.path) || !path.isAbsolute(copy.path) || !text(copy.content)) return
    return copy
  } catch { return }
}
