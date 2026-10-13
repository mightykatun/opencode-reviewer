import path from "node:path"
import { types } from "node:util"
import { sameLocation } from "./companion-protocol.js"
import { boundedHostJSON, hostJSONBytes } from "./host-request.js"
import type { HostInvocation, HostLocation, HostRequest } from "./host-types.js"

export interface RegisteredSkill {
  id: string
  name: string
  path: string
  content: string
}
export type SkillCatalogRead = (signal: AbortSignal) => Promise<unknown>

function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !value.includes("\0")

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
    const scope = boundedHostJSON(field(value, "location"))
    if (!sameLocation(scope, location)) return
    const entries = field(value, "data")
    if (!Array.isArray(entries) || types.isProxy(entries) || entries.length > 16384) return
    let selected: unknown, identities = 0
    for (let index = 0; index < entries.length; index++) {
      const entry = field(entries, String(index)), key = field(entry, "id")
      // Unreadable IDs cannot establish that the requested entry is unique.
      if (typeof key !== "string" || (identities += key.length) > hostJSONBytes || !text(key)) return
      if (key !== id) continue
      if (selected !== undefined) return
      selected = entry
    }
    if (selected === undefined) return
    // Only the matched main instructions and their registered identity are copied.
    // Other bodies and optional descriptions are neither traversed nor forwarded.
    const copy = boundedHostJSON({ id: field(selected, "id"), name: field(selected, "name"),
      path: field(selected, "path"), content: field(selected, "content") }) as unknown as RegisteredSkill | undefined
    if (!copy || copy.id !== id || !text(copy.name) || !text(copy.path) || !path.isAbsolute(copy.path) || !text(copy.content)) return
    return copy
  } catch { return }
}
