import type { HostRequest } from "./host-types.js"
import { conversationRoot, type SessionLocation } from "./route-approval.js"

export interface HostQueueReader {
  session(id: string): SessionLocation | undefined
  family(root: string): readonly string[] | undefined
  permissions(id: string): readonly Pick<HostRequest, "id" | "sessionID">[] | undefined
}

export type HostQueueIdentity = Pick<HostRequest, "id" | "sessionID">
export type HostQueueSnapshot =
  | { state: "unknown" }
  | { state: "empty"; family: readonly string[] }
  | { state: "front"; family: readonly string[]; request: HostQueueIdentity }

export const nativeObservationLimit = 16384

/** Public family order is not ancestry order. Only move the root to the front. */
export function hostFamilyIDs(root: string, family: readonly string[] | undefined): readonly string[] | undefined {
  if (typeof root !== "string" || !root || !Array.isArray(family) || family.length > nativeObservationLimit) return
  const seen = new Set<string>(), ids = [root]
  for (const id of family) {
    if (typeof id !== "string" || !id || seen.has(id)) return
    seen.add(id)
    if (id !== root) ids.push(id)
    if (ids.length > nativeObservationLimit) return
  }
  return ids
}

/** Native Solid caches are identity observations, not captured wire evidence.
 * Read only identity fields, never clone or inspect whole request descriptors.
 * Retain typed native entries so callers can separately map their public fields. */
export function hostPermissionIdentities<T extends HostQueueIdentity>(sessionID: string, requests: readonly T[] | undefined,
  identities = new Set<string>()): readonly T[] | undefined {
  if (!Array.isArray(requests) || requests.length > nativeObservationLimit) return
  const values: T[] = []
  for (const request of requests) {
    const id = request?.id, owner = request?.sessionID
    if (typeof id !== "string" || !id || id.length > nativeObservationLimit || owner !== sessionID || identities.has(id)
      || identities.size >= nativeObservationLimit) return
    identities.add(id); values.push(request)
  }
  return values
}

/** Full family/queue health, deliberately stricter than early native ownership. */
export function hostQueueSnapshot(root: string, reader: HostQueueReader): HostQueueSnapshot {
  try {
    if (conversationRoot(root, reader.session) !== root) return { state: "unknown" }
    const family = hostFamilyIDs(root, reader.family(root))
    if (!family) return { state: "unknown" }
    const identities = new Set<string>()
    let first: HostQueueIdentity | undefined
    for (const id of family) {
      if (conversationRoot(id, reader.session) !== root) return { state: "unknown" }
      const requests = hostPermissionIdentities(id, reader.permissions(id), identities)
      if (!requests) return { state: "unknown" }
      const head = requests[0]
      if (!first && head) first = { id: head.id, sessionID: head.sessionID }
    }
    return first ? { state: "front", family, request: first } : { state: "empty", family }
  } catch { return { state: "unknown" } }
}

/** Exactly stock V2's root-first family order, including disabled and deep calls.
 * Missing/conflicting ancestry or an unreadable earlier cache cannot yield ownership. */
export function hostQueueFront(root: string, reader: HostQueueReader): Pick<HostRequest, "id" | "sessionID"> | undefined {
  try {
    if (conversationRoot(root, reader.session) !== root) return
    const ids = hostFamilyIDs(root, reader.family(root))
    if (!ids) return
    for (const id of ids) {
      if (conversationRoot(id, reader.session) !== root) return
      const requests = hostPermissionIdentities(id, reader.permissions(id))
      if (!requests) return
      if (requests.length) {
        const first = requests[0], identity = first?.id, owner = first?.sessionID
        return typeof identity === "string" && identity && owner === id ? { id: identity, sessionID: owner } : undefined
      }
    }
  } catch { return }
}
