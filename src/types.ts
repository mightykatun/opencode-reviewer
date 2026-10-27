export interface Limits {
  maxFiles: number
  maxEvidenceBytes: number
  /** Standalone collectors default to narrow discovery when omitted. */
  includeShellArgumentFiles?: boolean
}

export interface FileEvidence {
  filename: string
  /** This path was a literal argv value, not a verified program input. */
  basis?: "literal argument; input role unknown"
  path?: string
  aliases?: string[]
  status: string
  contents?: string
  excerpt?: import("./excerpts.js").Excerpt
  warning?: string
}

export type ReviewKind = "shell" | "edit" | "external-directory" | "skill" | "tool"

/** Standalone shell collection input/output, not a host invocation contract. */
export interface Evidence {
  kind: "shell"
  command: string
  cwd: string | null
  userPrompt: string | null
  files: FileEvidence[]
  limitations: string[]
  execution?: { canonicalCwd: string | null }
}

export interface PatchOperation {
  operation: "add" | "update" | "delete" | "move"
  path: string
  movePath?: string
}

export interface Assessment {
  safe: boolean
  desc: string
}

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
  phase: "evaluating" | "retrying" | "streaming"
  preview?: Partial<Assessment>
}

/** Endpoint metadata stays outside the model's strict assessment JSON. */
export interface ReviewResult extends Assessment {
  usage?: import("./usage.js").Usage
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
export interface ReviewObservation {
  review: string
  observe?: (event: ReviewAttemptEvent) => unknown
}
