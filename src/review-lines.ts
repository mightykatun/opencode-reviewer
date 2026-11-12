import { uiText } from "./ui-text.js"
import type { Assessment, AssessmentPreview } from "./types.js"

/** Fields the live panel and saved history share for the reason and steering lines. */
export interface ReviewLineSource {
  status?: string
  assessment?: Assessment
  progress?: { preview?: AssessmentPreview }
  autoApproval?: { status: string }
  autoDecision?: "once" | "reject"
  steering?: string
}

/** "Reason for approval:" or "Reason for rejection:" with the model's reason. Reports
 * saved before the field existed have none. */
export function reasonLine(view: ReviewLineSource): { approved: boolean; label: string; text: string } | undefined {
  const live = view.status === "analyzing" ? view.progress?.preview : undefined
  const safe = view.assessment?.safe ?? live?.safe
  const reason = (view.assessment ? view.assessment.reason : live?.reason)?.trim()
  if (safe === undefined || !reason) return
  return { approved: safe, label: safe ? uiText.review.reasonForApproval : uiText.review.reasonForRejection, text: reason }
}

/** Steering shows only while a rejection is armed or sent, never after Cancel. */
export function steeringLine(view: ReviewLineSource): string | undefined {
  const status = view.autoApproval?.status
  if (view.autoDecision !== "reject" || !view.steering?.trim() || !status || status === "cancelled") return
  return view.steering.trim()
}

/** Saved outcome label. A rejection with recorded steering was automatic. */
export function historyOutcome(outcome: keyof typeof uiText.history.outcomes, steering?: string): string {
  return outcome === "rejected" && steering ? uiText.history.autoRejected : uiText.history.outcomes[outcome]
}

/** Footer copy mirrors auto-approval for an armed steering rejection. */
export function automaticCopy(view: ReviewLineSource) {
  return view.autoDecision === "reject" ? uiText.autoRejection : uiText.autoApproval
}
