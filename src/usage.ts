import { uiText } from "./ui-text.js"
import { HISTORY_TEXT_BYTES } from "./history-records.js"

/** Token counts are a pair; cost is independently available. */
export interface Usage { input?: number; output?: number; cost?: number }
export interface PricingRates {
  input: number
  output: number
  cache: { read: number; write: number }
}
export interface Pricing extends PricingRates {
  tiers?: (PricingRates & { tier: { type: "context"; size: number } })[]
}
export type PricingLookup = (model: string) => Pricing | undefined

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
/** Bounded historical metadata, independent of assessment validation and pricing. */
const reportedModel = (value: unknown): string | undefined => typeof value === "string" && value.trim()
  && !value.includes("\0") && Buffer.byteLength(value) <= HISTORY_TEXT_BYTES ? value : undefined
const endpoint = (value: unknown) => {
  if (typeof value !== "string") return
  try { return new URL(value).href.replace(/\/+$/, "") } catch { return }
}

export function responseUsage(envelope: unknown, requestedModel: string, pricing?: PricingLookup, baseURL?: string): Usage | undefined {
  const body = record(envelope), usage = record(body.usage)
  const tokens = count(usage.prompt_tokens) && count(usage.completion_tokens)
    ? { input: usage.prompt_tokens, output: usage.completion_tokens } : undefined
  if (endpoint(baseURL) === "https://openrouter.ai/api/v1") {
    // Reported cost already includes provider billing. Never add upstream cost or an estimate.
    return rate(usage.cost) ? { ...tokens, cost: usage.cost } : tokens
  }
  try { return estimatedUsage(body, requestedModel, pricing) }
  catch { return tokens } // Catalog failure must not affect the assessment or valid counts.
}

function estimatedUsage(body: Record<string, unknown>, requestedModel: string, pricing?: PricingLookup): Usage | undefined {
  const usage = record(body.usage)
  if (!count(usage.prompt_tokens) || !count(usage.completion_tokens)) return
  const result = { input: usage.prompt_tokens, output: usage.completion_tokens }
  const prices = pricing?.(typeof body.model === "string" ? body.model : requestedModel)
  if (!prices) return result
  // Omission permits the conventional zero-cache default. Explicit malformed
  // containers (including null) cannot support an estimated charge.
  const rawDetails = usage.prompt_tokens_details
  if (rawDetails !== undefined && (!rawDetails || typeof rawDetails !== "object" || Array.isArray(rawDetails))) return result
  const details = record(rawDetails)
  const cached = details.cached_tokens === undefined ? 0 : details.cached_tokens
  const written = details.cache_write_tokens === undefined ? 0 : details.cache_write_tokens
  // Native Anthropic usage is a different contract; do not guess its mapping to prompt_tokens.
  if (!count(cached) || !count(written) || cached + written > result.input
    || usage.cache_creation_input_tokens || usage.cache_read_input_tokens) return result
  const tiers = prices.tiers ?? []
  const selected = [...tiers].sort((a, b) => b.tier.size - a.tier.size).find((tier) => result.input > tier.tier.size) ?? prices
  if (![selected.input, selected.output, selected.cache.read, selected.cache.write].every(rate)) return result
  const cost = ((result.input - cached - written) * selected.input + result.output * selected.output
    + cached * selected.cache.read + written * selected.cache.write) / 1_000_000
  return Number.isFinite(cost) ? { ...result, cost } : result
}

/** One accumulator per POST. Feed decoded envelopes, including future SSE usage events.
 * Reported cost is independent of token counts. Derived cost belongs to the latest valid
 * token snapshot and must disappear if that snapshot cannot be priced.
 * Always finalize in the transport attempt's finally, even after failure or cancellation.
 */
export function usageAttempt(baseURL: string, requestedModel: string, pricing?: PricingLookup, onUsage?: (usage: Usage) => void) {
  const reportedCost = endpoint(baseURL) === "https://openrouter.ai/api/v1"
  let usage: Usage | undefined
  let finalized = false
  let model: string | undefined
  const current = () => usage ? { ...usage } : undefined
  return {
    observe(envelope: unknown): void {
      if (finalized) return
      const body = record(envelope)
      if (body.model !== undefined) model = reportedModel(body.model)
      const next = responseUsage(envelope, requestedModel, pricing, baseURL)
      if (next) usage = reportedCost ? { ...usage, ...next } : next
    },
    current,
    model: () => model,
    finalize(): Usage | undefined {
      if (!finalized) {
        finalized = true
        if (usage) {
          try { void Promise.resolve(onUsage?.({ ...usage })).catch(() => {}) }
          catch { /* The observer owns persistence diagnostics. */ }
        }
      }
      return current()
    },
  }
}

/** Report components must cover every POST, including transport recovery and corrections. */
export function sumUsage(previous: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!previous || !next) return
  const result: Usage = {}
  if (count(previous.input) && count(previous.output) && count(next.input) && count(next.output)) {
    const input = previous.input + next.input, output = previous.output + next.output
    if (count(input) && count(output)) { result.input = input; result.output = output }
  }
  const cost = previous.cost !== undefined && next.cost !== undefined ? previous.cost + next.cost : undefined
  if (rate(cost)) result.cost = cost
  return Object.keys(result).length ? result : undefined
}

export function usageText(usage: Usage): string {
  return [
    ...(count(usage.input) && count(usage.output) ? [uiText.usage.tokens(usage.input, usage.output)] : []),
    ...(usage.cost === undefined ? [] : [uiText.usage.cost(usage.cost.toFixed(4))]),
  ].join("\n")
}
