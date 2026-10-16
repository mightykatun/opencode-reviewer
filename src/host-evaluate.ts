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

export interface HostReviewerDependencies extends ReviewerDependencies {
  /** Synchronous accounting setup using the validated evidence kind. */
  observeEvidence?: (evidence: HostReviewEvidence) => ReviewObservation | void
}

/** Advisory evaluation only. Admission/mode/queue/presentation are controller
 * responsibilities, and no permission write is available at this boundary.
 * Physical evidence, POSTs, retries and cleanup share one evaluator lease/budget.
 */
export function evaluateHostReview(client: OpenCodeClient, snapshot: HostRequestSnapshot, config: Config,
  prompts: PromptSet, parent: AbortSignal, onIdentified: () => void, dependencies: HostReviewerDependencies = {}): ReviewEvaluation<ReviewResult | null> {
  return ownedReview(parent, config.timeoutMs, async signal => {
    const wire = hostRequestWire(snapshot)
    if (!wire) throw new Error(uiText.review.evidenceUnavailable)
    const owned = await readHostEvidence(client, snapshot.scope, wire, config, signal)
    signal.throwIfAborted()
    if (!owned) throw new Error(uiText.review.evidenceUnavailable)
    if (owned.result.status !== "ready") return null
    onIdentified()
    signal.throwIfAborted()
    const { observeEvidence, ...reviewer } = dependencies
    let observation: ReviewObservation | void = undefined
    try { observation = observeEvidence?.(owned.result.evidence) } catch { /* Accounting cannot change review. */ }
    signal.throwIfAborted()
    return review(owned.result.evidence, config, signal, { ...reviewer, ...(observation ? { observation } : {}), prompts })
  })
}
