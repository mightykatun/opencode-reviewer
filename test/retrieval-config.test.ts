import { test } from "node:test"
import assert from "node:assert/strict"
import { parseConfig, retrievalConnection } from "../src/config.js"

const main = {
  baseURL: "https://example.com/v1",
  model: "judge",
  apiKey: "main-key",
  apiKeyEnv: "MAIN_KEY",
}

test("retrieval settings are optional, normalized, and leave root defaults unchanged", () => {
  const defaults = parseConfig(main)
  assert.equal(defaults.retrievalBaseURL, undefined)
  assert.equal(defaults.retrievalModel, undefined)
  assert.equal(defaults.retrievalApiKey, undefined)
  assert.equal(defaults.retrievalApiKeyEnv, undefined)
  const config = parseConfig({ ...main, retrievalBaseURL: "  HTTPS://EXAMPLE.COM:443/v1///  ",
    retrievalModel: " retriever ", retrievalApiKey: " retrieval-key ", retrievalApiKeyEnv: " RETRIEVAL_KEY " })
  assert.equal(config.retrievalBaseURL, "https://example.com/v1")
  assert.equal(config.retrievalModel, "retriever")
  assert.equal(config.retrievalApiKey, "retrieval-key")
  assert.equal(config.retrievalApiKeyEnv, "RETRIEVAL_KEY")
  assert.deepEqual({ ...config, retrievalBaseURL: undefined, retrievalModel: undefined,
    retrievalApiKey: undefined, retrievalApiKeyEnv: undefined }, defaults)
})

test("invalid retrieval overrides and unknown settings fail even when retrieval is disabled", () => {
  for (const [name, value] of [
    ["retrievalBaseURL", "not a URL"], ["retrievalBaseURL", "ftp://example.com"],
    ["retrievalBaseURL", "https://user:pass@example.com"], ["retrievalBaseURL", "https://example.com?"],
    ["retrievalBaseURL", "https://example.com/#"], ["retrievalModel", " "],
    ["retrievalApiKey", 42], ["retrievalApiKeyEnv", "BAD-NAME"], ["retrievalModell", "typo"],
  ] as const) {
    assert.throws(() => parseConfig({ ...main, retrieval: false, [name]: value }), new RegExp(name), `${name}: ${value}`)
  }
  for (const name of ["retrievalBaseURL", "retrievalModel", "retrievalApiKey", "retrievalApiKeyEnv"])
    for (const value of [null, false, 0, {}, [], "", " "])
      assert.throws(() => parseConfig({ ...main, [name]: value }), new RegExp(name))
})

test("retrieval defaults to the main connection and model-only overrides inherit both credentials", () => {
  assert.deepEqual(retrievalConnection(parseConfig(main)), main)
  assert.deepEqual(retrievalConnection(parseConfig({ ...main, retrievalModel: "small" })), { ...main, model: "small" })
})

test("a different endpoint never inherits main credentials", () => {
  const config = parseConfig({ ...main, retrievalBaseURL: "https://other.example/v1/" })
  assert.deepEqual(retrievalConnection(config), { baseURL: "https://other.example/v1", model: "judge",
    apiKey: undefined, apiKeyEnv: undefined })
})

test("retrieval credentials form an independent pair without changing the main connection", () => {
  const envOnly = parseConfig({ ...main, retrievalApiKeyEnv: "RETRIEVAL_KEY" })
  assert.deepEqual(retrievalConnection(envOnly), { ...main, apiKey: undefined, apiKeyEnv: "RETRIEVAL_KEY" })
  const both = parseConfig({ ...main, retrievalApiKey: "retrieval-key", retrievalApiKeyEnv: "RETRIEVAL_KEY" })
  assert.deepEqual(retrievalConnection(both), { ...main, apiKey: "retrieval-key", apiKeyEnv: "RETRIEVAL_KEY" })
  assert.deepEqual({ baseURL: both.baseURL, model: both.model, apiKey: both.apiKey, apiKeyEnv: both.apiKeyEnv }, main)
})

test("an explicitly configured equivalent normalized endpoint inherits main credentials", () => {
  const config = parseConfig({ ...main, retrievalBaseURL: " HTTPS://EXAMPLE.COM:443/v1/// " })
  assert.deepEqual(retrievalConnection(config), main)
})
