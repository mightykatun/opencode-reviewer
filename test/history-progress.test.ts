import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as settle } from "node:timers/promises"
import { HistorySQL, type HistoryResult } from "../src/history-schema.js"
import { HistoryStore, type HistoryTransport } from "../src/history-store.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"
import { HistoryRefresh } from "../src/history-refresh.js"
import { HistoryController } from "../src/history-controller.js"
import { encodeEvent, type HistoryEvent, type HistoryQuery, type HistoryReview } from "../src/history-records.js"

const scope = "/project"
const context: HistoryReview = { scope, root: "root", session: "root", permission: "p", review: "r",
  category: "bash", configuredModel: "fixture", provider: "https://fixture.invalid" }
const resolved = (c = context): HistoryEvent => ({ type: "permissionResolved", context: c, at: 10,
  outcome: "manual", payload: { safe: true, completedAt: 10, desc: "Saved report" } })
const usage = (n: number): HistoryEvent => ({ type: "attemptFinalized", context, at: n + 20, attempt: `a${n}`,
  usage: { input: 1, output: 2 } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

/** Real FIFO/read scheduling and real SQL, with only the transport boundary controlled. */
function fixture(t: TestContext) {
  const sql = new HistorySQL(new DatabaseSync(":memory:"))
  let sequence = 0, active = 0, maximum = 0
  const queries: HistoryQuery[] = []
  const f = {
    sql, queries,
    before: async (_message: Record<string, unknown>) => {},
    after: async (_message: Record<string, unknown>, _result: unknown) => {},
    seed: (event: HistoryEvent) => sql.apply("seed", ++sequence, encodeEvent(event)),
    maximum: () => maximum,
  }
  const transport: HistoryTransport = { terminate: async () => {}, call: async message => {
    maximum = Math.max(maximum, ++active)
    try {
      await f.before(message)
      let result: unknown
      if (message.type === "query") { queries.push(message.query as HistoryQuery); result = sql.query(message.query as HistoryQuery) }
      if (message.type === "apply") result = sql.apply(message.writer as string, message.sequence as number, message.event as string)
      await f.after(message, result)
      return result
    } finally { active-- }
  } }
  const store = new HistoryStore("/state", { transport: () => transport })
  t.after(async () => { await store.dispose(); sql.close() })
  return { ...f, store, hooks: f }
}

for (const pattern of ["burst", "continuous"] as const) for (const type of ["history", "totals"] as const)
  test(`${type} publishes useful same-selection snapshots during ${pattern} writes before the FIFO drains`, async t => {
    const f = fixture(t); f.seed(resolved())
    // Let every SQL operation settle asynchronously, so the production scheduler
    // really alternates queued reads with writes and commit notifications.
    f.hooks.before = async message => { if (message.type === "apply") await settle() }
    let admitted = 0, committed = 0
    const enqueue = () => { assert.equal(f.store.admit(usage(admitted++)), true) }
    const off = f.store.onCommit(() => {
      committed++
      if (pattern === "continuous" && admitted < 40) enqueue()
    })
    t.after(off)
    for (let n = 0; n < (pattern === "burst" ? 40 : 8); n++) enqueue()
    const snapshots: { value: HistoryResult; pending: number; committed: number }[] = []
    const query: HistoryQuery = type === "history" ? { type, scope, root: "root" } : { type }
    const refresh = new HistoryRefresh(f.store, query, value => {
      if (value) snapshots.push({ value, pending: f.store.pendingOperations, committed })
    })
    t.after(() => refresh.dispose())
    while (committed < 40) await settle()
    await settle()
    const during = snapshots.filter(s => s.pending > 0)
    assert.ok(during.length >= 10, `only ${during.length} useful snapshots before drain`)
    assert.ok(during[0]!.committed <= 2, "the first useful committed snapshot must not wait for the backlog")
    assert.ok(during.at(-1)!.committed > during[0]!.committed)
    if (type === "history") assert.ok(during.every(s => "rank" in s.value && s.value.record?.payload.desc === "Saved report"))
    else {
      assert.ok(during.every(s => "totals" in s.value && s.value.totals.requests > 0))
      const last = snapshots.at(-1)!.value
      assert.equal("totals" in last && last.totals.requests, 40)
    }
    assert.equal(f.maximum(), 1)
  })

test("an exact notification history target opens before an ordinary write backlog drains", async t => {
  const f = fixture(t); f.seed(resolved())
  f.hooks.before = async message => { if (message.type === "apply") await settle() }
  for (let n = 0; n < 40; n++) assert.equal(f.store.admit(usage(n)), true)
  let pendingAtOpen = 0
  const browser = new HistoryController(scope, f.store, async () => "root", () => {})
  t.after(() => browser.dispose())
  browser.openPermission("root", { session: "root", permission: "p" }, () => { pendingAtOpen = f.store.pendingOperations })
  while (f.store.pendingOperations) await settle()
  assert.equal(browser.state.open, true)
  assert.ok(pendingAtOpen >= 35, `notification opened with only ${pendingAtOpen} pending writes`)
  assert.equal(browser.state.selection?.record?.context.permission, "p")
})

for (const session of ["root", "child"]) test(`known live ${session} deletion and a queued destructive commit never publish the captured pre-deletion report`, async t => {
  const f = fixture(t); f.seed(resolved({ ...context, session }))
  const captured = deferred<void>(), release = deferred<void>()
  let hold = true
  f.hooks.after = async message => {
    if (hold && message.type === "query" && (message.query as HistoryQuery).type === "history") {
      hold = false; captured.resolve(); await release.promise
    }
  }
  const ready: string[] = []
  const browser = new HistoryController(scope, f.store, async () => "root", state => {
    if (state.status === "ready" && state.selection?.record) ready.push(state.selection.record.payload.desc)
  })
  const history = new HistoryCoordinator(scope, f.store, async () => "root", () => 20)
  t.after(() => { release.resolve(); browser.dispose(); history.dispose() })
  browser.open("root"); await captured.promise
  // Exact live deletion with already-known scope/root ownership, not offline
  // authority inferred from a location index or a missing-session response.
  browser.deleted(session)
  history.deleted({ scope, root: "root", session })
  assert.equal(browser.state.selection?.record, undefined)
  release.resolve(); await settle()
  while (f.store.pendingOperations) await settle()
  await settle()
  assert.equal(f.store.maintenanceDirty, false)
  assert.equal(browser.state.open, session !== "root")
  if (session !== "root") { assert.equal(browser.state.status, "ready"); assert.equal(browser.state.selection?.total, 0) }
  assert.deepEqual(ready, [])
  const stored = await f.store.query({ type: "history", scope, root: "root" })
  assert.equal("total" in stored && stored.total, 0)
  assert.equal("deleted" in stored && !!stored.deleted, session === "root")
})

for (const action of ["navigate", "dispose"] as const) test(`${action} remains a hard invalidation while commits are soft`, async t => {
  const f = fixture(t); f.seed(resolved()); f.seed(resolved({ ...context, root: "other", session: "other", permission: "other", review: "other" }))
  const captured = deferred<void>(), release = deferred<void>()
  let hold = true
  f.hooks.after = async message => {
    if (hold && message.type === "query") { hold = false; captured.resolve(); await release.promise }
  }
  const roots: string[] = []
  const refresh = new HistoryRefresh(f.store, { type: "history", scope, root: "root" }, value => {
    if (value && "rank" in value && value.record) roots.push(value.record.context.root)
  })
  t.after(() => { release.resolve(); refresh.dispose() })
  await captured.promise
  for (let n = 0; n < 10; n++) assert.equal(f.store.admit(usage(n)), true)
  if (action === "navigate") refresh.select({ type: "history", scope, root: "other" })
  else refresh.dispose()
  release.resolve(); await settle()
  assert.deepEqual([...new Set(roots)], action === "navigate" ? ["other"] : [])
  assert.equal(f.maximum(), 1)
})

test("timed-out refresh owns its actual read until settlement across polling, navigation and commits", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const f = fixture(t); f.seed(resolved()); f.seed(resolved({ ...context, root: "other", session: "other", permission: "other", review: "other" }))
  const captured = deferred<void>(), release = deferred<void>()
  let hold = true
  f.hooks.after = async message => {
    if (hold && message.type === "query") { hold = false; captured.resolve(); await release.promise }
  }
  const roots: string[] = []
  const refresh = new HistoryRefresh(f.store, { type: "history", scope, root: "root" }, value => {
    if (value && "rank" in value && value.record) roots.push(value.record.context.root)
  })
  t.after(() => { release.resolve(); refresh.dispose() })
  await captured.promise
  t.mock.timers.tick(3000); await settle()
  for (let n = 0; n < 10; n++) refresh.select({ type: "history", scope, root: "other" })
  assert.equal(f.store.admit(usage(1)), true)
  t.mock.timers.tick(2000); await settle()
  assert.equal(f.queries.length, 1); assert.equal(f.maximum(), 1)
  assert.deepEqual(roots, [])
  release.resolve(); await settle()
  assert.deepEqual([...new Set(roots)], ["other"])
  assert.equal(f.maximum(), 1)
})
