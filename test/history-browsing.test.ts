import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistorySQL, type HistoryDatabase, type HistorySelection } from "../src/history-schema.js"
import { encodeEvent, entryID, rootID, sessionID } from "../src/history-records.js"
import { largeContext as c, seedLarge } from "./history-large-fixture.js"

test("1k/10k/100k valid roots have constant warm selection work with fresh same/foreign-connection corruption and repair", { timeout: 60000 }, t => {
  const measurements: { rows: number; visits: number; warmVisits: number; coldMs: number; warmMs: number; statements: number }[] = []
  for (const size of [1000, 10000, 100000]) {
    const directory = mkdtempSync(path.join(tmpdir(), "history-browsing-")), file = path.join(directory, "history.sqlite")
    const db = new DatabaseSync(file), other = new DatabaseSync(file)
    let visits = 0, statements = 0
    db.function("visited", () => { visits++; return 1 })
    // Measure actual SQLite row work in the potentially linear validation/count
    // statements, not merely returned rows or the number of SQL calls.
    const measured: HistoryDatabase = { exec: sql => db.exec(sql), close: () => db.close(), prepare(sql) {
      if (sql.includes("FROM history")) {
        sql = sql.replaceAll("count(*)", "count(visited())")
        if (sql.includes("typeof(completed)")) sql = sql.replace("(typeof(completed)", "visited()=1 AND (typeof(completed)")
        if (sql.includes("LEFT JOIN reviews")) sql = sql.replace("(r.id IS NULL", "visited()=1 AND (r.id IS NULL")
      }
      const statement = db.prepare(sql)
      return { run: (...args: any[]) => statement.run(...args), get: (...args: any[]) => { statements++; return statement.get(...args) },
        all: (...args: any[]) => { statements++; return statement.all(...args) } }
    } }
    const sql = new HistorySQL(measured)
    try {
      seedLarge(db, size, 0, true)
      const selected = { ...c, permission: `p${Math.floor(size / 2)}` }, query = { type: "history" as const, scope: c.scope, root: c.root, entry: entryID(selected) }
      visits = 0; const start = performance.now()
      const cold = sql.query(query) as HistorySelection, coldMs = performance.now() - start, coldVisits = visits
      assert.equal(cold.total, size); assert.equal(cold.rank, Math.floor(size / 2) + 1)
      assert.ok(coldVisits >= size * 3, "cold validation and count instrumentation actually visits the root")
      visits = 0; statements = 0; const warmStart = performance.now()
      for (let n = 0; n < 20; n++) assert.deepEqual(sql.query(query), cold)
      const warmMs = (performance.now() - warmStart) / 20
      measurements.push({ rows: size, visits: coldVisits, warmVisits: visits, coldMs, warmMs, statements: statements / 20 })
      assert.equal(visits, 0, "unchanged selections perform no validation/count/rank scans")
      assert.ok(statements / 20 <= 10)
      const payload = JSON.stringify(cold.record!.payload)
      for (const connection of [db, other]) {
        const generation = db.prepare("SELECT generation FROM history_generations WHERE id=?").get(rootID(c))!.generation
        connection.prepare("UPDATE payloads SET body='bad' WHERE id=?").run(cold.entry!)
        assert.equal((sql.query(query) as HistorySelection).unreadable, true)
        connection.prepare("UPDATE payloads SET body=? WHERE id=?").run(payload, cold.entry!)
        assert.deepEqual(sql.query(query), cold)
        assert.equal(db.prepare("SELECT generation FROM history_generations WHERE id=?").get(rootID(c))!.generation, generation)
        assert.equal(visits, 0, "payload repair remains fresh without invalidating root counts")
      }
      // Context text is also fetched every time, independently of structural generations.
      const context = JSON.stringify(cold.record!.context)
      other.prepare("UPDATE reviews SET context='bad' WHERE id=(SELECT review FROM history WHERE id=?)").run(cold.entry!)
      assert.throws(() => sql.query(query))
      other.prepare("UPDATE reviews SET context=? WHERE id=(SELECT review FROM history WHERE id=?)").run(context, cold.entry!)
      assert.deepEqual(sql.query(query), cold); assert.equal(visits, 0)
      sql.apply("unrelated", 1, encodeEvent({ type: "reviewAccepted", context: { ...c, root: "other", session: "other", review: "other", permission: "other" },
        at: 1, accepted: { safe: true, completedAt: 1 } }))
      assert.deepEqual(sql.query(query), cold); assert.equal(visits, 0, "writes to unrelated roots do not flush this root's validation")
      // Raw SQL need not remember to bump roots.revision. Both adapters' writes
      // must invalidate cached validation, including an unselected corrupt row.
      for (const connection of [other, db]) {
        const id = entryID(c)
        connection.prepare("UPDATE history SET completed=-1 WHERE id=?").run(id)
        assert.throws(() => sql.query(query), /index/)
        connection.prepare("UPDATE history SET completed=1 WHERE id=?").run(id)
        assert.deepEqual(sql.query(query), cold)
        connection.prepare("UPDATE sessions SET root='wrong' WHERE id=?").run(sessionID(c))
        assert.throws(() => sql.query(query), /index/)
        connection.prepare("UPDATE sessions SET root=? WHERE id=?").run(c.root, sessionID(c))
        assert.deepEqual(sql.query(query), cold)
      }
      const plans = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM history WHERE scope=? AND root=? AND outcome IS NOT NULL
        AND (completed,tie,id)<(?,?,?) ORDER BY completed DESC,tie DESC,id DESC LIMIT 1`).all(c.scope, rootID(c), cold.order!.completed, cold.order!.tie, cold.entry!)
      assert.match(JSON.stringify(plans), /SEARCH history USING INDEX history_visible_order/)
      assert.doesNotMatch(JSON.stringify(plans), /SCAN history|TEMP B-TREE/)
      other.prepare("UPDATE history SET outcome=NULL WHERE id!=?").run(cold.entry!)
      const sparse = sql.query(query) as HistorySelection
      assert.equal(sparse.total, 1); assert.equal(sparse.rank, 1)
      assert.equal(sparse.older, undefined); assert.equal(sparse.newer, undefined)
      visits = 0
      for (let n = 0; n < 10; n++) assert.deepEqual(sql.query(query), sparse)
      assert.equal(visits, 0, "an unchanged sparse root still avoids counts and validation scans")
    } finally { sql.close(); other.close(); rmSync(directory, { recursive: true, force: true }) }
  }
  assert.equal(new Set(measurements.map(m => m.statements)).size, 1)
  // Work is the primary deterministic bound. A generous time check also catches
  // accidental uninstrumented scans without depending on sub-millisecond clocks.
  assert.ok(measurements[2]!.warmMs < measurements[2]!.coldMs / 5)
  t.diagnostic(JSON.stringify(measurements))
})
