import type { OpenCodeClient } from "@opencode/client"
import { hostJSONBytes, readHostEnvelope, readHostInvocation, sameHostJSON, sameRequest, snapshotRequest } from "./host-request.js"
import { bindHostInvocation } from "./host-invocation.js"
import { loadHostConversationContext, type HostConversationContext } from "./host-context.js"
import { withDeadline } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"
import type { CompanionAccess } from "./companion-access.js"
import type { HostInvocation, HostRequestSnapshot, HostScope } from "./host-types.js"
import { registeredInvocationProject } from "./host-project.js"

export interface HostInvocationRead {
  snapshot: HostRequestSnapshot
  invocation: HostInvocation
  conversation: HostConversationContext
  /** Current registered attribution, never a replacement captured identity. */
  registeredProject?: HostInvocation["project"]
}

/** Conversation reads the binding needs from the verified client. */
export type HostReaderClient = Pick<OpenCodeClient, "session" | "message" | "permission" | "project" | "worktree">

/** Bind the captured direct or outer Code Mode invocation before any server
 * filesystem collection. The caller owns the enclosing transaction deadline.
 */
export async function preparePendingInvocation(client: HostReaderClient, snapshot: HostRequestSnapshot,
  signal: AbortSignal, access: CompanionAccess): Promise<HostInvocationRead | undefined> {
  if (!snapshot?.request.source) return
  const { scope, request } = snapshot
  signal.throwIfAborted()
  const owned = <T>(work: Promise<T>) => transportOwnership(signal)?.track(work) ?? work
  const options = { location: scope.location, signal }
  const raw = await access.invocation(request.sessionID, request.id, signal)
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
  const registeredProject = conversation.current.projectID === invocation.project.id ? undefined
    : await registeredInvocationProject(client as OpenCodeClient, invocation, conversation.current.projectID, signal)
  signal.throwIfAborted()
  return { snapshot, invocation, conversation, ...(registeredProject ? { registeredProject } : {}) }
}

/** Recheck native identity and the connected companion epoch once all reads and
 * evidence validation have finished, without extending the caller's deadline.
 */
export async function finalizePendingInvocation(client: HostReaderClient, current: HostInvocationRead,
  signal: AbortSignal, access: CompanionAccess): Promise<HostInvocationRead | undefined> {
  signal.throwIfAborted()
  const { snapshot } = current, { scope, request } = snapshot
  const owned = <T>(work: Promise<T>) => transportOwnership(signal)?.track(work) ?? work
  const options = { location: scope.location, signal }
  const final = snapshotRequest(await owned(client.permission.get({ sessionID: request.sessionID, requestID: request.id }, options)), scope)
  signal.throwIfAborted()
  if (!final || !sameRequest(snapshot, final)) return
  if (current.registeredProject) {
    const session = await owned(client.session.get({ sessionID: request.sessionID }, options))
    signal.throwIfAborted()
    if (session.id !== request.sessionID || session.location.directory !== scope.location.directory
      || session.projectID !== current.registeredProject.id) return
    const registered = await registeredInvocationProject(client as OpenCodeClient, current.invocation, current.registeredProject.id, signal)
    signal.throwIfAborted()
    if (!sameHostJSON(registered, current.registeredProject)) return
  }
  const epoch = await owned(access.epoch(signal))
  signal.throwIfAborted()
  if (epoch !== scope.epoch) return
  return current
}

/** A read-only boundary using the connected client and companion epoch.
 * Root intent stays separate from exact invocation identity. Code Mode binds only
 * the outer call; the judge receives inner-linkage uncertainty as operation evidence.
 * Missed outer/direct captures remain unavailable instead of guessing linkage.
 */
export async function readPendingInvocation(client: HostReaderClient, at: HostScope, pending: unknown,
  parent: AbortSignal, access: CompanionAccess): Promise<HostInvocationRead | undefined> {
  const snapshot = snapshotRequest(pending, at)
  if (!snapshot?.request.source) return
  return withDeadline(parent, 5000, async signal => {
    const current = await preparePendingInvocation(client, snapshot, signal, access)
    return current && finalizePendingInvocation(client, current, signal, access)
  }, "Pending invocation lookup")
}
