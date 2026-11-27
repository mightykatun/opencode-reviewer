import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { HistoryStore } from "../src/history-store.js"
import type { HistoryEvent, HistoryReview } from "../src/history-records.js"
import type { HistorySelection, HistoryTotals } from "../src/history-schema.js"
import { empty, lifetimeReport } from "../src/lifetime.js"

test("fresh SQL totals exclude all legacy files, resume across workers and count correlated events once across clients", async t => {
  const state = await mkdtemp(path.join(tmpdir(), "lifetime-storage-"))
  const source = (await build({ entryPoints: ["src/history-storage-worker.ts"], bundle: true, platform: "node", format: "cjs",
    external: ["bun:sqlite"], write: false })).outputFiles[0]!.text
  const clients: HistoryStore[] = []
  const client = () => {
    const store = new HistoryStore(state, { source, adapter: "node" }); clients.push(store); return store
  }
  t.after(async () => { await Promise.all(clients.map(s => s.dispose())); await rm(state, { recursive: true, force: true }) })
  const files: [string, string][] = []
  for (const version of [1, 2, 3, 4]) {
    const directory = path.join(state, "opencode-reviewer", `usage-v${version}`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // Valid former snapshots and corrupt files are equally irrelevant to new totals.
    for (const [name, text] of [["00000000-0000-4000-8000-000000000001.json", JSON.stringify({ version,
      ...empty(), requests: 999, tokenRequests: 999, input: 99900, output: 19980, priced: 999, cost: 999, since: 1 })],
      ["00000000-0000-4000-8000-000000000002.json", "{"]]) {
      const file = path.join(directory, name!); await writeFile(file, text!); files.push([file, text!])
    }
  }
  const totals = async (s: HistoryStore) => (await s.query({ type: "totals" }) as HistoryTotals).totals
  const apply = (s: HistoryStore, e: HistoryEvent) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); fail(); reject(Error("commit timeout")) }, 5000)
    const off = s.onCommit(() => { clearTimeout(timer); off(); fail(); resolve() })
    const fail = s.onWriteFailure(() => { clearTimeout(timer); off(); fail(); reject(Error("write failed")) })
    assert.equal(s.admit(e), true)
  })
  const a = client(), b = client()
  assert.deepEqual(await totals(a), empty()); assert.deepEqual(await totals(b), empty())
  const context: HistoryReview = { root: "root", session: "root", permission: "permission",
    review: "review-a", category: "bash", configuredModel: "model", provider: "https://example.com/v1" }
  const events: HistoryEvent[] = [
    { type: "attemptDispatched", context, at: 1, attempt: "post-1", retry: "initial" },
    { type: "attemptFinalized", context, at: 2, attempt: "post-1", usage: { input: 100, output: 20, cost: 0.01 } },
    { type: "attemptDispatched", context, at: 3, attempt: "post-2", retry: "format" },
    { type: "attemptFinalized", context, at: 4, attempt: "post-2" },
    { type: "reviewAccepted", context, at: 5, accepted: { safe: true, completedAt: 5, timing: { fullReportMs: 2000, ratingMs: 500 } } },
    { type: "approvalConfirmed", context, at: 6, approval: "approval-a", automatic: true },
    { type: "permissionResolved", context, at: 7, outcome: "auto", payload: { safe: true, completedAt: 5, desc: "Resolved report" } },
  ]
  for (const event of events) { await apply(a, event); await apply(b, event) }
  await apply(b, { type: "approvalConfirmed", context, at: 7, approval: "writer-b-confirmation", automatic: true })
  const first = await totals(a)
  assert.deepEqual(await totals(b), first)
  assert.equal(first.requests, 1); assert.equal(first.activity.usageRequests, 1)
  assert.equal(first.safe, 1); assert.equal(first.activity.reviews, 1)
  assert.equal(first.activity.retries, 1); assert.equal(first.activity.autoApproved, 1)
  assert.doesNotMatch(lifetimeReport(first), /partial history/)
  await a.dispose(); await b.dispose()
  const resumed = client()
  assert.deepEqual(await totals(resumed), first)
  for (const event of events) await apply(resumed, event)
  assert.deepEqual(await totals(resumed), first, "replay after restart never increments totals")
  const other = client(), next = { ...context, review: "review-b" }
  await apply(other, { type: "attemptFinalized", context: next, at: 8, attempt: "post-3", usage: { cost: 0.02 } })
  await apply(other, { type: "reviewAccepted", context: next, at: 9, accepted: { safe: false, completedAt: 9,
    timing: { fullReportMs: 4000, ratingMs: 1000 } } })
  const shared = await totals(resumed)
  assert.equal(shared.requests, 2); assert.equal(shared.cost, 0.03)
  assert.equal(shared.safe, 1); assert.equal(shared.unsafe, 1); assert.equal(shared.activity.reviews, 2)
  assert.equal(shared.activity.meanFullReportMs, 3000); assert.equal(shared.activity.meanRatingMs, 750)
  await apply(other, { type: "permissionResolved", context: next, at: 10, outcome: "auto",
    payload: { safe: false, completedAt: 9, desc: "Newer report" } })
  const history = () => resumed.query({ type: "history", root: context.root }) as Promise<HistorySelection>
  const replaced = await history()
  assert.equal(replaced.total, 1)
  assert.equal(replaced.record?.context.review, "review-b")
  assert.equal(replaced.record?.payload.desc, "Newer report")
  await apply(other, { type: "sessionDeleted", context: { root: context.root, session: context.root }, at: 11 })
  assert.deepEqual(await totals(resumed), shared, "a session invalidation does not change accounting")
  assert.deepEqual(await history(), replaced)
  const otherPermission = { ...context, permission: "other-permission", review: "review-c" }
  const manual: HistoryEvent = { type: "permissionResolved", context: otherPermission, at: 12, outcome: "manual",
    payload: { safe: true, completedAt: 12, desc: "Other permission" } }
  await Promise.all([apply(other, manual), apply(resumed, manual)])
  assert.equal((await history()).total, 2)
  const exact = async (permission: string) => (await resumed.query({ type: "history", root: context.root,
    permission: { session: context.session, permission } }) as HistorySelection).record
  assert.equal((await exact(context.permission))?.payload.desc, "Newer report")
  assert.equal((await exact(otherPermission.permission))?.payload.desc, "Other permission")
  assert.equal(await exact("unknown"), undefined)
  const final = await other.query({ type: "totals", conversation: { root: context.root } }) as HistoryTotals
  assert.deepEqual(final.conversation?.totals, final.totals)
  assert.equal(final.totals.activity.manuallyApproved, 1)
  assert.equal(final.totals.activity.autoApproved, 1)
  assert.equal(final.totals.requests, 2)
  for (const [file, text] of files) {
    assert.equal(await readFile(file, "utf8"), text)
    assert.equal((await readdir(path.dirname(file))).length, 2, "no legacy dual writes")
  }
})
