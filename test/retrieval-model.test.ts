import assert from "node:assert/strict"
import { test } from "node:test"
import { parseConfig } from "../src/config.js"
import { review } from "../src/reviewer.js"
import type { RetrievalExecutor } from "../src/retrieval.js"
import type { Usage } from "../src/usage.js"
import { shellEvidence } from "./review-fixtures.js"

const base = { baseURL: "https://judge.invalid/v1", model: "judge", apiKey: "judge-key" }
const signal = () => new AbortController().signal
const executor: RetrievalExecutor = { async execute() { assert.fail("No file operations expected") } }
const usage = { prompt_tokens: 10, completion_tokens: 2 }
const completion = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage })
const verdict = () => completion('{"safe":true,"reason":"Bounded operation.","desc":"Reviewed."}')
const finish = () => ({ choices: [{ message: { role: "assistant", content: null,
  tool_calls: [{ id: "finish", type: "function", function: { name: "finish", arguments: '{"items":[]}' } }] },
  finish_reason: "tool_calls" }], usage })
const rate = (input: number) => ({ input, output: input * 2, cache: { read: 0, write: 0 } })

test("retrieval retries and forced finish stay on their own connection, then verdict corrections use the judge", async () => {
  const config = parseConfig({ ...base, retrievalBaseURL: "https://scout.invalid/v1", retrievalModel: "scout",
    retrievalApiKeyEnv: "SCOUT_KEY" })
  const requests: { url: string; body: any; authorization: string | null }[] = []
  const replies = [new Response("", { status: 503 }), Response.json(completion("Enough context.")), Response.json(finish()),
    Response.json(completion("bad assessment")), Response.json(verdict())]
  const amounts: Usage[] = []
  const result = await review(shellEvidence(), config, signal(), {
    environment: { SCOUT_KEY: " scout-key " }, retrieval: executor,
    pricing: model => { assert.equal(model, "judge"); return rate(100) },
    retrievalPricing: model => { assert.equal(model, "scout"); return rate(1) },
    onUsage: value => { amounts.push(value) },
    fetcher: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("Authorization") })
      assert.equal(init?.redirect, "error")
      return replies.shift() ?? assert.fail("Unexpected POST")
    },
  })
  assert.equal(result.safe, true)
  assert.deepEqual(requests.map(request => [request.url, request.body.model, request.authorization]), [
    ...Array.from({ length: 3 }, () => ["https://scout.invalid/v1/chat/completions", "scout", "Bearer scout-key"]),
    ...Array.from({ length: 2 }, () => ["https://judge.invalid/v1/chat/completions", "judge", "Bearer judge-key"]),
  ])
  assert.deepEqual(requests[0]!.body, requests[1]!.body, "Transport retries retain the exact retrieval request")
  assert.deepEqual(requests[2]!.body.tool_choice, { type: "function", function: { name: "finish" } })
  assert.ok(requests.slice(0, 3).every(request => request.body.stream === false && request.body.tools))
  assert.ok(requests.slice(3).every(request => request.body.tools === undefined))
  assert.equal(requests[4]!.body.messages[2].content, "bad assessment")
  assert.deepEqual(amounts, [
    { input: 10, output: 2, cost: 0.000014 }, { input: 10, output: 2, cost: 0.000014 },
    { input: 10, output: 2, cost: 0.0014 }, { input: 10, output: 2, cost: 0.0014 },
  ])
  assert.equal(result.usage, undefined, "The unmetered 503 still leaves the total incomplete")
  assert.equal(result.metadata?.configuredModel, "judge")
  assert.equal(result.metadata?.provider, base.baseURL)
})

test("credential inheritance and retrieval overrides affect only the retrieval POST", async () => {
  for (const [options, key] of [
    [{ retrievalModel: "scout" }, "judge-key"],
    [{ retrievalBaseURL: "https://scout.invalid/v1" }, undefined],
    [{ retrievalApiKeyEnv: "SCOUT_KEY" }, "scout-env-key"],
    [{ retrievalApiKey: "scout-inline-key", retrievalApiKeyEnv: "MISSING_KEY" }, "scout-inline-key"],
  ] as const) {
    const requests: { url: string; body: any; authorization: string | null }[] = []
    await review(shellEvidence(), parseConfig({ ...base, ...options }), signal(), {
      retrieval: executor, environment: { SCOUT_KEY: "scout-env-key" },
      fetcher: async (url, init) => {
        const body = JSON.parse(String(init?.body))
        requests.push({ url: String(url), body, authorization: new Headers(init?.headers).get("Authorization") })
        return Response.json(body.tools ? finish() : verdict())
      },
    })
    assert.equal(requests.length, 2)
    assert.equal(requests[0]!.authorization, key ? `Bearer ${key}` : null)
    assert.equal(requests[1]!.authorization, "Bearer judge-key")
    assert.equal(requests[1]!.url, `${base.baseURL}/chat/completions`)
    assert.equal(requests[1]!.body.model, "judge")
  }
})

test("missing retrieval credentials fall back without a retrieval POST, and disabled retrieval never resolves them", async () => {
  for (const enabled of [true, false]) {
    const config = parseConfig({ ...base, retrieval: enabled, retrievalApiKeyEnv: "MISSING_KEY" })
    let posts = 0
    const result = await review(shellEvidence(), config, signal(), { environment: {}, retrieval: executor,
      fetcher: async (url, init) => {
        posts++
        assert.equal(String(url), `${base.baseURL}/chat/completions`)
        const body = JSON.parse(String(init?.body))
        assert.equal(body.tools, undefined)
        const data = JSON.parse(body.messages[1].content)
        if (enabled) {
          assert.equal(data.retrieval.endReason, "provider-error")
          assert.match(data.limitations.join("\n"), /Retrieval API key environment variable is unset or empty/)
        } else assert.equal(data.retrieval.status, "disabled")
        assert.doesNotMatch(JSON.stringify(body), /judge-key|MISSING_KEY/)
        return Response.json(verdict())
      },
    })
    assert.equal(result.safe, true)
    assert.equal(posts, 1)
    assert.deepEqual(result.usage, { input: 10, output: 2 })
  }
})

test("a rejected separate retrieval endpoint still sends the verdict with a factual limitation", async () => {
  const urls: string[] = []
  const result = await review(shellEvidence(), parseConfig({ ...base, retrievalBaseURL: "https://scout.invalid/v1" }), signal(), {
    retrieval: executor, fetcher: async (url, init) => {
      urls.push(String(url))
      const body = JSON.parse(String(init?.body))
      if (body.tools) return new Response("unsupported tools", { status: 400 })
      const data = JSON.parse(body.messages[1].content)
      assert.equal(data.retrieval.endReason, "tools-rejected")
      assert.match(data.limitations.join("\n"), /HTTP 400/)
      return Response.json(verdict())
    },
  })
  assert.equal(result.safe, true)
  assert.deepEqual(urls, ["https://scout.invalid/v1/chat/completions", "https://judge.invalid/v1/chat/completions"])
})

test("OpenRouter caching and reported costs follow each stage's endpoint", async () => {
  const router = "https://openrouter.ai/api/v1", generic = "https://provider.invalid/v1"
  for (const retrievalBaseURL of [router, generic]) {
    const baseURL = retrievalBaseURL === router ? generic : router
    const amounts: Usage[] = []
    const result = await review(shellEvidence(), parseConfig({ baseURL, model: "judge", retrievalBaseURL, retrievalModel: "scout" }), signal(), {
      retrieval: executor, onUsage: value => { amounts.push(value) },
      pricing: () => rate(100), retrievalPricing: () => rate(1),
      fetcher: async (url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.tools) {
          assert.equal(String(url), `${retrievalBaseURL}/chat/completions`)
          assert.equal(Array.isArray(body.messages[0].content), retrievalBaseURL === router)
          if (retrievalBaseURL === router) assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" })
        } else assert.equal(String(url), `${baseURL}/chat/completions`)
        return Response.json({ ...(body.tools ? finish() : verdict()), usage: { ...usage, cost: 0.5 } })
      },
    })
    const costs = retrievalBaseURL === router ? [0.5, 0.0014] : [0.000014, 0.5]
    assert.deepEqual(amounts.map(amount => amount.cost), costs)
    assert.deepEqual(result.usage, { input: 20, output: 4, cost: costs[0]! + costs[1]! })
  }
})

test("a different retrieval endpoint cannot borrow the verdict provider's catalog prices", async () => {
  const amounts: Usage[] = []
  let lookups = 0
  await review(shellEvidence(), parseConfig({ ...base, retrievalBaseURL: "https://scout.invalid/v1" }), signal(), {
    retrieval: executor, onUsage: value => { amounts.push(value) },
    pricing: () => { lookups++; return rate(100) },
    fetcher: async (_url, init) => Response.json(JSON.parse(String(init?.body)).tools ? finish() : verdict()),
  })
  assert.equal(lookups, 1)
  assert.deepEqual(amounts, [{ input: 10, output: 2 }, { input: 10, output: 2, cost: 0.0014 }])
})
