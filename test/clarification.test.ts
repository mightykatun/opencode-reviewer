import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import { parseConfig } from "../src/config.js"
import { askContext, clarificationEnabled, clarificationQuestions, sessionContextAsker, type ContextAsker } from "../src/clarification.js"
import { BUILTIN_PROMPTS, loadPrompts } from "../src/prompts.js"
import { review } from "../src/reviewer.js"
import inventory from "../src/prompt-files.json" with { type: "json" }
import type { JSONValue } from "../src/host-types.js"
import { shellEvidence } from "./review-fixtures.js"

const config = (options: Record<string, unknown> = {}) => parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", ...options })
const signal = () => new AbortController().signal
const location = { directory: "/fixture" }
const child = () => shellEvidence({ conversation: { current: { id: "child", parentID: "root", projectID: "project", location },
  root: { id: "root", projectID: "project", location }, rootMessageID: "user" } })

test("retrievalClarification defaults on, accepts only booleans, and is gated by retrieval and root conversations", () => {
  assert.equal(config().retrievalClarification, true)
  assert.equal(config({ retrievalClarification: false }).retrievalClarification, false)
  for (const value of ["yes", 1, null]) assert.throws(() => config({ retrievalClarification: value }), /retrievalClarification must be a boolean/)
  assert.equal(clarificationEnabled(config(), shellEvidence()), true)
  assert.equal(clarificationEnabled(config({ retrievalClarification: false }), shellEvidence()), false)
  assert.equal(clarificationEnabled(config({ retrieval: false }), shellEvidence()), false, "disabling retrieval disables clarification")
  assert.equal(clarificationEnabled(config({ retrievalKinds: { bash: false } }), shellEvidence()), false)
  assert.equal(clarificationEnabled(config(), child()), false, "subagent sessions are never asked")
})

test("questions are one nonempty trimmed string of at most 8 KiB", () => {
  assert.equal(clarificationQuestions({ questions: "  Why?  " }), "Why?")
  assert.equal(clarificationQuestions({ questions: "é".repeat(4096) }), "é".repeat(4096))
  const invalid: JSONValue[] = [null, "Why?", ["Why?"], {}, { questions: " " }, { questions: 1 }, { questions: "Why?", more: 1 }, { questions: "é".repeat(4097) }]
  for (const args of invalid) assert.equal(clarificationQuestions(args), undefined)
})

test("the session asker calls native generation with the bound session and the caller's signal", async () => {
  const calls: unknown[] = []
  const client = (result: unknown) => ({ session: { generate: async (input: unknown, options: unknown) => { calls.push([input, options]); return result } } }) as unknown as OpenCodeClient
  const abort = signal()
  assert.equal(await sessionContextAsker(client({ text: "answer" }), "ses_root").ask("prompt", abort), "answer")
  assert.deepEqual(calls, [[{ sessionID: "ses_root", prompt: "prompt" }, { signal: abort }]])
  for (const invalid of [null, {}, { text: 1 }]) await assert.rejects(sessionContextAsker(client(invalid), "ses_root").ask("prompt", signal()), /answer invalid/)
  const controller = new AbortController(), reason = Error("stop")
  controller.abort(reason)
  await assert.rejects(sessionContextAsker(client({ text: "late" }), "ses_root").ask("prompt", controller.signal), error => error === reason)
})

test("long answers keep exact leading lines, and the verdict reports every omitted line", async () => {
  const answer = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n")
  const asker: ContextAsker = { ask: async () => answer }
  const result = await askContext(asker, "template", shellEvidence(), "Why?", 20, signal())
  assert.deepEqual(result, { tool: "ask_context", questions: "Why?", status: "ok", content: "line 0\nline 1\n", truncated: { omittedLines: 8 } })
  assert.deepEqual(await askContext({ ask: async () => "x".repeat(30) }, "template", shellEvidence(), "Why?", 20, signal()),
    { tool: "ask_context", questions: "Why?", status: "error", reason: "answer exceeds the size limit" })

  // A forwarding budget smaller than the answer cuts it again and adds both omissions.
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })
  const replies = [{ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call("q", "ask_context", { questions: "Why?" })] }, finish_reason: "tool_calls" }] },
    { choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call("f", "finish", { items: ["c1"], notes: "0123456789" })] }, finish_reason: "tool_calls" }] },
    { choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ safe: false, reason: "Decisive reason.", desc: "Assessed." }) }, finish_reason: "stop" }] }]
  const bodies: any[] = []
  await review(shellEvidence(), config({ maxEvidenceBytes: 30 }), signal(), { clarification: asker, retrieval: { execute: async () => ({}) },
    fetcher: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json(replies.shift()) } })
  // The 30-byte result keeps 4 lines (6 omitted). Notes leave 20 bytes, which keep 2 more.
  const item = JSON.parse(bodies[2].messages[1].content).retrieval.items[0]
  assert.equal(item.content, "line 0\nline 1\n")
  assert.deepEqual(item.truncated, { omittedLines: 8 })
  assert.equal(Object.hasOwn(item, "endLine"), false, "an answer has no file line numbers")
})

test("the clarification prompt is a named built-in that a prompt directory can override", async t => {
  assert.equal(inventory.clarification, "prompts/CLARIFICATION-PROMPT.md")
  assert.match(BUILTIN_PROMPTS.clarification, /pendingOperation/)
  assert.doesNotMatch(BUILTIN_PROMPTS.clarification, /[;·—]/)
  const dir = await mkdtemp(path.join(tmpdir(), "review-clarification-prompt-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "CLARIFICATION-PROMPT.md"), "Custom clarification guidance.\n")
  const prompts = await loadPrompts(dir, signal())
  assert.equal(prompts.clarification, "Custom clarification guidance.")
  assert.equal(prompts.retrieval, BUILTIN_PROMPTS.retrieval)
})
