import { test } from "node:test"
import assert from "node:assert/strict"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS, RETRIEVAL_CONTRACT } from "../src/prompts.js"
import { clarifyingRetrievalTools, maxCallsPerRound, retrievalTools, type RetrievalExecutor } from "../src/retrieval.js"
import type { ContextAsker } from "../src/clarification.js"
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
    // Existing canned results are short enough for either inspection default.
    const { limit, ...withoutDefault } = call.arguments
    return results[JSON.stringify(call.arguments)]
      ?? (limit === (call.tool === "read" ? 100 : 50) ? results[JSON.stringify(withoutDefault)] : undefined)
      ?? { tool: call.tool, status: "error", path: String(call.arguments.path ?? ""), reason: "ENOENT" }
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
  assert.equal(result.toolCalls, 1)
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
  assert.deepEqual(h.executed, [{ call: { tool: "read", arguments: { path: "run.sh", limit: 100 } }, base: "/fixture" }])
  assert.deepEqual(result.usage, { input: 30, output: 6 })
  assert.deepEqual(h.events.filter(event => event.type === "dispatched").map(event => event.retry), ["initial", "initial", "initial"])
  assert.equal(h.events.filter(event => event.type === "finalized").length, 3)
  assert.deepEqual(h.events.filter(event => event.type === "toolDispatched"), [{ type: "toolDispatched", review: "review-1", call: "1" }])
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
  const result = await review(shellEvidence(), h.config, signal(), h.deps)
  assert.equal(result.toolCalls, 3, "the missing file counts as a dispatched retrieval operation")
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
  const result = await review(shellEvidence(), h.config, signal(), h.deps)
  assert.equal(result.toolCalls, maxCallsPerRound)
  assert.equal(h.events.filter(event => event.type === "toolDispatched").length, maxCallsPerRound)
  const answers = h.bodies[1].messages.slice(3).map((message: any) => JSON.parse(message.content))
  assert.deepEqual(answers.map((answer: any) => answer.reason), ["unknown tool", "invalid arguments: arguments must be a JSON object",
    "invalid arguments: finish requires items (result IDs or files with path and optional positive offset/limit) and optional notes (string)"])
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

test("synchronous retrieval transport failures retain every dispatched attempt and retry", async () => {
  const h = harness([tools(call("f", "finish", { items: [] })), verdict()])
  let calls = 0
  await review(shellEvidence(), h.config, signal(), { ...h.deps, fetcher: (url, init) => {
    if (++calls <= 2) throw Object.assign(Error("socket reset"), { code: "ECONNRESET" })
    return h.deps.fetcher(url, init)
  } })
  const dispatched = h.events.filter(event => event.type === "dispatched")
  assert.deepEqual(dispatched.map(event => event.retry), ["initial", "transport", "transport", "initial"])
  assert.deepEqual(h.events.filter(event => event.type === "finalized").map(event => event.attempt), dispatched.map(event => event.attempt))
  assert.equal(h.retries(), 2)
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
  assert.equal(h.events.filter(event => event.type === "toolDispatched").length, 1, "dispatch is counted even when its operation cancels the review")
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
  assert.equal((await review(editEvidence(), disabled.config, signal(), disabled.deps)).toolCalls, 0)
  assert.equal(disabled.bodies.length, 1)
  assert.deepEqual(verdictEvidence(disabled.bodies[0]).retrieval, { status: "disabled" })
  const off = harness([verdict()], {}, { retrieval: false })
  assert.equal((await review(shellEvidence(), off.config, signal(), off.deps)).toolCalls, 0)
  assert.deepEqual(verdictEvidence(off.bodies[0]).retrieval, { status: "disabled" })
  const missing = harness([verdict()])
  assert.equal((await review(shellEvidence(), missing.config, signal(), { ...missing.deps, retrieval: undefined })).toolCalls, 0)
  assert.deepEqual(verdictEvidence(missing.bodies[0]).retrieval, { status: "unavailable" })
  assert.deepEqual(missing.progress.map(value => value.phase), ["evaluating"])
})

test("OpenRouter retrieval requests mark the stable system and evidence prefix for provider caching", async () => {
  const h = harness([tools(call("f", "finish", { items: [] })), verdict()], {}, { baseURL: "https://openrouter.ai/api/v1/" })
  assert.equal((await review(shellEvidence(), h.config, signal(), h.deps)).toolCalls, 0, "finish is not a retrieval operation")
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

function asking(answer: ContextAsker["ask"] = async () => "The user asked to clear build output.") {
  const prompts: string[] = []
  const asker: ContextAsker = { ask: (prompt, signal) => { prompts.push(prompt); return answer(prompt, signal) } }
  return { asker, prompts }
}
const subagentShell = () => {
  const location = { directory: "/fixture" }
  return shellEvidence({ conversation: { current: { id: "child", parentID: "root", projectID: "project", location },
    root: { id: "root", projectID: "project", location }, rootMessageID: "user" } })
}

test("a root review asks the conversation once, and the answer is selectable evidence that is not a file", async () => {
  const context = asking(async () => "  The user asked to clear build output.\n")
  const questions = "Why delete build/? Did the user ask for it?"
  const h = harness([tools(call("q", "ask_context", { questions }), call("r", "read", { path: "run.sh" })),
    tools(call("q2", "ask_context", { questions: "One more?" })), tools(call("f", "finish", { items: ["c1", "c2"] })), verdict(true)],
  { [JSON.stringify({ path: "run.sh" })]: read("run.sh", "rm -rf build\n") }, { maxFiles: 1 })
  const result = await review(shellEvidence({ command: "./run.sh" }), h.config, signal(), { ...h.deps, clarification: context.asker })
  assert.equal(result.safe, true)
  assert.deepEqual(h.bodies[0].tools, clarifyingRetrievalTools)
  assert.equal(context.prompts.length, 1, "a second call is never executed")
  const [template, payload] = [context.prompts[0]!.slice(0, BUILTIN_PROMPTS.clarification.length), context.prompts[0]!.slice(BUILTIN_PROMPTS.clarification.length + 2)]
  assert.equal(template, BUILTIN_PROMPTS.clarification)
  const sent = JSON.parse(payload)
  assert.equal(sent.questions, questions)
  assert.equal(sent.pendingOperation.command, "./run.sh")
  for (const key of ["conversation", "userPrompt", "earlierUserPrompts", "delegation", "limitations"]) assert.equal(Object.hasOwn(sent.pendingOperation, key), false)
  assert.deepEqual(JSON.parse(h.bodies[1].messages[3].content),
    { id: "c1", tool: "ask_context", questions, status: "ok", content: "The user asked to clear build output." })
  assert.equal(JSON.parse(h.bodies[2].messages.at(-1).content).reason, "not executed: ask_context is allowed once per review")
  const evidence = verdictEvidence(h.bodies[3])
  assert.deepEqual(evidence.retrieval.items.map((item: any) => [item.id, item.tool]), [["c1", "ask_context"], ["c2", "read"]],
    "the answer does not use the single maxFiles read slot")
  assert.equal(evidence.retrieval.items[0].questions, questions)
  assert.deepEqual(evidence.retrieval.trace[0].arguments, { questions })
  assert.equal(Object.hasOwn(evidence.retrieval.trace[0], "questions"), false, "the trace keeps questions once, as arguments")
  assert.equal(evidence.retrieval.trace[2].status, "not-executed")
  assert.equal(result.toolCalls, 2)
  assert.deepEqual(h.progress.map(value => value.phase), ["retrieving", "asking", "retrieving", "retrieving", "retrieving", "evaluating"])
})

test("subagent reviews and a disabled setting never offer or run ask_context", async () => {
  for (const [evidence, options] of [[subagentShell(), {}], [shellEvidence(), { retrievalClarification: false }]] as const) {
    const context = asking()
    const h = harness([tools(call("q", "ask_context", { questions: "Why?" })), tools(call("f", "finish", { items: [] })), verdict()], {}, options)
    await review(evidence, h.config, signal(), { ...h.deps, clarification: context.asker })
    assert.deepEqual(h.bodies[0].tools, retrievalTools)
    assert.equal(JSON.parse(h.bodies[1].messages[3].content).reason, "unknown tool")
    assert.deepEqual(context.prompts, [])
    assert.ok(!h.progress.some(value => value.phase === "asking"))
  }
})

test("clarification failures and invalid questions are factual results, and cancellation ends the review", async () => {
  for (const [answer, reason] of [[async () => { throw Error("session busy") }, "session context answer unavailable"],
    [async () => " \n ", "the session model returned no answer text"]] as const) {
    const h = harness([tools(call("q", "ask_context", { questions: "Why?" })), tools(call("f", "finish", { items: ["c1"] })), verdict()])
    const result = await review(shellEvidence(), h.config, signal(), { ...h.deps, clarification: asking(answer).asker })
    const evidence = verdictEvidence(h.bodies[2])
    assert.deepEqual([evidence.retrieval.trace[0].status, evidence.retrieval.trace[0].reason], ["error", reason])
    assert.deepEqual(evidence.retrieval.items, [])
    assert.equal(result.toolCalls, 1)
  }
  for (const args of [{}, { questions: "" }, { questions: 7 }, { questions: "Why?", extra: true }, { questions: "x".repeat(8193) }]) {
    const context = asking()
    const h = harness([tools(call("q", "ask_context", args)), tools(call("q2", "ask_context", { questions: "Valid?" })),
      tools(call("f", "finish", { items: [] })), verdict()])
    await review(shellEvidence(), h.config, signal(), { ...h.deps, clarification: context.asker })
    assert.match(JSON.parse(h.bodies[1].messages[3].content).reason, /^invalid arguments: ask_context requires questions/)
    assert.equal(context.prompts.length, 1, "an invalid call does not use the single allowance")
  }
  const controller = new AbortController(), reason = Error("review canceled")
  const h = harness([tools(call("q", "ask_context", { questions: "Why?" }))])
  const pending = review(shellEvidence(), h.config, controller.signal, { ...h.deps, clarification: asking((_, abort) => new Promise((_, reject) => {
    abort.addEventListener("abort", () => reject(abort.reason), { once: true })
    queueMicrotask(() => controller.abort(reason))
  })).asker })
  await assert.rejects(pending, error => error === reason)
  assert.equal(h.bodies.length, 1, "no verdict follows a canceled clarification")
})

test("host evaluation asks the root session through native session generation on the captured client", async t => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os"), path = await import("node:path")
  const { FileAccess } = await import("../src/file-access.js")
  const { evaluateHostReview } = await import("../src/host-evaluate.js")
  const { nativeInvocation, nativeClient } = await import("./review-fixtures.js")
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "review-host-clarification-")))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const owned = nativeInvocation("shell", { command: "rm -rf build" }, undefined, dir, ["rm -rf build"])
  const generated: { sessionID: string; prompt: string; aborted: boolean }[] = [], posts: any[] = []
  const replies = [tools(call("q", "ask_context", { questions: "Why remove build?" })), tools(call("f", "finish", { items: ["c1"] })), verdict(true)]
  const client = nativeClient(owned, new FileAccess(), async (input, options) => {
    generated.push({ ...input, aborted: options.signal.aborted })
    return { text: "The user asked for a clean rebuild." }
  })
  const result = await evaluateHostReview(client, owned.snapshot, parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture" }),
    BUILTIN_PROMPTS, new AbortController().signal, () => {}, {
      fetcher: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return Response.json(replies.shift()) } })
  assert.equal(result?.safe, true)
  assert.equal(generated.length, 1)
  assert.equal(generated[0]!.sessionID, owned.conversation.current.id)
  assert.equal(generated[0]!.aborted, false)
  assert.match(generated[0]!.prompt, /"questions":"Why remove build\?"/)
  assert.equal(verdictEvidence(posts[2]).retrieval.items[0].content, "The user asked for a clean rebuild.")
})

test("finish attaches files directly, preserving exact ranges and paths without another retrieval POST", async () => {
  const args = { path: "~/release.sh", offset: 205, limit: 2 }
  const content = "curl -X POST https://example.invalid/deploy\nrm -rf build\n"
  const file = { ...read(args.path, content), absolutePath: "/home/fixture/release.sh", canonicalPath: "/real/release.sh",
    startLine: 205, endLine: 206, totalLines: 206 }
  const h = harness([tools(call("r", "read", { path: "not-executed" }), call("f", "finish", { items: [args] })), verdict()],
    { [JSON.stringify(args)]: file })
  const result = await review(shellEvidence(), h.config, signal(), h.deps)
  assert.equal(h.bodies.length, 2)
  assert.equal(result.toolCalls, 1)
  assert.deepEqual(h.executed, [{ call: { tool: "read", arguments: args }, base: "/fixture" }])
  assert.ok(!JSON.stringify(h.bodies[0]).includes("curl -X POST"))
  const { retrieval } = verdictEvidence(h.bodies[1])
  const { status: _, ...expected } = file
  assert.deepEqual(retrieval.items, [{ id: "c2", ...expected }])
  assert.deepEqual(retrieval.trace.map((entry: any) => [entry.status, entry.delivery]), [["not-executed", undefined], ["ok", "reviewer"]])
  assert.equal(h.events.filter(event => event.type === "toolDispatched").length, 1)
  assert.equal(retrieval.selection, "agent")
})

test("forced finish can attach directly, and descriptor validation precedes every attachment read", async () => {
  const h = harness([text("done"), tools(call("f", "finish", { items: [{ path: "run.sh" }] })), verdict()],
    { [JSON.stringify({ path: "run.sh" })]: read("run.sh", "run\n") })
  await review(shellEvidence(), h.config, signal(), h.deps)
  assert.equal(h.bodies.length, 3)
  assert.deepEqual(h.bodies[1].tool_choice, { type: "function", function: { name: "finish" } })
  assert.equal(verdictEvidence(h.bodies[2]).retrieval.items[0].content, "run\n")
  for (const bad of [null, [], {}, { path: "" }, { path: "x\0y" }, { path: "x".repeat(16385) },
    { path: "x", offset: 0 }, { path: "x", limit: -1 }, { path: "x", limit: 1.5 }, { path: "x", limit: null },
    { path: "x", offset: Number.MAX_SAFE_INTEGER + 1 }, { path: "x", limit: "100" }, { path: "x", extra: true }]) {
    const invalid = harness([tools(call("f", "finish", { items: [{ path: "valid" }, bad] })),
      tools(call("f2", "finish", { items: [] })), verdict()])
    await review(shellEvidence(), invalid.config, signal(), invalid.deps)
    assert.deepEqual(invalid.executed, [], "no partial attachment execution for invalid finish")
    assert.match(JSON.parse(invalid.bodies[1].messages.at(-1).content).reason, /^invalid arguments: finish/)
  }
})

test("mixed selections share ordered budgets, ignore duplicate result IDs and preserve attachment failures", async () => {
  const h = harness([tools(call("r", "read", { path: "inspected" }), call("u", "read", { path: "unselected" })),
    tools(call("f", "finish", { items: [{ path: "attached" }, "c1", "c1", { path: "missing" }, { path: "tail" }, "c999"] })), verdict()], {
    [JSON.stringify({ path: "inspected" })]: read("inspected", "two\n"),
    [JSON.stringify({ path: "unselected" })]: read("unselected", "not forwarded\n"),
    [JSON.stringify({ path: "attached" })]: read("attached", "one\n"),
    [JSON.stringify({ path: "tail" })]: read("tail", "three\n"),
  }, { maxFiles: 3 })
  const result = await review(shellEvidence(), h.config, signal(), h.deps)
  const evidence = verdictEvidence(h.bodies[2])
  assert.deepEqual(evidence.retrieval.items.map((item: any) => item.content), ["one\n", "two\n", "three\n"])
  assert.equal(evidence.retrieval.trace[1].forwarded, "not-selected")
  assert.equal(evidence.retrieval.trace[3].reason, "ENOENT")
  assert.match(evidence.limitations.join("\n"), /unknown or failed result IDs: "c999"/)
  assert.match(evidence.limitations.join("\n"), /Some selected attachments failed/)
  assert.equal(result.toolCalls, 5, "failed reads count, duplicate references do not")
})

test("attachment admission uses the same file and byte budget as final forwarding, including notes", async () => {
  for (const [options, notes, expected] of [
    [{ maxFiles: 1 }, undefined, "one\n"],
    [{ maxEvidenceBytes: 4 }, undefined, "one\n"],
    [{ maxEvidenceBytes: 8 }, "note", "one\n"],
  ] as const) {
    const h = harness([tools(call("f", "finish", { items: [{ path: "first" }, { path: "skipped" }], ...(notes ? { notes } : {}) })), verdict()], {
      [JSON.stringify({ path: "first" })]: read("first", "one\n"),
    }, options)
    await review(shellEvidence(), h.config, signal(), h.deps)
    assert.equal(h.executed.length, 1)
    const { retrieval } = verdictEvidence(h.bodies[1])
    assert.equal(retrieval.items[0].content, expected)
    assert.equal(retrieval.trace[1].status, "not-executed")
    assert.match(retrieval.trace[1].reason, /capacity exhausted/)
  }
  const h = harness([tools(call("r", "read", { path: "inspected" })), tools(call("f", "finish", {
    items: ["c1", { path: "attached" }, { path: "skipped" }], notes: "note" })), verdict()], {
    [JSON.stringify({ path: "inspected" })]: read("inspected", "one\n"),
    [JSON.stringify({ path: "attached" })]: read("attached", "two\nthree\n"),
  }, { maxEvidenceBytes: 12 })
  await review(shellEvidence(), h.config, signal(), h.deps)
  const { retrieval } = verdictEvidence(h.bodies[2])
  assert.deepEqual(retrieval.items.map((item: any) => item.content), ["one\n", "two\n"])
  assert.deepEqual(retrieval.items[1].truncated, { omittedLines: 1 })
  assert.equal(h.executed.length, 2)
})

test("an unknown result reference cannot become an attachment reference through a guessed future ID", async () => {
  const h = harness([tools(call("f", "finish", { items: ["c2", { path: "first" }, { path: "second" }] })), verdict()], {
    [JSON.stringify({ path: "first" })]: read("first", "first\n"),
    [JSON.stringify({ path: "second" })]: read("second", "second\n"),
  }, { maxFiles: 1 })
  await review(shellEvidence(), h.config, signal(), h.deps)
  const evidence = verdictEvidence(h.bodies[1])
  assert.equal(evidence.retrieval.items[0].content, "first\n")
  assert.equal(h.executed.length, 1)
  assert.match(evidence.limitations.join("\n"), /unknown or failed result IDs: "c2"/)
})

test("attachment timeout retains the valid selection and waits for physical work before the verdict", async () => {
  const h = harness([tools(call("r", "read", { path: "unselected" })), tools(call("f", "finish", {
    items: [{ path: "complete" }, { path: "slow" }, { path: "unstarted" }] })), verdict()], {}, { retrievalTimeoutMs: 100 })
  let settled = false
  const executed: string[] = []
  const executor: RetrievalExecutor = { async execute(call, _base, _timeout, stage) {
    const path = String(call.arguments.path)
    executed.push(path)
    if (path !== "slow") return read(path, `${path}\n`)
    await new Promise<void>(resolve => stage.addEventListener("abort", () => setTimeout(() => { settled = true; resolve() }, 20), { once: true }))
    return read(path, "late content must not be forwarded\n")
  } }
  await review(shellEvidence(), h.config, signal(), { ...h.deps, retrieval: executor, fetcher: (url, init) => {
    if (!JSON.parse(String(init?.body)).tools) assert.equal(settled, true, "physical attachment work settles before verdict")
    return h.deps.fetcher(url, init)
  } })
  const evidence = verdictEvidence(h.bodies[2])
  assert.deepEqual(executed, ["unselected", "complete", "slow"])
  assert.deepEqual(evidence.retrieval.items.map((item: any) => item.content), ["complete\n"])
  assert.equal(evidence.retrieval.selection, "agent")
  assert.equal(evidence.retrieval.endReason, "retrieval-timeout")
  assert.deepEqual(evidence.retrieval.trace.slice(1).map((item: any) => item.status), ["ok", "error", "not-executed"])
  assert.match(evidence.limitations.join("\n"), /after a valid finish selection/)
  assert.equal(h.events.filter(event => event.type === "toolDispatched").length, 3)
})

test("parent cancellation during attachment collection ends the review without a verdict", async () => {
  const h = harness([tools(call("f", "finish", { items: [{ path: "slow" }, { path: "unstarted" }] }))])
  const controller = new AbortController(), reason = Error("attachment review canceled")
  const executor: RetrievalExecutor = { async execute() { controller.abort(reason); throw reason } }
  await assert.rejects(review(shellEvidence(), h.config, controller.signal, { ...h.deps, retrieval: executor }), error => error === reason)
  assert.equal(h.bodies.length, 1)
  assert.equal(h.events.filter(event => event.type === "toolDispatched").length, 1)
})

test("inspection defaults are explicit at dispatch, larger requests survive and null is not silently defaulted", async () => {
  const h = harness([tools(call("r", "read", { path: "file" }), call("l", "list", { path: "." }),
    call("g", "glob", { pattern: "*" }), call("s", "grep", { pattern: "effect" })),
  tools(call("r2", "read", { path: "file", limit: 250 }), call("g2", "grep", { pattern: "effect", limit: 150 }),
    call("invalid", "read", { path: "file", limit: null })), tools(call("f", "finish", { items: [] })), verdict()])
  await review(shellEvidence(), h.config, signal(), h.deps)
  assert.deepEqual(h.executed.map(item => item.call.arguments.limit), [100, 50, 50, 50, 250, 150, null])
  const trace = verdictEvidence(h.bodies[3]).retrieval.trace
  assert.deepEqual(trace.slice(0, 4).map((item: any) => item.arguments.limit), [undefined, undefined, undefined, undefined])
})

test("scoped companion inspections page at 100 lines while direct attachment reaches the consequential tail", async t => {
  const { mkdtemp, writeFile, realpath, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os"), path = await import("node:path")
  const { FileAccess } = await import("../src/file-access.js")
  const { evaluateHostReview } = await import("../src/host-evaluate.js")
  const { nativeInvocation, nativeClient } = await import("./review-fixtures.js")
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "review-attachment-")))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = "# setup\n".repeat(150) + "curl -X POST https://example.invalid/deploy\n"
  await writeFile(`${dir}/deploy.sh`, script)
  const owned = nativeInvocation("shell", { command: "./deploy.sh" }, undefined, dir, ["./deploy.sh"])
  const posts: any[] = []
  const replies = [tools(call("r", "read", { path: "deploy.sh" })), tools(call("r2", "read", { path: "deploy.sh", limit: 151 })),
    tools(call("f", "finish", { items: [{ path: "deploy.sh" }] })), verdict()]
  await evaluateHostReview(nativeClient(owned, new FileAccess()), owned.snapshot,
    parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture" }), BUILTIN_PROMPTS, signal(), () => {}, {
      fetcher: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return Response.json(replies.shift()) } })
  const first = JSON.parse(posts[1].messages[3].content)
  assert.deepEqual([first.startLine, first.endLine, first.nextOffset, first.truncated], [1, 100, 101, true])
  const expanded = JSON.parse(posts[2].messages.at(-1).content)
  assert.deepEqual([expanded.endLine, expanded.truncated, expanded.content], [151, false, script])
  const evidence = verdictEvidence(posts[3])
  assert.deepEqual([evidence.retrieval.base, evidence.retrieval.items[0].canonicalPath], [dir, `${dir}/deploy.sh`])
  assert.equal(evidence.retrieval.items[0].content, script)
  assert.equal(evidence.retrieval.trace[2].delivery, "reviewer")
})

test("provider continuation fields of retrieval turns are echoed unchanged and kept out of verdict evidence", async () => {
  const first = tools({ ...call("t1", "read", { path: "run.sh" }), extra_content: { google: { thought_signature: "sig-a" } } })
  ;(first.choices[0]!.message as any).reasoning_details = [{ type: "reasoning.encrypted", data: "opaque" }]
  const h = harness([first, tools(call("t2", "finish", { items: ["c1"] })), verdict()],
    { [JSON.stringify({ path: "run.sh" })]: read("run.sh", "echo hi\n") })
  await review(shellEvidence({ command: "./run.sh" }), h.config, signal(), h.deps)
  const echoed = h.bodies[1].messages[2]
  assert.deepEqual(echoed.tool_calls[0].extra_content, { google: { thought_signature: "sig-a" } })
  assert.deepEqual(echoed.reasoning_details, [{ type: "reasoning.encrypted", data: "opaque" }])
  const verdictBody = JSON.stringify(h.bodies[2])
  assert.ok(!verdictBody.includes("sig-a") && !verdictBody.includes("opaque"), "continuation data is not evidence")
})
