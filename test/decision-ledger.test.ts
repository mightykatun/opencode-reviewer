import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { chmodSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { canonicalJSON, DECISION_LEDGER_CAPACITY, decisionFingerprint, decisionKey, DecisionLedger, DecisionLedgerUnavailable } from "../src/decision-ledger.js"

const construct = (file: string) => new DatabaseSync(file)
const location = { directory: "/server/project" }
const identity = {
  location, request: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["echo hi"], save: ["echo *"], source: { assistantID: "msg_1", id: "call_1" } },
  invocation: { assistantID: "msg_1", callID: "call_1", tool: "shell", input: { command: "echo hi" } },
}

async function ledger(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-ledger-"))
  chmodSync(dir, 0o700)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const value = DecisionLedger.open(dir, construct)
  t.after(() => value.close())
  return { dir, ledger: value }
}

test("canonical JSON and fingerprints are deterministic, versioned and free of raw inputs", () => {
  assert.equal(canonicalJSON({ b: 1, a: [true, null, { d: "x", c: 2 }] }), '{"a":[true,null,{"c":2,"d":"x"}],"b":1}')
  const first = decisionFingerprint(identity)
  assert.equal(first, decisionFingerprint({ ...identity, request: { ...identity.request, resources: ["echo hi"] } }))
  assert.notEqual(first, decisionFingerprint({ ...identity, invocation: { ...identity.invocation, input: { command: "echo bye" } } }))
  assert.notEqual(first, decisionFingerprint({ ...identity, request: { ...identity.request, id: "per_2" } }))
  assert.notEqual(first, decisionFingerprint({ ...identity, candidates: ["call_2"] }))
  assert.equal(decisionFingerprint({ ...identity, candidates: ["b", "a"] }), decisionFingerprint({ ...identity, candidates: ["a", "b"] }))
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.notEqual(decisionKey(location, "ses_1", "per_1"), decisionKey({ directory: "/elsewhere" }, "ses_1", "per_1"))
})

test("only an observed birth of this owner with a matching fingerprint may dispatch, and rows survive reopening", async t => {
  const { dir, ledger: first } = await ledger(t)
  const key = decisionKey(location, "ses_1", "per_1"), fingerprint = decisionFingerprint(identity)
  // An absent row is never evidence of safety.
  assert.equal(first.dispatchable(key, "owner-a", fingerprint), false)
  assert.throws(() => first.reserve(key, "owner-a", fingerprint), /not dispatchable/)
  assert.equal(first.observe(key, "owner-a", 10), true)
  assert.equal(first.dispatchable(key, "owner-a", fingerprint), false, "no fingerprint recorded yet")
  assert.equal(first.fingerprint(key, "owner-a", fingerprint, 11), true)
  assert.equal(first.dispatchable(key, "owner-a", fingerprint), true)
  assert.equal(first.dispatchable(key, "owner-b", fingerprint), false, "another owner never dispatches this birth")
  assert.equal(first.dispatchable(key, "owner-a", "other"), false, "a changed fingerprint stays manual")
  assert.equal(first.fingerprint(key, "owner-a", "other"), false, "a different fingerprint cannot replace the recorded one")
  assert.equal(first.fingerprint(key, "owner-b", fingerprint), false)
  // Cancel is durable and final for the key.
  first.cancel(key, "owner-a", fingerprint, 12)
  assert.equal(first.dispatchable(key, "owner-a", fingerprint), false)
  assert.throws(() => first.reserve(key, "owner-a", fingerprint), /not dispatchable/)
  assert.equal(first.observe(key, "owner-a"), false, "a cancelled row is kept")
  const other = decisionKey(location, "ses_1", "per_2")
  assert.equal(first.observe(other, "owner-a", 20), true)
  assert.equal(first.fingerprint(other, "owner-a", fingerprint, 21), true)
  assert.equal(first.observe(other, "owner-b"), false, "a second owner cannot take over an observed birth")
  first.reserve(other, "owner-a", fingerprint, 22)
  assert.throws(() => first.reserve(other, "owner-a", fingerprint), /not dispatchable/)
  first.sent(other, 23)
  assert.deepEqual(first.read(other), { key: other, owner: "owner-a", fingerprint, state: "sent", at: 23 })
  assert.throws(() => first.sent(key), /not reserved/)
  first.close()
  const reopened = DecisionLedger.open(dir, construct)
  t.after(() => reopened.close())
  assert.equal(reopened.read(key)?.state, "cancelled")
  assert.equal(reopened.read(other)?.state, "sent")
  assert.equal(reopened.dispatchable(other, "owner-a", fingerprint), false, "a spent row never dispatches again")
  reopened.resolve(other, 24)
  assert.equal(reopened.read(other)?.state, "resolved")
  assert.equal(reopened.dispatchable(other, "owner-a", fingerprint), false, "resolution frees the key but authorizes nothing")
  assert.equal(reopened.observe(other, "owner-c", 25), true, "a resolved key may be observed again")
})

test("capacity prunes only resolved rows and otherwise fails closed", async t => {
  const { ledger: value } = await ledger(t)
  const fingerprint = decisionFingerprint(identity)
  for (let index = 0; index < DECISION_LEDGER_CAPACITY; index++) value.cancel(decisionKey(location, "ses", `per_${index}`), "owner", fingerprint, index)
  assert.throws(() => value.observe(decisionKey(location, "ses", "overflow"), "owner"), DecisionLedgerUnavailable)
  value.resolve(decisionKey(location, "ses", "per_0"), 1)
  assert.equal(value.observe(decisionKey(location, "ses", "overflow"), "owner", 2), true)
  assert.equal(value.read(decisionKey(location, "ses", "per_0")), undefined, "the oldest resolved row was pruned")
  assert.equal(value.read(decisionKey(location, "ses", "per_1"))?.state, "cancelled")
})

test("the ledger refuses an unsafe state directory", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-ledger-public-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "opencode-reviewer"), { mode: 0o755 })
  assert.throws(() => DecisionLedger.open(dir, construct), DecisionLedgerUnavailable)
})

test("a ledger file from another schema is unavailable and never reset", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-ledger-dev-"))
  chmodSync(dir, 0o700)
  t.after(() => rm(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "opencode-reviewer"), { mode: 0o700 })
  const file = path.join(dir, "opencode-reviewer", "decisions-v1.sqlite")
  // The exact table a development build created: no owner column, no observed state.
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE decisions (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL
      CHECK(state IN ('cancelled','reserved','sent','resolved')), at INTEGER NOT NULL); CREATE INDEX decisions_state_at ON decisions(state,at)`)
  old.close()
  chmodSync(file, 0o600)
  assert.throws(() => DecisionLedger.open(dir, construct), (error: Error) => error instanceof DecisionLedgerUnavailable && /schema differs/.test(error.message))
  const check = new DatabaseSync(file)
  const columns = check.prepare("SELECT name FROM pragma_table_info('decisions') ORDER BY cid").all().map(row => row.name)
  check.close()
  assert.deepEqual(columns, ["key", "fingerprint", "state", "at"], "the file is left as it was")
})
