import type { OpenCodeClient } from "@opencode/client"
import type { Config } from "./config.js"
import type { PromptSet } from "./prompts.js"
import { hostRequestWire } from "./host-request.js"
import { readHostEvidence } from "./host-evidence-reader.js"
import type { HostReviewEvidence } from "./host-evidence.js"
import { review, type ReviewerDependencies } from "./reviewer.js"
import { ownedReview, type ReviewEvaluation } from "./review-admission.js"
import type { HostRequestSnapshot } from "./host-types.js"
import type { ReviewObservation, ReviewResult } from "./types.js"
import { uiText } from "./ui-text.js"
import { sessionInstructionsSnapshot } from "./session-instructions-snapshot.js"
import { companionBusy, companionRpc } from "./companion-protocol.js"
import { readCompanion } from "./companion-read.js"
import { boundedHostJSON } from "./host-request.js"
import { RetrievalCompletionError, type RetrievalExecutor } from "./retrieval.js"
import { DeadlineError, remainingTime } from "./deadline.js"
import { sessionContextAsker } from "./clarification.js"
import type { HostScope, HostRequest, JSONObject } from "./host-types.js"
import { readSteeringFollowUp, type SteeringRecord } from "./steering-follow-up.js"

export interface HostReviewerDependencies extends ReviewerDependencies {
  loadSessionInstructions?: (signal: AbortSignal) => Promise<string>
  /** Synchronous accounting setup using the validated evidence kind. */
  observeEvidence?: (evidence: HostReviewEvidence) => ReviewObservation | void
  /** Open steering paired with this request on arrival. */
  steeringRecord?: SteeringRecord
}

/** Advisory evaluation only. Admission/mode/queue/presentation are controller
 * responsibilities, and no permission write is available at this boundary.
 * Physical evidence, POSTs, retries and cleanup share one evaluator lease/budget.
 */
export function evaluateHostReview(client: OpenCodeClient, snapshot: HostRequestSnapshot, config: Config,
  prompts: PromptSet, parent: AbortSignal, onIdentified: () => void, dependencies: HostReviewerDependencies = {}): ReviewEvaluation<ReviewResult | null> {
  return ownedReview(parent, config.timeoutMs, async signal => {
    const { loadSessionInstructions, steeringRecord, ...captured } = dependencies
    const sessionInstructions = loadSessionInstructions
      ? await sessionInstructionsSnapshot(loadSessionInstructions, signal) : captured.sessionInstructions
    signal.throwIfAborted()
    const wire = hostRequestWire(snapshot)
    if (!wire) throw new Error(uiText.review.evidenceUnavailable)
    const owned = await readHostEvidence(client, snapshot.scope, wire, config, signal)
    signal.throwIfAborted()
    if (!owned) throw new Error(uiText.review.evidenceUnavailable)
    if (owned.result.status !== "ready") return null
    onIdentified()
    signal.throwIfAborted()
    const { observeEvidence, ...reviewer } = captured
    let observation: ReviewObservation | void = undefined
    try { observation = observeEvidence?.(owned.result.evidence) } catch { /* Accounting cannot change review. */ }
    signal.throwIfAborted()
    const evidence = owned.result.evidence
    // Same category, and a root-session steering ends with a newer root user message.
    const steeringFollowUp = steeringRecord && config.autoRejectSteering && steeringRecord.rejected.category === evidence.kind
      && (!steeringRecord.root || steeringRecord.rootMessageID === evidence.conversation.rootMessageID)
      ? await readSteeringFollowUp(client, steeringRecord, owned.snapshot.request, signal) : undefined
    signal.throwIfAborted()
    return review(evidence, config, signal, { ...reviewer, sessionInstructions, ...(observation ? { observation } : {}), prompts,
      ...(steeringFollowUp ? { steeringFollowUp } : {}),
      retrieval: reviewer.retrieval ?? companionRetrieval(client, owned.snapshot.scope, owned.snapshot.request, config.maxEvidenceBytes),
      // Retrieval offers it only for root conversations (clarificationEnabled).
      clarification: reviewer.clarification ?? sessionContextAsker(client, evidence.conversation.current.id) })
  })
}

/** Model-chosen read-only operations run in the scoped server companion. Ordinary
 * failures become factual tool results; cancellation and deadlines propagate. */
export function companionRetrieval(client: OpenCodeClient, scope: HostScope, request: HostRequest, maxBytes: number): RetrievalExecutor {
  return { async execute(call, base, timeoutMs, signal) {
    const end = performance.now() + Math.min(timeoutMs, remainingTime(signal))
    let raw: unknown, completionFailed = false
    try {
      raw = await readCompanion(signal, async () => {
        const remaining = Math.min(3600000, end - performance.now(), remainingTime(signal))
        if (remaining <= 0) throw new DeadlineError("Retrieval")
        try {
          // The caller races its logical deadline and owns this RPC until the
          // companion responds after draining. Aborting the HTTP wait would
          // hide still-running server I/O. The server enforces the sent budget.
          return await client.rpc(companionRpc).retrieve({ ...scope, sessionID: request.sessionID, requestID: request.id,
            base, call, timeoutMs: remaining, maxBytes }, { location: scope.location, signal: new AbortController().signal })
        } catch (error) {
          // Only explicit pre-admission refusals prove no work was started.
          const refused = error && typeof error === "object" && "type" in error
            && (error.type === companionBusy || error.type === "scope") && "data" in error
            && error.data && typeof error.data === "object" && !Array.isArray(error.data) && !Object.keys(error.data).length
          if (!refused) completionFailed = true
          throw error
        }
      }, timeoutMs)
    } catch {
      if (completionFailed) throw new RetrievalCompletionError()
      signal.throwIfAborted()
      return { tool: call.tool, status: "error", reason: "companion retrieval unavailable" }
    }
    signal.throwIfAborted()
    const value = boundedHostJSON(raw) as JSONObject | undefined
    if (!value || typeof value !== "object" || Array.isArray(value) || value.tool !== call.tool
      || (value.status !== "ok" && value.status !== "error"))
      return { tool: call.tool, status: "error", reason: "companion returned no usable result" }
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) return { tool: call.tool, status: "error", reason: "result exceeds size limit" }
    return value
  } }
}
