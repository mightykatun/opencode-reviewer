import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HistoryStore, HistoryWorker } from "../src/history-store.js"
import type { HistoryTransport } from "../src/history-store.js"
import { HISTORY_QUEUE_BYTES, HISTORY_OPERATION_OVERHEAD, HistoryInvalid, encodeEvent } from "../src/history-records.js"
import type { HistoryEvent, HistoryReview } from "../src/history-records.js"
import { HistorySQL } from "../src/history-schema.js"
import { HistoryRefresh } from "../src/history-refresh.js"
import { privateDatabase } from "../src/history-storage-worker.js"

const context: HistoryReview = { scope: "/project", root: "root", session: "root", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const event: HistoryEvent = { type: "permissionResolved", context, at: 1, outcome: "manual", payload: { safe: true, completedAt: 1, desc: "report" } }
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function clock() {
  let now = 0
  const timers = new Map<number, { at: number; call: () => void }>()
  let id = 0
  return { now: () => now, schedule: (call: () => void, ms: number) => {
    timers.set(++id, { at: now + ms, call }); return id as any
  }, cancel: (id: any) => { timers.delete(id) }, advance: (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.call() }
  }, get size() { return timers.size } }
}

test("64 MiB cap includes in-flight bytes, keeps FIFO admitted operations and allocates no sequence gaps", async () => {
  const memoryBefore = process.memoryUsage().rss
  const barrier = deferred<void>(), calls: number[] = []
  let first = true, active = 0, maximum = 0
  const transport: HistoryTransport = {
    async call(message) {
      if (message.type !== "apply") return {}
      active++; maximum = Math.max(maximum, active)
      if (first) { first = false; await barrier.promise }
      calls.push(message.sequence as number); active--; return {}
    }, async terminate() { barrier.resolve() },
  }
  const store = new HistoryStore("/state", { transport: () => transport })
  const large: HistoryEvent = { ...event, payload: { ...event.payload, desc: "x".repeat(65536) } }
  const bytes = Buffer.byteLength(encodeEvent(large)) + HISTORY_OPERATION_OVERHEAD
  let admitted = 0
  while (store.admit(large)) admitted++
  await turn()
  assert.equal(admitted, Math.floor(HISTORY_QUEUE_BYTES / bytes))
  assert.equal(store.retainedBytes, admitted * bytes); assert.equal(store.pendingOperations, admitted)
  assert.ok(process.memoryUsage().rss - memoryBefore < HISTORY_QUEUE_BYTES * 8, "actual resident allocation stays a constant multiple of the fixed queue budget")
  assert.equal(store.admit(large), false); assert.equal(store.retainedBytes, admitted * bytes)
  // Fill the remaining tail with small events before rejecting a deletion.
  while (store.admit(event)) admitted++
  const deleted: HistoryEvent = { type: "sessionDeleted", context: { scope: "/project", root: "r".repeat(4096), session: "s".repeat(4096) }, at: 2 }
  assert.equal(store.admit(deleted), false); assert.equal(store.maintenanceDirty, true)
  barrier.resolve(); await turn()
  assert.equal(store.pendingOperations, 0); assert.equal(store.retainedBytes, 0); assert.equal(maximum, 1)
  assert.deepEqual(calls, Array.from({ length: admitted }, (_, i) => i + 1))
  assert.equal(store.admit(event), true); await turn(); assert.equal(calls.at(-1), admitted + 1)
  store.maintenanceReconciled(); assert.equal(store.maintenanceDirty, false)
  await store.dispose()
})

test("failed real SQLite writes retry after exactly two seconds while committed history stays readable", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "history-outage-")), file = path.join(directory, "private/history-v1.sqlite")
  privateDatabase(file)
  const db = new DatabaseSync(file), sql = new HistorySQL(db), lock = new DatabaseSync(file)
  sql.apply("seed", 1, encodeEvent(event))
  const time = clock(); let attempts = 0, failures = 0, commits = 0
  const transport: HistoryTransport = {
    async call(message) {
      if (message.type === "apply") { attempts++; return sql.apply(message.writer as string, message.sequence as number, message.event as string) }
      if (message.type === "query") return sql.query(message.query as any)
      return {}
    }, async terminate() {},
  }
  const store = new HistoryStore(directory, { transport: () => transport, ...time })
  t.after(async () => { await store.dispose(performance.now() - 3500); lock.close(); sql.close(); rmSync(directory, { recursive: true, force: true }) })
  store.onWriteFailure(() => { failures++ }); store.onCommit(() => { commits++ })
  store.onCommit(() => Promise.reject(Error("isolated observer")))
  lock.exec("BEGIN IMMEDIATE")
  store.admit({ type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } })
  await turn(); assert.equal(attempts, 1); assert.equal(failures, 1)
  const history = await store.query({ type: "history", scope: context.scope, root: context.root }) as any
  assert.equal(history.record.payload.desc, "report")
  await assert.rejects(store.query({ type: "totals" }), /unavailable/)
  time.advance(1999); await turn(); assert.equal(attempts, 1)
  lock.exec("ROLLBACK"); time.advance(1); await turn()
  assert.equal(attempts, 2); assert.equal(commits, 1); assert.equal(store.pendingOperations, 0)
  assert.equal(((await store.query({ type: "totals" })) as any).totals.safe, 1)
})

test("invalid initialization retries after exactly two seconds and retains new admissions in FIFO order", async t => {
  const time = clock(), applied: Record<string, unknown>[] = []
  let opens = 0, failures = 0, commits = 0, workers = 0
  const store = new HistoryStore("/state", { ...time, transport: () => {
    workers++
    return { async call(message) {
      if (message.type === "open" && ++opens === 1) throw new HistoryInvalid("Invalid private path or schema")
      if (message.type === "apply") applied.push(message)
      return {}
    }, async terminate() {} }
  } })
  t.after(() => store.dispose(performance.now() - 3500))
  store.onWriteFailure(() => { failures++ }); store.onCommit(() => { commits++ })
  assert.equal(store.admit(event), true)
  await turn()
  assert.equal(opens, 1); assert.equal(failures, 1); assert.equal(applied.length, 0)
  const retained = store.retainedBytes
  assert.equal(store.pendingOperations, 1)
  assert.equal(store.admit({ ...event, context: { ...context, permission: "later", review: "later" } }), true)
  await turn()
  assert.equal(store.pendingOperations, 2); assert.ok(store.retainedBytes > retained)
  assert.equal(opens, 1)
  time.advance(1999); await turn()
  assert.equal(opens, 1); assert.equal(applied.length, 0)
  time.advance(1); await turn()
  assert.equal(opens, 2); assert.equal(workers, 1); assert.equal(commits, 2)
  assert.deepEqual(applied.map(message => message.sequence), [1, 2])
  assert.equal(new Set(applied.map(message => message.writer)).size, 1)
  assert.deepEqual(applied.map(message => JSON.parse(message.event as string).context.permission), ["permission", "later"])
  assert.equal(store.pendingOperations, 0); assert.equal(store.retainedBytes, 0)
  assert.equal(store.admit(event), true); await turn()
  assert.deepEqual(applied.map(message => message.sequence), [1, 2, 3])
})

test("invalid admitted apply permanently retains the FIFO and rejects new admissions", async t => {
  const time = clock(), applied: number[] = []
  let failures = 0, commits = 0, opens = 0
  const store = new HistoryStore("/state", { ...time, transport: () => ({ async call(message) {
    if (message.type === "open") opens++
    if (message.type === "apply") { applied.push(message.sequence as number); throw new HistoryInvalid("Invalid transaction") }
    return {}
  }, async terminate() {} }) })
  t.after(() => store.dispose(performance.now() - 3500))
  store.onWriteFailure(() => { failures++ }); store.onCommit(() => { commits++ })
  assert.equal(store.admit(event), true); assert.equal(store.admit(event), true)
  const retained = store.retainedBytes
  await turn()
  assert.deepEqual(applied, [1]); assert.equal(failures, 1); assert.equal(commits, 0)
  assert.equal(store.pendingOperations, 2); assert.equal(store.retainedBytes, retained)
  assert.equal(store.admit(event), false)
  time.advance(2000); await turn(); time.advance(20000); await turn()
  assert.deepEqual(applied, [1]); assert.equal(opens, 1); assert.equal(time.size, 0)
  assert.equal(store.admit(event), false)
  assert.equal(store.pendingOperations, 2); assert.equal(store.retainedBytes, retained)
})

test("uncertain commit acknowledgement replays exactly once, invalid inputs never poison the queue", async () => {
  const sql = new HistorySQL(new DatabaseSync(":memory:")), time = clock()
  let loseAck = true
  const transport: HistoryTransport = { async call(m) {
    if (m.type !== "apply") return {}
    const result = sql.apply(m.writer as string, m.sequence as number, m.event as string)
    if (loseAck) { loseAck = false; throw Error("ack lost") }
    return result
  }, async terminate() {} }
  const store = new HistoryStore("/state", { transport: () => transport, ...time })
  assert.throws(() => store.admit({ ...event, payload: { ...event.payload, safe: "yes" } } as any))
  assert.equal(store.pendingOperations, 0)
  store.admit({ type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } })
  await turn(); assert.equal(store.pendingOperations, 1)
  time.advance(2000); await turn(); assert.equal(store.pendingOperations, 0)
  assert.equal((sql.query({ type: "totals" }) as any).totals.safe, 1)
  await store.dispose(); assert.equal(time.size, 0); sql.close()
})

test("stalled operation owns slot until settlement/exit and disposal is below four seconds", async () => {
  const barrier = deferred<void>(), exit = deferred<void>(); let calls = 0, terminated = false
  const transport: HistoryTransport = {
    async call() { calls++; await barrier.promise; throw Error("History worker exited") },
    async terminate() { terminated = true; await exit.promise; barrier.resolve() },
  }
  const store = new HistoryStore("/state", { transport: () => transport })
  store.admit(event)
  const reads = Array.from({ length: 20 }, () => store.query({ type: "totals" }).catch(() => undefined))
  await turn(); assert.equal(calls, 1)
  const start = performance.now(), disposal = store.dispose(performance.now() - 3200)
  await turn(); assert.equal(terminated, true); assert.equal(calls, 1)
  exit.resolve(); await disposal; await Promise.all(reads)
  assert.ok(performance.now() - start < 4000)
  assert.equal(store.admit(event), false); assert.equal(store.pendingOperations, 0)
})

test("refresh coalesces, guards selection/write failures, polls repairs and never publishes after disposal", async () => {
  const pending: ReturnType<typeof deferred<any>>[] = [], publications: any[] = []
  let commit!: () => unknown, failure!: () => unknown
  const fake = { query: async () => { const p = deferred<any>(); pending.push(p); return p.promise },
    onCommit: (f: () => unknown) => { commit = f; return () => {} }, onWriteFailure: (f: () => unknown) => { failure = f; return () => {} } }
  const refresh = new HistoryRefresh(fake, { type: "totals" }, value => publications.push(value))
  refresh.refresh(); refresh.refresh(); assert.equal(pending.length, 1)
  failure(); pending[0]!.resolve({ stale: true }); await turn()
  assert.equal(publications.length, 1); assert.equal(publications[0], undefined); assert.equal(pending.length, 1)
  commit(); assert.equal(pending.length, 2)
  refresh.select({ type: "history", scope: context.scope, root: context.root })
  pending[1]!.resolve({ stale: true }); await turn(); assert.equal(pending.length, 3)
  pending[2]!.resolve({ revision: 1, total: 1, unreadable: true }); await turn()
  refresh.refresh(); pending[3]!.resolve({ revision: 1, total: 1, repaired: true }); await turn()
  assert.equal(publications.at(-1).repaired, true)
  failure(); assert.equal(publications.at(-1).repaired, true, "write failure does not hide readable history")
  refresh.refresh(); refresh.dispose(); pending[4]!.resolve({ disposed: true }); await turn()
  assert.equal(publications.some(p => p?.disposed || p?.stale), false)
})

test("refresh retains actual read ownership after caller timeout, with just one follow-up", async () => {
  const actual = deferred<void>(), caller = deferred<any>(), second = deferred<any>()
  let calls = 0
  const first = Object.assign(caller.promise, { settled: actual.promise })
  const refresh = new HistoryRefresh({ query: () => ++calls === 1 ? first : second.promise,
    onCommit: () => () => {}, onWriteFailure: () => () => {} }, { type: "totals" }, () => {})
  caller.reject(Error("timeout")); await turn()
  for (let i = 0; i < 100; i++) refresh.refresh()
  assert.equal(calls, 1)
  actual.resolve(); await turn(); assert.equal(calls, 2)
  refresh.dispose(); second.resolve({}); await turn()
})

test("actual stalled worker exits during bounded disposal with no replacement operation", async () => {
  let workers = 0
  const store = new HistoryStore("/state", { transport: () => {
    workers++
    return new HistoryWorker(`const {parentPort}=require('node:worker_threads'); parentPort.on('message', m => {
      if(m.type==='open') parentPort.postMessage({id:m.id,value:{}}); else while(true) {}
    })`)
  } })
  store.admit(event)
  const start = performance.now()
  await store.dispose(start)
  assert.ok(performance.now() - start < 4000)
  assert.equal(workers, 1); assert.equal(store.pendingOperations, 0)
})

test("queued query owns an immutable scope snapshot", async () => {
  const barrier = deferred<void>(), queries: any[] = []
  const store = new HistoryStore("/state", { transport: () => ({
    async call(m) {
      if (m.type === "open") await barrier.promise
      if (m.type === "query") { queries.push(m.query); return { total: 0 } }
      return {}
    }, async terminate() {},
  }) })
  store.admit(event)
  const query = { type: "history" as const, scope: "/project", root: "root" }
  const read = store.query(query); query.root = "other"
  barrier.resolve(); await read
  assert.equal(queries[0].root, "root")
  await store.dispose()
})

test("watchdog reply race retains ownership until termination actually settles", async () => {
  const reply = deferred<void>(), exit = deferred<void>(), terminating = deferred<void>()
  let calls = 0, workers = 0
  const store = new HistoryStore("/state", { transport: () => {
    workers++
    return { async call() { calls++; await reply.promise; return {} },
      async terminate() { terminating.resolve(); await exit.promise } }
  } })
  const read = store.query({ type: "totals" }); void read.catch(() => {})
  let settled = false; void read.settled!.then(() => { settled = true })
  await terminating.promise
  reply.resolve(); await turn()
  assert.equal(settled, false); assert.equal(calls, 1)
  const disposal = store.dispose(performance.now() - 3500)
  exit.resolve(); await disposal; await read.settled
  assert.equal(settled, true); assert.equal(workers, 1)
})

test("a worker that exits while idle reports the exit on the next call", async () => {
  const worker = new HistoryWorker("process.exit(0)")
  await worker.terminate()
  await assert.rejects(worker.call({ type: "open" }), /History worker exited/)
})

test("polling does not starve reads slower than its cadence and selection is snapshotted", async () => {
  const first = deferred<any>(), second = deferred<any>(), values: any[] = [], queries: any[] = []
  const query = { type: "history" as const, scope: "/project", root: "root" }
  const refresh = new HistoryRefresh({ query: q => { queries.push(q); return queries.length === 1 ? first.promise : second.promise },
    onCommit: () => () => {}, onWriteFailure: () => () => {} }, query, v => values.push(v))
  query.root = "other"
  await new Promise(resolve => setTimeout(resolve, 2100))
  first.resolve({ total: 1 }); await turn()
  assert.deepEqual(values, [{ total: 1 }]); assert.equal(queries.length, 2)
  assert.equal(queries[1].root, "root")
  refresh.dispose(); second.resolve({ total: 2 })
})

test("legacy escaped metadata baseline cannot block affected and unrelated roots in the admitted FIFO", async t => {
  const db = new DatabaseSync(":memory:"), seed = new HistorySQL(db)
  seed.apply("seed", 1, encodeEvent({ type: "attemptFinalized", context, at: 1, attempt: "old",
    reportedModel: "x" + "\u0001".repeat(4095), usage: { input: 7, output: 2 } }))
  db.exec("DROP TABLE conversation_totals")
  const sql = new HistorySQL(db), applied: number[] = []
  const store = new HistoryStore("/state", { transport: () => ({ async call(m) {
    if (m.type === "apply") {
      const result = sql.apply(m.writer as string, m.sequence as number, m.event as string)
      applied.push(m.sequence as number); return result
    }
    if (m.type === "query") return sql.query(m.query as any)
    return {}
  }, async terminate() {} }) })
  t.after(async () => { await store.dispose(performance.now() - 3500); sql.close() })
  assert.equal(store.admit(event), true)
  assert.equal(store.admit({ ...event, context: { ...context, root: "other", session: "other", permission: "other", review: "other" } }), true)
  await turn()
  assert.deepEqual(applied, [1, 2])
  assert.equal(store.pendingOperations, 0)
  assert.equal(store.admit({ type: "attemptFinalized", context, at: 2, attempt: "new", usage: { input: 3, output: 1 } }), true)
  await turn()
  assert.equal((await store.query({ type: "totals" }) as any).totals.input, 10)
})

test("query-driven bootstrap failure stays read-local and a later poll resumes its durable work", async t => {
  const db = new DatabaseSync(":memory:"), sql = new HistorySQL(db)
  sql.apply("seed", 1, encodeEvent({ type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } }))
  db.exec("DELETE FROM conversation_totals")
  let fail = true
  const store = new HistoryStore("/state", { transport: () => ({ async call(m) {
    if (m.type === "apply") return sql.applyReady(m.writer as string, m.sequence as number, m.event as string)
    if (m.type === "query") return sql.queryReady(m.query as any)
    if (m.type === "bootstrap") {
      if (fail) { fail = false; throw Error("temporary bootstrap read failure") }
      return sql.bootstrap(m.root as string)
    }
    return {}
  }, async terminate() {} }) })
  t.after(async () => { await store.dispose(); sql.close() })
  const query = { type: "conversationTotals" as const, scope: context.scope, root: context.root }
  await assert.rejects(store.query(query), /temporary/)
  assert.equal(store.admit({ ...event, context: { ...context, root: "other", session: "other", review: "other", permission: "other" } }), true)
  assert.equal((await store.query(query) as any).totals.safe, 1)
  assert.equal((await store.query({ type: "totals" }) as any).totals.safe, 1)
})

test("aborted bootstrap read retains actual slice ownership and releases only after settlement", async t => {
  const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController()
  let first = true, calls = 0
  const store = new HistoryStore("/state", { transport: () => ({ async call(m) {
    calls++
    if (m.type === "query") { if (first) { first = false; return { pending: "a".repeat(64) } }; return { total: 0 } }
    if (m.type === "bootstrap") { entered.resolve(); await release.promise; return { done: true } }
    return {}
  }, async terminate() { release.resolve() } }) })
  t.after(async () => { release.resolve(); await store.dispose() })
  const read = store.query({ type: "conversationTotals", scope: "/project", root: "root" }, controller.signal)
  let settled = false; void read.settled!.then(() => { settled = true })
  await entered.promise; controller.abort(); await assert.rejects(read, /aborted/)
  assert.equal(settled, false)
  const followup = store.query({ type: "totals" }); await turn(); assert.equal(calls, 3)
  release.resolve(); await read.settled; await followup; assert.equal(settled, true)
})
