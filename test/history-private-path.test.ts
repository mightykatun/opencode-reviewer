import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { privateDatabase } from "../src/history-private-path.js"

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "history-path-race-"))
  const file = path.join(directory, "history-v1.sqlite")
  privateDatabase(file)
  const db = new DatabaseSync(file)
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { file, db }
}

test("a real SQLite rollback journal can disappear during path validation", t => {
  const { file, db } = fixture(t), journal = file + "-journal"
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE probe(value); BEGIN IMMEDIATE; INSERT INTO probe VALUES (1)")
  assert.ok(fs.existsSync(journal))
  let committed = false
  const commit = () => {
    db.exec("COMMIT"); committed = true
    assert.equal(fs.existsSync(journal), false, "SQLite itself removes its journal")
  }
  const open = fs.openSync, lstat = fs.lstatSync
  // Force the competing commit at the metadata observation boundary. The old
  // descriptor check sees an unlinked inode; a pathname check sees ENOENT.
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args)
    if (args[0] === journal && !committed) commit()
    return fd
  })
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof lstat>) => {
    if (args[0] === journal && !committed) commit()
    return lstat(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.equal(privateDatabase(file), true)
  assert.equal(committed, true)
  assert.equal(db.prepare("SELECT count(*) n FROM probe").get()!.n, 1)
})

for (const journal of ["DELETE", "WAL"]) {
  test(`${journal}: path validation cannot release another connection's SQLite locks`, t => {
    const { file, db } = fixture(t)
    db.exec(`PRAGMA journal_mode=${journal}; CREATE TABLE probe(value); BEGIN IMMEDIATE`)
    // A separate process is essential: SQLite's in-process connection registry
    // would otherwise mask locks accidentally released by a non-SQLite close().
    const probe = () => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=commonjs", "-e", `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); console.log(JSON.stringify({ acquired: true })); }
      catch (error) { console.log(JSON.stringify({ code: error.code, errcode: error.errcode })); }
      finally { db.close(); }
    `, file], { encoding: "utf8", timeout: 10000 }))
    const busy = { code: "ERR_SQLITE_ERROR", errcode: 5 }
    assert.deepEqual(probe(), busy)
    for (const create of [false, true]) {
      assert.equal(privateDatabase(file, create), true)
      assert.deepEqual(probe(), busy, "validation must leave the existing transaction's OS locks intact")
    }
    db.exec("ROLLBACK")
    assert.deepEqual(probe(), { acquired: true })
  })
}
