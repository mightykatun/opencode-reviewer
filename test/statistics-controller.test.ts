import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { StatisticsController, type StatisticsClock } from "../src/statistics-controller.js"
import { empty } from "../src/lifetime.js"
import type { HistoryRead } from "../src/history-store.js"
import type { HistoryResult } from "../src/history-schema.js"
import type { HistoryQuery } from "../src/history-records.js"
import { SessionAncestry, type AncestryReader } from "../src/session-ancestry.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fakeClock() {
  let now = 0
  const pending = new Set<{ at: number; callback: () => void }>()
  const clock: StatisticsClock = { schedule(callback, delay) {
    const timer = { at: now + delay, callback }; pending.add(timer)
    return () => { pending.delete(timer) }
  } }
  return { clock, pending, tick(ms: number) {
    now += ms
    for (const timer of [...pending]) if (timer.at <= now) { pending.delete(timer); timer.callback() }
  }, dequeue() {
    const timer = [...pending][0]!
    assert.ok(timer, "expected a retry callback")
    pending.delete(timer)
    return timer.callback
  } }
}
function fixture(t: any, ancestry: AncestryReader = async session => session === "child" ? "root" : session, clock?: StatisticsClock) {
  const queries: HistoryQuery[] = [], calls: { value: ReturnType<typeof deferred<HistoryResult>>; cleanup: ReturnType<typeof deferred<void>> }[] = []
  const commits = new Set<() => void>(), failures = new Set<() => void>()
  const controller = new StatisticsController("/host", {
    query(query): HistoryRead {
      queries.push(query)
      const value = deferred<HistoryResult>(), cleanup = deferred<void>(); calls.push({ value, cleanup })
      return Object.assign(value.promise, { settled: cleanup.promise })
    },
    onCommit(fn) { commits.add(fn); return () => { commits.delete(fn) } },
    onWriteFailure(fn) { failures.add(fn); return () => { failures.delete(fn) } },
  }, ancestry, () => {}, clock)
  const finish = (index: number, input = 10) => {
    const totals = { ...empty(), requests: 1, tokenRequests: 1, input, output: 2, since: 1 }
    const q = queries[index]!
    calls[index]!.value.resolve({ revision: index, totals,
      ...(q.type === "totals" && q.conversation ? { conversation: { totals, partialHistory: false } } : {}) })
    calls[index]!.cleanup.resolve()
  }
  t.after(async () => { controller.dispose(); calls.forEach((_, i) => finish(i)); await settle() })
  return { controller, state: () => controller.state, calls, queries, finish, fail: () => failures.forEach(fn => fn()), commit: () => commits.forEach(fn => fn()) }
}

test("Conversation resolves descendant ancestry without mode loading; both views share one coalesced snapshot read", async t => {
  const f = fixture(t)
  f.finish(0); await settle()
  const token = f.controller.open("child")
  f.controller.select("conversation"); await settle()
  assert.equal(f.calls.length, 2)
  f.finish(1); await settle()
  assert.deepEqual(f.queries[2], { type: "totals", conversation: { scope: "/host", root: "root" } })
  f.finish(2, 200); await settle()
  assert.equal(f.controller.state.conversation?.totals.input, 200)
  f.controller.select("lifetime"); f.finish(3, 300); await settle()
  assert.equal(f.controller.state.totals?.input, 300)
  assert.equal(f.controller.state.view, "lifetime")
  f.controller.close(token); f.finish(4); await settle()
  assert.equal(f.controller.state.open, false)
})

test("returning from lifetime retains this conversation's report until its refreshed snapshot settles", async t => {
  const f = fixture(t)
  f.finish(0); await settle()
  f.controller.open("child"); f.controller.select("conversation"); await settle()
  f.finish(1); await settle(); f.finish(2, 200); await settle()
  const conversation = f.state().conversation
  assert.equal(conversation?.totals.input, 200)
  f.controller.select("lifetime"); f.finish(3, 300); await settle()
  assert.equal(f.state().totals?.input, 300)
  assert.equal(f.state().conversation, conversation, "Lifetime-only reads must not clear the loaded conversation")
  f.controller.select("conversation")
  assert.equal(f.state().conversation, conversation, "No loading frame while a fresh scoped read is pending")
  assert.deepEqual(f.queries[4], { type: "totals", conversation: { scope: "/host", root: "root" } })
  await settle()
  assert.equal(f.state().conversation, conversation)
  f.finish(4, 400); await settle()
  assert.equal(f.state().conversation?.totals.input, 400)
  f.controller.open("other"); f.controller.select("conversation")
  assert.equal(f.state().conversation, undefined, "A different dialog/session cannot inherit retained totals")
})

test("cached conversation totals never conceal a failed scoped refresh", async t => {
  const f = fixture(t)
  f.finish(0); await settle()
  f.controller.open("root"); f.controller.select("conversation"); await settle()
  f.finish(1); await settle(); f.finish(2, 200); await settle()
  f.controller.select("lifetime"); f.finish(3, 300); await settle()
  f.controller.select("conversation")
  f.calls[4]!.value.reject(Error("storage unavailable")); f.calls[4]!.cleanup.resolve(); await settle()
  assert.equal(f.state().unavailable, true, "A cached report is not proof that storage is healthy")
})

test("old aggregate results and old dialog cleanup cannot replace a newly opened root", async t => {
  const f = fixture(t)
  f.finish(0); await settle()
  const old = f.controller.open("a"); f.controller.select("conversation"); await settle()
  f.finish(1); await settle()
  f.controller.open("b"); f.controller.select("conversation"); f.controller.close(old); await settle()
  f.finish(2, 999); await settle()
  assert.equal(f.controller.state.conversation, undefined)
  assert.equal(f.controller.state.open, true)
  assert.deepEqual(f.queries[3], { type: "totals", conversation: { scope: "/host", root: "b" } })
  f.finish(3, 20); await settle()
  assert.equal(f.state().conversation?.totals.input, 20)
})

test("ancestry failures do not guess a root and home has no fabricated conversation statistics", async t => {
  const f = fixture(t, async () => { throw new Error("unavailable") })
  f.finish(0); await settle()
  f.controller.open("child"); f.controller.select("conversation"); await settle()
  assert.equal(f.controller.state.ancestry, "unavailable")
  assert.equal(f.queries.some(q => q.type === "totals" && q.conversation), false)
  f.controller.open(); f.controller.select("conversation")
  assert.equal(f.controller.state.ancestry, "none"); assert.equal(f.controller.state.conversation, undefined)
})

test("Conversation retries transient ancestry failures every two seconds without reselecting or redoing a settled root", async t => {
  const time = fakeClock(); let count = 0
  const f = fixture(t, async () => { if (++count < 3) throw Error("transient"); return "root" }, time.clock)
  f.finish(0); await settle()
  f.controller.open("child"); f.controller.select("conversation"); await settle()
  assert.equal(f.state().ancestry, "unavailable"); assert.equal(count, 1); assert.equal(time.pending.size, 1)
  for (let i = 0; i < 20; i++) f.controller.select("conversation")
  time.tick(1999); await settle(); assert.equal(count, 1); assert.equal(time.pending.size, 1)
  time.tick(1); await settle(); assert.equal(count, 2); assert.equal(f.state().ancestry, "unavailable")
  assert.equal(time.pending.size, 1)
  time.tick(2000); await settle(); assert.equal(count, 3); assert.equal(f.state().ancestry, "ready")
  assert.equal(time.pending.size, 0)
  f.finish(1); await settle()
  assert.deepEqual(f.queries[2], { type: "totals", conversation: { scope: "/host", root: "root" } })
  f.finish(2, 30); await settle()
  time.tick(20000); f.controller.select("lifetime"); f.controller.select("conversation"); await settle()
  assert.equal(count, 3); assert.equal(f.state().conversation?.totals.input, 30)
})

for (const outcome of ["resolve", "reject"] as const) test(`timed-out noncooperative ancestry starts retry delay only after late ${outcome} and settled ownership end`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const time = fakeClock(), root = deferred<string>(), cleanup = deferred<void>(); let count = 0
  const f = fixture(t, () => ++count === 1 ? Object.assign(root.promise, { settled: cleanup.promise }) : Promise.resolve("root"), time.clock)
  f.finish(0); await settle()
  f.controller.open("child"); f.controller.select("conversation"); await settle()
  t.mock.timers.tick(5000); await settle()
  assert.equal(f.state().ancestry, "unavailable")
  for (let i = 0; i < 20; i++) { f.controller.select("conversation"); time.tick(2000); await settle() }
  assert.equal(count, 1); assert.equal(time.pending.size, 0)
  if (outcome === "resolve") root.resolve("late-root"); else root.reject(Error("late failure"))
  await settle()
  time.tick(2000); await settle(); assert.equal(count, 1); assert.equal(time.pending.size, 0)
  assert.equal(f.state().ancestry, "unavailable")
  cleanup.resolve(); await settle(); assert.equal(time.pending.size, 1)
  time.tick(1999); await settle(); assert.equal(count, 1)
  time.tick(1); await settle(); assert.equal(count, 2); assert.equal(f.state().ancestry, "ready")
  f.finish(1); await settle()
  assert.deepEqual(f.queries[2], { type: "totals", conversation: { scope: "/host", root: "root" } })
  time.tick(20000); await settle(); assert.equal(count, 2)
})

for (const action of ["close", "lifetime", "dispose", "open"] as const) {
  test(`${action} cancels ancestry retry and invalidates even a dequeued callback`, async t => {
    const time = fakeClock(); let count = 0
    const f = fixture(t, async () => { count++; throw Error("transient") }, time.clock)
    f.finish(0); await settle()
    let token = f.controller.open("child"); f.controller.select("conversation"); await settle()
    const dequeued = time.dequeue()
    const stop = () => {
      if (action === "close") f.controller.close(token)
      else if (action === "lifetime") f.controller.select("lifetime")
      else if (action === "dispose") f.controller.dispose()
      else token = f.controller.open("new")
    }
    stop(); dequeued(); time.tick(20000); await settle()
    assert.equal(count, 1); assert.equal(time.pending.size, 0)
    if (action === "dispose") return
    if (action === "close") token = f.controller.open("child")
    f.controller.select("conversation"); await settle()
    assert.equal(count, 2); assert.equal(time.pending.size, 1)
    stop(); assert.equal(time.pending.size, 0)
    time.tick(20000); await settle(); assert.equal(count, 2)
  })
}

for (const action of ["close", "lifetime", "dispose"] as const) {
  test(`${action} prevents retry from being rearmed by late ancestry settlement`, async t => {
    const time = fakeClock(), failure = deferred<string>(), cleanup = deferred<void>(); let count = 0
    const f = fixture(t, () => { count++; return Object.assign(failure.promise, { settled: cleanup.promise }) }, time.clock)
    f.finish(0); await settle()
    const token = f.controller.open("child"); f.controller.select("conversation"); await settle()
    failure.reject(Error("transient")); await settle()
    assert.equal(f.state().ancestry, "unavailable"); assert.equal(time.pending.size, 0)
    if (action === "close") f.controller.close(token)
    else if (action === "lifetime") f.controller.select("lifetime")
    else f.controller.dispose()
    cleanup.resolve(); await settle()
    assert.equal(time.pending.size, 0)
    time.tick(20000); await settle(); assert.equal(count, 1)
    assert.equal(f.queries.some(q => q.type === "totals" && q.conversation), false)
  })
}

test("a new root dominates an old dequeued ancestry retry without another lookup", async t => {
  const time = fakeClock(), sessions: string[] = []
  const f = fixture(t, async session => { sessions.push(session); if (session === "old") throw Error("transient"); return session }, time.clock)
  f.finish(0); await settle()
  const old = f.controller.open("old"); f.controller.select("conversation"); await settle()
  const dequeued = time.dequeue()
  f.controller.open("new"); f.controller.select("conversation"); await settle()
  dequeued(); f.controller.close(old); time.tick(20000); await settle()
  assert.deepEqual(sessions, ["old", "new"]); assert.equal(f.state().ancestry, "ready"); assert.equal(f.state().open, true)
  f.finish(1); await settle()
  assert.deepEqual(f.queries[2], { type: "totals", conversation: { scope: "/host", root: "new" } })
})

test("a new root supersedes a failed ancestry lookup only after its actual settlement", async t => {
  const time = fakeClock(), failure = deferred<string>(), cleanup = deferred<void>(), sessions: string[] = []
  const f = fixture(t, session => {
    sessions.push(session)
    return session === "old" ? Object.assign(failure.promise, { settled: cleanup.promise }) : Promise.resolve(session)
  }, time.clock)
  f.finish(0); await settle()
  f.controller.open("old"); f.controller.select("conversation"); await settle()
  failure.reject(Error("transient")); await settle()
  assert.equal(f.state().ancestry, "unavailable"); assert.equal(time.pending.size, 0)
  for (let i = 0; i < 20; i++) { f.controller.open(`new-${i}`); f.controller.select("conversation") }
  time.tick(20000); await settle(); assert.deepEqual(sessions, ["old"])
  cleanup.resolve(); await settle()
  assert.deepEqual(sessions, ["old", "new-19"]); assert.equal(time.pending.size, 0)
  f.finish(1); await settle()
  assert.deepEqual(f.queries[2], { type: "totals", conversation: { scope: "/host", root: "new-19" } })
})

test("noncooperative ancestry retains one actual lookup through rapid reopen and disposal", async t => {
  const root = deferred<string>(); let count = 0
  const f = fixture(t, async session => { count++; return count === 1 ? root.promise : session })
  f.finish(0); await settle()
  f.controller.open("old"); f.controller.select("conversation"); await settle()
  for (let i = 0; i < 50; i++) { f.controller.open(`root-${i}`); f.controller.select("conversation") }
  await settle(); assert.equal(count, 1)
  root.resolve("old"); await settle(); assert.equal(count, 2)
  f.finish(1); await settle()
  assert.deepEqual(f.queries[2], { type: "totals", conversation: { scope: "/host", root: "root-49" } })
  f.controller.dispose(); f.finish(2, 999); await settle()
  assert.equal(f.controller.state.conversation, undefined)
})

test("write failures and actual read cleanup guard scoped snapshots and recover without resetting stored metrics", async t => {
  const f = fixture(t)
  f.finish(0); await settle()
  f.controller.open("root"); f.controller.select("conversation"); await settle()
  f.finish(1); await settle()
  f.calls[2]!.value.reject(new Error("read expired")); await settle()
  assert.equal(f.controller.state.unavailable, true)
  for (let i = 0; i < 20; i++) { f.commit(); f.controller.select("conversation") }
  assert.equal(f.calls.length, 3)
  f.calls[2]!.cleanup.resolve(); await settle()
  f.fail(); f.finish(3, 999); await settle()
  assert.equal(f.controller.state.unavailable, true); assert.equal(f.controller.state.conversation, undefined)
  f.commit(); f.finish(4, 40); await settle()
  assert.equal(f.controller.state.unavailable, false); assert.equal(f.state().conversation?.totals.input, 40)
})

test("production ancestry composition retains physical ownership through statistics reopen storms", async t => {
  const pending: { id: string; resolve: (v: { id: string }) => void }[] = []
  const ancestry = new SessionAncestry(id => new Promise(resolve => pending.push({ id, resolve })))
  const h = new HistoryCoordinator("/host", { admit: () => true, query: async () => ({}), onCommit: () => () => {} }, (id, signal) => ancestry.root(id, signal))
  const f = fixture(t, (id, signal) => h.root(id, signal))
  try {
    f.finish(0); await settle()
    f.controller.open("old"); f.controller.select("conversation"); await settle()
    for (let n = 0; n < 25; n++) { f.controller.open(`new-${n}`); f.controller.select("conversation"); await settle() }
    assert.equal(pending.length, 1, "deadline wrapper settlement is not actual metadata settlement")
    pending[0]!.resolve({ id: "old" }); await settle()
    assert.deepEqual(pending.map(p => p.id), ["old", "new-24"])
    pending[1]!.resolve({ id: "new-24" }); await settle()
    f.finish(1); await settle()
    assert.deepEqual(f.queries[2], { type: "totals", conversation: { scope: "/host", root: "new-24" } })
  } finally {
    f.controller.dispose(); h.dispose()
    for (const p of pending) p.resolve({ id: p.id })
    await settle()
  }
})

for (const outcome of ["resolve", "reject"] as const) test(`production statistics deadline and disposal retain actual ancestry through late ${outcome}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const actual = deferred<{ id: string }>(), cleanup = deferred<void>(); let calls = 0
  const ancestry = new SessionAncestry(async () => {
    calls++; try { return await actual.promise } finally { await cleanup.promise }
  })
  const h = new HistoryCoordinator("/host", { admit: () => true, query: async () => ({}), onCommit: () => () => {} }, (id, signal) => ancestry.root(id, signal))
  const f = fixture(t, (id, signal) => h.root(id, signal))
  try {
    f.finish(0); await settle(); f.controller.open("old"); f.controller.select("conversation"); await settle()
    t.mock.timers.tick(5000); await settle(); assert.equal(f.state().ancestry, "unavailable")
    for (let n = 0; n < 10; n++) { f.controller.select("conversation"); t.mock.timers.tick(5000); await settle() }
    assert.equal(calls, 1)
    if (outcome === "resolve") actual.resolve({ id: "old" }); else actual.reject(Error("late failure"))
    await settle(); assert.equal(calls, 1)
    f.controller.dispose(); cleanup.resolve(); await settle()
    assert.equal(calls, 1); assert.equal(f.state().conversation, undefined)
    assert.equal(f.queries.some(q => q.type === "totals" && q.conversation), false)
  } finally { f.controller.dispose(); h.dispose(); actual.resolve({ id: "old" }); cleanup.resolve(); await settle() }
})
