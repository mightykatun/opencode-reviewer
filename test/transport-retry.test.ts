import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import timers, { setImmediate as settle } from "node:timers/promises"
import { httpFailure, networkFailure, retryAfter, TransportRetries } from "../src/transport-retry.js"
import { withDeadline } from "../src/deadline.js"

function clock(t: TestContext, jitter = 0) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.method(Math, "random", () => jitter)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 8, 12) })
  const sleep = t.mock.method(timers, "setTimeout")
  return { sleep, advance(ms: number) { now += ms; t.mock.timers.tick(ms) } }
}

test("Retry-After accepts seconds and HTTP dates without treating malformed delays as dates", () => {
  const now = Date.UTC(2026, 9, 8, 12)
  for (const [value, expected] of [[null, 0], ["0", 0], [" 2 ", 2000], ["Thu, 08 Oct 2026 12:00:02 GMT", 2000],
    ["Thursday, 08-Oct-26 12:00:02 GMT", 2000], ["Thu Oct  8 12:00:02 2026", 2000],
    ["Thu, 08 Oct 2026 11:00:00 GMT", 0], ["garbage", 0], ["-1", 0], ["1.5", 0], ["1e3", 0], ["2026", 2026000]] as const) {
    assert.equal(retryAfter(value, now), expected, String(value))
  }
  assert.equal(retryAfter("9".repeat(400), now), Infinity, "huge valid cooldowns must not become immediate retries")
})

for (const jitter of [0, 0.5, 0.999]) test(`transport retry exact boundaries and shared budget with jitter ${jitter}`, async t => {
  const time = clock(t, jitter)
  const retries = new TransportRetries(), signal = new AbortController().signal
  const transient = networkFailure(new TypeError("PRIVATE", { cause: Object.assign(new Error("PRIVATE"), { code: "ECONNRESET" }) }), "Reviewer network request failed")
  assert.equal(transient.message, "Reviewer network request failed")
  assert.equal(transient.cause, undefined)
  for (let i = 0; i < 2; i++) {
    let done = false
    const wait = retries.wait(transient, signal).then(value => { done = true; return value })
    const duration = Math.ceil(250 * 2 ** i * (1 + jitter))
    time.advance(duration - 1)
    await settle()
    assert.equal(done, false)
    time.advance(1)
    await settle()
    assert.equal(done, true, "the production sleep must settle at the virtual boundary")
    assert.equal(await wait, true)
  }
  assert.equal(await retries.wait(transient, signal), false)
  assert.equal(time.sleep.mock.callCount(), 2)
})

test("terminal transport errors do not sleep, retry or reveal provider details", async t => {
  const time = clock(t)
  const errors = [new TypeError("PRIVATE"), Object.assign(new Error("PRIVATE"), { code: "CERT_HAS_EXPIRED" }),
    { code: "ERR_TLS_CERT_ALTNAME_INVALID", cause: { code: "ECONNRESET" } }, { code: "ENOTFOUND" }, { code: "ABORT_ERR" }]
  const retries = new TransportRetries(), signal = new AbortController().signal
  for (const error of errors) assert.equal(await retries.wait(networkFailure(error, "Reviewer network request failed"), signal), false)
  for (const status of [400, 401, 403, 404, 409, 422, 501, 505]) {
    assert.equal(await retries.wait(httpFailure(new Response(null, { status })), signal), false)
  }
  assert.equal(time.sleep.mock.callCount(), 0)
})

test("provider cooldowns never extend the review or cause an early retry", async t => {
  const time = clock(t)
  for (const value of ["100", "9".repeat(400), new Date(Date.now() + 60000).toUTCString()]) {
    await withDeadline(new AbortController().signal, 1000, async signal => {
      assert.equal(await new TransportRetries().wait(httpFailure(new Response(null, { status: 429, headers: { "Retry-After": value } })), signal), false)
    })
  }
  assert.equal(time.sleep.mock.callCount(), 0)
})

for (const kind of ["seconds", "date"]) test(`Retry-After ${kind} controls the actual production sleep boundary`, async t => {
  const time = clock(t)
  const value = kind === "seconds" ? "1" : new Date(Date.now() + 1000).toUTCString()
  const failure = httpFailure(new Response(null, { status: 429, headers: { "Retry-After": value } }))
  // Time spent cleaning up the failed response counts toward the cooldown.
  time.advance(200)
  let done = false
  const pending = new TransportRetries().wait(failure, new AbortController().signal).then(value => { done = true; return value })
  time.advance(799)
  await settle()
  assert.equal(done, false)
  time.advance(1)
  await settle()
  assert.equal(done, true)
  assert.equal(await pending, true)
  assert.equal(time.sleep.mock.callCount(), 1)
})

test("canceling transport backoff propagates the original reason immediately", async t => {
  const time = clock(t)
  const abort = new AbortController(), reason = new Error("canceled")
  const pending = new TransportRetries().wait(httpFailure(new Response(null, { status: 503 })), abort.signal)
  const rejected = assert.rejects(pending, error => error === reason)
  abort.abort(reason)
  await rejected
  time.advance(10000)
  assert.equal(time.sleep.mock.callCount(), 1)
})
