import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { readProductionHistory, savedStageHistory, assertWriteEvidence } from "../scripts/smoke-v2-review-support.mjs"

const opaque = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
function records(count) {
  const expected = Array.from({ length: count }, (_, index) => ({ action: count === 2 && index === 0 ? "external_directory" : "edit",
    request: { id: `permission-${index}` }, description: `report-${index}` }))
  const rows = expected.map((stage, index) => ({ id: opaque("scope", stage.request.id), review: `review-${index}`,
    root: opaque("scope", "root"), session: opaque("scope", "root"), outcome: "auto", resolution: "auto", approving: `review-${index}`,
    context: JSON.stringify({ scope: "scope", root: "root", session: "root", permission: stage.request.id,
      category: stage.action, configuredModel: "v2-production-reviewer" }), accepted: '{"safe":true}',
    body: JSON.stringify({ safe: true, desc: stage.description, usage: { input: 23, output: 11 } }) }))
  const totals = { requests: count, tokenRequests: count, input: 23 * count, output: 11 * count, safe: count, unsafe: 0,
    priced: 0, cost: 0, activity: { reviews: count, autoApproved: count, usageRequests: count, retries: 0, timedReviews: count } }
  return { expected, value: { rows, payloadCount: count, meta: { version: 1, totals: JSON.stringify(totals) },
    conversations: [{ id: opaque("scope", "root"), totals: JSON.stringify(totals), partial: 0 }],
    reviews: rows.map(row => ({ id: row.review, root: row.root, session: row.session, context: row.context, accepted: row.accepted })),
    attempts: rows.map(row => ({ review: row.review, dispatched: '{"retry":"initial"}', finalized: '{"usage":{"input":23,"output":11}}' })),
    approvals: rows.map(row => ({ review: row.review, state: "confirmed", entry: row.id, automatic: 1 })) } }
}

test("native-stage history assertions reject wrong usage, attribution and categories instead of trusting stored totals", () => {
  for (const count of [1, 2]) {
    const { expected, value } = records(count)
    assert.equal(savedStageHistory(value, expected, "root").rows.length, count)
    for (const corrupt of [
      copy => { const totals = JSON.parse(copy.meta.totals); totals.input++; copy.meta.totals = JSON.stringify(totals) },
      copy => { copy.rows[0].outcome = "manual" },
      copy => { const context = JSON.parse(copy.rows[0].context); context.category = "bash"; copy.rows[0].context = JSON.stringify(context) },
      copy => { copy.approvals[0].automatic = 0 },
      copy => { copy.payloadCount++ },
      copy => { copy.attempts.push(copy.attempts[0]) },
    ]) {
      const copy = structuredClone(value); corrupt(copy)
      assert.throws(() => savedStageHistory(copy, expected, "root"), assert.AssertionError)
    }
    const awaiting = structuredClone(value); awaiting.approvals[0].state = "dispatched"
    assert.equal(savedStageHistory(awaiting, expected, "root"), undefined)
    const unfinalized = structuredClone(value); unfinalized.attempts[0].finalized = null
    assert.equal(savedStageHistory(unfinalized, expected, "root"), undefined)
  }
})

test("native write evidence expectations reject full target snapshots, raw write bodies and reconstructed changes", () => {
  const expected = { action: "edit", target: "target.txt", prompt: "Write the marker", initial: "/project/invocation", project: "/project" }
  const evidence = { kind: "edit", tool: "write", permission: { action: "edit" }, operation: { input: { path: "target.txt" } },
    userPrompt: expected.prompt, location: { directory: expected.initial }, project: { directory: expected.project }, partial: false,
    changes: [{ file: "target.txt", status: "included", hostStatus: "modified", patch: "-V2_EDIT_BEFORE\n+V2_EDIT_AFTER" }] }
  assertWriteEvidence(evidence, expected)
  for (const corrupt of [copy => { copy.files = [] }, copy => { copy.operation.input.content = "invented" },
    copy => { copy.partial = true }, copy => { copy.changes[0].patch = "invented diff" }]) {
    const copy = structuredClone(evidence); corrupt(copy)
    assert.throws(() => assertWriteEvidence(copy, expected), assert.AssertionError)
  }
})

test("read-only production SQL probes never initialize missing databases or mutate committed bytes", async () => {
  const directory = await mkdtemp("/tmp/opencode/reviewer-sql-probe-")
  const file = path.join(directory, "history-v1.sqlite")
  try {
    assert.equal(await readProductionHistory(file), undefined)
    const db = new DatabaseSync(file)
    try {
      const empty = await readFile(file)
      assert.equal(await readProductionHistory(file), undefined, "Created file without schema remains pending")
      assert.deepEqual(await readFile(file), empty)
      db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE")
      db.exec(`CREATE TABLE history(id TEXT,review TEXT,completed INTEGER,tie TEXT);
        CREATE TABLE reviews(id TEXT,context TEXT,accepted TEXT,root TEXT,session TEXT);
        CREATE TABLE payloads(id TEXT,body TEXT); CREATE TABLE attempts(id TEXT,review TEXT,dispatched TEXT,finalized TEXT);
        CREATE TABLE approvals(id TEXT); CREATE TABLE meta(id INTEGER,version INTEGER,revision INTEGER,totals TEXT);
        CREATE TABLE conversation_totals(id TEXT,totals TEXT,partial INTEGER);
        INSERT INTO meta VALUES(1,1,7,'{}');`)
      assert.equal(await readProductionHistory(file), undefined, "Uncommitted schema remains pending")
      db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")
    } finally { db.close() }
    const before = await readFile(file)
    const value = await readProductionHistory(file)
    assert.equal(value.meta.revision, 7)
    assert.equal(value.payloadCount, 0)
    for (const key of ["rows", "reviews", "attempts", "approvals", "conversations"]) assert.deepEqual(value[key], [])
    assert.deepEqual(await readFile(file), before)
    const alias = path.join(directory, "alias.sqlite"); await symlink(file, alias)
    await assert.rejects(readProductionHistory(alias), /Actual isolated production database/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("history polling owns transient initialization locks but rejects partial schema and corrupt bytes", async t => {
  const directory = await mkdtemp("/tmp/opencode/reviewer-sql-startup-")
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, "history.sqlite"), db = new DatabaseSync(file)
  try {
    db.exec("BEGIN EXCLUSIVE; CREATE TABLE unfinished(id INTEGER)")
    assert.equal(await readProductionHistory(file), undefined, "Exclusive initialization is pending within the existing poll budget")
    db.exec("COMMIT")
    await assert.rejects(readProductionHistory(file), /no such table: history/, "Committed partial schema is corruption, not pending")
  } finally { db.close() }
  const corrupt = path.join(directory, "corrupt.sqlite")
  await writeFile(corrupt, "This is not a SQLite database")
  await assert.rejects(readProductionHistory(corrupt), /not a database/)
})
