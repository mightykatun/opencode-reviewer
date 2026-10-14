import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { parseConfig } from "../src/config.js"
import { review } from "../src/reviewer.js"
import { withDeadline } from "../src/deadline.js"
import { shellEvidence } from "./review-fixtures.js"
import { reviewerClock as clock } from "./reviewer-clock.js"

const evidence = shellEvidence()
const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", timeoutMs: 5000, formatRetries: 0 })
const success = () => Response.json({ choices: [{ message: { content: '{"safe":true,"desc":"Recovered."}' } }] })

for (const kind of ["seconds", "date"]) test(`review POST waits for the exact Retry-After ${kind} boundary`, async t => {
  const time = clock(t), requests: RequestInit[] = []
  const cooldown = kind === "seconds" ? "1" : new Date(Date.now() + 1000).toUTCString()
  let retries = 0
  const pending = review(evidence, config, new AbortController().signal, {
    fetcher: async (_url, init) => {
      requests.push(init!)
      return requests.length === 1 ? new Response(null, { status: 429, headers: { "Retry-After": cooldown } }) : success()
    },
    onRetry: () => { retries++ },
  })
  await settle()
  assert.equal(time.sleep.mock.callCount(), 1)
  time.advance(999)
  await settle()
  assert.equal(requests.length, 1)
  assert.equal(retries, 0)
  time.advance(1)
  await settle()
  assert.equal(requests.length, 2)
  const result = await pending
  assert.equal(result.safe, true)
  assert.equal(result.desc, "Recovered.")
  assert.equal(retries, 1)
  assert.equal(requests[0]!.method, "POST")
  assert.equal(requests[1]!.method, "POST")
  assert.equal(requests[1]!.body, requests[0]!.body)
})

test("review dispatches only two identical extra POSTs at the exponential backoff boundaries", async t => {
  const time = clock(t), requests: RequestInit[] = []
  let retries = 0
  const pending = review(evidence, config, new AbortController().signal, {
    fetcher: async (_url, init) => { requests.push(init!); return new Response(null, { status: 503 }) },
    onRetry: () => { retries++ },
  })
  const rejected = assert.rejects(pending, { message: "Reviewer HTTP 503" })
  await settle()
  for (const [index, duration] of [250, 500].entries()) {
    time.advance(duration - 1)
    await settle()
    assert.equal(requests.length, index + 1)
    time.advance(1)
    await settle()
    assert.equal(requests.length, index + 2)
  }
  await rejected
  time.advance(10000)
  await settle()
  assert.equal(requests.length, 3)
  assert.equal(retries, 2)
  assert.equal(time.sleep.mock.callCount(), 2)
  assert.ok(requests.every(request => request.method === "POST" && request.body === requests[0]!.body))
})

for (const cooldown of [undefined, "1"]) test(`exhausted parent budget prevents a retry POST${cooldown ? " with Retry-After" : ""}`, async t => {
  const time = clock(t)
  let calls = 0, retries = 0
  // Equality is insufficient: backoff plus the useful request window must fit.
  const budget = cooldown ? 1250 : 500
  const pending = withDeadline(new AbortController().signal, budget, bounded => review(evidence, config, bounded, {
    fetcher: async () => {
      calls++
      return new Response(null, { status: 429, headers: cooldown ? { "Retry-After": cooldown } : {} })
    },
    onRetry: () => { retries++ },
  }))
  await assert.rejects(pending, { message: "Reviewer HTTP 429" })
  assert.equal(time.sleep.mock.callCount(), 0)
  time.advance(10000)
  await settle()
  assert.equal(calls, 1)
  assert.equal(retries, 0)
})

for (const remaining of [249, 250, 0]) test(`late backoff delivery with ${remaining} ms remaining never dispatches another POST`, async t => {
  const time = clock(t)
  let calls = 0, retries = 0
  const pending = withDeadline(new AbortController().signal, 1000, bounded => review(evidence, config, bounded, {
    fetcher: async () => { calls++; return new Response(null, { status: 503 }) },
    onRetry: () => { retries++ },
  }))
  const rejected = assert.rejects(pending, remaining ? { message: "Reviewer HTTP 503" } : { name: "DeadlineError" })
  await settle()
  assert.equal(time.sleep.mock.callCount(), 1)
  // The 250 ms sleep finishes after a scheduling pause. Even if the parent
  // timeout callback has not run, the monotonic budget is already consumed.
  time.pause(750 - remaining)
  time.advance(250)
  await rejected
  time.advance(10000)
  await settle()
  assert.equal(calls, 1)
  assert.equal(retries, 0)
})

test("late backoff delivery with 251 ms remaining can dispatch one identical retry POST", async t => {
  const time = clock(t), requests: RequestInit[] = []
  let retries = 0
  const pending = withDeadline(new AbortController().signal, 1000, bounded => review(evidence, config, bounded, {
    fetcher: async (_url, init) => {
      requests.push(init!)
      return requests.length === 1 ? new Response(null, { status: 503 }) : success()
    },
    onRetry: () => { retries++ },
  }))
  await settle()
  assert.equal(time.sleep.mock.callCount(), 1)
  time.pause(499)
  time.advance(249)
  await settle()
  assert.equal(requests.length, 1)
  assert.equal(retries, 0)
  time.advance(1)
  assert.equal((await pending).safe, true)
  assert.equal(requests.length, 2)
  assert.equal(retries, 1)
  assert.ok(requests.every(request => request.method === "POST" && request.body === requests[0]!.body))
})

test("a stalled response is canceled at the exact 50 ms parent deadline without retry", async t => {
  const time = clock(t)
  let calls = 0, retries = 0, canceled = false
  const response = new Response(new ReadableStream({ cancel() { canceled = true } }))
  const pending = withDeadline(new AbortController().signal, 50, bounded => review(evidence, config, bounded, {
    fetcher: async () => { calls++; return response },
    onRetry: () => { retries++ },
  }))
  const rejected = assert.rejects(pending, { name: "DeadlineError", message: "Reviewer response body timed out" })
  await settle()
  time.advance(49)
  await settle()
  assert.equal(calls, 1)
  assert.equal(canceled, false)
  assert.equal(response.body!.locked, true)
  time.advance(1)
  await rejected
  await settle()
  assert.equal(canceled, true)
  assert.equal(response.body!.locked, false)
  assert.equal(calls, 1)
  assert.equal(retries, 0)
  assert.equal(time.sleep.mock.callCount(), 0)
})

test("cancellation during production backoff preserves its reason and prevents another POST", async t => {
  const time = clock(t), abort = new AbortController(), reason = new Error("canceled")
  let calls = 0, retries = 0
  const pending = review(evidence, config, abort.signal, {
    fetcher: async () => { calls++; return new Response(null, { status: 503 }) },
    onRetry: () => { retries++ },
  })
  const rejected = assert.rejects(pending, error => error === reason)
  await settle()
  assert.equal(time.sleep.mock.callCount(), 1)
  time.advance(249)
  await settle()
  abort.abort(reason)
  await rejected
  time.advance(10000)
  await settle()
  assert.equal(calls, 1)
  assert.equal(retries, 0)
})
