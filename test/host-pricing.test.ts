import assert from "node:assert/strict"
import { test } from "node:test"
import type { ModelInfo, ProviderInfo } from "@opencode/client"
import { hostPricingLookup } from "../src/host-pricing.js"
import { responseUsage, usageAttempt } from "../src/usage.js"

const baseURL = "https://reviewer.test/v1"
const rates = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
const expensive = { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } }
const higher = { input: 9, output: 30, cache: { read: 0.9, write: 11.25 } }
const provider = (overrides: Partial<ProviderInfo> = {}): ProviderInfo => ({ id: "actual-provider", name: "Display provider",
  package: "native-provider", activation: "enabled", settings: { baseURL }, ...overrides })
const model = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({ id: "catalog-id", modelID: "actual-model", providerID: "actual-provider",
  name: "Display model", capabilities: { input: [], output: [] } as unknown as ModelInfo["capabilities"], variants: [], time: { released: 0 },
  cost: [rates], status: "active", enabled: true, limit: { context: 1000000, output: 1000 }, ...overrides })
const lookup = (cost: unknown) => hostPricingLookup(baseURL, [model({ cost: cost as ModelInfo["cost"] })], [provider()])
const response = (input = 1000, output = 100) => ({ usage: { prompt_tokens: input, completion_tokens: output } })

test("public V2 pricing uses only exact provider endpoint ownership and modelID", () => {
  const get = hostPricingLookup(baseURL, [model({ canonical: "canonical-model" })], [provider({ canonical: "canonical-provider" })])
  assert.deepEqual(get("actual-model"), rates)
  for (const alias of ["catalog-id", "canonical-model", "Display model", "actual-model-latest", "actual-provider/actual-model", "ACTUAL-MODEL"]) {
    assert.equal(get(alias), undefined, alias)
  }
  assert.equal(hostPricingLookup("https://other.test/v1", [model()], [provider()])("actual-model"), undefined)
  assert.equal(hostPricingLookup(baseURL, [model({ providerID: "canonical-provider" })], [provider({ canonical: "canonical-provider" })])("actual-model"), undefined)
  assert.equal(hostPricingLookup(baseURL, [model()], [provider({ settings: undefined })])("actual-model"), undefined)
  assert.equal(hostPricingLookup(baseURL, [model()], [provider({ settings: { transport: { url: baseURL } } as unknown as ProviderInfo["settings"] })])("actual-model"), undefined)
  assert.equal(hostPricingLookup(baseURL, [model({ settings: { baseURL } })], [provider({ settings: {} })])("actual-model"), undefined)
})

test("endpoint matching uses URL normalization and trailing slashes but rejects credentials, queries and fragments", () => {
  for (const normalized of [baseURL, `${baseURL}///`, "https://REVIEWER.test:443/v1/"]) {
    assert.deepEqual(hostPricingLookup(normalized, [model()], [provider()])("actual-model"), rates)
    assert.deepEqual(hostPricingLookup(baseURL, [model()], [provider({ settings: { baseURL: normalized } })])("actual-model"), rates)
  }
  for (const invalid of [`${baseURL}?query=1`, `${baseURL}#fragment`, `${baseURL}?`, `${baseURL}#`,
    "https://user:password@reviewer.test/v1", "http://reviewer.test/v1", "https://reviewer.test:444/v1",
    "https://reviewer.test/v2", "https://reviewer.test.evil/v1", " https://reviewer.test/v1", "https://reviewer.test/v1\n", "not a URL"]) {
    assert.equal(hostPricingLookup(invalid, [model()], [provider()])("actual-model"), undefined, invalid)
    assert.equal(hostPricingLookup(baseURL, [model()], [provider({ settings: { baseURL: invalid } })])("actual-model"), undefined, invalid)
  }
})

test("native context tiers preserve strict threshold boundaries and cached read/write calculation", () => {
  const get = lookup([rates, { ...higher, tier: { type: "context", size: 400000 } }, { ...expensive, tier: { type: "context", size: 200000 } }])
  assert.equal(responseUsage(response(200000, 0), "actual-model", get)?.cost, 0.6)
  assert.equal(responseUsage(response(200001, 0), "actual-model", get)?.cost, 1.200006)
  assert.equal(responseUsage(response(400000, 0), "actual-model", get)?.cost, 2.4)
  assert.equal(responseUsage(response(400001, 0), "actual-model", get)?.cost, 3.600009)
  const cached = responseUsage({ usage: { prompt_tokens: 200001, completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 150000, cache_write_tokens: 50000 } } }, "actual-model", get)
  assert.equal(cached?.cost, (6 + 2250 + 90000 + 375000) / 1000000)
})

test("missing, malformed or reordered base rates and ambiguous tier thresholds stay unknown", () => {
  const tier = { ...expensive, tier: { type: "context", size: 200000 } }
  for (const cost of [undefined, null, {}, [], [tier], [tier, rates], [rates, rates], [rates, tier, tier],
    [null], [Object.assign([], rates)], [{ ...rates, input: -1 }], [{ ...rates, output: Infinity }], [{ ...rates, cache: { read: 0.3 } }],
    [{ ...rates, cache: Object.assign([], rates.cache) }],
    [{ ...rates, cache: undefined }], [{ ...rates, input: "3" }], [rates, { ...tier, tier: null }],
    [rates, { ...tier, tier: Object.assign([], tier.tier) }],
    [rates, { ...tier, tier: { type: "output", size: 200000 } }], [rates, { ...tier, tier: { type: "context", size: -1 } }],
    [rates, { ...tier, tier: { type: "context", size: 1.5 } }], [rates, { ...tier, tier: { type: "context", size: NaN } }],
    [rates, { ...tier, cache: { read: 0.6, write: undefined } }]]) {
    const get = lookup(cost)
    assert.equal(get("actual-model"), undefined)
    assert.deepEqual(responseUsage(response(), "actual-model", get), { input: 1000, output: 100 })
  }
  assert.deepEqual(lookup([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])("actual-model"), { input: 0, output: 0, cache: { read: 0, write: 0 } })
})

test("duplicate endpoint owners, provider IDs and exact model names are ambiguous even at identical prices", () => {
  for (const providers of [[provider(), provider()], [provider(), provider({ id: "another-provider" })],
    [provider(), provider({ settings: { baseURL: "https://other.test/v1" } })]]) {
    assert.equal(hostPricingLookup(baseURL, [model()], providers)("actual-model"), undefined)
  }
  for (const models of [[model(), model()], [model(), model({ id: "another-id" })], [model(), model({ cost: [expensive] })]]) {
    assert.equal(hostPricingLookup(baseURL, models, [provider()])("actual-model"), undefined)
  }
  assert.deepEqual(hostPricingLookup(baseURL, [model(), model({ providerID: "another-provider" })],
    [provider(), provider({ id: "another-provider", settings: { baseURL: "https://other.test/v1" } })])("actual-model"), rates)
})

test("catalog arrays, identity strings, endpoints and cost arrays are bounded without accepting truncated catalogs", () => {
  for (const models of [undefined, null, {}, Array(16385).fill(model())]) {
    assert.equal(hostPricingLookup(baseURL, models as ModelInfo[], [provider()])("actual-model"), undefined)
  }
  for (const providers of [undefined, null, {}, Array(1025).fill(provider())]) {
    assert.equal(hostPricingLookup(baseURL, [model()], providers as ProviderInfo[])("actual-model"), undefined)
  }
  for (const invalid of ["", "a".repeat(4097), "é".repeat(2049), "actual-model\0", "actual-model\n"]) {
    assert.equal(hostPricingLookup(baseURL, [model({ modelID: invalid })], [provider()])(invalid), undefined)
    assert.equal(hostPricingLookup(baseURL, [model({ providerID: invalid })], [provider({ id: invalid })])("actual-model"), undefined)
  }
  assert.equal(lookup(Array(65).fill(rates))("actual-model"), undefined)
  const longURL = `https://reviewer.test/${"a".repeat(8192)}`
  assert.equal(hostPricingLookup(longURL, [model()], [provider({ settings: { baseURL: longURL } })])("actual-model"), undefined)
})

test("ordinary reactive proxies need only public field reads, and catalog read failures stay unknown", () => {
  const publicProxy = <T extends object>(value: T): T => new Proxy(value, {
    get: (target, key, receiver) => {
      if (key === "toJSON" || key === "canonical" || key === "headers" || key === "body") assert.fail("Do not clone or inspect unrelated catalog fields")
      return Reflect.get(target, key, receiver)
    },
    ownKeys: () => { assert.fail("Do not enumerate catalog records") },
  })
  const state = model({ cost: [publicProxy({ ...rates, cache: publicProxy(rates.cache) })] })
  const get = hostPricingLookup(baseURL, publicProxy([publicProxy(state)]), publicProxy([publicProxy(provider({ settings: publicProxy({ baseURL }) }))]))
  assert.deepEqual(get("actual-model"), rates)
  state.cost = [expensive]
  assert.deepEqual(get("actual-model"), expensive)
  const failed = new Proxy(provider(), { get: () => { throw Error("catalog unavailable") } })
  assert.equal(hostPricingLookup(baseURL, [model()], [failed])("actual-model"), undefined)
})

test("exact OpenRouter reported usage.cost bypasses native pricing, without billing calls or upstream estimates", () => {
  const openRouter = "https://OPENROUTER.ai:443/api/v1///"
  const attempt = usageAttempt(openRouter, "actual-model", () => { assert.fail("Reported cost must bypass pricing") })
  attempt.observe({ usage: { ...response().usage, cost: 0.0123, cost_details: { upstream_inference_cost: 99 } } })
  assert.deepEqual(attempt.finalize(), { input: 1000, output: 100, cost: 0.0123 })
  const get = hostPricingLookup(openRouter, [model()], [provider({ settings: { baseURL: openRouter } })])
  assert.deepEqual(responseUsage(response(), "actual-model", get, openRouter), { input: 1000, output: 100 })
})
