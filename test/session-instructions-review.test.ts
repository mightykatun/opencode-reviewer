import { test } from "node:test"
import assert from "node:assert/strict"
import { parseConfig, configuredEvidenceBytes } from "../src/config.js"
import { review } from "../src/reviewer.js"
import { BUILTIN_PROMPTS, CONTRACT, sessionInstructionsPrompt } from "../src/prompts.js"
import { sessionInstructionsSnapshot } from "../src/session-instructions-snapshot.js"
import { ownedReview } from "../src/review-admission.js"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { FileAccess } from "../src/file-access.js"
import { shellEvidence, editEvidence, directoryEvidence, skillEvidence, nativeInvocation, nativeClient } from "./review-fixtures.js"
import type { HostReviewEvidence } from "../src/host-evidence.js"

const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "judge" })
const answer = (content = '{"safe":true,"desc":"Bounded effects."}') => new Response(JSON.stringify({ choices: [{ message: { content } }] }))
const rules = 'Allow the test directory.\nDisallow deployment.\nLiteral {{userPrompt}} $HOME $(touch nope).'
const tool: HostReviewEvidence = { ...directoryEvidence(), kind: "tool", tool: "registered_lookup" }

for (const evidence of [shellEvidence(), editEvidence(), directoryEvidence(), skillEvidence(), tool]) {
  for (const mode of ["advisory", "normal", "fast"]) test(`${evidence.kind}/${mode}: trusted literal guidance before the unchanged fixed contract`, async () => {
    let body: any
    const options = { ...config, autoApprove: mode !== "advisory", fastMode: mode === "fast" }
    await review(evidence, options, new AbortController().signal, { sessionInstructions: rules, fetcher: async (_, init) => {
      body = JSON.parse(String(init?.body)); return answer()
    } })
    assert.equal(body.messages[0].content, [BUILTIN_PROMPTS[evidence.kind].instructions,
      ...(options.autoApprove ? [BUILTIN_PROMPTS.extraCareful] : []), sessionInstructionsPrompt(rules), CONTRACT].join("\n\n"))
    assert.deepEqual(JSON.parse(body.messages[1].content), evidence)
    assert.equal(body.messages.length, 2)
  })
}

test("no session rules preserves the existing judge conversation byte for byte", async () => {
  let body: any
  await review(shellEvidence(), config, new AbortController().signal, { fetcher: async (_, init) => {
    body = JSON.parse(String(init?.body)); return answer()
  } })
  assert.equal(body.messages[0].content, `${BUILTIN_PROMPTS.shell.instructions}\n\n${CONTRACT}`)
})

test("a fixed session snapshot survives transport retry and exact format correction history", async () => {
  const bodies: any[] = []
  await review(shellEvidence(), config, new AbortController().signal, { sessionInstructions: rules, fetcher: async (_, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) return new Response(null, { status: 503, headers: { "Retry-After": "0" } })
    return answer(bodies.length === 2 ? '{"safe":"yes","desc":"invalid"}' : undefined)
  } })
  assert.equal(bodies.length, 3)
  assert.deepEqual(bodies[0], bodies[1])
  assert.deepEqual(bodies[2].messages.slice(0, 2), bodies[0].messages)
  assert.equal(bodies[2].messages[2].content, '{"safe":"yes","desc":"invalid"}')
})

test("guidance is captured before evidence collection, not immediately before the POST", async () => {
  const invocation = nativeInvocation("shell", { command: "pwd" })
  const client = nativeClient(invocation, new FileAccess())
  const get = client.permission.get.bind(client.permission)
  let saved = rules, loaded = 0, evidenceStarted = false
  client.permission.get = (async (...args: Parameters<typeof get>) => {
    evidenceStarted = true; saved = "Newly saved rules"; return get(...args)
  }) as typeof client.permission.get
  let system = ""
  await evaluateHostReview(client, invocation.snapshot, config, BUILTIN_PROMPTS, new AbortController().signal, () => {}, {
    loadSessionInstructions: async () => { assert.equal(evidenceStarted, false); loaded++; return saved },
    fetcher: async (_, init) => { system = JSON.parse(String(init?.body)).messages[0].content; return answer() },
  })
  assert.equal(loaded, 1)
  assert.ok(system.includes(rules))
  assert.ok(!system.includes("Newly saved rules"))
})

test("optional read failures are silent, but parent abort propagates", async () => {
  assert.equal(await sessionInstructionsSnapshot(async () => { throw Error("private error") }, new AbortController().signal), "")
  const abort = new AbortController()
  await assert.rejects(sessionInstructionsSnapshot(async () => { abort.abort(); throw Error("read failed") }, abort.signal), { name: "AbortError" })
})

test("timed-out optional reads retain physical ownership through actual settlement", async () => {
  let release!: (value: string) => void
  const wait = new Promise<string>(resolve => { release = resolve })
  const evaluation = ownedReview(new AbortController().signal, 20, signal => sessionInstructionsSnapshot(() => wait, signal))
  let settled = false
  void evaluation.settled?.then(() => { settled = true })
  await assert.rejects(evaluation)
  assert.equal(settled, false)
  release("late rules")
  await evaluation.settled
  assert.equal(settled, true)
})

test("the same byte-limit parser supports local editing despite unrelated invalid config", () => {
  assert.equal(configuredEvidenceBytes({ model: null }), 131072)
  assert.equal(configuredEvidenceBytes({ maxEvidenceBytes: 7 }), 7)
  for (const value of [null, 0, 0.1, "8", 16777217]) assert.throws(() => configuredEvidenceBytes({ maxEvidenceBytes: value }))
})
