import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import timers, { setImmediate as tick } from "node:timers/promises"
import { readCompanion } from "../src/companion-read.js"
import { withDeadline } from "../src/deadline.js"
import { bindTransportOwnership, TransportOwnership } from "../src/transport-ownership.js"

const busy = () => ({ type: "capacity_busy", message: "Read capacity occupied", data: {} })

function clock(t: TestContext) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const sleep = t.mock.method(timers, "setTimeout")
  return {
    sleep,
    advance(ms: number) { now += ms; t.mock.timers.tick(ms) },
    pause(ms: number) { now += ms },
  }
}

test("only declared capacity rejection retries; null, malformed evidence and other failures do not", async () => {
  for (const value of [null, { request: "invalid" }, { type: "capacity_busy", data: {} }]) {
    let calls = 0
    assert.equal(await readCompanion(new AbortController().signal, async () => { calls++; return value }), value)
    assert.equal(calls, 1)
  }
  for (const error of [Error("capacity_busy"), { type: "rpc.unavailable" }, { type: "scope" },
    { type: "capacity_busy" }, { type: "capacity_busy", data: { invalid: true } }]) {
    let calls = 0
    await assert.rejects(readCompanion(new AbortController().signal, async () => { calls++; throw error }), reason => reason === error)
    assert.equal(calls, 1)
  }
})

test("a retry cannot overlap the physically unsettled rejected RPC and waits for the exact 50 ms boundary", async t => {
  const time = clock(t)
  const abort = new AbortController(), ownership = new TransportOwnership()
  bindTransportOwnership(abort.signal, ownership)
  let reject!: (reason: unknown) => void, calls = 0
  const reading = withDeadline(abort.signal, 1000, signal => readCompanion(signal, () => {
    calls++
    return calls === 1 ? new Promise<string>((_yes, no) => { reject = no }) : Promise.resolve("ready")
  }))
  await tick(); await tick()
  assert.equal(calls, 1)
  let settled = false
  const actual = ownership.settled().then(() => { settled = true })
  await tick(); assert.equal(settled, false)
  reject(busy())
  await tick()
  assert.equal(time.sleep.mock.callCount(), 1)
  assert.equal(time.sleep.mock.calls[0]!.arguments[0], 50)
  time.advance(49); await tick()
  assert.equal(calls, 1)
  time.advance(1); await tick()
  assert.equal(calls, 2)
  assert.equal(await reading, "ready")
  await actual
  assert.equal(calls, 2)
})

for (const stop of ["cancel", "deadline"] as const) test(`capacity wait stops on ${stop} without another dispatch`, async t => {
  const time = clock(t)
  const abort = new AbortController()
  let calls = 0, rejected!: () => void
  const started = new Promise<void>(yes => { rejected = yes })
  const reading = withDeadline(abort.signal, stop === "deadline" ? 20 : 1000, signal => readCompanion(signal, async () => {
    calls++; rejected(); throw busy()
  }))
  const result = assert.rejects(reading, stop === "deadline" ? /timed out/ : /Stop contention/)
  await started; await tick()
  assert.equal(time.sleep.mock.callCount(), 1)
  assert.equal(time.sleep.mock.calls[0]!.arguments[0], stop === "deadline" ? 20 : 50)
  time.advance(stop === "deadline" ? 19 : 49); await tick()
  assert.equal(calls, 1)
  if (stop === "cancel") abort.abort(Error("Stop contention"))
  else time.advance(1)
  await result; await tick()
  time.advance(1000); await tick()
  assert.equal(calls, 1)
})

test("elapsed monotonic budget blocks a retry even before deadline timer delivery", async t => {
  let now = 0, calls = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await assert.rejects(withDeadline(new AbortController().signal, 100, signal => readCompanion(signal, async () => {
    calls++; now = 101; throw busy()
  })), /timed out/)
  assert.equal(calls, 1)
})

test("late 50 ms backoff delivery cannot dispatch after monotonic expiry before the deadline timer runs", async t => {
  const time = clock(t)
  let calls = 0, bounded!: AbortSignal
  const reading = withDeadline(new AbortController().signal, 100, signal => {
    bounded = signal
    return readCompanion(signal, async () => { calls++; throw busy() })
  })
  const rejected = assert.rejects(reading, /timed out/)
  await tick()
  assert.equal(time.sleep.mock.callCount(), 1)
  assert.equal(time.sleep.mock.calls[0]!.arguments[0], 50)
  time.pause(50)
  time.advance(49); await tick()
  assert.equal(bounded.aborted, false)
  assert.equal(calls, 1)
  time.advance(1)
  assert.equal(bounded.aborted, false, "The parent timer has not delivered at mocked timer time 50 ms")
  await rejected
  time.advance(1000); await tick()
  assert.equal(calls, 1)
  assert.equal(time.sleep.mock.callCount(), 1)
})

test("cancellation during a noncooperative RPC retains ownership and its late busy error cannot retry", async t => {
  const time = clock(t)
  const abort = new AbortController(), ownership = new TransportOwnership()
  bindTransportOwnership(abort.signal, ownership)
  let reject!: (reason: unknown) => void, calls = 0
  const reading = withDeadline(abort.signal, 1000, signal => readCompanion(signal, () => {
    calls++; return new Promise<never>((_yes, no) => { reject = no })
  }))
  await tick(); abort.abort(Error("Stop RPC"))
  await assert.rejects(reading, /Stop RPC/)
  let settled = false
  const actual = ownership.settled().then(() => { settled = true })
  await tick(); assert.equal(settled, false)
  reject(busy()); await actual
  time.advance(1000); await tick()
  assert.equal(calls, 1)
  assert.equal(time.sleep.mock.callCount(), 0)
})
