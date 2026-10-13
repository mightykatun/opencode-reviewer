import assert from "node:assert/strict"
import { test } from "node:test"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS, CONTRACT, CORRECTION } from "../src/prompts.js"
import { skillEvidence } from "./review-fixtures.js"

for (const stream of [false, true]) test(`native skill review selects its own guidance and retains exact data through corrections (stream=${stream})`, async () => {
  const evidence = skillEvidence(), bodies: any[] = []
  const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "reviewer", stream, autoApprove: true,
    formatRetries: 1, notify: false })
  const fetcher = (async (_url, options) => {
    const body = JSON.parse(String(options?.body)); bodies.push(body)
    const content = bodies.length === 1 ? '{"safe":"yes","desc":"Invalid"}' : '{"safe":true,"desc":"Routine skill loading."}'
    return stream ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } })
      : new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }))
  }) as typeof fetch
  const result = await review(evidence, config, new AbortController().signal, { fetcher })
  assert.equal(result.safe, true); assert.equal(result.metadata?.kind, "skill")
  assert.equal(bodies.length, 2)
  assert.ok(bodies[0].messages[0].content.includes(BUILTIN_PROMPTS.skill.instructions))
  assert.ok(bodies[0].messages[0].content.includes(CONTRACT))
  assert.ok(bodies[0].messages[0].content.includes(BUILTIN_PROMPTS.extraCareful))
  assert.deepEqual(JSON.parse(bodies[0].messages[1].content), evidence)
  assert.deepEqual(bodies[1].messages.slice(0, 2), bodies[0].messages)
  assert.equal(bodies[1].messages[2].content, '{"safe":"yes","desc":"Invalid"}')
  assert.ok(bodies[1].messages[3].content.includes(CORRECTION.split("{{validationError}}")[0]!))
  assert.doesNotMatch(bodies[0].messages[0].content, /permission\.action="shell"|kind="edit"/)
})
