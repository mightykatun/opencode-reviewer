import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { openHistoryDatabase } from "../src/history-storage-worker.js"
import { HistoryStore, HistoryWorker } from "../src/history-store.js"
import { HISTORY_SCRUB_BYTES, HISTORY_SCRUB_STEPS } from "../src/history-legacy-scrub.js"
import { encodeEvent, reviewID } from "../src/history-records.js"
import type { HistoryEvent, HistoryReview } from "../src/history-records.js"

const context: HistoryReview = { scope: "/legacy", root: "root", session: "root", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const accepted: HistoryEvent = { type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } }
const marker = "LEGACY_FREELIST_PRIVATE_MARKER_21a76e"
const open = (file: string) => openHistoryDatabase(file, "node", name => new DatabaseSync(name))
const contains = (file: string, text: string) => ["", "-wal", "-shm", "-journal"].filter(suffix => existsSync(file + suffix))
  .some(suffix => readFileSync(file + suffix).includes(Buffer.from(text)))

function liveSeed(t: any, rows = 8) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-live-privacy-")), file = path.join(dir, "opencode-reviewer/history-v1.sqlite")
  const sql = open(file), db = sql.db, contexts: HistoryReview[] = []
  t.after(() => { sql.close(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < rows; i++) {
    const c = { ...context, permission: i === 4 ? marker : `permission-${i}`, review: `review-${i}`, session: `child-${i}` }
    contexts.push(c)
    sql.apply("seed", i * 2 + 1, encodeEvent({ ...accepted, context: c }))
    sql.apply("seed", i * 2 + 2, encodeEvent({ type: "permissionResolved", context: c, at: 2, outcome: "manual",
      payload: { safe: true, completedAt: 1, desc: i === 4 ? marker.repeat(3) : `live-${i}` } }))
  }
  db.exec("PRAGMA secure_delete=OFF")
  db.prepare("DELETE FROM history WHERE id=?").run(reviewID(contexts[4]!))
  db.prepare("DELETE FROM reviews WHERE id=?").run(reviewID(contexts[4]!))
  db.exec("UPDATE history_privacy SET legacy=1,generation=generation+1; PRAGMA wal_checkpoint(TRUNCATE)")
  assert.equal(contains(file, marker), true)
  return { dir, file, sql, db, contexts }
}

function finish(sql: ReturnType<typeof open>, limit = 5000) {
  for (let slices = 1; slices <= limit; slices++) if (!sql.cleanup().pending) return slices
  assert.fail("legacy cleanup did not settle")
}

/** Prove the marker is in a linked freeblock of the named LIVE b-tree root. */
function markedFreeblock(file: string, page: number, text: string) {
  const bytes = readFileSync(file), size = bytes.readUInt16BE(16), offset = (page - 1) * size
  let block = bytes.readUInt16BE(offset + 1)
  while (block) {
    const length = bytes.readUInt16BE(offset + block + 2)
    if (bytes.subarray(offset + block, offset + block + length).includes(Buffer.from(text))) return true
    block = bytes.readUInt16BE(offset + block)
  }
  return false
}

test("automatic rebuild erases zero-freelist live table AND index freeblocks with shared snapshots, replay and totals intact", t => {
  const { file, db, sql, contexts } = liveSeed(t)
  assert.equal(db.prepare("PRAGMA freelist_count").get().freelist_count, 0)
  const payloadRoot = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='payloads'").get().rootpage
  const indexRoot = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='sqlite_autoindex_history_2'").get().rootpage
  assert.equal(markedFreeblock(file, payloadRoot, marker), true)
  assert.equal(markedFreeblock(file, indexRoot, marker), true)
  const totals = sql.query({ type: "totals", conversation: { scope: context.scope, root: context.root } })
  const first = open(file), reader = new DatabaseSync(file)
  t.after(() => { first.close(); reader.close() })
  reader.exec("BEGIN")
  assert.equal(reader.prepare("SELECT count(*) n FROM payloads").get()!.n, 7)
  let slices = 0
  while (true) {
    const result = first.cleanup()
    // Busy-reader checkpoint is the only work left once all b-trees were rebuilt.
    if (!result.scrubbing) { assert.deepEqual(result, { pending: true, legacy: false }); break }
    assert.ok(++slices < 100)
    assert.deepEqual(sql.query({ type: "totals", conversation: { scope: context.scope, root: context.root } }), totals)
    assert.equal((sql.query({ type: "history", scope: context.scope, root: context.root }) as any).total, 7)
    assert.deepEqual(sql.apply("seed", 1, encodeEvent({ ...accepted, context: contexts[0]! })), { replay: true })
    assert.equal(reader.prepare("SELECT count(*) n FROM payloads").get()!.n, 7, "old reader retains consistent snapshot across cutovers")
  }
  assert.equal(contains(file, marker), true, "old frames cannot be erased while a reader owns them")
  reader.exec("ROLLBACK")
  assert.deepEqual(first.cleanup(), { pending: false, legacy: false })
  assert.equal(contains(file, marker), false)
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [])
  const reopened = open(file)
  try {
    assert.deepEqual(reopened.cleanup(), { pending: false, legacy: false })
    assert.deepEqual(reopened.query({ type: "totals", conversation: { scope: context.scope, root: context.root } }), totals)
    assert.equal(contains(file, marker), false)
    // No duplicate, unbounded startup index builds after alternate-name cutover.
    const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='history' AND sql IS NOT NULL").all()
    assert.equal(indexes.length, 7)
    assert.ok(indexes.some(index => index.name === "history_rebuilt_history_review"))
    assert.ok(indexes.every(index => index.name.startsWith("history_rebuilt_")))
  } finally { reopened.close() }
  t.diagnostic(JSON.stringify({ zeroFreelist: true, tableFreeblock: true, indexFreeblock: true, slices }))
})

test("copy mirrors concurrent updates, inserts behind and beyond cursor, cascaded deletion and reopen at every phase", t => {
  const { file, db, contexts } = liveSeed(t, 40)
  let cleaner = open(file), client = open(file), mutated = false, reopened = false
  t.after(() => { cleaner.close(); client.close() })
  const replacement = "CONCURRENT_REPLACEMENT_SURVIVES"
  const removed = "CONCURRENT_DELETION_MUST_ERASE"
  let steps = 0, rollbacks = 0
  for (;;) {
    const state = db.prepare("SELECT * FROM history_legacy_rebuild").get()
    const mirroring = db.prepare("SELECT tbl_name FROM sqlite_schema WHERE name='history_legacy_insert'").get()?.tbl_name
    if (mirroring === "payloads" && state.cursor !== null && !mutated) {
      const c = contexts[0]!
      client.apply("mutate", 1, encodeEvent({ type: "permissionResolved", context: c, at: 3, outcome: "manual",
        payload: { safe: false, completedAt: 3, desc: replacement } }))
      client.apply("mutate", 2, encodeEvent({ type: "permissionResolved", context: contexts[1]!, at: 3, outcome: "manual",
        payload: { safe: true, completedAt: 3, desc: removed } }))
      client.apply("mutate", 3, encodeEvent({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: contexts[1]!.session }, at: 4 }))
      const fresh = { ...context, permission: "fresh", review: "fresh", session: "fresh" }
      client.apply("mutate", 4, encodeEvent({ type: "permissionResolved", context: fresh, at: 5, outcome: "manual",
        payload: { safe: true, completedAt: 5, desc: "APPENDED_DURING_COPY" } }))
      // Explicit rowid reuse behind the cursor exercises SQLite trigger semantics
      // as well as the application-level cascaded delete above.
      const saved = db.prepare("SELECT rowid AS n,body,id FROM payloads ORDER BY rowid LIMIT 1").get()
      db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE")
      db.prepare("DELETE FROM payloads WHERE id=?").run(saved.id)
      db.prepare("INSERT INTO payloads(rowid,id,body) VALUES (?,?,?)").run(saved.n, saved.id, saved.body)
      db.exec("COMMIT")
      mutated = true
    }
    const before = db.prepare("SELECT * FROM history_legacy_rebuild").get()
    if (steps % 7 === 0 && before.position < 16) {
      assert.throws(() => cleaner.cleanup(() => { throw Error("crash before commit") }), /crash before commit/)
      assert.deepEqual(db.prepare("SELECT * FROM history_legacy_rebuild").get(), before)
      assert.equal(cleaner.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1)
      rollbacks++
    }
    const result = cleaner.cleanup()
    if (!result.pending) break
    if (before.phase !== db.prepare("SELECT phase FROM history_legacy_rebuild").get().phase) {
      cleaner.close(); cleaner = open(file)
      client.close(); client = open(file)
      reopened = true
    }
    assert.ok(++steps < 400)
  }
  assert.equal(mutated, true); assert.equal(reopened, true); assert.ok(rollbacks > 5)
  assert.equal(contains(file, marker), false); assert.equal(contains(file, removed), false)
  assert.equal((client.query({ type: "history", scope: context.scope, root: context.root, entry: reviewID(contexts[0]!) }) as any).record.payload.desc, replacement)
  assert.equal(db.prepare("SELECT count(*) n FROM payloads").get().n, 39)
  assert.equal(db.prepare("SELECT count(*) n FROM tombstones").get().n, 1)
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [])
  assert.deepEqual(client.apply("mutate", 4, encodeEvent(accepted)), { replay: true })
})

test("large live rows and slow copies yield bounded durable slices, then retire indexes without full scans", t => {
  const { file, db } = liveSeed(t, 160), cleaner = open(file)
  t.after(() => cleaner.close())
  db.exec("PRAGMA secure_delete=ON")
  const large = JSON.stringify({ safe: true, completedAt: 1, desc: "x".repeat(65536) })
  db.prepare("UPDATE payloads SET body=?").run(large)
  let slices = 0
  while (db.prepare("SELECT tbl_name FROM sqlite_schema WHERE name='history_legacy_insert'").get()?.tbl_name !== "payloads") {
    cleaner.cleanup(); assert.ok(++slices < 600)
  }
  const prepare = cleaner.db.prepare.bind(cleaner.db), wait = new Int32Array(new SharedArrayBuffer(4))
  let copies = 0, slow = true, maximum = 0, maximumMs = 0
  cleaner.db.prepare = (sql: string) => {
    const statement = prepare(sql)
    if (sql.startsWith("INSERT INTO history_legacy_copy(rowid,")) {
      const run = statement.run.bind(statement)
      statement.run = (...args: any[]) => { const result = run(...args); copies++; if (slow) Atomics.wait(wait, 0, 0, 60); return result }
    }
    return statement
  }
  for (let i = 0; i < 3; i++) {
    copies = 0
    const start = performance.now()
    assert.equal(cleaner.cleanup().scrubbing, true)
    const ms = performance.now() - start; maximumMs = Math.max(maximumMs, ms)
    assert.equal(copies, 1, "time budget is checked between rows, not only after eight copies")
    assert.ok(ms < 3000)
  }
  slow = false
  while (db.prepare("SELECT tbl_name FROM sqlite_schema WHERE name='history_legacy_insert'").get()?.tbl_name === "payloads") {
    copies = 0; cleaner.cleanup(); maximum = Math.max(maximum, copies)
    assert.ok(copies <= HISTORY_SCRUB_STEPS)
    assert.ok(++slices < 1000)
  }
  finish(cleaner)
  assert.equal(contains(file, marker), false)
  assert.equal(db.prepare("SELECT count(*) n FROM payloads WHERE body=?").get(large).n, 159)
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  t.diagnostic(JSON.stringify({ livePayloadBytes: Buffer.byteLength(large) * 159, maximumRows: maximum, maximumSlowSliceMs: maximumMs }))
})

test("production worker watchdog rolls back a live-table cutover and the store resumes automatically with concurrent accounting", { timeout: 30000 }, async t => {
  const { dir, file, db } = liveSeed(t, 40)
  const bundle = await build({ entryPoints: ["src/history-storage-worker.ts"], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["bun:sqlite", "node:sqlite"] })
  const instrument = `const sqlite=require('node:sqlite'), exec=sqlite.DatabaseSync.prototype.exec;
    let swapping=false;const wait=new Int32Array(new SharedArrayBuffer(4));
    sqlite.DatabaseSync.prototype.exec=function(sql) {
      if(sql.startsWith('ALTER TABLE "payloads"'))swapping=true;
      if(sql==='COMMIT'&&swapping)Atomics.wait(wait,0,0,10000);
      return exec.call(this,sql);
    };`
  let workers = 0, active = 0, maximum = 0, interrupted = false
  const store = new HistoryStore(dir, { adapter: "node", transport: () => {
    if (workers) {
      assert.equal(db.prepare("SELECT tbl_name FROM sqlite_schema WHERE name='history_legacy_insert'").get()?.tbl_name, "payloads")
      assert.equal(db.prepare("SELECT count(*) n FROM payloads").get().n, 39)
      interrupted = true
    }
    const worker = new HistoryWorker((workers++ ? "" : instrument) + bundle.outputFiles[0]!.text)
    return { async call(message: Record<string, unknown>) {
      active++; maximum = Math.max(maximum, active)
      try { return await worker.call(message) } finally { active-- }
    }, terminate: () => worker.terminate() }
  } })
  t.after(() => store.dispose(performance.now() - 3500))
  assert.equal((await store.query({ type: "totals" }) as any).totals.safe, 40)
  assert.equal(store.admit({ ...accepted, context: { ...context, root: "other", session: "other", permission: "other", review: "other" } }), true)
  const end = performance.now() + 20000
  while ((!interrupted || store.cleanupPending || store.pendingOperations) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(interrupted, true); assert.equal(workers, 2); assert.equal(maximum, 1)
  assert.equal(store.cleanupPending, false); assert.equal(store.legacyCleanupRequired, false)
  assert.equal((await store.query({ type: "totals" }) as any).totals.safe, 41)
  assert.equal(contains(file, marker), false)
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  const start = performance.now(); await store.dispose(start)
  assert.ok(performance.now() - start < 3500)
})

/** Inspect only test-owned checkpointed files, never mutate raw database pages. */
function freelist(file: string) {
  const bytes = readFileSync(file), size = bytes.readUInt16BE(16) || 65536
  const pageSize = size === 1 ? 65536 : size
  const pages = new Set<number>()
  let trunk = bytes.readUInt32BE(32)
  while (trunk) {
    assert.equal(pages.has(trunk), false)
    pages.add(trunk)
    const offset = (trunk - 1) * pageSize, count = bytes.readUInt32BE(offset + 4)
    assert.ok(count <= (pageSize - 8) / 4)
    for (let n = 0; n < count; n++) pages.add(bytes.readUInt32BE(offset + 8 + n * 4))
    trunk = bytes.readUInt32BE(offset)
  }
  assert.equal(pages.size, bytes.readUInt32BE(36))
  const marked = [...pages].filter(page => bytes.subarray((page - 1) * pageSize, page * pageSize).includes(Buffer.from(marker)))
  return { marked, pageSize, total: pages.size }
}

function seed(t: any, rows = 256) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-legacy-privacy-")), file = path.join(dir, "opencode-reviewer/history-v1.sqlite")
  const sql = open(file), db = sql.db
  t.after(() => { sql.close(); rmSync(dir, { recursive: true, force: true }) })
  sql.apply("seed", 1, encodeEvent(accepted))
  sql.apply("seed", 2, encodeEvent({ type: "permissionResolved", context, at: 2, outcome: "manual",
    payload: { safe: true, completedAt: 1, desc: "LIVE_REPORT_MUST_SURVIVE" } }))
  sql.apply("tombstone", 1, encodeEvent({ type: "sessionDeleted", context: { scope: context.scope, root: "gone", session: "gone" }, at: 3 }))
  db.exec(`DROP TRIGGER history_privacy_delete; DROP TRIGGER history_privacy_replace; DROP TABLE history_privacy;
    PRAGMA secure_delete=OFF; CREATE TABLE legacy_discard (id INTEGER PRIMARY KEY, body TEXT); BEGIN`)
  const insert = db.prepare("INSERT INTO legacy_discard VALUES (?,?)"), text = marker.repeat(3000)
  for (let n = 0; n < rows; n++) insert.run(n, text)
  db.exec("COMMIT; DROP TABLE legacy_discard; PRAGMA wal_checkpoint(TRUNCATE)")
  const free = freelist(file)
  assert.ok(free.marked.length > 0)
  assert.equal(db.prepare("PRAGMA auto_vacuum").get().auto_vacuum, 0)
  return { dir, file, sql, db, free }
}

function assertErased(file: string, free: ReturnType<typeof freelist>) {
  const bytes = readFileSync(file)
  for (const page of free.marked)
    assert.equal(bytes.subarray((page - 1) * free.pageSize, page * free.pageSize).includes(Buffer.from(marker)), false, `freelist page ${page}`)
  for (const suffix of ["-wal", "-shm"])
    assert.equal(readFileSync(file + suffix).includes(Buffer.from(marker)), false, suffix)
}

test("automatic legacy freelist scrub is bounded, durable, rollback-safe and shared without changing live rows or replay", t => {
  const { file, sql, db, free } = seed(t), first = open(file), second = open(file)
  t.after(() => { first.close(); second.close() })
  const totals = first.query({ type: "totals", conversation: { scope: context.scope, root: context.root } })
  const originalPages = db.prepare("PRAGMA page_count").get().page_count
  const state = () => ({ phase: db.prepare("SELECT phase FROM history_legacy_scrub").get().phase,
    rows: db.prepare("SELECT count(*) n FROM history_legacy_padding").get().n, free: db.prepare("PRAGMA freelist_count").get().freelist_count,
    generation: db.prepare("SELECT generation FROM history_privacy").get().generation })
  const before = state()
  assert.throws(() => first.cleanup(() => { throw Error("interrupted scrub") }), /interrupted/)
  assert.deepEqual(state(), before)
  let slices = 0, maximumMs = 0, maximumDelta = 0, maximumPages = originalPages
  const start = performance.now()
  for (;;) {
    const before = state(), at = performance.now(), result = (slices % 2 ? first : second).cleanup()
    maximumMs = Math.max(maximumMs, performance.now() - at)
    const after = state(), delta = Math.abs(after.rows - before.rows)
    maximumDelta = Math.max(maximumDelta, delta)
    maximumPages = Math.max(maximumPages, db.prepare("PRAGMA page_count").get().page_count)
    assert.ok(delta <= HISTORY_SCRUB_STEPS)
    if (after.phase === 0) assert.ok(after.free < before.free, "reservation must consume pages instead of recycling clean pages")
    if (!result.pending) { assert.equal(result.legacy, false); break }
    assert.equal(result.scrubbing, true)
    assert.ok(++slices < 300)
  }
  assert.ok(slices > 50)
  assert.equal(state().phase, 2); assert.equal(state().rows, 0)
  assertErased(file, free)
  assert.deepEqual(first.query({ type: "totals", conversation: { scope: context.scope, root: context.root } }), totals)
  assert.equal((second.query({ type: "history", scope: context.scope, root: context.root }) as any).record.payload.desc, "LIVE_REPORT_MUST_SURVIVE")
  assert.deepEqual(second.apply("seed", 1, encodeEvent(accepted)), { replay: true })
  assert.equal(db.prepare("SELECT count(*) n FROM tombstones").get().n, 1)
  assert.equal(sql.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  t.diagnostic(JSON.stringify({ freedPages: free.total, markedPages: free.marked.length, pageSize: free.pageSize,
    slices, maximumRows: maximumDelta, maximumBlobBytes: HISTORY_SCRUB_BYTES, maximumSliceMs: maximumMs,
    fileGrowthPages: maximumPages - originalPages, totalMs: performance.now() - start }))
})

test("normal store resumes legacy freelist cleanup after a real watchdog interruption without blocking unrelated accounting", { timeout: 40000 }, async t => {
  const { dir, file, db, free } = seed(t)
  const bundle = await build({ entryPoints: ["src/history-storage-worker.ts"], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["bun:sqlite", "node:sqlite"] })
  const instrument = (interrupt: boolean) => `
    const sqlite=require('node:sqlite'), prepare=sqlite.DatabaseSync.prototype.prepare, exec=sqlite.DatabaseSync.prototype.exec;
    let reservation=false, slices=0;
    const wait=new Int32Array(new SharedArrayBuffer(4));
    sqlite.DatabaseSync.prototype.prepare=function(sql) {
      const s=prepare.call(this,sql);
      if(sql.startsWith('INSERT INTO history_legacy_padding')) {
        const run=s.run.bind(s);s.run=(...args)=>{reservation=true;return run(...args)};
      }
      return s;
    };
    sqlite.DatabaseSync.prototype.exec=function(sql) {
      if(sql==='COMMIT'&&reservation) {reservation=false;if(++slices===3&&${interrupt}) Atomics.wait(wait,0,0,10000)};
      return exec.call(this,sql);
    };
  `
  let workers = 0, calls = 0, active = 0, maximumActive = 0, maximumMs = 0, resumes = 0
  const errors: string[] = []
  const store = new HistoryStore(dir, { adapter: "node", transport: () => {
    if (workers) {
      resumes = db.prepare("SELECT count(*) n FROM history_legacy_padding").get().n
      assert.ok(resumes > 0, "replacement resumes committed reservations")
    }
    const worker = new HistoryWorker(instrument(workers++ === 0) + bundle.outputFiles[0]!.text)
    return { async call(m: Record<string, unknown>) {
      active++; maximumActive = Math.max(maximumActive, active)
      const start = performance.now()
      try {
        const result = await worker.call(m)
        if (m.type === "cleanup") { calls++; maximumMs = Math.max(maximumMs, performance.now() - start) }
        return result
      } catch (error) { errors.push(`${m.type}: ${String(error)}`); throw error }
      finally { active-- }
    }, terminate: () => worker.terminate() }
  } })
  t.after(() => store.dispose(performance.now() - 3500))
  const start = performance.now()
  assert.equal((await store.query({ type: "totals" }) as any).totals.safe, 1)
  store.admit({ ...accepted, context: { ...context, root: "other", session: "other", review: "other", permission: "other" } })
  while ((calls < 3 || store.cleanupPending || store.pendingOperations) && performance.now() - start < 30000)
    await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(store.cleanupPending, false); assert.equal(store.pendingOperations, 0)
  assert.equal(workers, 2); assert.equal(maximumActive, 1)
  assert.deepEqual(errors, ["cleanup: Error: History worker exited"])
  assert.equal((await store.query({ type: "totals" }) as any).totals.safe, 2)
  assert.equal(store.legacyCleanupRequired, false)
  assertErased(file, free)
  t.diagnostic(JSON.stringify({ workers, successfulCleanupCalls: calls, resumedPaddingRows: resumes, maximumSuccessfulCallMs: maximumMs,
    totalMs: performance.now() - start, errors }))
})

test("NONE cannot become incremental vacuum without a rebuild and incremental vacuum does not erase live-page fragments", t => {
  const { db, file } = seed(t, 1)
  db.exec("PRAGMA auto_vacuum=INCREMENTAL")
  assert.equal(db.prepare("PRAGMA auto_vacuum").get().auto_vacuum, 0)
  const before = db.prepare("PRAGMA freelist_count").get().freelist_count
  db.exec("PRAGMA incremental_vacuum(8)")
  assert.equal(db.prepare("PRAGMA freelist_count").get().freelist_count, before)
  // A separate tiny database isolates the active-page case with NO freelist.
  const memory = new DatabaseSync(file + ".tiny")
  try {
    memory.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA secure_delete=OFF; CREATE TABLE x(id INTEGER PRIMARY KEY,body TEXT)")
    const insert = memory.prepare("INSERT INTO x VALUES (?,?)")
    for (let i = 0; i < 40; i++) insert.run(i, i === 20 ? marker : `live-${i}`)
    memory.exec("DELETE FROM x WHERE id=20; PRAGMA secure_delete=ON; PRAGMA incremental_vacuum(8); UPDATE x SET body=body")
    assert.equal(memory.prepare("PRAGMA freelist_count").get()!.freelist_count, 0)
    assert.ok(readFileSync(file + ".tiny").includes(Buffer.from(marker)), "zero freelist and no-op updates still leave deleted plaintext")
    assert.equal(memory.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok")
  } finally { memory.close() }
})
