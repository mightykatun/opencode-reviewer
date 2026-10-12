import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { createServer } from "node:http"
import { parseConfig } from "../src/config.js"
import { review, withDeadline } from "../src/reviewer.js"
import type { Evidence, ReviewAttemptEvent, ReviewProgress } from "../src/types.js"
import type { Usage } from "../src/usage.js"

const evidence: Evidence = { kind: "shell", command: "pwd", cwd: "/fixture", userPrompt: "Show cwd", files: [], limitations: [] }
const config = parseConfig({ baseURL: "https://openrouter.ai/api/v1", model: "alias", stream: true, formatRetries: 5 })
const event = (body: unknown) => `data: ${typeof body === "string" ? body : JSON.stringify(body)}\n\n`
const frame = (delta: Record<string, unknown>, finish_reason: string | null = null) => event({
  id: "response", model: "reported-model", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
})
const preview = frame({ content: '{"safe":true,"desc":"Provisional"}' })
const usage = event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.03 } })
const done = event("[DONE]")
const expected = { input: 12, output: 4, cost: 0.03 }
const refusals = [
  ["refusal", frame({ refusal: "PRIVATE café 🍐" })],
  ["filter", frame({}, "content_filter")],
  ["tool finish", frame({}, "tool_calls")],
  ["function finish", frame({}, "function_call")],
  ["tool delta", frame({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "fixture", arguments: "" } }] })],
  ["function delta", frame({ function_call: { name: "fixture", arguments: "" } })],
] as const

function fixture(parts: readonly Uint8Array[], options: { stall?: boolean; disconnect?: boolean } = {}) {
  let index = 0, pulls = 0, cancels = 0, calls = 0, retries = 0
  const progress: ReviewProgress[] = [], observed: Usage[] = [], attempts: ReviewAttemptEvent[] = []
  const body = new ReadableStream<Uint8Array>({
    pull(writer) {
      pulls++
      if (index < parts.length) writer.enqueue(parts[index++]!)
      else if (options.disconnect) writer.error(Object.assign(new Error("PRIVATE socket"), { code: "ECONNRESET" }))
      else if (!options.stall) writer.close()
    },
    cancel() { cancels++; return new Promise(() => {}) },
  }, { highWaterMark: 0 })
  const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } })
  const dependencies = {
    fetcher: async () => { calls++; return response },
    onUsage: (value: Usage) => { observed.push(value) },
    onProgress: (value: ReviewProgress) => { progress.push(value) },
    onRetry: () => { retries++ },
    observation: { review: "review", observe: (value: ReviewAttemptEvent) => { attempts.push(value) } },
  }
  return { body, dependencies, progress, observed, attempts, counts: () => ({ pulls, cancels, calls, retries }) }
}

function finalized(f: ReturnType<typeof fixture>, value?: Usage) {
  assert.equal(f.counts().calls, 1)
  assert.equal(f.counts().retries, 0)
  assert.equal(f.body.locked, false)
  assert.deepEqual(f.observed, value ? [value] : [])
  assert.deepEqual(f.attempts.map(event => event.type), ["dispatched", "finalized"])
  assert.equal(f.attempts[0]!.attempt, f.attempts[1]!.attempt)
  assert.deepEqual(f.attempts[1]!.type === "finalized" ? f.attempts[1]!.usage : undefined, value)
  assert.ok(f.progress.every(value => value.attempt === 0 && value.phase !== "retrying"))
}

for (const [name, rejection] of refusals) test(`terminal ${name} clears previews and drains usage at every byte split`, async () => {
  // Cumulative usage replaces values. Before a finish, subsequent assessment JSON
  // cannot restore a rejected preview or become a format-correction request.
  const finish = name.endsWith("finish") || name === "filter" ? "" : frame({ content: '{"safe":true,"desc":"Must not return"}' }, "stop")
  const wire = Buffer.from(preview + rejection + finish
    + event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }) + usage + usage + done)
  for (let split = 0; split <= wire.length; split++) {
    const f = fixture([wire.subarray(0, split), wire.subarray(split)])
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), { message: "Reviewer API did not return a text assessment stream" })
    finalized(f, expected)
    assert.equal(f.progress[1]!.preview?.safe, true)
    assert.deepEqual(f.progress.slice(2), [{ attempt: 0, phase: "streaming" }])
    assert.doesNotMatch(JSON.stringify(f.progress), /PRIVATE|Must not return/)
    assert.equal(f.attempts[1]!.type === "finalized" && f.attempts[1]!.reportedModel, "reported-model")
  }
  const f = fixture(Array.from(wire, byte => Uint8Array.of(byte)))
  await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), /text assessment stream/)
  finalized(f, expected)
})

test("terminal rejection remains pending through usage, DONE and body EOF with its preview already cleared", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(value) { writer = value } })
  const progress: ReviewProgress[] = [], observed: Usage[] = [], attempts: ReviewAttemptEvent[] = []
  let settled = false
  const pending = review(evidence, config, new AbortController().signal, {
    fetcher: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    onProgress: value => { progress.push(value) }, onUsage: value => { observed.push(value) },
    observation: { review: "review", observe: value => { attempts.push(value) } },
  })
  const rejected = assert.rejects(pending, /text assessment stream/).then(() => { settled = true })
  writer.enqueue(Buffer.from(preview + refusals[0][1]))
  await settle()
  assert.deepEqual(progress.at(-1), { attempt: 0, phase: "streaming" })
  assert.equal(settled, false)
  assert.equal(body.locked, true)
  writer.enqueue(Buffer.from(usage + done))
  await settle()
  assert.equal(settled, false)
  assert.deepEqual(observed, [])
  assert.deepEqual(attempts.map(value => value.type), ["dispatched"])
  writer.close()
  await rejected
  assert.deepEqual(observed, [expected])
  assert.deepEqual(attempts.map(value => value.type), ["dispatched", "finalized"])
  assert.equal(body.locked, false)
})

test("a terminal rejection encountered during retryable draining retains later accounting and disables retry", async () => {
  for (const [, rejection] of refusals) {
    const invalidIndex = event({ choices: [{ index: 1, delta: {} }] })
    const f = fixture([Buffer.from(preview + invalidIndex + rejection), Buffer.from(usage + done)])
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), /text assessment stream/)
    finalized(f, expected)
    assert.ok(f.progress.slice(2).every(value => !value.preview))
  }
})

test("terminal finishes reject subsequent content, reasoning and contradictory finishes before later usage", async () => {
  const finishes = ["content_filter", "tool_calls", "function_call", "stop", "length"]
  for (const finish of finishes) {
    const prefix = finish === "stop" || finish === "length" ? frame({ refusal: "Cannot assess" }) + frame({}, finish) : frame({}, finish)
    for (const tail of [
      frame({ content: "Invalid content after finish" }),
      frame({ content: "Invalid content after finish" }, finish),
      frame({ reasoning: "Invalid reasoning" }, finish),
      frame({ reasoning_content: "Invalid reasoning" }, finish),
      frame({ reasoning_details: [{ text: "Invalid reasoning" }] }, finish),
      frame({ refusal: "Another refusal" }, finish),
      frame({ tool_calls: [{ index: 0 }] }, finish),
      frame({}, finish === "stop" ? "content_filter" : "stop"),
    ]) for (const earlierUsage of [false, true]) for (const sameChunk of [false, true]) {
      const before = preview + prefix + (earlierUsage ? usage : "")
      const after = tail + event({ choices: [], usage: { cost: 99 } }) + done
      const f = fixture(sameChunk ? [Buffer.from(before + after)] : [Buffer.from(before), Buffer.from(after)])
      await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), /text assessment stream/)
      finalized(f, earlierUsage ? expected : undefined)
      assert.ok(f.progress.slice(2).every(value => !value.preview))
    }
  }
})

test("terminal finishes allow empty repeated finish frames and retain well-framed usage", async () => {
  for (const finish of ["content_filter", "tool_calls", "function_call", "stop"]) {
    const rejection = finish === "stop" ? frame({ refusal: "Cannot assess" }, finish) : frame({}, finish)
    const f = fixture([Buffer.from(preview + rejection + frame({ content: "", reasoning: "", reasoning_details: [] }, finish) + usage + done)])
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), /text assessment stream/)
    finalized(f, expected)
  }
})

test("malformed terminal metadata retains immediate non-retryable failure rather than draining later usage", async () => {
  for (const delta of [{ role: "user" }, { role: null }, { refusal: false }, { refusal: 1 },
    { tool_calls: "" }, { tool_calls: {} }, { tool_calls: [false] }, { function_call: false }]) {
    const f = fixture([Buffer.from(frame(delta) + usage), Buffer.from(usage)], { stall: true })
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), /text assessment stream/)
    finalized(f)
    assert.equal(f.counts().pulls, 1)
    assert.equal(f.counts().cancels, 1)
  }
  // A truncation cannot turn subsequently invalid non-text metadata into another
  // transport retry, including malformed envelopes around that metadata.
  for (const rejection of [frame({ refusal: "PRIVATE" }, "unknown"), frame({ tool_calls: false }),
    event({ choices: [{ index: 1, delta: { refusal: "PRIVATE" } }] }),
    event({ choices: [{ index: 0, message: { refusal: "PRIVATE" } }] })]) {
    const f = fixture([Buffer.from(frame({}, "length") + rejection + usage)], { stall: true })
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), /text assessment stream/)
    finalized(f)
    assert.equal(f.counts().pulls, 1)
    assert.equal(f.counts().cancels, 1)
  }
})

test("terminal drains stop immediately on malformed tails and SSE resource caps, retaining only received usage", { timeout: 10000 }, async () => {
  const prefix = Buffer.from(preview + refusals[0][1] + usage)
  const late = Buffer.from(event({ choices: [], usage: { cost: 99 } }))
  const cases: [string, Uint8Array, RegExp][] = [
    ["JSON", Buffer.from(event("{")), /invalid SSE API JSON/],
    ["UTF-8", Buffer.from([0xff]), /invalid UTF-8/],
    ["event cap", Buffer.from(":" + "x".repeat(65536)), /event exceeds/],
    ["event count", Buffer.from("\n".repeat(65536)), /exceeds 65536 events/],
    ["wire cap", Buffer.from((":" + "x".repeat(1021) + "\n\n").repeat(4096)), /wire exceeds/],
    ["named event", Buffer.from("event: unexpected\n" + frame({})), /text assessment stream/],
    ["wrong ID", Buffer.from(frame({}).replace('"response"', '"changed"')), /text assessment stream/],
    ["wrong model", Buffer.from(frame({}).replace('"reported-model"', '"changed"')), /text assessment stream/],
    ["invalid envelope", Buffer.from(event([])), /text assessment stream/],
    ["invalid delta", Buffer.from(frame({ content: [] })), /text assessment stream/],
    ["unknown finish", Buffer.from(frame({}, "unknown")), /text assessment stream/],
    ["duplicate DONE", Buffer.from(done + done), /text assessment stream/],
    ["after DONE", Buffer.from(done + frame({})), /text assessment stream/],
  ]
  for (const [name, bad, expectedError] of cases) for (const sameChunk of [false, true]) {
    const parts = sameChunk ? [Buffer.concat([prefix, bad, late])] : [prefix, bad, late]
    const f = fixture(parts, { stall: true })
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), expectedError, name)
    finalized(f, expected)
    assert.equal(f.counts().pulls, sameChunk ? 1 : 2, name)
    assert.equal(f.counts().cancels, 1, name)
    assert.deepEqual(f.progress.at(-1), { attempt: 0, phase: "streaming" })
  }
  for (const tail of ["data: unfinished", "data: [DONE]\n", Buffer.from([0xe2])]) {
    const f = fixture([prefix, typeof tail === "string" ? Buffer.from(tail) : tail])
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), /mid-event|invalid UTF-8/)
    finalized(f, expected)
  }
})

test("terminal drain cancellation within one network chunk never observes later usage", async () => {
  const abort = new AbortController(), reason = new Error("native resolution")
  const f = fixture([Buffer.from(preview + refusals[0][1] + usage)], { stall: true })
  await assert.rejects(review(evidence, config, abort.signal, { ...f.dependencies, onProgress(value) {
    f.dependencies.onProgress(value)
    if (value.phase === "streaming" && !value.preview) abort.abort(reason)
  } }), error => error === reason)
  finalized(f)
  assert.equal(f.counts().cancels, 1)
  assert.equal(f.counts().pulls, 1)
})

test("terminal drains obey cancellation and the original enclosing deadline despite hanging cleanup", { timeout: 3000 }, async () => {
  for (const cancel of [true, false]) {
    const abort = new AbortController(), reason = new Error("conversation disabled")
    const f = fixture([Buffer.from(preview + refusals[0][1] + usage)], { stall: true })
    let worker: Promise<unknown> | undefined
    const pending = withDeadline(abort.signal, 100, bounded => worker = review(evidence, config, bounded, f.dependencies))
    const rejected = assert.rejects(pending, cancel ? error => error === reason : /timed out/)
    await settle()
    assert.deepEqual(f.progress.at(-1), { attempt: 0, phase: "streaming" })
    assert.equal(f.body.locked, true)
    assert.deepEqual(f.observed, [])
    if (cancel) abort.abort(reason)
    await rejected
    await worker?.catch(() => {})
    finalized(f, expected)
    assert.equal(f.counts().cancels, 1)
  }
})

test("a transient socket failure after terminal rejection cannot retry, even without prior assessment content", async () => {
  for (const [, rejection] of refusals) {
    const f = fixture([Buffer.from(rejection + usage)], { disconnect: true })
    await assert.rejects(review(evidence, config, new AbortController().signal, f.dependencies), { message: "Reviewer response read failed" })
    finalized(f, expected)
    assert.deepEqual(f.progress, [{ attempt: 0, phase: "evaluating" }, { attempt: 0, phase: "streaming" }])
  }
})

test("real HTTP terminal rejection drains delayed usage using the established response model for pricing", async t => {
  const requests: unknown[] = [], observed: Usage[] = [], models: string[] = [], attempts: ReviewAttemptEvent[] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const part of request) body += part
    requests.push(JSON.parse(body))
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write(preview + refusals[0][1])
    await settle()
    response.end(usage + done)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  await assert.rejects(review(evidence, { ...config, baseURL: `http://127.0.0.1:${address.port}/v1` }, new AbortController().signal, {
    pricing: model => { models.push(model); return { input: 1, output: 2, cache: { read: 0, write: 0 } } },
    onUsage: value => { observed.push(value) },
    observation: { review: "review", observe: value => { attempts.push(value) } },
  }), /text assessment stream/)
  assert.equal(requests.length, 1)
  assert.deepEqual(models, ["reported-model"])
  assert.deepEqual(observed, [{ input: 12, output: 4, cost: 0.00002 }])
  assert.deepEqual(attempts.map(value => value.type), ["dispatched", "finalized"])
})
