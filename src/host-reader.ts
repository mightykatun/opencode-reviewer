import type { OpenCodeClient } from "@opencode/client"
import { companionRpc, readHandshake } from "./companion-protocol.js"
import { hostJSONBytes, readHostEnvelope, readHostInvocation, sameRequest, snapshotRequest } from "./host-request.js"
import { bindHostInvocation } from "./host-invocation.js"
import { loadHostConversationContext, type HostConversationContext } from "./host-context.js"
import { withDeadline } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"
import type { HostInvocation, HostRequestSnapshot, HostScope } from "./host-types.js"

export interface HostInvocationRead {
  snapshot: HostRequestSnapshot
  invocation: HostInvocation
  conversation: HostConversationContext
}

/** Bind the captured invocation to a durable direct call before any server
 * filesystem collection. The caller owns the enclosing transaction deadline.
 */
export async function preparePendingInvocation(client: OpenCodeClient, snapshot: HostRequestSnapshot,
  signal: AbortSignal): Promise<HostInvocationRead | undefined> {
  if (!snapshot?.request.source) return
  const { scope, request } = snapshot
  signal.throwIfAborted()
  const owned = <T>(work: Promise<T>) => transportOwnership(signal)?.track(work) ?? work
  const options = { location: scope.location, signal }
  const raw = await owned(client.rpc(companionRpc).invocation({ ...scope, sessionID: request.sessionID, requestID: request.id }, options))
  signal.throwIfAborted()
  const result = readHostEnvelope(raw, { request: hostJSONBytes, invocation: hostJSONBytes })
  if (!result) return
  const fresh = snapshotRequest(result.request, scope)
  if (!fresh || !sameRequest(snapshot, fresh)) return
  const captured = readHostInvocation(result.invocation)
  if (!captured) return
  const source = request.source!
  const message = await owned(client.session.message.get({ sessionID: request.sessionID, messageID: source.assistantID }, options))
  signal.throwIfAborted()
  const invocation = bindHostInvocation(snapshot, request.sessionID, message, captured)
  if (!invocation) return
  const conversation = await loadHostConversationContext({ sessionID: request.sessionID, location: scope.location }, client, signal)
  signal.throwIfAborted()
  return { snapshot, invocation, conversation }
}

/** Recheck native identity and the connected companion epoch once all reads and
 * evidence validation have finished, without extending the caller's deadline.
 */
export async function finalizePendingInvocation(client: OpenCodeClient, current: HostInvocationRead,
  signal: AbortSignal): Promise<HostInvocationRead | undefined> {
  signal.throwIfAborted()
  const { snapshot } = current, { scope, request } = snapshot
  const owned = <T>(work: Promise<T>) => transportOwnership(signal)?.track(work) ?? work
  const options = { location: scope.location, signal }
  const final = snapshotRequest(await owned(client.permission.get({ sessionID: request.sessionID, requestID: request.id }, options)), scope)
  signal.throwIfAborted()
  if (!final || !sameRequest(snapshot, final)) return
  const handshake = readHandshake(await owned(client.rpc(companionRpc).handshake(scope.location, options)), scope.location)
  signal.throwIfAborted()
  if (handshake?.epoch !== scope.epoch) return
  return current
}

/** A read-only boundary using this CLI's connected client and companion epoch.
 * Root intent stays separate from exact invocation identity; unproven nested calls
 * and missed startup captures return unavailable instead of guessing linkage.
 */
export async function readPendingInvocation(client: OpenCodeClient, at: HostScope, pending: unknown,
  parent: AbortSignal): Promise<HostInvocationRead | undefined> {
  const snapshot = snapshotRequest(pending, at)
  if (!snapshot?.request.source) return
  return withDeadline(parent, 5000, async signal => {
    const current = await preparePendingInvocation(client, snapshot, signal)
    return current && finalizePendingInvocation(client, current, signal)
  }, "Pending invocation lookup")
}
