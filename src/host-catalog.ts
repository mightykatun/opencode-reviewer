import { types } from "node:util"
import { boundedHostJSON, hostJSONBytes } from "./host-request.js"
import { sameLocation } from "./companion-protocol.js"
import type { HostLocation } from "./host-types.js"

export function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
}
export const catalogText = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !value.includes("\0")

/** Establish unique scoped identity without reading other bodies or executors. */
export function selectDefinition(value: unknown, location: HostLocation, id: string): { entry: unknown } | { reason: string } {
  if (!sameLocation(boundedHostJSON(field(value, "location")), location)) return { reason: "scoped registry location did not match" }
  const entries = field(value, "data")
  if (!Array.isArray(entries) || types.isProxy(entries) || entries.length > 16384)
    return { reason: "registry inventory unreadable or exceeds its bounded allowance" }
  let selected: unknown, bytes = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = field(entries, String(i)), key = field(entry, "id")
    if (typeof key !== "string" || (bytes += key.length) > hostJSONBytes || !catalogText(key))
      return { reason: "registry identities unreadable or exceed their bounded allowance" }
    if (key !== id) continue
    if (selected !== undefined) return { reason: "multiple definitions have the exact tool ID" }
    selected = entry
  }
  return selected === undefined ? { reason: "no definition has the exact tool ID" } : { entry: selected }
}
