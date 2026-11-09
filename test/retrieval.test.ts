import { test } from "node:test"
import assert from "node:assert/strict"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS, RETRIEVAL_CONTRACT } from "../src/prompts.js"
import { maxCallsPerRound, retrievalTools, type RetrievalExecutor } from "../src/retrieval.js"
import type { JSONObject } from "../src/host-types.js"
import type { ReviewAttemptEvent, ReviewProgress } from "../src/types.js"
import { editEvidence, shellEvidence } from "./review-fixtures.js"

type Reply = Record<string, unknown> | ((body: any) => Response | Promise<Response>)
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } })
const tools = (...calls: unknown[]) => ({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 10, completion_tokens: 2 } })
const text = (content: string, usage = true) => ({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 2 } } : {}) })
const verdict = (safe = false) => text(JSON.stringify({ safe, desc: "Assessed with retrieved files." }))

function harness(replies: Reply[], results: Record<string, JSONObject> = {}, options: Record<string, unknown> = {}) {
  const bodies: any[] = [], executed: { call: any; base: string }[] = [], events: ReviewAttemptEvent[] = [], progress: ReviewProgress[] = []
  let retries = 0
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    const reply = replies.shift()
    assert.ok(reply, "unexpected POST")
    return typeof reply === "function" ? reply(body) : Response.json(reply)
  }
  const executor: RetrievalExecutor = { async execute(call, base) {
    executed.push({ call, base })
    return results[JSON.stringify(call.arguments)] ?? { tool: call.tool, status: "error", path: String(call.arguments.path ?? ""), reason: "ENOENT" }
  } }
  const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", ...options })
  const deps = { fetcher, retrieval: executor, onRetry: () => { retries++ },
    onProgress: (value: ReviewProgress) => { progress.push(value) },
    observation: { review: "review-1", observe: (event: ReviewAttemptEvent) => { events.push(event) } } }
  return { bodies, executed, events, progress, config, deps, retries: () => retries }
}
const signal = () => new AbortController().signal
const verdictEvidence = (body: any) => JSON.parse(body.messages[1].content)
const read = (path: string, content: string) => ({ tool: "read", status: "ok", path, absolutePath: `/fixture/${path}`,
  canonicalPath: `/fixture/${path}`, startLine: 1, endLine: content.split("\n").length - 1, totalLines: content.split("\n").length - 1, truncated: false, content })

test("the agent reads a script, selects it with notes, and the separate verdict receives the selection and summed usage", async () => {
  const script = "#!/bin/sh\nrm -rf build\n"
  const h = harness([tools(call("t1", "read", { path: "run.sh" })), tools(call("t2", "finish", { items: ["c1"], notes: "run.sh deletes build/." })), verdict()],
    { [JSON.stringify({ path: "run.sh" })]: read("run.sh", script) })
  const result = await review(shellEvidence({ command: "./run.sh" }), h.config, signal(), h.deps)
  assert.equal(result.safe, false)
  assert.equal(h.bodies.length, 3)
  const [first, second, last] = h.bodies
  assert.deepEqual(first.tools, retrievalTools)
  assert.equal(first.stream, false)
  assert.equal(first.tool_choice, undefined)
  assert.equal(first.messages[0].content, [BUILTIN_PROMPTS.shell.instructions, BUILTIN_PROMPTS.retrieval, RETRIEVAL_CONTRACT].join("\n\n"))
  assert.equal(JSON.parse(first.messages[1].content).relativePathBase, "/fixture")
  assert.deepEqual(second.messages.slice(0, 2), first.messages, "turns append to a byte-stable prefix")
  assert.deepEqual(second.messages[3], { role: "tool", tool_call_id: "t1", content: JSON.stringify({ id: "c1", ...read("run.sh", script) }) })
  assert.equal(last.tools, undefined, "the verdict request declares no tools")
  assert.ok(!last.messages[0].content.includes(BUILTIN_PROMPTS.retrieval), "the verdict never receives retrieval guidance")
  const evidence = verdictEvidence(last)
  assert.equal(evidence.retrieval.status, "completed")
  assert.equal(evidence.retrieval.selection, "agent")
  assert.equal(evidence.retrieval.endReason, "finish")
  assert.equal(evidence.retrieval.notes, "run.sh deletes build/.")
  assert.deepEqual(evidence.retrieval.items.map((item: any) => [item.id, item.content]), [["c1", script]])
  assert.equal(evidence.retrieval.trace[0].forwarded, "full")
  assert.deepEqual(h.executed, [{ call: { tool: "read", arguments: { path: "run.sh" } }, base: "/fixture" }])
  assert.deepEqual(result.usage, { input: 30, output: 6 })
  assert.deepEqual(h.events.filter(event => event.type === "dispatched").map(event => event.retry), ["initial", "initial", "initial"])
  assert.equal(h.events.filter(event => event.type === "finalized").length, 3)
  assert.equal(h.retries(), 0)
  assert.deepEqual(h.progress.map(value => value.phase), ["retrieving", "retrieving", "evaluating"])
})

test("a plain-text stop and the round limit both lead to one forced finish turn with unchanged tools", async () => {
  for (const [replies, rounds] of [
    [[text("I have enough."), tools(call("f", "finish", { items: [] })), verdict()], 3],
    [[tools(call("a", "list", { path: "." })), tools(call("f", "finish", { items: ["c1"] })), verdict()], 1],
  ] as const) {
    const h = harness([...replies], { [JSON.stringify({ path: "." })]: { tool: "list", status: "ok", path: ".", entries: [{ name: "a", type: "file" }], truncated: false } },
      { maxRetrievalRounds: rounds })
    await review(shellEvidence(), h.config, signal(), h.deps)
    const finish = h.bodies[1]
    assert.deepEqual(finish.tool_choice, { type: "function", function: { name: "finish" } })
    assert.deepEqual(finish.tools, retrievalTools)
    assert.equal(verdictEvidence(h.bodies[2]).retrieval.selection, "agent")
  }
})

test("without a valid finish, every successful result is forwarded in call order with a factual limitation", async () => {
  const h = harness([tools(call("a", "read", { path: "a" }), call("b", "read", { path: "missing" }), call("c", "read", { path: "c" })),
    tools(call("x", "read", { path: "a" })), verdict()],
  { [JSON.stringify({ path: "a" })]: read("a", "one\n"), [JSON.stringify({ path: "c" })]: read("c", "three\n") }, { maxRetrievalRounds: 1 })
  await review(shellEvidence(), h.config, signal(), h.deps)
  const evidence = verdictEvidence(h.bodies[2])
  assert.equal(evidence.retrieval.selection, "all-in-order")
  assert.equal(evidence.retrieval.endReason, "no-finish")
  assert.deepEqual(evidence.retrieval.items.map((item: any) => item.id), ["c1", "c3"])
  assert.equal(evidence.retrieval.trace[1].status, "error")
  assert.equal(evidence.retrieval.trace[1].reason, "ENOENT")
  assert.match(evidence.limitations.join("\n"), /without a valid finish selection \(no-finish\)/)
})

test("malformed calls return errors to the model; extra calls and calls beside finish are not executed", async () => {
  const many = Array.from({ length: maxCallsPerRound + 1 }, (_, index) => call(`m${index}`, "read", { path: `f${index}` }))
  const h = harness([tools(call("u", "write", { path: "x" }), call("j", "read", "{not json"), call("i", "finish", { items: "c1" })),
    tools(...many), tools(call("r", "read", { path: "late" }), call("f", "finish", { items: [] })), verdict()])
  await review(shellEvidence(), h.config, signal(), h.deps)
  const answers = h.bodies[1].messages.slice(3).map((message: any) => JSON.parse(message.content))
  assert.deepEqual(answers.map((answer: any) => answer.reason), ["unknown tool", "invalid arguments: arguments must be a JSON object",
    "invalid arguments: finish requires items (string array) and optional notes (string)"])
  assert.equal(h.executed.length, maxCallsPerRound, "the eleventh call is not executed")
  const last = h.bodies[2].messages.at(-1)
  assert.equal(JSON.parse(last.content).reason, "not executed: per-round call limit")
  const trace = verdictEvidence(h.bodies[3]).retrieval.trace
  assert.deepEqual(trace.at(-1), { id: `c${trace.length}`, round: 3, tool: "read", arguments: "{\"path\":\"late\"}", status: "not-executed", reason: "not executed: finish called" })
  assert.equal(h.executed.some(item => item.call.arguments.path === "late"), false)
})

test("endpoint rejection, provider errors and malformed tool calls fall back to the verdict with the reason", async () => {
  for (const [reply, reason] of [
    [() => new Response("tools unsupported", { status: 400 }), "tools-rejected"],
    [{ choices: [{ message: { role: "assistant", refusal: "No." }, finish_reason: "stop" }] }, "provider-error"],
    [{ choices: [{ message: { role: "assistant", tool_calls: [{ id: "x", function: { name: "read" } }] }, finish_reason: "tool_calls" }] }, "malformed-response"],
  ] as const) {
    const h = harness([reply as Reply, verdict()])
    const result = await review(shellEvidence(), h.config, signal(), h.deps)
    assert.equal(result.safe, false)
    const evidence = verdictEvidence(h.bodies[1])
    assert.equal(evidence.retrieval.endReason, reason)
    assert.equal(evidence.retrieval.selection, "all-in-order")
    assert.equal(h.bodies.length, 2, reason)
  }
})

test("retrieval has its own transport retry budget, counted as retries and shown as retrying", async () => {
  const h = harness([() => new Response("busy", { status: 503 }), tools(call("f", "finish", { items: [] })),
    () => new Response("busy", { status: 503 }), verdict()])
  await review(shellEvidence(), h.config, signal(), h.deps)
  assert.deepEqual(h.events.filter(event => event.type === "dispatched").map(event => event.retry), ["initial", "transport", "initial", "transport"])
  assert.equal(h.retries(), 2)
  assert.deepEqual(h.progress.map(value => value.phase).slice(0, 3), ["retrieving", "retrieval-retrying", "retrieving"])
})

test("the retrieval budget expires into a fallback while the review deadline still allows a verdict", async () => {
  const h = harness([tools(call("a", "read", { path: "slow" })), verdict()], {}, { retrievalTimeoutMs: 100 })
  const executor: RetrievalExecutor = { execute: (_call, _base, _timeout, stage) => new Promise((_, reject) => {
    stage.addEventListener("abort", () => reject(stage.reason), { once: true })
  }) }
  await review(shellEvidence(), h.config, signal(), { ...h.deps, retrieval: executor })
  const evidence = verdictEvidence(h.bodies[1])
  assert.equal(evidence.retrieval.endReason, "retrieval-timeout")
  assert.match(evidence.limitations.join("\n"), /retrievalTimeoutMs/)
})

test("cancelling the review during retrieval rejects instead of falling back", async () => {
  const h = harness([tools(call("a", "read", { path: "slow" }))])
  const controller = new AbortController()
  const executor: RetrievalExecutor = { execute: () => { controller.abort(new Error("review canceled")); return new Promise(() => {}) } }
  await assert.rejects(review(shellEvidence(), h.config, controller.signal, { ...h.deps, retrieval: executor }), /review canceled/)
  assert.equal(h.bodies.length, 1)
})

test("forwarding honors maxFiles for reads and truncates to exact leading lines or entries within the byte budget", async () => {
  const long = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
  const h = harness([tools(call("a", "read", { path: "a" }), call("b", "read", { path: "b" }), call("c", "glob", { pattern: "*" }), call("d", "read", { path: "d" })),
    tools(call("f", "finish", { items: ["c1", "c2", "c3", "c4", "c9"] })), verdict()], {
    [JSON.stringify({ path: "a" })]: read("a", long), [JSON.stringify({ path: "b" })]: read("b", "bee\n"),
    [JSON.stringify({ pattern: "*" })]: { tool: "glob", status: "ok", path: "/fixture", matches: ["/fixture/1", "/fixture/2", "/fixture/3"], truncated: false },
    [JSON.stringify({ path: "d" })]: read("d", "dee\n"),
  }, { maxFiles: 2, maxEvidenceBytes: 100 })
  await review(shellEvidence(), h.config, signal(), h.deps)
  const { retrieval, limitations } = verdictEvidence(h.bodies[2])
  const [a, b] = retrieval.items
  // 9 seven-byte lines plus 4 eight-byte lines fill 95 of 100 bytes.
  assert.equal(a.content, long.split("\n").slice(0, 13).join("\n") + "\n")
  assert.deepEqual([a.startLine, a.endLine, a.truncated, a.totalLines], [1, 13, { omittedLines: 37 }, undefined])
  assert.equal(b.content, "bee\n")
  assert.deepEqual(retrieval.items.map((item: any) => item.id), ["c1", "c2"])
  const reasons = Object.fromEntries(retrieval.trace.map((entry: any) => [entry.id, [entry.forwarded, entry.omittedReason]]))
  assert.deepEqual(reasons, { c1: ["truncated", undefined], c2: ["full", undefined], c3: ["omitted", "forwarded byte budget exhausted"],
    c4: ["omitted", "file-count limit"] })
  assert.match(limitations.join("\n"), /unknown or failed result IDs: "c9"/)
  assert.match(limitations.join("\n"), /omitted or truncated/)
})

test("disabled categories and missing executors run a single verdict POST with a factual section", async () => {
  const disabled = harness([verdict()])
  await review(editEvidence(), disabled.config, signal(), disabled.deps)
  assert.equal(disabled.bodies.length, 1)
  assert.deepEqual(verdictEvidence(disabled.bodies[0]).retrieval, { status: "disabled" })
  const off = harness([verdict()], {}, { retrieval: false })
  await review(shellEvidence(), off.config, signal(), off.deps)
  assert.deepEqual(verdictEvidence(off.bodies[0]).retrieval, { status: "disabled" })
  const missing = harness([verdict()])
  await review(shellEvidence(), missing.config, signal(), { ...missing.deps, retrieval: undefined })
  assert.deepEqual(verdictEvidence(missing.bodies[0]).retrieval, { status: "unavailable" })
  assert.deepEqual(missing.progress.map(value => value.phase), ["evaluating"])
})

test("OpenRouter retrieval requests mark the stable system and evidence prefix for provider caching", async () => {
  const h = harness([tools(call("f", "finish", { items: [] })), verdict()], {}, { baseURL: "https://openrouter.ai/api/v1/" })
  await review(shellEvidence(), h.config, signal(), h.deps)
  for (const message of h.bodies[0].messages)
    assert.deepEqual(Object.keys(message.content[0]), ["type", "text", "cache_control"])
  assert.equal(typeof h.bodies[1].messages[0].content, "string", "the verdict request shape is unchanged")
})

test("unknown retrieval usage keeps the report usage unknown rather than zero", async () => {
  const unknown = { choices: [{ index: 0, message: { role: "assistant", tool_calls: [call("f", "finish", { items: [] })] }, finish_reason: "tool_calls" }] }
  const h = harness([unknown, verdict()])
  const result = await review(shellEvidence(), h.config, signal(), h.deps)
  assert.equal(result.usage, undefined)
})

test("host evaluation runs the agent's reads through the scoped companion against the shell launch directory", async t => {
  const { mkdtemp, mkdir, writeFile, realpath, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os"), path = await import("node:path")
  const { FileAccess } = await import("../src/file-access.js")
  const { evaluateHostReview } = await import("../src/host-evaluate.js")
  const { nativeInvocation, nativeClient } = await import("./review-fixtures.js")
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "review-host-retrieval-")))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(`${dir}/scripts`)
  await writeFile(`${dir}/scripts/deploy.sh`, "#!/bin/sh\ncurl -X POST https://example.invalid/deploy\n")
  const owned = nativeInvocation("shell", { command: "./deploy.sh", workdir: "scripts" }, undefined, dir, ["./deploy.sh"])
  const posts: any[] = []
  const replies = [tools(call("a", "read", { path: "deploy.sh" })), tools(call("f", "finish", { items: ["c1"] })), verdict(false)]
  const result = await evaluateHostReview(nativeClient(owned, new FileAccess()), owned.snapshot,
    parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture" }), BUILTIN_PROMPTS, new AbortController().signal, () => {}, {
      fetcher: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return Response.json(replies.shift()) } })
  assert.equal(result?.safe, false)
  assert.equal(posts.length, 3)
  const answer = JSON.parse(posts[1].messages[3].content)
  assert.deepEqual([answer.id, answer.status, answer.canonicalPath], ["c1", "ok", `${dir}/scripts/deploy.sh`])
  const evidence = verdictEvidence(posts[2])
  assert.equal(evidence.retrieval.base, `${dir}/scripts`)
  assert.match(evidence.retrieval.items[0].content, /curl -X POST/)
})
