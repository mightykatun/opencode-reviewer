import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistorySQL, type HistoryDatabase, type HistorySelection } from "../src/history-schema.js"
import { encodeEvent, entryID, reviewID, rootID, sessionID, type HistoryEvent } from "../src/history-records.js"
import { empty } from "../src/lifetime.js"
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
      // The baseline is irrelevant to browsing work. Establish it directly so
      // these dispatches do not charge this test to a separate legacy bootstrap.
      db.prepare("INSERT INTO conversation_totals VALUES (?,?,0)").run(rootID(c), JSON.stringify(empty()))
      const pending = { ...c, permission: "unsaved", review: "unsaved" }
      const activity: HistoryEvent[] = [
        { type: "attemptDispatched", context: pending, at: 1, attempt: "post", retry: "initial" },
        { type: "attemptFinalized", context: pending, at: 2, attempt: "post", usage: { input: 3, output: 1 } },
        { type: "reviewAccepted", context: pending, at: 3, accepted: { safe: true, completedAt: 3 } },
      ]
      const generation = db.prepare("SELECT generation FROM history_generations WHERE id=?").get(rootID(c))!.generation
      for (const [n, event] of activity.entries()) {
        sql.apply("unsaved", n + 1, encodeEvent(event))
        const current = sql.query(query) as HistorySelection
        assert.deepEqual({ ...current, revision: cold.revision }, cold)
        assert.equal(visits, 0, `${event.type} on the same root performs no validation/count/rank scans`)
        assert.equal(db.prepare("SELECT generation FROM history_generations WHERE id=?").get(rootID(c))!.generation, generation)
      }
      // Raw identity changes/deletion of that unreferenced review remain silent.
      other.prepare("UPDATE reviews SET entry=?,root=?,session=? WHERE id=?").run(
        "e".repeat(64), "d".repeat(64), "b".repeat(64), reviewID(pending))
      assert.deepEqual(sql.query(query), cold); assert.equal(visits, 0)
      other.prepare("DELETE FROM reviews WHERE id=?").run(reviewID(pending))
      // Reinsert without attempt children so SQLite's unchanged FK policy permits
      // the raw primary-key mutation, rather than disabling foreign keys.
      other.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,NULL)").run(
        reviewID(pending), entryID(pending), rootID(pending), sessionID(pending), JSON.stringify(pending))
      other.prepare("UPDATE reviews SET id=?,entry=?,root=?,session=? WHERE id=?").run(
        "f".repeat(64), "e".repeat(64), "d".repeat(64), "b".repeat(64), reviewID(pending))
      other.prepare("DELETE FROM reviews WHERE id=?").run("f".repeat(64))
      assert.deepEqual(sql.query(query), cold); assert.equal(visits, 0)
      const referencePlan = db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT root FROM history WHERE review=?").all(reviewID(pending))
      assert.match(JSON.stringify(referencePlan), /SEARCH history USING INDEX history_review/)
      assert.doesNotMatch(JSON.stringify(referencePlan), /SCAN history/)
      // Payloads and context are still read fresh while structural caches stay warm.
      const fresh = { ...cold.record!.payload, desc: "Fresh selected report during unsaved activity" }
      other.prepare("UPDATE payloads SET body=? WHERE id=?").run(JSON.stringify(fresh), cold.entry!)
      assert.deepEqual((sql.query(query) as HistorySelection).record?.payload, fresh)
      other.prepare("UPDATE payloads SET body=? WHERE id=?").run(JSON.stringify(cold.record!.payload), cold.entry!)
      assert.deepEqual(sql.query(query), cold); assert.equal(visits, 0)
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

test("referenced review identities invalidate actual history roots through raw corruption, repair and cross-root moves", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "history-review-ownership-")), file = path.join(directory, "history.sqlite")
  const db = new DatabaseSync(file), other = new DatabaseSync(file), sql = new HistorySQL(db)
  t.after(() => { sql.close(); other.close(); rmSync(directory, { recursive: true, force: true }) })
  const owners = ["first", "second"].flatMap(root => [0, 1].map(n => ({ ...c, root, session: `${root}-${n}`,
    permission: `${root}-p${n}`, review: `${root}-r${n}` })))
  for (const [n, context] of owners.entries()) sql.apply("seed", n + 1, encodeEvent({ type: "permissionResolved", context,
    at: n + 1, outcome: "manual", payload: { safe: true, completedAt: n + 1, desc: context.review } }))
  const owner = owners[0]!, target = owners[2]!, id = reviewID(owner)
  const query = { type: "history" as const, scope: c.scope, root: owner.root }
  const targetQuery = { ...query, root: target.root }
  const original = sql.query(query), originalTarget = sql.query(targetQuery), totals = sql.query({ type: "totals" })
  const generation = (root: string) => db.prepare("SELECT generation FROM history_generations WHERE id=?").get(rootID({ scope: c.scope, root }))!.generation as number
  for (const connection of [db, other]) {
    for (const [column, changed, prior] of [
      ["id", "a".repeat(64), id], ["entry", entryID(target), entryID(owner)],
      ["root", rootID(target), rootID(owner)], ["session", sessionID(target), sessionID(owner)],
    ] as const) {
      const before = generation(owner.root), unaffected = generation(target.root)
      connection.prepare(`UPDATE reviews SET ${column}=? WHERE id=?`).run(changed, id)
      assert.ok(generation(owner.root) > before, `${column} invalidates the referencing root, even when metadata points elsewhere`)
      assert.throws(() => sql.query(query), /index/, `unselected ${column} corruption cannot hide behind a warm selection`)
      assert.equal(generation(target.root), unaffected)
      assert.deepEqual(sql.query(targetQuery), originalTarget)
      connection.prepare(`UPDATE reviews SET ${column}=? WHERE id=?`).run(prior, column === "id" ? changed : id)
      assert.deepEqual(sql.query(query), original)
    }
    const row = connection.prepare("SELECT * FROM reviews WHERE id=?").get(id)!
    const beforeDelete = generation(owner.root)
    connection.prepare("DELETE FROM reviews WHERE id=?").run(id)
    assert.ok(generation(owner.root) > beforeDelete)
    assert.throws(() => sql.query(query), /index/)
    assert.deepEqual(sql.query(targetQuery), originalTarget)
    const beforeInsert = generation(owner.root)
    connection.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,?)").run(row.id!, row.entry!, row.root!, row.session!, row.context!, row.accepted!)
    assert.ok(generation(owner.root) > beforeInsert)
    assert.deepEqual(sql.query(query), original, "owner reinsert restores fresh structural validation")

    // A primary-key change can remove one root's owner while supplying another
    // root's missing owner. Both old and new references, not row.root, invalidate.
    const targetID = reviewID(target), targetRow = connection.prepare("SELECT * FROM reviews WHERE id=?").get(targetID)!
    connection.prepare("DELETE FROM reviews WHERE id=?").run(targetID)
    const beforeIdentityMove = [generation(owner.root), generation(target.root)]
    connection.prepare("UPDATE reviews SET id=? WHERE id=?").run(targetID, id)
    assert.ok(generation(owner.root) > beforeIdentityMove[0]!); assert.ok(generation(target.root) > beforeIdentityMove[1]!)
    assert.throws(() => sql.query(query), /index/); assert.throws(() => sql.query(targetQuery), /index/)
    connection.prepare("UPDATE reviews SET id=? WHERE id=?").run(id, targetID)
    connection.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,?)").run(
      targetRow.id!, targetRow.entry!, targetRow.root!, targetRow.session!, targetRow.context!, targetRow.accepted!)
    assert.deepEqual(sql.query(query), original); assert.deepEqual(sql.query(targetQuery), originalTarget)

    const move = (root: string) => {
      connection.exec("BEGIN IMMEDIATE")
      try {
        connection.prepare("UPDATE sessions SET root=? WHERE id=?").run(root, sessionID(owner))
        connection.prepare("UPDATE reviews SET root=?,context=? WHERE id=?").run(rootID({ scope: c.scope, root }), JSON.stringify({ ...owner, root }), id)
        connection.prepare("UPDATE history SET root=? WHERE id=?").run(rootID({ scope: c.scope, root }), entryID(owner))
        connection.exec("COMMIT")
      } catch (error) { connection.exec("ROLLBACK"); throw error }
    }
    const before = [generation(owner.root), generation(target.root)]
    move(target.root)
    assert.ok(generation(owner.root) > before[0]!); assert.ok(generation(target.root) > before[1]!)
    assert.equal((sql.query(query) as HistorySelection).total, 1)
    assert.equal((sql.query(targetQuery) as HistorySelection).total, 3)
    assert.equal((sql.query({ ...targetQuery, entry: entryID(owner) }) as HistorySelection).record?.context.root, target.root)
    move(owner.root)
    assert.deepEqual(sql.query(query), original); assert.deepEqual(sql.query(targetQuery), originalTarget)
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM history").get()!.n, 4)
  assert.deepEqual(sql.query({ type: "totals" }), totals, "ownership repairs and moves never delete reports or alter accumulated totals")
})
