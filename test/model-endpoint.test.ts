import assert from "node:assert/strict"
import { test } from "node:test"
import { isOpenRouter, normalizedEndpoint, reasoningEfforts, reasoningRequest } from "../src/model-endpoint.js"
import { parseConfig, retrievalConnection } from "../src/config.js"

test("OpenRouter is recognized by its exact normalized base URL only", () => {
  assert.equal(isOpenRouter("https://openrouter.ai/api/v1"), true)
  assert.equal(isOpenRouter("https://openrouter.ai/api/v1/"), true)
  assert.equal(isOpenRouter("https://openrouter.ai/api/v2"), false)
  assert.equal(isOpenRouter("https://api.openai.com/v1"), false)
  assert.equal(isOpenRouter(undefined), false)
  assert.equal(normalizedEndpoint("not a url"), undefined)
})

test("reasoning effort uses the OpenRouter object there and the standard field elsewhere, and nothing when unset", () => {
  assert.deepEqual(reasoningRequest({ baseURL: "https://openrouter.ai/api/v1", reasoningEffort: "high" }), { reasoning: { effort: "high" } })
  assert.deepEqual(reasoningRequest({ baseURL: "https://api.openai.com/v1", reasoningEffort: "low" }), { reasoning_effort: "low" })
  assert.deepEqual(reasoningRequest({ baseURL: "https://openrouter.ai/api/v1" }), {})
})

test("reasoning efforts parse from the fixed list and reject anything else", () => {
  const base = { baseURL: "https://openrouter.ai/api/v1", model: "m" }
  for (const effort of reasoningEfforts) assert.equal(parseConfig({ ...base, reasoningEffort: effort }).reasoningEffort, effort)
  assert.equal(parseConfig(base).reasoningEffort, undefined)
  for (const value of ["High", "", null, 3, true]) {
    assert.throws(() => parseConfig({ ...base, reasoningEffort: value }), /reasoningEffort must be one of/)
    assert.throws(() => parseConfig({ ...base, retrievalReasoningEffort: value }), /retrievalReasoningEffort must be one of/)
  }
})

test("retrieval inherits the effort only for the same model at the same endpoint, and its own effort wins", () => {
  const base = { baseURL: "https://openrouter.ai/api/v1", model: "m", reasoningEffort: "high" }
  assert.equal(retrievalConnection(parseConfig(base)).reasoningEffort, "high")
  assert.equal(retrievalConnection(parseConfig({ ...base, retrievalModel: "other" })).reasoningEffort, undefined)
  assert.equal(retrievalConnection(parseConfig({ ...base, retrievalBaseURL: "https://api.openai.com/v1" })).reasoningEffort, undefined)
  assert.equal(retrievalConnection(parseConfig({ ...base, retrievalModel: "other", retrievalReasoningEffort: "low" })).reasoningEffort, "low")
  assert.equal(retrievalConnection(parseConfig({ ...base, retrievalReasoningEffort: "none" })).reasoningEffort, "none")
})
