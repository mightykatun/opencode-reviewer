import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { collectHostOperation } from "../src/host-evidence.js"
import { FileAccess, type FileIO } from "../src/file-access.js"
import { parseConfig } from "../src/config.js"
import { readHostInvocation, snapshotRequest } from "../src/host-request.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import type { ReviewAttemptEvent } from "../src/types.js"
import type { SteeringRecord } from "../src/steering-follow-up.js"

const scope = { epoch: "10000000-1000-4000-8000-100000000000", location: { directory: "/server/project" } }
const project = { id: "project", directory: "/server", canonical: "/server" }
const raw = { id: "permission", sessionID: "session", action: "edit", resources: ["target.txt"], source: { type: "tool", messageID: "assistant", id: "call" },
  metadata: { files: [{ file: "target.txt", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } }
const input = { path: "target.txt", content: "new\n" }
const config = () => parseConfig({ baseURL: "http://127.0.0.1:40999/v1", model: "reviewer", stream: false, notify: false, retrieval: false })

function fixture() {
  const snapshot = snapshotRequest(raw, scope)!
  const invocation = readHostInvocation({ sessionID: "session", assistantID: "assistant", callID: "call", tool: "write", input, ...scope, project })!
  const calls: string[] = [], posts: any[] = []
  const state = { missing: false, invalidEvidence: false, response: '{"safe":true,"reason":"Decisive reason.","desc":"A bounded isolated text replacement."}' }
  const io = new FileAccess({ open: async () => { throw Error("Edits must not read files") }, realpath: async () => { throw Error("Edits must not resolve files") } } as unknown as FileIO)
  const client = {
    rpc: () => ({
      handshake: async () => ({ protocol: 2, hostVersion: "2.0.26", ...scope, project }),
      invocation: async () => { calls.push("invocation"); return state.missing ? null : { request: raw, invocation } },
      evidence: async (query: any, { signal }: { signal: AbortSignal }) => {
        calls.push("evidence")
        const result = await collectHostOperation({ snapshot, invocation }, query.options, signal, io)
        return { request: raw, invocation, result: state.invalidEvidence && result.status === "ready"
          ? { ...result, evidence: { ...result.evidence, kind: "shell" } } : result }
      },
    }),
    session: { get: async () => ({ id: "session", projectID: project.id, location: scope.location }),
      message: { get: async () => ({ id: "assistant", type: "assistant", content: [{ id: "call", type: "tool", name: "write", state: { status: "running", input } }] }) } },
    message: { list: async () => ({ data: [{ id: "root-user", type: "user", text: "Update the isolated target.txt" },
      { id: "earlier-user", type: "user", text: "Only touch files inside /server/project." }], cursor: {} }) },
    permission: { get: async () => raw, reply: async () => { throw Error("Advisory evaluation cannot write a permission reply") } },
  }
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push("POST")
    posts.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { role: "assistant", content: state.response }, finish_reason: "stop" }] })
  }
  return { client: client as unknown as OpenCodeClient, snapshot, calls, posts, state, fetcher }
}

test("native evaluation sends exact V2 evidence as data under the correct guidance, not a fabricated legacy request", async () => {
  const f = fixture(), events: string[] = []
  const result = await evaluateHostReview(f.client, f.snapshot, config(), BUILTIN_PROMPTS, new AbortController().signal,
    () => { events.push("identified") }, { fetcher: f.fetcher })
  assert.equal(result?.safe, true)
  assert.deepEqual(events, ["identified"])
  assert.deepEqual(f.calls, ["invocation", "evidence", "POST"])
  const [system, user] = f.posts[0].messages
  assert.match(system.content, /permission\.action="edit"/)
  assert.match(system.content, /conversation\.root/)
  assert.match(system.content, /earlierUserPrompts holds the same conversation's earlier root-user messages, oldest first/)
  assert.match(system.content, /the latest prompt wins every conflict/)
  const data = JSON.parse(user.content)
  assert.deepEqual(data.earlierUserPrompts, [{ text: "Only touch files inside /server/project." }])
  assert.equal(data.permission.action, "edit")
  assert.deepEqual(data.permission.resources, ["target.txt"])
  assert.deepEqual(data.permission.source, { assistantID: "assistant", id: "call" })
  assert.equal(data.permission.type, undefined)
  assert.equal(data.permission.patterns, undefined)
  assert.equal(data.userPrompt, "Update the isolated target.txt")
  assert.equal(data.operation.input.path, "target.txt")
  assert.equal(data.changes[0].patch, raw.metadata.files[0]!.patch)
  assert.equal(data.session, undefined)
  assert.equal(data.location.directory, scope.location.directory)
})

test("disabled evidence skips review while missed capture stays visibly unavailable without a model POST", async () => {
  for (const missing of [false, true]) {
    const f = fixture()
    f.state.missing = missing
    let identified = false, observed = false
    const evaluation = evaluateHostReview(f.client, f.snapshot, { ...config(), reviewEdits: missing }, BUILTIN_PROMPTS,
      new AbortController().signal, () => { identified = true }, { fetcher: f.fetcher,
        observeEvidence: () => { observed = true; return { review: "must-not-exist" } } })
    if (missing) await assert.rejects(evaluation, /Exact operation evidence unavailable/)
    else assert.equal(await evaluation, null)
    assert.equal(identified, false)
    assert.equal(observed, false)
    assert.equal(f.posts.length, 0)
  }
})

test("native accounting observation is created after ready evidence validation and keeps exact execution identity", async () => {
  const f = fixture(), attempts: ReviewAttemptEvent[] = []
  const result = await evaluateHostReview(f.client, f.snapshot, config(), BUILTIN_PROMPTS, new AbortController().signal,
    () => { f.calls.push("identified") }, { fetcher: f.fetcher, observeEvidence: evidence => {
      f.calls.push("observation")
      assert.equal(evidence.kind, "edit")
      assert.deepEqual(evidence.permission.source, { assistantID: "assistant", id: "call" })
      assert.equal(evidence.userPrompt, "Update the isolated target.txt")
      return { review: "controller-execution", observe: event => { attempts.push(event) } }
    } })
  assert.deepEqual(f.calls, ["invocation", "evidence", "identified", "observation", "POST"])
  assert.equal(result?.metadata?.review, "controller-execution")
  assert.equal(result?.metadata?.kind, "edit")
  assert.deepEqual(attempts.map(event => [event.type, event.review]), [
    ["dispatched", "controller-execution"], ["finalized", "controller-execution"],
  ])
  assert.equal(f.posts[0].messages.some((message: any) => message.content.includes("controller-execution")), false)
})

test("invalid native evidence never creates an accounting observation", async () => {
  const f = fixture()
  f.state.invalidEvidence = true
  let observed = false, identified = false
  await assert.rejects(evaluateHostReview(f.client, f.snapshot, config(), BUILTIN_PROMPTS, new AbortController().signal,
    () => { identified = true }, { fetcher: f.fetcher, observeEvidence: () => { observed = true; return { review: "invalid" } } }),
    /Exact operation evidence unavailable/)
  assert.equal(identified, false)
  assert.equal(observed, false)
  assert.equal(f.posts.length, 0)
})

for (const behavior of ["factory-throw", "observer-throw", "observer-reject"] as const)
  test(`native accounting ${behavior} cannot change the assessment`, async () => {
    const f = fixture()
    const result = await evaluateHostReview(f.client, f.snapshot, config(), BUILTIN_PROMPTS, new AbortController().signal,
      () => {}, { fetcher: f.fetcher, observeEvidence: () => {
        if (behavior === "factory-throw") throw Error("observational setup failure")
        return { review: "execution", observe: () => {
          if (behavior === "observer-throw") throw Error("observational delivery failure")
          return Promise.reject(Error("observational delivery failure"))
        } }
      } })
    assert.equal(result?.safe, true)
    assert.equal(result?.desc, "A bounded isolated text replacement.")
    assert.equal(f.posts.length, 1)
  })

test("native format correction retains byte-exact initial evidence and the failed assessment", async () => {
  const f = fixture()
  let posted = 0
  const fetcher: typeof fetch = async (_url, init) => {
    f.posts.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: posted++ ? '{"safe":true,"reason":"Decisive reason.","desc":"Bounded replacement."}' : "invalid assessment" }, finish_reason: "stop" }] })
  }
  assert.equal((await evaluateHostReview(f.client, f.snapshot, config(), BUILTIN_PROMPTS, new AbortController().signal, () => {}, { fetcher }))?.safe, true)
  assert.equal(f.posts.length, 2)
  assert.equal(f.posts[1].messages[1].content, f.posts[0].messages[1].content)
  assert.deepEqual(f.posts[1].messages[2], { role: "assistant", content: "invalid assessment" })
})

test("pre-dispatch cancellation starts no native evidence read, and late reviewer response remains physically owned", async () => {
  const f = fixture(), abort = new AbortController()
  abort.abort()
  await assert.rejects(evaluateHostReview(f.client, f.snapshot, config(), BUILTIN_PROMPTS, abort.signal, () => {}, { fetcher: f.fetcher }))
  assert.deepEqual(f.calls, [])
  let dispatched!: () => void, resolve!: (response: Response) => void, canceled = false
  const started = new Promise<void>(yes => { dispatched = yes }), live = new AbortController()
  const evaluation = evaluateHostReview(f.client, f.snapshot, config(), BUILTIN_PROMPTS, live.signal, () => {}, {
    fetcher: async () => { dispatched(); return new Promise(yes => { resolve = yes }) },
  })
  await started
  live.abort()
  await assert.rejects(evaluation)
  let settled = false
  const cleanup = evaluation.settled!.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  resolve(new Response(new ReadableStream({ cancel() { canceled = true } })))
  await cleanup
  assert.equal(canceled, true)
})

test("a paired steering reaches only the verdict, and a category mismatch or newer root prompt sends none", async () => {
  const steering: SteeringRecord = { sessionID: "session", assistantID: "earlier", callID: "rejected", message: "Rejected by opencode-reviewer: Too broad.",
    rejected: { category: "edit", tool: "write", input: { path: "all.txt" } }, root: true, rootMessageID: "root-user" }
  const run = async (record: SteeringRecord, retrieval = false) => {
    const f = fixture(), client = f.client as any, list = client.message.list
    client.message.list = async (query: any) => query.type === "assistant" ? { data: [
      { id: "assistant", type: "assistant", content: [{ type: "text", text: "I will write only target.txt." }, { id: "call", type: "tool", name: "write", state: { status: "running", input } }] },
      { id: "earlier", type: "assistant", content: [{ id: "rejected", type: "tool", name: "write", state: { status: "error", input: { path: "all.txt" } } }] }], cursor: {} } : list(query)
    let posts = 0, retrievalPosts = 0
    const fetcher: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.tools) {
        retrievalPosts++
        assert.doesNotMatch(String(init?.body), /steeringFollowUp|Too broad/, "retrieval never sees the follow-up")
        return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `f${posts++}`, type: "function",
          function: { name: "finish", arguments: '{"items":[]}' } }] }, finish_reason: "tool_calls" }] })
      }
      return f.fetcher(url, init)
    }
    const value = parseConfig({ baseURL: "http://127.0.0.1:40999/v1", model: "reviewer", stream: false, notify: false, retrieval, retrievalKinds: { edit: true }, autoRejectSteering: true })
    await evaluateHostReview(f.client, f.snapshot, value, BUILTIN_PROMPTS, new AbortController().signal, () => {}, { fetcher, steeringRecord: record })
    assert.equal(retrievalPosts > 0, retrieval)
    const [system, user] = f.posts.at(-1).messages
    return { system: system.content as string, evidence: JSON.parse(user.content) }
  }
  for (const retrieval of [false, true]) {
    const { system, evidence } = await run(steering, retrieval)
    assert.match(system, /steeringFollowUp is context for a previously rejected request/)
    assert.deepEqual(evidence.steeringFollowUp, { steeringMessage: steering.message, rejectedOperation: steering.rejected,
      agentOutput: [{ type: "text", text: "I will write only target.txt." }] })
  }
  for (const record of [{ ...steering, rejected: { ...steering.rejected, category: "shell" } } satisfies SteeringRecord, { ...steering, rootMessageID: "older-user" }]) {
    const { system, evidence } = await run(record)
    assert.doesNotMatch(system, /steeringFollowUp/)
    assert.equal(evidence.steeringFollowUp, undefined)
  }
})
