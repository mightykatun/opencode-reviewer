import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistorySQL, type HistoryDatabase, type HistorySelection } from "../src/history-schema.js"
import { encodeEvent, entryID, reviewID, rootID, sessionID, type HistoryReview } from "../src/history-records.js"

const context: HistoryReview = { scope: "/legacy", root: "root", session: "root", permission: "p", review: "r",
  category: "bash", configuredModel: "model", provider: "https://example.com" }
const query = { type: "history" as const, scope: context.scope, root: context.root }

function fixture(t: TestContext, count = 1) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-report-migration-")), file = path.join(dir, "history.sqlite")
  const db = new DatabaseSync(file), sql = new HistorySQL(db), clients = [sql]
  t.after(() => { for (const client of clients) client.close(); rmSync(dir, { recursive: true, force: true }) })
  // Seed actual old IDs and schema, including gaps in rowids used by resumable
  // maintenance. No production migration reads or reconstructs report bodies.
  for (let n = 0; n < count; n++) {
    const c = n ? { ...context, permission: `p${n}`, review: `r${n}` } : context
    sql.apply("seed", n + 1, encodeEvent({ type: "reviewAccepted", context: c, at: n + 1,
      accepted: { safe: true, completedAt: n + 1 } }))
    db.prepare("INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(entryID(c), c.scope, rootID(c), sessionID(c),
      c.permission, n + 1, c.review, reviewID(c), "manual", "manual", null, n + 2, entryID(c))
    db.prepare("UPDATE history SET rowid=? WHERE id=?").run((n + 1) * 10, entryID(c))
    db.prepare("INSERT INTO payloads VALUES (?,?)").run(entryID(c), JSON.stringify({ safe: true, completedAt: n + 1, desc: `legacy ${n}` }))
  }
  const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name='history'").get()!.sql as string
  const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='history' AND sql IS NOT NULL AND type IN ('index','trigger')").all()
  const columns = db.prepare("PRAGMA table_info(history)").all().filter(row => row.name !== "entry").map(row => `"${row.name}"`).join(",")
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE")
  db.exec(schema.replace(/^CREATE TABLE history/, "CREATE TABLE original_history")
    .replace(/entry TEXT NOT NULL, UNIQUE\(scope,permission,review\)/, "UNIQUE(scope,permission)"))
  db.exec(`INSERT INTO original_history(rowid,${columns}) SELECT rowid,${columns} FROM history;
    DROP TABLE history; ALTER TABLE original_history RENAME TO history;`)
  for (const object of objects) db.exec(object.sql as string)
  db.exec("COMMIT; PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON")
  const reopen = () => { const client = new HistorySQL(new DatabaseSync(file)); clients.push(client); return client }
  return { db, sql, reopen, file }
}

test("legacy report migration preserves IDs, bodies, accounting, replay and foreign keys while retaining re-reviews", t => {
  const f = fixture(t), totals = f.sql.query({ type: "totals" })
  const migrated = f.reopen()
  const original = migrated.query(query) as HistorySelection
  assert.equal(original.entry, entryID(context))
  assert.equal(original.record?.payload.desc, "legacy 0")
  assert.deepEqual(migrated.query({ type: "totals" }), totals)
  assert.throws(() => migrated.apply("collision", 1, encodeEvent({ type: "permissionResolved",
    context: { ...context, permission: "other", review: context.permission }, at: 3, outcome: "approved",
    payload: { safe: false, completedAt: 3, desc: "Must not replace another permission's legacy ID" } })), /identity/)
  assert.equal((migrated.query(query) as HistorySelection).record?.payload.desc, "legacy 0")
  const later = { ...context, review: "later" }
  const event = { type: "permissionResolved" as const, context: later, at: 10, outcome: "rejected" as const,
    payload: { safe: false, completedAt: 9, desc: "New Unsafe report" } }
  // Use the existing approval outcome here; contradictory approved/rejected
  // facts still fail closed rather than fabricate a decision.
  migrated.apply("new", 1, encodeEvent({ ...event, outcome: "manual" }))
  const latest = migrated.query(query) as HistorySelection
  assert.equal(latest.total, 2)
  assert.equal(latest.entry, reviewID(later))
  assert.equal(latest.older, original.entry)
  assert.equal(latest.record?.payload.safe, false)
  assert.deepEqual(migrated.query({ type: "totals" }), totals)
  assert.deepEqual(migrated.apply("new", 1, encodeEvent(event)), { replay: true })
  assert.equal((f.reopen().query({ ...query, entry: original.entry }) as HistorySelection).record?.payload.desc, "legacy 0")
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), [])
  assert.equal(f.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok")
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1)
})

test("interrupted report-index migration rolls back without touching payloads or totals", t => {
  const f = fixture(t), totals = f.sql.query({ type: "totals" }), connection = new DatabaseSync(f.file)
  const failing: HistoryDatabase = { prepare: sql => connection.prepare(sql), close: () => connection.close(), exec(sql) {
    const result = connection.exec(sql)
    if (sql.includes("ALTER TABLE history_report_migration")) throw Error("interrupted migration")
    return result
  } }
  try {
    assert.throws(() => new HistorySQL(failing), /interrupted migration/)
    assert.equal(connection.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1)
    const schema = connection.prepare("SELECT sql FROM sqlite_schema WHERE name='history'").get()!.sql
    assert.equal(typeof schema, "string")
    assert.match(schema as string, /UNIQUE\(scope,permission\)/)
    assert.equal(connection.prepare("SELECT count(*) n FROM payloads").get()!.n, 1)
  } finally { connection.close() }
  assert.deepEqual(f.reopen().query({ type: "totals" }), totals)
  assert.equal((f.sql.query(query) as HistorySelection).record?.payload.desc, "legacy 0")
})

test("migration preserves rowids and mirroring during an already-running legacy history-index rebuild", t => {
  const f = fixture(t, 20)
  f.db.exec("UPDATE history_privacy SET legacy=1; INSERT INTO history_legacy_rebuild VALUES (1,9,0,NULL,NULL)")
  f.sql.cleanup(); f.sql.cleanup()
  const before = f.db.prepare("SELECT * FROM history_legacy_rebuild").get()!
  assert.equal(before.phase, 1)
  assert.equal(before.cursor, 80)
  const migrated = f.reopen()
  assert.deepEqual(f.db.prepare("SELECT * FROM history_legacy_rebuild").get(), before)
  const rowids = (table: string) => f.db.prepare(`SELECT rowid n FROM ${table} ORDER BY rowid`).all().map(row => row.n)
  assert.deepEqual(rowids("history"), Array.from({ length: 20 }, (_, n) => (n + 1) * 10))
  assert.deepEqual(rowids("history_legacy_copy"), Array.from({ length: 8 }, (_, n) => (n + 1) * 10))
  const later = { ...context, review: "later" }
  migrated.apply("new", 1, encodeEvent({ type: "permissionResolved", context: later, at: 30, outcome: "manual",
    payload: { safe: false, completedAt: 30, desc: "During history rebuild" } }))
  assert.equal(f.db.prepare("SELECT count(*) n FROM history_legacy_copy WHERE review=?").get(reviewID(later))!.n, 1)
  let steps = 0
  while (migrated.cleanup().pending) assert.ok(++steps < 500)
  assert.equal((migrated.query(query) as HistorySelection).total, 21)
  assert.equal((migrated.query(query) as HistorySelection).record?.payload.desc, "During history rebuild")
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), [])
  assert.equal(f.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok")
})
