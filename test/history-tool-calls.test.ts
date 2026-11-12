import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HistorySQL, type HistoryTotals, type HistorySelection } from "../src/history-schema.js"
import { encodeEvent, reviewID, rootID, type HistoryEvent, type HistoryReview, type RetrievalCallTool } from "../src/history-records.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"
import { HISTORY_DELETE_STEPS } from "../src/history-deletion.js"
import { HISTORY_BOOTSTRAP_STEPS } from "../src/history-migration.js"
import { historyMetadata } from "../src/history-layout.js"
import { empty, validate } from "../src/lifetime.js"
import { hostStatisticsMessage } from "../src/host-statistics-view.js"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import { shellEvidence } from "./review-fixtures.js"

const context: HistoryReview = { scope: "/project", root: "root", session: "child", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const tool = (call: string, c = context, kind?: RetrievalCallTool): HistoryEvent =>
  ({ type: "toolDispatched", context: c, at: 100, call, ...(kind ? { tool: kind } : {}) })
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-tool-calls-")), file = path.join(dir, "history.sqlite")
  const db = new DatabaseSync(file), sql = new HistorySQL(db), clients = [sql]
  t.after(() => { clients.forEach(client => client.close()); rmSync(dir, { recursive: true, force: true }) })
  let sequence = 0
  return { db, sql, apply: (e: HistoryEvent) => sql.apply("writer", ++sequence, encodeEvent(e)),
    open: () => { const client = new HistorySQL(new DatabaseSync(file)); clients.push(client); return client } }
}
const totals = (sql: HistorySQL, c = context) => sql.query({ type: "totals", conversation: { scope: c.scope, root: c.root } }) as HistoryTotals

test("tool-call accounting commits both scopes atomically, deduplicates across writers and survives reopening and deletion", t => {
  const f = fixture(t), second = f.open()
  const usage: HistoryEvent = { type: "attemptFinalized", context, at: 100, attempt: "request", usage: { input: 19, output: 3, cost: 0.125 } }
  f.apply(usage); f.apply(tool("one"))
  const before = totals(f.sql)
  assert.equal(before.totals.activity.toolCalls, 1)
  assert.throws(() => second.apply("second", 1, encodeEvent(tool("two")), () => { throw Error("rollback") }), /rollback/)
  assert.deepEqual(totals(f.sql), before)
  assert.equal(f.db.prepare("SELECT count(*) n FROM retrieval_calls").get()!.n, 1)
  second.apply("second", 1, encodeEvent(tool("two")))
  second.apply("second", 1, encodeEvent(tool("two"))) // Lost acknowledgement replay.
  f.apply(tool("two")) // Duplicate fact through another writer.
  assert.equal(totals(f.sql).totals.activity.toolCalls, 2)
  const other = { ...context, root: "another", session: "another", permission: "other", review: "other" }
  f.apply(tool("one", other))
  const reopened = f.open(), result = totals(reopened)
  assert.equal(result.totals.activity.toolCalls, 3)
  assert.equal(result.conversation!.totals.activity.toolCalls, 2)
  assert.equal(totals(reopened, other).conversation!.totals.activity.toolCalls, 1)
  assert.deepEqual([result.totals.input, result.totals.output, result.totals.cost, result.totals.activity.reviews], [19, 3, 0.125, 0])
  f.apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.session }, at: 200 })
  const after = totals(f.sql)
  f.apply(tool("one")); f.apply(tool("two")); f.apply(usage)
  assert.deepEqual(totals(f.open()), after, "detail deletion and replay cannot reduce or duplicate recorded totals")
  assert.equal(f.db.prepare("SELECT count(*) n FROM retrieval_calls").get()!.n, 1, "deleted review calls are removed, unrelated calls remain")
})

test("legacy totals normalize only the absent tool count and preserve all existing accounting", t => {
  const f = fixture(t)
  f.apply({ type: "attemptFinalized", context, at: 10, attempt: "old", usage: { input: 200, output: 30, cost: 0.2 } })
  const expected = totals(f.sql)
  for (const table of ["meta", "conversation_totals"]) {
    const old = JSON.parse(String(f.db.prepare(`SELECT totals FROM ${table}`).get()!.totals))
    delete old.activity.toolCalls
    f.db.prepare(`UPDATE ${table} SET totals=?`).run(JSON.stringify(old))
  }
  f.db.exec("DROP TABLE retrieval_calls")
  assert.deepEqual(totals(f.open()), expected)
  f.apply(tool("new"))
  const next = totals(f.open())
  assert.deepEqual([next.totals.input, next.totals.output, next.totals.cost, next.totals.activity.toolCalls], [200, 30, 0.2, 1])
  assert.deepEqual(next.totals, next.conversation!.totals)
  for (const invalid of [-1, 0.5, null, "3", Infinity, undefined]) {
    assert.throws(() => validate({ ...empty(), activity: { ...empty().activity, toolCalls: invalid } } as any))
    if (invalid !== undefined) assert.throws(() => encodeEvent({ type: "permissionResolved", context, at: 1, outcome: "approved",
      payload: { safe: true, desc: "report", completedAt: 1, toolCalls: invalid } } as any))
  }
})

test("tool kinds use an additive side table: untyped and older calls stay unknown, invalid kinds are rejected, deletion removes kinds", t => {
  const f = fixture(t)
  f.apply(tool("old"))
  // A database from before kinds existed, still written by an older worker's three-value insert.
  f.db.exec("DROP TABLE retrieval_call_tools")
  f.db.prepare("INSERT INTO retrieval_calls VALUES (?,?,?)").run("legacy", reviewID(context), 1)
  const reopened = f.open()
  assert.equal(f.db.prepare("SELECT count(*) n FROM retrieval_call_tools").get()!.n, 0, "no backfill guesses earlier kinds")
  let sequence = 0
  const apply = (e: HistoryEvent) => reopened.apply("upgraded", ++sequence, encodeEvent(e))
  apply(tool("grep", context, "grep")); apply(tool("grep", context, "grep")); apply(tool("ask", context, "ask_context"))
  assert.equal(totals(reopened).totals.activity.toolCalls, 3)
  assert.deepEqual(f.db.prepare("SELECT tool FROM retrieval_call_tools ORDER BY tool").all().map(row => row.tool), ["ask_context", "grep"])
  f.db.prepare("INSERT INTO retrieval_calls VALUES (?,?,?)").run("after-upgrade", reviewID(context), 2)
  for (const invalid of ["finish", "bash", "", null, 1]) assert.throws(() => encodeEvent({ ...tool("x"), tool: invalid } as any))
  apply({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.session }, at: 200 })
  assert.equal(f.db.prepare("SELECT count(*) n FROM retrieval_call_tools").get()!.n, 0)
})

test("retrieval-only bootstrap and deletion stay bounded while preserving lifetime totals", t => {
  const f = fixture(t), count = HISTORY_BOOTSTRAP_STEPS * 3
  for (let index = 0; index < count; index++) f.apply(tool(String(index)))
  const before = totals(f.sql)
  f.db.exec("DELETE FROM conversation_totals")
  let slices = 0
  for (;;) {
    const result = f.sql.bootstrap(rootID(context))
    assert.ok(result.steps <= HISTORY_BOOTSTRAP_STEPS)
    slices++
    if (result.done) break
  }
  assert.ok(slices > 1)
  assert.deepEqual(totals(f.sql).totals, before.totals, "bootstrap never reconstructs or reapplies lifetime contributions")
  assert.deepEqual(totals(f.sql).conversation!.totals, before.conversation!.totals)
  const event = encodeEvent({ type: "sessionDeleted", context: { scope: context.scope, root: context.root, session: context.session }, at: 200 })
  assert.deepEqual(f.sql.applyReady("delete", 1, event), { deleting: true })
  assert.ok(Number(f.db.prepare("SELECT count(*) n FROM retrieval_calls").get()!.n) >= count - HISTORY_DELETE_STEPS,
    "a review deletion cannot cascade through unbounded retrieval calls")
  f.sql.apply("delete", 1, event)
  assert.equal(f.db.prepare("SELECT count(*) n FROM retrieval_calls").get()!.n, 0)
  assert.deepEqual(totals(f.open()).totals, before.totals)
})

test("real retrieval, report resolution and interrupted work feed history and identical statistics fields", async t => {
  const f = fixture(t), config = parseConfig({ baseURL: context.provider, model: context.configuredModel })
  const coordinator = new HistoryCoordinator(context.scope, {
    admit(event) { f.apply(event); return true }, query: async query => f.sql.query(query), onCommit: () => () => {},
  }, async () => context.root, () => 100)
  t.after(() => coordinator.dispose())
  const request = { id: context.permission, sessionID: context.session, action: "shell", resources: ["pwd"] }
  const observation = coordinator.observation(request, "shell", config, { review: context.review, root: context.root })
  let posts = 0
  const fetcher: typeof fetch = async () => {
    posts++
    const toolCall = (name: string, args: unknown) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } })
    return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ finish_reason: posts < 3 ? "tool_calls" : "stop",
      message: posts === 1 ? { tool_calls: [toolCall("read", { path: "missing" }), toolCall("list", { path: "." })] }
        : posts === 2 ? { tool_calls: [toolCall("finish", { items: [] })] } : { content: '{"safe":false,"reason":"Decisive reason.","desc":"Missing context."}' } }] })
  }
  const result = await review(shellEvidence(), config, new AbortController().signal, { fetcher, observation,
    retrieval: { async execute(call) { return { tool: call.tool, status: "error", reason: "ENOENT" } } } })
  assert.equal(result.toolCalls, 2)
  assert.deepEqual(f.db.prepare("SELECT tool FROM retrieval_call_tools ORDER BY tool").all().map(row => row.tool), ["list", "read"],
    "dispatched kinds are recorded beside the count")
  coordinator.lifecycle({ type: "accepted", request, root: context.root, review: context.review, result,
    completedAt: 100, timing: { fullReportMs: 20, ratingMs: 20 } })
  coordinator.reply({ requestID: request.id, sessionID: request.sessionID, reply: "reject" })
  const saved = f.sql.query({ type: "history", scope: context.scope, root: context.root }) as HistorySelection
  assert.equal(saved.record!.payload.toolCalls, 2)
  assert.deepEqual(historyMetadata(saved.record!).split("\n").slice(0, 2), ["tokens: 30 in 6 out", "tool calls: 2"])
  const both = totals(f.sql)
  assert.deepEqual(both.totals, both.conversation!.totals)
  const state = { open: true, view: "lifetime" as const, unavailable: false, ancestry: "ready" as const,
    totals: both.totals, conversation: both.conversation }
  assert.equal(hostStatisticsMessage(state), hostStatisticsMessage({ ...state, view: "conversation" }))
  assert.match(hostStatisticsMessage(state), /Tokens: 30 in 6 out\nTool calls: 2\nCost:/)
  const abort = new AbortController(), interrupted = { review: "interrupted", root: context.root }
  posts = 0
  await assert.rejects(review(shellEvidence(), config, abort.signal, { fetcher,
    observation: coordinator.observation(request, "shell", config, interrupted),
    retrieval: { async execute() { abort.abort(Error("cancelled")); throw abort.signal.reason } } }), /cancelled/)
  assert.equal(totals(f.open()).totals.activity.toolCalls, 3, "interrupted work persists independently of saved reports")
  assert.equal((f.sql.query({ type: "history", scope: context.scope, root: context.root }) as HistorySelection).total, 1)
  assert.equal(totals(f.sql).totals.activity.retries, 0, "tool calls and normal retrieval turns are not retries")
})
