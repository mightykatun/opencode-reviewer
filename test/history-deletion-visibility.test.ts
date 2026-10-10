import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistorySQL } from "../src/history-schema.js"
import type { HistoryDatabase, HistorySelection } from "../src/history-schema.js"
import { encodeEvent, entryID, reviewID, rootID, sessionID } from "../src/history-records.js"
import type { HistoryReview } from "../src/history-records.js"

const context: HistoryReview = { scope: "/visibility", root: "root", session: "deleted-child", permission: "p", review: "r",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const query = { type: "history" as const, scope: context.scope, root: context.root }
const marker = "DELETED_CHILD_REPORT_MUST_NOT_PUBLISH"

function fixture(t: any, size: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-delete-visibility-")), file = path.join(dir, "history.sqlite")
  const db = new DatabaseSync(file), writer = new HistorySQL(db), other = new DatabaseSync(file)
  let scans = 0, seeks = 0, maximumSeek = 0
  const payloadReads: string[] = [], plans: string[] = []
  other.function("scan_visit", () => { scans++; return 1 })
  other.function("seek_visit", () => { seeks++; return 1 })
  const measured: HistoryDatabase = { exec: sql => other.exec(sql), close: () => other.close(), prepare(sql) {
    const seeking = sql.includes("FROM sessions s JOIN history h")
    if (sql.includes("FROM history")) {
      sql = sql.replaceAll("count(*)", "count(scan_visit())")
      sql = sql.replace("(typeof(completed)", "scan_visit()=1 AND (typeof(completed)")
      sql = sql.replace("(r.id IS NULL", "scan_visit()=1 AND (r.id IS NULL")
    }
    if (seeking) sql = sql.replace("session=s.id AND outcome IS NOT NULL", "session=s.id AND outcome IS NOT NULL AND seek_visit()=1")
    const statement = other.prepare(sql)
    return { run: (...args: any[]) => statement.run(...args), all: (...args: any[]) => statement.all(...args), get: (...args: any[]) => {
      if (sql.includes("FROM payloads")) payloadReads.push(args[0])
      const before = seeks, result = statement.get(...args)
      if (seeking) {
        maximumSeek = Math.max(maximumSeek, seeks - before)
        plans.push(JSON.stringify(other.prepare("EXPLAIN QUERY PLAN " + sql).all(...args)))
      }
      return result
    } }
  } }
  const reader = new HistorySQL(measured)
  t.after(() => { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }) })
  // Establish a committed conversation baseline, then seed realistic valid rows
  // in one transaction without charging test time to thousands of fsyncs.
  writer.apply("baseline", 1, encodeEvent({ type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } }))
  db.exec("BEGIN IMMEDIATE")
  const session = db.prepare("INSERT OR IGNORE INTO sessions VALUES (?,?,?,?)")
  const review = db.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,NULL)")
  const history = db.prepare("INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  const payload = db.prepare("INSERT INTO payloads VALUES (?,?)")
  const add = (c: HistoryReview, completed: number, desc: string) => {
    session.run(sessionID(c), c.scope, c.root, c.session)
    review.run(reviewID(c), entryID(c), rootID(c), sessionID(c), JSON.stringify(c))
    history.run(entryID(c), c.scope, rootID(c), sessionID(c), c.permission, completed, c.review, reviewID(c), "manual", "manual", null, completed)
    payload.run(entryID(c), JSON.stringify({ safe: true, completedAt: completed, desc }))
  }
  for (let n = 0; n < size; n++) add({ ...context, permission: `child-p${n}`, review: `child-r${n}` }, n + 100, marker)
  const siblings = [10, 100 + Math.floor(size / 2), size + 50].map((completed, n) => {
    const c = { ...context, session: `sibling-${n}`, permission: `sibling-p${n}`, review: `sibling-r${n}` }
    add(c, completed, `SURVIVING_SIBLING_${n}`); return c
  })
  db.exec("COMMIT")
  return { db, writer, reader, siblings, file, payloadReads, plans,
    reset: () => { scans = 0; seeks = 0; maximumSeek = 0; payloadReads.length = 0; plans.length = 0 },
    work: () => ({ scans, seeks, maximumSeek }),
    remaining: () => db.prepare("SELECT count(*) n FROM history WHERE session=?").get(sessionID(context))!.n as number,
    generation: () => db.prepare("SELECT generation FROM history_generations WHERE id=?").get(rootID(context))!.generation }
}

for (const size of [1000, 10000]) test(`two-connection sliced child deletion immediately hides ${size} reports with bounded indexed neighbor seeks`, t => {
  const f = fixture(t, size)
  const old = f.reader.query(query) as HistorySelection
  assert.equal(old.record?.payload.desc, marker); assert.equal(old.total, size + 3)
  for (const c of f.siblings) f.reader.query({ ...query, entry: entryID(c) }) // Warm counts, ranks and neighbor IDs before deletion.
  const deletion = encodeEvent({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.session }, at: 50000 })
  const before = f.generation()
  assert.deepEqual(f.writer.applyReady("delete", 1, deletion), { deleting: true })
  assert.ok(f.remaining() >= size - 128)
  assert.notEqual(f.generation(), before)
  assert.equal(f.db.prepare("SELECT sequence FROM writers WHERE id='delete'").get(), undefined, "deletion has not been acknowledged")
  f.reset()
  const latest = f.reader.query(query) as HistorySelection
  assert.equal(latest.total, 3); assert.equal(latest.rank, 3)
  assert.equal(latest.entry, entryID(f.siblings[2]!)); assert.equal(latest.older, entryID(f.siblings[1]!)); assert.equal(latest.newer, undefined)
  const ascending = f.reader.query({ ...query, entry: entryID(f.siblings[0]!), direction: "newer" }) as HistorySelection
  assert.equal(ascending.entry, entryID(f.siblings[1]!)); assert.equal(ascending.rank, 2)
  assert.equal(ascending.older, entryID(f.siblings[0]!)); assert.equal(ascending.newer, entryID(f.siblings[2]!))
  const descending = f.reader.query({ ...query, entry: entryID(f.siblings[2]!), direction: "older" }) as HistorySelection
  assert.equal(descending.entry, entryID(f.siblings[1]!)); assert.equal(descending.total, 3)
  const remaining = f.db.prepare("SELECT id,completed,tie FROM history WHERE session=? ORDER BY completed DESC LIMIT 1").get(sessionID(context))!
  const exact = f.reader.query({ ...query, entry: remaining.id as string }) as HistorySelection
  assert.equal(exact.record, undefined); assert.equal(exact.entry, undefined); assert.equal(exact.total, 3)
  const restored = f.reader.query({ ...query, entry: remaining.id as string,
    order: { id: remaining.id as string, completed: remaining.completed as number, tie: remaining.tie as string } }) as HistorySelection
  assert.ok(restored.record?.payload.desc.startsWith("SURVIVING_SIBLING_"))
  for (const id of f.payloadReads) assert.ok(f.siblings.some(c => entryID(c) === id), "no tombstoned report body was even fetched")
  assert.ok(f.plans.every(plan => plan.includes("history_session_visible_order")))
  assert.ok(f.plans.every(plan => !/SCAN history|SCAN h\b/.test(plan)))
  assert.ok(f.work().maximumSeek <= 3, "each uncached seek touches at most one candidate per live sibling, independent of hidden gap size")
  const coldWork = f.work()
  f.reset()
  for (let n = 0; n < 10; n++) assert.deepEqual(f.reader.query(query), latest)
  assert.deepEqual(f.work(), { scans: 0, seeks: 0, maximumSeek: 0 })
  // Orphan cleanup in another connection must not repeatedly invalidate visible
  // siblings while it physically removes rows already hidden by the tombstone.
  const generation = f.generation()
  assert.equal(f.writer.cleanup().deleting, true)
  assert.equal(f.generation(), generation)
  assert.deepEqual(f.reader.query(query), latest)
  assert.deepEqual(f.work(), { scans: 0, seeks: 0, maximumSeek: 0 })
  const reopened = new HistorySQL(new DatabaseSync(f.file))
  try { assert.deepEqual(reopened.query(query), latest) } finally { reopened.close() }
  t.diagnostic(JSON.stringify({ hiddenRows: size, maximumCandidateVisits: coldWork.maximumSeek, warmScans: f.work().scans, warmSeeks: f.work().seeks }))
})

test("tombstones alone invalidate foreign caches; pending child/root owner and resolution reads behave as deleted", t => {
  const f = fixture(t, 300), selected = f.reader.query(query) as HistorySelection
  assert.equal(selected.record?.context.session, context.session)
  // Direct insertion isolates tombstone invalidation from physical history deletes.
  f.db.prepare("INSERT INTO tombstones VALUES (?)").run(sessionID(context))
  assert.equal(f.remaining(), 300)
  const visible = f.reader.query(query) as HistorySelection
  assert.equal(visible.total, 3); assert.equal(visible.rank, 3)
  assert.equal((f.reader.query({ ...query, entry: selected.entry }) as HistorySelection).record, undefined)
  assert.deepEqual(f.reader.query({ type: "session", scope: context.scope, session: context.session }), {})
  // Even corrupt or conflicting pending attribution is no longer a fact about a
  // logically deleted permission; do not expose uncertainty from obsolete rows.
  f.db.prepare("UPDATE history SET resolution='conflict' WHERE id=?").run(selected.entry!)
  assert.deepEqual(f.reader.query({ type: "resolution", scope: context.scope, root: context.root, session: context.session,
    permission: selected.record!.context.permission }), { outcome: undefined, uncertain: false, conflict: false, deleted: true })
  assert.deepEqual(f.reader.query({ type: "session", scope: context.scope, session: f.siblings[0]!.session }),
    { context: { scope: context.scope, root: context.root, session: f.siblings[0]!.session } })
  const deletion = encodeEvent({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.root }, at: 50000 })
  assert.deepEqual(f.writer.applyReady("root-delete", 1, deletion), { deleting: true })
  assert.ok(f.db.prepare("SELECT count(*) n FROM history").get()!.n as number > 0)
  f.reset()
  assert.deepEqual(f.reader.query(query), { revision: visible.revision, total: 0, rank: 0, deleted: true })
  assert.deepEqual(f.reader.query({ type: "session", scope: context.scope, session: f.siblings[0]!.session }), {})
  assert.deepEqual(f.reader.query({ type: "resolution", scope: context.scope, root: context.root, session: f.siblings[0]!.session,
    permission: f.siblings[0]!.permission }), { outcome: undefined, uncertain: false, conflict: false, deleted: true })
  assert.deepEqual(f.payloadReads, [])
  // Maintenance intentionally retains a bounded physical inventory until erasure.
  const inventory = f.reader.query({ type: "sessions", scope: context.scope, limit: 1 }) as any
  assert.equal(inventory.sessions.length, 1); assert.ok(inventory.after)
})
