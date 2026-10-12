import type { OpenCodeClient } from "@opencode/client"
import type { Config } from "./config.js"
import type { PromptSet } from "./prompts.js"
import { hostRequestWire } from "./host-request.js"
import { readHostEvidence } from "./host-evidence-reader.js"
import { review, type ReviewerDependencies } from "./reviewer.js"
import { ownedReview, type ReviewEvaluation } from "./review-admission.js"
import type { HostRequestSnapshot } from "./host-types.js"
import type { ReviewResult } from "./types.js"

/** Advisory evaluation only. Admission/mode/queue/presentation are controller
 * responsibilities, and no permission write is available at this boundary.
 * Physical evidence, POSTs, retries and cleanup share one evaluator lease/budget.
 */
export function evaluateHostReview(client: OpenCodeClient, snapshot: HostRequestSnapshot, config: Config,
  prompts: PromptSet, parent: AbortSignal, onIdentified: () => void, dependencies: ReviewerDependencies = {}): ReviewEvaluation<ReviewResult | null> {
  return ownedReview(parent, config.timeoutMs, async signal => {
    const wire = hostRequestWire(snapshot)
    if (!wire) return null
    const owned = await readHostEvidence(client, snapshot.scope, wire, config, signal)
    signal.throwIfAborted()
    if (!owned || owned.result.status !== "ready") return null
    onIdentified()
    signal.throwIfAborted()
    return review(owned.result.evidence, config, signal, { ...dependencies, prompts })
  })
}
