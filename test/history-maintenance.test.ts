import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistoryMaintenance, sessionPresence } from "../src/history-maintenance.js"
import { HistorySQL } from "../src/history-schema.js"
import type { HistoryEvent, HistoryReview } from "../src/history-records.js"
import { encodeEvent } from "../src/history-records.js"
import { HistoryStore, type HistoryTransport } from "../src/history-store.js"
import { HistoryController } from "../src/history-controller.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"
import { setImmediate as settle } from "node:timers/promises"

const present = (id: string) => ({ response: { status: 200 }, data: { id } })
const missing = (session = "root") => ({ response: { status: 404 }, error: { name: "NotFoundError", data: { message: `Session not found: ${session}` } } })
const context: HistoryReview = { scope: "/project", root: "root", session: "child", permission: "p", review: "r",
  category: "bash", configuredModel: "fixture", provider: "https://fixture.invalid" }
const resolved = (c = context): HistoryEvent => ({ type: "permissionResolved", context: c, at: 10,
  outcome: "manual", payload: { safe: true, completedAt: 10, desc: "Private resolved report" } })

test("absence requires the pinned session.get HTTP status and exact NotFound envelope", () => {
  assert.equal(sessionPresence(missing("child"), "child"), "missing")
  assert.equal(sessionPresence(present("child"), "child"), "present")
  for (const result of [undefined, {}, { data: undefined }, { response: { status: 404 } },
    { ...missing(), response: { status: 403 } }, { ...missing(), data: {} },
    { ...missing(), error: { name: "NotFoundError", data: {} } },
    { ...missing(), error: { _tag: "SessionNotFoundError", sessionID: "child" } },
    { ...missing(), error: { name: "NotFoundError", data: { message: "x", extra: true } } },
    missing("other"), present("other"), { data: [{ id: "child" }], response: { status: 200 } }])
    assert.equal(sessionPresence(result, "child"), "unknown")
})

function fixture(t: any) {
  const dir = mkdtempSync(path.join(tmpdir(), "maintenance-")), file = path.join(dir, "history.sqlite")
  const sql = new HistorySQL(new DatabaseSync(file)), second = new HistorySQL(new DatabaseSync(file))
  let sequence = 0, fail = false, revision = 0, scanRevision = 0, dirty = false
  const events: HistoryEvent[] = []
  const apply = (event: HistoryEvent) => sql.apply("seed", ++sequence, encodeEvent(event))
  const store = {
    query: async (q: any) => second.query(q),
    admit: (event: HistoryEvent) => { events.push(event); if (fail) return false; apply(event); return true },
    get maintenanceRevision() { return revision },
    get maintenanceScanRevision() { return scanRevision },
    get maintenanceDirty() { return dirty },
    get maintenancePending() { return false },
    markMaintenanceDirty: (origin?: "cleanup") => { revision++; if (origin !== "cleanup") scanRevision++; dirty = true; return revision },
    maintenanceReconciled: (r = revision) => { if (r !== revision || fail) return false; dirty = false; return true },
  }
  t.after(() => { second.close(); sql.close(); rmSync(dir, { recursive: true, force: true }) })
  return { sql, second, apply, store, events, fail: (value: boolean) => { fail = value }, dirty: () => dirty }
}

test("two real SQLite clients: root first without root ownership row, cascading detail deletion, totals and replay retained", async t => {
  const f = fixture(t)
  for (const session of ["child", "grandchild"]) {
    const c = { ...context, session, review: session, permission: session }
    f.apply({ type: "reviewAccepted", context: c, at: 10, accepted: { safe: true, completedAt: 10 } })
    f.apply({ type: "attemptFinalized", context: c, at: 10, attempt: "a", usage: { input: 2, output: 1, cost: 0.01 } })
    f.apply(resolved(c))
  }
  f.apply(resolved({ ...context, scope: "/other" }))
  const totals = f.second.query({ type: "totals" }), calls: string[] = []
  const m = new HistoryMaintenance(context.scope, f.store, async id => { calls.push(id); return missing() })
  await m.step(); await m.step()
  assert.deepEqual(calls, ["root"])
  assert.deepEqual(f.second.query({ type: "totals" }), totals)
  assert.deepEqual(f.second.query({ type: "sessions", scope: context.scope }), { sessions: [], after: undefined })
  assert.equal((f.second.query({ type: "history", scope: "/other", root: "root" }) as any).total, 1)
  f.apply(resolved()) // Late body from another writer cannot resurrect.
  assert.equal((f.second.query({ type: "history", scope: context.scope, root: "root" }) as any).deleted, true)
  assert.equal(f.sql.db.prepare("SELECT count(*) n FROM attempts").get()!.n, 0)
  assert.equal(f.sql.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 1)
  m.dispose()
})

test("child-only absence retains root and sibling; transient/inaccessible root never permits child probing or deletion", async t => {
  const f = fixture(t)
  for (const session of ["root", "child", "sibling"]) f.apply(resolved({ ...context, session, permission: session, review: session }))
  let inaccessible = true
  const calls: string[] = []
  const m = new HistoryMaintenance(context.scope, f.store, async id => {
    calls.push(id)
    if (inaccessible) return { ...missing(), response: { status: 403 } }
    return id === "child" ? missing(id) : present(id)
  })
  for (let n = 0; n < 4; n++) await m.step()
  assert.equal(f.events.length, 0); assert.ok(calls.every(id => id === "root"))
  inaccessible = false
  for (let n = 0; n < 8; n++) await m.step()
  assert.equal((f.second.query({ type: "history", scope: context.scope, root: "root" }) as any).total, 2)
  assert.deepEqual(f.events.map(e => e.context.session), ["child"])
  assert.equal(f.dirty(), false)
  m.dispose()
})

test("saturated deletion retries via dirty revision, does not clear after an incomplete or failed pass", async t => {
  const f = fixture(t); f.apply(resolved()); f.fail(true); f.store.markMaintenanceDirty()
  const m = new HistoryMaintenance(context.scope, f.store, async () => missing())
  await m.step(); assert.equal(f.dirty(), true)
  f.fail(false)
  for (let n = 0; n < 5; n++) await m.step()
  assert.equal(f.dirty(), false)
  assert.equal((f.second.query({ type: "history", scope: context.scope, root: "root" }) as any).deleted, true)
  m.dispose()
})

test("indexed pages stay <=100, one row per turn, scopes isolated, dirty revision during scan requires restart", async t => {
  const f = fixture(t)
  for (let n = 0; n < 105; n++) f.apply(resolved({ ...context, session: "s" + n, permission: "p" + n, review: "r" + n }))
  const pages: any[] = [], calls: string[] = []
  const store = { ...f.store, get maintenanceRevision() { return f.store.maintenanceRevision },
    get maintenanceDirty() { return f.store.maintenanceDirty },
    get maintenanceScanRevision() { return f.store.maintenanceScanRevision }, query: async (q: any) => {
    pages.push(q); return f.store.query(q)
  } }
  const m = new HistoryMaintenance(context.scope, store, async id => { calls.push(id); return present(id) })
  for (let n = 0; n < 106; n++) await m.step()
  assert.equal(calls.length, 210); assert.equal(pages.length, 3)
  assert.ok(pages.every(q => q.limit === 100 && q.scope === context.scope))
  assert.ok(pages[1].after); assert.ok(pages[2].after)
  f.store.markMaintenanceDirty(); await m.step()
  assert.equal(pages.at(-1).after, undefined); assert.equal(f.dirty(), true)
  m.dispose()
})

test("aborted host transaction retains actual ownership, late NotFound ignored, no post-disposal work", async t => {
  const f = fixture(t); f.apply(resolved())
  let release!: (value: any) => void, started!: () => void, calls = 0
  const began = new Promise<void>(resolve => { started = resolve })
  const m = new HistoryMaintenance(context.scope, f.store, async () => {
    calls++; started(); return new Promise(resolve => { release = resolve })
  })
  const first = m.step(); await began; await m.step(); assert.equal(calls, 1)
  m.dispose(); release(missing()); await first; await m.step()
  assert.equal(calls, 1); assert.equal(f.events.length, 0)
})

test("timed-out storage read retains settled ownership instead of spawning replacement scans", async () => {
  let release!: () => void, calls = 0
  const settled = new Promise<void>(resolve => { release = resolve })
  const store = { query: () => { calls++; return Object.assign(Promise.reject(Error("timeout")), { settled }) },
    admit: () => true, maintenanceDirty: false, maintenanceRevision: 0, maintenanceScanRevision: 0, maintenancePending: false,
    maintenanceReconciled: () => true, markMaintenanceDirty: () => 0 }
  const m = new HistoryMaintenance("/project", store, async () => { throw Error("unexpected") })
  const first = m.step(); await Promise.resolve(); await m.step(); assert.equal(calls, 1)
  m.dispose(); release(); await first; await m.step(); assert.equal(calls, 1)
})

test("host timeout retains its slot through actual settlement and ignores late missing", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t); f.apply(resolved())
  let release!: (value: unknown) => void, signal!: AbortSignal, calls = 0
  const m = new HistoryMaintenance(context.scope, f.store, async (_id, s) => {
    calls++; signal = s; return new Promise(resolve => { release = resolve })
  })
  const first = m.step()
  for (let n = 0; n < 4; n++) await Promise.resolve()
  t.mock.timers.tick(1500); assert.equal(signal.aborted, true)
  await m.step(); assert.equal(calls, 1)
  release(missing()); await first; assert.equal(f.events.length, 0)
  m.dispose()
})

test("live deleted-child lookup saturation retains only a dirty signal, recovery scan removes every missed child", async t => {
  const f = fixture(t)
  for (let n = 0; n < 3; n++) f.apply(resolved({ ...context, session: "child" + n, permission: "p" + n, review: "r" + n }))
  const pending: (() => void)[] = []
  let reads = 0
  const coordinator = new HistoryCoordinator(context.scope, {
    ...f.store, onCommit: () => () => {}, query: async q => {
      reads++; await new Promise<void>(resolve => pending.push(resolve)); throw Error("unavailable")
    },
  }, async () => { throw Error("deleted ancestry must not be required") })
  const deletes = [0, 1, 2].map(n => coordinator.sessionDeleted({ id: "child" + n, parentID: "root" }))
  assert.equal(reads, 2); assert.equal(f.dirty(), true)
  for (const release of pending) release()
  await Promise.all(deletes)
  const m = new HistoryMaintenance(context.scope, f.store, async id => id === "root" ? present(id) : missing(id))
  for (let n = 0; n < 5; n++) await m.step()
  assert.equal((f.second.query({ type: "history", scope: context.scope, root: "root" }) as any).total, 0)
  assert.equal(f.dirty(), false)
  coordinator.dispose(); m.dispose()
})

test("maintenance indexes upgrade an existing v1 store and scope pages use an indexed cursor", t => {
  const f = fixture(t)
  f.sql.db.exec("DROP INDEX sessions_root; DROP INDEX attempts_review; DROP INDEX history_root; DROP INDEX approvals_root; DROP INDEX approvals_session")
  const upgraded = new HistorySQL(f.sql.db)
  const indexes = f.sql.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name)
  for (const name of ["sessions_root", "attempts_review", "history_root", "approvals_root", "approvals_session"]) assert.ok(indexes.includes(name))
  const plan = f.sql.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE scope=? AND id>? ORDER BY id LIMIT 100").all("/project", "")
  assert.match(JSON.stringify(plan), /sessions_scope/)
  assert.equal((upgraded.query({ type: "totals" }) as any).revision, 0)
})

test("dirty gate suppresses already-dispatched history snapshots and open UI until reconciliation, totals remain readable", async t => {
  const f = fixture(t); f.apply(resolved())
  let release!: () => void, began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  let hold = true
  const transport: HistoryTransport = { terminate: async () => {}, call: async message => {
    if (message.type === "open") return
    const result = f.second.query(message.query as any)
    if (hold && (message.query as any).type === "history") {
      hold = false; began(); await new Promise<void>(resolve => { release = resolve })
    }
    return result
  } }
  const store = new HistoryStore("/state", { transport: () => transport })
  const browser = new HistoryController(context.scope, store, async () => "root", () => {})
  t.after(async () => { browser.dispose(); await store.dispose() })
  browser.open("root"); await started
  store.markMaintenanceDirty(); release(); await new Promise(resolve => setImmediate(resolve))
  assert.notEqual(browser.state.status, "ready")
  assert.deepEqual(await store.query({ type: "totals" }), f.second.query({ type: "totals" }))
  const revision = store.maintenanceRevision
  store.markMaintenanceDirty(); assert.equal(store.maintenanceReconciled(revision), false)
  assert.equal(store.maintenanceReconciled(store.maintenanceRevision), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(browser.state.status, "ready")
  browser.recordScroll(17)
  const reset = browser.state.reset
  // Deletion elsewhere in this host scope temporarily replaces this report too.
  store.markMaintenanceDirty()
  assert.equal(browser.state.status, "loading")
  browser.recordScroll(0)
  assert.equal(browser.scroll, 17)
  assert.equal(store.maintenanceReconciled(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(browser.state.status, "ready")
  assert.equal(browser.scroll, 17)
  assert.ok(browser.state.reset > reset)
})

test("production scheduler reconciles a surviving prefix and missing suffix across pages in linear work", async t => {
  const f = fixture(t)
  for (let n = 0; n < 110; n++) f.apply(resolved({ ...context, root: `root${n}`, session: `root${n}`, permission: `p${n}`, review: `r${n}` }))
  const first = f.sql.query({ type: "sessions", scope: context.scope, limit: 100 }) as any
  const last = f.sql.query({ type: "sessions", scope: context.scope, after: first.after }) as any
  const absent = new Set<string>(last.sessions.map((c: any) => c.session))
  let lookups = 0
  const store = new HistoryStore("/state", { transport: () => ({ async call(m) {
    if (m.type === "apply") return f.sql.apply(m.writer as string, m.sequence as number, m.event as string)
    if (m.type === "query") return f.sql.query(m.query as any)
    return {}
  }, async terminate() {} }) })
  const m = new HistoryMaintenance(context.scope, store, async id => { lookups++; return absent.has(id) ? missing(id) : present(id) })
  t.after(async () => { m.dispose(); await store.dispose(performance.now() - 3500) })
  store.markMaintenanceDirty()
  let turns = 0
  while (store.maintenanceDirty && turns < 230) { turns++; await m.step(); await settle() }
  assert.equal(store.maintenanceDirty, false, `reconciliation still dirty after ${turns} turns and ${lookups} lookups`)
  assert.ok(lookups <= 220, `linear bound exceeded: ${lookups}`)
  t.diagnostic(`110 indexed roots, 10 absent: ${lookups} host lookups, ${turns} turns including final healthy pass`)
  assert.equal(store.pendingOperations, 0)
  assert.equal((f.sql.query({ type: "sessions", scope: context.scope }) as any).sessions.length, 100)
})

test("cleanup invalidates cached root descendants across pages and external changes restart the final pass", async t => {
  const f = fixture(t)
  for (let n = 0; n < 105; n++) f.apply(resolved({ ...context, session: `child${n}`, permission: `p${n}`, review: `r${n}` }))
  f.apply(resolved({ ...context, root: "alive", session: "alive", permission: "alive", review: "alive" }))
  let calls = 0
  const m = new HistoryMaintenance(context.scope, f.store, async id => { calls++; return id === "root" ? missing(id) : present(id) })
  t.after(() => m.dispose())
  f.store.markMaintenanceDirty()
  for (let n = 0; n < 4; n++) await m.step()
  // An external event during/restarting confirmation must not be absorbed into cleanup's revision.
  f.store.markMaintenanceDirty()
  assert.equal(f.dirty(), true)
  await m.step(); assert.equal(f.dirty(), false, "the surviving row and empty page fit in one recovery batch")
  assert.ok(calls <= 6, `root cascade should invalidate every cached child: ${calls}`)
  assert.equal(f.events.filter(e => e.type === "sessionDeleted").length, 1)
  assert.equal((f.sql.query({ type: "sessions", scope: context.scope }) as any).sessions.length, 1)
})

test("queued cleanup and a transient commit failure cannot release the gate before durable cleanup and confirmation", async t => {
  const f = fixture(t); f.apply(resolved())
  let release!: () => void, fail = true, retry!: () => void, now = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const store = new HistoryStore("/state", { now: () => now, schedule: cb => { retry = cb; return 1 as any }, cancel: () => {},
    transport: () => ({ async call(m) {
      if (m.type === "apply") {
        await held
        if (fail) throw Error("temporary outage")
        return f.sql.apply(m.writer as string, m.sequence as number, m.event as string)
      }
      if (m.type === "query") return f.sql.query(m.query as any)
      return {}
    }, async terminate() {} }) })
  const m = new HistoryMaintenance(context.scope, store, async id => missing(id))
  t.after(async () => { m.dispose(); release(); await store.dispose(performance.now() - 3500) })
  await m.step(); await settle()
  assert.equal(store.maintenanceDirty, true); assert.equal(store.pendingOperations, 1)
  release(); await settle()
  await m.step() // End of cleanup pass, but the admitted deletion has failed.
  for (let n = 0; n < 5; n++) await m.step()
  assert.equal(store.maintenanceDirty, true)
  assert.equal(store.pendingOperations, 1)
  fail = false; now = 2000; retry(); await settle()
  assert.equal(store.pendingOperations, 0); assert.equal(store.maintenanceDirty, true)
  await m.step(); assert.equal(store.maintenanceDirty, true, "draining cleanup starts a fresh confirmation pass")
  await m.step(); assert.equal(store.maintenanceDirty, false)
})
