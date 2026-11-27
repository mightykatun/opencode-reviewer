import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, link, mkdir, mkdtemp, open, readdir, readFile, rename, writeFile, rm, symlink, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { setImmediate as settle } from "node:timers/promises"
import { SessionModes, SessionModeStore, type ModeStore } from "../src/session-mode.js"
import { SessionAncestry } from "../src/session-ancestry.js"
import { monotonicTimers } from "./reviewer-clock.js"

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

test("refresh applies another terminal's shared switch, suspends unreadable records and lets local switches win", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-mode-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ancestry = { root: async (id: string) => id, deleted() {} } as any
  const a = new SessionModes(new SessionModeStore(directory, "/host"), ancestry)
  const b = new SessionModes(new SessionModeStore(directory, "/host"), ancestry)
  const refresh = async () => {
    const changed: string[] = []
    b.refresh(signal(), new Set(["root"]), root => changed.push(root))
    await b.refreshSettled()
    return changed
  }
  await a.load("root", signal()); await b.load("root", signal())
  await a.set("root", false)
  assert.equal(b.enabled("root"), true)
  assert.deepEqual(await refresh(), ["root"])
  assert.equal(b.enabled("root"), false, "terminal B observes terminal A's disable")
  assert.deepEqual(await refresh(), [], "an unchanged record reports nothing")
  await a.set("root", true)
  assert.deepEqual(await refresh(), ["root"])
  assert.equal(b.enabled("root"), true)
  const [name] = await readdir(directory)
  await writeFile(path.join(directory, name!), "{")
  assert.deepEqual(await refresh(), ["root"])
  assert.equal(b.enabled("root"), false, "an unreadable shared record suspends review")
  const held = deferred<boolean>()
  const slow = new SessionModes({ read: () => held.promise, write: async () => {}, flush: async () => {} }, ancestry)
  await slow.set("root", true)
  const changes: string[] = []
  slow.refresh(signal(), new Set(["root"]), root => changes.push(root))
  await settle()
  await slow.set("root", false)
  held.resolve(true)
  await slow.refreshSettled()
  assert.deepEqual(changes, [])
  assert.equal(slow.enabled("root"), false, "a local switch during the read is not overwritten")
})

test("mode records use the resolved root location and reject unknown locations", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "reviewer-root-mode-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  const directory = path.join(base, "modes")
  const home = JSON.stringify({ directory: "/home/project", workspaceID: "one" })
  const other = JSON.stringify({ directory: "/other" })
  const locations = new Map([["root", home], ["other", other]])
  const store = new SessionModeStore(directory, root => locations.get(root))
  await assert.rejects(store.read("unknown", signal()), /root location unavailable/)
  await assert.rejects(store.write("unknown", false), /root location unavailable/)
  assert.deepEqual(await readdir(base), [])
  await new SessionModeStore(directory, home).write("root", false)
  const ancestry = new SessionAncestry(async id => ({ id, parentID: id === "child" ? "root" : undefined }))
  const modes = new SessionModes(store, ancestry)
  const root = await modes.root("child", signal())
  await modes.load(root, signal())
  assert.equal(modes.enabled(root), false)
  await modes.set("other", false)
  assert.equal(await new SessionModeStore(directory, other).read("other", signal()), false)
  assert.equal(await new SessionModeStore(directory, home).read("other", signal()), true)
})

test("mode reads reject corrupt, oversized, invalid UTF-8, nonregular and linked records", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-mode-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionModeStore(directory, "host")
  await store.write("root", false)
  const file = path.join(directory, (await readdir(directory))[0]!)
  const boundary = '{"version":1,"enabled":false}'.padEnd(1024)
  await writeFile(file, boundary)
  assert.equal(await store.read("root", signal()), false, "the full 1024-byte record remains valid")
  await writeFile(file, `${boundary} `)
  await assert.rejects(store.read("root", signal()), /Invalid session mode record/)
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

test("refresh publishes each root independently and revokes at the deadline while physical cleanup still owns capacity", async t => {
  const clock = monotonicTimers(t), f = readFixture(t)
  const active = new Set(["a", "b", "c"]), changes: string[] = []
  for (const root of active) await f.modes.set(root, true)
  const parent = signal(), refresh = () => f.modes.refresh(parent, active, root => changes.push(root))
  refresh()
  await settle()
  assert.deepEqual(f.calls.map(call => call.root), ["a", "b"])
  f.finish(1, false)
  await settle()
  assert.deepEqual(changes, ["b"])
  assert.equal(f.calls[2]?.root, "c")
  f.finish(2)
  await settle()
  clock.tick(2000)
  refresh()
  await settle()
  assert.equal(f.calls[3]?.root, "b", "a held read does not delay the next poll of other roots")
  f.finish(3)
  await settle()
  f.finish(4)
  await settle()
  assert.deepEqual(changes, ["b", "b"])
  clock.tick(2999)
  await settle()
  assert.equal(f.modes.enabled("a"), true)
  clock.tick(1)
  assert.equal(f.modes.enabled("a"), false, "authorization sees expiry before the timer callback's microtasks")
  await settle()
  assert.equal(f.modes.enabled("a"), false)
  assert.deepEqual(changes, ["b", "b", "a"])
  assert.equal(f.counts().actual, 1)
  let drained = false
  const draining = f.modes.refreshSettled().then(() => { drained = true })
  f.calls[0]!.value.resolve(true)
  await settle()
  assert.equal(drained, false)
  f.calls[0]!.cleanup.resolve()
  await draining
  assert.equal(f.modes.enabled("a"), false)
})

test("queued roots lose authority within budget, retain their turn and share slots with initial reads", async t => {
  const clock = monotonicTimers(t), f = readFixture(t)
  const active = new Set(["a", "b", "c", "d"]), changes: string[] = []
  for (const root of active) await f.modes.set(root, true)
  const parent = signal(), refresh = () => f.modes.refresh(parent, active, root => changes.push(root))
  const initial = assert.rejects(f.modes.load("initial", parent), /timed out/)
  refresh()
  await settle()
  assert.deepEqual(f.calls.map(call => call.root), ["initial", "a"])
  for (let i = 0; i < 100; i++) refresh()
  clock.tick(5000)
  await initial
  await settle()
  assert.deepEqual(changes.toSorted(), [...active])
  for (const root of active) assert.equal(f.modes.enabled(root), false)
  const other = assert.rejects(f.modes.load("other", parent), /Session mode loading timed out/)
  for (let i = 0; i < 5; i++) {
    refresh()
    await settle()
    clock.tick(5000)
    await settle()
    assert.equal(f.calls.length, 2)
    assert.equal(changes.length, 4)
  }
  f.finish(1)
  await settle()
  refresh()
  await settle()
  for (const [index, root] of ["b", "c", "d", "a"].entries()) {
    assert.equal(f.calls[index + 2]?.root, root)
    f.finish(index + 2)
    await settle()
  }
  assert.deepEqual(changes.slice(4), ["b", "c", "d", "a"])
  await other
})

test("a local enable racing a refresh timeout survives both revocation and late physical settlement", async t => {
  const clock = monotonicTimers(t), f = readFixture(t), changes: string[] = []
  await f.modes.set("root", false)
  f.modes.refresh(signal(), new Set(["root"]), root => changes.push(root))
  await settle()
  await f.modes.set("root", true)
  clock.tick(5000)
  await settle()
  assert.equal(f.modes.enabled("root"), true)
  f.finish(0, false)
  await f.modes.refreshSettled()
  assert.equal(f.modes.enabled("root"), true)
  assert.deepEqual(changes, [])
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

for (const first of [false, true]) test(`concurrent mode writes starting with ${first} publish only the last committed enable`, async () => {
  const calls: boolean[] = []
  const commits = [deferred<void>(), deferred<void>()]
  const modes = new SessionModes({ ...memory(), write: async (_root, enabled) => {
    const index = calls.length
    calls.push(enabled)
    await commits[index]!.promise
  } }, new SessionAncestry(async id => ({ id })))
  await modes.load("root", signal())
  const earlier = modes.set("root", first)
  const later = modes.set("root", !first)
  assert.equal(modes.enabled("root"), false)
  assert.deepEqual(calls, [first])
  commits[0]!.resolve()
  await earlier
  assert.deepEqual(calls, [first, !first])
  assert.equal(modes.enabled("root"), false)
  commits[1]!.resolve()
  await later
  assert.equal(modes.enabled("root"), !first)
})

test("a failed positive write leaves a disabled root disabled", async () => {
  const modes = new SessionModes({ ...memory(), read: async () => false, write: async () => {
    throw new Error("record write failed")
  } }, new SessionAncestry(async id => ({ id })))
  await modes.load("root", signal())
  await assert.rejects(modes.set("root", true), /record write failed/)
  assert.equal(modes.enabled("root"), false)
})

test("mode directory sync failures reject after rename while preserving the committed value", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-mode-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionModeStore(directory, "host")
  await store.write("root", true)
  const probe = await open(path.join(directory, (await readdir(directory))[0]!), "r")
  const prototype = Object.getPrototypeOf(probe), sync = probe.sync
  await probe.close()
  const failure = t.mock.method(prototype, "sync", async function(this: FileHandle) {
    if ((await this.stat()).isDirectory()) throw new Error("postcommit sync failed")
    return sync.call(this)
  })
  await assert.rejects(store.write("root", false), /postcommit sync failed/)
  await assert.rejects(store.flush(), /postcommit sync failed/)
  assert.equal(await new SessionModeStore(directory, "host").read("root", signal()), false)
  assert.equal((await readdir(directory)).length, 1, "temporary records are cleaned up")
  failure.mock.restore()
  await store.write("root", true)
  await store.flush()
  assert.equal(await store.read("root", signal()), true)
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
  const clock = monotonicTimers(t)
  const modes = new SessionModes({ ...memory(), read: () => new Promise(() => {}) }, new SessionAncestry(async (id) => ({ id })))
  const loading = assert.rejects(modes.load("root", signal()), /Session mode loading timed out/)
  await Promise.resolve()
  clock.tick(5000)
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
  const clock = monotonicTimers(t)
  const f = readFixture(t)
  const expired = assert.rejects(f.modes.load("root", signal()), /Session mode loading timed out/)
  await settle()
  clock.tick(5000)
  await expired
  for (let cycle = 0; cycle < 40; cycle++) {
    await Promise.all(Array.from({ length: 20 }, () => assert.rejects(f.modes.load("root", signal()), /Session mode loading timed out/)))
    clock.tick(5000)
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

test("multiple roots wait within budget at the two-read cap and recover in queue order after cleanup", async (t) => {
  const clock = monotonicTimers(t)
  const f = readFixture(t)
  const first = assert.rejects(f.modes.load("a", signal()), /Session mode loading timed out/)
  const second = assert.rejects(f.modes.load("b", signal()), /Session mode loading timed out/)
  await settle()
  const queuedTimeouts = (count: number) => Array.from({ length: count }, (_, i) =>
    assert.rejects(f.modes.load(`other${i}`, signal()), /Session mode loading timed out/))
  const waiting = queuedTimeouts(30)
  clock.tick(5000)
  await Promise.all([first, second, ...waiting])
  for (let cycle = 0; cycle < 30; cycle++) {
    await assert.rejects(f.modes.load("a", signal()), /timed out/)
    await assert.rejects(f.modes.load("b", signal()), /timed out/)
    const expired = queuedTimeouts(20)
    clock.tick(5000)
    await Promise.all(expired)
    assert.deepEqual(f.counts(), { actual: 2, maximum: 2, maximumPerRoot: 1, reads: 2 })
  }
  f.calls[0]!.value.resolve(true)
  await settle()
  const third = f.modes.load("c", signal())
  const joined = f.modes.load("c", signal())
  const fourth = f.modes.load("d", signal())
  assert.equal(f.counts().reads, 2)
  f.calls[0]!.cleanup.resolve()
  await settle()
  assert.equal(f.modes.enabled("a"), false)
  assert.equal(f.calls[2]?.root, "c")
  assert.equal(f.counts().actual, 2)
  await f.modes.set("disabled", false)
  await f.modes.load("disabled", signal())
  assert.equal(f.modes.enabled("disabled"), false)
  f.finish(2)
  await Promise.all([third, joined])
  await settle()
  assert.equal(f.calls[3]?.root, "d")
  f.finish(3)
  await fourth
  f.calls[1]!.value.reject(new Error("late store failure"))
  f.calls[1]!.cleanup.resolve()
  await settle()
  const recovered = f.modes.load("a", signal())
  await settle()
  f.finish(4)
  await recovered
  assert.equal(f.modes.enabled("a"), true)
  assert.deepEqual(f.counts(), { actual: 0, maximum: 2, maximumPerRoot: 1, reads: 5 })
})

test("a new root loads ahead of queued refreshes when a slot opens", async t => {
  const f = readFixture(t)
  const active = new Set(["a", "b", "c"])
  for (const root of active) await f.modes.set(root, true)
  f.modes.refresh(signal(), active, () => {})
  const loading = f.modes.load("new", signal())
  await settle()
  assert.deepEqual(f.calls.map(call => call.root), ["a", "b"])
  f.finish(0)
  await settle()
  assert.equal(f.calls[2]?.root, "new")
  f.finish(2)
  await loading
  await settle()
  assert.equal(f.calls[3]?.root, "c")
  f.finish(1)
  f.finish(3)
  await f.modes.refreshSettled()
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
  const clock = monotonicTimers(t)
  const f = readFixture(t)
  const expired = assert.rejects(f.modes.load("root", signal()), /timed out/)
  await settle()
  clock.tick(5000)
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
