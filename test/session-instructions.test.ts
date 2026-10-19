import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { chmod, link, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, truncate, writeFile, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { setImmediate as settle } from "node:timers/promises"
import { SessionInstructionsStore } from "../src/session-instructions.js"

const signal = () => new AbortController().signal
const MAX_BYTES = 16 * 1024 * 1024
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-instructions-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionInstructionsStore(directory)
  const file = async () => path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!)
  return { directory, store, file }
}
const encoded = (text: string) => {
  const bytes = Buffer.from(text, "utf8")
  return JSON.stringify({ version: 1, bytes: bytes.length, data: bytes.toString("base64") })
}

test("instructions survive restart and session moves, share fresh commits, and isolate roots and forks", async (t) => {
  const { directory, store } = await fixture(t)
  const terminal = new SessionInstructionsStore(directory)
  assert.equal(await store.read("root", 1024, signal()), "")
  assert.deepEqual(await readdir(directory), [], "missing reads do not create state")
  await store.write("root", "  Inspect deployment commands carefully.\n")
  assert.equal(await terminal.read("root", 1024, signal()), "Inspect deployment commands carefully.")
  await terminal.write("root", "Updated in another terminal")
  assert.equal(await store.read("root", 1024, signal()), "Updated in another terminal", "reads never cache old instructions")
  const moved = new SessionInstructionsStore(directory)
  assert.equal(await moved.read("root", 1024, signal()), "Updated in another terminal", "no project or working directory participates in the key")
  for (const root of ["different-root", "fork-of-root", "child"]) assert.equal(await moved.read(root, 1024, signal()), "")
  await store.write("different-root", "Other rules")
  await terminal.write("root", "\n\t  ")
  assert.equal(await moved.read("root", 1024, signal()), "", "empty trimmed text atomically clears the record")
  assert.equal(await moved.read("different-root", 1024, signal()), "Other rules")
  await store.flush()
  const names = await readdir(directory)
  assert.equal(names.length, 2)
  for (const name of names) {
    assert.match(name, /^[a-f0-9]{64}\.json$/)
    assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600)
  }
})

test("new private directories are created without modifying existing paths", async (t) => {
  const { directory } = await fixture(t)
  const target = path.join(directory, "nested", "instructions")
  const store = new SessionInstructionsStore(target)
  assert.equal(await store.read("root", 100, signal()), "")
  await assert.rejects(stat(target), { code: "ENOENT" })
  await store.write("root", "private")
  assert.equal((await stat(target)).mode & 0o777, 0o700)
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700)
  assert.equal(await store.read("root", 100, signal()), "private")
})

test("UTF-8 limits apply to complete trimmed text, never truncating it", async (t) => {
  const { store } = await fixture(t)
  await store.write("root", " \té🍐\n ")
  assert.equal(await store.read("root", 6, signal()), "é🍐")
  assert.equal(await store.read("root", 5, signal()), "")
  assert.equal(await store.read("root", 6, signal()), "é🍐", "an oversize read does not clear the committed value")
  for (const cap of [0, -1, 1.5, NaN, Infinity, MAX_BYTES + 1]) assert.equal(await store.read("root", cap, signal()), "")
  await assert.rejects(store.write("root", "é".repeat(MAX_BYTES / 2 + 1)), /UTF-8 bytes/)
  assert.equal(await store.read("root", 6, signal()), "é🍐")
})

test("base64 records admit the hard UTF-8 maximum without JSON escaping inflation", async (t) => {
  const { store, file } = await fixture(t)
  const text = "\u0001".repeat(MAX_BYTES)
  await store.write("root", text)
  const physical = (await stat(await file())).size
  assert.ok(physical <= 4 * Math.ceil(MAX_BYTES / 3) + 128)
  assert.equal(await store.read("root", MAX_BYTES, signal()), text)
  assert.equal(await store.read("root", MAX_BYTES - 1, signal()), "")
  await assert.rejects(store.write("root", `${text}x`), /maximum UTF-8 bytes/)
})

test("invalid, corrupt, noncanonical, oversized and non-UTF-8 records are silently omitted", async (t) => {
  const { store, file } = await fixture(t)
  await store.write("root", "original")
  const filename = await file()
  for (const value of ["{", "null", "[]", Buffer.from([0xff]),
    '{"version":2,"bytes":1,"data":"eA=="}',
    '{"version":1,"bytes":1,"data":"eA==","extra":1}',
    '{"version":1,"bytes":1,"data":"eA==","version":1}',
    '{"version":1,"bytes":"1","data":"eA=="}',
    '{"version":1,"bytes":-1,"data":""}',
    '{"version":1,"bytes":2,"data":"eA=="}',
    '{"version":1,"bytes":1,"data":"eB=="}',
    '{"version":1,"bytes":1,"data":"!!!!"}',
    '{"version":1,"bytes":1,"data":"/w=="}',
    encoded("😀"), " ".repeat(200)]) {
    await writeFile(filename, value)
    assert.equal(await store.read("root", 3, signal()), "")
  }
  await writeFile(filename, encoded("restored"))
  assert.equal(await store.read("root", 100, signal()), "restored")
  await truncate(filename, 4 * Math.ceil(MAX_BYTES / 3) + 129)
  assert.equal(await store.read("root", MAX_BYTES, signal()), "", "absolute physical cap rejects sparse oversized records before reading")
  await rm(filename)
  await mkdir(filename)
  assert.equal(await store.read("root", 100, signal()), "")
})

test("untrusted permissions, record symlinks and hard links fail open without repairing targets", async (t) => {
  const { directory, store, file } = await fixture(t)
  await store.write("root", "private")
  const filename = await file()
  await chmod(filename, 0o666)
  assert.equal(await store.read("root", 100, signal()), "")
  await assert.rejects(store.write("root", "replacement"))
  assert.equal((await stat(filename)).mode & 0o777, 0o666)
  await chmod(filename, 0o600)
  const alias = path.join(directory, "alias")
  await link(filename, alias)
  assert.equal(await store.read("root", 100, signal()), "")
  await assert.rejects(store.write("root", "replacement"))
  assert.equal(await readFile(alias, "utf8"), encoded("private"))
  await rm(filename)
  await symlink(alias, filename)
  assert.equal(await store.read("root", 100, signal()), "")
  await assert.rejects(store.write("root", "replacement"))
  assert.equal(await readFile(alias, "utf8"), encoded("private"))
})

test("unsafe or symlinked directories silently omit reads and reject writes", async (t) => {
  const { directory } = await fixture(t)
  const privateRoot = path.join(directory, "target")
  await mkdir(privateRoot, { mode: 0o700 })
  const store = new SessionInstructionsStore(privateRoot)
  await store.write("root", "saved")
  await chmod(privateRoot, 0o755)
  assert.equal(await store.read("root", 100, signal()), "")
  await assert.rejects(store.write("root", "replacement"))
  assert.equal((await stat(privateRoot)).mode & 0o777, 0o755)
  await chmod(privateRoot, 0o700)
  const linked = path.join(directory, "linked")
  await symlink(privateRoot, linked)
  const throughLink = new SessionInstructionsStore(path.join(linked, "instructions"))
  assert.equal(await throughLink.read("root", 100, signal()), "")
  await assert.rejects(throughLink.write("root", "replacement"))
  assert.equal(await store.read("root", 100, signal()), "saved")
  assert.equal((await readdir(privateRoot)).length, 1, "no linked target descendants are created")
  // Without a private ancestor, a nonsticky writable host directory is replaceable.
  await chmod(directory, 0o755)
  const host = path.join(directory, "host")
  await mkdir(host, { mode: 0o777 })
  await chmod(host, 0o777)
  const unsafe = new SessionInstructionsStore(path.join(host, "instructions"))
  assert.equal(await unsafe.read("root", 100, signal()), "")
  await assert.rejects(unsafe.write("root", "replacement"))
  assert.deepEqual(await readdir(host), [])
})

test("foreign file ownership and read errors silently omit text, while short reads complete", async (t) => {
  const { store, file } = await fixture(t)
  await store.write("root", "complete é🍐 text")
  const probe = await open(await file(), "r")
  const prototype = Object.getPrototypeOf(probe), stat = probe.stat
  const read: (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }> = probe.read
  await probe.close()
  const foreign = t.mock.method(prototype, "stat", async function(this: FileHandle) {
    const value = await stat.call(this)
    Object.defineProperty(value, "uid", { value: process.geteuid!() + 1 })
    return value
  })
  assert.equal(await store.read("root", 100, signal()), "")
  foreign.mock.restore()
  let captured: FileHandle | undefined
  const broken = t.mock.method(prototype, "read", async function(this: FileHandle) {
    captured = this
    throw new Error("synthetic filesystem failure")
  })
  assert.equal(await store.read("root", 100, signal()), "")
  assert.equal(captured?.fd, -1, "failed reads close their descriptors")
  broken.mock.restore()
  t.mock.method(prototype, "read", async function(this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    return read.call(this, buffer, offset, Math.min(length, 1), position)
  })
  assert.equal(await store.read("root", 100, signal()), "complete é🍐 text")
})

test("failed precommit sync preserves the previous record and serialized writes recover", async (t) => {
  const { directory, store, file } = await fixture(t)
  await store.write("root", "previous")
  const probe = await open(await file(), "r")
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const mock = t.mock.method(prototype, "sync", async () => { throw new Error("sync failed") })
  await assert.rejects(store.write("root", "uncommitted"), /sync failed/)
  await assert.rejects(store.flush(), /sync failed/)
  assert.equal(await store.read("root", 100, signal()), "previous")
  assert.equal((await readdir(directory)).length, 1, "failed temporary records are removed")
  mock.mock.restore()
  await store.write("root", "recovered")
  await store.flush()
  assert.equal(await store.read("root", 100, signal()), "recovered")
})

test("directory sync failures after atomic rename do not falsely report an uncommitted write", async (t) => {
  const { directory, store, file } = await fixture(t)
  await store.write("root", "previous")
  const probe = await open(await file(), "r")
  const prototype = Object.getPrototypeOf(probe), sync = probe.sync
  await probe.close()
  t.mock.method(prototype, "sync", async function(this: FileHandle) {
    if ((await this.stat()).isDirectory()) throw new Error("postcommit sync failed")
    return sync.call(this)
  })
  await store.write("root", "committed")
  await store.flush()
  assert.equal(await new SessionInstructionsStore(directory).read("root", 100, signal()), "committed")
})

test("concurrent terminals commit whole last-writer records without clobbering unrelated roots", async (t) => {
  const { directory, store } = await fixture(t)
  const other = new SessionInstructionsStore(directory)
  await store.write("untouched", "retained")
  await store.write("root", "first-initial")
  const writes = (async () => {
    for (let i = 0; i < 20; i++) await Promise.all([
      store.write("root", `first-${i}`), other.write("root", `second-${i}`), other.write(`independent-${i}`, `text-${i}`),
    ])
  })()
  await Promise.all([writes, (async () => {
    for (let i = 0; i < 40; i++) {
      const value = await store.read("root", 100, signal())
      // A concurrent rename can unlink an opened old record before its ownership
      // checks finish. That read fails open, never returning partial/new mixed data.
      if (value !== "") assert.match(value, /^(?:first|second)-(?:initial|\d+)$/)
    }
  })()])
  const winner = await store.read("root", 100, signal())
  assert.ok(["first-19", "second-19"].includes(winner))
  await other.write("root", "last successful write")
  assert.equal(await store.read("root", 100, signal()), "last successful write")
  assert.equal(await other.read("untouched", 100, signal()), "retained")
  for (let i = 0; i < 20; i++) assert.equal(await store.read(`independent-${i}`, 100, signal()), `text-${i}`)
  assert.equal((await readdir(directory)).length, 22)
})

test("already aborted reads propagate the parent reason and perform no filesystem work", async (t) => {
  const { directory, store } = await fixture(t)
  const parent = new AbortController(), reason = new Error("review canceled")
  parent.abort(reason)
  await assert.rejects(store.read("root", 100, parent.signal), (error) => error === reason)
  assert.deepEqual(await readdir(directory), [])
})

test("overlapping review and editor reads wait and capture a fresh committed value", async t => {
  const { store } = await fixture(t)
  await store.write("root", "original")
  const internal = store as unknown as { readRecord(root: string, max: number, signal: AbortSignal): Promise<string> }
  const read = internal.readRecord.bind(store), entered = deferred(), resume = deferred()
  let calls = 0
  t.mock.method(internal, "readRecord", async (...args: Parameters<typeof read>) => {
    const value = await read(...args)
    if (++calls === 1) { entered.resolve(); await resume.promise }
    return value
  })
  const first = store.read("root", 100, signal())
  await entered.promise
  let secondSettled = false
  const second = store.read("root", 100, signal()).then(value => { secondSettled = true; return value })
  await settle()
  assert.equal(secondSettled, false)
  await store.write("root", "new committed value")
  resume.resolve()
  assert.equal(await first, "original")
  assert.equal(await second, "new committed value")
  assert.equal(calls, 2)
})

test("stalled writes retain bounded save admission across dismissed editor drafts", async t => {
  const { store, file } = await fixture(t)
  await store.write("root", "original")
  const probe = await open(await file(), "r"), prototype = Object.getPrototypeOf(probe), sync = probe.sync
  await probe.close()
  const entered = deferred(), resume = deferred()
  t.mock.method(prototype, "sync", async function(this: FileHandle) {
    entered.resolve(); await resume.promise; return sync.call(this)
  })
  const first = store.write("root", "submitted-0")
  await entered.promise
  const queued = Array.from({ length: 7 }, (_, i) => store.write("root", `submitted-${i + 1}`))
  for (let i = 0; i < 20; i++) await assert.rejects(store.write("root", "overflow"), /capacity/)
  assert.equal(await store.read("root", 100, signal()), "original")
  resume.resolve()
  await Promise.all([first, ...queued])
  assert.equal(await store.read("root", 100, signal()), "submitted-7")
  await store.write("root", "recovered")
  assert.equal(await store.read("root", 100, signal()), "recovered")
})

test("aborting before dispatch releases the reserved slot and flush owns same-turn read reservations", async (t) => {
  const { store } = await fixture(t)
  const parent = new AbortController(), reason = new Error("canceled before I/O")
  const pending = assert.rejects(store.read("root", 100, parent.signal), (error) => error === reason)
  const flush = store.flush()
  parent.abort(reason)
  await pending
  await flush
  await store.write("root", "recovered")
  assert.equal(await store.read("root", 100, signal()), "recovered")
})

for (const abort of [false, true]) test(`${abort ? "aborted" : "expired"} reads retain bounded physical ownership through descriptor cleanup`, async (t) => {
  const { store, file } = await fixture(t)
  await store.write("a", "first")
  await store.write("b", "second")
  const probe = await open(await file(), "r")
  const prototype = Object.getPrototypeOf(probe)
  const read: (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }> = probe.read
  await probe.close()
  const entered = deferred(), resume = deferred(), closing = deferred(), cleanup = deferred()
  const handles: FileHandle[] = []
  let closes = 0
  t.mock.method(prototype, "read", async function(this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    handles.push(this)
    const close = this.close.bind(this)
    this.close = async () => {
      if (++closes === 2) closing.resolve()
      await cleanup.promise
      await close()
    }
    if (handles.length === 2) entered.resolve()
    await resume.promise
    return read.call(this, buffer, offset, length, position)
  })
  t.after(async () => { resume.resolve(); cleanup.resolve(); await store.flush() })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const parent = new AbortController(), reason = new Error("parent stopped")
  const first = store.read("a", 100, parent.signal)
  const second = store.read("b", 100, parent.signal)
  let earlyFlushed = false
  const earlyFlush = store.flush().then(() => { earlyFlushed = true })
  const waits = abort ? Promise.all([
    assert.rejects(first, (error) => error === reason), assert.rejects(second, (error) => error === reason),
  ]) : Promise.all([first, second])
  await entered.promise
  assert.equal(earlyFlushed, false, "flush includes physical work reserved before dispatch")
  if (abort) parent.abort(reason)
  else t.mock.timers.tick(5000)
  assert.deepEqual(await waits, abort ? [undefined, undefined] : ["", ""])
  const queued = Array.from({ length: 20 }, (_, i) => store.read(i % 2 ? "a" : `other-${i}`, 100, signal()))
  await settle()
  t.mock.timers.tick(5000)
  assert.ok((await Promise.all(queued)).every(value => value === ""))
  assert.equal(handles.length, 2, "expired slots cannot dispatch more actual reads")
  resume.resolve()
  await closing.promise
  const duringClose = store.read("a", 100, signal())
  await settle()
  t.mock.timers.tick(5000)
  assert.equal(await duringClose, "")
  assert.equal(handles.length, 2, "settled read calls retain slots while close is pending")
  let flushed = false
  const flush = store.flush().then(() => { flushed = true })
  await settle()
  assert.equal(flushed, false)
  cleanup.resolve()
  await Promise.all([flush, earlyFlush])
  assert.ok(handles.every((handle) => handle.fd === -1))
  t.mock.restoreAll()
  assert.equal(await store.read("a", 100, signal()), "first", "late values are not cached and later reviews recover")
})

test("invalid directory inputs are rejected without filesystem access", () => {
  for (const directory of ["relative", "/a/../b", "/a\0b", `/${"a/".repeat(257)}b`]) {
    assert.throws(() => new SessionInstructionsStore(directory), /absolute, normalized and bounded/)
  }
})
