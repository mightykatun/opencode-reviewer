import type { OpenCodeClient } from "@opencode/client"
import { companionRpc, readHandshake } from "./companion-protocol.js"
import { boundedHostJSON, hostRequestWire, readHostScope, sameRequest, snapshotRequest } from "./host-request.js"
import { transportOwnership } from "./transport-ownership.js"
import type { HostRequestSnapshot, HostScope } from "./host-types.js"

export type OnceSubmission = { status: "submitted" | "unavailable" | "uncertain" }
/** Preparation may await host reads. Call dispatch exactly once, synchronously
 * immediately before invoking the native once reply, with no intervening work.
 * The caller proves same-conversation eligibility/native priority in that callback.
 * A false return means no write. submitted is only a successful local ack,
 * never a permission.replied confirmation event. */
export interface NativeApprovalTransport<R> {
  once(request: R, signal: AbortSignal, dispatch: () => boolean): Promise<OnceSubmission>
}
export interface HostPermissionTransport extends NativeApprovalTransport<HostRequestSnapshot> {
  /** Caller-admitted native resolution from this connected location/epoch only. */
  resolved(event: { sessionID: string; requestID: string; decision: string }): void
  /** Local source-test/embedding count, not configuration or UI diagnostics. */
  readonly retainedReservations: number
  /** Complete location snapshot, not one session's native queue. */
  listScope(signal: AbortSignal): Promise<readonly HostRequestSnapshot[]>
  list(sessionID: string, signal: AbortSignal): Promise<readonly HostRequestSnapshot[]>
  get(sessionID: string, requestID: string, signal: AbortSignal): Promise<HostRequestSnapshot | undefined>
}

/** No rejection, persistent grants, tool execution or rule-writing surface.
 * Each instance is pinned to one connected client/location/companion epoch.
 */
export function hostPermissionTransport(client: OpenCodeClient, at: HostScope): HostPermissionTransport {
  const scope = readHostScope(at)
  if (!scope) throw Error("Permission connection scope unavailable")
  type Reservation = { dispatched: boolean; acknowledged: boolean; uncertain?: boolean; resolution?: string; cleanup?: () => void }
  const reservations = new Map<string, Reservation>()
  // Keep original snapshots spent without strongly retaining successful IDs.
  // Other snapshots still need a fresh native get, which fails after resolution.
  const dispatchedSnapshots = new WeakSet<HostRequestSnapshot>()
  const identity = (sessionID: string, requestID: string) => JSON.stringify([sessionID, requestID])
  const prune = (key: string, reservation: Reservation) => {
    if (reservation.acknowledged && !reservation.uncertain && reservation.resolution === "once") {
      reservation.cleanup?.()
      reservations.delete(key)
    }
  }
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
    get retainedReservations() { return reservations.size },
    resolved(event) {
      const key = identity(event.sessionID, event.requestID), reservation = reservations.get(key)
      // Preparation and unrelated events cannot confirm our physical write.
      if (!reservation?.dispatched) return
      // A non-once outcome stays protected, even if another event follows it.
      if (reservation.resolution === undefined || event.decision !== "once") reservation.resolution = event.decision
      prune(key, reservation)
    },
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
    async once(snapshot, signal, dispatch) {
      const key = identity(snapshot.request.sessionID, snapshot.request.id)
      const bound = snapshotRequest(hostRequestWire(snapshot), scope)
      if (!bound || !sameRequest(bound, snapshot) || reservations.has(key) || dispatchedSnapshots.has(snapshot)) return { status: "unavailable" }
      // Reserve before awaited reads so concurrent contenders cannot race past
      // the fresh identity check. No retries after dispatch, even on rejection.
      const reservation: Reservation = { dispatched: false, acknowledged: false }
      reservations.set(key, reservation)
      // Confirmation may outlive the physical ACK. Keep the same signal owner
      // until exact native resolution, so a timeout cannot later prune uncertainty.
      const aborted = () => { if (reservation.dispatched) reservation.uncertain = true }
      signal.addEventListener("abort", aborted, { once: true })
      reservation.cleanup = () => signal.removeEventListener("abort", aborted)
      try {
        signal.throwIfAborted()
        const current = await get(snapshot.request.sessionID, snapshot.request.id, signal)
        if (!current || !sameRequest(current, snapshot)) return { status: "unavailable" }
        signal.throwIfAborted()
        // The callback admits and records actual invocation. Nothing fallible or
        // asynchronous may separate it from the fixed native reply call.
        const input = { sessionID: snapshot.request.sessionID, requestID: snapshot.request.id, decision: "once" as const }
        const requestOptions = options(signal)
        // Allocate the weak receipt before final admission, not in the native
        // callback-to-invocation gap. An unsent reservation removes it below.
        dispatchedSnapshots.add(snapshot)
        if (!dispatch()) return { status: "unavailable" }
        reservation.dispatched = true
        await owned(signal, client.permission.reply(input, requestOptions))
        // An ignored abort followed by a late physical ACK is still uncertain.
        signal.throwIfAborted()
        reservation.acknowledged = true
        prune(key, reservation)
        return { status: "submitted" }
      } catch {
        return { status: reservation.dispatched ? "uncertain" : "unavailable" }
      } finally {
        if (!reservation.dispatched) { reservation.cleanup(); reservations.delete(key); dispatchedSnapshots.delete(snapshot) }
      }
    },
  }
}
