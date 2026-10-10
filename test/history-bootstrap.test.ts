import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { HistorySQL, type HistoryConversationTotals } from "../src/history-schema.js"
import { HistoryStore, HistoryWorker } from "../src/history-store.js"
import { privateDatabase } from "../src/history-storage-worker.js"
import { HISTORY_BOOTSTRAP_STEPS } from "../src/history-migration.js"
import { encodeEvent, rootID, type HistoryEvent } from "../src/history-records.js"
import { largeContext as c, seedLarge } from "./history-large-fixture.js"

test("durable bounded per-review cursor serializes two writers, rollback, replay and deletion", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "history-bootstrap-")), file = path.join(directory, "history.sqlite")
  const db = new DatabaseSync(file), first = new HistorySQL(db), second = new HistorySQL(new DatabaseSync(file))
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }) })
  seedLarge(db, 2000, 20000, false, 4000)
  const root = rootID(c), event: HistoryEvent = { type: "attemptFinalized", context: c, at: 10, attempt: "new", usage: { input: 7, output: 3 } }
  const deletion = encodeEvent({ type: "sessionDeleted", context: { scope: c.scope, root: c.root, session: c.session }, at: 11 })
  assert.deepEqual(first.applyReady("a", 1, encodeEvent(event)), { pending: root })
  assert.deepEqual(second.applyReady("b", 1, deletion), { pending: root })
  const lifetime = first.query({ type: "totals" })
  let slices = 0, maximum = 0, sawAttempts = false, interruptedAttempts = false
  for (;;) {
    const sql = slices % 2 ? first : second
    const before = db.prepare("SELECT * FROM conversation_bootstrap").all()
    if (!interruptedAttempts && before[0]?.phase === 1 && before[0]?.after) {
      assert.throws(() => sql.bootstrap(root, () => { throw Error("interrupted transaction") }))
      assert.deepEqual(db.prepare("SELECT * FROM conversation_bootstrap").all(), before)
      interruptedAttempts = true
    }
    const result = sql.bootstrap(root); slices++; maximum = Math.max(maximum, result.steps)
    const cursor = db.prepare("SELECT * FROM conversation_bootstrap").get()
    if (cursor?.phase === 1 && cursor.after) sawAttempts = true
    assert.deepEqual(first.query({ type: "totals" }), lifetime, "bootstrap never reconstructs lifetime")
    if (result.done) break
    assert.deepEqual(second.applyReady("b", 1, deletion), { pending: root }, "deletion cannot remove the scan's snapshot")
    assert.equal(db.prepare("SELECT count(*) n FROM writers").get()!.n, 0)
  }
  assert.ok(sawAttempts); assert.ok(interruptedAttempts); assert.ok(slices > 200); assert.ok(maximum <= HISTORY_BOOTSTRAP_STEPS)
  assert.deepEqual(first.applyReady("a", 1, encodeEvent(event)), { replay: false })
  assert.deepEqual(second.applyReady("a", 1, encodeEvent(event)), { replay: true })
  assert.deepEqual(second.apply("b", 1, deletion), { replay: false })
  const totals = first.query({ type: "conversationTotals", scope: c.scope, root: c.root }) as HistoryConversationTotals
  assert.equal(totals.totals.safe, 2000); assert.equal(totals.totals.input, 20007)
  assert.equal(totals.totals.activity.retries, 20000); assert.equal(totals.partialHistory, true)
  assert.equal(totals.totals.activity.autoApproved, 4000)
  assert.equal(db.prepare("SELECT count(*) n FROM reviews").get()!.n, 0)
  assert.equal((first.query({ type: "totals" }) as any).totals.input, 7)
  t.diagnostic(`26000 retained rows: ${slices} transactions, maximum ${maximum} steps`)
})

test("80k legacy reviews progress under the actual watchdog after interrupted slow source worker, then FIFO deletion and unrelated root commit", { timeout: 120000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "history-slow-bootstrap-")), file = path.join(directory, "opencode-reviewer/history-v1.sqlite")
  privateDatabase(file)
  const db = new DatabaseSync(file), seed = new HistorySQL(db)
  seedLarge(db, 80000, 10000)
  const originalLifetime = seed.query({ type: "totals" })
  const bundle = await build({ entryPoints: ["src/history-storage-worker.ts"], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["bun:sqlite", "node:sqlite"] })
  // Slow real SQLite reads, and once stall a slice before COMMIT beyond the real
  // 3s watchdog. The replacement loads the actual production worker unchanged.
  const instrumentation = (interrupt: boolean) => `
    const sqlite = require('node:sqlite');
    const prepare = sqlite.DatabaseSync.prototype.prepare, exec = sqlite.DatabaseSync.prototype.exec;
    let reads=0, slices=0, bootstrapWrite=false;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    sqlite.DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (/FROM (reviews|attempts) WHERE .*id>.*LIMIT 1/.test(sql)) {
        const get=statement.get.bind(statement);
        statement.get=(...args)=>{if(++reads%8===0) Atomics.wait(wait,0,0,1); return get(...args)};
      }
      if(sql.includes('INSERT INTO conversation_bootstrap VALUES')) {
        const run=statement.run.bind(statement);
        statement.run=(...args)=>{bootstrapWrite=true;return run(...args)};
      }
      return statement;
    };
    sqlite.DatabaseSync.prototype.exec=function(sql) {
      if(sql==='COMMIT' && bootstrapWrite) {
        bootstrapWrite=false;
        if(++slices===10 && ${interrupt}) Atomics.wait(wait,0,0,10000);
      }
      return exec.call(this,sql);
    };
  `
  let workers = 0, active = 0, maximumActive = 0, slices = 0, maximumSteps = 0, maximumSliceMs = 0, cursorAtRestart: any
  const errors: string[] = []
  const store = new HistoryStore(directory, { adapter: "node", transport: () => {
    if (workers) cursorAtRestart = db.prepare("SELECT * FROM conversation_bootstrap").get()
    const worker = new HistoryWorker(instrumentation(workers++ === 0) + bundle.outputFiles[0]!.text)
    return { async call(message: Record<string, unknown>) {
      active++; maximumActive = Math.max(maximumActive, active)
      const start = performance.now()
      try {
        const result = await worker.call(message)
        if (message.type === "bootstrap") {
          slices++; maximumSteps = Math.max(maximumSteps, result.steps); maximumSliceMs = Math.max(maximumSliceMs, performance.now() - start)
        }
        return result
      } catch (error) { errors.push(`${message.type}: ${String(error)}`); throw error
      } finally { active-- }
    }, terminate: () => worker.terminate() }
  } })
  t.after(async () => { await store.dispose(performance.now() - 3500); seed.close(); rmSync(directory, { recursive: true, force: true }) })
  const start = performance.now()
  store.admit({ type: "reviewAccepted", context: { ...c, review: "new", permission: "new" }, at: 1, accepted: { safe: false, completedAt: 1 } })
  store.admit({ type: "sessionDeleted", context: { scope: c.scope, root: c.root, session: c.session }, at: 2 })
  store.admit({ type: "attemptFinalized", context: { ...c, root: "other", session: "other", review: "other", permission: "other" }, at: 3, attempt: "a", usage: { input: 9, output: 1 } })
  let readDuringBootstrap = false
  while (store.pendingOperations && performance.now() - start < 100000) {
    if (errors.length > 3) break
    if (!readDuringBootstrap && slices > 15) {
      assert.equal((await store.query({ type: "history", scope: c.scope, root: "other" }) as any).total, 0)
      assert.deepEqual(seed.query({ type: "totals" }), originalLifetime)
      readDuringBootstrap = true
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  t.diagnostic(JSON.stringify({ workers, slices, errors, cursor: db.prepare("SELECT review,phase,after FROM conversation_bootstrap").get() }))
  assert.equal(store.pendingOperations, 0); assert.equal(maximumActive, 1); assert.equal(workers, 2)
  assert.ok(cursorAtRestart?.review); assert.ok(readDuringBootstrap); assert.ok(slices > 1900)
  assert.ok(maximumSteps <= HISTORY_BOOTSTRAP_STEPS); assert.ok(maximumSliceMs < 2000)
  const conversation = await store.query({ type: "conversationTotals", scope: c.scope, root: c.root }) as HistoryConversationTotals
  assert.equal(conversation.totals.safe, 80000); assert.equal(conversation.totals.unsafe, 1)
  assert.equal(conversation.totals.input, 10000); assert.equal(conversation.totals.activity.retries, 10000)
  const lifetime = await store.query({ type: "totals" }) as any
  assert.equal(lifetime.totals.safe, 0); assert.equal(lifetime.totals.unsafe, 1); assert.equal(lifetime.totals.input, 9)
  assert.equal(db.prepare("SELECT count(*) n FROM reviews WHERE root=?").get(rootID(c))!.n, 0)
  t.diagnostic(`80k reviews + 10k attempts: ${slices} committed slices; max ${maximumSteps} steps / ${maximumSliceMs.toFixed(1)}ms; ${(performance.now() - start).toFixed(0)}ms including watchdog + retry`)
})
