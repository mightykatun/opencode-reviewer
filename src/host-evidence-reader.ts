import type { OpenCodeClient } from "@opencode/client"
import { companionRpc } from "./companion-protocol.js"
import { preparePendingInvocation, finalizePendingInvocation, type HostInvocationRead } from "./host-reader.js"
import { attachHostConversation, readHostOperationEvidence, type HostEvidenceOptions, type HostEvidenceResult } from "./host-evidence.js"
import { hostEvidenceOptions, readHostEvidenceOptions } from "./host-evidence-options.js"
import { hostJSONBytes, hostOperationJSONBytes, readHostEnvelope, readHostInvocation, sameHostJSON, sameRequest, snapshotRequest } from "./host-request.js"
import { withDeadline, remainingTime } from "./deadline.js"
import { readCompanion } from "./companion-read.js"
import type { HostScope, JSONObject } from "./host-types.js"

export interface HostEvidenceRead extends HostInvocationRead { result: HostEvidenceResult }

/** Filesystem evidence is collected by the scoped server companion. The CLI
 * supplies request identity and bounded collection options, never a target path,
 * tool input or fabricated operation. One budget covers both RPCs and context.
 */
export async function readHostEvidence(client: OpenCodeClient, at: HostScope, pending: unknown,
  options: HostEvidenceOptions, parent: AbortSignal): Promise<HostEvidenceRead | undefined> {
  const collection = readHostEvidenceOptions(hostEvidenceOptions(options))
  if (!collection) return
  return withDeadline(parent, 5000, async signal => {
    const initial = snapshotRequest(pending, at)
    if (!initial?.request.source) return
    const current = await preparePendingInvocation(client, initial, signal)
    if (!current) return
    const { snapshot } = current, { scope, request } = snapshot
    const rpcOptions = { location: scope.location, signal }
    const raw = await readCompanion(signal, () => client.rpc(companionRpc).evidence({ ...scope,
      sessionID: request.sessionID, requestID: request.id, options: collection, timeoutMs: remainingTime(signal) }, rpcOptions))
    signal.throwIfAborted()
    const data = readHostEnvelope(raw, { request: hostJSONBytes, invocation: hostJSONBytes, result: hostOperationJSONBytes })
    if (!data) return
    const returned = snapshotRequest(data.request, scope)
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
    if (!await finalizePendingInvocation(client, current, signal)) return
    return { ...current, result: reviewed }
  }, "Host evidence lookup")
}
