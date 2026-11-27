import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { HistorySQL } from "../src/history-schema.js"
import { encodeEvent, type HistoryEvent, type HistoryReview } from "../src/history-records.js"
import { reviewVersions, reviewerVersion } from "../src/review-versions.js"
import manifest from "../package.json" with { type: "json" }

const context: HistoryReview = { root: "root", session: "root", permission: "permission", review: "old",
  category: "bash", configuredModel: "model", provider: "https://example.com" }
const versions = { reviewer: "2.8.0", opencode: "2.0.123-dev.fixture" }
const resolved = (review = "old", captured?: typeof versions): Extract<HistoryEvent, { type: "permissionResolved" }> => ({ type: "permissionResolved",
  context: { ...context, review }, at: 20, outcome: "approved", payload: { safe: false, completedAt: 10,
    desc: `Report ${review}`, usage: { input: 100, output: 20, cost: 0.01 } }, ...(captured ? { versions: captured } : {}) })
test("producer versions are captured on first admission", t => {
  const db = new DatabaseSync(":memory:"), sql = new HistorySQL(db)
  t.after(() => sql.close())
  sql.apply("one", 1, encodeEvent({ type: "attemptDispatched", context, at: 1, attempt: "post", retry: "initial", versions }))
  sql.apply("two", 1, encodeEvent(resolved(context.review, { reviewer: "other", opencode: "other" })))
  assert.deepEqual({ ...db.prepare("SELECT reviewer_version,opencode_version FROM reviews").get() },
    { reviewer_version: versions.reviewer, opencode_version: versions.opencode })
})

test("version envelopes are optional, strict and bounded", () => {
  assert.doesNotThrow(() => encodeEvent(resolved()))
  assert.doesNotThrow(() => encodeEvent({ ...resolved(), versions: { reviewer: "2.8.0", opencode: null } }))
  for (const invalid of [null, [], {}, { reviewer: "2.8.0" }, { reviewer: "", opencode: null },
    { reviewer: "2.8.0", opencode: " " }, { reviewer: "2.8.0", opencode: 2 }, { reviewer: "2.8.0", opencode: "x\0y" },
    { reviewer: "x".repeat(129), opencode: null }, { reviewer: "2.8.0", opencode: "é".repeat(65) },
    { ...versions, extra: "unexpected" }, { ...versions, get opencode() { return "getter" } }])
    assert.throws(() => encodeEvent({ ...resolved(), versions: invalid } as any), /Invalid history event/)
  assert.equal(reviewerVersion, manifest.version)
  assert.deepEqual(reviewVersions("2.0.123+local"), { reviewer: manifest.version, opencode: "2.0.123+local" })
  for (const unknown of [undefined, null, "", " ", "x\0y", "x".repeat(129), 2])
    assert.deepEqual(reviewVersions(unknown), { reviewer: manifest.version, opencode: null })
})
