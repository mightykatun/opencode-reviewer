import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistorySQL, type HistoryDatabase, type HistorySelection } from "../src/history-schema.js"
import { encodeEvent, reviewID, type HistoryEvent, type HistoryReview } from "../src/history-records.js"
import { reviewVersions, reviewerVersion } from "../src/review-versions.js"
import manifest from "../package.json" with { type: "json" }

const context: HistoryReview = { scope: "/versions", root: "root", session: "root", permission: "permission", review: "old",
  category: "bash", configuredModel: "model", provider: "https://example.com" }
const versions = { reviewer: "2.8.0", opencode: "2.0.123-dev.fixture" }
const resolved = (review = "old", captured?: typeof versions): Extract<HistoryEvent, { type: "permissionResolved" }> => ({ type: "permissionResolved",
  context: { ...context, review }, at: 20, outcome: "approved", payload: { safe: false, completedAt: 10,
    desc: `Report ${review}`, usage: { input: 100, output: 20, cost: 0.01 } }, ...(captured ? { versions: captured } : {}) })
const query = { type: "history" as const, scope: context.scope, root: context.root }

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "history-versions-")), file = path.join(directory, "history.sqlite")
  const db = new DatabaseSync(file), sql = new HistorySQL(db), connections = [db]
  t.after(() => { for (const connection of connections) connection.close(); rmSync(directory, { recursive: true, force: true }) })
  let sequence = 0
  const apply = (event: HistoryEvent) => sql.apply("old-format-writer", ++sequence, encodeEvent(event))
  apply({ type: "attemptDispatched", context, at: 1, attempt: "post", retry: "initial" })
  apply({ type: "attemptFinalized", context, at: 2, attempt: "post", usage: { input: 100, output: 20, cost: 0.01 } })
  apply({ type: "reviewAccepted", context, at: 10, accepted: { safe: false, completedAt: 10 } })
  apply(resolved())
  // Restore the immediately preceding schema without reconstructing any old row.
  db.exec("DROP TRIGGER review_versions_insert; DROP TABLE review_versions")
  const tables = ["reviews", "history", "payloads", "attempts", "meta", "conversation_totals", "writers", "contributions", "permission_statistics"]
  const snapshot = () => tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])
  const open = () => { const connection = new DatabaseSync(file); connections.push(connection); return connection }
  const row = (review = "old") => ({ ...db.prepare("SELECT reviewer_version,opencode_version FROM review_versions WHERE review=?")
    .get(reviewID({ ...context, review })) })
  return { db, sql, apply, snapshot, open, row }
}

test("version migration preserves report identities, bodies, usage and totals and runs its backfill only once", t => {
  const f = fixture(t), before = f.snapshot(), original = f.sql.query(query)
  const upgraded = new HistorySQL(f.open())
  assert.deepEqual(f.row(), { reviewer_version: "2.7.0", opencode_version: null })
  assert.deepEqual(f.snapshot(), before)
  assert.deepEqual(upgraded.query(query), original, "history's public record and UI data remain identical")
  const connection = f.open()
  new HistorySQL({ prepare: text => connection.prepare(text), close: () => {}, exec(text) {
    assert.ok(!text.includes("INSERT OR IGNORE INTO review_versions(review) SELECT"), "reopen must not scan all reviews again")
    connection.exec(text)
  } })
  assert.deepEqual(f.snapshot(), before)
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), [])
  assert.equal(f.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok")
})

test("new and old-format clients share the upgraded database without relabeling existing reviews", t => {
  const f = fixture(t), upgraded = new HistorySQL(f.open())
  upgraded.apply("new", 1, encodeEvent(resolved("new", versions)))
  f.apply(resolved("legacy-after-upgrade"))
  assert.deepEqual(f.row("new"), { reviewer_version: versions.reviewer, opencode_version: versions.opencode })
  assert.deepEqual(f.row("legacy-after-upgrade"), { reviewer_version: "2.7.0", opencode_version: null })
  assert.deepEqual(upgraded.apply("new", 1, encodeEvent(resolved("new", versions))), { replay: true })
  upgraded.apply("new", 2, encodeEvent(resolved("new", { reviewer: "9.0.0", opencode: "9.0.0" })))
  upgraded.apply("new", 3, encodeEvent(resolved("old", versions)))
  assert.deepEqual(f.row("new"), { reviewer_version: versions.reviewer, opencode_version: versions.opencode })
  assert.deepEqual(f.row(), { reviewer_version: "2.7.0", opencode_version: null }, "an upgrade never relabels historical generation")
  assert.equal((f.sql.query(query) as HistorySelection).total, 3, "the already-open old-format client can still browse new reports")
  assert.equal(f.db.prepare("PRAGMA table_info(reviews)").all().length, 6)
  const id = "a".repeat(64)
  f.db.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,NULL)").run(id, "entry", "root", "session", JSON.stringify(context))
  assert.deepEqual({ ...f.db.prepare("SELECT reviewer_version,opencode_version FROM review_versions WHERE review=?").get(id) },
    { reviewer_version: "2.7.0", opencode_version: null }, "literal legacy INSERT shape remains valid")
  const moved = "b".repeat(64)
  f.db.prepare("UPDATE reviews SET id=? WHERE id=?").run(moved, id)
  assert.equal(f.db.prepare("SELECT count(*) n FROM review_versions WHERE review=?").get(id)!.n, 0)
  assert.deepEqual({ ...f.db.prepare("SELECT reviewer_version,opencode_version FROM review_versions WHERE review=?").get(moved) },
    { reviewer_version: "2.7.0", opencode_version: null }, "metadata follows identity repairs without blocking legacy SQL")
})

test("interrupted metadata migration rolls back table, trigger and backfill, then upgrades cleanly", t => {
  const f = fixture(t), before = f.snapshot(), connection = f.open()
  const interrupted: HistoryDatabase = { prepare: text => connection.prepare(text), close: () => {}, exec(text) {
    connection.exec(text)
    if (text.includes("INSERT OR IGNORE INTO review_versions(review) SELECT")) throw Error("migration interrupted")
  } }
  assert.throws(() => new HistorySQL(interrupted), /migration interrupted/)
  assert.equal(connection.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1)
  assert.equal(connection.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('review_versions','review_versions_insert')").get()!.n, 0)
  assert.deepEqual(f.snapshot(), before)
  new HistorySQL(f.open())
  assert.deepEqual(f.row(), { reviewer_version: "2.7.0", opencode_version: null })
  assert.deepEqual(f.snapshot(), before)
})

test("version capture survives reviews-table legacy rebuilding and cascades with review deletion", t => {
  const f = fixture(t), upgraded = new HistorySQL(f.open())
  upgraded.apply("new", 1, encodeEvent(resolved("new", versions)))
  f.db.exec("UPDATE history_privacy SET legacy=1; INSERT INTO history_legacy_rebuild VALUES (1,6,0,NULL,NULL)")
  upgraded.cleanup()
  assert.equal(f.db.prepare("SELECT phase FROM history_legacy_rebuild").get()!.phase, 1)
  new HistorySQL(f.open())
  f.apply(resolved("during-rebuild"))
  let steps = 0
  while (upgraded.cleanup().pending) assert.ok(++steps < 500)
  assert.deepEqual(f.row("new"), { reviewer_version: versions.reviewer, opencode_version: versions.opencode })
  assert.deepEqual(f.row("during-rebuild"), { reviewer_version: "2.7.0", opencode_version: null })
  f.apply(resolved("after-rebuild"))
  assert.equal(f.db.prepare("SELECT count(*) n FROM review_versions").get()!.n, 4)
  assert.equal((upgraded.query(query) as HistorySelection).total, 4)
  upgraded.apply("new", 2, encodeEvent({ type: "sessionDeleted", at: 30,
    context: { scope: context.scope, root: context.root, session: context.session } }))
  assert.equal(f.db.prepare("SELECT count(*) n FROM review_versions").get()!.n, 0)
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), [])
  assert.equal(f.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok")
})

test("version envelopes are optional for legacy events, strict and bounded for new ones", () => {
  assert.doesNotThrow(() => encodeEvent(resolved()))
  assert.doesNotThrow(() => encodeEvent({ ...resolved(), versions: { reviewer: "2.8.0", opencode: null } }))
  for (const invalid of [null, [], {}, { reviewer: "2.8.0" }, { reviewer: "", opencode: null },
    { reviewer: "2.8.0", opencode: " " }, { reviewer: "2.8.0", opencode: 2 }, { reviewer: "2.8.0", opencode: "x\0y" },
    { reviewer: "x".repeat(129), opencode: null }, { reviewer: "2.8.0", opencode: "é".repeat(65) },
    { ...versions, extra: "unexpected" }, { ...versions, get opencode() { return "getter" } }])
    assert.throws(() => encodeEvent({ ...resolved(), versions: invalid } as any), /Invalid history event/)
  assert.equal(reviewerVersion, manifest.version)
  assert.deepEqual(reviewVersions("2.0.123+local"), { reviewer: manifest.version, opencode: "2.0.123+local" })
  for (const unknown of [undefined, null, "", " ", "x\0y", "x".repeat(129), 2])
    assert.deepEqual(reviewVersions(unknown), { reviewer: manifest.version, opencode: null })
})
