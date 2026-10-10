import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as settle } from "node:timers/promises"
import { HistorySQL, type HistoryResult } from "../src/history-schema.js"
import { HistoryStore, type HistoryTransport } from "../src/history-store.js"
import { HistoryMaintenance } from "../src/history-maintenance.js"
import { HistoryRefresh } from "../src/history-refresh.js"
import { HistoryController } from "../src/history-controller.js"
import { encodeEvent, type HistoryEvent, type HistoryQuery, type HistoryReview } from "../src/history-records.js"

const scope = "/project"
const context: HistoryReview = { scope, root: "root", session: "root", permission: "p", review: "r",
  category: "bash", configuredModel: "fixture", provider: "https://fixture.invalid" }
const present = (id: string) => ({ response: { status: 200 }, data: { id } })
const missing = (id: string) => ({ response: { status: 404 }, error: { name: "NotFoundError", data: { message: `Session not found: ${id}` } } })
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

for (const { latency, idle } of [{ latency: 0, idle: false }, { latency: 1, idle: false }, { latency: 1, idle: true }])
  test(`scheduled 1,000-session recovery with ${latency}ms host reads${idle ? " from an idle timer" : ""} restores notification history before its deadline`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 })
  const f = fixture(t)
  for (let n = 0; n < 1000; n++) f.seed(resolved({ ...context, root: `root${n}`, session: `root${n}`, permission: `p${n}`, review: `r${n}` }))
  const ordered = f.sql.db.prepare("SELECT session FROM sessions ORDER BY id").all().map(row => row.session as string)
  const absent = new Set(ordered.slice(-10)), calls: { id: string; at: number }[] = []
  let active = 0, maximum = 0, readyAt: number | undefined
  const m = new HistoryMaintenance(scope, f.store, async id => {
    maximum = Math.max(maximum, ++active); calls.push({ id, at: Date.now() })
    try {
      if (latency) await new Promise(resolve => setTimeout(resolve, latency))
      return absent.has(id) ? missing(id) : present(id)
    } finally { active-- }
  }, undefined, Date.now)
  const browser = new HistoryController(scope, f.store, async id => id, state => {
    if (state.status === "ready") readyAt = Date.now()
  })
  t.after(() => { m.dispose(); browser.dispose() })
  if (idle) m.start()
  f.store.markMaintenanceDirty()
  const selected = ordered[0]!
  browser.openPermission(selected, { session: selected, permission: `p${selected.slice(4)}` }, () => {})
  if (!idle) m.start()
  await settle()
  // Drive the actual scheduled runner, including all inter-batch delays, not step().
  const bound = idle ? 5000 : 3000
  while (readyAt === undefined && Date.now() < bound) { t.mock.timers.tick(1); await settle() }
  assert.equal(f.store.maintenanceDirty, false)
  assert.equal(browser.state.status, "ready")
  assert.ok(readyAt !== undefined && readyAt < bound, `availability: ${readyAt}ms`)
  assert.equal(calls.length, 1990, "cleanup keeps its cursor; one complete healthy confirmation pass follows")
  assert.equal(maximum, 1); assert.equal(f.maximum(), 1)
  const pages = f.queries.filter(q => q.type === "sessions")
  assert.equal(pages.filter(q => q.after === undefined).length, 2, "own deletions never restart the current scan")
  assert.ok(pages.every(q => q.limit === 100))
  let burst = 0, longest = 0, last = -100
  for (const call of calls) {
    burst = call.at - last > latency ? 1 : burst + 1
    longest = Math.max(longest, burst); last = call.at
  }
  assert.ok(longest <= (latency ? 50 : 100), `bounded batch: ${longest} rows`)
  assert.equal(f.store.pendingOperations, 0)
  t.diagnostic(`1,000 roots, 10 absent: ready at ${readyAt}ms, ${calls.length} host reads, max batch ${longest}`)
})

test("an external dirty revision during an owned host read discards absence and restarts at the beginning", async t => {
  const f = fixture(t); f.seed(resolved())
  const held = deferred<unknown>(), started = deferred<void>(); let calls = 0
  const m = new HistoryMaintenance(scope, f.store, async id => {
    if (++calls === 1) { started.resolve(); return held.promise }
    return present(id)
  })
  t.after(() => m.dispose())
  f.store.markMaintenanceDirty()
  const first = m.step(); await started.promise
  f.store.markMaintenanceDirty(); await m.step()
  held.resolve(missing("root")); await first
  assert.equal(calls, 1); assert.equal(f.store.pendingOperations, 0)
  assert.equal(f.store.maintenanceDirty, true)
  await m.step()
  assert.equal(f.store.maintenanceDirty, false)
  const pages = f.queries.filter(q => q.type === "sessions")
  assert.deepEqual(pages.slice(0, 2).map(q => q.after), [undefined, undefined])
  assert.ok(pages[2]!.after)
  assert.equal((f.sql.query({ type: "history", scope, root: "root" }) as any).total, 1)
})

test("unknown root metadata and a bare 404 keep dirty recovery blocked until exact root-first reconciliation", async t => {
  const f = fixture(t); f.seed(resolved({ ...context, session: "child" }))
  let healthy = false
  const calls: string[] = []
  const m = new HistoryMaintenance(scope, f.store, async id => {
    calls.push(id)
    return healthy ? id === "root" ? present(id) : missing(id) : { response: { status: 404 } }
  })
  t.after(() => m.dispose())
  f.store.markMaintenanceDirty()
  for (let n = 0; n < 3; n++) await m.step()
  assert.equal(f.store.maintenanceDirty, true); assert.deepEqual(calls, ["root", "root", "root"])
  await assert.rejects(f.store.query({ type: "history", scope, root: "root" }))
  healthy = true
  for (let n = 0; n < 5 && f.store.maintenanceDirty; n++) { await m.step(); await settle() }
  assert.equal(f.store.maintenanceDirty, false)
  assert.deepEqual(calls.slice(3), ["root", "child"])
  assert.equal((await f.store.query({ type: "history", scope, root: "root" }) as any).total, 0)
})

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

test("maintenance and a queued destructive commit never publish the captured pre-deletion report", async t => {
  const f = fixture(t); f.seed(resolved())
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
  const m = new HistoryMaintenance(scope, f.store, async id => missing(id))
  t.after(() => { release.resolve(); browser.dispose(); m.dispose() })
  browser.open("root"); await captured.promise
  // This is the production deletion protocol: dirty before admission, then a
  // complete healthy maintenance pass before the history gate can reopen.
  f.store.markMaintenanceDirty()
  assert.equal(f.store.admit({ type: "sessionDeleted", context: { scope, root: "root", session: "root" }, at: 20 }), true)
  release.resolve(); await settle()
  assert.deepEqual(ready, []); assert.equal(browser.state.status, "loading")
  await m.step(); await settle()
  assert.equal(f.store.maintenanceDirty, false)
  assert.equal(browser.state.open, false)
  assert.deepEqual(ready, [])
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
