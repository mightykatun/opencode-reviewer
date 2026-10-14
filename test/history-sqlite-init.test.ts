import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { initializeHistoryPragmas } from "../src/history-sqlite-init.js"
import type { HistoryDatabase } from "../src/history-schema.js"

function fixture(t: TestContext, execute: (sql: string, spend: (ms: number) => void) => void) {
  let now = 0
  const calls: string[] = [], waits: number[] = []
  t.mock.method(performance, "now", () => now)
  t.mock.method(Atomics, "wait", (_array: Int32Array, _index: number, _value: number, timeout: number) => {
    waits.push(timeout); now += timeout; return "timed-out" as const
  })
  const db = { exec(sql: string) { calls.push(sql); execute(sql, ms => { now += ms }) } } as HistoryDatabase
  return { db, calls, waits, now: () => now }
}

for (const busy of [{ code: "ERR_SQLITE_ERROR", errcode: 5 }, { code: "ERR_SQLITE_ERROR", errcode: 261 }, { code: "SQLITE_BUSY" }]) {
  test(`WAL initialization retries explicit busy ${JSON.stringify(busy)} without extending the SQLite budget`, t => {
    let attempts = 0
    const f = fixture(t, sql => { if (sql.includes("journal_mode") && ++attempts < 3) throw busy })
    initializeHistoryPragmas(f.db)
    assert.equal(attempts, 3)
    assert.deepEqual(f.waits, [5, 5])
    assert.deepEqual(f.calls.filter(sql => sql.includes("journal_mode")).map(sql => sql.match(/busy_timeout=(\d+)/)![1]), ["250", "245", "240"])
    assert.equal(f.calls.at(-1), "PRAGMA busy_timeout=250")
  })
}

test("immediate persistent busy stops at the original 250 ms boundary and preserves the failure", t => {
  const busy = { code: "ERR_SQLITE_ERROR", errcode: 5 }
  const f = fixture(t, sql => { if (sql.includes("journal_mode")) throw busy })
  assert.throws(() => initializeHistoryPragmas(f.db), error => error === busy)
  assert.equal(f.now(), 250)
  assert.equal(f.waits.length, 50)
  assert.equal(f.calls.filter(sql => sql.includes("journal_mode")).length, 50)
  assert.equal(f.calls.at(-1), "PRAGMA busy_timeout=250")
})

test("time already spent in SQLite consumes the same initialization budget", t => {
  const busy = { code: "SQLITE_BUSY" }
  const f = fixture(t, (sql, spend) => { if (sql.includes("journal_mode")) { spend(250); throw busy } })
  assert.throws(() => initializeHistoryPragmas(f.db), error => error === busy)
  assert.equal(f.now(), 250)
  assert.deepEqual(f.waits, [])
  assert.equal(f.calls.length, 2, "One initialization attempt plus restoring the transaction wait policy")
})

for (const error of [Error("database is locked"), { code: "SQLITE_LOCKED" }, { code: "ERR_SQLITE_ERROR", errcode: 11 },
  { code: "ERR_SQLITE_ERROR", errcode: "5" }, { code: "SQLITE_CANTOPEN" }]) {
  test(`non-busy initialization errors stay terminal: ${JSON.stringify(error)}`, t => {
    const f = fixture(t, sql => { if (sql.includes("journal_mode")) throw error })
    assert.throws(() => initializeHistoryPragmas(f.db), actual => actual === error)
    assert.deepEqual(f.waits, [])
    assert.equal(f.calls.length, 2)
  })
}
