/** The one endpoint with OpenRouter request and accounting conventions. Exact match only. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

/** Reasoning effort levels accepted by the configuration. Providers decide which they support. */
export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = typeof reasoningEfforts[number]

/** Normalized base URL without trailing slashes, or undefined for an invalid value. */
export function normalizedEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return
  try { return new URL(value).href.replace(/\/+$/, "") } catch { return }
}

export function isOpenRouter(baseURL: unknown): boolean {
  return normalizedEndpoint(baseURL) === OPENROUTER_BASE_URL
}

/** Chat Completions fields for a configured effort. OpenRouter takes `reasoning.effort`, other
 * OpenAI-compatible endpoints the standard `reasoning_effort`. Unset sends nothing. */
export function reasoningRequest(connection: { baseURL: string; reasoningEffort?: ReasoningEffort }): Record<string, unknown> {
  const effort = connection.reasoningEffort
  if (!effort) return {}
  return isOpenRouter(connection.baseURL) ? { reasoning: { effort } } : { reasoning_effort: effort }
}
