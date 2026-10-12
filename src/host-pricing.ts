import type { ModelInfo, ProviderInfo } from "@opencode/client"
import type { Pricing, PricingLookup } from "./usage.js"

const MAX_MODELS = 16384
const MAX_PROVIDERS = 1024
const MAX_NAME_BYTES = 4096
const MAX_ENDPOINT_BYTES = 8192
const MAX_RATES = 64

const object = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value)
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= MAX_NAME_BYTES && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value) <= MAX_NAME_BYTES
const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

function endpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_BYTES || Buffer.byteLength(value) > MAX_ENDPOINT_BYTES
    || /[\u0000-\u0020\u007f?#]/.test(value)) return
  try {
    const url = new URL(value)
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return
    return url.href.replace(/\/+$/, "")
  } catch { return }
}

/** Read only the native public rates, never substitute a missing cache or base rate. */
function pricing(cost: ModelInfo["cost"]): Pricing | undefined {
  if (!Array.isArray(cost) || !cost.length || cost.length > MAX_RATES) return
  let base: Pricing | undefined
  const tiers: NonNullable<Pricing["tiers"]> = []
  const thresholds = new Set<number>()
  for (let index = 0; index < cost.length; index++) {
    const entry = cost[index]
    if (!entry || !object(entry) || !rate(entry.input) || !rate(entry.output) || !object(entry.cache)
      || !rate(entry.cache.read) || !rate(entry.cache.write)) return
    const rates = { input: entry.input, output: entry.output, cache: { read: entry.cache.read, write: entry.cache.write } }
    if (index === 0) {
      if (entry.tier !== undefined) return
      base = rates
      continue
    }
    const tier = entry.tier
    if (!tier || !object(tier) || tier.type !== "context" || !Number.isSafeInteger(tier.size) || tier.size < 0 || thresholds.has(tier.size)) return
    thresholds.add(tier.size)
    tiers.push({ ...rates, tier: { type: "context", size: tier.size } })
  }
  return base && { ...base, ...(tiers.length ? { tiers } : {}) }
}

/** A public V2 catalog adapter for the reviewer's existing per-million calculation.
 * Endpoint ownership and modelID must each be unique. No canonical names, aliases,
 * package defaults, transport URLs or implicit zero prices establish a match.
 * Public field reads also work with ordinary reactive catalog proxies.
 */
export function hostPricingLookup(baseURL: string, models: readonly ModelInfo[] | undefined,
  providers: readonly ProviderInfo[] | undefined): PricingLookup {
  const target = endpoint(baseURL)
  return modelID => {
    try {
      if (!target || !name(modelID) || !Array.isArray(models) || models.length > MAX_MODELS
        || !Array.isArray(providers) || providers.length > MAX_PROVIDERS) return
      let providerID: string | undefined
      const providerIDs = new Set<string>()
      for (const provider of providers) {
        if (!provider || !object(provider) || !name(provider.id) || providerIDs.has(provider.id)) return
        providerIDs.add(provider.id)
        if (!object(provider.settings) || endpoint(provider.settings?.baseURL) !== target) continue
        if (providerID !== undefined) return
        providerID = provider.id
      }
      if (providerID === undefined) return
      let match: ModelInfo | undefined
      for (const model of models) {
        if (!model || !object(model) || !name(model.providerID) || !name(model.modelID)) return
        if (model.providerID !== providerID || model.modelID !== modelID) continue
        if (match !== undefined) return
        match = model
      }
      return match && pricing(match.cost)
    } catch { return } // Unavailable catalog metadata cannot affect review or valid token counts.
  }
}
