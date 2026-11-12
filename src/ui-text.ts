/** Compact display only. Stored token counts retain their full precision. */
function compactTokens(count: number): string {
  const units = [[1e15, "Q"], [1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]] as const
  for (const [scale, suffix] of units) if (count >= scale) {
    const precision = count < scale * 100 ? 10 : 1
    return `${Math.floor(count / (scale / precision)) / precision}${suffix}`
  }
  return String(count)
}

function statisticsRating(count: number, percentage: string | undefined): string {
  return `${count} (${percentage === undefined ? "n/a" : `${percentage}%`})`
}

/**
 * User-facing interface copy. Edit the values here, then rebuild and restart
 * OpenCode. Keep keys and formatter parameters intact so callers stay typed.
 *
 * This is source-level customization, not a tui.json option or runtime override.
 * Model instructions live in prompts/ and contracts/. Model-written reports and
 * host-owned controls are not interface copy.
 *
 * Review failure lines are copy too, but the errors behind them are not: their
 * internal messages also reach model limitations and diagnostics, so they stay
 * fixed in code. review-failure-text.ts maps each one to `review.failures` and
 * `review.stages` below. Errors raised by the OpenCode host or client have no
 * entry here and are shown verbatim (sanitized).
 *
 * Keep labels short: the review sidebar is 42 columns including padding.
 * Never use em dashes, semicolons or middle dots in text. Only the graphics
 * `review.staticIndicator` and `review.scanner` are exempt. The test in
 * test/review-failure-text.test.ts enforces this.
 */
export const uiText = {
  /** Marks shortened metadata rows and history outcome labels. */
  truncation: "..",
  review: {
    heading: "Permission analysis",
    safe: "✓ Safe",
    unsafe: "✗ Unsafe",
    unavailable: "! Analysis unavailable",
    retrieving: "Retrieving",
    /** The retriever is asking the conversation's own model a question. */
    asking: "Asking",
    evaluating: "Evaluating",
    /** The streamed verdict is reasoning before its report starts. */
    thinking: "Thinking",
    retrying: "Retrying",
    /** Fixed labels before the model's reason. Colored like the rating. */
    reasonForApproval: "Reason for approval:",
    reasonForRejection: "Reason for rejection:",
    /** Label before steering sent to the agent with an automatic rejection. */
    steering: "Steering:",
    /** Shown instead of the scanner when host animations are off. */
    staticIndicator: "[⋯]",
    /** Eight single-cell glyphs animate before the progress label. */
    scanner: { active: "■", inactive: "⬝" },
    /** Fallback when a review fails without an error message. */
    failed: "Review failed",
    evidenceUnavailable: "Exact operation evidence unavailable. Use native controls.",
    /** Recorded for an invalid cli.json entry. Not rendered by any current view. */
    invalidConfiguration: "Invalid configuration",
    /** Detail line under "Analysis unavailable". */
    failures: {
      // Reviewer configuration
      apiKeyMissing: (variable: string) => `API key environment variable ${variable} is unset or empty`,
      // Reviewer HTTP transport
      http: (status: number) => `Reviewer HTTP ${status}`,
      network: "Reviewer network request failed",
      responseRead: "Reviewer response read failed",
      emptyResponse: "Reviewer returned an empty HTTP response",
      responseTooLarge: "Reviewer HTTP response exceeds 64 KiB",
      responseEncoding: "Reviewer HTTP response contains invalid UTF-8",
      // Non-streamed responses (stream: false)
      invalidJson: "Reviewer returned invalid API JSON",
      completionCount: "Reviewer API must return one completion",
      noTextAssessment: "Reviewer API did not return a text assessment",
      // Streamed responses (stream: true)
      expectedStream: "Reviewer expected an SSE response",
      noTextStream: "Reviewer API did not return a text assessment stream",
      invalidStreamJson: "Reviewer returned invalid SSE API JSON",
      streamIncomplete: "Reviewer stream ended without stop and DONE",
      streamTooLarge: "Reviewer SSE wire exceeds 4 MiB",
      streamEventTooLarge: "Reviewer SSE event exceeds 64 KiB",
      streamEventCount: "Reviewer SSE exceeds 65536 events",
      streamEndedMidEvent: "Reviewer SSE ended mid-event",
      streamEncoding: "Reviewer SSE contains invalid UTF-8",
      streamParserEnded: "Reviewer SSE parser already ended",
      outputLimit: "Reviewer output token limit reached. Increase maxOutputTokens",
      // Assessment validation
      assessmentTooLarge: "Reviewer assessment exceeds 64 KiB",
      formatInvalid: "Reviewer response format invalid after configured attempts",
      // Conversation context and evidence binding
      conversationScope: "Captured conversation scope unavailable",
      conversationSession: "Conversation session unavailable or mismatched",
      conversationLocation: "Conversation location differs from captured invocation scope",
      conversationAncestry: "Conversation ancestry incomplete: cycle or 16-edge limit",
      rootHistory: "Root-user history response unavailable or invalid",
      rootMessage: "Root-user history message invalid",
      rootHistoryCursor: "Root-user history cursor invalid",
      rootHistoryRepeat: "Root-user history repeats a message",
      project: "Registered invocation project metadata unavailable or ambiguous",
      invocationScope: "Evidence request or invocation scope mismatch",
      conversationMismatch: "Evidence conversation scope mismatch",
      operationScope: "Evidence operation or conversation scope mismatch",
      // Deadlines. `stage` is one of `review.stages`
      timedOut: (stage: string) => `${stage} timed out`,
    },
    /** Stage names used by `failures.timedOut`. */
    stages: {
      review: "Review",
      hostEvidence: "Host evidence lookup",
      companionEvidence: "Companion evidence lookup",
      conversationContext: "Conversation context lookup",
      conversationHistory: "Conversation history lookup",
      evidenceCollection: "Evidence collection",
      evidenceValidation: "Evidence validation",
      retrieval: "Retrieval",
      retrievalResponse: "Retrieval response",
      reviewerResponse: "Reviewer response",
      reviewerResponseBody: "Reviewer response body",
      assessmentValidation: "Assessment validation",
    },
  },
  autoApproval: {
    countdown: (seconds: number) => `Allowed in ${seconds}s`,
    checking: "Checking…",
    waiting: "Auto-approval waiting",
    cancel: "Cancel",
    allowing: "Allowing…",
    finishing: "Auto-approved. Finishing report…",
    cancelled: "Auto-approval canceled",
    unavailable: "! Auto-approval unavailable. Use native controls.",
  },
  /** Mirrors autoApproval for automatic steering rejections. */
  autoRejection: {
    countdown: (seconds: number) => `Rejected in ${seconds}s`,
    checking: "Checking…",
    waiting: "Auto-rejection waiting",
    cancel: "Cancel",
    allowing: "Rejecting…",
    finishing: "Auto-rejected. Finishing report…",
    cancelled: "Auto-rejection canceled",
    unavailable: "! Auto-rejection unavailable. Use native controls.",
  },
  commands: {
    history: "Reviewer: Report history",
    category: "Reviewer",
    enable: "Reviewer: Enable for conversation",
    disable: "Reviewer: Disable for conversation",
    lifetime: "Reviewer: Statistics",
    instructions: "Reviewer: Session instructions",
  },
  sessionMode: {
    saved: (enabled: boolean) => enabled
      ? "Reviewer enabled for this conversation."
      : "Reviewer disabled for this conversation.",
    saveFailed: (enabled: boolean) => enabled
      ? "Reviewer enabled locally, but saving failed. Resume may use the previous setting."
      : "Reviewer disabled locally, but saving failed. Resume may use the previous setting.",
    unavailable: "Reviewer setting unavailable. Session ancestry or saved mode could not be read.",
  },
  sessionInstructions: {
    title: "Session instructions",
    close: "Close",
    placeholder: "Type instructions...",
    clear: "Clear",
    apply: "Apply",
    saveFailed: "Session instructions could not be saved.",
    loadFailed: "Session instructions could not be loaded.",
    tooLarge: (limit: number) => `Session instructions exceed maxEvidenceBytes (${limit} bytes).`,
  },
  history: {
    heading: "Analysis history", close: "Close",
    outcomes: { auto: "Auto approved", manual: "Manually approved", approved: "Manually approved", cancelled: "Canceled", rejected: "Rejected" },
    /** Rejected by a confirmed automatic steering rejection. */
    autoRejected: "Auto rejected",
    older: "<", newer: ">", index: (x: number, y: number) => `${x}/${y}`,
    empty: "No history entries", loading: "Loading history", unavailable: "History could not be read",
    unreadable: "! Unreadable entry", model: (model: string) => `model: ${model}`,
    provider: (providerBaseURL: string) => `provider: ${providerBaseURL}`,
    timeToRating: (seconds: string) => `Time to first rating: ${seconds}s`,
    timeToReport: (seconds: string) => `Time to full report: ${seconds}s`,
  },
  usage: {
    tokens: (input: number, output: number) => `tokens: ${input} in ${output} out`,
    toolCalls: (count: number) => `tool calls: ${count}`,
    cost: (amount: string) => `cost: $${amount}`,
  },
  lifetime: {
    title: "Reviewer statistics",
    close: "Close",
    scopeTab: (scope: "conversation" | "lifetime") => scope === "conversation" ? "Conversation" : "Lifetime",
    switchScope: "Tab: switch view",
    noConversation: "Select a conversation to see its statistics.",
    conversationUnavailable: "Conversation statistics unavailable. Recorded totals have not been reset.",
    loading: "Loading recorded usage…",
    unavailable: "Lifetime usage unavailable. Recorded totals have not been reset.",
    inlineUnavailable: "lifetime: usage unavailable",
    empty: "lifetime: no recorded usage",
    costUnavailable: "lifetime: cost unavailable",
    cost: (amount: string, partial: boolean) => `lifetime: $${amount}${partial ? " (partial pricing)" : ""}`,
    requests: (count: number) => `${count} requests with recorded usage`,
    tokens: (input: number, output: number, partial: boolean) => `token: ${input} in ${output} out${partial ? " (partial coverage)" : ""}`,
    tokensUnavailable: "tokens unavailable",
    tokenCoverage: (available: number, total: number) => `Token counts available: ${available}/${total} requests`,
    pricingCoverage: (available: number, total: number) => `Pricing available: ${available}/${total} requests`,
    since: (date: string) => `Recorded since: ${date}`,
    ratings: (safe: number, unsafe: number) => `ratings: ${safe} ✓ ${unsafe} ✗`,
    dialogReviews: (count: number) => `Reviews: ${count}`,
    dialogRetries: (count: number) => `Retries: ${count}`,
    dialogTokens: (input: number, output: number, partial: boolean) => `Tokens: ${compactTokens(input)} in ${compactTokens(output)} out${partial ? " (partial coverage)" : ""}`,
    dialogTokensUnavailable: "Tokens: unavailable",
    dialogToolCalls: (count: number) => `Tool calls: ${count}`,
    dialogCost: (amount: string | undefined, partial: boolean) => amount === undefined ? "Cost: unavailable" : `Cost: $${amount}${partial ? " (partial pricing)" : ""}`,
    dialogSafeLabel: "Safe: ",
    dialogUnsafeLabel: "Unsafe: ",
    dialogRating: statisticsRating,
    dialogAutoApproved: (count: number, percentage: string | undefined) => `Auto-approved: ${count} (${percentage === undefined ? "n/a" : `${percentage}%`})`,
    dialogManuallyApproved: (count: number, percentage: string | undefined) => `Manually approved: ${count} (${percentage === undefined ? "n/a" : `${percentage}%`})`,
    dialogRejected: (count: number, percentage: string | undefined) => `Rejected: ${count} (${percentage === undefined ? "n/a" : `${percentage}%`})`,
    averageFullReport: (seconds: string | undefined) => `Average time to full report: ${seconds === undefined ? "unavailable" : `${seconds}s`}`,
    averageRating: (seconds: string | undefined) => `Average time to rating: ${seconds === undefined ? "unavailable" : `${seconds}s`}`,
    ratingsSince: (date: string) => `Ratings recorded since: ${date}`,
  },
  notifications: {
    application: "Opencode",
    heading: (session: string) => `Opencode (${session})`,
    openSession: "Open session",
    openReview: "Open review",
    fallbackSession: "OpenCode session",
    attention: "Session needs attention",
    unsafe: "Unsafe permission needs human approval",
    question: "Agent has a question",
    reminder: (event: string) => `${event} (Reminder)`,
    approved: "Reviewer approved a permission",
    error: "Session error",
    ended: "Session ended",
    // Arguments are escaped by the desktop adapter before formatting.
    body: (event: string) => event,
  },
} as const
