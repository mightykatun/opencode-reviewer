import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { setupCompanion } from "../src/companion.js"
import { companionRetrieval } from "../src/host-evaluate.js"
import { companionBusy } from "../src/companion-protocol.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { abortable } from "../src/chat-transport.js"
import { parseConfig } from "../src/config.js"
import { ownedReview } from "../src/review-admission.js"
import { review } from "../src/reviewer.js"
import { RetrievalCompletionError, type RetrievalExecutor } from "../src/retrieval.js"
import { runRetrievalTool, type RetrievalCall } from "../src/retrieval-tools.js"
import type { FileIO } from "../src/file-access.js"
import { shellEvidence } from "./review-fixtures.js"

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function clock(t: TestContext) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  return { advance(ms: number) { now += ms; t.mock.timers.tick(ms) } }
}

function heldIO(...names: string[]) {
  const holds = new Map(names.map(name => [name, { started: deferred<void>(), release: deferred<void>(), settled: false }]))
  const io: FileIO = {
    open: async () => { assert.fail("An expired server operation must not proceed from path resolution to open") },
    realpath: async name => {
      const hold = holds.get(name)
      if (!hold) throw Object.assign(Error("missing fixture file"), { code: "ENOENT" })
      hold.started.resolve()
      await hold.release.promise
      hold.settled = true
      return name
    },
  }
  return { io, holds, release() { for (const hold of holds.values()) hold.release.resolve() } }
}

/** Production handlers and executor, with a wire that really rejects on client
 * cancellation rather than quietly waiting for the handler's physical work. */
async function companion(io: FileIO, directory = "/fixture", lost?: Promise<never>) {
  const lifecycle = new PluginLifecycle(), location = { directory }
  let handlers: Record<string, (input: any, call: any) => Promise<unknown>> = {}
  const context = {
    app: { version: "development" }, location: { ...location, project: { id: "project", directory, canonical: directory } },
    tool: { hook: async () => ({ dispose() {} }) },
    rpc: { register: async (_definition: unknown, value: typeof handlers) => { handlers = value; return { dispose() {} } } },
  } as unknown as Plugin.Context
  const handshake = await setupCompanion(context, lifecycle, io)
  const scope = { location, epoch: handshake.epoch }
  const request = shellEvidence({ cwd: directory }).permission
  const queries: any[] = [], work: Promise<unknown>[] = []
  const invoke = (query: unknown, signal: AbortSignal) => handlers.retrieve!(query, {
    signal, error: (type: string, message: string, data: unknown) => { throw { type, message, data } },
  })
  const client = { rpc: () => ({ retrieve: (query: unknown, options: { signal?: AbortSignal }) => {
    queries.push(query)
    const transport = new AbortController(), signal = options.signal
    const cancel = () => transport.abort(signal?.reason)
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    const physical = invoke(query, transport.signal)
    work.push(physical)
    const response = lost ? Promise.race([physical, lost]) : physical
    return (signal ? abortable(response, signal) : response).finally(() => signal?.removeEventListener("abort", cancel))
  } }) } as unknown as OpenCodeClient
  return { executor: companionRetrieval(client, scope, request, 4096), queries,
    direct: (call: RetrievalCall, timeoutMs: number) => invoke({ ...scope, sessionID: request.sessionID, requestID: request.id,
      base: directory, call, timeoutMs, maxBytes: 4096 }, new AbortController().signal),
    async dispose() { await lifecycle.stop(); await lifecycle.settled(); await Promise.allSettled(work) },
  }
}

const turn = (name: string, args: unknown) => ({ choices: [{ message: { role: "assistant", tool_calls: [
  { id: name, type: "function", function: { name, arguments: JSON.stringify(args) } },
] }, finish_reason: "tool_calls" }] })

function start(executor: RetrievalExecutor, parent = new AbortController(), options: Record<string, unknown> = {},
  replies = [turn("finish", { items: [{ path: "slow" }] })], directory = "/fixture") {
  const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", timeoutMs: 1000,
    retrievalTimeoutMs: 100, maxEvidenceBytes: 4096, ...options })
  const bodies: any[] = []
  const evaluation = ownedReview(parent.signal, config.timeoutMs, signal => review(shellEvidence({ cwd: directory }), config, signal, {
    retrieval: executor,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      if (body.tools) {
        const reply = replies.shift()
        assert.ok(reply, "unexpected retriever POST")
        return Response.json(reply)
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ safe: false, desc: "Offline fixture assessment." }) }, finish_reason: "stop" }] })
    },
  }))
  return { evaluation, bodies }
}

test("default inspection flags an oversized unterminated next line through the production companion", async t => {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await mkdtemp("/tmp/opencode/retrieval-adversarial-")
  const service = await companion({ open, realpath: name => realpath(name) }, directory)
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }) })
  const prefix = "# x\n".repeat(100)
  await writeFile(`${directory}/script.sh`, prefix + "echo ".padEnd(100000, "x"))
  const running = start(service.executor, undefined, { retrievalTimeoutMs: 1000, timeoutMs: 2000 }, [
    turn("read", { path: "script.sh" }), turn("finish", { items: ["c1"] }),
  ], directory)
  await running.evaluation
  const answer = JSON.parse(running.bodies[1].messages.at(-1).content)
  assert.equal(service.queries[0].call.arguments.limit, 100)
  assert.equal(answer.content, prefix)
  assert.deepEqual([answer.endLine, answer.truncated, answer.nextOffset, answer.totalLines], [100, true, 101, undefined])
  const item = JSON.parse(running.bodies[2].messages[1].content).retrieval.items[0]
  assert.deepEqual([item.content, item.endLine, item.truncated, item.nextOffset], [prefix, 100, true, 101])

  // Exact EOF is still complete, and an oversized line before offset is skipped.
  for (const [text, args, expected] of [
    [prefix, { offset: 1, limit: 100 }, [1, 100, false, 100, prefix]],
    ["x".repeat(100000) + "\nlast\n", { offset: 2, limit: 1 }, [2, 2, false, 2, "last\n"]],
  ] as const) {
    await writeFile(`${directory}/boundary`, text)
    const result = await runRetrievalTool({ tool: "read", arguments: { path: "boundary", ...args } }, {
      base: directory, home: directory, maxBytes: 4096, io: { open, realpath: name => realpath(name) },
      signal: new AbortController().signal, softEnd: performance.now() + 1000,
    })
    assert.deepEqual([result.startLine, result.endLine, result.truncated, result.totalLines, result.content], expected)
  }
})

test("attachment timeout drains only its production RPC and keeps server capacity owned", async t => {
  const time = clock(t), data = heldIO("/fixture/slow", "/fixture/other")
  const service = await companion(data.io)
  t.after(async () => { data.release(); await service.dispose() })
  const slow = data.holds.get("/fixture/slow")!, other = data.holds.get("/fixture/other")!
  const running = start(service.executor)
  await slow.started.promise
  time.advance(100); await tick()
  assert.equal(running.bodies.length, 1, "no verdict while the timed-out attachment is physically pending")

  const missing = await service.direct({ tool: "read", arguments: { path: "missing" } }, 100)
  assert.equal((missing as any).reason, "ENOENT", "an unrelated read still has the second slot")
  const independent = service.direct({ tool: "read", arguments: { path: "other" } }, 100)
  await other.started.promise
  await assert.rejects(service.direct({ tool: "read", arguments: { path: "third" } }, 100),
    error => (error as any).type === companionBusy)
  time.advance(100); await tick()
  assert.equal(running.bodies.length, 1)
  slow.release.resolve()
  await running.evaluation
  assert.equal(slow.settled, true)
  assert.equal(other.settled, false, "this review does not drain another call")
  const evidence = JSON.parse(running.bodies[1].messages[1].content)
  assert.equal(evidence.retrieval.endReason, "retrieval-timeout")
  assert.deepEqual(evidence.retrieval.items, [])
  assert.equal(evidence.retrieval.trace[0].status, "error")
  other.release.resolve(); await independent
})

test("companion capacity retries keep the original deadline and stop on parent cancellation", async t => {
  const time = clock(t), data = heldIO("/fixture/first", "/fixture/second"), parent = new AbortController()
  const service = await companion(data.io)
  const occupying = ["first", "second"].map(path => service.direct({ tool: "read", arguments: { path } }, 1000))
  t.after(async () => { data.release(); await service.dispose(); await Promise.allSettled(occupying) })
  await Promise.all([...data.holds.values()].map(hold => hold.started.promise))
  const running = start(service.executor, parent, { retrievalTimeoutMs: 200 })
  const rejected = assert.rejects(running.evaluation, /capacity wait canceled/)
  await tick()
  assert.equal(service.queries.length, 1)
  assert.equal(service.queries[0].timeoutMs, 200)
  time.advance(50); await tick()
  assert.equal(service.queries.length, 2)
  assert.equal(service.queries[1].timeoutMs, 150, "retries do not reset the companion's time allowance")
  parent.abort(Error("capacity wait canceled"))
  await rejected; await running.evaluation.settled
  time.advance(50); await tick()
  assert.equal(service.queries.length, 2)
  assert.equal(running.bodies.length, 1)
})

for (const stop of ["parent cancellation", "review deadline"] as const) test(`${stop} stays immediate while the evaluator owns the companion drain`, async t => {
  const time = clock(t), data = heldIO("/fixture/slow"), parent = new AbortController()
  const service = await companion(data.io)
  t.after(async () => { data.release(); await service.dispose() })
  const hold = data.holds.get("/fixture/slow")!, reason = Error("cancel this review")
  const running = start(service.executor, parent, { timeoutMs: 200 })
  const rejected = assert.rejects(running.evaluation, stop === "parent cancellation" ? error => error === reason : /timed out/)
  await hold.started.promise
  let settled = false
  const lease = running.evaluation.settled!.then(() => { settled = true })
  if (stop === "parent cancellation") parent.abort(reason)
  else { time.advance(100); await tick(); time.advance(100) }
  await rejected; await tick()
  assert.equal(settled, false, "visible cancellation cannot release the evaluator's physical lease")
  assert.equal(running.bodies.length, 1)
  time.advance(100); await tick()
  assert.equal(settled, false)
  hold.release.resolve(); await lease
  assert.equal(hold.settled, true)
  assert.equal(running.bodies.length, 1, "late completion cannot start a verdict")
})

for (const late of [false, true]) test(`lost retrieval RPC ${late ? "after" : "before"} stage expiry cannot stand in for server completion`, async t => {
  const time = clock(t), data = heldIO("/fixture/slow"), lost = deferred<never>()
  const service = await companion(data.io, "/fixture", lost.promise)
  t.after(async () => { data.release(); await service.dispose() })
  const hold = data.holds.get("/fixture/slow")!
  const running = start(service.executor)
  const rejected = assert.rejects(running.evaluation, RetrievalCompletionError)
  await hold.started.promise
  if (late) { time.advance(100); await tick() }
  lost.reject(Error("wire disconnected"))
  await rejected
  assert.equal(hold.settled, false, "the server work is still pending when its transport disappears")
  assert.equal(running.bodies.length, 1, "an unconfirmed drain ends the review without a verdict")
  time.advance(100); await tick()
  hold.release.resolve()
})
