import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { collectHostOperation } from "../src/host-evidence.js"
import { FileAccess, type FileIO } from "../src/file-access.js"
import { parseConfig } from "../src/config.js"
import { readHostInvocation, snapshotRequest } from "../src/host-request.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"

const scope = { epoch: "10000000-1000-4000-8000-100000000000", location: { directory: "/server/project" } }
const project = { id: "project", directory: "/server", canonical: "/server" }
const raw = { id: "permission", sessionID: "session", action: "edit", resources: ["target.txt"], source: { type: "tool", messageID: "assistant", id: "call" },
  metadata: { files: [{ file: "target.txt", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } }
const input = { path: "target.txt", content: "new\n" }
const config = () => parseConfig({ baseURL: "http://127.0.0.1:40999/v1", model: "reviewer", stream: false, notify: false })

function fixture() {
  const snapshot = snapshotRequest(raw, scope)!
  const invocation = readHostInvocation({ sessionID: "session", assistantID: "assistant", callID: "call", tool: "write", input, ...scope, project })!
  const calls: string[] = [], posts: any[] = []
  const state = { missing: false, response: '{"safe":true,"desc":"A bounded isolated text replacement."}' }
  const io = new FileAccess({ open: async () => { throw Error("Edits must not read files") }, realpath: async () => { throw Error("Edits must not resolve files") } } as unknown as FileIO)
  const client = {
    rpc: () => ({
      handshake: async () => ({ protocol: 1, hostVersion: "2.0.26", ...scope, project }),
      invocation: async () => { calls.push("invocation"); return state.missing ? null : { request: raw, invocation } },
      evidence: async (query: any, { signal }: { signal: AbortSignal }) => {
        calls.push("evidence")
        return { request: raw, invocation, result: await collectHostOperation({ snapshot, invocation }, query.options, signal, io) }
      },
    }),
    session: { get: async () => ({ id: "session", projectID: project.id, location: scope.location }),
      message: { get: async () => ({ id: "assistant", type: "assistant", content: [{ id: "call", type: "tool", name: "write", state: { status: "running", input } }] }) } },
    message: { list: async () => ({ data: [{ id: "root-user", type: "user", text: "Update the isolated target.txt" }], cursor: {} }) },
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
  const data = JSON.parse(user.content)
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

test("disabled or missed-capture native evidence cannot identify or dispatch a reviewer POST", async () => {
  for (const missing of [false, true]) {
    const f = fixture()
    f.state.missing = missing
    let identified = false
    assert.equal(await evaluateHostReview(f.client, f.snapshot, { ...config(), reviewEdits: missing }, BUILTIN_PROMPTS,
      new AbortController().signal, () => { identified = true }, { fetcher: f.fetcher }), null)
    assert.equal(identified, false)
    assert.equal(f.posts.length, 0)
  }
})

test("native format correction retains byte-exact initial evidence and the failed assessment", async () => {
  const f = fixture()
  let posted = 0
  const fetcher: typeof fetch = async (_url, init) => {
    f.posts.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: posted++ ? '{"safe":true,"desc":"Bounded replacement."}' : "invalid assessment" }, finish_reason: "stop" }] })
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
