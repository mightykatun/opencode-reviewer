import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { diagnosticAttempt, emitDiagnostic, type DiagnosticEvent, type DiagnosticObserver } from "../src/diagnostics.js"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import { shellEvidence } from "./review-fixtures.js"

const evidence = shellEvidence({ command: "PRIVATE_COMMAND", cwd: "/private/path", userPrompt: "PRIVATE_PROMPT",
  files: [{ filename: "private.py", contents: "PRIVATE_SOURCE", status: "captured" }] })
const config = (stream: boolean) => parseConfig({ baseURL: "http://private.invalid/v1", model: "PRIVATE_MODEL", apiKey: "PRIVATE_KEY", stream })
const frame = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "PRIVATE_NATIVE_ID", model: "PRIVATE_MODEL",
  choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`
const finish = frame("", "stop") + "data: [DONE]\n\n"
const response = (content: string) => Response.json({ model: "PRIVATE_MODEL", choices: [{ message: { content } }] }, { headers: { "x-private": "PRIVATE_HEADER" } })
const safe = { safe: true, desc: "PRIVATE_DESCRIPTION" }

function assertNumeric(events: readonly DiagnosticEvent[]) {
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.ok(Object.isFrozen(event))
    for (const [key, value] of Object.entries(event)) {
      assert.ok(["phase", "at", "duration", "review", "attempt", "call"].includes(key))
      if (key === "phase") continue
      assert.equal(typeof value, "number")
      assert.ok(Number.isFinite(value) && value >= 0)
      if (["review", "attempt", "call"].includes(key)) assert.ok(Number.isSafeInteger(value))
    }
  }
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|private\.invalid|private\/path|private\.py/)
  for (let i = 1; i < events.length; i++) assert.ok(events[i]!.at >= events[i - 1]!.at)
}

for (const stream of [false, true]) test(`${stream ? "streaming" : "non-streaming"} attempt diagnostics are ordered, numeric and absent from the wire`, async () => {
  const events: DiagnosticEvent[] = [], bodies: string[] = []
  const fetcher: typeof fetch = async (_, init) => {
    bodies.push(String(init?.body))
    return stream ? new Response(frame('{"safe":true,') + frame('"desc":"PRIVATE_DESCRIPTION"}') + finish,
      { headers: { "Content-Type": "text/event-stream", "x-private": "PRIVATE_HEADER" } }) : response(JSON.stringify(safe))
  }
  const args = [evidence, config(stream), new AbortController().signal] as const
  const measuredResult = await review(...args, { fetcher, environment: {}, onDiagnostics: (event) => { events.push(event) } })
  const plainResult = await review(...args, { fetcher })
  const { metadata: measuredMetadata, ...measuredAssessment } = measuredResult
  const { metadata: plainMetadata, ...plainAssessment } = plainResult
  assert.deepEqual(measuredAssessment, safe)
  assert.deepEqual(measuredAssessment, plainAssessment)
  assert.notEqual(measuredMetadata?.review, plainMetadata?.review)
  assert.equal(measuredMetadata?.reportedModel, "PRIVATE_MODEL")
  assert.equal(bodies[0], bodies[1])
  assert.deepEqual(events.map((event) => event.phase), ["dispatch", "headers", "first-content", "first-rating", "final-validation"])
  assert.ok(events.every((event) => event.attempt === 0 && event.review === undefined && event.call === undefined))
  assert.equal(events[0]!.duration, 0)
  for (const event of events) assert.ok(Math.abs(event.duration - (event.at - events[0]!.at)) < 0.01)
  assertNumeric(events)
})

test("first content/rating are observed before terminal validation, once per attempt", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder(), events: DiagnosticEvent[] = []
  const run = review(evidence, config(true), new AbortController().signal, { fetcher: async () => new Response(new ReadableStream({
    start(controller) { writer = controller },
  }), { headers: { "Content-Type": "text/event-stream" } }), environment: {}, onDiagnostics: (event) => { events.push(event) } })
  await settle()
  const send = (text: string) => writer.enqueue(encoder.encode(text))
  send(": keepalive\n\n")
  await settle()
  assert.deepEqual(events.map((event) => event.phase), ["dispatch", "headers"])
  send(frame('{"safe":true,'))
  await settle()
  assert.deepEqual(events.map((event) => event.phase), ["dispatch", "headers", "first-content", "first-rating"])
  send(frame('"desc":"PRIVATE_DESCRIPTION"}'))
  send(frame("", "stop"))
  await settle()
  assert.equal(events.length, 4, "full JSON and stop metadata do not mean final validation")
  send("data: [DONE]\n\n")
  writer.close()
  await run
  assert.equal(events.at(-1)!.phase, "final-validation")
  assertNumeric(events)
})

test("correction attempts emit separate ordinals and dispatch-relative clocks", async () => {
  const events: DiagnosticEvent[] = []
  let calls = 0
  const result = await review(evidence, config(true), new AbortController().signal, { fetcher: async () => {
    const content = ++calls === 1 ? '{"safe":true,"desc":"PRIVATE_DESCRIPTION","extra":1}' : JSON.stringify(safe)
    return new Response(frame(content.slice(0, 13)) + frame(content.slice(13)) + finish, { headers: { "Content-Type": "text/event-stream" } })
  }, environment: {}, onDiagnostics: (event) => { events.push(event) } })
  assert.deepEqual(result, { ...safe, metadata: result.metadata })
  assert.equal(calls, 2)
  for (const attempt of [0, 1]) {
    const group = events.filter((event) => event.attempt === attempt)
    assert.deepEqual(group.map((event) => event.phase), ["dispatch", "headers", "first-content", "first-rating", "final-validation"])
    assert.ok(group.every((event) => event.review === undefined && event.call === undefined))
    assert.equal(group[0]!.duration, 0)
    for (const event of group) assert.ok(Math.abs(event.duration - (event.at - group[0]!.at)) < 0.01)
  }
  assertNumeric(events)
})

for (const kind of ["throw", "reject", "mutate"] as const) test(`observer ${kind} cannot affect review or cause an extra POST`, async () => {
  const observer: DiagnosticObserver = kind === "reject" ? async () => { throw new Error("PRIVATE_OBSERVER_ERROR") }
    : kind === "throw" ? () => { throw new Error("PRIVATE_OBSERVER_ERROR") }
    : (event) => { (event as { at: number }).at = -1 }
  let calls = 0
  const result = await review(evidence, config(true), new AbortController().signal, { fetcher: async () => {
    calls++
    return new Response(frame(JSON.stringify(safe)) + finish, { headers: { "Content-Type": "text/event-stream" } })
  }, environment: {}, onDiagnostics: observer })
  await settle() // Rejected asynchronous observers must also be consumed.
  assert.deepEqual(result, { ...safe, metadata: result.metadata })
  assert.equal(calls, 1)
})

test("attempt phases deduplicate independently and measure from each dispatch", t => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const events: DiagnosticEvent[] = []
  const observer: DiagnosticObserver = event => { events.push(event) }
  const first = diagnosticAttempt(observer, 0)
  now = 50
  for (const phase of ["headers", "first-content", "first-rating", "final-validation"] as const) {
    first(phase); first(phase)
  }
  const second = diagnosticAttempt(observer, 1)
  now = 100
  second("headers"); second("headers")
  assert.deepEqual(events.map(event => [event.phase, event.attempt, event.at, event.duration]), [
    ["dispatch", 0, 0, 0], ["headers", 0, 50, 50], ["first-content", 0, 50, 50],
    ["first-rating", 0, 50, 50], ["final-validation", 0, 50, 50],
    ["dispatch", 1, 50, 0], ["headers", 1, 100, 50],
  ])
  assertNumeric(events)
})

test("emission strips extraneous properties and preserves optional numeric correlations", async () => {
  const events: DiagnosticEvent[] = []
  const extra = { phase: "headers" as const, at: performance.now(), duration: 0, secret: "PRIVATE_DATA" }
  emitDiagnostic((event) => { events.push(event) }, extra)
  const correlated = { ...extra, review: 7, attempt: 1, call: 2 }
  emitDiagnostic((event) => { events.push(event) }, correlated)
  assert.deepEqual(events, [
    { phase: extra.phase, at: extra.at, duration: 0 },
    { phase: extra.phase, at: extra.at, duration: 0, review: 7, attempt: 1, call: 2 },
  ])
  assert.equal(Object.isFrozen(extra), false, "emission freezes a copy, not the caller's event")
  for (const observer of [() => { throw new Error("PRIVATE_OBSERVER_ERROR") },
    async () => { throw new Error("PRIVATE_OBSERVER_ERROR") }]) {
    assert.doesNotThrow(() => emitDiagnostic(observer, correlated))
  }
  await settle()
  assertNumeric(events)
})

test("abort and failed transport never invent final validation or leak private errors", async () => {
  const events: DiagnosticEvent[] = []
  const abort = new AbortController()
  let calls = 0
  const run = review(evidence, config(true), abort.signal, { fetcher: async () => {
    calls++
    return new Response(new ReadableStream({ start(writer) { writer.enqueue(new TextEncoder().encode(frame('{"safe":true,'))) } }),
      { headers: { "Content-Type": "text/event-stream" } })
  }, environment: {}, onDiagnostics: (event) => { events.push(event) } })
  await settle()
  abort.abort(new Error("PRIVATE_ABORT_REASON"))
  await assert.rejects(run)
  assert.equal(calls, 1)
  assert.deepEqual(events.map((event) => event.phase), ["dispatch", "headers", "first-content", "first-rating"])
  const before = events.length
  await assert.rejects(review(evidence, config(true), abort.signal, { fetcher: async () => { throw new Error("unreachable") },
    environment: {}, onDiagnostics: (event) => { events.push(event) } }))
  assert.equal(events.length, before)
  await assert.rejects(review(evidence, config(false), new AbortController().signal, { fetcher: async () => { throw new Error("PRIVATE_NETWORK_ERROR") },
    environment: {}, onDiagnostics: (event) => { events.push(event) } }), /Reviewer network request failed/)
  assert.equal(events.at(-1)!.phase, "dispatch")
  assertNumeric(events)
})
