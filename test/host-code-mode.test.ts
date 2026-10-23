import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { setupCompanion } from "../src/companion.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { readHostEvidence } from "../src/host-evidence-reader.js"
import { snapshotRequest } from "../src/host-request.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import { Controller } from "../src/controller.js"

const location = { directory: "/project" }, project = { id: "project", directory: "/project", canonical: "/project" }
const input = { code: 'return await Promise.all([tools.account.lookup({account:"A"}), tools.account.lookup({account:"B"})]);' }
const pending = { id: "permission-A", sessionID: "session", action: "account_lookup", resources: ["*"],
  source: { type: "tool", messageID: "assistant", id: "outer" } }
const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "judge", stream: false, notify: false })

async function fixture() {
  const life = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let handlers: any
  const state = { request: structuredClone(pending), epoch: "", registry: true, catalogReads: 0,
    afterCatalog: () => {}, transform: (value: any) => value,
    message: { id: "assistant", type: "assistant", content: [{ id: "outer", type: "tool", name: "execute", state: { status: "running", input } }] } }
  const server = { app: { version: "development" }, location: { ...location, project },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } },
      list: async () => {
        state.catalogReads++; state.afterCatalog()
        if (!state.registry) throw Error("private registry failure")
        return [{ id: "account_lookup", name: "lookup", description: "Read a public account.", input: { type: "object", properties: { account: { type: "string" } } },
          get execute(): never { return assert.fail("Executors must not be inspected") } }]
      } },
    rpc: { register: async (_definition: unknown, methods: any) => { handlers = methods; return { dispose() {} } } },
    permission: { get: async () => state.request }, session: { get: async () => ({ id: "session", projectID: project.id, location }) },
  }
  const handshake = await setupCompanion(server as unknown as Plugin.Context, life, {
    open: async () => assert.fail("Code Mode review must not inspect files"), realpath: async () => assert.fail("No filesystem reads"),
  })
  state.epoch = handshake.epoch
  const outer = { sessionID: "session", messageID: "assistant", id: "outer", tool: "execute", input }
  hooks.get("execute.before")!(outer)
  for (const account of ["A", "B"]) hooks.get("execute.before")!({ ...outer, tool: "account_lookup", input: { account } })
  const rpc = {
    handshake: async () => ({ ...handshake, epoch: state.epoch }),
    invocation: async (query: unknown, options: { signal: AbortSignal }) => handlers.invocation(query, options),
    evidence: async (query: unknown, options: { signal: AbortSignal }) => state.transform(await handlers.evidence(query, options)),
  }
  const client = { rpc: () => rpc, session: { ...server.session, message: { get: async () => state.message } },
    message: { list: async () => ({ data: [{ id: "user", type: "user", text: "Look up both public accounts." }], cursor: {} }) },
    permission: { get: async () => state.request, reply: () => assert.fail("Evaluator cannot write permissions") } } as unknown as OpenCodeClient
  const scope = { location, epoch: handshake.epoch }, snapshot = snapshotRequest(pending, scope)!
  return { life, state, hooks, outer, client, scope, snapshot }
}

for (const safe of [true, false]) test(`uncertain parallel MCP linkage reaches the judge and preserves ${safe ? "Safe" : "Unsafe"}`, async () => {
  const f = await fixture()
  try {
    let posts = 0
    const result = await evaluateHostReview(f.client, f.snapshot, config, BUILTIN_PROMPTS, f.life.signal, () => {}, {
      fetcher: async (_url, init) => {
        posts++
        const body = JSON.parse(String(init?.body)), evidence = JSON.parse(body.messages[1].content)
        assert.match(body.messages[0].content, /may decide Safe even when the inner call cannot be identified uniquely/)
        assert.equal(evidence.kind, "tool"); assert.equal(evidence.tool, "execute")
        assert.deepEqual(evidence.operation.input, input)
        assert.equal(evidence.permission.id, pending.id)
        assert.deepEqual(evidence.permission.resources, ["*"])
        assert.equal(evidence.userPrompt, "Look up both public accounts.")
        assert.equal(evidence.codeMode.linkage, "unverified")
        assert.equal(evidence.codeMode.observedCalls, 2)
        assert.equal(evidence.codeMode.omittedCalls, 0)
        assert.deepEqual(evidence.codeMode.candidates.map((value: any) => value.input), [{ account: "A" }, { account: "B" }])
        assert.ok(evidence.codeMode.candidates.every((value: any) => value.definition.id === "account_lookup"))
        assert.equal(evidence.definition, undefined, "No inner definition is presented as the outer executor")
        assert.ok(evidence.limitations.some((value: string) => /No candidate has been selected/.test(value)))
        return Response.json({ choices: [{ message: { content: JSON.stringify({ safe, desc: "Judge decision with linkage uncertainty." }) }, finish_reason: "stop" }] })
      },
    })
    assert.equal(result?.safe, safe); assert.equal(result?.metadata?.kind, "tool")
    assert.equal(posts, 1); assert.equal(f.state.catalogReads, 1)
  } finally { await f.life.stop() }
})

test("later and completed sibling candidates stay observations; absent definitions and omitted arguments do not veto review", async () => {
  const f = await fixture()
  try {
    f.state.registry = false
    f.hooks.get("execute.after")!({ ...f.outer, tool: "account_lookup" })
    f.hooks.get("execute.before")!({ ...f.outer, tool: "account_lookup", input: { account: "x".repeat(10000) } })
    const value = await readHostEvidence(f.client, f.scope, pending, { ...config, maxEvidenceBytes: 2048 }, f.life.signal)
    assert.ok(value?.result.status === "ready" && value.result.evidence.kind === "tool")
    const evidence = value.result.evidence
    assert.equal(evidence.codeMode?.observedCalls, 3)
    assert.equal(evidence.codeMode?.omittedCalls, 1)
    assert.deepEqual(evidence.codeMode?.candidates.map(value => value.input), [{ account: "A" }, { account: "B" }])
    assert.ok(evidence.limitations.some(value => /registry read failed/.test(value)))
    assert.doesNotMatch(JSON.stringify(evidence), /private registry failure/)
  } finally { await f.life.stop() }
})

for (const change of ["outer-input", "duplicate-outer", "permission", "epoch", "location", "settled-outer", "candidate-definition", "linkage", "counts", "native"])
  test(`Code Mode judge admission still rejects ${change}`, async () => {
    const f = await fixture()
    try {
      if (change === "outer-input") f.state.message.content[0]!.state.input = { code: "different" }
      if (change === "duplicate-outer") f.hooks.get("execute.before")!(f.outer)
      if (change === "permission") f.state.afterCatalog = () => { f.state.request = { ...pending, resources: ["changed"] } }
      if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
      if (change === "location") f.state.transform = value => ({ ...value, invocation: { ...value.invocation, location: { directory: "/wrong" } } })
      if (change === "settled-outer") f.state.afterCatalog = () => f.hooks.get("execute.after")!(f.outer)
      if (["candidate-definition", "linkage", "counts"].includes(change)) f.state.transform = value => {
        const evidence = value.result.evidence
        if (change === "candidate-definition") evidence.codeMode.candidates[0].definition.id = "wrong"
        if (change === "linkage") evidence.codeMode.linkage = "exact"
        if (change === "counts") evidence.codeMode.observedCalls = 0
        return value
      }
      if (change === "native") f.state.request = { ...pending, action: "shell" }
      const value = await readHostEvidence(f.client, f.scope, f.state.request, config, f.life.signal)
      assert.equal(value, undefined)
    } finally { await f.life.stop() }
  })

test("disabled registered-tool review skips candidate registry work", async () => {
  const f = await fixture()
  try {
    const value = await readHostEvidence(f.client, f.scope, pending, { ...config, reviewTools: false }, f.life.signal)
    assert.equal(value?.result.status, "disabled")
    assert.equal(f.state.catalogReads, 0)
  } finally { await f.life.stop() }
})

for (const safe of [true, false]) test(`the judge's ${safe ? "Safe" : "Unsafe"} verdict controls automatic eligibility despite ambiguous candidates`, async () => {
  const f = await fixture(), timers = new Set<() => void>(), writes: string[] = []
  const options = { ...config, autoApprove: true, autoApproveDelaySeconds: 0 }
  const controller = new Controller((_request, signal, identified) => evaluateHostReview(f.client, f.snapshot, options, BUILTIN_PROMPTS, signal, identified, {
    fetcher: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ safe, desc: "Decision with uncertainty." }) }, finish_reason: "stop" }] }),
  }), () => {}, {
    reviewOptions: options, candidate: () => true, nativeFront: () => pending.id, approvalReady: () => true,
    modes: { root: async () => "session", load: async () => {}, enabled: () => true },
    clock: { now: () => 0, after: (_ms, run) => { timers.add(run); return () => { timers.delete(run) } } },
    nativeApproval: { list: async () => [f.snapshot.request], once: async (request, _signal, dispatch) => {
      if (!dispatch()) return { status: "unavailable" }
      writes.push(request.id)
      controller.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
      return { status: "submitted" }
    } },
  })
  try {
    controller.asked(f.snapshot.request)
    await settle()
    assert.equal(controller.views[0]?.assessment?.safe, safe)
    for (const run of timers) run()
    await settle()
    assert.deepEqual(writes, safe ? [pending.id] : [])
    controller.refreshApprovalEligibility()
    await settle()
    assert.deepEqual(writes, safe ? [pending.id] : [], "No extra approval or ambiguity override")
  } finally { await controller.dispose(); await f.life.stop() }
})
