import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { openHistoryDatabase } from "../src/history-storage-worker.js"
import { HistoryStore, HistoryWorker } from "../src/history-store.js"
import { HISTORY_SCRUB_BYTES, HISTORY_SCRUB_STEPS } from "../src/history-legacy-scrub.js"
import { encodeEvent } from "../src/history-records.js"
import type { HistoryEvent, HistoryReview } from "../src/history-records.js"

const context: HistoryReview = { scope: "/legacy", root: "root", session: "root", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const accepted: HistoryEvent = { type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } }
const marker = "LEGACY_FREELIST_PRIVATE_MARKER_21a76e"
const open = (file: string) => openHistoryDatabase(file, "node", name => new DatabaseSync(name))

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
  db.exec("COMMIT; DELETE FROM legacy_discard; PRAGMA wal_checkpoint(TRUNCATE)")
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
    if (!result.pending) { assert.equal(result.legacy, true, "live-page legacy fragments remain outside this proof"); break }
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
  assert.equal(store.legacyCleanupRequired, true, "freelist cleanup cannot certify live-page fragments")
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
