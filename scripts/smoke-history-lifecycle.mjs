// Phase 2: exercise the production lifecycle through existing real-host fixtures,
// then inspect the isolated committed database. No synthetic history admissions.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { isolatedStateDirectory } from "./smoke-runtime.mjs"

const { scenario } = runtimeArguments("smoke-history-lifecycle.mjs")
const expected = { "auto-shell": "auto", "auto-immediate": "manual", "auto-manual": undefined, "auto-cancel": "rejected" }
assert.ok(Object.hasOwn(expected, scenario))
const root = path.resolve(import.meta.dirname, "..")
let temp = process.argv[3]
let output = ""
if (!temp) {
  output = execFileSync(process.execPath, ["scripts/smoke.mjs", scenario], { cwd: root, encoding: "utf8", timeout: 120000 })
  process.stdout.write(output)
}
temp = isolatedStateDirectory(output, temp)
const db = new DatabaseSync(path.join(temp, "state/opencode/opencode-reviewer/history-v1.sqlite"), { readOnly: true })
try {
  const totals = JSON.parse(db.prepare("SELECT totals FROM meta WHERE id=1").get().totals)
  const rows = db.prepare("SELECT h.outcome,p.body,r.context FROM history h JOIN payloads p ON p.id=h.id JOIN reviews r ON r.id=h.review").all()
  const attempts = db.prepare("SELECT dispatched,finalized FROM attempts").all()
  assert.equal(totals.activity.reviews, 1, "new store must not import the legacy seeded totals")
  assert.equal(totals.safe, 1)
  assert.equal(totals.activity.autoApproved, scenario === "auto-shell" ? 1 : 0)
  assert.equal(attempts.length, 1)
  assert.equal(JSON.parse(attempts[0].dispatched).retry, "initial")
  assert.ok(attempts[0].finalized, "actual received attempt is finalized")
  assert.equal(rows.length, expected[scenario] ? 1 : 0)
  if (rows.length) {
    assert.equal(rows[0].outcome, expected[scenario])
    const context = JSON.parse(rows[0].context), payload = JSON.parse(rows[0].body)
    assert.equal(context.category, "bash")
    assert.equal(context.scope, path.join(temp, "project"))
    assert.match(context.review, /^[0-9a-f-]{36}$/)
    assert.ok(payload.desc && payload.safe)
    assert.ok(context.configuredModel && context.provider.endsWith("/review"))
    assert.ok(payload.timing.fullReportMs >= payload.timing.ratingMs)
  }
  const artifacts = path.join(root, ".runtime", "history-lifecycle")
  await mkdir(artifacts, { recursive: true })
  await writeFile(path.join(artifacts, scenario + ".json"), JSON.stringify({ scenario, temp, totals, outcomes: rows.map(r => r.outcome), attempts: attempts.length }, null, 2))
  console.log(`PASS history lifecycle ${scenario}: committed accounting, ${expected[scenario] ?? "conservatively omitted native once"}, invocation scope and correlated POST; ${artifacts}`)
} finally { db.close() }
