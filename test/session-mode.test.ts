import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { setImmediate as settle } from "node:timers/promises"
import { SessionModes, SessionModeStore, type ModeStore } from "../src/session-mode.js"
import { sessionModeCommands } from "../src/session-mode-commands.js"

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
  } }, async (id) => ({ id }))
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
  const resumedModes = new SessionModes(resumed, async (id) => ({ id, ...(id === "child" ? { parentID: "root" } : {}) }))
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

test("bounded ancestry resolves all descendants using only session metadata", async () => {
  const calls: string[] = []
  const modes = new SessionModes(memory(), async (id) => {
    calls.push(id)
    return { id, ...(id === "root" ? {} : { parentID: id === "grandchild" ? "child" : "root" }) }
  })
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

for (const failure of ["missing", "mismatch", "cycle", "depth", "empty parent"] as const) {
  test(`ancestry ${failure} remains closed`, async () => {
    let calls = 0
    const modes = new SessionModes(memory(), async (id) => {
      calls++
      if (failure === "missing") return undefined
      if (failure === "mismatch") return { id: "wrong" }
      return { id, parentID: failure === "cycle" ? "root" : failure === "empty parent" ? "" : `${id}-next` }
    })
    await assert.rejects(modes.root("root", signal()))
    assert.ok(calls <= 17)
    assert.equal(modes.enabled("root"), false)
  })
}

for (const warm of [undefined, 0, 1, 8, 16]) test(`${warm === undefined ? "cold" : `depth-${warm} warm`} ancestry accepts 16 edges and rejects 17 without caching rejected prefixes`, async () => {
  const calls: string[] = []
  const modes = new SessionModes(memory(), async (id) => {
    calls.push(id)
    const depth = Number(id.slice(1))
    return { id, ...(depth ? { parentID: `s${depth - 1}` } : {}) }
  })
  if (warm !== undefined) assert.equal(await modes.root(`s${warm}`, signal()), "s0")
  calls.length = 0
  await assert.rejects(modes.root("s17", signal()), /Session ancestry limit reached/)
  assert.ok(calls.length <= 17)
  calls.length = 0
  assert.equal(await modes.root("s16", signal()), "s0")
  assert.ok(calls.length <= 17)
  calls.length = 0
  assert.equal(await modes.root("s16", signal()), "s0")
  assert.deepEqual(calls, [], "accepted prefixes retain their full cached distances")
  await assert.rejects(modes.root("s17", signal()), /Session ancestry limit reached/)
  assert.deepEqual(calls, ["s17"], "an over-depth request must not seed a shortcut")
})

test("incrementally warming descendants cannot extend the ancestry depth limit", async () => {
  let calls = 0
  const modes = new SessionModes(memory(), async (id) => {
    calls++
    const depth = Number(id.slice(1))
    return { id, ...(depth ? { parentID: `s${depth - 1}` } : {}) }
  })
  for (let depth = 0; depth <= 16; depth++) {
    assert.equal(await modes.root(`s${depth}`, signal()), "s0")
    assert.equal(calls, depth + 1, "each new child uses one read and the validated cached suffix")
  }
  for (let i = 0; i < 2; i++) await assert.rejects(modes.root("s17", signal()), /Session ancestry limit reached/)
  assert.equal(calls, 19)
})

test("ancestry cache stays bounded and deletion invalidates distance-aware records", async () => {
  let calls = 0
  const modes = new SessionModes(memory(), async (id) => { calls++; return { id } })
  for (let i = 0; i <= 4096; i++) await modes.root(`root${i}`, signal())
  const before = calls
  await modes.root("root4096", signal())
  assert.equal(calls, before)
  await modes.root("root0", signal())
  assert.equal(calls, before + 1, "exceeding the cap clears older cache entries")
  modes.deleted("root4096")
  await modes.root("root4096", signal())
  assert.equal(calls, before + 2)
})

test("late initial store read cannot overwrite a local disabled switch", async () => {
  const read = deferred<boolean>()
  const modes = new SessionModes({ ...memory(), read: () => read.promise }, async (id) => ({ id }))
  const loading = modes.load("root", signal())
  await modes.set("root", false)
  read.resolve(true)
  await loading
  assert.equal(modes.enabled("root"), false)
})

test("store errors remain closed, and bounded metadata reads honor parent cancellation", async () => {
  const modes = new SessionModes({ ...memory(), read: async () => { throw new Error("broken") } }, async () => new Promise(() => {}))
  await assert.rejects(modes.load("root", signal()))
  assert.equal(modes.enabled("root"), false)
  const abort = new AbortController()
  const lookup = modes.root("root", abort.signal)
  abort.abort()
  await assert.rejects(lookup)
})

test("noncooperative ancestry and mode reads expire within their five-second budgets", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const modes = new SessionModes({ ...memory(), read: () => new Promise(() => {}) }, async () => new Promise(() => {}))
  const lookup = assert.rejects(modes.root("root", signal()), /Session mode ancestry timed out/)
  const loading = assert.rejects(modes.load("root", signal()), /Session mode loading timed out/)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await Promise.all([lookup, loading])
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
  } }, async (id) => ({ id }))
  for (let i = 0; i < 20; i++) await assert.rejects(modes.load(`root${i}`, signal()), /store unavailable/)
  available = true
  await modes.load("root", signal())
  for (let i = 0; i < 20; i++) await modes.load("root", signal())
  assert.equal(reads, 21)
  assert.equal(modes.enabled("root"), false)
})

test("local palette/slash commands capture session, persist, report failures and do nothing on home", async () => {
  const toasts: { message: string }[] = [], changes: string[] = [], writes: boolean[] = []
  let route: TuiPluginApi["route"]["current"] = { name: "home" }
  let fail = false
  const modes = new SessionModes({ ...memory(), write: async (_, enabled) => { writes.push(enabled); if (fail) throw new Error("private") } },
    async (id) => ({ id, ...(id === "child" ? { parentID: "root" } : {}) }))
  type Command = { namespace: string; slashName: string; enabled: () => boolean; run: () => Promise<void> }
  let commands!: Command[]
  const unregister = () => {}
  const api = { route: { get current() { return route } }, lifecycle: { signal: signal() },
    ui: { toast: (value: { message: string }) => toasts.push(value) },
    keymap: { registerLayer: (layer: { commands: Command[] }) => { commands = layer.commands; return unregister } } } as unknown as TuiPluginApi
  assert.equal(sessionModeCommands(api, modes, (root) => changes.push(root)), unregister)
  assert.deepEqual(commands.map((c) => [c.namespace, c.slashName]), [["palette", "reviewer-enable"], ["palette", "reviewer-disable"]])
  await commands[0]!.run()
  assert.equal(commands[0]!.enabled(), false)
  assert.deepEqual(writes, [])
  route = { name: "session", params: { sessionID: "child" } }
  await commands[1]!.run()
  assert.equal(modes.enabled("root"), false)
  assert.equal(toasts.at(-1)!.message, "Reviewer disabled for this conversation.")
  fail = true
  await commands[0]!.run()
  assert.equal(modes.enabled("root"), true)
  assert.deepEqual(changes, ["root", "root"])
  assert.match(toasts.at(-1)!.message, /enabled locally, but saving failed/)
  assert.doesNotMatch(JSON.stringify(toasts), /private/)
})

test("enable cannot bypass corrupt persisted mode", async () => {
  let writes = 0, changes = 0
  const modes = new SessionModes({ ...memory(), read: async () => { throw new Error("private record") }, write: async () => { writes++ } }, async (id) => ({ id }))
  const toasts: { message: string }[] = []
  let commands!: { run: () => Promise<void> }[]
  const api = { route: { current: { name: "session", params: { sessionID: "root" } } }, lifecycle: { signal: signal() },
    ui: { toast: (value: { message: string }) => toasts.push(value) },
    keymap: { registerLayer: (layer: { commands: typeof commands }) => { commands = layer.commands; return () => {} } } } as unknown as TuiPluginApi
  sessionModeCommands(api, modes, () => { changes++ })
  await commands[0]!.run()
  assert.equal(modes.enabled("root"), false)
  assert.equal(writes, 0)
  assert.equal(changes, 0)
  assert.match(toasts[0]!.message, /saved mode could not be read/)
})

test("newer root command defeats an older descendant lookup and pending persistence does not delay the local switch", async () => {
  const lookup = deferred<{ id: string; parentID: string }>()
  const persistence = deferred<void>()
  const writes: boolean[] = [], changes: string[] = []
  const modes = new SessionModes({ ...memory(), write: async (_, enabled) => { writes.push(enabled); await persistence.promise } },
    async (id) => id === "child" ? lookup.promise : { id })
  let sessionID = "child"
  let commands!: { run: () => Promise<void> }[]
  const api = { route: { get current() { return { name: "session", params: { sessionID } } } }, lifecycle: { signal: signal() },
    ui: { toast: () => {} }, keymap: { registerLayer: (layer: { commands: typeof commands }) => { commands = layer.commands; return () => {} } } } as unknown as TuiPluginApi
  sessionModeCommands(api, modes, (root) => changes.push(root))
  const oldEnable = commands[0]!.run()
  sessionID = "root"
  const disable = commands[1]!.run()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(modes.enabled("root"), false)
  assert.deepEqual(changes, ["root"])
  lookup.resolve({ id: "child", parentID: "root" })
  await oldEnable
  assert.deepEqual(writes, [false])
  persistence.resolve()
  await disable
})

test("unchanged Enable still supersedes an older descendant Disable awaiting ancestry", async () => {
  const lookup = deferred<{ id: string; parentID: string }>()
  const writes: boolean[] = [], changes: string[] = []
  const modes = new SessionModes({ ...memory(), write: async (_, enabled) => { writes.push(enabled) } },
    async id => id === "child" ? lookup.promise : { id })
  let sessionID = "child"
  let commands!: { run: () => Promise<void> }[]
  const api = { route: { get current() { return { name: "session", params: { sessionID } } } }, lifecycle: { signal: signal() },
    ui: { toast: () => {} }, keymap: { registerLayer: (layer: { commands: typeof commands }) => { commands = layer.commands; return () => {} } } } as unknown as TuiPluginApi
  sessionModeCommands(api, modes, root => changes.push(root))
  const disable = commands[1]!.run()
  sessionID = "root"
  await commands[0]!.run()
  lookup.resolve({ id: "child", parentID: "root" })
  await disable
  assert.equal(modes.enabled("root"), true)
  assert.deepEqual(writes, [true])
  assert.deepEqual(changes, [], "ordering metadata changes without invalidating enabled reviews")
})

function ancestryFixture(t: import("node:test").TestContext) {
  const calls: { id: string; signal: AbortSignal; value: ReturnType<typeof deferred<{ id: string; parentID?: string }>>;
    cleanup: ReturnType<typeof deferred<void>> }[] = []
  let active = 0, maximum = 0
  const modes = new SessionModes(memory(), async (id, signal) => {
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
  return { modes, calls, finish, active: () => active }
}

for (const outcome of ["resolve", "reject"] as const) test(`ancestry deadlines retain two actual reads through late ${outcome} and cleanup without caching`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = ancestryFixture(t)
  const a = f.modes.root("a", signal()), b = f.modes.root("b", signal())
  const expired = Promise.all([assert.rejects(a, /timed out/), assert.rejects(b, /timed out/)])
  let settled = false; void a.settled!.then(() => { settled = true })
  await settle(); t.mock.timers.tick(5000); await expired
  for (let n = 0; n < 25; n++) {
    await assert.rejects(f.modes.root("a", signal()), /timed out/)
    await assert.rejects(f.modes.root(`other-${n}`, signal()), /capacity/)
    t.mock.timers.tick(5000)
  }
  assert.equal(f.calls.length, 2); assert.equal(settled, false)
  if (outcome === "resolve") f.calls[0]!.value.resolve({ id: "a" })
  else f.calls[0]!.value.reject(Error("late metadata failure"))
  await settle()
  assert.equal(f.active(), 2); assert.equal(settled, false)
  f.calls[0]!.cleanup.resolve(); await a.settled
  assert.equal(settled, true)
  const fresh = f.modes.root("a", signal()); await settle()
  assert.equal(f.calls.length, 3, "an expired result cannot populate ancestry cache")
  f.finish(2); assert.equal(await fresh, "a")
  f.finish(1); await b.settled
})

test("ancestry joins share actual ownership but a joining abort never cancels the owner's operation", async t => {
  const f = ancestryFixture(t), parent = new AbortController()
  const owner = f.modes.root("root", signal()); await settle()
  const join = f.modes.root("root", parent.signal)
  assert.equal(join.settled, owner.settled)
  const rejected = assert.rejects(join, { name: "AbortError" }); parent.abort(); await rejected
  assert.equal(f.calls[0]!.signal.aborted, false)
  const more = Array.from({ length: 50 }, () => f.modes.root("root", signal()))
  assert.equal(f.calls.length, 1)
  f.finish(0); assert.equal(await owner, "root"); await Promise.all(more)
  assert.equal(await f.modes.root("root", signal()), "root"); assert.equal(f.calls.length, 1)
})

test("ancestry owner abort and deletion suppress late caches while retaining physical slots", async t => {
  const f = ancestryFixture(t), abort = new AbortController()
  const first = f.modes.root("old", abort.signal), second = f.modes.root("deleted", signal())
  const canceled = assert.rejects(first, { name: "AbortError" })
  const deleted = assert.rejects(second, /ancestry changed/)
  await settle(); abort.abort(); f.modes.deleted("deleted"); await canceled
  assert.equal(f.active(), 2)
  f.finish(0); f.finish(1); await deleted; await Promise.all([first.settled, second.settled])
  const fresh = f.modes.root("deleted", signal()); await settle()
  assert.equal(f.calls.length, 3); f.finish(2); assert.equal(await fresh, "deleted")
})

test("ancestry cancellation before dispatch reserves no abandoned read", async t => {
  const f = ancestryFixture(t), abort = new AbortController()
  const read = f.modes.root("root", abort.signal)
  const canceled = assert.rejects(read, { name: "AbortError" }); abort.abort()
  await canceled; await read.settled
  assert.equal(f.calls.length, 0)
  const next = f.modes.root("root", signal()); await settle(); f.finish(0)
  assert.equal(await next, "root")
})
