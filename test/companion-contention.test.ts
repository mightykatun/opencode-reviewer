import assert from "node:assert/strict"
import { test } from "node:test"
import timers, { setTimeout as wait, setImmediate as tick } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import type { OpenCodeClient } from "@opencode/client"
import { CompanionBusyError, createCompanionServer, type CompanionCollection, type CompanionQuery } from "../src/companion-reads.js"
import { directCompanionAccess } from "../src/companion-access.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { Controller } from "../src/controller.js"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { readHostEvidence } from "../src/host-evidence-reader.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import { snapshotRequest } from "../src/host-request.js"
import { withDeadline } from "../src/deadline.js"
import type { HostRequest } from "../src/host-types.js"

async function until(ready: () => boolean) {
  const end = performance.now() + 2000
  while (!ready()) {
    assert.ok(performance.now() < end, "Contention fixture did not reach its expected state")
    await wait(5)
  }
}

async function fixture(stage: "invocation" | "evidence", synchronize = false) {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  const location = { directory: "/server/project" }, project = { id: "project", directory: "/server", canonical: "/server" }
  const config = parseConfig({ baseURL: "http://127.0.0.1:40999/v1", model: "reviewer", stream: false, notify: false, retrieval: false })
  const requests = Array.from({ length: 4 }, (_, i) => ({ id: `request-${i}`, sessionID: "session", action: "edit", resources: [`target-${i}.txt`],
    source: { type: "tool", messageID: `assistant-${i}`, id: `call-${i}` },
    metadata: { files: [{ file: `target-${i}.txt`, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } }))
  const input = (i: number) => ({ path: `target-${i}.txt`, content: "new\n" })
  let hold = true, physical = 0, maximum = 0, messages = 0, releaseMessages!: () => void
  const messageBarrier = new Promise<void>(yes => { releaseMessages = yes })
  const held: (() => void)[] = [], counts = new Map<string, number>(), queries: { client: number; method: string; query: any }[] = []
  const busy: { client: number; method: string }[] = [], posts: any[] = []
  const server = {
    app: { version: "2.0.29" }, location: { ...location, project },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    permission: { get: async ({ requestID }: { requestID: string }) => {
      physical++; maximum = Math.max(maximum, physical)
      const count = (counts.get(requestID) ?? 0) + 1; counts.set(requestID, count)
      try {
        if (hold && count === (stage === "invocation" ? 1 : 3)) await new Promise<void>(yes => { held.push(yes) })
        return requests.find(request => request.id === requestID)
      } finally { physical-- }
    } },
    session: { get: async () => ({ id: "session", projectID: project.id, location }) },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(server, lifecycle, {
    open() { assert.fail("Write evidence cannot open files") }, realpath() { assert.fail("Write evidence cannot resolve files") },
  } as any)
  const scope = { epoch: companion.handshake.epoch, location }
  for (let i = 0; i < 4; i++) hooks.get("execute.before")!({ sessionID: "session", messageID: `assistant-${i}`, id: `call-${i}`, tool: "write", input: input(i) })
  const access = (client: number) => directCompanionAccess({ ...companion,
    read: async (query: CompanionQuery, signal: AbortSignal, collection?: CompanionCollection) => {
      const method = collection ? "evidence" : "invocation"
      queries.push({ client, method, query: structuredClone({ ...query, ...collection }) })
      try { return await companion.read(query, signal, collection) }
      catch (error) {
        if (error instanceof CompanionBusyError) busy.push({ client, method })
        throw error
      }
    },
  })
  const client = (id: number) => ({
    permission: { get: async ({ requestID }: { requestID: string }) => requests.find(request => request.id === requestID) },
    session: { get: async () => ({ id: "session", projectID: project.id, location }), message: { get: async ({ messageID }: { messageID: string }) => {
      if (synchronize) { messages++; if (messages === 4) releaseMessages(); await messageBarrier }
      const i = Number(messageID.split("-")[1])
      return { id: messageID, type: "assistant", content: [{ id: `call-${i}`, type: "tool", name: "write", state: { status: "running", input: input(i) } }] }
    } } },
    message: { list: async () => ({ data: [{ id: "root-user", type: "user", text: "Update the four isolated text targets." }], cursor: {} }) },
  }) as unknown as OpenCodeClient
  const fetcher: typeof fetch = async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: '{"safe":true,"reason":"Decisive reason.","desc":"Bounded text replacement."}' }, finish_reason: "stop" }] })
  }
  return { lifecycle, requests, scope, config, client, access, fetcher, held, busy, queries, posts, companion,
    maximum: () => maximum, physical: () => physical,
    release() { hold = false; for (const release of held) release(); releaseMessages() },
    unhold() { hold = false },
  }
}

for (const stage of ["invocation", "evidence"] as const) for (const shared of [false, true])
  test(`actual companion + evaluator + ${shared ? "shared clients/controllers" : "controller fanout4"} recovers ${stage} contention`, async t => {
    const f = await fixture(stage, stage === "evidence"), accepted: string[] = []
    let evaluations = 0
    const controllers = Array.from({ length: shared ? 2 : 1 }, (_, index) => {
      const client = f.client(index)
      return new Controller<HostRequest>((request, signal, identified) => {
        evaluations++
        return evaluateHostReview(client, snapshotRequest(f.requests.find(raw => raw.id === request.id)!, f.scope)!,
          f.config, BUILTIN_PROMPTS, signal, identified, { fetcher: f.fetcher, access: f.access(index) })
      }, () => {}, { candidate: () => true, onLifecycle: fact => { if (fact.type === "accepted") accepted.push(fact.request.id) } })
    })
    t.after(async () => { f.release(); await Promise.all(controllers.map(controller => controller.dispose())); await f.lifecycle.stop() })
    f.requests.forEach((raw, i) => controllers[shared ? i % 2 : 0]!.asked(snapshotRequest(raw, f.scope)!.request))
    await until(() => f.held.length === 2 && f.busy.some(event => event.method === stage))
    assert.equal(evaluations, 4)
    assert.equal(f.physical(), 2)
    assert.equal(f.posts.length, 0)
    assert.equal(controllers.flatMap(controller => controller.views).some(view => view.status === "unrelated"), false)
    await until(() => f.busy.filter(event => event.method === stage).length >= 4)
    f.release()
    await until(() => accepted.length === 4)
    assert.equal(new Set(accepted).size, 4)
    assert.ok(controllers.flatMap(controller => controller.views).every(view => view.status === "complete"))
    assert.equal(f.maximum(), 2)
    assert.equal(f.posts.length, 4, "Capacity retries do not add model POSTs")
    assert.equal(new Set(f.posts.map(post => JSON.parse(post.messages[1].content).permission.id)).size, 4)
    if (shared) assert.equal(new Set(f.queries.map(query => query.client)).size, 2)
    if (stage === "evidence") {
      for (const raw of f.requests) {
        const timeouts = f.queries.filter(item => item.method === "evidence" && item.query.requestID === raw.id).map(item => item.query.timeoutMs)
        assert.ok(timeouts.every(timeout => timeout > 0 && timeout <= 5000))
        for (let i = 1; i < timeouts.length; i++) assert.ok(timeouts[i]! < timeouts[i - 1]!, "Every retry regenerates the remaining original budget")
      }
    }
  })

test("timed-out noncooperative server reads retain both slots across invocation/evidence retries and client deadline", async t => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const sleep = t.mock.method(timers, "setTimeout")
  const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms) }
  const f = await fixture("invocation"), abort = new AbortController()
  t.after(async () => { f.release(); await f.lifecycle.stop() })
  const query = (i: number) => ({ ...f.scope, sessionID: "session", requestID: f.requests[i]!.id, options: f.config, timeoutMs: 20 })
  // Pass only the exact supported collection option fields, as actual clients do.
  const options = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true, reviewSkills: true,
    reviewTools: true, maxFiles: f.config.maxFiles, maxEvidenceBytes: f.config.maxEvidenceBytes }
  const first = f.companion.read(query(0), f.lifecycle.signal, { options, timeoutMs: 20 })
  const second = f.companion.read(query(1), f.lifecycle.signal, { options, timeoutMs: 20 })
  let completed = 0
  const results = Promise.all([first, second].map(read => read.then((result: unknown) => { completed++; return result })))
  await tick()
  assert.equal(f.held.length, 2)
  advance(19); await tick()
  assert.equal(completed, 0)
  assert.equal(f.physical(), 2)
  advance(1)
  assert.deepEqual(await results, [null, null])
  assert.equal(f.physical(), 2)
  const canceled = new AbortController()
  const evaluation = evaluateHostReview(f.client(3), snapshotRequest(f.requests[2], f.scope)!, f.config,
    BUILTIN_PROMPTS, canceled.signal, () => assert.fail("Busy evidence cannot identify"), { fetcher: f.fetcher, access: f.access(3) })
  const rejectedEvaluation = assert.rejects(evaluation, /Stop waiting review/)
  await tick()
  assert.ok(f.busy.some(event => event.client === 3))
  assert.equal(sleep.mock.calls.at(-1)!.arguments[0], 50)
  advance(49); await tick()
  assert.equal(f.queries.filter(query => query.client === 3).length, 1)
  canceled.abort(Error("Stop waiting review"))
  await rejectedEvaluation; await evaluation.settled
  const canceledCalls = f.queries.filter(query => query.client === 3).length
  advance(60); await tick()
  assert.equal(f.queries.filter(query => query.client === 3).length, canceledCalls, "Cancellation settles waiting without any detached retry")
  assert.equal(f.physical(), 2)
  assert.equal(f.posts.length, 0)
  const waiting = withDeadline(abort.signal, 120, signal => readHostEvidence(f.client(1), f.scope, f.requests[2], f.config, signal, f.access(1)))
  const rejectedWait = assert.rejects(waiting, /timed out/)
  await tick()
  const waitingCalls = () => f.queries.filter(query => query.client === 1).length
  assert.equal(waitingCalls(), 1)
  assert.equal(sleep.mock.calls.at(-1)!.arguments[0], 50)
  for (let retry = 0; retry < 2; retry++) {
    advance(49); await tick()
    assert.equal(waitingCalls(), retry + 1)
    advance(1); await tick()
    assert.equal(waitingCalls(), retry + 2)
  }
  assert.equal(sleep.mock.calls.at(-1)!.arguments[0], 20, "The final pause uses only the original remaining budget")
  advance(19); await tick()
  assert.equal(waitingCalls(), 3)
  advance(1); await rejectedWait
  assert.equal(f.busy.filter(event => event.client === 1 && event.method === "invocation").length, 3)
  advance(60); await tick()
  assert.equal(waitingCalls(), 3, "Expiry cannot leave a detached retry")
  assert.equal(f.queries.filter(query => query.client === 3).length, canceledCalls)
  await assert.rejects(f.companion.read(query(2), f.lifecycle.signal, { options, timeoutMs: 20 }), CompanionBusyError)
  assert.equal(f.held.length, 2, "Timeouts and retries cannot add physical reads")
  f.unhold(); f.held[0]!(); await tick(); await tick()
  assert.equal(f.physical(), 1)
  assert.equal((await readHostEvidence(f.client(2), f.scope, f.requests[3], f.config, new AbortController().signal, f.access(2)))?.result.status, "ready")
  assert.equal(f.maximum(), 2)
  let stopped = false
  const stopping = f.lifecycle.stop().then(() => { stopped = true })
  await tick(); assert.equal(stopped, false)
  f.held[1]!(); await stopping
  assert.equal(f.physical(), 0)
})
