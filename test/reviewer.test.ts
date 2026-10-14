import { test } from "node:test"
import type { TestContext } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep, setImmediate as settle } from "node:timers/promises"
import { parseConfig } from "../src/config.js"
import { parseAssessment, review as reviewWithMetadata, withDeadline } from "../src/reviewer.js"

// Existing transport assertions stay exact for assessment/usage. Historical
// metadata has its own assertions here and detailed correlation tests separately.
async function review(...args: Parameters<typeof reviewWithMetadata>) {
  const { metadata, ...result } = await reviewWithMetadata(...args)
  assert.ok(metadata)
  assert.match(metadata.review, /^[0-9a-f-]{36}$/)
  assert.equal(metadata.kind, args[0].kind)
  assert.equal(metadata.configuredModel, args[1].model)
  assert.equal(metadata.provider, args[1].baseURL)
  return result
}
import { BUILTIN_PROMPTS, CONTRACT, CORRECTION, loadPrompts } from "../src/prompts.js"
import { collectHostEvidence } from "../src/host-evidence.js"
import { FileAccess } from "../src/file-access.js"
import { shellEvidence, editEvidence, directoryEvidence, nativeInvocation } from "./review-fixtures.js"
import type { ReviewProgress } from "../src/types.js"
import { usageText, type Usage } from "../src/usage.js"
import { lifetimeCost } from "../src/lifetime.js"
import { DatabaseSync } from "node:sqlite"
import { HistorySQL, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent } from "../src/history-records.js"
import { reviewerClock } from "./reviewer-clock.js"

const evidence = shellEvidence({
  command: "python fruits.py", cwd: "/external", userPrompt: "Count fruits",
  files: [{ filename: "fruits.py", status: "captured", contents: "print('pear')" }], limitations: [],
})
const signal = () => new AbortController().signal
const envelope = (content: string) => JSON.stringify({ choices: [{ message: { content } }] })

async function endpoint(t: TestContext, handler: (index: number, res: ServerResponse) => void) {
  const requests: { body: Record<string, any>; authorization?: string; target?: string }[] = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    requests.push({ body: JSON.parse(body), authorization: req.headers.authorization, target: req.url })
    handler(requests.length - 1, res)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return { requests, config: parseConfig({ baseURL: `http://127.0.0.1:${address.port}/v1`, model: "fixture" }) }
}

test("config defaults, URL handling, credentials, and invalid settings", () => {
  const cfg = parseConfig({ baseURL: "http://localhost:1234/v1/", model: "small" })
  assert.equal(cfg.baseURL, "http://localhost:1234/v1")
  assert.equal(cfg.timeoutMs, 30000)
  assert.equal(cfg.maxOutputTokens, 4096)
  assert.equal(cfg.formatRetries, 1)
  assert.equal(cfg.maxFiles, 6)
  assert.equal(cfg.maxEvidenceBytes, 131072)
  assert.equal(cfg.reviewBash, true)
  assert.equal(cfg.reviewEdits, true)
  assert.equal(cfg.reviewSkills, true)
  assert.equal(cfg.reviewTools, true)
  assert.equal(cfg.reviewExternalDirectories, true)
  assert.equal(cfg.autoApprove, false)
  assert.equal(cfg.fastMode, false)
  assert.equal(cfg.extraCareful, true)
  assert.equal(cfg.stream, false)
  assert.equal(cfg.autoApproveDelaySeconds, 15)
  for (const override of [ { baseURL: "file:///tmp" }, { baseURL: "https://secret@example.org" }, { model: "" }, { apiKeyEnv: "bad name" }, { timeoutMs: 0 }, { formatRetries: -1 }, { formatRetries: 1.2 }, { retries: 3 }, { reviewMcp: true }, { reviewCustomTools: true } ]) {
    assert.throws(() => parseConfig({ baseURL: "http://localhost/v1", model: "m", ...override }))
  }
})

test("transient HTTP failures recover with byte-identical POSTs and independent format correction", async t => {
  const bad = '{"safe":"yes","desc":"Needs correction."}'
  const { config, requests } = await endpoint(t, (index, res) => {
    if (index === 0 || index === 2) { res.writeHead(index === 0 ? 429 : 503, { "Retry-After": "0" }); res.end("PRIVATE"); return }
    res.end(envelope(index === 1 ? bad : '{"safe":true,"desc":"Recovered."}'))
  })
  const progress: ReviewProgress[] = []
  let retries = 0
  const result = await review(evidence, config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS,
    onProgress: p => { progress.push(p) }, onRetry: () => { retries++ } })
  assert.deepEqual(result, { safe: true, desc: "Recovered." })
  assert.equal(requests.length, 4)
  assert.equal(retries, 3, "count both transport retries and format corrections at dispatch")
  assert.deepEqual(requests[0]!.body, requests[1]!.body)
  assert.deepEqual(requests[2]!.body, requests[3]!.body)
  assert.equal(requests[2]!.body.messages.length, 4)
  assert.equal(requests[2]!.body.messages[2].content, bad)
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE|HTTP 429|HTTP 503/)
  assert.deepEqual(progress.map(p => [p.attempt, p.phase]), [[0, "evaluating"], [1, "retrying"], [2, "retrying"], [3, "retrying"]])
})

test("transient HTTP status allowlist has a two-retry cap even with format retries disabled", async t => {
  await Promise.all([408, 429, 500, 502, 503, 504].map(async status => {
    const { config, requests } = await endpoint(t, (_, res) => { res.writeHead(status); res.end("PRIVATE") })
    await assert.rejects(review(evidence, { ...config, formatRetries: 0 }, signal()), { message: `Reviewer HTTP ${status}` })
    assert.equal(requests.length, 3)
    assert.ok(requests.every(request => JSON.stringify(request.body) === JSON.stringify(requests[0]!.body)))
  }))
})

test("real connection resets before headers recover without changing evidence or authentication", async t => {
  const { config, requests } = await endpoint(t, (index, res) => {
    if (index === 0) { res.destroy(); return }
    res.end(envelope('{"safe":false,"desc":"Recovered connection."}'))
  })
  const result = await review(evidence, { ...config, apiKey: "fixture-secret" }, signal())
  assert.equal(result.safe, false)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[1]!.authorization, "Bearer fixture-secret")
})

test("format correction cannot replenish the transport retry budget", async () => {
  let calls = 0
  const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", formatRetries: 10 })
  await assert.rejects(review(evidence, config, signal(), { fetcher: async () => {
    if (++calls === 2) return new Response(envelope('{"safe":"yes","desc":"Invalid."}'))
    return new Response(null, { status: 503 })
  } }), /HTTP 503/)
  assert.equal(calls, 4, "one format correction plus two total transport retries")
})

for (const failure of ["throw", "reject"] as const) test(`retry metric observer ${failure} cannot affect the review`, async () => {
  let calls = 0, retries = 0
  const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture" })
  const result = await review(evidence, config, signal(), { fetcher: async () => ++calls === 1
    ? new Response(null, { status: 503 }) : new Response(envelope('{"safe":true,"desc":"Recovered."}')),
  environment: {}, prompts: BUILTIN_PROMPTS, onRetry: () => {
    retries++
    if (failure === "throw") throw new Error("metric unavailable")
    return Promise.reject(new Error("metric unavailable"))
  } })
  assert.equal(result.safe, true)
  assert.equal(calls, 2); assert.equal(retries, 1)
})

test("a disconnected non-streaming body restarts the exact POST rather than joining partial envelopes", async () => {
  let calls = 0, reads = 0
  const bodies: string[] = []
  const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture" })
  const result = await review(evidence, config, signal(), { fetcher: async (_, init) => {
    bodies.push(init!.body as string)
    if (++calls > 1) return new Response(envelope('{"safe":false,"desc":"Fresh response."}'))
    return new Response(new ReadableStream({ pull(writer) {
      if (reads++ === 0) writer.enqueue(Buffer.from('{"choices":['))
      else writer.error(Object.assign(new Error("PRIVATE"), { code: "UND_ERR_SOCKET" }))
    } }))
  } })
  assert.deepEqual(result, { safe: false, desc: "Fresh response." })
  assert.equal(calls, 2)
  assert.equal(bodies[0], bodies[1])
})

test("retry attempts have distinct diagnostic ordinals and cannot outlive the original deadline", async () => {
  const abort = new AbortController(), config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", timeoutMs: 1000 })
  const dispatches: number[] = []
  let calls = 0, secondAborted = false
  const start = performance.now()
  await assert.rejects(review(evidence, config, abort.signal, { fetcher: async (_, init) => {
    if (++calls === 1) return new Response(null, { status: 503 })
    init!.signal!.addEventListener("abort", () => { secondAborted = true }, { once: true })
    return new Promise<Response>(() => {})
  }, environment: {}, prompts: BUILTIN_PROMPTS, onDiagnostics: e => {
    if (e.phase === "dispatch") dispatches.push(e.attempt!)
  } }), /timed out/)
  assert.equal(calls, 2)
  assert.equal(secondAborted, true)
  assert.deepEqual(dispatches, [0, 1])
  assert.ok(performance.now() - start < 1800, "the second request must not get a new full timeout")
})

test("backoff cancellation and insufficient review time never dispatch another POST", async t => {
  const abort = new AbortController(), reason = new Error("native resolution")
  let calls = 0, retries = 0
  const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 503 }) }
  const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture" })
  const pending = review(evidence, config, abort.signal, { fetcher, environment: {}, prompts: BUILTIN_PROMPTS, onRetry: () => { retries++ } })
  await sleep(10)
  abort.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.equal(calls, 1)
  assert.equal(retries, 0, "canceled backoff is not a dispatched retry")
  calls = 0
  await assert.rejects(review(evidence, { ...config, timeoutMs: 200 }, signal(), { fetcher }), /HTTP 503/)
  assert.equal(calls, 1)
  const { config: real, requests } = await endpoint(t, (_, res) => {
    res.writeHead(429, { "Retry-After": "5" }); res.end("PRIVATE")
  })
  await assert.rejects(review(evidence, { ...real, timeoutMs: 1000 }, signal()), /HTTP 429/)
  assert.equal(requests.length, 1)
})

test("failed POSTs finalize received-only usage before backoff without inventing complete report totals", async () => {
  const config = parseConfig({ baseURL: "https://openrouter.ai/api/v1", model: "fixture", stream: true })
  const observed: Usage[] = [], requests: string[] = []
  let aborted = false
  const fetcher: typeof fetch = async (_, init) => {
    requests.push(init!.body as string)
    if (requests.length === 1) {
      init!.signal!.addEventListener("abort", () => { aborted = true }, { once: true })
      let read = 0
      return new Response(new ReadableStream({ pull(writer) {
        if (read++ === 0) writer.enqueue(Buffer.from(event({ choices: [], usage: { cost: 0.01 } })))
        else writer.error(Object.assign(new Error("PRIVATE"), { code: "ECONNRESET" }))
      } }), { headers: { "Content-Type": "text/event-stream" } })
    }
    assert.equal(aborted, true)
    assert.deepEqual(observed, [{ cost: 0.01 }], "accounting settles before the next request")
    return streamText(event(chunk('{"safe":true,"desc":"Recovered."}', "stop"))
      + event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.02 } }) + done)
  }
  const result = await review(evidence, config, signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: u => { observed.push(u) } })
  assert.deepEqual(result.usage, { cost: 0.03 }, "only cost covers both POSTs")
  assert.deepEqual(requests[0], requests[1])
  assert.equal(observed.length, 2)

  let calls = 0
  const recovered = await review(evidence, { ...config, stream: false }, signal(), { fetcher: async () => {
    if (++calls === 1) return new Response(null, { status: 503 })
    return Response.json({ choices: [{ message: { content: '{"safe":true,"desc":"Recovered."}' } }], usage: { cost: 0.02 } })
  }, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: u => { observed.push(u) } })
  assert.equal(recovered.usage, undefined, "an unreported failed attempt is not free")
  assert.equal(observed.length, 3, "the successful POST still contributes to lifetime")
})

test("streamed assessment content prevents transport retries even before a complete rating", async () => {
  for (const text of ['{"safe":', '{"safe":true,', '{"desc":"partial']) {
    let calls = 0, read = 0
    const previews: ReviewProgress[] = []
    await assert.rejects(review(evidence, streamConfig(), signal(), { fetcher: async () => {
      calls++
      return new Response(new ReadableStream({ pull(writer) {
        if (read++ === 0) writer.enqueue(Buffer.from(event(chunk(text))))
        else writer.error(Object.assign(new Error("PRIVATE"), { code: "ECONNRESET" }))
      } }), { headers: { "Content-Type": "text/event-stream" } })
    }, environment: {}, prompts: BUILTIN_PROMPTS, onProgress: p => { previews.push(p) } }), { message: "Reviewer response read failed" })
    assert.equal(calls, 1)
    assert.ok(previews.every(p => p.attempt === 0))
  }
})

test("review switches are independent strict booleans with enabled defaults", () => {
  const options = { baseURL: "http://localhost/v1", model: "m" }
  for (const reviewBash of [true, false]) for (const reviewEdits of [true, false]) {
    const config = parseConfig({ ...options, reviewBash, reviewEdits })
    assert.equal(config.reviewBash, reviewBash)
    assert.equal(config.reviewEdits, reviewEdits)
  }
  for (const name of ["reviewBash", "reviewEdits", "reviewSkills", "reviewTools", "reviewExternalDirectories", "autoApprove", "fastMode", "extraCareful", "stream"] as const) {
    assert.equal(parseConfig({ ...options, [name]: undefined })[name], name.startsWith("review") || name === "extraCareful")
    for (const value of [true, false]) assert.equal(parseConfig({ ...options, [name]: value })[name], value)
    for (const value of [null, 0, 1, "true", "false", {}, []]) {
      assert.throws(() => parseConfig({ ...options, [name]: value }), { message: `${name} must be a boolean` })
    }
  }
})

test("numeric settings default only on omission and enforce integer boundaries before transport", async (t) => {
  for (const [name, fallback, min, max] of [
    ["formatRetries", 1, 0, 100],
    ["timeoutMs", 30000, 1, 3600000],
    ["maxOutputTokens", 4096, 1, Number.MAX_SAFE_INTEGER],
    ["maxFiles", 6, 1, 1000],
    ["maxEvidenceBytes", 131072, 1, 16 * 1024 * 1024],
    ["autoApproveDelaySeconds", 15, 0, 3600],
  ] as const) {
    await t.test(name, async (t) => {
      const { config, requests } = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Unexpected."}')))
      const options = { baseURL: config.baseURL, model: config.model }
      assert.equal(parseConfig(options)[name], fallback)
      assert.equal(parseConfig({ ...options, [name]: undefined })[name], fallback)
      for (const value of [min, max]) assert.equal(parseConfig({ ...options, [name]: value })[name], value)
      let fetchCalls = 0
      const fetcher: typeof fetch = (...args) => { fetchCalls++; return fetch(...args) }
      for (const value of [null, min - 1, max + 1, min + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "fixture-secret", false]) {
        await assert.rejects(async () => {
          const cfg = parseConfig({ ...options, [name]: value })
          await review(evidence, cfg, signal(), { fetcher })
        }, { message: `${name} must be an integer between ${min} and ${max}` })
        assert.equal(fetchCalls, 0)
        assert.equal(requests.length, 0)
      }
    })
  }
})

test("strict boolean schema rejects coercion, fences, arrays, blank descriptions and extra keys", () => {
  assert.deepEqual(parseAssessment('{"safe":false,"desc":"  Prints credentials. "}'), { safe: false, desc: "Prints credentials." })
  for (const text of ['{"safe":"false","desc":"x"}', '{"safe":0,"desc":"x"}', '{"safe":true,"desc":" "}', '{"safe":true,"desc":"x","other":1}', '[]', 'null', '```json\n{"safe":true,"desc":"x"}\n```']) assert.throws(() => parseAssessment(text))
})

test("query and fragment base URLs fail before transport, including bare delimiters", async (t) => {
  for (const suffix of ["?", "?key=fixture", "#", "#fragment", "?#", "/?", "/#"]) {
    await t.test(suffix, async (t) => {
      const { config, requests } = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Unexpected."}')))
      await assert.rejects(async () => {
        const cfg = parseConfig({ ...config, baseURL: `${config.baseURL}${suffix}` })
        await review(evidence, cfg, signal())
      }, { message: "baseURL must use HTTP(S) without embedded credentials, query, or fragment" })
      assert.deepEqual(requests.map((request) => request.target), [])
    })
  }
})

test("valid base URLs preserve encoded paths and normalize trailing slashes on the wire", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Counts fruits."}')))
  const origin = new URL(config.baseURL).origin
  for (const [path, target] of [
    ["", "/chat/completions"],
    ["/", "/chat/completions"],
    ["/v1", "/v1/chat/completions"],
    ["/v1/", "/v1/chat/completions"],
    ["/v1///", "/v1/chat/completions"],
    ["/v1/%3F%23%2F%20", "/v1/%3F%23%2F%20/chat/completions"],
    ["/v1/%3f%23%2f%20///", "/v1/%3f%23%2f%20/chat/completions"],
  ]) {
    const before = requests.length
    const cfg = parseConfig({ ...config, baseURL: `${origin}${path}` })
    assert.deepEqual(await review(evidence, cfg, signal()), { safe: true, desc: "Counts fruits." })
    assert.deepEqual(requests.slice(before).map((request) => request.target), [target])
  }
})

test("minimal and explicit successful assistant envelopes remain compatible", async (t) => {
  for (const [name, fields, messageFields] of [
    ["minimal", {}, {}],
    ["assistant role only", {}, { role: "assistant" }],
    ["stop reason only", { finish_reason: "stop" }, {}],
    ["assistant stop", { finish_reason: "stop" }, { role: "assistant" }],
    ["null optional calls", { finish_reason: "stop" }, { role: "assistant", function_call: null, tool_calls: null, refusal: null }],
    ["empty tool calls", { finish_reason: "stop" }, { role: "assistant", tool_calls: [] }],
  ] as const) {
    await t.test(name, async (t) => {
      const { config, requests } = await endpoint(t, (_, res) => res.end(JSON.stringify({
        choices: [{ ...fields, message: { ...messageFields, content: '{"safe":true,"desc":"Counts fruits."}' } }],
      })))
      assert.deepEqual(await review(evidence, config, signal()), { safe: true, desc: "Counts fruits." })
      assert.deepEqual(requests.map((request) => request.target), ["/v1/chat/completions"])
    })
  }
})

test("invalid completion metadata terminates before assessment parsing without retries", async (t) => {
  for (const [name, fields, messageFields] of [
    ["legacy function call", {}, { function_call: { name: "fixture", arguments: "{}" } }],
    ["empty legacy function call", {}, { function_call: {} }],
    ["false legacy function call", {}, { function_call: false }],
    ["string legacy function call", {}, { function_call: "" }],
    ["tool call", {}, { tool_calls: [{ type: "function", function: { name: "fixture", arguments: "{}" } }] }],
    ["object tool calls", {}, { tool_calls: {} }],
    ["array-like tool calls", {}, { tool_calls: { length: 0 } }],
    ["string tool calls", {}, { tool_calls: "" }],
    ["false tool calls", {}, { tool_calls: false }],
    ["numeric tool calls", {}, { tool_calls: 0 }],
    ["user role", {}, { role: "user" }],
    ["tool role", {}, { role: "tool" }],
    ["null role", {}, { role: null }],
    ["empty role", {}, { role: "" }],
    ["length finish", { finish_reason: "length" }, {}],
    ["filtered finish", { finish_reason: "content_filter" }, {}],
    ["tool-call finish", { finish_reason: "tool_calls" }, {}],
    ["function-call finish", { finish_reason: "function_call" }, {}],
    ["null finish", { finish_reason: null }, {}],
    ["empty finish", { finish_reason: "" }, {}],
    ["unknown finish", { finish_reason: "unknown" }, {}],
    ["refusal", {}, { refusal: "Cannot assess." }],
  ] as const) {
    await t.test(name, async (t) => {
      for (const content of ['{"safe":true,"desc":"Must not be accepted."}', "bad assessment format"]) {
        const { config, requests } = await endpoint(t, (_, res) => res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", ...fields, message: { role: "assistant", content, ...messageFields } }],
        })))
        config.formatRetries = 2
        await assert.rejects(review(evidence, config, signal()), { message: "Reviewer API did not return a text assessment" })
        assert.deepEqual(requests.map((request) => request.target), ["/v1/chat/completions"])
      }
    })
  }
})

test("malformed assessment in an assistant stop envelope still gets format correction", async (t) => {
  const { config, requests } = await endpoint(t, (index, res) => res.end(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: index ? '{"safe":true,"desc":"Counts fruits."}' : "bad format" } }],
  })))
  assert.deepEqual(await review(evidence, config, signal()), { safe: true, desc: "Counts fruits." })
  assert.deepEqual(requests.map((request) => request.target), ["/v1/chat/completions", "/v1/chat/completions"])
  assert.deepEqual(requests[1]!.body.messages[2], { role: "assistant", content: "bad format" })
  assert.match(requests[1]!.body.messages[3].content, /Format validation failed: Invalid JSON/)
})

test("choice-level errors reject even Safe content without correction and retain received usage", async () => {
  for (const error of [{ message: "PRIVATE PROVIDER ERROR" }, "PRIVATE", false, 0, ""]) {
    for (const content of ['{"safe":true,"desc":"Must not be accepted."}', "bad assessment format"]) {
      const config = parseConfig({ baseURL: "https://openrouter.ai/api/v1", model: "fixture", formatRetries: 2 })
      const observed: Usage[] = []
      let calls = 0
      const fetcher: typeof fetch = async () => {
        calls++
        return new Response(JSON.stringify({ usage: { cost: 0.01, prompt_tokens: 10, completion_tokens: 2 },
          choices: [{ index: 0, finish_reason: "stop", error, message: { role: "assistant", content } }] }))
      }
      await assert.rejects(review(evidence, config, signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS,
        onUsage: (usage) => observed.push(usage) }), { message: "Reviewer API did not return a text assessment" })
      assert.equal(calls, 1)
      assert.deepEqual(observed, [{ input: 10, output: 2, cost: 0.01 }])
    }
  }
})

test("formatted descriptions preserve Markdown and decoded JSON newlines", () => {
  const desc = "**Effects**\n\n- Writes `result.txt`.\n- *Risk:* replaces its existing contents.\n\n```sh\nprintf hello\n```"
  assert.deepEqual(parseAssessment(JSON.stringify({ safe: false, desc })), { safe: false, desc })
})

test("inline API keys must be nonempty strings and validation does not expose their values", () => {
  for (const apiKey of ["", " \t\n", null, 123, false, ["fixture-secret"], { key: "fixture-secret" }]) {
    assert.throws(() => parseConfig({ baseURL: "http://localhost/v1", model: "m", apiKey }), {
      message: "apiKey must be a nonempty string",
    })
  }
})

test("sends textual source, genuine user prompt, fixed schema and optional bearer key", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Counts fruits."}')))
  config.apiKeyEnv = "TEST_REVIEW_KEY"
  config.instructions = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
  t.after(() => rm(config.instructions!, { recursive: true, force: true }))
  await writeFile(path.join(config.instructions, "PERMISSION-REVIEW-PROMPT.md"), "Custom risk guidance")
  const prompts = await loadPrompts(config.instructions, signal())
  assert.deepEqual(await review(evidence, config, signal(), { fetcher: fetch, environment: { TEST_REVIEW_KEY: "fixture-secret" }, prompts }), { safe: true, desc: "Counts fruits." })
  const body = requests[0]!.body
  assert.equal(requests[0]!.authorization, "Bearer fixture-secret")
  assert.deepEqual(JSON.parse(body.messages[1].content), evidence)
  assert.match(body.messages[0].content, /Custom risk guidance/)
  assert.match(body.messages[0].content, /exactly two fields/)
  const contract = (await readFile(new URL("../contracts/PERMISSION-REVIEW-CONTRACT.md", import.meta.url), "utf8")).trim()
  assert.equal(body.messages[0].content, `Custom risk guidance\n\n${contract}`)
  assert.equal(body.stream, false)
  assert.equal(body.stream_options, undefined)
  assert.match(body.messages[0].content, /Emit "safe" first/)
  assert.equal(body.tools, undefined)
})

test("inline API key authenticates requests and corrections without entering model evidence", async (t) => {
  const { config, requests } = await endpoint(t, (index, res) => res.end(envelope(index ? '{"safe":true,"desc":"Counts fruits."}' : "bad format")))
  const cfg = parseConfig({ ...config, apiKey: "  inline-fixture-key  " })
  assert.deepEqual(await review(evidence, cfg, signal(), { fetcher: fetch, environment: {} }), { safe: true, desc: "Counts fruits." })
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.authorization, "Bearer inline-fixture-key")
    assert.deepEqual(JSON.parse(request.body.messages[1].content), evidence)
    assert.ok(!JSON.stringify(request.body).includes("inline-fixture-key"))
  }
})

test("environment API keys match inline normalization on requests and corrections", async (t) => {
  const { config, requests } = await endpoint(t, (index, res) => res.end(envelope(index % 2 ? '{"safe":true,"desc":"Counts fruits."}' : "bad format")))
  const padded = " \t\n fixture-environment-key \r\n\u00a0"
  for (const options of [{ apiKey: padded }, { apiKeyEnv: "TEST_REVIEW_KEY" }]) {
    const cfg = parseConfig({ ...config, ...options })
    assert.deepEqual(await review(evidence, cfg, signal(), { fetcher: fetch, environment: { TEST_REVIEW_KEY: padded } }), { safe: true, desc: "Counts fruits." })
  }
  assert.deepEqual(requests.map((request) => request.target), Array(4).fill("/v1/chat/completions"))
  for (const request of requests) {
    assert.equal(request.authorization, "Bearer fixture-environment-key")
    assert.deepEqual(JSON.parse(request.body.messages[1].content), evidence)
    assert.ok(!JSON.stringify(request.body).includes("fixture-environment-key"))
  }
})

test("inline API key takes precedence over set, blank or missing environment keys", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Counts fruits."}')))
  const cfg = parseConfig({ ...config, apiKey: "inline-fixture-key", apiKeyEnv: "TEST_REVIEW_KEY" })
  for (const environment of [{ TEST_REVIEW_KEY: "environment-fixture-key" }, { TEST_REVIEW_KEY: " \t\r\n" }, {}]) {
    await review(evidence, cfg, signal(), { fetcher: fetch, environment })
  }
  assert.equal(requests.length, 3)
  for (const request of requests) assert.equal(request.authorization, "Bearer inline-fixture-key")
})

test("omitting both API-key options sends no authorization header", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Counts fruits."}')))
  await review(evidence, config, signal(), { fetcher: fetch, environment: { TEST_REVIEW_KEY: "unused-fixture-key" } })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.authorization, undefined)
})

test("format correction uses validation feedback and configurable retry count", async (t) => {
  const { config, requests } = await endpoint(t, (index, res) => res.end(envelope(index < 2 ? '{"safe":"yes","desc":"x"}' : '{"safe":false,"desc":"Source unavailable."}')))
  config.formatRetries = 2
  const result = await review(evidence, config, signal())
  assert.equal(result.safe, false)
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map((request) => request.target), Array(3).fill("/v1/chat/completions"))
  const prompt = (await readFile(new URL("../prompts/PERMISSION-REVIEW-PROMPT.md", import.meta.url), "utf8")).trim()
  const contract = (await readFile(new URL("../contracts/PERMISSION-REVIEW-CONTRACT.md", import.meta.url), "utf8")).trim()
  const correction = (await readFile(new URL("../contracts/PERMISSION-REVIEW-CORRECTION.md", import.meta.url), "utf8")).trim()
  assert.match(correction, /\{\{validationError\}\}/)
  assert.equal(requests[0]!.body.messages[0].content, `${prompt}\n\n${contract}`)
  assert.equal(requests[1]!.body.messages[3].content, correction.replace("{{validationError}}", "Invalid assessment fields or types"))
  assert.deepEqual(JSON.parse(requests[2]!.body.messages[1].content), evidence)
})

test("zero retries and exhausted retries end with unavailable, not a fabricated rating", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => res.end(envelope("not json")))
  config.formatRetries = 0
  await assert.rejects(review(evidence, config, signal()), /format invalid/)
  assert.equal(requests.length, 1)
  config.formatRetries = 2
  await assert.rejects(review(evidence, config, signal()), /format invalid/)
  assert.deepEqual(requests.map((request) => request.target), Array(4).fill("/v1/chat/completions"))
})

test("HTTP errors, malformed API envelopes and oversized bodies do not trigger correction", async (t) => {
  for (const [name, handler, expected] of [
    ["http", (_: number, res: ServerResponse) => { res.statusCode = 401; res.end("secret diagnostic") }, /HTTP 401/],
    ["envelope", (_: number, res: ServerResponse) => res.end("not API json"), /invalid API JSON/],
    ["no choices", (_: number, res: ServerResponse) => res.end("{}"), /one completion/],
    ["oversized", (_: number, res: ServerResponse) => res.end("x".repeat(70000)), /exceeds 64 KiB/],
  ] as const) {
    await t.test(name, async (t) => {
      const { config, requests } = await endpoint(t, handler)
      await assert.rejects(review(evidence, config, signal()), expected)
      assert.equal(requests.length, 1)
    })
  }
})

test("total deadline covers format retries rather than resetting per attempt", async (t) => {
  const { config, requests } = await endpoint(t, (index, res) => {
    if (!index) res.end(envelope("bad format"))
    // Correction intentionally never completes.
  })
  const start = Date.now()
  await assert.rejects(withDeadline(signal(), 100, (s) => review(evidence, config, s)), /timed out/)
  assert.equal(requests.length, 2)
  assert.ok(Date.now() - start < 1500)
})

test("cancelled and pre-cancelled reviews never return or retry a late response", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => {
    void sleep(100).then(() => res.end(envelope('{"safe":true,"desc":"Late."}')))
  })
  const controller = new AbortController()
  const promise = withDeadline(controller.signal, 1000, (s) => review(evidence, config, s))
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(promise, { name: "AbortError" })
  await sleep(120)
  assert.equal(requests.length, 1)
  await assert.rejects(withDeadline(controller.signal, 100, (s) => review(evidence, config, s)), { name: "AbortError" })
  assert.equal(requests.length, 1)
})

test("missing and blank environment API keys fail before transport with value-free errors", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Unexpected."}')))
  const cfg = parseConfig({ ...config, apiKeyEnv: "TEST_REVIEW_KEY" })
  let fetchCalls = 0
  const fetcher: typeof fetch = (...args) => { fetchCalls++; return fetch(...args) }
  for (const value of [undefined, "", " ", " \t\r\n", "\u00a0\uFEFF"]) {
    await assert.rejects(review(evidence, cfg, signal(), { fetcher, environment: { TEST_REVIEW_KEY: value } }), {
      message: "API key environment variable TEST_REVIEW_KEY is unset or empty",
    })
    assert.equal(fetchCalls, 0)
    assert.equal(requests.length, 0)
  }
})

test("environment API keys are excluded from HTTP and network error messages", async (t) => {
  const secret = "fixture-sensitive-key"
  const environment = { TEST_REVIEW_KEY: `  ${secret}  ` }
  const { config, requests } = await endpoint(t, (_, res) => { res.statusCode = 401; res.end(`Rejected ${secret}`) })
  const cfg = parseConfig({ ...config, apiKeyEnv: "TEST_REVIEW_KEY" })
  await assert.rejects(review(evidence, cfg, signal(), { fetcher: fetch, environment }), { message: "Reviewer HTTP 401" })
  assert.deepEqual(requests.map((request) => request.target), ["/v1/chat/completions"])
  assert.equal(requests[0]!.authorization, `Bearer ${secret}`)
  let fetchCalls = 0
  const fetcher: typeof fetch = async () => { fetchCalls++; throw new Error(`Transport rejected ${secret}`) }
  await assert.rejects(review(evidence, cfg, signal(), { fetcher, environment }), { message: "Reviewer network request failed" })
  assert.equal(fetchCalls, 1)
})

test("deadline also aborts a response that stalls after HTTP headers", async (t) => {
  const { config, requests } = await endpoint(t, (_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.write('{"choices":[')
  })
  await assert.rejects(withDeadline(signal(), 100, (s) => review(evidence, config, s)), /timed out/)
  assert.equal(requests.length, 1)
})

test("redirects are not followed and cannot forward review evidence", async (t) => {
  const destination = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Unexpected."}')))
  const origin = await endpoint(t, (_, res) => {
    res.writeHead(307, { Location: `${destination.config.baseURL}/chat/completions` })
    res.end()
  })
  await assert.rejects(review(evidence, origin.config, signal()), /network request failed/)
  assert.equal(origin.requests.length, 1)
  assert.equal(destination.requests.length, 0)
})

test("edit evidence uses its own assessment and fixed correction, retaining partial coverage", async (t) => {
  const { config, requests } = await endpoint(t, (index, res) => res.end(envelope(index % 2 ? '{"safe":false,"desc":"Partial review: deleted file content omitted."}' : '{"safe":"yes","desc":"bad type"}')))
  const collected = await collectHostEvidence(nativeInvocation("patch", {
    patchText: "*** Begin Patch\n*** Update File: config\n@@\n-false\n+true\n*** Delete File: data\n*** End Patch",
  }, { diff: "raw secret aggregate", files: [
    { file: "config", status: "modified", patch: "-false\n+true\n" },
    { file: "data", status: "deleted", patch: "omitted secret" },
  ] }, "/project", ["config", "data"]), { ...config, maxFiles: 1, maxEvidenceBytes: 100 }, signal(), new FileAccess())
  assert.ok(collected.status === "ready" && collected.evidence.kind === "edit")
  const edit = collected.evidence
  assert.equal(edit.partial, true)
  assert.deepEqual(edit.changes.map(change => change.status), ["included", "omitted"])
  const customDir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
  t.after(() => rm(customDir, { recursive: true, force: true }))
  await writeFile(path.join(customDir, "EDIT-REVIEW-PROMPT.md"), "Custom edit instructions")
  await writeFile(path.join(customDir, "PERMISSION-REVIEW-PROMPT.md"), "Shell-only guidance")
  const custom = await loadPrompts(customDir, signal())
  for (const prompts of [BUILTIN_PROMPTS, custom]) {
    const index = requests.length
    const result = await review(edit, config, signal(), { fetcher: fetch, environment: {}, prompts })
    assert.equal(result.safe, false)
    assert.equal(requests[index]!.body.messages[0].content, `${prompts.edit.instructions}\n\n${CONTRACT}`)
    assert.deepEqual(JSON.parse(requests[index]!.body.messages[1].content), edit)
    assert.ok(!JSON.stringify(requests[index]!.body).includes("raw secret aggregate"))
    assert.ok(!JSON.stringify(requests[index]!.body).includes("omitted secret"))
    assert.ok(!JSON.stringify(requests[index]!.body).includes("Shell-only guidance"))
    assert.equal(requests[index + 1]!.body.messages[3].content, CORRECTION.replace("{{validationError}}", "Invalid assessment fields or types"))
    assert.deepEqual(JSON.parse(requests[index + 1]!.body.messages[1].content), edit)
    assert.equal(requests[index]!.body.tools, undefined)
    assert.equal(requests[index]!.body.stream, false)
  }
})

test("extra-careful guidance defaults on and can be omitted from native auto reviews and corrections in both transport modes", async (t) => {
  let stream = false
  const { config, requests } = await endpoint(t, (index, res) => {
    const content = index % 2 ? '{"safe":true,"desc":"Bounded effects."}' : "invalid JSON"
    res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" })
    res.end(stream ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` : envelope(content))
  })
  const edit = editEvidence({ userPrompt: "Update note" })
  for (const input of [evidence, edit]) for (const autoApprove of [false, true]) for (const extraCareful of [undefined, true, false]) for (const streaming of [false, true]) {
    stream = streaming
    const prompts = { ...BUILTIN_PROMPTS, extraCareful: "CUSTOM EXTRA CARE: check the supplied evidence carefully." }
    const start = requests.length
    const settings = parseConfig({ ...config, autoApprove, extraCareful, stream, autoApproveDelaySeconds: 17 })
    await review(input, settings, signal(), { fetcher: fetch, environment: {}, prompts })
    const kind = input.kind === "edit" ? "edit" : "shell"
    for (const request of requests.slice(start)) {
      assert.equal(request.body.messages[0].content, [prompts[kind].instructions, ...(autoApprove && extraCareful !== false ? [prompts.extraCareful] : []), CONTRACT].join("\n\n"))
      assert.deepEqual(JSON.parse(request.body.messages[1].content), input)
      assert.equal(request.body.stream, stream)
      assert.equal(request.body.max_tokens, 4096)
      assert.doesNotMatch(JSON.stringify(request.body), /"extraCareful"|autoApprove|countdown|automatic approval/)
    }
    assert.equal(requests.length - start, 2)
  }
})

test("provider reasoning stays outside the displayed assessment", async (t) => {
  const { config } = await endpoint(t, (_, res) => res.end(JSON.stringify({ choices: [{ message: {
    content: '{"safe":true,"desc":"Visible effects."}', reasoning: "hidden reasoning", reasoning_content: "hidden thoughts",
  } }] })))
  assert.deepEqual(await review(evidence, config, signal()), { safe: true, desc: "Visible effects." })
})

test("configured output limit reaches both transports, network retries and format corrections unchanged", async t => {
  for (const stream of [false, true]) {
    const { config, requests } = await endpoint(t, (index, res) => {
      if (index === 0) { res.writeHead(503); res.end("temporary"); return }
      const content = index === 1 ? "bad format" : '{"safe":true,"desc":"Bounded."}'
      res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" })
      res.end(stream ? event(chunk(content, "stop")) + done : envelope(content))
    })
    const result = await review(evidence, { ...config, stream, maxOutputTokens: 8192 }, signal())
    assert.equal(result.safe, true)
    assert.equal(requests.length, 3)
    assert.ok(requests.every(request => request.body.max_tokens === 8192))
    assert.deepEqual(requests[0]!.body, requests[1]!.body)
    assert.equal(requests[2]!.body.messages.length, 4)
  }
})

test("truncated assessment stream clears its rating, drains usage, and retries the exact configured request", async () => {
  const requests: string[] = [], progress: ReviewProgress[] = [], observed: Usage[] = []
  let retries = 0
  const result = await review(evidence, { ...streamConfig(), maxOutputTokens: 4096 }, signal(), { fetcher: async (_, init) => {
    requests.push(init!.body as string)
    if (requests.length === 1) return streamText(event(chunk('{"safe":true,"desc":"Old preview"}'))
      + event(chunk("", "length")) + event({ choices: [], usage: { cost: 0.01 } }) + done)
    assert.deepEqual(observed, [{ cost: 0.01 }], "failed attempt usage is finalized before retry dispatch")
    assert.deepEqual(progress.at(-1), { attempt: 1, phase: "retrying" })
    return streamText(event(chunk('{"safe":false,"desc":"Fresh report"}', "stop"))
      + event({ choices: [], usage: { cost: 0.02 } }) + done)
  }, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: usage => { observed.push(usage) }, onProgress: value => { progress.push(value) }, onRetry: () => { retries++ } })
  assert.deepEqual(result, { safe: false, desc: "Fresh report", usage: { cost: 0.03 } })
  assert.equal(retries, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0], requests[1])
  assert.equal(JSON.parse(requests[1]!).max_tokens, 4096, "retries never increase the configured cap")
  assert.ok(progress.some(value => value.attempt === 0 && value.preview?.safe === true))
  assert.ok(progress.some(value => value.attempt === 0 && value.phase === "streaming" && !value.preview))
  assert.ok(progress.filter(value => value.attempt === 1).every(value => !value.preview?.desc?.includes("Old preview")))
  assert.deepEqual(observed, [{ cost: 0.01 }, { cost: 0.02 }])
})

test("assessment-stream retries share the transport budget and surface token-limit errors only after exhaustion", async () => {
  for (const httpFirst of [false, true]) {
    let calls = 0, retries = 0
    const observed: Usage[] = []
    await assert.rejects(review(evidence, { ...streamConfig(), formatRetries: 0 }, signal(), { fetcher: async () => {
      if (++calls === 1 && httpFirst) return new Response(null, { status: 503 })
      return streamText(event(chunk('{"safe":true,')) + event(chunk("", "length"))
        + event({ choices: [], usage: { cost: 0.01 } }) + done)
    }, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: usage => { observed.push(usage) }, onRetry: () => { retries++ } }),
    /output token limit reached; increase maxOutputTokens/)
    assert.equal(calls, 3); assert.equal(retries, 2)
    assert.equal(observed.length, httpFirst ? 2 : 3)
  }
})

test("canceling a rejected-stream retry clears the preview and dispatches no new request", async () => {
  const abort = new AbortController(), reason = new Error("conversation disabled")
  const progress: ReviewProgress[] = []
  let calls = 0, retries = 0
  await assert.rejects(review(evidence, streamConfig(), abort.signal, { fetcher: async () => {
    calls++
    return streamText(event(chunk('{"safe":true,"desc":"Discard"}')) + event(chunk("", "length")) + done)
  }, environment: {}, prompts: BUILTIN_PROMPTS, onProgress: value => {
    progress.push(value)
    if (value.phase === "retrying") abort.abort(reason)
  }, onRetry: () => { retries++ } }), error => error === reason)
  assert.equal(calls, 1); assert.equal(retries, 0)
  assert.deepEqual(progress.at(-1), { attempt: 1, phase: "retrying" })
})

test("native directory reviews select their own instructions and share the fixed correction contract", async (t) => {
  let stream = false
  const { config, requests } = await endpoint(t, (index, res) => {
    const content = index % 2 ? '{"safe":true,"desc":"Bounded operation."}' : "bad format"
    res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" })
    res.end(stream ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` : envelope(content))
  })
  const kind = "external-directory"
  for (const autoApprove of [false, true]) for (const extraCareful of [undefined, true, false]) for (const streaming of [false, true]) {
    stream = streaming
    const input = directoryEvidence({ userPrompt: "Perform fixture operation" })
    const start = requests.length
    await review(input, parseConfig({ ...config, autoApprove, extraCareful, stream }), signal())
    assert.equal(requests.length - start, 2)
    for (const request of requests.slice(start)) {
      assert.equal(request.body.messages[0].content, [BUILTIN_PROMPTS[kind].instructions, ...(autoApprove && extraCareful !== false ? [BUILTIN_PROMPTS.extraCareful] : []), CONTRACT].join("\n\n"))
      assert.deepEqual(JSON.parse(request.body.messages[1].content), input)
      assert.equal(request.body.tools, undefined)
      assert.equal(request.body.stream, stream)
      assert.equal(request.body.max_tokens, 4096)
      assert.doesNotMatch(JSON.stringify(request.body), /"extraCareful"|autoApprove|countdown|automatic approval/)
    }
    assert.equal(requests[start + 1]!.body.messages[3].content, CORRECTION.replace("{{validationError}}", "Invalid JSON"))
  }
})

test("review usage sums correction requests outside assessment JSON and evidence", async (t) => {
  const { config, requests } = await endpoint(t, (index, res) => res.end(JSON.stringify({
    model: "fixture", usage: { prompt_tokens: 100 + index, completion_tokens: 10 },
    choices: [{ message: { content: index ? '{"safe":true,"desc":"Visible effects."}' : "bad format" } }],
  })))
  const result = await review(evidence, config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS,
    pricing: () => ({ input: 1, output: 2, cache: { read: 0, write: 0 } }) })
  assert.deepEqual(result, { safe: true, desc: "Visible effects.", usage: { input: 201, output: 20, cost: 0.000241 } })
  assert.equal(requests.length, 2)
  for (const request of requests) assert.deepEqual(JSON.parse(request.body.messages[1].content), evidence)
  assert.throws(() => parseAssessment('{"safe":true,"desc":"x","usage":{"prompt_tokens":10}}'))
})

test("missing usage in either correction response omits the report usage line", async (t) => {
  for (const missing of [0, 1]) {
    const { config } = await endpoint(t, (index, res) => res.end(JSON.stringify({
      ...(index === missing ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      choices: [{ message: { content: index ? '{"safe":true,"desc":"Visible effects."}' : "bad format" } }],
    })))
    assert.deepEqual(await review(evidence, config, signal()), { safe: true, desc: "Visible effects." })
  }
})

test("lifetime observer receives each completed attempt even when the final assessment fails", async (t) => {
  const { config } = await endpoint(t, (_, res) => res.end(JSON.stringify({
    usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: { content: "bad format" } }],
  })))
  const observed: Usage[] = []
  await assert.rejects(review(evidence, config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: (usage) => observed.push(usage) }), /format invalid/)
  assert.deepEqual(observed, [{ input: 100, output: 10 }, { input: 100, output: 10 }])
})

test("completed invalid envelopes retain reported usage; accounting failures cannot break reviews", async (t) => {
  const observed: Usage[] = []
  const invalid = await endpoint(t, (_, res) => res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10 } })))
  await assert.rejects(review(evidence, invalid.config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: (usage) => observed.push(usage) }), /one completion/)
  assert.equal(observed.length, 1)
  const valid = await endpoint(t, (_, res) => res.end(JSON.stringify({
    usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: { content: '{"safe":true,"desc":"Bounded effects."}' } }],
  })))
  const result = await review(evidence, valid.config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: (usage) => {
    usage.input = 999
    throw new Error("storage failure")
  } })
  assert.deepEqual(result, { safe: true, desc: "Bounded effects.", usage: { input: 100, output: 10 } })
  const unpriced = await review(evidence, valid.config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS,
    pricing: () => { throw new Error("catalog unavailable") }, onUsage: (usage) => observed.push(usage) })
  assert.deepEqual(unpriced, result)
  assert.deepEqual(observed.at(-1), { input: 100, output: 10 })
})

test("missing usage, HTTP errors, and cancellation before usage produce no lifetime usage records", async (t) => {
  let observations = 0
  const observe = () => { observations++ }
  const missing = await endpoint(t, (_, res) => res.end(envelope('{"safe":true,"desc":"Bounded effects."}')))
  await review(evidence, missing.config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: observe })
  const error = await endpoint(t, (_, res) => { res.writeHead(503); res.end("Unavailable") })
  await assert.rejects(review(evidence, error.config, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: observe }), /HTTP 503/)
  const held = await endpoint(t, () => {})
  await assert.rejects(withDeadline(signal(), 100, (s) => review(evidence, held.config, s, { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: observe })), /timed out/)
  assert.equal(observations, 0)
})

test("OpenRouter cost-only corrections accumulate report cost and finalize each attempt once", async () => {
  const config = parseConfig({ baseURL: "https://openrouter.ai/api/v1/", model: "fixture" })
  const observed: Usage[] = []
  let calls = 0
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions")
    assert.equal(observed.length, calls, "the previous attempt must finalize before correction dispatch")
    const index = calls++
    assert.equal(JSON.parse(init!.body as string).stream, false)
    return new Response(JSON.stringify({
      usage: { cost: index ? 0.02 : 0.01, ...(index ? { prompt_tokens: 10, completion_tokens: 2 } : {}), cost_details: { upstream_inference_cost: 99 } },
      choices: [{ message: { content: index ? '{"safe":true,"desc":"Bounded effects."}' : "bad format" } }],
    }))
  }
  const result = await review(evidence, config, signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS,
    pricing: () => { assert.fail("reported cost must bypass catalog pricing") }, onUsage: (usage) => observed.push(usage) })
  assert.deepEqual(result, { safe: true, desc: "Bounded effects.", usage: { cost: 0.03 } })
  assert.deepEqual(observed, [{ cost: 0.01 }, { input: 10, output: 2, cost: 0.02 }])
  assert.equal(calls, 2)
})

test("OpenRouter incomplete report components do not suppress known lifetime contributions", async () => {
  for (const missing of [0, 1]) for (const tokens of [false, true]) {
    const config = parseConfig({ baseURL: "https://openrouter.ai/api/v1", model: "fixture" })
    const observed: Usage[] = []
    let calls = 0
    const fetcher: typeof fetch = async () => {
      const index = calls++
      return new Response(JSON.stringify({
        usage: { ...(tokens ? { prompt_tokens: 10, completion_tokens: 2 } : {}), ...(index === missing ? {} : { cost: 0 }) },
        choices: [{ message: { content: index ? '{"safe":true,"desc":"Bounded effects."}' : "bad format" } }],
      }))
    }
    const result = await review(evidence, config, signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS,
      pricing: () => { assert.fail("missing reported cost must not trigger estimation") }, onUsage: (usage) => observed.push(usage) })
    assert.deepEqual(result, { safe: true, desc: "Bounded effects.", ...(tokens ? { usage: { input: 20, output: 4 } } : {}) })
    assert.equal(calls, 2)
    assert.equal(observed.length, tokens ? 2 : 1)
    assert.deepEqual(observed.filter((usage) => usage.cost !== undefined), [{ ...(tokens ? { input: 10, output: 2 } : {}), cost: 0 }])
  }
})

test("decoded cost-only usage survives invalid envelopes, refusals and exhausted assessment corrections", async () => {
  for (const [choices, message, attempts] of [
    [undefined, /one completion/, 1],
    [[{ message: { content: "ignored", refusal: "refused" } }], /text assessment/, 1],
    [[{ message: { content: "bad format" } }], /format invalid/, 2],
  ] as const) {
    const config = parseConfig({ baseURL: "https://openrouter.ai/api/v1", model: "fixture" })
    const observed: Usage[] = []
    let calls = 0
    const fetcher: typeof fetch = async () => {
      calls++
      return new Response(JSON.stringify({ usage: { cost: 0.01, prompt_tokens: "bad", completion_tokens: 3 }, choices }))
    }
    await assert.rejects(review(evidence, config, signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: (usage) => observed.push(usage) }), message)
    assert.equal(calls, attempts)
    assert.deepEqual(observed, Array.from({ length: attempts }, () => ({ cost: 0.01 })))
  }
})

test("cancellation after decoded usage finalizes accounting but cannot return or retry an assessment", async () => {
  const config = parseConfig({ baseURL: "https://generic.test/v1", model: "fixture" })
  const controller = new AbortController()
  const observed: Usage[] = []
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 },
      choices: [{ message: { content: '{"safe":true,"desc":"Bounded effects."}' } }] }))
  }
  await assert.rejects(review(evidence, config, controller.signal, { fetcher, environment: {}, prompts: BUILTIN_PROMPTS,
    pricing: () => { controller.abort(); return { input: 1, output: 2, cache: { read: 0, write: 0 } } },
    onUsage: (usage) => observed.push(usage) }), { name: "AbortError" })
  assert.equal(calls, 1)
  assert.deepEqual(observed, [{ input: 10, output: 2, cost: 0.000014 }])
})

test("correction transport failure retains prior reported cost without an extra POST or record", async () => {
  const config = parseConfig({ baseURL: "https://openrouter.ai/api/v1", model: "fixture", formatRetries: 5 })
  const observed: Usage[] = []
  let calls = 0
  const fetcher: typeof fetch = async () => {
    if (calls++) throw new Error("disconnected")
    return new Response(JSON.stringify({ usage: { cost: 0.01 }, choices: [{ message: { content: "bad format" } }] }))
  }
  await assert.rejects(review(evidence, config, signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS, onUsage: (usage) => observed.push(usage) }), /network request failed/)
  assert.equal(calls, 2)
  assert.deepEqual(observed, [{ cost: 0.01 }])
})

const streamConfig = () => parseConfig({ baseURL: "https://openrouter.ai/api/v1", model: "fixture", stream: true })
const event = (body: unknown) => `data: ${typeof body === "string" ? body : JSON.stringify(body)}\n\n`
const chunk = (content: string | null = "", finish_reason: string | null = null) => ({
  id: "fixture-id", model: "fixture", object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content }, finish_reason }],
})
const done = event("[DONE]")
function streamingResponse(parts: readonly Uint8Array[]): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === parts.length) controller.close()
      else controller.enqueue(parts[index++]!)
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
}
const streamText = (text: string) => streamingResponse([Buffer.from(text)])

test("SSE review survives every byte split, including UTF-8 and escaped assessment Unicode", async () => {
  const desc = 'Café 🍐 **effects**\n"quoted"'
  const text = JSON.stringify({ safe: false, desc }).replace("🍐", "\\uD83C\\uDF50")
  const wire = Buffer.from(": café 🍐\r\n\r\n" + event(chunk(text.slice(0, 25)))
    + event(chunk(text.slice(25), "stop")) + event({ choices: [], usage: { cost: 0 } }) + done)
  for (let split = 0; split <= wire.length; split++) {
    let calls = 0
    const observed: Usage[] = []
    const fetcher: typeof fetch = async (_, init) => {
      calls++
      const request = JSON.parse(init!.body as string)
      assert.equal(request.stream, true)
      assert.deepEqual(request.stream_options, { include_usage: true })
      assert.equal(request.tools, undefined)
      assert.equal(request.response_format, undefined)
      return streamingResponse([wire.subarray(0, split), wire.subarray(split)])
    }
    assert.deepEqual(await review(evidence, streamConfig(), signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS,
      onUsage: (usage) => observed.push(usage) }), { safe: false, desc, usage: { cost: 0 } })
    assert.equal(calls, 1)
    assert.deepEqual(observed, [{ cost: 0 }])
  }
  const fetcher: typeof fetch = async () => streamingResponse(Array.from(wire, (byte) => Uint8Array.of(byte)))
  assert.equal((await review(evidence, streamConfig(), signal(), { fetcher })).desc, desc)
})

test("a rejected stream is drained only under the original deadline", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>, calls = 0, canceled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { writer = value }, cancel() { canceled = true },
  }), { headers: { "Content-Type": "text/event-stream" } })
  writer.enqueue(Buffer.from(event(chunk('{"safe":true,"desc":"old"}')) + event(chunk("", "length"))))
  await assert.rejects(review(evidence, { ...streamConfig(), timeoutMs: 30 }, signal(), { fetcher: async () => { calls++; return response } }), /timed out/)
  assert.equal(calls, 1); assert.equal(canceled, true)
  assert.equal(response.body!.locked, false)
})

test("draining rejected metadata never turns refusals or resource failures into retriable results", async () => {
  const prefix = Buffer.from(event(chunk('{"safe":true,"desc":"preview"}')) + event(chunk("", "length")))
  for (const suffix of [Buffer.from(event(chunk("", "content_filter"))),
    Buffer.from(event({ choices: [{ index: 0, delta: { refusal: "PRIVATE" }, finish_reason: "stop" }] })),
    Buffer.from([0xff]), Buffer.from(":" + "x".repeat(65536))]) {
    let calls = 0
    await assert.rejects(review(evidence, streamConfig(), signal(), { fetcher: async () => {
      calls++
      return streamingResponse([prefix, suffix])
    } }), error => error instanceof Error && !error.message.includes("PRIVATE"))
    assert.equal(calls, 1)
  }
})

test("previews precede completion while stop, final cumulative usage, DONE and EOF are all consumed", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller } })
  const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } })
  const previews: ReviewProgress[] = [], observed: Usage[] = []
  let completed = false
  const promise = review(evidence, streamConfig(), signal(), { fetcher: async () => response, environment: {}, prompts: BUILTIN_PROMPTS,
    onUsage: (usage) => observed.push(usage), onProgress: (progress) => previews.push(progress) }).then((result) => { completed = true; return result })
  writer.enqueue(Buffer.from(event({ ...chunk(), choices: [{ index: 0, delta: { role: "assistant", reasoning: "PRIVATE REASONING", reasoning_content: "PRIVATE" }, finish_reason: null }] })
    + event(chunk('{"safe":true'))))
  await sleep(0)
  assert.equal(previews.some((progress) => progress.preview?.safe !== undefined), false)
  writer.enqueue(Buffer.from(event(chunk(',"desc":"Visible'))))
  await sleep(0)
  assert.deepEqual(previews.at(-1), { attempt: 0, phase: "streaming", preview: { safe: true, desc: "Visible" } })
  assert.equal(completed, false)
  writer.enqueue(Buffer.from(event(chunk(' effects."}', "stop"))))
  await sleep(0)
  assert.equal(completed, false, "a brace and stop are not transport completion")
  writer.enqueue(Buffer.from(event({ ...chunk("", "stop"), usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.02 } })
    + event({ ...chunk("", "stop"), usage: { cost: 0.01 } })
    + event({ choices: [], usage: { cost: 0.01 } }) + done))
  await sleep(0)
  assert.equal(completed, false, "consume through EOF to reject trailing data")
  writer.close()
  assert.deepEqual(await promise, { safe: true, desc: "Visible effects.", usage: { input: 10, output: 2, cost: 0.01 } })
  assert.deepEqual(observed, [{ input: 10, output: 2, cost: 0.01 }])
  assert.equal(body.locked, false)
  assert.deepEqual(previews[0], { attempt: 0, phase: "evaluating" })
  assert.doesNotMatch(JSON.stringify(previews), /PRIVATE/)
})

test("only final assessment-format errors correct, with reset progress and fresh per-attempt accounting", async () => {
  for (const stream of [false, true]) {
    const bad = '{"safe":true,"desc":"provisional","s\\u0061fe":false}'
    const progress: ReviewProgress[] = [], observed: Usage[] = []
    let calls = 0
    const fetcher: typeof fetch = async (_, init) => {
      const index = calls++
      if (index) {
        assert.deepEqual(progress.at(-1), { attempt: 1, phase: "retrying" })
        assert.equal(observed.length, 1)
        const request = JSON.parse(init!.body as string)
        assert.equal(request.messages[2].content, bad)
        assert.match(request.messages[3].content, /Duplicate assessment field/)
      }
      const content = index ? '{"desc":"Corrected.","safe":false}' : bad
      return stream ? streamText(event(chunk(content.slice(0, 25))) + event(chunk(content.slice(25), "stop")) + event({ choices: [], usage: { cost: 0.01 } }) + done)
        : new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.01 } }))
    }
    const result = await review(evidence, { ...streamConfig(), stream }, signal(), { fetcher, environment: {}, prompts: BUILTIN_PROMPTS,
      onUsage: (usage) => observed.push(usage), onProgress: (value) => progress.push(value) })
    assert.deepEqual(result, { safe: false, desc: "Corrected.", usage: { cost: 0.02 } })
    assert.equal(calls, 2)
    assert.deepEqual(observed, [{ cost: 0.01 }, { cost: 0.01 }])
    assert.ok(progress.some((value) => value.attempt === 1 && value.phase === "retrying" && value.preview === undefined))
    if (stream) assert.ok(progress.some((value) => value.attempt === 0 && value.preview?.safe === true))
  }
})

test("rejected SSE metadata retries boundedly; refusals, tool calls and API errors stay terminal", async (t) => {
  const valid = chunk('{"safe":true,"desc":"x"}')
  const withChoice = (fields: Record<string, unknown>) => event({ ...valid, choices: [{ ...valid.choices[0], ...fields }] })
  const withDelta = (fields: Record<string, unknown>) => withChoice({ delta: { ...valid.choices[0]!.delta, ...fields } })
  const cases: [string, string][] = [
    ["invalid JSON", event("not JSON")], ["null", event("null")], ["array", event("[]")],
    ["error", event({ error: { message: "PRIVATE ERROR" }, usage: { cost: 0.02 } })],
    ["error event", "event: error\n" + event({ error: "PRIVATE ERROR", usage: { cost: 0.02 } })],
    ["named event", "event: unsupported\n" + event(valid)],
    ["missing choices", event({})], ["multiple choices", event({ choices: [valid.choices[0], valid.choices[0]] })],
    ["non-accounting empty choices", event({ choices: [] })],
    ["missing index", withChoice({ index: undefined })], ["wrong index", withChoice({ index: 1 })],
    ["string index", withChoice({ index: "0" })], ["null choice", event({ choices: [null] })],
    ["message instead of delta", withChoice({ message: { content: "PRIVATE" } })],
    ["null delta", withChoice({ delta: null })], ["missing delta", withChoice({ delta: undefined })],
    ["wrong role", withDelta({ role: "user" })], ["null role", withDelta({ role: null })],
    ["object content", withDelta({ content: {} })], ["array content", withDelta({ content: [] })],
    ["legacy call", withDelta({ function_call: {} })], ["tool calls", withDelta({ tool_calls: [{ id: "call" }] })],
    ["bad calls", withDelta({ tool_calls: "" })], ["refusal", withDelta({ refusal: "PRIVATE" })],
    ["bad refusal", withDelta({ refusal: false })], ["length", withChoice({ finish_reason: "length" })],
    ["filter", withChoice({ finish_reason: "content_filter" })], ["tool finish", withChoice({ finish_reason: "tool_calls" })],
    ["empty finish", withChoice({ finish_reason: "" })], ["wrong object", event({ ...valid, object: "chat.completion" })],
    ["changed ID", event(valid) + event({ ...valid, id: "different" })],
    ["changed model", event(valid) + event({ ...valid, model: "different" })],
    ["invalid ID", event({ ...valid, id: 1 })],
    ["content after stop", event(chunk("", "stop")) + event(chunk("late", "stop"))],
    ["reasoning after stop", event(chunk("", "stop")) + withDelta({ content: "", reasoning_content: "late" })],
    ["contradictory stop", event(chunk("", "stop")) + event(chunk("", "length"))],
    ["continuation after stop", event(chunk("", "stop")) + event(chunk("", null))],
    ["DONE before stop", done],
    ["data after DONE", event(chunk("", "stop")) + done + event(valid)],
    ["duplicate DONE", event(chunk("", "stop")) + done + done],
  ]
  const terminal = new Set(["invalid JSON", "error", "error event", "wrong role", "null role", "legacy call", "tool calls",
    "bad calls", "refusal", "bad refusal", "filter", "tool finish"])
  for (const [name, text] of cases) await t.test(name, async t => {
    const time = reviewerClock(t), requests: RequestInit[] = []
    const observed: Usage[] = []
    let calls = 0, retries = 0
    const responses: Response[] = []
    const pending = review(evidence, streamConfig(), signal(), { fetcher: async (_, init) => {
      calls++
      requests.push(init!)
      const response = streamText(event({ choices: [], usage: { cost: 0.01 } }) + text + done)
      responses.push(response)
      return response
    }, environment: {}, prompts: BUILTIN_PROMPTS,
      onUsage: (usage) => observed.push(usage), onRetry: () => { retries++ } })
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /PRIVATE|format invalid/)
      return true
    })
    await settle()
    if (!terminal.has(name)) for (const [index, duration] of [250, 500].entries()) {
      assert.equal(time.sleep.mock.callCount(), index + 1)
      assert.equal(time.sleep.mock.calls[index]!.arguments[0], duration)
      time.advance(duration - 1)
      await settle()
      assert.equal(calls, index + 1, "no POST before the production backoff boundary")
      assert.equal(retries, index)
      time.advance(1)
      await settle()
      assert.equal(calls, index + 2)
      assert.equal(retries, index + 1)
    }
    await rejected
    assert.equal(calls, terminal.has(name) ? 1 : 3)
    assert.equal(retries, calls - 1)
    assert.equal(time.sleep.mock.callCount(), calls - 1)
    assert.ok(requests.every(request => request.method === "POST" && request.body === requests[0]!.body))
    assert.ok(responses.every(response => !response.body!.locked))
    assert.deepEqual(observed, Array.from({ length: calls }, () => ({ cost: name.startsWith("error") ? 0.02 : 0.01 })))
  })
})

test("missing completion markers retry while incomplete SSE framing remains terminal", async t => {
  const cases = [
    event(chunk('{"safe":true,"desc":"x"}')),
    event(chunk('{"safe":true,"desc":"x"}', "stop")),
    event(chunk('{"safe":true,"desc":"x"}', "stop")) + "data: [DONE]\n",
    event(chunk('{"safe":true,"desc":"x"}', "stop")) + done + "data: trailing",
    event(chunk("invalid JSON", "stop")),
  ]
  for (const [index, text] of cases.entries()) await t.test(`framing case ${index}`, async t => {
    const time = reviewerClock(t), requests: RequestInit[] = []
    let calls = 0, retries = 0
    const pending = review(evidence, streamConfig(), signal(), { fetcher: async (_, init) => {
      calls++; requests.push(init!); return streamText(text)
    }, onRetry: () => { retries++ } })
    const rejected = assert.rejects(pending, /ended/)
    await settle()
    if ([0, 1, 4].includes(index)) for (const [retry, duration] of [250, 500].entries()) {
      assert.equal(time.sleep.mock.callCount(), retry + 1)
      assert.equal(time.sleep.mock.calls[retry]!.arguments[0], duration)
      time.advance(duration - 1)
      await settle()
      assert.equal(calls, retry + 1, "incomplete completion markers cannot bypass backoff")
      assert.equal(retries, retry)
      time.advance(1)
      await settle()
      assert.equal(calls, retry + 2)
      assert.equal(retries, retry + 1)
    }
    await rejected
    assert.equal(calls, [0, 1, 4].includes(index) ? 3 : 1, "unfinished records cannot be treated as completed assessment frames")
    assert.equal(retries, calls - 1)
    assert.equal(time.sleep.mock.callCount(), calls - 1)
    assert.ok(requests.every(request => request.method === "POST" && request.body === requests[0]!.body))
  })
})

test("decoded usage survives later UTF-8, API JSON, assessment-limit and framing-limit failures", async () => {
  const usage = Buffer.from(event({ choices: [], usage: { cost: 0.01 } }))
  const assessmentLimit = Array.from({ length: 3 }, () => event(chunk("x".repeat(30000)))).join("")
  const failures = [Buffer.from([0xff]), Buffer.from([0xe2]), Buffer.from(event("{")),
    Buffer.from(assessmentLimit), Buffer.from(":" + "x".repeat(65536)),
    Buffer.from(event({ ...chunk(), choices: [{ index: 0, delta: { reasoning: "x".repeat(65536) } }] })),
    Buffer.from("\n".repeat(65536)),
    Buffer.from((":" + "x".repeat(1021) + "\n\n").repeat(4096)),
  ]
  for (const bytes of failures) {
    const observed: Usage[] = []
    let calls = 0
    const response = streamingResponse([Buffer.concat([usage, bytes])])
    await assert.rejects(review(evidence, streamConfig(), signal(), { fetcher: async () => { calls++; return response }, environment: {}, prompts: BUILTIN_PROMPTS,
      onUsage: (value) => observed.push(value) }))
    assert.equal(calls, 1)
    assert.deepEqual(observed, [{ cost: 0.01 }])
    assert.equal(response.body!.locked, false)
  }
})

test("stream progress observer mutations and exceptions cannot change assessment or accounting", async () => {
  const text = event(chunk('{"safe":false,"desc":"Visible."}', "stop")) + event({ choices: [], usage: { cost: 0.01 } }) + done
  let progressCalls = 0
  const result = await review(evidence, streamConfig(), signal(), { fetcher: async () => streamText(text), environment: {}, prompts: BUILTIN_PROMPTS,
    onUsage: () => { throw new Error("accounting observer") }, onProgress: (value) => {
      progressCalls++
      if (value.preview) { value.preview.safe = true; value.preview.desc = "mutated" }
      throw new Error("progress observer")
    } })
  assert.deepEqual(result, { safe: false, desc: "Visible.", usage: { cost: 0.01 } })
  assert.ok(progressCalls >= 2)
})

test("asynchronous progress and usage rejections cannot escape review", async () => {
  for (const stream of [false, true]) {
    const content = '{"safe":false,"desc":"Visible."}'
    const response = stream ? streamText(event(chunk(content, "stop")) + event({ choices: [], usage: { cost: 0.01 } }) + done)
      : new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.01 } }))
    let usageCalls = 0, progressCalls = 0
    const result = await review(evidence, { ...streamConfig(), stream }, signal(), { fetcher: async () => response, environment: {}, prompts: BUILTIN_PROMPTS,
      onUsage: async () => { usageCalls++; await sleep(0); throw new Error("accounting observer") },
      onProgress: async () => { progressCalls++; await sleep(0); throw new Error("progress observer") } })
    assert.deepEqual(result, { safe: false, desc: "Visible.", usage: { cost: 0.01 } })
    await sleep(10) // Let late observer rejection surface to node:test if not owned.
    assert.equal(usageCalls, 1)
    assert.ok(progressCalls >= (stream ? 2 : 1))
  }
})

test("aborting pending reads ignores fetcher signal cooperation and hanging cancel promises", { timeout: 3000 }, async () => {
  for (const stream of [false, true]) for (const atEOF of [false, true]) {
    const controller = new AbortController()
    const observed: Usage[] = []
    let cancelCalls = 0, calls = 0
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const body = new ReadableStream<Uint8Array>({
      start(writer) {
        if (stream) writer.enqueue(Buffer.from(event({ choices: [], usage: { cost: 0.01 } })))
      },
      pull(writer) {
        started()
        if (atEOF) { writer.close(); controller.abort() }
      },
      cancel() { cancelCalls++; return new Promise(() => {}) },
    }, { highWaterMark: 0 }) // Pull only when the dispatched request's reader asks for data.
    const response = new Response(body, { headers: { "Content-Type": stream ? "text/event-stream" : "application/json" } })
    const promise = review(evidence, { ...streamConfig(), stream }, controller.signal, { fetcher: async () => { calls++; return response }, environment: {}, prompts: BUILTIN_PROMPTS,
      onUsage: (usage) => observed.push(usage) })
    // Start the rejection observer before inducing abort (or awaiting a pull that aborts at EOF).
    const rejected = assert.rejects(promise, { name: "AbortError" })
    await reading
    if (!atEOF) { await sleep(0); controller.abort() }
    await rejected
    assert.equal(calls, 1)
    assert.equal(body.locked, false)
    assert.ok(cancelCalls <= 1)
    if (stream && !atEOF) assert.deepEqual(observed, [{ cost: 0.01 }])
  }
})

test("aborting noncooperative fetch cancels its late response and never emits late progress", { timeout: 3000 }, async () => {
  const controller = new AbortController()
  let deliver!: (response: Response) => void
  let dispatched!: () => void
  const started = new Promise<void>((resolve) => { dispatched = resolve })
  const progress: ReviewProgress[] = []
  const promise = review(evidence, streamConfig(), controller.signal, { fetcher: () => {
    dispatched()
    return new Promise((resolve) => { deliver = resolve })
  }, environment: {}, prompts: BUILTIN_PROMPTS, onProgress: (value) => progress.push(value) })
  const rejected = assert.rejects(promise, { name: "AbortError" })
  await started
  controller.abort()
  await rejected
  let canceled = false
  deliver(new Response(new ReadableStream({ cancel() { canceled = true } })))
  await sleep(0)
  assert.equal(canceled, true)
  assert.deepEqual(progress, [{ attempt: 0, phase: "evaluating" }])
})

test("stream corrections and keepalives share the original deadline on a real HTTP fixture", async (t) => {
  const timers: ReturnType<typeof setInterval>[] = []
  t.after(() => timers.forEach(clearInterval))
  const { config, requests } = await endpoint(t, (index, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    if (!index) response.end(event(chunk("bad format", "stop")) + done)
    else {
      response.write(": keepalive\n\n")
      timers.push(setInterval(() => response.write(": keepalive\n\n"), 10))
    }
  })
  const progress: ReviewProgress[] = []
  await assert.rejects(withDeadline(signal(), 150, (s) => review(evidence, { ...config, stream: true }, s, { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS,
    onProgress: (value) => progress.push(value) })), /timed out/)
  assert.equal(requests.length, 2)
  assert.deepEqual(progress.filter((value) => value.phase !== "streaming"), [{ attempt: 0, phase: "evaluating" }, { attempt: 1, phase: "retrying" }])
  for (const request of requests) assert.equal(request.body.stream, true)
})

test("stream disconnection preserves decoded usage, sanitizes errors and never retries", async () => {
  let index = 0, calls = 0
  const observed: Usage[] = []
  const body = new ReadableStream<Uint8Array>({ pull(writer) {
    if (!index++) writer.enqueue(Buffer.from(event({ choices: [], usage: { cost: 0.01 } })))
    else writer.error(new Error("PRIVATE TRANSPORT ERROR"))
  } })
  const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } })
  await assert.rejects(review(evidence, streamConfig(), signal(), { fetcher: async () => { calls++; return response }, environment: {}, prompts: BUILTIN_PROMPTS,
    onUsage: (usage) => observed.push(usage) }), { message: "Reviewer response read failed" })
  assert.equal(calls, 1)
  assert.deepEqual(observed, [{ cost: 0.01 }])
  assert.equal(body.locked, false)
})

test("abort at EOF after decoded terminal usage finalizes once and never returns an assessment", async () => {
  const controller = new AbortController()
  const observed: Usage[] = []
  const progress: ReviewProgress[] = []
  let index = 0
  const body = new ReadableStream<Uint8Array>({ pull(writer) {
    if (!index++) writer.enqueue(Buffer.from(event(chunk('{"safe":true,"desc":"x"}', "stop"))
      + event({ choices: [], usage: { cost: 0.01 } }) + done))
    else { writer.close(); controller.abort() }
  } }, { highWaterMark: 0 })
  const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } })
  await assert.rejects(review(evidence, streamConfig(), controller.signal, { fetcher: async () => response, environment: {}, prompts: BUILTIN_PROMPTS,
    onUsage: (usage) => observed.push(usage), onProgress: (value) => progress.push(value) }), { name: "AbortError" })
  assert.deepEqual(observed, [{ cost: 0.01 }])
  assert.equal(body.locked, false)
  assert.equal(progress.filter((value) => value.preview?.desc === "x").length, 1, "only a provisional report was emitted")
})

test("stream MIME mismatch and terminal HTTP errors cancel without waiting for cleanup or making another POST", { timeout: 3000 }, async () => {
  for (const [status, contentType, expected] of [[200, "application/json", /expected an SSE/], [401, "text/event-stream", /HTTP 401/]] as const) {
    let canceled = false, calls = 0
    const body = new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}) } })
    const response = new Response(body, { status, headers: { "Content-Type": contentType } })
    await assert.rejects(review(evidence, streamConfig(), signal(), { fetcher: async () => { calls++; return response } }), expected)
    assert.equal(canceled, true)
    assert.equal(calls, 1)
    assert.equal(body.locked, false)
  }
})

test("real HTTP streaming retains the response model for generic usage-only pricing and full-size assessment", async (t) => {
  const empty = JSON.stringify({ safe: true, desc: "" })
  const desc = "x".repeat(65536 - empty.length)
  const content = JSON.stringify({ safe: true, desc })
  assert.equal(Buffer.byteLength(content), 65536)
  const { config, requests } = await endpoint(t, (_, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" })
    for (let offset = 0; offset < content.length; offset += 16000) response.write(event(chunk(content.slice(offset, offset + 16000))))
    response.write(event(chunk("", "stop")))
    response.end(event({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 99,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 } } }) + done)
  })
  const observed: Usage[] = [], models: string[] = []
  const result = await review(evidence, { ...config, model: "requested-alias", stream: true }, signal(), { fetcher: fetch, environment: {}, prompts: BUILTIN_PROMPTS,
    pricing: (model) => { models.push(model); return { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } }, onUsage: (usage) => observed.push(usage) })
  assert.equal(result.desc, desc)
  assert.equal(result.safe, true)
  assert.ok(Math.abs(result.usage!.cost! - 0.002955) < 1e-12)
  assert.deepEqual(models, ["fixture"])
  assert.deepEqual(observed, [result.usage])
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.body.stream, true)
  assert.equal(requests[0]!.body.model, "requested-alias")
})

test("complete SSE reviews discard stale estimates from report and lifetime but preserve independently reported cost", async (t) => {
  for (const reported of [false, true]) for (const output of [1, 100]) await t.test(`${reported ? "reported" : "estimated"}, final output ${output}`, async (t) => {
    const store = new HistorySQL(new DatabaseSync(":memory:"))
    const observed: Usage[] = []
    t.after(() => store.close())
    const initial = { prompt_tokens: 100, completion_tokens: 1, ...(reported ? { cost: 0.000102 } : {}) }
    const latest = { prompt_tokens: 100, completion_tokens: output, prompt_tokens_details: { cached_tokens: 101 } }
    const wire = event({ ...chunk('{"safe":true,"desc":"Bounded effects."}', "stop"), usage: initial })
      + event({ choices: [], usage: latest }) + event({ choices: [], usage: latest }) + done
    let calls = 0
    const config = { ...streamConfig(), baseURL: reported ? "https://openrouter.ai/api/v1" : "https://generic.test/v1" }
    const result = await review(evidence, config, signal(), { fetcher: async () => { calls++; return streamText(wire) }, environment: {}, prompts: BUILTIN_PROMPTS,
      pricing: () => ({ input: 1, output: 2, cache: { read: 0, write: 0 } }), onUsage: (usage) => {
        observed.push(usage)
      }, observation: { review: "00000000-0000-4000-8000-000000000001", observe: event => {
        if (event.type !== "finalized") return
        store.apply("writer", 1, encodeEvent({ type: "attemptFinalized", at: 1, attempt: event.attempt, usage: event.usage,
          context: { scope: "/fixture", root: "root", session: "root", permission: "permission", review: event.review,
            category: "bash", configuredModel: config.model, provider: config.baseURL } }))
      } } })
    const expected = { input: 100, output, ...(reported ? { cost: 0.000102 } : {}) }
    assert.deepEqual(result, { safe: true, desc: "Bounded effects.", usage: expected })
    assert.equal(usageText(result.usage!), `token: 100 in ${output} out${reported ? "\ncost: $0.0001" : ""}`)
    assert.deepEqual(observed, [expected], "one final accounting observation, not cumulative-frame increments")
    assert.equal(calls, 1)
    const totals = (store.query({ type: "totals" }) as HistoryTotals).totals
    const { activity, ...usageTotals } = totals
    assert.equal(activity.usageRequests, 1)
    assert.equal(activity.reviews, 0)
    assert.deepEqual({ ...usageTotals, since: null }, { requests: 1, tokenRequests: 1, input: 100, output,
      priced: reported ? 1 : 0, cost: reported ? 0.000102 : 0, since: null, safe: 0, unsafe: 0, ratingsSince: null })
    assert.equal(lifetimeCost(totals), reported ? "lifetime: $0.0001" : "lifetime: cost unavailable")
  })
})
