import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { Controller } from "../src/controller.js"
import { ownedReview } from "../src/review-admission.js"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import { drainHistory } from "../src/history-coordinator.js"
import type { ReviewAttemptEvent } from "../src/types.js"
import { shellEvidence } from "./review-fixtures.js"

const evidence = shellEvidence()
const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", stream: false })
const request = (i: number) => ({ id: `p${String(i).padStart(2, "0")}`, sessionID: "root", action: "shell", resources: ["pwd"],
  source: { assistantID: "assistant", id: "call" } })
const good = JSON.stringify({ choices: [{ message: { content: '{"safe":true,"desc":"Bounded."}' } }] })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function clock(t: TestContext) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  return async (ms: number) => { now += ms; t.mock.timers.tick(ms); await turn() }
}

for (const outcome of ["resolve", "reject"] as const) test(`production admission retains expired fetches through late ${outcome} and response cancellation`, async t => {
  const tick = clock(t)
  const fetches: ReturnType<typeof deferred<Response>>[] = [], cancels: ReturnType<typeof deferred<void>>[] = []
  const signals: AbortSignal[] = [], events: ReviewAttemptEvent[] = []
  let active = 0, maximum = 0
  const controller = new Controller((_request, parent, identify) => ownedReview(parent, 20, async signal => {
    identify()
    // An ordinary async wrapper cannot retain a special promise property.
    // Physical ownership travels with the bounded signal.
    return review(evidence, config, signal, { fetcher: (_url, init) => {
      signals.push(init!.signal as AbortSignal)
      maximum = Math.max(maximum, ++active)
      const pending = deferred<Response>()
      fetches.push(pending)
      return pending.promise.finally(() => { active-- })
    }, observation: { review: "review", observe: event => { events.push(event) } } })
  }), () => {}, { candidate: () => true })
  for (let i = 0; i < 12; i++) controller.asked(request(i))
  await turn()
  assert.equal(fetches.length, 4)
  for (let i = 0; i < 4; i++) await tick(20)
  assert.equal(fetches.length, 4)
  assert.equal(maximum, 4)
  assert.equal(signals.every(signal => signal.aborted), true)
  assert.equal(controller.views.filter(view => view.status === "unavailable").length, 4)
  assert.equal(events.filter(event => event.type === "finalized").length, 4, "usage finalizers do not wait for physical fetch settlement")

  if (outcome === "resolve") {
    for (const pending of fetches) pending.resolve(new Response(new ReadableStream({ cancel() {
      const cancellation = deferred<void>()
      cancels.push(cancellation)
      return cancellation.promise
    } })))
    await turn()
    assert.equal(cancels.length, 4)
    assert.equal(fetches.length, 4, "late headers alone do not release admission")
    cancels[0]!.resolve()
  } else fetches[0]!.reject(new Error("late network failure"))
  await turn()
  assert.equal(fetches.length, 5, "exactly one physically settled attempt releases one slot")
  let closed = false
  const closing = controller.dispose().then(() => { closed = true })
  await turn()
  assert.equal(closed, false)
  for (const pending of fetches) pending.reject(new Error("cleanup"))
  for (const cancellation of cancels) cancellation.reject(new Error("cleanup failure"))
  await closing
  assert.equal(fetches.length, 5, "disposal never starts queued work")
  assert.equal(active, 0)
})

// A deliberately noncooperative reader exposes read and cancellation as separate
// physical promises. Native ReadableStreams usually settle reads synchronously
// during cancel; neither behavior may be assumed of an injected transport.
function heldReader(read: () => Promise<ReadableStreamReadResult<Uint8Array>>, cancel: () => Promise<void>, released: () => void) {
  const response = new Response(null)
  Object.defineProperty(response, "body", { value: { getReader: () => ({ read, cancel, releaseLock: released }) } })
  return response
}

for (const stream of [false, true]) for (const first of ["read", "cancel"] as const) {
  test(`production admission owns both body read and cancel, ${stream ? "SSE" : "JSON"}, ${first} settles first`, async t => {
    const tick = clock(t)
    const reads: ReturnType<typeof deferred<ReadableStreamReadResult<Uint8Array>>>[] = []
    const cancels: ReturnType<typeof deferred<void>>[] = []
    let posts = 0, released = 0
    const controller = new Controller((_request, parent, identify) => ownedReview(parent, 20, async signal => {
      identify()
      return review(evidence, { ...config, stream }, signal, { fetcher: async () => {
        posts++
        const read = deferred<ReadableStreamReadResult<Uint8Array>>(), cancel = deferred<void>()
        reads.push(read); cancels.push(cancel)
        const response = heldReader(() => read.promise, () => cancel.promise, () => { released++ })
        response.headers.set("Content-Type", "text/event-stream")
        return response
      } })
    }), () => {}, { candidate: () => true })
    for (let i = 0; i < 12; i++) controller.asked(request(i))
    await turn()
    assert.equal(posts, 4)
    await tick(20)
    assert.equal(released, 4)
    assert.equal(controller.views.filter(view => view.status === "unavailable").length, 4)
    if (first === "read") reads[0]!.resolve({ done: true, value: undefined })
    else cancels[0]!.resolve()
    await turn()
    assert.equal(posts, 4)
    if (first === "cancel") reads[0]!.resolve({ done: true, value: undefined })
    else cancels[0]!.resolve()
    await turn()
    assert.equal(posts, 5)
    const closing = controller.dispose()
    await turn()
    for (const read of reads) read.resolve({ done: true, value: undefined })
    for (const cancel of cancels) cancel.resolve()
    await closing
    assert.equal(posts, 5)
    assert.equal(released, 5)
  })
}

for (const mode of ["transport", "format"] as const) for (const release of [false, true]) {
  test(`${mode} retry waits for physical cancellation ${release ? "then resumes" : "until the original deadline"}`, async t => {
    const tick = clock(t), cancel = deferred<void>()
    const events: ReviewAttemptEvent[] = []
    let posts = 0, retries = 0, reads = 0, canceled = 0
    const evaluation = ownedReview(new AbortController().signal, 1000, async signal => review(evidence, config, signal, {
      fetcher: async () => {
        if (++posts > 1) return new Response(good)
        if (mode === "transport") return new Response(new ReadableStream({ cancel() { canceled++; return cancel.promise } }), { status: 503 })
        const malformed = JSON.stringify({ choices: [{ message: { content: '{"safe":"yes","desc":"Invalid."}' } }] })
        return heldReader(async () => reads++ ? { done: true, value: undefined } : { done: false, value: Buffer.from(malformed) },
          () => { canceled++; return cancel.promise }, () => {})
      }, onRetry: () => { retries++ }, observation: { review: "review", observe: event => { events.push(event) } },
    }))
    const result = release ? evaluation : assert.rejects(evaluation, /timed out/)
    let settled = false
    void evaluation.settled!.then(() => { settled = true })
    await turn()
    assert.equal(canceled, 1)
    assert.equal(events.filter(event => event.type === "finalized").length, 1)
    await tick(600)
    assert.equal(posts, 1)
    assert.equal(retries, 0)
    if (release) {
      cancel.resolve()
      await turn()
      assert.equal((await evaluation).safe, true)
      assert.equal(posts, 2)
      assert.equal(retries, 1)
    } else {
      await tick(400)
      await result
      assert.equal(posts, 1)
      assert.equal(settled, false, "deadline returns without releasing physical ownership")
      cancel.resolve()
    }
    await evaluation.settled
    assert.equal(events.filter(event => event.type === "finalized").length, posts)
  })
}

test("cancellation before evaluator dispatch sends no POST and releases ownership", async () => {
  const abort = new AbortController()
  let posts = 0
  const evaluation = ownedReview(abort.signal, 1000, async signal => review(evidence, config, signal, {
    fetcher: async () => { posts++; return new Response(good) },
  }))
  abort.abort(new Error("canceled before dispatch"))
  await assert.rejects(evaluation, /canceled before dispatch/)
  await evaluation.settled
  assert.equal(posts, 0)
})

test("abort from the initial progress callback cannot dispatch a POST", async () => {
  const abort = new AbortController()
  let posts = 0
  const evaluation = ownedReview(abort.signal, 1000, async signal => review(evidence, config, signal, {
    fetcher: async () => { posts++; return new Response(good) },
    onProgress: () => abort.abort(new Error("canceled at progress")),
  }))
  await assert.rejects(evaluation, /canceled at progress/)
  await evaluation.settled
  assert.equal(posts, 0)
})

test("nested owned review scopes inherit physical ownership through async wrappers", async t => {
  const tick = clock(t), fetch = deferred<Response>()
  const evaluation = ownedReview(new AbortController().signal, 20, async parent =>
    ownedReview(parent, 20, async signal => review(evidence, config, signal, { fetcher: () => fetch.promise })))
  const rejected = assert.rejects(evaluation, /timed out/)
  let settled = false
  void evaluation.settled!.then(() => { settled = true })
  await turn()
  await tick(20)
  await rejected
  assert.equal(settled, false)
  fetch.reject(new Error("late failure"))
  await evaluation.settled
})

test("native body cancellation retains admission while usage finalization and bounded storage shutdown proceed", async t => {
  const tick = clock(t), cancel = deferred<void>()
  let canceled = 0, posts = 0, storageAt: number | undefined
  const events: ReviewAttemptEvent[] = []
  const controller = new Controller((_request, parent, identify) => ownedReview(parent, 10000, async signal => {
    identify()
    return review(evidence, { ...config, baseURL: "https://openrouter.ai/api/v1", stream: true }, signal, {
      fetcher: async () => {
        posts++
        return new Response(new ReadableStream({
          start(writer) { writer.enqueue(Buffer.from('data: {"choices":[],"usage":{"cost":0.03}}\n\n')) },
          cancel() { canceled++; return cancel.promise },
        }), { headers: { "Content-Type": "text/event-stream" } })
      }, observation: { review: "review", observe: event => { events.push(event) } },
    })
  }), () => {}, { candidate: () => true })
  for (let i = 0; i < 12; i++) controller.asked(request(i))
  await turn()
  assert.equal(posts, 4)
  let closed = false
  const closing = controller.dispose().then(() => { closed = true })
  const draining = drainHistory({ dispose: async abortAt => {
    assert.equal(abortAt, 0)
    storageAt = performance.now()
    const finalized = events.filter(event => event.type === "finalized")
    assert.equal(finalized.length, 4)
    assert.ok(finalized.every(event => event.usage?.cost === 0.03))
  } }, closing, 0)
  await turn()
  assert.equal(canceled, 4)
  assert.equal(closed, false)
  assert.equal(events.filter(event => event.type === "finalized").length, 4)
  await tick(3149)
  assert.equal(storageAt, undefined)
  await tick(1)
  await draining
  assert.equal(storageAt, 3150, "storage retains its 350ms share of the existing 3.5-second shutdown budget")
  assert.equal(closed, false, "bounded shutdown does not falsely settle transport ownership")
  cancel.resolve()
  await closing
  assert.equal(posts, 4)
})
