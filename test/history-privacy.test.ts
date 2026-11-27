import assert from "node:assert/strict"
import { test } from "node:test"
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as turn } from "node:timers/promises"
import { openHistoryDatabase as openDatabase, privateDatabase } from "../src/history-storage-worker.js"
import { HistoryStore } from "../src/history-store.js"
import type { HistoryTransport } from "../src/history-store.js"
import { encodeEvent } from "../src/history-records.js"
import type { HistoryEvent, HistoryReview } from "../src/history-records.js"

const context: HistoryReview = { root: "root", session: "child", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const conversation = { root: context.root }
const openHistoryDatabase = (file: string, adapter: "node", construct = (file: string) => new DatabaseSync(file)) => openDatabase(file, adapter, construct)
const marker = "PRIVATE_REPORT_47a9e9c4_DELETION_PROOF"
const accepted: HistoryEvent = { type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } }
const report: HistoryEvent = { type: "permissionResolved", context, at: 2, outcome: "manual", payload: { safe: true, completedAt: 1, desc: marker.repeat(1000) } }
const replacement: HistoryEvent = { ...report, context: { ...context, review: "replacement" }, payload: { safe: true, completedAt: 2, desc: "Replacement" } }

function directory(t: any) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-privacy-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function contains(file: string, text = marker) {
  return ["", "-wal", "-shm", "-journal"].filter(suffix => existsSync(file + suffix))
    .some(suffix => readFileSync(file + suffix).includes(Buffer.from(text)))
}
function fixture(t: any) {
  const dir = directory(t), file = path.join(dir, "private/history-v2.sqlite")
  const sql = openHistoryDatabase(file, "node"), db = sql.db
  t.after(() => sql.close())
  sql.apply("seed", 1, encodeEvent(accepted)); sql.apply("seed", 2, encodeEvent(report))
  return { dir, file, sql, db }
}

test("busy readers keep replaced bodies and reasons pending until checkpoint can remove them", t => {
  const { file, sql, db } = fixture(t), reader = new DatabaseSync(file)
  t.after(() => reader.close())
  assert.equal(db.prepare("PRAGMA secure_delete").get().secure_delete, 1)
  assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 2)
  const reason = "PRIVATE_REASON_568AE"
  sql.apply("reason", 1, encodeEvent({ ...report, reason: reason.repeat(600) }))
  assert.equal(contains(file, reason), true)
  reader.exec("BEGIN"); assert.ok(reader.prepare("SELECT body FROM payloads").get())
  sql.apply("seed", 3, encodeEvent(replacement))
  assert.deepEqual(sql.cleanup(), { pending: true })
  assert.equal(contains(file), true, "reader still owns old WAL snapshot")
  assert.ok(db.prepare("SELECT generation>cleaned AS dirty FROM history_privacy").get().dirty)
  const second = openHistoryDatabase(file, "node")
  try {
    assert.deepEqual(second.cleanup(), { pending: true })
    reader.exec("ROLLBACK")
    assert.deepEqual(second.cleanup(), { pending: false })
    assert.equal(contains(file), false)
    assert.equal(contains(file, reason), false)
  } finally { second.close() }
})

test("payload replacement also schedules physical removal of superseded text", t => {
  const { file, sql } = fixture(t)
  sql.apply("seed", 3, encodeEvent({ ...report, payload: { safe: false, completedAt: 2, desc: "Replacement" } } as HistoryEvent))
  assert.deepEqual(sql.cleanup(), { pending: false })
  assert.equal(contains(file), false)
  assert.equal((sql.query({ type: "history", ...conversation }) as any).record.payload.desc, "Replacement")
})

test("concurrent deletion after checkpoint cannot be acknowledged by an older cleanup generation", t => {
  const { file, sql, db } = fixture(t), other = openHistoryDatabase(file, "node")
  t.after(() => other.close())
  const prepare = db.prepare.bind(db)
  let injected = false
  db.prepare = ((text: string) => {
    if (!injected && text.startsWith("UPDATE history_privacy SET cleaned=")) {
      injected = true; other.apply("delete", 1, encodeEvent(replacement))
    }
    return prepare(text)
  }) as typeof db.prepare
  assert.deepEqual(sql.cleanup(), { pending: true })
  assert.deepEqual(sql.cleanup(), { pending: false })
  assert.equal(contains(file), false)
})

test("unprotected writable ancestors reject before a controlled SQLite constructor swap can write replacement storage", t => {
  const dir = directory(t), parent = path.join(dir, "replaceable"), tree = path.join(parent, "state")
  mkdirSync(parent); chmodSync(parent, 0o777); mkdirSync(tree, { mode: 0o700 })
  let constructed = false
  assert.throws(() => openHistoryDatabase(path.join(tree, "private/history-v2.sqlite"), "node", file => {
    constructed = true
    renameSync(tree, tree + "-old"); mkdirSync(tree); mkdirSync(path.dirname(file))
    writeFileSync(file, "replacement", { mode: 0o644 })
    return new DatabaseSync(file)
  }), /ancestor/)
  assert.equal(constructed, false)
  assert.equal(existsSync(path.join(tree, "private")), false)
  assert.equal(existsSync(tree + "-old"), false)
})

test("protected sticky temporary ancestry and private homes permit SQLite and private sidecars", t => {
  const dir = directory(t), sticky = path.join(dir, "sticky")
  mkdirSync(sticky); chmodSync(sticky, 0o1777)
  const file = path.join(sticky, "home/state/private/history-v2.sqlite")
  const sql = openHistoryDatabase(file, "node")
  try {
    sql.apply("seed", 1, encodeEvent(report))
    for (const suffix of ["", "-wal", "-shm"]) assert.equal(statSync(file + suffix).mode & 0o077, 0)
  } finally { sql.close() }
})

for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  for (const kind of ["symlink", "hardlink", "mode", "directory", "owner"] as const) {
    test(`unsafe ${suffix || "database"} ${kind} is rejected without chmod or mutation`, t => {
      const dir = directory(t), privateDir = path.join(dir, "private")
      mkdirSync(privateDir, { mode: 0o700 })
      const file = path.join(privateDir, "history-v2.sqlite"), name = file + suffix, target = path.join(dir, "target")
      writeFileSync(target, "UNTOUCHED", { mode: 0o600 })
      if (kind === "symlink") symlinkSync(target, name)
      else if (kind === "hardlink") linkSync(target, name)
      else if (kind === "directory") mkdirSync(name)
      else writeFileSync(name, "UNCHANGED", { mode: kind === "mode" ? 0o644 : 0o600 })
      const mode = statSync(name).mode
      if (kind === "owner") {
        // Unprivileged tests cannot chown. Inject only the kernel ownership result,
        // retaining actual lstat and file bytes, and verify zero chmod calls.
        const original = fs.lstatSync
        const identity = statSync(name)
        t.mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
          const stat = original(...args)
          if (stat && stat.ino === identity.ino && stat.dev === identity.dev) stat.uid = process.geteuid!() + 1
          return stat
        })
        syncBuiltinESMExports()
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
      }
      let chmod = 0
      t.mock.method(fs, "fchmodSync", () => { chmod++ })
      syncBuiltinESMExports()
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
      assert.throws(() => privateDatabase(file))
      assert.equal(chmod, 0); assert.equal(statSync(name).mode, mode)
      assert.equal(readFileSync(target, "utf8"), "UNTOUCHED")
      if (kind === "mode" || kind === "owner") assert.equal(readFileSync(name, "utf8"), "UNCHANGED")
    })
  }
}

test("foreign-owned ancestors including sticky parents and sticky children are rejected", t => {
  const dir = directory(t), parent = path.join(dir, "parent"), child = path.join(parent, "child")
  mkdirSync(parent); chmodSync(parent, 0o1777); mkdirSync(child, { mode: 0o700 })
  const original = fs.lstatSync
  let foreign = parent
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
    const stat = original(...args)
    if (args[0] === foreign && stat) stat.uid = process.geteuid!() + 1
    return stat
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.throws(() => privateDatabase(path.join(child, "private/history-v2.sqlite")), /ancestor/)
  foreign = child
  assert.throws(() => privateDatabase(path.join(child, "private/history-v2.sqlite")), /ancestor/)
  assert.equal(existsSync(path.join(child, "private")), false)
})

function clock() {
  let now = 0, timer: { call: () => void; at: number } | undefined
  return { now: () => now, schedule: (call: () => void, ms: number) => { timer = { call, at: now + ms }; return 1 as any },
    cancel: () => { timer = undefined }, advance: (ms: number) => {
      now += ms; if (timer && timer.at <= now) { const call = timer.call; timer = undefined; call() }
    } }
}

test("store owns busy cleanup retries independently of write FIFO, including idle recovery and durable disposal", async t => {
  const { dir, file, sql } = fixture(t), reader = new DatabaseSync(file), time = clock()
  t.after(() => reader.close())
  let calls = 0, active = 0, maximum = 0
  const transport: HistoryTransport = { async call(m) {
    active++; maximum = Math.max(maximum, active)
    try {
      if (m.type === "open") return { cleanup: true }
      if (m.type === "apply") return sql.apply(m.writer as string, m.sequence as number, m.event as string)
      if (m.type === "query") return sql.query(m.query as any)
      if (m.type === "cleanup") { calls++; return sql.cleanup() }
      return {}
    } finally { active-- }
  }, async terminate() {} }
  const store = new HistoryStore(dir, { transport: () => transport, ...time })
  t.after(() => store.dispose(performance.now() - 3500))
  reader.exec("BEGIN"); reader.prepare("SELECT body FROM payloads").get()
  store.admit(replacement); await turn()
  assert.equal(calls, 1); assert.equal(store.pendingOperations, 0); assert.equal(store.cleanupPending, true)
  store.admit({ ...accepted, context: { ...context, root: "other", session: "other", review: "other", permission: "other" } })
  await turn(); assert.equal(store.pendingOperations, 0)
  assert.equal((await store.query({ type: "totals" }) as any).totals.safe, 2)
  time.advance(1999); await turn(); assert.equal(calls, 1)
  time.advance(1); await turn(); assert.equal(calls, 2); assert.equal(store.cleanupPending, true)
  reader.exec("ROLLBACK"); time.advance(2000); await turn()
  assert.equal(calls, 3); assert.equal(store.cleanupPending, false); assert.equal(contains(file), false)
  // Another client can leave work behind while this store's local flag is clean.
  sql.apply("idle", 1, encodeEvent({ ...replacement, payload: { ...replacement.payload, desc: "Changed again" } }))
  time.advance(2000); await turn(); assert.equal(calls, 4)
  assert.equal(maximum, 1)
})

test("cleanup watchdog reply race keeps the single slot until actual worker termination", async () => {
  let release!: () => void, exit!: () => void, entered!: () => void
  const held = new Promise<void>(r => { release = r }), exited = new Promise<void>(r => { exit = r })
  const terminating = new Promise<void>(r => { entered = r })
  let calls = 0, workers = 0
  const store = new HistoryStore("/state", { transport: () => {
    workers++
    return { async call(m) {
      calls++
      if (m.type === "open") return { cleanup: true }
      if (m.type === "cleanup") { await held; return { pending: false } }
      return {}
    }, async terminate() { entered(); await exited } }
  } })
  await store.query({ type: "totals" })
  await terminating
  release(); await turn()
  const before = calls
  const read = store.query({ type: "totals" }); void read.catch(() => {})
  await turn(); assert.equal(calls, before); assert.equal(workers, 1)
  const disposal = store.dispose(performance.now() - 3500)
  exit(); await disposal; await assert.rejects(read, /disposed/)
  assert.equal(workers, 1)
})

test("cleanup errors do not poison accounting and disposal leaves durable unfinished cleanup for reopen", async t => {
  const { dir, sql, file } = fixture(t), time = clock()
  let attempts = 0, failures = 0
  const store = new HistoryStore(dir, { ...time, transport: () => ({ async call(m) {
    if (m.type === "open") return { cleanup: true }
    if (m.type === "apply") return sql.apply(m.writer as string, m.sequence as number, m.event as string)
    if (m.type === "query") return sql.query(m.query as any)
    if (m.type === "cleanup") { attempts++; throw Error("checkpoint I/O failure") }
    return {}
  }, async terminate() {} }) })
  store.onWriteFailure(() => { failures++ })
  store.admit(replacement); await turn()
  assert.equal(store.pendingOperations, 0); assert.equal(store.cleanupPending, true)
  assert.equal((await store.query({ type: "totals" }) as any).totals.safe, 1)
  time.advance(1999); await turn(); assert.equal(attempts, 1)
  time.advance(1); await turn(); assert.equal(attempts, 2); assert.equal(failures, 0)
  await store.dispose(performance.now() - 3500)
  const reopened = openHistoryDatabase(file, "node")
  try {
    assert.equal(reopened.db.prepare("SELECT generation>cleaned dirty FROM history_privacy").get().dirty, 1)
    assert.deepEqual(reopened.cleanup(), { pending: false })
    assert.equal(contains(file), false)
  } finally { reopened.close() }
})
