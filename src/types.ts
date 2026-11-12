export interface Limits {
  maxFiles: number
  maxEvidenceBytes: number
}

export type ReviewKind = "shell" | "edit" | "external-directory" | "skill" | "tool"

export interface PatchOperation {
  operation: "add" | "update" | "delete" | "move"
  path: string
  movePath?: string
}

export interface Assessment {
  safe: boolean
  desc: string
  /** Decisive reason, shown after a fixed label. Required from the model. Absent only
   * in reports saved before the field existed. */
  reason?: string
  /** Normalized steering for the requesting agent: Unsafe only, nonempty when present. */
  steering?: string
}

/** Provisional prefixes. Completion flags mark closed reason and steering tokens. */
export type AssessmentPreview = Partial<Assessment> & { reasonComplete?: boolean; steeringComplete?: boolean }

/** Monotonic durations from evaluation start, excluding approval/countdown time. */
export interface ReviewTiming {
  fullReportMs: number
  ratingMs: number
}

/** Provisional transport observations, not an accepted assessment. Only opt-in
 * fast mode may use a parsed Safe preview for early approval.
 * Attempts are zero-based; evaluating/retrying (and absent preview) clear prior content.
 * The display layer must sanitize prefixes before rendering.
 */
export interface ReviewProgress {
  attempt: number
  /** Retrieval phases (retrieving, retrieval-retrying, asking) precede verdict
   * attempts and never advance attempt ordinals. thinking marks reasoning in a
   * streamed attempt before its answer text starts. */
  phase: "retrieving" | "retrieval-retrying" | "asking" | "evaluating" | "retrying" | "thinking" | "streaming"
  preview?: AssessmentPreview
}

/** Endpoint metadata stays outside the model's strict assessment JSON. */
export interface ReviewResult extends Assessment {
  usage?: import("./usage.js").Usage
  /** Dispatched retrieval operations, excluding finish and model requests. */
  toolCalls?: number
  metadata?: ReviewMetadata
}

export interface ReviewMetadata {
  review: string
  kind: ReviewKind
  configuredModel: string
  provider: string
  reportedModel?: string
}
export type ReviewAttemptEvent =
  | { type: "dispatched"; review: string; attempt: string; retry: "initial" | "transport" | "format" }
  | { type: "finalized"; review: string; attempt: string; usage?: import("./usage.js").Usage; reportedModel?: string }
  | { type: "toolDispatched"; review: string; call: string; tool: import("./history-records.js").RetrievalCallTool }
export interface ReviewObservation {
  review: string
  observe?: (event: ReviewAttemptEvent) => unknown
}
