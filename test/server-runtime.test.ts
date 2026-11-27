import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { createServer } from "node:http"
import { DecisionLedger, decisionKey } from "../src/decision-ledger.js"
import { setupServerRuntime, type ServerRuntime, type ServerRuntimeDependencies } from "../src/server-runtime.js"

const location = { directory: "/server/project" }
const project = { id: "project", directory: "/server/project", canonical: "/server/project" }
const serverPolicy = { baseURL: "http://127.0.0.1:1/v1", model: "judge", autoApprove: true, autoApproveDelaySeconds: 0 }

/** A fake hosting server and plugin context around one location. */
function fakeHost() {
  const handlers: Record<string, any> = {}
  const pending: any[] = []
  const hooks = new Map<string, (event: any) => void>()
  const events: any[] = []
  let wake: (() => void) | undefined
  const push = (event: any) => { events.push(event); wake?.() }
  const replies: any[] = []
  const sessions = new Map<string, any>([["ses_root", { id: "ses_root", location, projectID: project.id }]])
  /** Assistant messages by ID, in the public message.get shape with running tool parts. */
  const messages = new Map<string, any>()
  const ctx = {
    app: { version: "2.4.1", channel: "latest" },
    location: { ...location, project },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } }, list: async () => [] },
    skill: { list: async () => ({ location, data: [] }) },
    model: { list: async () => ({ location, data: [] }) },
    provider: { list: async () => ({ location, data: [] }) },
    rpc: { register: async (definition: { id: string }, value: Record<string, unknown>) => { handlers[definition.id] = value; return { dispose() {}, events: { emit: async () => {} } } } },
    permission: {
      get: async ({ requestID }: { requestID: string }) => { const found = pending.find(item => item.id === requestID); if (!found) throw new Error("Permission request not found"); return found },
      list: async ({ sessionID }: { sessionID: string }) => pending.filter(item => item.sessionID === sessionID),
      reply: async (input: any) => { replies.push(input); const index = pending.findIndex(item => item.id === input.requestID); if (index < 0) throw new Error("Permission request not found"); pending.splice(index, 1) },
    },
    session: { get: async ({ sessionID }: { sessionID: string }) => { const found = sessions.get(sessionID); if (!found) throw new Error("Session not found"); return found } },
    event: { subscribe: (options: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() {
      let index = 0
      while (!options.signal.aborted) {
        if (index < events.length) { yield events[index++]; continue }
        await new Promise<void>(resolve => { wake = resolve; options.signal.addEventListener("abort", () => resolve(), { once: true }) })
      }
    } }) },
  } as unknown as Plugin.Context
  const call = { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => { throw Object.assign(new Error(message), { type, data }) } }
  const client = {
    server: { info: async () => ({ version: "2.4.1", pid: process.pid, urls: ["http://fake"], paths: { tmp: "/tmp" } }) },
    rpc: (definition: { id: string }) => ({ identity: async () => handlers[definition.id].identity({}, call) }),
    permission: { request: { list: async () => ({ location, data: pending.map(item => ({ ...item })) }) } },
    session: { get: ctx.session.get, message: { get: async ({ messageID }: { messageID: string }) => { const found = messages.get(messageID); if (!found) throw new Error("no message"); return found } } },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }
  return { ctx, handlers, pending, hooks, push, replies, client, call, sessions, messages }
}

async function runtimeFixture(t: { after(fn: () => unknown): void }, options: { policy?: object; hosting?: boolean; ledger?: (dir: string) => ServerRuntimeDependencies["ledger"] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-server-runtime-"))
  chmodSync(dir, 0o700)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const policy = path.join(dir, "opencode-reviewer.json")
  if (options.policy) await writeFile(policy, JSON.stringify(options.policy), { mode: 0o600 })
  const host = fakeHost()
  const life = new PluginLifecycle()
  t.after(() => life.stop())
  let runtime!: ServerRuntime
  await life.start(async () => {
    runtime = await setupServerRuntime(host.ctx, life, { policyFile: policy, registrationFile: path.join(dir, "service.json"), stateRoot: dir, ledger: options.ledger ? options.ledger(dir) : null, accounting: null,
      hosting: { discover: async () => options.hosting === false ? undefined : { url: "http://fake", auth: undefined }, makeClient: () => host.client as never, pid: process.pid } })
  })
  return { ...host, runtime, life, policy, dir }
}

const until = async (what: string, check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error("Timeout: " + what); await sleep(20) }
}

test("without a policy file the server identifies itself but reviews nothing", async t => {
  const fixture = await runtimeFixture(t)
  const snapshot = fixture.runtime.snapshot()
  assert.deepEqual(snapshot.review, { enabled: false, reason: "no-policy" })
  assert.equal(snapshot.hosting.status, "verified")
  assert.equal(fixture.runtime.engine(), undefined)
  const identity = await fixture.handlers["opencode-reviewer"].identity({}, fixture.call)
  assert.equal(identity.nonce, fixture.runtime.nonce)
  assert.equal(identity.pid, process.pid)
  assert.deepEqual(Object.keys(fixture.handlers), ["opencode-reviewer"], "the reviewer RPC is the only public surface")
})

test("an unverified hosting service keeps a valid policy manual with the hosting reason", async t => {
  const fixture = await runtimeFixture(t, { policy: { server: serverPolicy }, hosting: false })
  assert.deepEqual(fixture.runtime.snapshot().review, { enabled: false, reason: "hosting" })
  assert.equal(fixture.runtime.engine(), undefined)
  assert.equal(fixture.runtime.snapshot().hosting.status, "unavailable")
})

test("without a decision ledger the engine is advisory and the snapshot says why", async t => {
  const fixture = await runtimeFixture(t, { policy: { server: { ...serverPolicy, autoApprove: true, autoRejectSteering: true, fastMode: true } } })
  assert.ok(fixture.runtime.engine())
  assert.deepEqual(fixture.runtime.snapshot().automation, { autoApprove: false, autoRejectSteering: false, fastMode: false, unavailable: "ledger" })
  await writeFile(fixture.policy, JSON.stringify({ server: { ...serverPolicy, autoApprove: false, autoRejectSteering: false } }), { mode: 0o600 })
  await until("advisory policy", () => fixture.runtime.snapshot().automation?.autoApprove === false && fixture.runtime.snapshot().automation?.unavailable === undefined)
  assert.deepEqual(fixture.runtime.snapshot().automation, { autoApprove: false, autoRejectSteering: false, fastMode: false }, "an advisory policy loses nothing")
})

test("a valid policy starts one engine per server generation and tui edits leave it alone", async t => {
  const fixture = await runtimeFixture(t, { policy: { server: serverPolicy, tui: { notify: false } } })
  const first = fixture.runtime.engine()
  assert.ok(first, "engine created for a valid policy on a verified service")
  assert.deepEqual(fixture.runtime.snapshot().review, { enabled: true })
  assert.equal((fixture.runtime.snapshot().tui as { notify: boolean }).notify, false)
  assert.equal("notificationSoundDirectory" in (fixture.runtime.snapshot().tui as object), true)
  assert.equal((fixture.runtime.snapshot().tui as { notificationSoundDirectory?: string }).notificationSoundDirectory, undefined)
  await writeFile(fixture.policy, JSON.stringify({ server: serverPolicy, tui: { notify: true } }), { mode: 0o600 })
  await until("tui change", () => (fixture.runtime.snapshot().tui as { notify: boolean })?.notify === true)
  assert.equal(fixture.runtime.engine(), first, "a tui-only edit does not replace the engine")
  await writeFile(fixture.policy, JSON.stringify({ server: { ...serverPolicy, autoApprove: false }, tui: { notify: true } }), { mode: 0o600 })
  await until("server change", () => fixture.runtime.engine() !== undefined && fixture.runtime.engine() !== first)
  assert.notEqual(fixture.runtime.engine()!.generation, first.generation)
  await rm(fixture.policy)
  await until("policy removed", () => fixture.runtime.engine() === undefined)
  assert.deepEqual(fixture.runtime.snapshot().review, { enabled: false, reason: "no-policy" })
})

test("pending permissions reach the controller with per-session heads, and controls name the attempt", async t => {
  const fixture = await runtimeFixture(t, { policy: { server: { ...serverPolicy, autoApprove: false } } })
  const request = (id: string, call: string) => ({ id, sessionID: "ses_root", action: "shell", resources: ["echo " + id], save: ["echo *"],
    source: { type: "tool", messageID: "msg_1", id: call } })
  fixture.pending.push(request("per_1", "call_1"), request("per_2", "call_2"))
  fixture.push({ type: "permission.asked", location, data: fixture.pending[0] })
  await until("views", () => fixture.runtime.snapshot().views.length === 2)
  const views = fixture.runtime.snapshot().views
  assert.deepEqual(views.map(item => item.head), [true, false], "only the first request of the session is its head")
  await until("unidentified without a capture", () => fixture.runtime.snapshot().views.every(item => (item.view as { status: string }).status === "unidentified"))
  const control = fixture.handlers["opencode-reviewer"].control
  assert.deepEqual(await control({ sessionID: "ses_root", permissionID: "per_1", attempt: "stale", action: "cancel" }), { result: "late" })
  assert.deepEqual(await control({ sessionID: "ses_root", permissionID: "per_9", attempt: "x", action: "cancel" }), { result: "unavailable" })
  assert.equal(fixture.replies.length, 0, "advisory policy never writes")
  // A native resolution of a foreign location is ignored, one at this location removes the view.
  fixture.push({ type: "permission.replied", location: { directory: "/elsewhere" }, data: { sessionID: "ses_root", requestID: "per_1", reply: "once" } })
  await sleep(100)
  assert.equal(fixture.runtime.snapshot().views.length, 2)
  fixture.pending.shift()
  fixture.push({ type: "permission.replied", location, data: { sessionID: "ses_root", requestID: "per_1", reply: "once" } })
  await until("removed", () => fixture.runtime.snapshot().views.length === 1)
  assert.equal(fixture.runtime.snapshot().views[0]!.head, true, "the remaining request became its session's head")
})

test("ledger rows from an earlier generation keep their requests manual while fresh requests still dispatch once", async t => {
  // A loopback judge: every verdict is Safe.
  const posts: string[] = []
  const judge = createServer((req, res) => {
    let text = ""
    req.on("data", chunk => { text += chunk })
    req.on("end", () => {
      posts.push(JSON.parse(text).messages.at(-1).content)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true, reason: "Fine.", desc: "Prints text." }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise<void>(resolve => judge.listen(0, "127.0.0.1", () => resolve()))
  t.after(() => judge.close())
  const baseURL = `http://127.0.0.1:${(judge.address() as { port: number }).port}/v1`
  let ledger!: DecisionLedger
  const fixture = await runtimeFixture(t, {
    policy: { server: { ...serverPolicy, baseURL, stream: false, retrieval: false } },
    ledger: dir => {
      ledger = DecisionLedger.open(dir)
      // A spent reservation and a durable cancel from a previous owner.
      ledger.observe(decisionKey(location, "ses_spent", "per_spent"), "previous-owner")
      ledger.fingerprint(decisionKey(location, "ses_spent", "per_spent"), "previous-owner", "fingerprint-spent")
      ledger.reserve(decisionKey(location, "ses_spent", "per_spent"), "previous-owner", "fingerprint-spent")
      ledger.sent(decisionKey(location, "ses_spent", "per_spent"))
      ledger.cancel(decisionKey(location, "ses_cancelled", "per_cancelled"), "previous-owner", "fingerprint-cancelled")
      return ledger
    },
  })
  const request = (session: string, id: string) => ({ id, sessionID: session, action: "shell", resources: [`echo ${id}`], save: ["echo *"],
    source: { type: "tool", messageID: `msg_${session}`, id: `call_${id}` } })
  for (const [session, id] of [["ses_spent", "per_spent"], ["ses_cancelled", "per_cancelled"], ["ses_fresh", "per_fresh"]] as const) {
    fixture.sessions.set(session, { id: session, location, projectID: project.id })
    fixture.messages.set(`msg_${session}`, { id: `msg_${session}`, type: "assistant", content: [{ type: "tool", id: `call_${id}`, name: "shell", state: { status: "running", input: { command: `echo ${id}` } } }] })
    fixture.hooks.get("execute.before")!({ sessionID: session, messageID: `msg_${session}`, id: `call_${id}`, tool: "shell", input: { command: `echo ${id}` } })
    fixture.pending.push(request(session, id))
  }
  // Every birth is observed through the native event stream. Only this runtime may dispatch them.
  for (const request of fixture.pending) fixture.push({ type: "permission.asked", location, data: request })
  await until("fresh dispatch", () => fixture.replies.length === 1, 15000)
  assert.deepEqual(fixture.replies.map(reply => [reply.requestID, reply.decision]), [["per_fresh", "once"]])
  await until("every review complete", () => fixture.runtime.snapshot().views.filter(item => (item.view as { status: string }).status === "complete").length >= 2, 15000)
  await sleep(500)
  assert.equal(fixture.replies.length, 1, "spent and cancelled requests never dispatch again")
  const status = (id: string) => fixture.runtime.snapshot().views.find(item => (item.view as { request: { id: string } }).request.id === id)?.view as { status: string; assessment?: { safe: boolean }; autoApproval?: { status: string } }
  for (const id of ["per_spent", "per_cancelled"]) {
    assert.equal(status(id).status, "complete", id)
    assert.equal(status(id).assessment?.safe, true, id)
    assert.notEqual(status(id).autoApproval?.status, "approved", id)
    assert.notEqual(status(id).autoApproval?.status, "allowing", id)
  }
  assert.equal(ledger.read(decisionKey(location, "ses_spent", "per_spent"))!.state, "sent")
  assert.equal(ledger.read(decisionKey(location, "ses_cancelled", "per_cancelled"))!.state, "cancelled")
  const fresh = ledger.read(decisionKey(location, "ses_fresh", "per_fresh"))!
  assert.equal(fresh.state, "sent", "dispatched and awaiting the native resolution event")
  assert.equal(fresh.owner, fixture.runtime.nonce, "the dispatching owner is this runtime")
  assert.ok(fresh.fingerprint.length === 64, "the fingerprint of the bound invocation was recorded before dispatch")
  fixture.push({ type: "permission.replied", location, data: { sessionID: "ses_fresh", requestID: "per_fresh", reply: "once" } })
  await until("resolved", () => ledger.read(decisionKey(location, "ses_fresh", "per_fresh"))!.state === "resolved")
  assert.equal(posts.length, 3, "one verdict per pending request")
  // A request born before this runtime watched has no observed row and stays manual.
  fixture.sessions.set("ses_baseline", { id: "ses_baseline", location, projectID: project.id })
  fixture.messages.set("msg_ses_baseline", { id: "msg_ses_baseline", type: "assistant", content: [{ type: "tool", id: "call_per_baseline", name: "shell", state: { status: "running", input: { command: "echo per_baseline" } } }] })
  fixture.hooks.get("execute.before")!({ sessionID: "ses_baseline", messageID: "msg_ses_baseline", id: "call_per_baseline", tool: "shell", input: { command: "echo per_baseline" } })
  fixture.pending.push(request("ses_baseline", "per_baseline"))
  fixture.push({ type: "session.step.failed", location, data: { sessionID: "ses_other", error: { type: "aborted" } } })
  await until("baseline reviewed", () => status("per_baseline")?.status === "complete", 15000)
  await sleep(500)
  assert.equal(fixture.replies.length, 1, "an unobserved birth never dispatches")
  assert.equal(ledger.read(decisionKey(location, "ses_baseline", "per_baseline")), undefined)
})
