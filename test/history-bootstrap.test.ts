import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { HistoryStore, HistoryWorker } from "../src/history-store.js"
import { privateDatabase } from "../src/history-storage-worker.js"
import { HistorySQL } from "../src/history-schema.js"
import { largeContext, seedLarge } from "./history-large-fixture.js"
import { rootID } from "../src/history-records.js"
import { empty } from "../src/lifetime.js"

test("a stalled transaction on a large database is rolled back by the real watchdog and replayed once", { timeout: 120000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "history-watchdog-"))
  const file = path.join(directory, "opencode-reviewer/history-v2.sqlite")
  privateDatabase(file)
  const db = new DatabaseSync(file), sql = new HistorySQL(db)
  t.after(() => { sql.close(); rmSync(directory, { recursive: true, force: true }) })
  seedLarge(db, 80000, 10000)
  const totals = empty()
  totals.safe = totals.activity.reviews = 80000
  totals.activity.since = totals.ratingsSince = 1
  db.prepare("UPDATE meta SET totals=?").run(JSON.stringify(totals))
  db.prepare("INSERT INTO conversation_totals VALUES (?,?)").run(rootID(largeContext), JSON.stringify(totals))
  const bundle = await build({ entryPoints: ["src/history-storage-worker.ts"], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["bun:sqlite", "node:sqlite"] })
  const stall = `
    const sqlite = require("node:sqlite").DatabaseSync.prototype
    const exec = sqlite.exec
    let commits = 0
    sqlite.exec = function (statement) {
      if (statement === "COMMIT" && ++commits === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      return exec.call(this, statement)
    }
  `
  let workers = 0, failures = 0
  const store = new HistoryStore(directory, { adapter: "node", transport: () =>
    new HistoryWorker((workers++ === 0 ? stall : "") + bundle.outputFiles[0]!.text) })
  t.after(() => store.dispose())
  const committed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Replay did not commit")), 10000)
    store.onCommit(() => { clearTimeout(timeout); resolve() })
  })
  const failed = new Promise<void>(resolve => { store.onWriteFailure(() => { failures++; resolve() }) })
  const start = performance.now()
  assert.ok(store.admit({ type: "attemptFinalized", context: largeContext, at: 2, attempt: "new", usage: { input: 9, output: 1 } }))
  await failed
  assert.ok(performance.now() - start >= 3000)
  assert.equal(db.prepare("SELECT count(*) AS n FROM writers").get()!.n, 0)
  await committed
  assert.equal(workers, 2)
  assert.equal(failures, 1)
  assert.equal(store.pendingOperations, 0)
  const result = await store.query({ type: "totals", conversation: { root: largeContext.root } })
  assert.ok("conversation" in result)
  assert.deepEqual(result.conversation?.totals, result.totals)
  assert.equal(result.totals.input, 9)
  assert.equal(result.totals.activity.reviews, 80000)
  assert.equal(db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 10001)
})
