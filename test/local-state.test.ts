import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { localStateRoot, historyStateRoot } from "../src/local-state.js"
import { privateDatabase } from "../src/history-private-path.js"
import { HistorySQL } from "../src/history-schema.js"
import { encodeEvent, type HistoryReview } from "../src/history-records.js"
import { SessionModeStore } from "../src/session-mode.js"

const context: HistoryReview = { scope: "/project", root: "root", session: "root", permission: "permission", review: "review",
  category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
const database = (root: string) => path.join(root, "opencode-reviewer/history-v1.sqlite")
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
    assert.equal((sql.query({ type: "history", scope: context.scope, root: context.root }) as any).record.payload.desc, "saved report")
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
