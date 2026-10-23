import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setImmediate as settle } from "node:timers/promises"
import { HistoryCoordinator } from "../src/history-coordinator.js"
import { HistorySQL, type HistorySelection, type HistoryTotals } from "../src/history-schema.js"
import { encodeEvent, type HistoryEvent, type HistoryQuery } from "../src/history-records.js"
import type { ApprovalObserver, ReviewLifecycleFact, ReviewLifecycleObserver } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"
import type { ReviewResult } from "../src/types.js"
import { parseConfig } from "../src/config.js"
import { review } from "../src/reviewer.js"
import { shellEvidence } from "./review-fixtures.js"

const request: HostRequest = { id: "permission", sessionID: "child", action: "edit", resources: ["target.txt"],
  source: { assistantID: "assistant", id: "call" } }
const config = parseConfig({ model: "configured", baseURL: "https://openrouter.ai/api/v1", notify: false })
const result = (execution = "execution"): ReviewResult => ({ safe: true, desc: "Final validated native report.",
  metadata: { review: execution, kind: "edit", configuredModel: config.model, provider: config.baseURL } })
const accepted = (value = result(), req = request): ReviewLifecycleFact<HostRequest> => ({ type: "accepted", request: req,
  result: value, root: "root", review: "execution", completedAt: 100, timing: { fullReportMs: 10, ratingMs: 5 } })
const removed = (req = request): ReviewLifecycleFact<HostRequest> => ({ type: "removed", request: req, reason: "resolved" })
const approval = { request, automatic: true, approval: "approval", review: "execution" }

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:"), sql = new HistorySQL(db), events: HistoryEvent[] = []
  let sequence = 0, now = 1000, monotonic = 0
  const commits = new Set<() => unknown>()
  const store = { admit(event: HistoryEvent) {
    const encoded = encodeEvent(event)
    events.push(JSON.parse(encoded)); sql.apply("writer", ++sequence, encoded); return true
  }, query: (query: HistoryQuery) => Promise.resolve(sql.query(query)),
  onCommit: (fn: () => unknown) => { commits.add(fn); return () => { commits.delete(fn) } } }
  const h = new HistoryCoordinator<HostRequest>("/native-host", store, async () => "root", () => now, () => monotonic)
  const lifecycle: ReviewLifecycleObserver<HostRequest> = h.lifecycle
  const onApproval: ApprovalObserver<HostRequest> = h.approval
  t.after(() => { h.dispose(); sql.close() })
  return { h, lifecycle, onApproval, events, db,
    poll: async () => { now += 2000; monotonic += 2000; for (const fn of commits) fn(); await settle() },
    history: () => sql.query({ type: "history", scope: "/native-host", root: "root" }) as HistorySelection,
    totals: () => (sql.query({ type: "totals" }) as HistoryTotals).totals }
}

test("native history saves on once, but automatic attribution requires exact local confirmation", async t => {
  const f = fixture(t)
  const observation = f.h.observation(request, "edit", config, { review: "execution", root: "root" })
  observation.observe!({ type: "dispatched", review: "execution", attempt: "post", retry: "initial" })
  observation.observe!({ type: "finalized", review: "execution", attempt: "post", usage: { input: 2, output: 1, cost: 0 } })
  f.lifecycle(accepted())
  assert.equal(f.history().total, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  f.onApproval({ ...approval, type: "dispatched" })
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "once" })
  f.lifecycle(removed()); await settle()
  for (const wrong of [{ request: { ...request, id: "other" } }, { request: { ...request, sessionID: "other" } },
    { review: "other" }, { approval: "other" }]) f.onApproval({ ...approval, ...wrong, type: "confirmed" })
  assert.equal(f.history().record?.outcome, "approved")
  f.onApproval({ ...approval, type: "confirmed" })
  f.onApproval({ ...approval, type: "settled" })
  assert.equal(f.history().record?.payload.desc, "Final validated native report.")
  assert.equal(f.history().record?.outcome, "auto")
  assert.deepEqual(f.history().record?.context, { scope: "/native-host", root: "root", session: "child",
    permission: "permission", review: "execution", category: "edit", configuredModel: config.model, provider: config.baseURL })
  assert.equal(f.totals().requests, 1)
  assert.equal(f.totals().activity.autoApproved, 1)
  assert.equal(f.totals().activity.manuallyApproved, 0)
  assert.equal(f.totals().activity.rejected, 0)
  assert.equal(f.events.filter(event => event.type === "permissionResolved").length, 1)
  assert.equal(Object.hasOwn(request, "permission"), false)
  assert.equal(Object.hasOwn(request, "tool"), false)
})

test("external native once resolution saves the body without inventing approving-client identity", async t => {
  const f = fixture(t)
  f.lifecycle(accepted())
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "once" })
  f.lifecycle(removed()); await settle()
  assert.equal(f.history().record?.outcome, "approved")
  assert.equal(f.totals().safe, 1)
  assert.equal(f.totals().activity.autoApproved, 0)
  assert.equal(f.totals().activity.manuallyApproved, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 1)
  assert.equal(f.history().record?.payload.desc, "Final validated native report.")
})

test("native observation uses supplied validated kind rather than request action guesses", t => {
  const f = fixture(t)
  const observation = f.h.observation(request, "external-directory", config, { review: "execution", root: "root" })
  observation.observe!({ type: "dispatched", review: "unrelated", attempt: "other", retry: "initial" })
  observation.observe!({ type: "dispatched", review: "execution", attempt: "post", retry: "initial" })
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0]!.type, "attemptDispatched")
  assert.equal("category" in f.events[0]!.context && f.events[0]!.context.category, "external_directory")
})

test("fast native confirmation before completion saves only the final validated stream", async t => {
  const f = fixture(t), fast = { ...config, autoApprove: true, fastMode: true, stream: true }
  const observation = f.h.observation(request, "shell", fast, { review: "execution", root: "root" })
  let release!: () => void, preview!: () => void
  const previewed = new Promise<void>(resolve => { preview = resolve })
  const remainder = new Promise<void>(resolve => { release = resolve })
  let confirmed = false
  const frame = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [
    { index: 0, delta: { content }, finish_reason: finish },
  ] })}\n\n`
  const evaluation = review(shellEvidence(), fast,
    new AbortController().signal, { observation, fetcher: async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(frame('{"safe":true,"desc":"Final')))
        await remainder
        controller.enqueue(new TextEncoder().encode(frame(' validated native report."}', "stop") + "data: [DONE]\n\n"))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } }), onProgress: progress => {
      if (confirmed || !progress.preview?.safe) return
      confirmed = true
      f.onApproval({ ...approval, type: "dispatched" })
      f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply: "once" })
      f.onApproval({ ...approval, type: "confirmed" })
      f.onApproval({ ...approval, type: "settled" })
      preview()
    } })
  await previewed
  assert.equal(f.totals().activity.autoApproved, 1)
  assert.equal(f.history().total, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  f.lifecycle(accepted(result("wrong-execution")))
  assert.equal(f.history().total, 0, "mismatched final metadata is not accepted")
  release()
  const final = await evaluation
  f.lifecycle(accepted(final))
  assert.equal(f.history().record?.payload.desc, "Final validated native report.")
  assert.equal(f.history().record?.outcome, "auto")
  assert.equal(f.history().record?.context.category, "bash")
  assert.equal(f.totals().safe, 1)
  assert.equal(f.totals().activity.autoApproved, 1)
})

for (const reply of ["once", "always", "reject"] as const) test(`fast review completing after native ${reply} saves only its final report`, t => {
  const f = fixture(t), fast = { ...config, autoApprove: true, fastMode: true }
  f.h.observation(request, "edit", fast, { review: "execution", root: "root" })
  f.h.reply({ requestID: request.id, sessionID: request.sessionID, reply })
  assert.equal(f.history().total, 0)
  f.lifecycle(accepted({ ...result(), safe: false }))
  assert.equal(f.history().record?.payload.safe, false)
  assert.equal(f.history().record?.outcome, reply === "once" ? "approved" : reply === "always" ? "manual" : "rejected")
  assert.equal(f.totals().activity.autoApproved, 0)
  assert.equal(f.totals().activity.manuallyApproved, reply === "always" ? 1 : 0)
  assert.equal(f.totals().activity.rejected, reply === "reject" ? 1 : 0)
})

test("a rejected fast remainder counts received usage and confirmation without storing its preview", async t => {
  const f = fixture(t), fast = { ...config, autoApprove: true, fastMode: true, stream: true }
  const observation = f.h.observation(request, "shell", fast, { review: "execution", root: "root" })
  let confirmed = false
  const evaluation = review(shellEvidence(), fast,
    new AbortController().signal, { observation, fetcher: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"{\\"safe\\":true,\\"desc\\":\\"Unfinished preview"}}]}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"cost":0.1}}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } }), onProgress: progress => {
      if (confirmed || !progress.preview?.safe) return
      confirmed = true
      f.onApproval({ ...approval, type: "dispatched" })
      f.onApproval({ ...approval, type: "confirmed" })
      f.onApproval({ ...approval, type: "settled" })
    } })
  await assert.rejects(evaluation)
  f.lifecycle(removed())
  assert.equal(confirmed, true)
  assert.equal(f.totals().activity.autoApproved, 1)
  assert.equal(f.totals().cost, 0.1)
  assert.equal(f.totals().safe, 0)
  assert.equal(f.history().total, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
  assert.ok(f.events.every(event => !JSON.stringify(event).includes("Unfinished preview")))
})

for (const reason of ["reconciled", "resolved"] as const) test(`native ${reason} removal without a decision never saves reports`, async t => {
  const f = fixture(t)
  const req = request
  f.lifecycle(accepted(result(), req))
  f.lifecycle({ type: "removed", request: req, reason })
  await f.poll()
  assert.equal(f.history().total, 0)
  assert.equal(f.events.filter(event => event.type === "permissionResolved").length, 0)
})

test("native requests without an assistant source still require an actual permission decision", async t => {
  const f = fixture(t), req = { ...request, source: undefined }
  f.lifecycle(accepted(result(), req))
  f.lifecycle(removed(req)); await settle()
  assert.equal(f.history().total, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM payloads").get()!.n, 0)
})
