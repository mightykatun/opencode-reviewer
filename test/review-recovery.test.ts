import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import type { OpenCodeClient } from "@opencode/client"
import { Controller, visibleReview } from "../src/controller.js"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { collectHostOperation } from "../src/host-evidence.js"
import { FileAccess } from "../src/file-access.js"
import { snapshotRequest } from "../src/host-request.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"

const location = { directory: "/project/nested" }
const scope = { location, epoch: "10000000-1000-4000-8000-100000000000" }
const startupProject = { id: "global", directory: "/project", canonical: "/project" }

function fixture(child = false) {
  const sessionID = child ? "child" : "root"
  const raw = { id: "permission", sessionID, action: "external_directory", resources: ["/outside/*"],
    source: { type: "tool", messageID: "assistant", id: "call" } }
  const snapshot = snapshotRequest(raw, scope)!
  const invocation = { sessionID, assistantID: "assistant", callID: "call", tool: "read", input: { path: "/outside/file" },
    ...scope, project: startupProject }
  const state = { projectID: "global", canonical: "/project", registry: true, duplicate: false, foreign: false,
    changed: false, invalid: false, missing: false, permission: raw, epoch: scope.epoch }
  const posts: any[] = [], calls: string[] = []
  const files = new FileAccess({ open: async () => { assert.fail("No filesystem evidence needed") },
    realpath: async () => { assert.fail("Do not rediscover or initialize a project") } })
  const client = {
    rpc: () => ({
      handshake: async () => ({ protocol: 1, hostVersion: "development", ...scope, epoch: state.epoch, project: startupProject }),
      invocation: async () => state.missing ? null : { request: raw, invocation },
      evidence: async (query: any, options: { signal: AbortSignal }) => {
        const result = await collectHostOperation({ snapshot, invocation }, query.options, options.signal, files)
        if (state.changed) state.projectID = "changed-project"
        return { request: raw, invocation, result: state.invalid && result.status === "ready"
          ? { ...result, evidence: { ...result.evidence, tool: "other" } } : result }
      },
    }),
    project: { list: async () => {
      calls.push("project.list")
      const entry = { id: state.projectID, canonical: state.foreign ? "/foreign" : state.canonical }
      return state.registry ? [entry, ...(state.duplicate ? [entry] : [])] : []
    } },
    worktree: { list: async () => { calls.push("worktree.list"); return [] } },
    session: {
      get: async ({ sessionID: id }: { sessionID: string }) => ({ id, projectID: state.projectID, location,
        ...(id === "child" ? { parentID: "root" } : {}) }),
      message: { get: async () => ({ id: "assistant", type: "assistant", content: [
        { type: "tool", id: "call", name: "read", state: { status: "running", input: invocation.input } },
      ] }) },
    },
    message: { list: async () => ({ data: [{ id: "user", type: "user", text: "Inspect the requested file." }], cursor: {} }) },
    permission: { get: async () => state.permission, reply: () => assert.fail("No permission writes in evaluator tests") },
  }
  const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", notify: false })
  const evaluate = (identify = () => {}) => evaluateHostReview(client as unknown as OpenCodeClient, snapshot, config,
    BUILTIN_PROMPTS, new AbortController().signal, identify, { fetcher: async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: '{"safe":false,"desc":"Synthetic assessment."}' } }] })
    } })
  return { client, state, posts, calls, evaluate, snapshot }
}

for (const child of [false, true]) test(`project reassignment preserves exact ${child ? "descendant" : "root"} evidence and reviews`, async () => {
  const f = fixture(child)
  assert.equal((await f.evaluate())?.safe, false)
  assert.deepEqual(f.calls, [], "Matching project IDs require no registry reads")
  f.state.projectID = "git-project"
  const result = await f.evaluate()
  assert.equal(result?.safe, false)
  const evidence = JSON.parse(f.posts[1].messages[1].content)
  assert.deepEqual(evidence.project, { id: "git-project", directory: "/project", canonical: "/project" })
  assert.deepEqual(evidence.location, location)
  assert.equal(evidence.permission.sessionID, child ? "child" : "root")
  assert.deepEqual(evidence.operation.input, { path: "/outside/file" })
  assert.equal(evidence.conversation.root.id, "root")
  assert.ok(evidence.limitations.some((reason: string) => /registered project/.test(reason)))
})

for (const failure of ["missing", "duplicate", "foreign", "changed", "invalid"] as const)
  test(`project repair remains manual for ${failure} metadata/evidence`, async () => {
    const f = fixture()
    f.state.projectID = "git-project"
    if (failure === "missing") f.state.registry = false
    else f.state[failure] = true
    let identified = false
    await f.evaluate(() => { identified = true }).catch(() => {})
    assert.equal(identified, false)
    assert.equal(f.posts.length, 0)
  })

test("an operational evidence error is visible without review or approval, including after mode retry", async () => {
  const f = fixture()
  f.state.projectID = "git-project"; f.state.registry = false
  const controller = new Controller((_request, _signal, identify) => f.evaluate(identify), () => {}, {
    candidate: () => true, nativeFront: () => "permission", session: id => ({ id }),
    modes: { root: async () => "root", load: async () => {}, enabled: () => true },
  })
  try {
    controller.asked(f.snapshot.request)
    await tick(); await tick()
    assert.equal(controller.views[0]?.status, "unidentified")
    assert.equal(visibleReview(controller.views, "root", id => ({ id }), () => "permission")?.request.id, "permission")
    assert.equal(f.posts.length, 0)
    controller.modeChanged("root")
    f.state.registry = true
    controller.reconcile([f.snapshot.request], controller.revision)
    await tick(); await tick()
    assert.equal(controller.views[0]?.status, "complete")
    assert.equal(f.posts.length, 1)
  } finally { await controller.dispose() }
})
