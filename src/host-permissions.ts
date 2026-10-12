import type { OpenCodeClient } from "@opencode/client"
import { companionRpc, readHandshake } from "./companion-protocol.js"
import { boundedHostJSON, hostRequestWire, readHostScope, sameRequest, snapshotRequest } from "./host-request.js"
import { transportOwnership } from "./transport-ownership.js"
import type { HostRequestSnapshot, HostScope } from "./host-types.js"

export type OnceSubmission = { status: "submitted" | "unavailable" | "uncertain" }
export interface HostPermissionTransport {
  /** Complete location snapshot, not one session's native queue. */
  listScope(signal: AbortSignal): Promise<readonly HostRequestSnapshot[]>
  list(sessionID: string, signal: AbortSignal): Promise<readonly HostRequestSnapshot[]>
  get(sessionID: string, requestID: string, signal: AbortSignal): Promise<HostRequestSnapshot | undefined>
  /** The caller must prove root presentation/native priority immediately before
   * dispatch. Submission is not a permission.replied confirmation event. */
  once(snapshot: HostRequestSnapshot, signal: AbortSignal, eligible: () => boolean): Promise<OnceSubmission>
}

/** No rejection, persistent grants, tool execution or rule-writing surface.
 * Each instance is pinned to one connected client/location/companion epoch.
 */
export function hostPermissionTransport(client: OpenCodeClient, at: HostScope): HostPermissionTransport {
  const scope = readHostScope(at)
  if (!scope) throw Error("Permission connection scope unavailable")
  const writes = new Set<string>()
  const owned = <T>(signal: AbortSignal, work: Promise<T>): Promise<T> => transportOwnership(signal)?.track(work) ?? work
  const options = (signal: AbortSignal) => ({ location: scope.location, signal })
  const session = async (sessionID: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const value = await owned(signal, client.session.get({ sessionID }, options(signal)))
    signal.throwIfAborted()
    return value.id === sessionID && value.location.directory === scope.location.directory
  }
  const currentEpoch = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    const handshake = readHandshake(await owned(signal, client.rpc(companionRpc).handshake(scope.location, options(signal))), scope.location)
    signal.throwIfAborted()
    return handshake?.epoch === scope.epoch
  }
  const get = async (sessionID: string, requestID: string, signal: AbortSignal) => {
    if (!await session(sessionID, signal) || !await currentEpoch(signal)) return
    const value = snapshotRequest(await owned(signal, client.permission.get({ sessionID, requestID }, options(signal))), scope)
    signal.throwIfAborted()
    return value?.request.sessionID === sessionID && value.request.id === requestID && await currentEpoch(signal) ? value : undefined
  }
  return {
    get,
    async listScope(signal) {
      if (!await currentEpoch(signal)) throw Error("Pending permission scope unavailable")
      const raw = boundedHostJSON(await owned(signal, client.permission.request.list({ location: scope.location }, options(signal))))
      signal.throwIfAborted()
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Pending permissions unavailable")
      const result = raw as Record<string, unknown>, location = result.location as { directory?: unknown } | undefined
      if (Object.keys(result).length !== 2 || location?.directory !== scope.location.directory || !Array.isArray(result.data))
        throw Error("Pending permission location unavailable")
      const requests: HostRequestSnapshot[] = [], ids = new Set<string>()
      for (const value of result.data) {
        const snapshot = snapshotRequest(value, scope)
        if (!snapshot || ids.has(snapshot.request.id)) throw Error("Pending permission identity unavailable")
        ids.add(snapshot.request.id); requests.push(snapshot)
      }
      if (!await currentEpoch(signal)) throw Error("Pending permission connection replaced")
      return requests
    },
    async list(sessionID, signal) {
      if (!await session(sessionID, signal) || !await currentEpoch(signal)) throw Error("Pending permission scope unavailable")
      const raw = await owned(signal, client.permission.list({ sessionID }, options(signal)))
      signal.throwIfAborted()
      if (!Array.isArray(raw) || raw.length > 16384) throw Error("Pending permissions unavailable")
      const requests: HostRequestSnapshot[] = [], ids = new Set<string>()
      for (const value of raw) {
        const projected = snapshotRequest(value, scope)
        if (!projected || projected.request.sessionID !== sessionID || ids.has(projected.request.id)) throw Error("Pending permission identity unavailable")
        ids.add(projected.request.id); requests.push(projected)
      }
      if (!await currentEpoch(signal)) throw Error("Pending permission connection replaced")
      return requests
    },
    async once(snapshot, signal, eligible) {
      const key = JSON.stringify([snapshot.request.sessionID, snapshot.request.id])
      const bound = snapshotRequest(hostRequestWire(snapshot), scope)
      if (!bound || !sameRequest(bound, snapshot) || writes.has(key)) return { status: "unavailable" }
      // Reserve before awaited reads so concurrent contenders cannot race past
      // the fresh identity check. No retries after dispatch, even on rejection.
      writes.add(key)
      let dispatched = false
      try {
        signal.throwIfAborted()
        const current = await get(snapshot.request.sessionID, snapshot.request.id, signal)
        if (!current || !sameRequest(current, snapshot) || !eligible()) return { status: "unavailable" }
        signal.throwIfAborted()
        dispatched = true
        await owned(signal, client.permission.reply({ sessionID: snapshot.request.sessionID, requestID: snapshot.request.id, decision: "once" }, options(signal)))
        return { status: "submitted" }
      } catch {
        return { status: dispatched ? "uncertain" : "unavailable" }
      } finally {
        if (!dispatched) writes.delete(key)
      }
    },
  }
}
