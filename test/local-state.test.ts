import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { localStateRoot, historyStateRoot } from "../src/local-state.js"
import { privateDatabase } from "../src/history-storage-worker.js"
import { HistorySQL } from "../src/history-schema.js"
import { encodeEvent, type HistoryReview } from "../src/history-records.js"
import { SessionModeStore } from "../src/session-mode.js"
import { SessionInstructionsStore } from "../src/session-instructions.js"
import { empty } from "../src/lifetime.js"
import { openHistoryDatabase } from "../src/history-storage-worker.js"

const context: HistoryReview = { root: "root", session: "root", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const database = (root: string) => path.join(root, "opencode-reviewer/history-v2.sqlite")
function home(t: { after(callback: () => void): void }) {
  // SQLite ancestor checks require the sticky system /tmp, not the potentially
  // group-writable /tmp/opencode used by non-storage fixtures.
  const directory = mkdtempSync("/tmp/reviewer-state-selection-")
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const state = localStateRoot({}, directory)
  mkdirSync(state, { recursive: true, mode: 0o700 })
  return { directory, state }
}
function seed(root: string) {
  privateDatabase(database(root))
  const sql = new HistorySQL(new DatabaseSync(database(root)))
  try {
    sql.apply("seed", 1, encodeEvent({ type: "reviewAccepted", context, at: 1, accepted: { safe: true, completedAt: 1 } }))
    sql.apply("seed", 2, encodeEvent({ type: "attemptFinalized", context, at: 1, attempt: "attempt", usage: { input: 17, output: 3 } }))
    sql.apply("seed", 3, encodeEvent({ type: "permissionResolved", context, at: 1, outcome: "auto", payload: { safe: true, completedAt: 1, desc: "saved report" } }))
  } finally { sql.close() }
}

test("the first v2 open ignores a live v1 database, its sidecars and the existing conversation records", async t => {
  const { state } = home(t)
  const old = path.join(state, "opencode-reviewer/history-v1.sqlite")
  mkdirSync(path.dirname(old), { mode: 0o700 })
  const v1 = new DatabaseSync(old)
  t.after(() => v1.close())
  v1.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta(id INTEGER,version INTEGER,revision INTEGER,totals TEXT)")
  v1.prepare("INSERT INTO meta VALUES(1,1,8,?)").run(JSON.stringify({ ...empty(), safe: 100 }))
  const modeDir = path.join(state, "session-mode-v2"), instructionDir = path.join(state, "session-instructions-v1")
  const modes = new SessionModeStore(modeDir, "host"), instructions = new SessionInstructionsStore(instructionDir)
  await modes.write("root", false)
  await instructions.write("root", "Use the existing test database.")
  const paths = [old, old + "-wal", old + "-shm", ...[modeDir, instructionDir].flatMap(dir => readdirSync(dir).map(name => path.join(dir, name)))]
  const digests = () => paths.map(file => createHash("sha256").update(readFileSync(file)).digest("hex"))
  const before = digests()
  const open = () => openHistoryDatabase(database(historyStateRoot(state)), "node", file => new DatabaseSync(file))
  const sql = open()
  try {
    assert.deepEqual(sql.query({ type: "totals" }), { revision: 0, totals: empty() })
    assert.deepEqual(sql.query({ type: "history", root: "root" }), { revision: 0, total: 0, rank: 0 })
    sql.apply("writer", 1, encodeEvent({ type: "permissionResolved", context, at: 3, outcome: "manual",
      payload: { completedAt: 2, safe: true, desc: "New v2 report" } }))
  } finally { sql.close() }
  const reopened = open()
  try {
    const result = reopened.query({ type: "history", root: "root" })
    assert.ok("record" in result)
    assert.equal(result.record?.payload.desc, "New v2 report")
    const stats = reopened.query({ type: "totals" })
    assert.ok("totals" in stats)
    assert.equal(stats.totals.activity.manuallyApproved, 1)
  } finally { reopened.close() }
  assert.deepEqual(digests(), before)
  const signal = new AbortController().signal
  assert.equal(await modes.read("root", signal), false)
  assert.equal(await instructions.read("root", 4096, signal, true), "Use the existing test database.")
})

test("default HOME with a 0775 host state directory gets private persistent history without chmod or mode relocation", async t => {
  const { state, directory } = home(t)
  chmodSync(state, 0o775)
  const modeDirectory = path.join(state, "session-mode-v2")
  const modes = new SessionModeStore(modeDirectory, "host")
  await modes.write("root", false)
  const before = lstatSync(state)
  const selected = historyStateRoot(state)
  assert.equal(selected, path.join(path.dirname(state), "opencode-reviewer-state"))
  assert.equal(existsSync(selected), false, "selection is read-only")
  seed(selected)
  assert.equal(lstatSync(state).mode & 0o777, 0o775)
  assert.equal(lstatSync(state).ino, before.ino)
  assert.equal(existsSync(database(state)), false)
  assert.equal(await modes.read("root", new AbortController().signal), false)
  assert.equal(historyStateRoot(localStateRoot({}, directory)), selected)
  const sql = new HistorySQL(new DatabaseSync(database(historyStateRoot(state))))
  try {
    const totals = sql.query({ type: "totals" }) as any
    assert.equal(totals.totals.safe, 1)
    assert.equal(totals.totals.input, 17)
    assert.equal(totals.totals.output, 3)
    assert.equal((sql.query({ type: "history", root: context.root }) as any).record.payload.desc, "saved report")
  } finally { sql.close() }
  // A later host permission repair must not strand the already selected database.
  chmodSync(state, 0o700)
  assert.equal(historyStateRoot(state), selected)
})

test("safe existing history stays in place with identical database bytes and accumulated totals", t => {
  const { state } = home(t)
  seed(state)
  const before = readFileSync(database(state)), inode = lstatSync(database(state)).ino
  assert.equal(historyStateRoot(state), state)
  assert.equal(lstatSync(database(state)).ino, inode)
  assert.deepEqual(readFileSync(database(state)), before)
  assert.equal(existsSync(path.join(path.dirname(state), "opencode-reviewer-state")), false)
})

test("unsafe legacy history remains untouched and selection never follows a sibling symlink", t => {
  const { state, directory } = home(t)
  seed(state)
  const before = readFileSync(database(state)), inode = lstatSync(database(state)).ino
  chmodSync(state, 0o775)
  const selected = historyStateRoot(state)
  assert.equal(existsSync(selected), false)
  assert.equal(lstatSync(database(state)).ino, inode)
  assert.deepEqual(readFileSync(database(state)), before)
  const target = path.join(directory, "outside")
  mkdirSync(target, { mode: 0o700 })
  symlinkSync(target, selected)
  assert.equal(historyStateRoot(state), selected)
  assert.throws(() => privateDatabase(database(selected)), /Untrusted history ancestor/)
  assert.equal(existsSync(path.join(target, "opencode-reviewer")), false)
  assert.equal(lstatSync(state).mode & 0o777, 0o775)
})

test("read-only database probes create no missing directories, database or sidecars", t => {
  const { state } = home(t)
  assert.equal(privateDatabase(database(state), false), false)
  assert.equal(existsSync(path.dirname(database(state))), false)
  mkdirSync(path.dirname(database(state)), { mode: 0o700 })
  assert.equal(privateDatabase(database(state), false), false)
  for (const suffix of ["", "-wal", "-shm", "-journal"]) assert.equal(existsSync(database(state) + suffix), false)
})
