import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { SessionAncestry } from "../src/session-ancestry.js"

const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("bounded ancestry resolves all descendants using only session metadata", async () => {
  const calls: string[] = []
  const ancestry = new SessionAncestry(async (id) => {
    calls.push(id)
    return { id, ...(id === "root" ? {} : { parentID: id === "grandchild" ? "child" : "root" }) }
  })
  assert.equal(await ancestry.root("grandchild", signal()), "root")
  assert.deepEqual(calls, ["grandchild", "child", "root"])
  assert.equal(await ancestry.root("child", signal()), "root")
  assert.equal(calls.length, 3)
  ancestry.deleted("root")
  await ancestry.root("child", signal())
  assert.equal(calls.length, 5)
})

test("bounded metadata reads honor parent cancellation", async () => {
  const ancestry = new SessionAncestry(async () => new Promise(() => {}))
  const abort = new AbortController()
  const lookup = ancestry.root("root", abort.signal)
  abort.abort()
  await assert.rejects(lookup)
})

test("noncooperative ancestry reads expire within their five-second budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const ancestry = new SessionAncestry(async () => new Promise(() => {}))
  const lookup = assert.rejects(ancestry.root("root", signal()), /Session ancestry timed out/)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await lookup
})

for (const failure of ["missing", "mismatch", "cycle", "depth", "empty parent"] as const) {
  test(`ancestry ${failure} remains closed`, async () => {
    let calls = 0
    const ancestry = new SessionAncestry(async (id) => {
      calls++
      if (failure === "missing") return undefined
      if (failure === "mismatch") return { id: "wrong" }
      return { id, parentID: failure === "cycle" ? "root" : failure === "empty parent" ? "" : `${id}-next` }
    })
    await assert.rejects(ancestry.root("root", signal()))
    assert.ok(calls <= 17)
  })
}

for (const warm of [undefined, 0, 1, 8, 16]) test(`${warm === undefined ? "cold" : `depth-${warm} warm`} ancestry accepts 16 edges and rejects 17 without caching rejected prefixes`, async () => {
  const calls: string[] = []
  const ancestry = new SessionAncestry(async (id) => {
    calls.push(id)
    const depth = Number(id.slice(1))
    return { id, ...(depth ? { parentID: `s${depth - 1}` } : {}) }
  })
  if (warm !== undefined) assert.equal(await ancestry.root(`s${warm}`, signal()), "s0")
  calls.length = 0
  await assert.rejects(ancestry.root("s17", signal()), /Session ancestry limit reached/)
  assert.ok(calls.length <= 17)
  calls.length = 0
  assert.equal(await ancestry.root("s16", signal()), "s0")
  assert.ok(calls.length <= 17)
  calls.length = 0
  assert.equal(await ancestry.root("s16", signal()), "s0")
  assert.deepEqual(calls, [], "accepted prefixes retain their full cached distances")
  await assert.rejects(ancestry.root("s17", signal()), /Session ancestry limit reached/)
  assert.deepEqual(calls, ["s17"], "an over-depth request must not seed a shortcut")
})

test("incrementally warming descendants cannot extend the ancestry depth limit", async () => {
  let calls = 0
  const ancestry = new SessionAncestry(async (id) => {
    calls++
    const depth = Number(id.slice(1))
    return { id, ...(depth ? { parentID: `s${depth - 1}` } : {}) }
  })
  for (let depth = 0; depth <= 16; depth++) {
    assert.equal(await ancestry.root(`s${depth}`, signal()), "s0")
    assert.equal(calls, depth + 1, "each new child uses one read and the validated cached suffix")
  }
  for (let i = 0; i < 2; i++) await assert.rejects(ancestry.root("s17", signal()), /Session ancestry limit reached/)
  assert.equal(calls, 19)
})

test("ancestry cache stays bounded and deletion invalidates distance-aware records", async () => {
  let calls = 0
  const ancestry = new SessionAncestry(async (id) => { calls++; return { id } })
  for (let i = 0; i <= 4096; i++) await ancestry.root(`root${i}`, signal())
  const before = calls
  await ancestry.root("root4096", signal())
  assert.equal(calls, before)
  await ancestry.root("root0", signal())
  assert.equal(calls, before + 1, "exceeding the cap clears older cache entries")
  ancestry.deleted("root4096")
  await ancestry.root("root4096", signal())
  assert.equal(calls, before + 2)
})

function ancestryFixture(t: import("node:test").TestContext) {
  const calls: { id: string; signal: AbortSignal; value: ReturnType<typeof deferred<{ id: string; parentID?: string }>>;
    cleanup: ReturnType<typeof deferred<void>> }[] = []
  let active = 0, maximum = 0
  const ancestry = new SessionAncestry(async (id, signal) => {
    active++; maximum = Math.max(maximum, active)
    const call = { id, signal, value: deferred<{ id: string; parentID?: string }>(), cleanup: deferred<void>() }
    calls.push(call)
    try { return await call.value.promise }
    finally { try { await call.cleanup.promise } finally { active-- } }
  })
  const finish = (n: number) => { calls[n]!.value.resolve({ id: calls[n]!.id }); calls[n]!.cleanup.resolve() }
  t.after(async () => {
    calls.forEach((_, n) => finish(n)); await settle()
    assert.equal(active, 0); assert.ok(maximum <= 2)
  })
  return { ancestry, calls, finish, active: () => active }
}

test("intermediate deletion invalidates warm descendant suffixes and pending cache hits", async () => {
  const calls: string[] = []
  let parentID = "root"
  const ancestry = new SessionAncestry(async id => {
    calls.push(id)
    return { id, ...(id === "grandchild" ? { parentID: "child" } : id === "child" ? { parentID } : {}) }
  })
  assert.equal(await ancestry.root("grandchild", signal()), "root")
  const cached = ancestry.root("grandchild", signal())
  parentID = "other-root"
  ancestry.deleted("child")
  await assert.rejects(cached, /Session ancestry changed/)
  assert.equal(await ancestry.root("grandchild", signal()), "other-root")
  assert.deepEqual(calls, ["grandchild", "child", "root", "grandchild", "child", "other-root"])
})

for (const outcome of ["resolve", "reject"] as const) test(`ancestry deadlines retain two actual reads through late ${outcome} and cleanup without caching`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = ancestryFixture(t)
  const a = f.ancestry.root("a", signal()), b = f.ancestry.root("b", signal())
  const expired = Promise.all([assert.rejects(a, /timed out/), assert.rejects(b, /timed out/)])
  let settled = false; void a.settled!.then(() => { settled = true })
  await settle(); t.mock.timers.tick(5000); await expired
  for (let n = 0; n < 25; n++) {
    await assert.rejects(f.ancestry.root("a", signal()), /timed out/)
    await assert.rejects(f.ancestry.root(`other-${n}`, signal()), /capacity/)
    t.mock.timers.tick(5000)
  }
  assert.equal(f.calls.length, 2); assert.equal(settled, false)
  if (outcome === "resolve") f.calls[0]!.value.resolve({ id: "a" })
  else f.calls[0]!.value.reject(Error("late metadata failure"))
  await settle()
  assert.equal(f.active(), 2); assert.equal(settled, false)
  f.calls[0]!.cleanup.resolve(); await a.settled
  assert.equal(settled, true)
  const fresh = f.ancestry.root("a", signal()); await settle()
  assert.equal(f.calls.length, 3, "an expired result cannot populate ancestry cache")
  f.finish(2); assert.equal(await fresh, "a")
  f.finish(1); await b.settled
})

test("ancestry joins share actual ownership but a joining abort never cancels the owner's operation", async t => {
  const f = ancestryFixture(t), parent = new AbortController()
  const owner = f.ancestry.root("root", signal()); await settle()
  const join = f.ancestry.root("root", parent.signal)
  assert.equal(join.settled, owner.settled)
  const rejected = assert.rejects(join, { name: "AbortError" }); parent.abort(); await rejected
  assert.equal(f.calls[0]!.signal.aborted, false)
  const more = Array.from({ length: 50 }, () => f.ancestry.root("root", signal()))
  assert.equal(f.calls.length, 1)
  f.finish(0); assert.equal(await owner, "root"); await Promise.all(more)
  assert.equal(await f.ancestry.root("root", signal()), "root"); assert.equal(f.calls.length, 1)
})

test("ancestry owner abort and deletion suppress late caches while retaining physical slots", async t => {
  const f = ancestryFixture(t), abort = new AbortController()
  const first = f.ancestry.root("old", abort.signal), second = f.ancestry.root("deleted", signal())
  const canceled = assert.rejects(first, { name: "AbortError" })
  const deleted = assert.rejects(second, /ancestry changed/)
  await settle(); abort.abort(); f.ancestry.deleted("deleted"); await canceled
  assert.equal(f.active(), 2)
  f.finish(0); f.finish(1); await deleted; await Promise.all([first.settled, second.settled])
  const fresh = f.ancestry.root("deleted", signal()); await settle()
  assert.equal(f.calls.length, 3); f.finish(2); assert.equal(await fresh, "deleted")
})

test("ancestry owner cancellation rejects joined waits but holds capacity through actual cleanup", async t => {
  const f = ancestryFixture(t), abort = new AbortController()
  const owner = f.ancestry.root("root", abort.signal)
  const canceled = assert.rejects(owner, { name: "AbortError" })
  await settle()
  const joined = f.ancestry.root("root", signal())
  const joinCanceled = assert.rejects(joined, { name: "AbortError" })
  assert.equal(joined.settled, owner.settled)
  abort.abort(); await Promise.all([canceled, joinCanceled])
  assert.equal(f.calls[0]!.signal.aborted, true)
  await assert.rejects(f.ancestry.root("root", signal()), { name: "AbortError" })
  const second = f.ancestry.root("second", signal()); await settle()
  await assert.rejects(f.ancestry.root("third", signal()), /capacity/)
  f.calls[0]!.value.resolve({ id: "root" }); await settle()
  assert.equal(f.active(), 2)
  await assert.rejects(f.ancestry.root("third", signal()), /capacity/)
  f.calls[0]!.cleanup.resolve(); await owner.settled
  const fresh = f.ancestry.root("root", signal()); await settle()
  assert.equal(f.calls.length, 3, "the canceled owner's late result never seeds a cached root")
  f.finish(2); assert.equal(await fresh, "root")
  f.finish(1); assert.equal(await second, "second")
})

test("ancestry cancellation before dispatch reserves no abandoned read", async t => {
  const f = ancestryFixture(t), abort = new AbortController()
  const read = f.ancestry.root("root", abort.signal)
  const canceled = assert.rejects(read, { name: "AbortError" }); abort.abort()
  await canceled; await read.settled
  assert.equal(f.calls.length, 0)
  const next = f.ancestry.root("root", signal()); await settle(); f.finish(0)
  assert.equal(await next, "root")
})
