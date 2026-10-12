import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import timers, { setImmediate as settle } from "node:timers/promises"
import { parseConfig } from "../src/config.js"
import { review } from "../src/reviewer.js"
import { withDeadline } from "../src/deadline.js"
import type { Evidence } from "../src/types.js"

const evidence: Evidence = { kind: "shell", command: "pwd", cwd: "/fixture", userPrompt: "Show cwd", files: [], limitations: [] }
const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", timeoutMs: 5000, formatRetries: 0 })
const success = () => Response.json({ choices: [{ message: { content: '{"safe":true,"desc":"Recovered."}' } }] })

function clock(t: TestContext) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.method(Math, "random", () => 0)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 8, 12) })
  const sleep = t.mock.method(timers, "setTimeout")
  return {
    sleep,
    advance(ms: number) { now += ms; t.mock.timers.tick(ms) },
    pause(ms: number) { now += ms }, // Spend monotonic budget without delivering timers.
  }
}

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

for (const remaining of [250, 0]) test(`late backoff delivery with ${remaining} ms remaining never dispatches another POST`, async t => {
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
