import assert from "node:assert/strict"
import { test } from "node:test"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import type { ReviewAttemptEvent } from "../src/types.js"
import { shellEvidence } from "./review-fixtures.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"

const evidence = shellEvidence({ command: "true", cwd: "/target", userPrompt: "check" })
const config = parseConfig({ model: "configured", baseURL: "https://openrouter.ai/api/v1", notify: false })
const envelope = (model?: unknown, content = '{"safe":true,"desc":"report"}', usage: unknown = { cost: 0 }) =>
  Response.json({ model, usage, choices: [{ message: { content } }] })

test("per execution and POST identity, actual retry kind and exactly-once normalized finalization leave POST bytes unchanged", async () => {
  const events: ReviewAttemptEvent[] = [], bodies: string[] = []
  let calls = 0
  const fetcher: typeof fetch = async (_url, options) => {
    bodies.push(String(options!.body))
    if (++calls === 1) return new Response("unavailable", { status: 503 })
    if (calls === 2) return envelope("failed-model", "not JSON", { prompt_tokens: 2, completion_tokens: 1, cost: 0.01 })
    return envelope("successful-model", undefined, { prompt_tokens: 4, completion_tokens: 2, cost: 0.02 })
  }
  const value = await review(evidence, config, new AbortController().signal, { fetcher, environment: {},
    observation: { review: "execution", observe: e => events.push(e) } })
  assert.deepEqual(events.filter(e => e.type === "dispatched").map(e => e.retry), ["initial", "transport", "format"])
  const attempts = events.filter(e => e.type === "dispatched").map(e => e.attempt)
  assert.equal(new Set(attempts).size, 3)
  for (const attempt of attempts) {
    assert.match(attempt, /^[0-9a-f-]{36}$/)
    assert.equal(events.filter(e => e.type === "finalized" && e.attempt === attempt).length, 1)
  }
  assert.ok(events.every(e => e.review === "execution"))
  assert.deepEqual(events.filter(e => e.type === "finalized").map(e => [e.usage, e.reportedModel]), [
    [undefined, undefined], [{ input: 2, output: 1, cost: 0.01 }, "failed-model"], [{ input: 4, output: 2, cost: 0.02 }, "successful-model"],
  ])
  assert.equal(bodies[0], bodies[1])
  assert.equal(bodies[0], JSON.stringify({ model: config.model, messages: [
    { role: "system", content: [BUILTIN_PROMPTS.shell.instructions, (await import("../src/prompts.js")).CONTRACT].join("\n\n") },
    { role: "user", content: JSON.stringify(evidence) },
  ], max_tokens: 4096, stream: false }))
  assert.ok(!bodies.some(b => b.includes('"review":"execution"')))
  assert.equal(value.metadata?.reportedModel, "successful-model")
  assert.equal(value.metadata?.configuredModel, "configured")
  assert.equal(value.metadata?.provider, config.baseURL)
  assert.equal(value.usage, undefined, "missing first POST usage prevents complete report coverage")
})

for (const model of [undefined, "", "  ", null, 4, "x\0y", "x".repeat(4097)]) test(`final model falls back without leaking a failed attempt: ${String(model).slice(0, 12)}`, async () => {
  let calls = 0
  const value = await review(evidence, config, new AbortController().signal, { fetcher: async () =>
    ++calls === 1 ? envelope("failed-model", "invalid") : envelope(model) })
  assert.equal(value.metadata?.reportedModel, undefined)
  assert.equal(value.metadata?.configuredModel, "configured")
})

test("failed envelopes finalize model and normalized usage without storing raw error data", async () => {
  const events: ReviewAttemptEvent[] = []
  await assert.rejects(review(evidence, config, new AbortController().signal, { fetcher: async () => Response.json({ model: "failure-model",
    usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.1 }, error: { private: "secret" } }), environment: {},
  observation: { review: "execution", observe: e => events.push(e) } }))
  assert.equal(events.length, 2)
  assert.deepEqual(events[1], { type: "finalized", review: "execution", attempt: events[0]!.attempt,
    reportedModel: "failure-model", usage: { input: 2, output: 1, cost: 0.1 } })
  assert.ok(!JSON.stringify(events).includes("secret"))
})

for (const behavior of ["throw", "reject", "hang", "mutate"] as const) test(`attempt observer ${behavior} cannot change assessment or usage`, async () => {
  const value = await review(evidence, config, new AbortController().signal, { fetcher: async () => envelope("reported"), environment: {},
    observation: { review: "execution", observe: e => {
      if (behavior === "throw") throw new Error("observer")
      if (behavior === "reject") return Promise.reject(new Error("observer"))
      if (behavior === "hang") return new Promise(() => {})
      if (e.type === "finalized" && e.usage) e.usage.cost = 999
    } } })
  assert.equal(value.safe, true); assert.equal(value.usage?.cost, 0)
})

test("cancel after decoded SSE usage still emits one finalizer and no accepted result", async () => {
  const events: ReviewAttemptEvent[] = [], abort = new AbortController()
  const chunk = 'data: {"model":"reported","choices":[{"index":0,"delta":{"content":"{\\"safe\\":true,"}}],"usage":{"cost":0.1}}\n\n'
  await assert.rejects(review(evidence, { ...config, stream: true }, abort.signal, { fetcher: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(chunk)) },
  }), { headers: { "content-type": "text/event-stream" } }), environment: {},
  onProgress: e => { if (e.preview?.safe) abort.abort() }, observation: { review: "execution", observe: e => events.push(e) } }))
  assert.equal(events.length, 2)
  assert.equal(events[1]!.type, "finalized")
  assert.equal(events[1]!.type === "finalized" && events[1]!.usage?.cost, 0.1)
})

test("cancelled backoff has no invented POST dispatch or finalizer", async () => {
  const events: ReviewAttemptEvent[] = [], abort = new AbortController()
  await assert.rejects(review(evidence, config, abort.signal, { fetcher: async () => new Response("", { status: 503 }), environment: {},
    onProgress: e => { if (e.phase === "retrying") abort.abort() },
    observation: { review: "execution", observe: e => events.push(e) } }))
  assert.deepEqual(events.map(e => e.type), ["dispatched", "finalized"])
})

test("separate executions get random identities without an observer", async () => {
  const a = await review(evidence, config, new AbortController().signal, { fetcher: async () => envelope() })
  const b = await review(evidence, config, new AbortController().signal, { fetcher: async () => envelope() })
  assert.notEqual(a.metadata?.review, b.metadata?.review)
})
