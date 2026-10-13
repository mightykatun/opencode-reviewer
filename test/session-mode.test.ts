import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rename, writeFile, rm, symlink, stat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { setImmediate as settle } from "node:timers/promises"
import { SessionModes, SessionModeStore, type ModeStore } from "../src/session-mode.js"
import { SessionAncestry } from "../src/session-ancestry.js"

const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const memory = (): ModeStore => ({ read: async () => true, write: async () => {}, flush: async () => {} })

function readFixture(t: import("node:test").TestContext) {
  const calls: { root: string; signal: AbortSignal; value: ReturnType<typeof deferred<boolean>>; cleanup: ReturnType<typeof deferred<void>> }[] = []
  const perRoot = new Map<string, number>()
  let actual = 0, maximum = 0, maximumPerRoot = 0
  const modes = new SessionModes({ ...memory(), read: async (root, signal) => {
    actual++
    maximum = Math.max(maximum, actual)
    perRoot.set(root, (perRoot.get(root) ?? 0) + 1)
    maximumPerRoot = Math.max(maximumPerRoot, perRoot.get(root)!)
    const call = { root, signal, value: deferred<boolean>(), cleanup: deferred<void>() }
    calls.push(call)
    try { return await call.value.promise }
    finally {
      try { await call.cleanup.promise }
      finally { actual--; perRoot.set(root, perRoot.get(root)! - 1) }
    }
  } }, new SessionAncestry(async (id) => ({ id })))
  const finish = (index: number, value = true) => { calls[index]!.value.resolve(value); calls[index]!.cleanup.resolve() }
  t.after(async () => {
    for (const call of calls) { call.value.resolve(false); call.cleanup.resolve() }
    await settle()
    assert.equal(actual, 0)
    assert.ok(maximum <= 2, "actual mode reads including cleanup obey the instance cap")
    assert.ok(maximumPerRoot <= 1, "a root never has overlapping actual mode reads")
  })
  return { modes, calls, finish, counts: () => ({ actual, maximum, maximumPerRoot, reads: calls.length }) }
}

test("atomic mode records survive restart, serialize toggles and isolate host/root identities", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-mode-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionModeStore(directory, "/host")
  assert.equal(await store.read("root", signal()), true)
  await Promise.all([store.write("root", false), store.write("root", true), store.write("root", false), store.write("other", true)])
  await store.flush()
  const resumed = new SessionModeStore(directory, "/host")
  assert.equal(await resumed.read("root", signal()), false)
  assert.equal(await resumed.read("other", signal()), true)
  assert.equal(await new SessionModeStore(directory, "/other-host").read("root", signal()), true)
  const resumedModes = new SessionModes(resumed, new SessionAncestry(async (id) => ({ id, ...(id === "child" ? { parentID: "root" } : {}) })))
  const inherited = await resumedModes.root("child", signal())
  await resumedModes.load(inherited, signal())
  assert.equal(resumedModes.enabled(inherited), false, "a resumed descendant inherits persisted root mode")
  const names = await readdir(directory)
  assert.equal(names.length, 2)
  for (const name of names) {
    assert.match(name, /^[a-f0-9]{64}\.json$/)
    assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600)
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(directory, name), "utf8"))).sort(), ["enabled", "version"])
  }
})

test("mode reads reject corrupt, oversized, invalid UTF-8, nonregular and linked records", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-mode-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionModeStore(directory, "host")
  await store.write("root", false)
  const file = path.join(directory, (await readdir(directory))[0]!)
  for (const value of ["{", "null", '{"version":2,"enabled":false}', '{"version":1,"enabled":"false"}',
    '{"version":1,"enabled":true,"extra":1}', " ".repeat(1025), Buffer.from([0xff])]) {
    await writeFile(file, value)
    await assert.rejects(store.read("root", signal()))
  }
  await rm(file)
  await symlink(directory, file)
  await assert.rejects(store.read("root", signal()))
  await rm(file)
  const { mkdir } = await import("node:fs/promises")
  await mkdir(file)
  await assert.rejects(store.read("root", signal()))
})

test("failed writes reject honestly and later serialized writes recover", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-mode-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const blocked = path.join(directory, "blocked")
  await writeFile(blocked, "not a directory")
  const store = new SessionModeStore(blocked, "host")
  await assert.rejects(store.write("root", false))
  await assert.rejects(store.flush())
  await rm(blocked)
  await store.write("root", false)
  assert.equal(await store.read("root", signal()), false)
})

test("replaceable mode ancestors fail closed even when a disabled record disappears", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "reviewer-mode-namespace-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  await chmod(base, 0o755)
  const host = path.join(base, "host"), directory = path.join(host, "modes")
  await mkdir(host, { mode: 0o755 })
  const store = new SessionModeStore(directory, "host")
  await store.write("root", false)
  assert.equal(await store.read("root", signal()), false)
  await chmod(host, 0o777)
  await rename(directory, path.join(host, "displaced"))
  await mkdir(directory, { mode: 0o700 })
  const resumed = new SessionModes(new SessionModeStore(directory, "host"), new SessionAncestry(async id => ({ id })))
  await assert.rejects(resumed.load("root", signal()), /Untrusted session mode ancestor/)
  assert.equal(resumed.enabled("root"), false)
  await assert.rejects(store.write("root", true), /Untrusted session mode ancestor/)
  assert.deepEqual(await readdir(directory), [])
  assert.equal((await stat(host)).mode & 0o777, 0o777, "Existing host permissions remain untouched")
})

test("mode reads and writes reject ancestor symlinks without touching their targets", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "reviewer-mode-link-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  const target = path.join(base, "target"), ancestor = path.join(base, "linked")
  await mkdir(target, { mode: 0o700 })
  await symlink(target, ancestor)
  const store = new SessionModeStore(path.join(ancestor, "modes"), "host")
  await assert.rejects(store.read("root", signal()), /Untrusted session mode ancestor/)
  await assert.rejects(store.write("root", false), /Untrusted session mode ancestor/)
  assert.deepEqual(await readdir(target), [])
})

test("mode records reject writable permissions and hard links without repairing them", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-mode-record-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionModeStore(directory, "host")
  await store.write("root", false)
  const file = path.join(directory, (await readdir(directory))[0]!)
  await chmod(file, 0o666)
  await assert.rejects(store.read("root", signal()), /Invalid session mode record/)
  assert.equal((await stat(file)).mode & 0o777, 0o666)
  await chmod(file, 0o600)
  await link(file, path.join(directory, "alias"))
  await assert.rejects(store.read("root", signal()), /Invalid session mode record/)
  assert.equal(await readFile(file, "utf8"), '{"version":1,"enabled":false}')
})

test("injected ancestry resolves descendant modes and delegates deletion", async () => {
  const calls: string[] = []
  const modes = new SessionModes(memory(), new SessionAncestry(async (id) => {
    calls.push(id)
    return { id, ...(id === "root" ? {} : { parentID: id === "grandchild" ? "child" : "root" }) }
  }))
  assert.equal(await modes.root("grandchild", signal()), "root")
  assert.deepEqual(calls, ["grandchild", "child", "root"])
  assert.equal(modes.enabled("root"), false)
  await modes.load("root", signal())
  assert.equal(modes.enabled("root"), true)
  await modes.set("root", false)
  assert.equal(await modes.root("child", signal()), "root")
  assert.equal(modes.enabled("root"), false)
  modes.deleted("root")
  await modes.root("child", signal())
  assert.equal(calls.length, 5)
})

test("late initial store read cannot overwrite a local disabled switch", async () => {
  const read = deferred<boolean>()
  const modes = new SessionModes({ ...memory(), read: () => read.promise }, new SessionAncestry(async (id) => ({ id })))
  const loading = modes.load("root", signal())
  await modes.set("root", false)
  read.resolve(true)
  await loading
  assert.equal(modes.enabled("root"), false)
})

test("mode root forwarding preserves shared ancestry settlement without reading saved modes", async () => {
  const value = deferred<{ id: string }>(), cleanup = deferred<void>()
  let loads = 0
  const ancestry = new SessionAncestry(async () => {
    try { return await value.promise } finally { await cleanup.promise }
  })
  const modes = new SessionModes({ ...memory(), read: async () => { loads++; return true } }, ancestry)
  const owner = ancestry.root("root", signal())
  const joiner = new AbortController()
  const joined = modes.root("root", joiner.signal)
  assert.ok(owner.settled)
  assert.equal(joined.settled, owner.settled, "a synchronous forward retains actual ownership")
  const canceled = assert.rejects(joined, { name: "AbortError" })
  joiner.abort(); await canceled
  let settled = false
  void joined.settled!.then(() => { settled = true })
  value.resolve({ id: "root" }); await settle()
  assert.equal(settled, false)
  cleanup.resolve(); assert.equal(await owner, "root"); await joined.settled
  assert.equal(settled, true)
  assert.equal(loads, 0)
  assert.equal(modes.enabled("root"), false)
})

test("store errors remain closed", async () => {
  const modes = new SessionModes({ ...memory(), read: async () => { throw new Error("broken") } }, new SessionAncestry(async (id) => ({ id })))
  await assert.rejects(modes.load("root", signal()))
  assert.equal(modes.enabled("root"), false)
})

test("noncooperative mode reads expire within their five-second budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const modes = new SessionModes({ ...memory(), read: () => new Promise(() => {}) }, new SessionAncestry(async (id) => ({ id })))
  const loading = assert.rejects(modes.load("root", signal()), /Session mode loading timed out/)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await loading
  assert.equal(modes.enabled("root"), false)
})

test("concurrent same-root loads share one actual read through cleanup and cache a disabled result", async (t) => {
  const f = readFixture(t)
  const loads = Array.from({ length: 100 }, () => f.modes.load("root", signal()))
  await settle()
  assert.deepEqual(f.counts(), { actual: 1, maximum: 1, maximumPerRoot: 1, reads: 1 })
  f.calls[0]!.value.resolve(false)
  await settle()
  const more = Array.from({ length: 100 }, () => f.modes.load("root", signal()))
  await settle()
  assert.equal(f.counts().reads, 1)
  f.calls[0]!.cleanup.resolve()
  await Promise.all([...loads, ...more])
  assert.equal(f.modes.enabled("root"), false)
  for (let i = 0; i < 100; i++) await f.modes.load("root", signal())
  assert.equal(f.counts().reads, 1, "disabled is a loaded choice, not another unavailable read")
})

for (const outcome of ["resolve", "reject"] as const) test(`expired same-root loads retain one actual read across many deadlines and late ${outcome} cleanup`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = readFixture(t)
  const expired = assert.rejects(f.modes.load("root", signal()), /Session mode loading timed out/)
  await settle()
  t.mock.timers.tick(5000)
  await expired
  for (let cycle = 0; cycle < 40; cycle++) {
    await Promise.all(Array.from({ length: 20 }, () => assert.rejects(f.modes.load("root", signal()), /Session mode loading timed out/)))
    t.mock.timers.tick(5000)
    await settle()
    assert.deepEqual(f.counts(), { actual: 1, maximum: 1, maximumPerRoot: 1, reads: 1 })
  }
  assert.equal(f.calls[0]!.signal.aborted, true)
  if (outcome === "resolve") f.calls[0]!.value.resolve(true)
  else f.calls[0]!.value.reject(new Error("late store failure"))
  await settle()
  await assert.rejects(f.modes.load("root", signal()), /Session mode loading timed out/)
  assert.equal(f.counts().actual, 1, "value settlement alone does not release cleanup ownership")
  f.calls[0]!.cleanup.resolve()
  await settle()
  assert.equal(f.modes.enabled("root"), false, "late values cannot populate the mode cache")
  const recovered = f.modes.load("root", signal())
  await settle()
  assert.equal(f.counts().reads, 2)
  f.finish(1)
  await recovered
  assert.equal(f.modes.enabled("root"), true)
})

test("multiple roots are capped at two actual reads through timeout and cleanup, then recover without queueing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = readFixture(t)
  const first = assert.rejects(f.modes.load("a", signal()), /Session mode loading timed out/)
  const second = assert.rejects(f.modes.load("b", signal()), /Session mode loading timed out/)
  await settle()
  for (let i = 0; i < 30; i++) await assert.rejects(f.modes.load(`other${i}`, signal()), /read capacity unavailable/)
  t.mock.timers.tick(5000)
  await Promise.all([first, second])
  for (let cycle = 0; cycle < 30; cycle++) {
    await assert.rejects(f.modes.load("a", signal()), /timed out/)
    await assert.rejects(f.modes.load("b", signal()), /timed out/)
    for (let i = 0; i < 20; i++) await assert.rejects(f.modes.load(`other${i}`, signal()), /read capacity unavailable/)
    t.mock.timers.tick(5000)
    await settle()
    assert.deepEqual(f.counts(), { actual: 2, maximum: 2, maximumPerRoot: 1, reads: 2 })
  }
  f.calls[0]!.value.resolve(true)
  await settle()
  await assert.rejects(f.modes.load("c", signal()), /read capacity unavailable/)
  f.calls[0]!.cleanup.resolve()
  await settle()
  assert.equal(f.modes.enabled("a"), false)
  assert.equal(f.counts().reads, 2, "capacity release does not dispatch skipped work")
  const third = f.modes.load("c", signal())
  await settle()
  assert.equal(f.counts().actual, 2)
  await assert.rejects(f.modes.load("d", signal()), /read capacity unavailable/)
  await f.modes.set("disabled", false)
  await f.modes.load("disabled", signal())
  assert.equal(f.modes.enabled("disabled"), false)
  f.finish(2)
  await third
  f.calls[1]!.value.reject(new Error("late store failure"))
  f.calls[1]!.cleanup.resolve()
  await settle()
  const recovered = f.modes.load("a", signal())
  await settle()
  f.finish(3)
  await recovered
  assert.equal(f.modes.enabled("a"), true)
  assert.deepEqual(f.counts(), { actual: 0, maximum: 2, maximumPerRoot: 1, reads: 4 })
})

test("canceling a joining caller does not abort the owner's shared read", async (t) => {
  const f = readFixture(t)
  const owner = f.modes.load("root", signal())
  await settle()
  const joiner = new AbortController()
  const joined = assert.rejects(f.modes.load("root", joiner.signal), { name: "AbortError" })
  joiner.abort()
  await joined
  assert.equal(f.calls[0]!.signal.aborted, false)
  assert.equal(f.counts().reads, 1)
  f.finish(0)
  await owner
  assert.equal(f.modes.enabled("root"), true)
})

test("owner cancellation rejects shared waits but retains actual-read ownership until cleanup", async (t) => {
  const f = readFixture(t)
  const parent = new AbortController()
  const owner = assert.rejects(f.modes.load("root", parent.signal), { name: "AbortError" })
  await settle()
  const joined = assert.rejects(f.modes.load("root", signal()), { name: "AbortError" })
  parent.abort()
  await Promise.all([owner, joined])
  await assert.rejects(f.modes.load("root", signal()), { name: "AbortError" })
  f.calls[0]!.value.resolve(true)
  await settle()
  assert.equal(f.counts().actual, 1)
  f.calls[0]!.cleanup.resolve()
  await settle()
  assert.equal(f.modes.enabled("root"), false)
  const next = f.modes.load("root", signal())
  await settle()
  f.finish(1)
  await next
  assert.equal(f.modes.enabled("root"), true)
})

test("cancellation before read dispatch leaves no reserved slot or filesystem work", async (t) => {
  const f = readFixture(t)
  const parent = new AbortController()
  const canceled = assert.rejects(f.modes.load("root", parent.signal), { name: "AbortError" })
  parent.abort()
  await canceled
  await settle()
  assert.deepEqual(f.counts(), { actual: 0, maximum: 0, maximumPerRoot: 0, reads: 0 })
  const next = f.modes.load("root", signal())
  await settle()
  f.finish(0)
  await next
  assert.equal(f.modes.enabled("root"), true)
})

for (const enabled of [true, false]) test(`local ${enabled ? "enabled" : "disabled"} mode survives pending read settlement without another read`, async (t) => {
  const f = readFixture(t)
  const loading = f.modes.load("root", signal())
  await settle()
  await f.modes.set("root", enabled)
  await f.modes.load("root", signal())
  assert.equal(f.counts().reads, 1)
  f.finish(0, !enabled)
  await loading
  assert.equal(f.modes.enabled("root"), enabled)
})

for (const enabled of [true, false]) test(`local ${enabled ? "enabled" : "disabled"} mode survives late expired values while their slot stays occupied`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = readFixture(t)
  const expired = assert.rejects(f.modes.load("root", signal()), /timed out/)
  await settle()
  t.mock.timers.tick(5000)
  await expired
  await f.modes.set("root", enabled)
  for (let i = 0; i < 100; i++) await f.modes.load("root", signal())
  assert.equal(f.counts().reads, 1)
  assert.equal(f.counts().actual, 1)
  f.calls[0]!.value.resolve(!enabled)
  await settle()
  assert.equal(f.counts().actual, 1)
  assert.equal(f.modes.enabled("root"), enabled)
  f.calls[0]!.cleanup.resolve()
  await settle()
  assert.equal(f.modes.enabled("root"), enabled)
})

test("failed cleanup and synchronous store errors free read capacity for later recovery", async (t) => {
  const f = readFixture(t)
  const failed = assert.rejects(f.modes.load("root", signal()), /cleanup failed/)
  await settle()
  f.calls[0]!.value.resolve(true)
  f.calls[0]!.cleanup.reject(new Error("cleanup failed"))
  await failed
  const next = f.modes.load("root", signal())
  await settle()
  f.finish(1)
  await next
  assert.equal(f.modes.enabled("root"), true)

  let available = false, reads = 0
  const modes = new SessionModes({ ...memory(), read: () => {
    reads++
    if (!available) throw new Error("store unavailable")
    return Promise.resolve(false)
  } }, new SessionAncestry(async (id) => ({ id })))
  for (let i = 0; i < 20; i++) await assert.rejects(modes.load(`root${i}`, signal()), /store unavailable/)
  available = true
  await modes.load("root", signal())
  for (let i = 0; i < 20; i++) await modes.load("root", signal())
  assert.equal(reads, 21)
  assert.equal(modes.enabled("root"), false)
})
