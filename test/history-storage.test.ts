import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { HistorySQL } from "../src/history-schema.js"
import type { HistorySelection, HistoryTotals, HistoryResolution } from "../src/history-schema.js"
import { encodeEvent, entryID, reviewID } from "../src/history-records.js"
import type { HistoryEvent, HistoryPayload, HistoryReview } from "../src/history-records.js"
import { privateDatabase } from "../src/history-storage-worker.js"
import { HistoryWorker } from "../src/history-store.js"
import { StreamingAssessment } from "../src/streaming-assessment.js"
import { displayText } from "../src/controller.js"

const context: HistoryReview = { scope: "/project", root: "root", session: "child", permission: "permission", review: "review",
  category: "bash", configuredModel: "configured", provider: "https://openrouter.ai/api/v1" }
const payload: HistoryPayload = { safe: true, completedAt: 100, desc: "Resolved private report", reportedModel: "reported", usage: { cost: 0 } }
const resolve = (c = context, p = payload, outcome: "auto" | "manual" | "cancelled" | "rejected" = "manual"): HistoryEvent =>
  ({ type: "permissionResolved", context: c, at: 200, outcome, payload: p })

test("validated report controls survive resolved storage and remain escaped for display", t => {
  const f = fixture(t), parser = new StreamingAssessment()
  const desc = "Report\u0000with\u001bcontrols\u202e"
  parser.push(JSON.stringify({ safe: true, desc }))
  const assessment = parser.finish()
  f.apply({ type: "reviewAccepted", context, at: 100, accepted: { safe: assessment.safe, completedAt: 100 } })
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  f.apply(resolve(context, { ...payload, ...assessment }))
  assert.equal(f.history().record?.payload.desc, desc)
  assert.equal(displayText(f.history().record!.payload.desc), "Report\\u0000with\\u001bcontrols\\u202e")
})

test("saved indexed order selects next newer after deletion, then nearest older, without jumping newest", t => {
  const f = fixture(t)
  for (let n = 1; n <= 5; n++) f.apply(resolve({ ...context, session: `child-${n}`, permission: `p-${n}`, review: `r-${n}` }, { ...payload, completedAt: n }))
  const query = { type: "history" as const, scope: context.scope, root: context.root }
  const middle = f.sql.query({ ...query, entry: entryID({ ...context, permission: "p-3" }) }) as HistorySelection
  f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: "child-3" }, at: 300 })
  const newer = f.sql.query({ ...query, entry: middle.entry, order: middle.order }) as HistorySelection
  assert.equal(newer.record?.context.permission, "p-4"); assert.equal(newer.rank, 3); assert.equal(newer.total, 4)
  for (const n of [4, 5]) f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: `child-${n}` }, at: 301 })
  const older = f.sql.query({ ...query, entry: middle.entry, order: middle.order }) as HistorySelection
  assert.equal(older.record?.context.permission, "p-2")
  assert.throws(() => f.sql.query({ ...query, entry: middle.entry, order: { ...middle.order!, id: "b".repeat(64) } }))
})

test("data-only resolution queries observe independent clients without reading or admitting report bodies", t => {
  const f = fixture(t), second = f.second()
  const query = { type: "resolution" as const, scope: context.scope, root: context.root, session: context.session, permission: context.permission }
  f.apply({ type: "reviewAccepted", context, at: 100, accepted: { safe: true, completedAt: 100 } })
  assert.deepEqual(second.query(query), { uncertain: false, conflict: false, deleted: false, outcome: undefined })
  assert.throws(() => second.query({ ...query, root: "another-root" }), /ownership/)
  f.apply({ type: "approvalDispatched", context, at: 200, approval: "write", automatic: true })
  assert.equal((second.query(query) as HistoryResolution).uncertain, true)
  f.apply({ type: "approvalConfirmed", context, at: 201, approval: "write", automatic: true })
  assert.equal((second.query(query) as HistoryResolution).outcome, "auto")
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  f.apply(resolve(context, payload, "rejected"))
  assert.equal((second.query(query) as HistoryResolution).conflict, true)
  assert.equal((second.query(query) as HistoryResolution).outcome, undefined)
})

test("stored session ownership and late outcome updates remain strict, data-only and deletion-aware", t => {
  const f = fixture(t)
  f.apply(resolve(context, payload, "cancelled"))
  assert.deepEqual(f.sql.query({ type: "session", scope: context.scope, session: context.session }),
    { context: { scope: context.scope, root: context.root, session: context.session } })
  f.apply({ type: "permissionOutcome", context, at: 300, outcome: "rejected" })
  assert.equal(f.history().record?.outcome, "rejected")
  assert.equal(f.history().record?.payload.desc, payload.desc)
  assert.throws(() => encodeEvent({ type: "permissionOutcome", context, at: 300, outcome: "rejected", payload } as any))
  f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.session }, at: 400 })
  assert.deepEqual(f.sql.query({ type: "session", scope: context.scope, session: context.session }), {})
  const facts = f.sql.query({ type: "resolution", scope: context.scope, root: context.root, session: context.session, permission: context.permission }) as HistoryResolution
  assert.equal(facts.deleted, true); assert.equal(facts.outcome, undefined)
})

test("resolution facts reject corrupt attribution rather than authorize cancelled history", t => {
  const f = fixture(t)
  f.apply({ type: "approvalConfirmed", context, at: 200, approval: "write", automatic: true })
  f.db.exec("UPDATE approvals SET automatic=-1")
  assert.throws(() => f.sql.query({ type: "resolution", scope: context.scope, root: context.root, session: context.session, permission: context.permission }), /ownership/)
})
function fixture(t: any) {
  const directory = mkdtempSync(path.join(tmpdir(), "history-test-"))
  const file = path.join(directory, "private/history-v1.sqlite")
  privateDatabase(file)
  const db = new DatabaseSync(file), sql = new HistorySQL(db)
  const clients = [sql]
  t.after(() => { for (const client of clients) client.close(); rmSync(directory, { recursive: true, force: true }) })
  let sequence = 0
  return { directory, file, db, sql, apply: (e: HistoryEvent) => sql.apply("writer", ++sequence, encodeEvent(e)),
    totals: () => (sql.query({ type: "totals" }) as HistoryTotals).totals,
    history: () => sql.query({ type: "history", scope: context.scope, root: context.root }) as HistorySelection,
    second: () => { const second = new HistorySQL(new DatabaseSync(file)); clients.push(second); return second } }
}

test("real transactions roll back every effect, detect gaps, and replay a commit without acknowledgement", t => {
  const f = fixture(t), event: HistoryEvent = { type: "reviewAccepted", context, at: 100, accepted: { safe: true, completedAt: 100 } }
  assert.throws(() => f.sql.apply("writer", 1, encodeEvent(event), () => { throw Error("before commit") }))
  assert.equal(f.totals().safe, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM reviews").get()!.n, 0)
  assert.throws(() => f.sql.apply("writer", 2, encodeEvent(event)), /gap/)
  f.sql.apply("writer", 1, encodeEvent(event)) // Simulate commit whose acknowledgement was lost.
  const second = f.second()
  assert.deepEqual(second.apply("writer", 1, encodeEvent(event)), { replay: true })
  second.apply("other", 1, encodeEvent(event)) // Duplicate lifecycle identity across writers.
  assert.equal(f.totals().safe, 1)
  assert.equal((second.query({ type: "totals" }) as HistoryTotals).totals.activity.reviews, 1)
})

test("self-contained dropped predecessors never synthesize dispatch, acceptance or usage", t => {
  const f = fixture(t)
  f.apply({ type: "attemptFinalized", context, at: 100, attempt: "one", usage: { input: 4, output: 2 } })
  f.apply(resolve())
  assert.equal(f.totals().requests, 1); assert.equal(f.totals().activity.retries, 0); assert.equal(f.totals().safe, 0)
  assert.equal(f.history().record?.payload.desc, payload.desc)
  assert.equal(f.db.prepare("SELECT dispatched FROM attempts").get()!.dispatched, null)
  assert.equal(f.db.prepare("SELECT accepted FROM reviews").get()!.accepted, null)
  f.apply({ type: "attemptDispatched", context, at: 101, attempt: "two", retry: "transport" })
  f.apply({ type: "attemptFinalized", context, at: 102, attempt: "two" })
  assert.equal(f.totals().requests, 1); assert.equal(f.totals().activity.retries, 1)
})

test("two clients count distinct attempts and accepted reviews; latest Unsafe report retains earlier auto outcome", t => {
  const f = fixture(t), second = f.second(), later = { ...context, review: "review-2" }
  f.apply({ type: "reviewAccepted", context, at: 100, accepted: { safe: true, completedAt: 100, timing: { fullReportMs: 100, ratingMs: 10 } } })
  second.apply("second", 1, encodeEvent({ type: "reviewAccepted", context: later, at: 150, accepted: { safe: false, completedAt: 150, timing: { fullReportMs: 300, ratingMs: 30 } } }))
  f.apply({ type: "attemptFinalized", context, at: 100, attempt: "1", usage: { cost: 0 } })
  second.apply("second", 2, encodeEvent({ type: "attemptFinalized", context: later, at: 150, attempt: "1", usage: { input: 8, output: 3, cost: 0.1 } }))
  f.apply({ type: "approvalConfirmed", context, at: 200, approval: "write", automatic: true })
  second.apply("second", 3, encodeEvent(resolve(later, { ...payload, safe: false, completedAt: 150, desc: "New Unsafe" })))
  f.apply(resolve())
  const h = f.history()
  assert.equal(h.record?.payload.safe, false); assert.equal(h.record?.outcome, "auto")
  assert.equal(h.record?.approvingReview, reviewID(context)); assert.equal(h.record?.context.configuredModel, "configured")
  assert.equal(h.record?.payload.reportedModel, "reported")
  const totals = f.totals()
  assert.equal(totals.safe, 1); assert.equal(totals.unsafe, 1); assert.equal(totals.requests, 2)
  assert.equal(totals.tokenRequests, 1); assert.equal(totals.priced, 2)
  assert.equal(totals.activity.meanFullReportMs, 200); assert.equal(totals.activity.meanRatingMs, 20)
  assert.equal(totals.activity.autoApproved, 1)
})

test("cross-window dispatch observations hide ambiguous native/cancellation outcomes until confirmation", t => {
  const f = fixture(t), second = f.second()
  f.apply(resolve())
  second.apply("second", 1, encodeEvent({ type: "approvalDispatched", context, at: 190, approval: "write", automatic: true }))
  assert.equal(f.history().total, 0)
  f.apply(resolve(context, payload, "cancelled"))
  second.apply("second", 2, encodeEvent({ type: "approvalSettled", context, at: 201, approval: "write", result: "uncertain" }))
  assert.equal(f.history().total, 0); assert.equal(f.totals().activity.autoApproved, 0)
  second.apply("second", 3, encodeEvent({ type: "approvalConfirmed", context, at: 202, approval: "write", automatic: true }))
  second.apply("second", 4, encodeEvent({ type: "approvalDispatched", context, at: 190, approval: "write", automatic: true }))
  assert.equal(f.history().record?.outcome, "auto")
  assert.equal(f.totals().activity.autoApproved, 1)
})

test("self-contained resolved approval facts survive stale manual/cancelled updates; contradictions stay omitted", t => {
  const f = fixture(t)
  f.apply(resolve(context, payload, "auto"))
  f.apply(resolve({ ...context, review: "new" }, { ...payload, completedAt: 150, safe: false }, "manual"))
  f.apply(resolve(context, payload, "cancelled"))
  assert.equal(f.history().record?.outcome, "auto"); assert.equal(f.history().record?.payload.safe, false)
  assert.equal(f.totals().activity.autoApproved, 0, "resolved payload never invents a dropped accounting contribution")
  f.apply(resolve(context, payload, "rejected"))
  assert.equal(f.history().total, 0, "contradictory known approval/rejection is not guessed")
})

test("completion ordering, stable ties, neighbors and rank use one snapshot; roots are isolated", t => {
  const f = fixture(t)
  const middle = { ...context, permission: "middle", review: "b" }, oldest = { ...context, permission: "old", review: "a" }
  f.apply(resolve(middle)); f.apply(resolve()); f.apply(resolve(oldest, { ...payload, completedAt: 50 }))
  f.apply(resolve({ ...context, root: "other", session: "other", permission: "other", review: "other" }))
  const latest = f.history()
  assert.equal(latest.total, 3); assert.equal(latest.rank, 3); assert.equal(latest.entry, entryID(context))
  const selected = f.sql.query({ type: "history", scope: context.scope, root: context.root, entry: latest.entry, direction: "older" }) as HistorySelection
  assert.equal(selected.entry, entryID(middle)); assert.equal(selected.rank, 2)
  assert.equal(selected.newer, entryID(context)); assert.equal(selected.older, entryID(oldest))
})

test("payload corruption retains placeholder, repair is revalidated, invalid index fails whole read", t => {
  const f = fixture(t); f.apply(resolve())
  f.db.prepare("UPDATE payloads SET body=?").run('{"safe":false}')
  const invalid = f.history()
  assert.equal(invalid.unreadable, true); assert.equal(invalid.rank, 1); assert.equal(invalid.total, 1); assert.equal(invalid.record, undefined)
  f.db.prepare("UPDATE payloads SET body=?").run("x".repeat(600000))
  assert.equal(f.history().unreadable, true, "oversized stored payload is bounded before transfer/JSON decoding")
  f.apply(resolve()); assert.equal(f.history().record?.payload.desc, payload.desc)
  f.db.exec("UPDATE history SET completed=-1")
  assert.throws(() => f.history(), /index/)
})

test("root/child tombstones remove details and retain totals and opaque contribution dedup", t => {
  const f = fixture(t)
  const event: HistoryEvent = { type: "reviewAccepted", context, at: 100, accepted: { safe: true, completedAt: 100 } }
  f.apply(event); f.apply(resolve())
  f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.session }, at: 300 })
  f.apply(resolve()); f.apply(event)
  assert.equal(f.history().total, 0); assert.equal(f.totals().safe, 1)
  assert.equal(f.db.prepare("SELECT count(*) n FROM reviews").get()!.n, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  const root = { ...context, session: context.root, permission: "root-permission", review: "root-review" }
  f.apply(resolve(root))
  f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.root }, at: 301 })
  f.apply({ type: "attemptFinalized", context: root, at: 302, attempt: "late", usage: { cost: 0.25 } })
  assert.equal(f.totals().requests, 1); assert.equal(f.history().total, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM attempts").get()!.n, 0)
  assert.deepEqual(f.sql.query({ type: "sessions", scope: context.scope }), { sessions: [], after: undefined })
})

test("pending operations reject text, credentials, unsafe integers and unknown fields; no pending body on disk", t => {
  const f = fixture(t)
  const event: HistoryEvent = { type: "reviewAccepted", context, at: 100, accepted: { safe: true, completedAt: 100 } }
  assert.throws(() => encodeEvent({ ...event, accepted: { ...event.accepted, desc: "SECRET_BODY" } } as any))
  assert.throws(() => encodeEvent({ ...event, context: { ...context, provider: "https://key@example.com" } }))
  assert.throws(() => encodeEvent({ type: "attemptFinalized", context, at: 1, attempt: "1", usage: { input: 2 ** 53, output: 0 } }))
  assert.throws(() => encodeEvent(resolve(context, { ...payload, desc: "x".repeat(65537) })))
  f.apply(event)
  for (const name of readdirSync(path.dirname(f.file))) assert.equal(readFileSync(path.join(path.dirname(f.file), name)).includes(Buffer.from("SECRET_BODY")), false)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
})

test("private directory/database/WAL protection rejects symlinks, public modes and corrupt stores without resetting", t => {
  const f = fixture(t)
  for (const name of readdirSync(path.dirname(f.file))) assert.equal(statSync(path.join(path.dirname(f.file), name)).mode & 0o077, 0)
  const other = path.join(f.directory, "other"); mkdirSync(other, { mode: 0o700 })
  const file = path.join(other, "history-v1.sqlite"), target = path.join(f.directory, "target")
  writeFileSync(target, "do not change", { mode: 0o600 }); symlinkSync(target, file)
  assert.throws(() => privateDatabase(file)); assert.equal(readFileSync(target, "utf8"), "do not change")
  rmSync(file); writeFileSync(file, "corrupt database", { mode: 0o600 })
  assert.throws(() => { const db = new DatabaseSync(file); try { new HistorySQL(db) } finally { db.close() } })
  assert.equal(readFileSync(file, "utf8"), "corrupt database")
  rmSync(file); writeFileSync(file, "", { mode: 0o644 }); assert.throws(() => privateDatabase(file))
  rmSync(file); privateDatabase(file); symlinkSync(target, file + "-wal"); assert.throws(() => privateDatabase(file))
  const publicDir = path.join(f.directory, "public"); mkdirSync(publicDir, { mode: 0o755 })
  assert.throws(() => privateDatabase(path.join(publicDir, "history-v1.sqlite")))
})

test("unsupported schema is not reset; precomputed totals survive reopen and ignore legacy files", t => {
  const f = fixture(t)
  writeFileSync(path.join(f.directory, "usage-v4.json"), '{"cost":999}')
  f.apply({ type: "attemptFinalized", context, at: 1, attempt: "1", usage: { cost: 3 } })
  assert.equal((f.second().query({ type: "totals" }) as HistoryTotals).totals.cost, 3)
  assert.equal(readFileSync(path.join(f.directory, "usage-v4.json"), "utf8"), '{"cost":999}')
  f.db.exec("UPDATE meta SET version=99")
  const other = new DatabaseSync(f.file)
  try { assert.throws(() => new HistorySQL(other), /schema/); assert.equal(other.prepare("SELECT version FROM meta").get()!.version, 99) }
  finally { other.close() }
})

test("bounded session maintenance pages stay within invocation scope", t => {
  const f = fixture(t)
  for (let i = 0; i < 5; i++) f.apply(resolve({ ...context, session: `s${i}`, permission: `p${i}`, review: `r${i}` }))
  const first = f.sql.query({ type: "sessions", scope: context.scope, limit: 2 }) as any
  const second = f.sql.query({ type: "sessions", scope: context.scope, limit: 2, after: first.after }) as any
  assert.equal(first.sessions.length, 2); assert.equal(second.sessions.length, 2)
  assert.equal(new Set([...first.sessions, ...second.sessions].map(x => x.session)).size, 4)
  assert.throws(() => f.sql.query({ type: "sessions", scope: context.scope, limit: 101 }))
})

test("two real worker clients concurrently initialize schema and share committed Node SQLite data", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "history-workers-"))
  const file = path.join(directory, "private/history-v1.sqlite")
  const bundle = await build({ entryPoints: ["src/history-storage-worker.ts"], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["bun:sqlite", "node:sqlite"] })
  const workers = [new HistoryWorker(bundle.outputFiles[0]!.text), new HistoryWorker(bundle.outputFiles[0]!.text)]
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); rmSync(directory, { recursive: true, force: true }) })
  const ready = await Promise.all(workers.map(w => w.call({ type: "open", file, adapter: "node" })))
  assert.deepEqual(ready, [{ environmentKeys: 0, cleanup: true }, { environmentKeys: 0, cleanup: true }])
  await Promise.all(workers.map((w, i) => w.call({ type: "apply", writer: `worker${i}`, sequence: 1, event: encodeEvent({
    type: "attemptFinalized", context: { ...context, review: `worker${i}` }, attempt: "1", at: 1, usage: { cost: 1 },
  }) })))
  const totals = await workers[0]!.call({ type: "query", query: { type: "totals" } })
  assert.equal(totals.totals.requests, 2); assert.equal(totals.totals.cost, 2)
  const marker = "PRIVATE_WORKER_REPORT_TO_ERASE_8b183f"
  await workers[0]!.call({ type: "apply", writer: "worker0", sequence: 2, event: encodeEvent(resolve(context, { ...payload, desc: marker.repeat(1000) })) })
  const reader = new DatabaseSync(file)
  try {
    reader.exec("BEGIN"); reader.prepare("SELECT body FROM payloads").get()
    await workers[0]!.call({ type: "apply", writer: "worker0", sequence: 3,
      event: encodeEvent({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.root }, at: 300 }) })
    assert.deepEqual(await workers[0]!.call({ type: "cleanup" }), { pending: true, legacy: false })
    assert.ok(readFileSync(file + "-wal").includes(Buffer.from(marker)))
    reader.exec("ROLLBACK")
    assert.deepEqual(await workers[1]!.call({ type: "cleanup" }), { pending: false, legacy: false })
    for (const suffix of ["", "-wal", "-shm"]) {
      assert.equal(readFileSync(file + suffix).includes(Buffer.from(marker)), false)
    }
    assert.equal(reader.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
    assert.equal(reader.prepare("SELECT count(*) n FROM tombstones").get()!.n, 1)
    assert.deepEqual(await workers[1]!.call({ type: "query", query: { type: "totals" } }), totals)
  } finally { reader.close() }
})

test("deletion rejects conflicting root ownership without deleting another root's details", t => {
  const f = fixture(t); f.apply(resolve())
  assert.throws(() => f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: "wrong", session: context.session }, at: 300 }), /ownership/)
  assert.equal(f.history().record?.payload.desc, payload.desc)
  assert.equal(f.db.prepare("SELECT count(*) n FROM tombstones").get()!.n, 0)
})

test("approval identity cannot change review attribution or manual/automatic accounting", t => {
  const f = fixture(t)
  const confirmed: HistoryEvent = { type: "approvalConfirmed", context, at: 200, approval: "write", automatic: false }
  f.apply(confirmed); f.apply(resolve())
  assert.throws(() => f.sql.apply("other", 1, encodeEvent({ ...confirmed, automatic: true })), /identity/)
  assert.throws(() => f.sql.apply("other", 1, encodeEvent({ ...confirmed, context: { ...context, review: "other" } })), /identity/)
  assert.equal(f.totals().activity.autoApproved, 0)
  assert.equal(f.history().record?.outcome, "manual")
  assert.equal(f.history().record?.approvingReview, reviewID(context))
})

test("settlement without dispatch can later receive a self-contained automatic confirmation", t => {
  const f = fixture(t)
  f.apply({ type: "approvalSettled", context, at: 190, approval: "write", result: "uncertain" })
  f.apply({ type: "approvalConfirmed", context, at: 200, approval: "write", automatic: true })
  f.apply(resolve()); assert.equal(f.history().record?.outcome, "auto")
  assert.equal(f.totals().activity.autoApproved, 1)
})

test("late dispatch fills missing approval identity without undoing settlement", t => {
  const f = fixture(t)
  f.apply({ type: "approvalSettled", context, at: 190, approval: "write", result: "not-sent" })
  f.apply({ type: "approvalDispatched", context, at: 180, approval: "write", automatic: true })
  f.apply(resolve()); assert.equal(f.history().record?.outcome, "manual")
  assert.throws(() => f.sql.apply("other", 1, encodeEvent({ type: "approvalConfirmed", context, at: 200, approval: "write", automatic: false })), /identity/)
  assert.equal(f.totals().activity.autoApproved, 0)
})

test("review identity ignores object property insertion order", t => {
  const f = fixture(t); f.apply(resolve())
  const reordered = Object.fromEntries(Object.entries(context).reverse()) as unknown as HistoryReview
  f.apply(resolve(reordered)); assert.equal(f.history().total, 1)
})

test("serialized pending events are revalidated before admission", () => {
  const accepted = { safe: true, completedAt: 100 }
  Object.defineProperty(accepted, "toJSON", { value: () => ({ ...accepted, desc: "SECRET_PENDING_TEXT" }) })
  assert.throws(() => encodeEvent({ type: "reviewAccepted", context, at: 100, accepted }), /Invalid history event/)
  const pending: HistoryEvent = { type: "reviewAccepted", context, at: 100, accepted: { safe: true, completedAt: 100 } }
  Object.defineProperty(pending, "toJSON", { value: () => resolve() })
  assert.throws(() => encodeEvent(pending), /Invalid history event/, "a pending event cannot serialize as a valid resolved event")
  const changing = { ...context }
  Object.defineProperty(changing, "root", { enumerable: true, get: () => "another root" })
  assert.throws(() => encodeEvent(resolve(changing)), /Invalid history event/)
})

test("symlinked ancestors are rejected before creating directories in their target", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "history-path-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, "target"), alias = path.join(directory, "alias")
  mkdirSync(target, { mode: 0o700 }); symlinkSync(target, alias)
  assert.throws(() => privateDatabase(path.join(alias, "new", "private", "history-v1.sqlite")))
  assert.equal(existsSync(path.join(target, "new")), false)
})

test("serialized bounds cover maximum escaped context and payload shapes without weakening decoded limits", t => {
  const f = fixture(t), text = "x" + "\u0001".repeat(4095)
  const c = { ...context, scope: "/" + "\u0001".repeat(4095), root: text, session: text,
    permission: text, review: text, configuredModel: text, provider: "https://example.com/" + "x".repeat(4076) }
  assert.equal(Buffer.byteLength(c.provider), 4096)
  f.apply(resolve(c))
  assert.equal((f.sql.query({ type: "history", scope: c.scope, root: c.root }) as HistorySelection).record?.context.configuredModel, text)
  const p = { ...payload, reportedModel: text, desc: "\u0001".repeat(65536),
    timing: { fullReportMs: Number.MAX_VALUE, ratingMs: Number.MIN_VALUE },
    usage: { input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER, cost: Number.MAX_VALUE } }
  f.apply(resolve(context, p))
  assert.deepEqual(f.history().record?.payload, p)
  assert.throws(() => encodeEvent(resolve(context, { ...p, desc: p.desc + "x" })))
  assert.throws(() => encodeEvent(resolve({ ...context, configuredModel: text + "x" })))
  assert.throws(() => encodeEvent(resolve(c, p)), "the independent event admission ceiling still bounds combined envelopes")
})
