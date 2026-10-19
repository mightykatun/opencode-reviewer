/** Compact display only; stored token counts retain their full precision. */
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
 * Model instructions live in prompts/ and contracts/. Model-written reports,
 * host-owned controls and technical diagnostic details are not interface copy.
 * Keep labels short: the review sidebar is 42 columns including padding.
 */
export const uiText = {
  review: {
    heading: "Permission analysis",
    safe: "✓ Safe",
    unsafe: "✗ Unsafe",
    unavailable: "! Analysis unavailable",
    evaluating: "Evaluating",
    retrying: "Retrying",
    staticIndicator: "[⋯]",
    failed: "Review failed",
    evidenceUnavailable: "Exact operation evidence unavailable. Use native controls.",
    invalidConfiguration: "Invalid configuration",
  },
  autoApproval: {
    countdown: (seconds: number) => `Allowed in ${seconds}s`,
    checking: "Checking…",
    waiting: "Auto-approval waiting",
    cancel: "Cancel",
    allowing: "Allowing…",
    finishing: "Auto-approved; finishing report…",
    cancelled: "Auto-approval canceled",
    unavailable: "! Auto-approval unavailable. Use native controls.",
  },
  commands: {
    history: "Reviewer: Report history",
    toggleHistory: "Reviewer: Toggle report history",
    category: "Reviewer",
    enable: "Reviewer: Enable for conversation",
    disable: "Reviewer: Disable for conversation",
    lifetime: "Reviewer: Statistics",
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
  history: {
    heading: "Analysis history", close: "Close",
    outcomes: { auto: "Auto approved", manual: "Manually approved", approved: "Manually approved", cancelled: "Canceled", rejected: "Rejected" },
    older: "<", newer: ">", index: (x: number, y: number) => `${x}/${y}`,
    empty: "No history entries", loading: "Loading history", unavailable: "History could not be read",
    unreadable: "! Unreadable entry", model: (model: string) => `model: ${model}`,
    provider: (providerBaseURL: string) => `provider: ${providerBaseURL}`,
    timeToRating: (seconds: string) => `Time to first rating: ${seconds}s`,
    timeToReport: (seconds: string) => `Time to full report: ${seconds}s`,
  },
  usage: {
    tokens: (input: number, output: number) => `tokens: ${input} in ${output} out`,
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
    dialogCost: (amount: string | undefined, partial: boolean) => amount === undefined ? "Cost: unavailable" : `Cost: $${amount}${partial ? " (partial pricing)" : ""}`,
    dialogSafeLabel: "Safe: ",
    dialogUnsafeLabel: "Unsafe: ",
    dialogRating: statisticsRating,
    dialogAutoApproved: (count: number, percentage: string | undefined) => `Auto-approved: ${count} (${percentage === undefined ? "n/a" : `${percentage}%`})`,
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
