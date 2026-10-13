import { test } from "node:test"
import assert from "node:assert/strict"
import { Agent, createServer, request } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { smokeMetrics } from "../scripts/smoke-runtime.mjs"
import { reviewerAudit, assertReviewerReuse, sendReviewStream } from "../scripts/smoke-reviewer.mjs"

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const close = async (server) => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
const send = (server, agent, url, body, abort = false) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port: server.address().port, path: url, method: "POST", agent,
    headers: { authorization: "PRIVATE-HEADER" } }, (res) => {
    const chunks = []
    res.on("data", (chunk) => { chunks.push(chunk); if (abort) res.destroy() })
    res.once(abort ? "close" : "end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
  req.once("error", reject)
  req.end(body)
})

test("separate origins measure a fresh reviewer connection then warm reuse without content", async () => {
  const handler = async (req, res) => {
    for await (const _ of req) { /* The measurements count bytes without retaining content. */ }
    res.writeHead(200, { "X-Private": "PRIVATE-RESPONSE-HEADER" })
    res.write("é")
    if (req.url === "/PRIVATE-PATH") return
    await sleep(10)
    res.end("done")
  }
  const main = createServer(handler), reviewer = createServer(handler)
  const metrics = smokeMetrics(main, { origin: "main" })
  metrics.attach(reviewer, "reviewer")
  assert.throws(() => metrics.attach(reviewer, "reviewer"), /already attached/)
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  try {
    await Promise.all([listen(main), listen(reviewer)])
    await send(main, agent, "/main/chat/completions", "PRIVATE-BODY")
    await send(reviewer, agent, "/review/chat/completions", "PRIVATE-BODY")
    await send(reviewer, agent, "/review/chat/completions", "PRIVATE-BODY")
    await send(main, agent, "/PRIVATE-PATH", "PRIVATE-BODY", true)
    await sleep(20)
    const report = metrics.snapshot("passed")
    assertReviewerReuse(report)
    assert.equal(report.counts.sockets, 2)
    assert.equal(report.counts.byRole.other.aborted, 1)
    for (const item of report.requests.slice(0, 3)) {
      assert.equal(item.requestBytes, 12)
      assert.equal(item.responseBytes, 6)
      assert.ok(item.headersAtMs >= item.bodyReadAtMs)
      assert.ok(item.firstBodyWriteAtMs >= item.headersAtMs)
      assert.ok(item.finishedAtMs > item.firstBodyWriteAtMs)
    }
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|authorization|127\.0\.0\.1/)
    const warmed = structuredClone(report)
    warmed.requests.find((item) => item.role === "reviewer").socketRequest = 2
    assert.throws(() => assertReviewerReuse(warmed), /first reviewer POST/)
    const reopened = structuredClone(report)
    reopened.requests.filter((item) => item.role === "reviewer")[1].socket = 99
    assert.throws(() => assertReviewerReuse(reopened), /reuses the first/)
  } finally { agent.destroy(); await Promise.all([close(main), close(reviewer)]) }
})

const initial = () => ({ model: "PRIVATE-MODEL", messages: [
  { role: "system", content: "PRIVATE-SYSTEM" },
  { role: "user", content: JSON.stringify({ kind: "shell", permission: { id: "PRIVATE-ID" }, command: "PRIVATE-EVIDENCE" }) },
], max_tokens: 4096, stream: false })
const corrected = (body) => ({ ...structuredClone(body), messages: [...structuredClone(body.messages),
  { role: "assistant", content: "PRIVATE-BAD-RESPONSE" }, { role: "user", content: "Format validation failed: Invalid JSON" }] })

test("payload audit accepts only the supported V2 review categories", () => {
  const request = kind => {
    const body = initial(), evidence = JSON.parse(body.messages[1].content)
    body.messages[1].content = JSON.stringify({ ...evidence, kind })
    return JSON.stringify(body)
  }
  for (const kind of ["shell", "edit", "skill", "external-directory"]) {
    const audit = reviewerAudit()
    audit.request("POST", request(kind))
    audit.verify([kind], 1)
  }
  for (const kind of ["mcp", "custom", "unknown"]) assert.throws(() => reviewerAudit().request("POST", request(kind)))
})

test("payload audit preserves exact correction history and reports cumulative cache usage once per attempt", () => {
  const audit = reviewerAudit(), first = initial()
  const one = audit.request("POST", JSON.stringify(first))
  one.response("PRIVATE-BAD-RESPONSE", true)
  const second = corrected(first)
  const two = audit.request("POST", JSON.stringify(second))
  const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 }, private: "PRIVATE-USAGE" }
  two.usage(usage); two.usage(usage)
  two.response("PRIVATE-GOOD-RESPONSE")
  audit.verify(["shell"], 2)
  const report = audit.snapshot()
  assert.equal(report.verified, true)
  assert.equal(report.posts, 2)
  assert.equal(report.systemGroups, 1)
  assert.equal(report.attempts[0].systemBytes, Buffer.byteLength(first.messages[0].content))
  assert.equal(report.attempts[1].fixtureUsageFrames, 2)
  assert.deepEqual(report.attempts[1].fixtureUsage, { input: 100, output: 20, cacheRead: 40, cacheWrite: 5 })
  assert.ok(report.attempts[1].requestBytes > report.attempts[0].requestBytes)
  assert.equal(report.attempts[1].evidenceBytes, report.attempts[0].evidenceBytes)
  assert.equal(report.attempts[0].fixtureUsage, undefined, "missing cache/usage is unknown, never zero-filled")
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/)
  assert.throws(() => audit.request("POST", JSON.stringify(second)), /duplicate\/speculative POST/)
})

test("payload audit admits only explicitly planned, byte-identical transport retries", () => {
  const audit = reviewerAudit(), body = initial()
  audit.request("POST", JSON.stringify(body)).transportRetry()
  audit.request("POST", JSON.stringify(body)).response("PRIVATE-BAD-RESPONSE", true)
  const correction = corrected(body)
  audit.request("POST", JSON.stringify(correction)).transportRetry()
  audit.request("POST", JSON.stringify(correction)).response("PRIVATE-GOOD-RESPONSE")
  audit.verify(["shell"], 4)
  assert.doesNotMatch(JSON.stringify(audit.snapshot()), /PRIVATE/)
  assert.throws(() => audit.request("POST", JSON.stringify(correction)), /duplicate\/speculative POST/)
  const changed = reviewerAudit()
  changed.request("POST", JSON.stringify(body)).transportRetry()
  assert.throws(() => changed.request("POST", JSON.stringify(corrected(body))), /entire POST byte-for-byte/)
})

test("payload audit rejects altered correction evidence/history, category prefix drift and unplanned counts", () => {
  for (const change of [
    (body) => { body.messages[1].content = body.messages[1].content.replace("PRIVATE-EVIDENCE", "CHANGED") },
    (body) => { body.messages[0].content += "CHANGED" },
    (body) => { body.messages[2].content += "CHANGED" },
    (body) => { body.messages.push({ role: "user", content: "extra" }) },
    (body) => { body.model = "changed" },
  ]) {
    const audit = reviewerAudit(), body = initial()
    audit.request("POST", JSON.stringify(body)).response("PRIVATE-BAD-RESPONSE", true)
    const next = corrected(body)
    change(next)
    assert.throws(() => audit.request("POST", JSON.stringify(next)))
  }
  const audit = reviewerAudit(), body = initial()
  audit.request("POST", JSON.stringify(body))
  const next = initial()
  next.messages[1].content = next.messages[1].content.replace("PRIVATE-ID", "second-id")
  next.messages[0].content = "changed prefix"
  assert.throws(() => audit.request("POST", JSON.stringify(next)), /system prefix/)
  assert.throws(() => audit.verify(["shell"], 2), /one POST per planned attempt/)
  assert.equal(audit.snapshot().verified, false)
})

test("payload audit rejects noncompact JSON, provider extras and incorrect stream usage negotiation", () => {
  assert.throws(() => reviewerAudit().request("GET", "{}"), /attempt POSTs/)
  assert.throws(() => reviewerAudit().request("POST", JSON.stringify(initial(), null, 2)), /compact JSON/)
  const body = initial()
  body.messages[1].content = JSON.stringify(JSON.parse(body.messages[1].content), null, 2)
  assert.throws(() => reviewerAudit().request("POST", JSON.stringify(body)), /compact JSON/)
  assert.throws(() => reviewerAudit().request("POST", JSON.stringify({ ...initial(), tools: [] })))
  assert.throws(() => reviewerAudit({ stream: true }).request("POST", JSON.stringify({ ...initial(), stream: true })))
  const audit = reviewerAudit({ stream: true })
  audit.request("POST", JSON.stringify({ ...initial(), stream: true, stream_options: { include_usage: true } }))
  audit.verify(["shell"], 1)
})

test("SSE fixture sends fragmented multiline events, repeated stop/usage and a terminal marker after the gate", async () => {
  const content = JSON.stringify({ safe: true, desc: 'Café fixture.\nQuoted "text".' })
  const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 } }
  let gate = false, usageFrames = 0, error
  const phases = []
  const server = createServer((req, res) => {
    req.resume()
    void sendReviewStream(res, { content, usage, observation: { usage: () => { usageFrames++ } },
      phase: (event) => phases.push(event), beforeTerminal: async () => { gate = true; assert.equal(res.writableEnded, false) },
    }).catch((cause) => { error = cause; res.destroy() })
  })
  const agent = new Agent({ keepAlive: true })
  try {
    await listen(server)
    const wire = await send(server, agent, "/review/chat/completions", "{}")
    assert.equal(error, undefined)
    assert.equal(gate, true)
    assert.equal(usageFrames, 2)
    assert.deepEqual(phases, ["sse-first-content-written", "sse-stop-and-usage-written", "sse-terminal-written"])
    assert.match(wire, /^: fixture keepalive\r\n\r\n/)
    assert.match(wire, /,\r\ndata: "choices":/)
    const events = wire.split("\r\n\r\n").map((event) => event.split("\r\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n")).filter(Boolean)
    assert.equal(events.pop(), "[DONE]")
    const frames = events.map((event) => JSON.parse(event))
    assert.equal(frames.map((frame) => frame.choices[0]?.delta.content ?? "").join(""), content)
    assert.equal(frames.filter((frame) => frame.choices[0]?.finish_reason === "stop").length, 2)
    assert.equal(frames.filter((frame) => frame.usage).length, 2)
    assert.deepEqual(frames.at(-1).usage, usage)
  } finally { agent.destroy(); await close(server) }
})
