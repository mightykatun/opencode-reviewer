import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { ApprovalTransaction } from "../src/approval-transaction.js"
import type { ApprovalFact } from "../src/controller.js"
import type { OnceSubmission } from "../src/host-permissions.js"
import { withDeadline } from "../src/deadline.js"

const request = Object.freeze({ id: "request", sessionID: "session" })
const resolved = Object.freeze({ reason: "permission resolved" })
const once = { requestID: request.id, sessionID: request.sessionID, decision: "once" }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(observe?: (fact: ApprovalFact<typeof request>) => unknown) {
  const parent = new AbortController(), ack = deferred<OnceSubmission>(), preparation = deferred<void>()
  const facts: ApprovalFact<typeof request>[] = []
  const transaction = new ApprovalTransaction(request, "root", "review", true, resolved,
    fact => { facts.push(fact); return observe?.(fact) })
  let signal!: AbortSignal, verification!: AbortSignal, calls = 0, publications = 0
  const policy = {
    guard: () => true,
    dispatch: () => {
      assert.equal(transaction.state, "dispatched")
      assert.equal(facts.length, 0, "the final admission boundary cannot run observers")
    },
    dispatched: () => { publications++; assert.equal(calls, 1) },
    confirming: () => {}, confirmed: () => {},
  }
  const writer = { async once(_request: typeof request, bounded: AbortSignal, dispatch: () => boolean) {
    signal = bounded
    await preparation.promise
    if (!dispatch()) return { status: "unavailable" as const }
    assert.equal(publications, 0, "no publication separates dispatch from actual invocation")
    assert.equal(dispatch(), false, "even a repeated transport callback cannot dispatch again")
    calls++
    return ack.promise
  } }
  return { transaction, parent, ack, preparation, facts, policy, writer, signal: () => signal, verification: () => verification, calls: () => calls,
    start() { return withDeadline(parent.signal, 5000, signal => { verification = signal; return transaction.submit(signal, writer, policy) }) },
    submit(other: Parameters<typeof transaction.submit>[1], checks: Parameters<typeof transaction.submit>[2] = policy) {
      return withDeadline(parent.signal, 5000, signal => { verification = signal; return transaction.submit(signal, other, checks) })
    } }
}

test("native owner: preparing, dispatched, acknowledged and confirmed are distinct; exact ownership and cleanup", async () => {
  const f = fixture()
  assert.equal(f.transaction.state, "preparing")
  assert.equal(f.transaction.resolved(once), false, "an event before our invocation has no attribution")
  const work = f.start(); await settle()
  assert.equal(f.transaction.state, "preparing")
  f.preparation.resolve(); await settle()
  assert.equal(f.transaction.state, "dispatched")
  f.ack.resolve({ status: "submitted" }); await settle()
  assert.equal(f.transaction.state, "acknowledged")
  assert.equal(f.transaction.resolved({ ...once, sessionID: "other" }), false)
  assert.equal(f.transaction.resolved({ ...once, requestID: "other" }), false)
  assert.equal(f.transaction.resolved(once), true)
  await work
  assert.equal(f.transaction.state, "confirmed")
  assert.equal(f.transaction.resolved(once), false)
  f.transaction.finish()
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
  assert.ok(f.facts.every(fact => fact.request === request && fact.review === "review" && fact.automatic
    && fact.approval === f.transaction.approval && fact.result === undefined))
  assert.equal(getEventListeners(f.verification(), "abort").length, 0)
  assert.equal(getEventListeners(f.signal(), "abort").length, 0)
  await assert.rejects(f.start(), /already settled or submitting/)
  assert.equal(f.calls(), 1)
})

test("native owner: early first once survives native-resolution abort but still needs local ACK", async () => {
  const f = fixture()
  f.preparation.resolve()
  const work = f.start(), rejected = assert.rejects(work); await settle()
  assert.equal(f.transaction.resolved(once), true)
  assert.equal(f.transaction.resolved({ ...once, decision: "reject" }), false, "first native resolution owns the decision")
  f.parent.abort(resolved); await rejected; await settle()
  assert.equal(f.signal().aborted, false, "native resolution cannot cancel our already dispatched ACK")
  assert.equal(f.transaction.state, "dispatched")
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched"])
  f.ack.resolve({ status: "submitted" }); await settle()
  assert.equal(f.transaction.state, "confirmed")
})

test("native owner: first non-once cannot be replaced by a later once", async () => {
  const f = fixture()
  f.preparation.resolve()
  const work = f.start(); await settle()
  assert.equal(f.transaction.resolved({ ...once, decision: "reject" }), true)
  assert.equal(f.transaction.resolved(once), false)
  f.ack.resolve({ status: "submitted" })
  await assert.rejects(work, /did not match once/)
  assert.equal(f.transaction.state, "uncertain")
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["dispatched", undefined], ["settled", "uncertain"]])
})

for (const earlyEvent of [false, true]) test(`native owner: timeout seals uncertainty against late ACK/event, early event ${earlyEvent}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture()
  f.preparation.resolve()
  const work = f.start()
  const rejected = assert.rejects(work)
  await settle()
  if (earlyEvent) assert.equal(f.transaction.resolved(once), true)
  t.mock.timers.tick(5000); await rejected; await settle()
  assert.equal(f.transaction.state, "uncertain")
  assert.equal(getEventListeners(f.verification(), "abort").length, 0)
  assert.equal(f.transaction.resolved(once), false)
  f.ack.resolve({ status: "submitted" }); await settle()
  assert.equal(f.transaction.state, "uncertain")
  assert.equal(getEventListeners(f.signal(), "abort").length, 0)
  f.transaction.finish()
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["dispatched", undefined], ["settled", "uncertain"]])
  await assert.rejects(f.start(), /already settled or submitting/)
  assert.equal(f.calls(), 1)
})

test("native owner: cancellation while preparing blocks a late dispatch and removes abort listeners", async () => {
  const f = fixture()
  const work = f.start(), rejected = assert.rejects(work)
  await settle(); f.parent.abort(Error("cancelled")); await rejected
  assert.equal(f.transaction.state, "not-sent")
  f.transaction.finish()
  f.preparation.resolve(); await settle()
  assert.equal(f.calls(), 0)
  assert.equal(getEventListeners(f.verification(), "abort").length, 0)
  assert.equal(getEventListeners(f.signal(), "abort").length, 0)
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"]])
})

test("native owner: unavailable preparation never produces dispatch or automatic attribution", async () => {
  const f = fixture()
  await f.submit({ once: async () => ({ status: "unavailable" }) })
  assert.equal(f.transaction.state, "not-sent")
  assert.equal(f.transaction.dispatched, false)
  assert.equal(f.transaction.resolved(once), false)
  f.transaction.finish()
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"]])
})

test("owner: pre-aborted preparation settles not-sent without calling a writer", async () => {
  const f = fixture()
  f.parent.abort()
  await assert.rejects(f.transaction.submit(f.parent.signal, f.writer, f.policy))
  assert.equal(f.transaction.state, "not-sent")
  f.transaction.finish()
  assert.equal(f.calls(), 0)
  assert.equal(getEventListeners(f.parent.signal, "abort").length, 0)
  assert.equal(f.facts[0]?.result, "not-sent")
})

test("native owner: a read-only guard deferral allows fresh verification but never a second invocation", async () => {
  const f = fixture()
  let eligible = false, calls = 0
  const policy = { ...f.policy, guard: () => eligible, dispatched: undefined }
  const writer = { once: async (_request: typeof request, _signal: AbortSignal, dispatch: () => boolean) => {
    assert.equal(dispatch(), true); calls++; f.transaction.resolved(once); return { status: "submitted" as const }
  } }
  await f.submit(writer, policy)
  assert.equal(f.transaction.state, "preparing")
  assert.equal(getEventListeners(f.verification(), "abort").length, 0)
  eligible = true
  await f.submit(writer, policy)
  assert.equal(f.transaction.state, "confirmed", "native acknowledgement and exact once confirm together")
  await assert.rejects(f.submit(writer, policy))
  assert.equal(calls, 1)
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
})

test("native owner: verification and acknowledgement retain one five-second budget after an early native resolution", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let time = 0
  t.mock.method(performance, "now", () => time)
  const f = fixture(), read = deferred<void>()
  f.preparation.resolve()
  const work = withDeadline(f.parent.signal, 5000, async signal => {
    await read.promise
    await f.transaction.submit(signal, f.writer, f.policy)
  })
  const rejected = assert.rejects(work)
  await settle()
  time = 4000; t.mock.timers.tick(4000); read.resolve(); await settle()
  assert.equal(f.calls(), 1)
  f.transaction.resolved(once); f.parent.abort(resolved); await rejected; await settle()
  assert.equal(f.signal().aborted, false)
  time = 4999; t.mock.timers.tick(999); await settle()
  assert.equal(f.transaction.state, "dispatched")
  time = 5000; t.mock.timers.tick(1); await settle()
  assert.equal(f.transaction.state, "uncertain")
  assert.equal(f.signal().aborted, true)
  f.ack.resolve({ status: "submitted" }); await settle()
  assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, 0)
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["dispatched", undefined], ["settled", "uncertain"]])
})

test("native owner: deletion abort after local ACK cannot be confirmed by a later native event", async () => {
  const f = fixture()
  f.preparation.resolve(); f.ack.resolve({ status: "submitted" })
  const work = f.start(), rejected = assert.rejects(work)
  await settle()
  assert.equal(f.transaction.state, "acknowledged")
  f.transaction.abort(); await rejected
  assert.equal(f.transaction.state, "uncertain")
  assert.equal(f.transaction.resolved(once), false)
  assert.equal(getEventListeners(f.verification(), "abort").length, 0)
  assert.equal(getEventListeners(f.signal(), "abort").length, 0)
  assert.equal(f.facts.at(-1)?.result, "uncertain")
})

for (const failure of ["throw", "reject"] as const) test(`owner: ${failure} from fact observers cannot change approval`, async () => {
  const f = fixture(() => {
    if (failure === "throw") throw Error("observer")
    return Promise.reject(Error("observer"))
  })
  f.preparation.resolve(); f.ack.resolve({ status: "submitted" })
  const work = f.start(); await settle()
  f.transaction.resolved(once); await work; await settle()
  assert.equal(f.transaction.state, "confirmed")
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
})
