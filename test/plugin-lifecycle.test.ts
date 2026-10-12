import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("concurrent and reentrant stops abort before reverse disposals and share one drain", async () => {
  const life = new PluginLifecycle(), held = deferred(), events: string[] = []
  let reentrant: Promise<void> | undefined
  life.signal.addEventListener("abort", () => {
    events.push("abort")
    reentrant = life.stop()
    life.addCleanup(() => { events.push("abort registration") })
  })
  life.signal.addEventListener("abort", () => { events.push("last abort observer") })
  life.addCleanup(() => {
    assert.equal(life.signal.aborted, true)
    events.push("first")
  })
  life.addCleanup(() => {
    assert.equal(life.signal.aborted, true)
    events.push("second")
    assert.equal(life.stop(), reentrant)
    return held.promise
  })
  const stopped = life.stop()
  assert.equal(stopped, reentrant)
  assert.equal(life.stop(), stopped)
  assert.deepEqual(events, ["abort", "last abort observer", "abort registration", "second", "first"])
  let returned = false
  void stopped.then(() => { returned = true })
  await settle()
  assert.equal(returned, false)
  held.resolve()
  await Promise.all([stopped, life.stop(), life.stop()])
  assert.equal(life.stop(), stopped)
  assert.equal(events.filter(event => event === "second").length, 1)
})

test("late async acquisition is disposed and remains owned after setup returns", async () => {
  const life = new PluginLifecycle(), acquisition = deferred(), disposal = deferred()
  let disposed = 0
  const startup = life.start(async () => {
    await acquisition.promise
    life.addCleanup(() => { disposed++; return disposal.promise })
  })
  await settle()
  const stopped = life.stop()
  acquisition.resolve()
  await startup
  assert.equal(disposed, 1)
  let returned = false
  void stopped.then(() => { returned = true })
  await settle()
  assert.equal(returned, false)
  disposal.resolve()
  await stopped
  await life.settled()
})

for (const asynchronous of [false, true]) test(`${asynchronous ? "async" : "sync"} setup rejection disposes partial resources and preserves the setup error`, async () => {
  const life = new PluginLifecycle(), held = deferred(), failure = new Error("setup failed")
  const events: string[] = []
  const fail = () => { throw failure }
  const startup = life.start(() => {
    life.addCleanup(() => { events.push("first") })
    life.addCleanup(() => {
      assert.equal(life.signal.aborted, true)
      events.push("second")
      return held.promise
    })
    if (asynchronous) return Promise.resolve().then(fail)
    fail()
  })
  await settle()
  assert.equal(life.signal.aborted, true)
  assert.deepEqual(events, ["second", "first"])
  let returned = false
  void startup.then(() => { returned = true }, () => { returned = true })
  await settle()
  assert.equal(returned, false)
  held.resolve()
  await assert.rejects(startup, error => error === failure)
  await life.stop()
  assert.deepEqual(events, ["second", "first"])
})

test("throwing and rejecting cleanups cannot skip others, including post-stop registration", async () => {
  const life = new PluginLifecycle(), events: string[] = []
  life.addCleanup(() => { events.push("oldest") })
  life.addCleanup(async () => { events.push("reject"); throw new Error("async disposal") })
  life.addCleanup(() => { events.push("throw"); throw new Error("sync disposal") })
  await life.stop()
  life.addCleanup(async () => { events.push("late"); throw new Error("late disposal") })
  await life.settled()
  await settle()
  assert.deepEqual(events, ["throw", "reject", "oldest", "late"])
})

test("bounded stop retains unfinished setup and late failing disposal through actual settlement", { timeout: 6000 }, async () => {
  const life = new PluginLifecycle(), acquisition = deferred(), disposal = deferred()
  let disposed = false
  const startup = life.start(async () => {
    await acquisition.promise
    life.addCleanup(() => { disposed = true; return disposal.promise })
    throw new Error("late setup failure")
  })
  await settle()
  const before = performance.now(), stopped = life.stop()
  let physicallySettled = false
  const physical = life.settled().then(() => { physicallySettled = true })
  await stopped
  const elapsed = performance.now() - before
  assert.ok(elapsed >= 3400 && elapsed < 5000, `bounded drain took ${elapsed} ms`)
  assert.equal(physicallySettled, false)
  assert.equal(life.stop(), stopped, "repeated stop cannot start a fresh drain budget")
  acquisition.resolve()
  // Let the helper own a detached rejection before the caller inspects it.
  await settle()
  assert.equal(disposed, true)
  assert.equal(physicallySettled, false)
  await assert.rejects(startup, /late setup failure/)
  disposal.reject(new Error("late disposal failure"))
  await physical
  assert.equal(physicallySettled, true)
})

test("stop before the setup callback prevents new startup work", async () => {
  const life = new PluginLifecycle()
  let started = false
  const startup = life.start(() => { started = true })
  await life.stop()
  await assert.rejects(startup, { name: "AbortError" })
  assert.equal(started, false)
  await life.settled()
})

test("abort listeners and disposal invocation consume the same monotonic drain budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 100
  t.mock.method(performance, "now", () => now)
  const life = new PluginLifecycle(), held = deferred()
  life.signal.addEventListener("abort", () => { now += 1000 })
  life.addCleanup(() => { now += 1000; return held.promise })
  let returned = false
  const stopped = life.stop().then(() => { returned = true })
  t.mock.timers.tick(1499)
  await settle()
  assert.equal(returned, false)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(returned, true, "the original deadline leaves only 1500 ms to drain")
  held.resolve()
  await stopped
  await life.settled()
})
