import { preparePendingInvocation, finalizePendingInvocation, type HostInvocationRead, type HostReaderClient } from "./host-reader.js"
import { attachHostConversation, readHostOperationEvidence, type HostEvidenceOptions, type HostEvidenceResult } from "./host-evidence.js"
import { hostEvidenceOptions, readHostEvidenceOptions } from "./host-evidence-options.js"
import { hostJSONBytes, hostOperationJSONBytes, readHostEnvelope, readHostInvocation, sameHostJSON, sameRequest, snapshotRequest } from "./host-request.js"
import { withDeadline, remainingTime } from "./deadline.js"
import type { CompanionAccess } from "./companion-access.js"
import type { HostScope, JSONObject } from "./host-types.js"

export interface HostEvidenceRead extends HostInvocationRead { result: HostEvidenceResult }

/** Filesystem evidence is collected by the scoped companion at its location. The
 * caller supplies request identity and bounded collection options, never a target
 * path, tool input or fabricated operation. One budget covers both reads and context.
 */
export async function readHostEvidence(client: HostReaderClient, at: HostScope, pending: unknown,
  options: HostEvidenceOptions, parent: AbortSignal, access: CompanionAccess): Promise<HostEvidenceRead | undefined> {
  const collection = readHostEvidenceOptions(hostEvidenceOptions(options))
  if (!collection) return
  return withDeadline(parent, 5000, async signal => {
    const initial = snapshotRequest(pending, at)
    if (!initial?.request.source) return
    const current = await preparePendingInvocation(client, initial, signal, access)
    if (!current) return
    const { snapshot } = current, { request } = snapshot
    const raw = await access.evidence(request.sessionID, request.id, collection, remainingTime(signal), signal)
    signal.throwIfAborted()
    const data = readHostEnvelope(raw, { request: hostJSONBytes, invocation: hostJSONBytes, result: hostOperationJSONBytes })
    if (!data) return
    const returned = snapshotRequest(data.request, snapshot.scope)
    if (!returned || !sameRequest(snapshot, returned) || !sameHostJSON(readHostInvocation(data.invocation), current.invocation)) return
    const result = data.result as JSONObject | undefined
    if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 2) return
    let reviewed: HostEvidenceResult
    if (result.status === "ready") {
      const evidence = readHostOperationEvidence(result.evidence, current, collection, signal)
      if (!evidence) return
      reviewed = { status: "ready", evidence: attachHostConversation(current, evidence) }
    } else if ((result.status === "disabled" || result.status === "unsupported") && typeof result.reason === "string" && result.reason.length > 0) {
      reviewed = { status: result.status, reason: result.reason }
    } else return
    if (!await finalizePendingInvocation(client, current, signal, access)) return
    return { ...current, result: reviewed }
  }, "Host evidence lookup")
}
