// Shared boot for the headless server-review fixtures: one isolated managed OpenCode
// service with the installed archive listed only in the project's opencode.json, a
// server-user reviewer policy file, a synthetic session model and a loopback reviewer
// on one origin. No terminal is ever attached. Scenarios drive the public HTTP API.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer as createNetServer } from "node:net"
import { createServer } from "node:http"
import { chmod, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { Rpc } from "@opencode/plugin/rpc"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { packFixtureArchive, verifyFixturePackage } from "./smoke-package.mjs"
import { publishObservation } from "./smoke-observations.mjs"

export const archiveFiles = ["dist/server.js", "dist/tui.js", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].sort()
export const reviewerModel = "v2-headless-reviewer"

/** Loose schemas: the fixture inspects raw JSON results, the production viewer validates. */
export const reviewerRpc = Rpc.define({ id: "opencode-reviewer", methods: {
  identity: { input: { type: "object" }, output: { type: "object" } },
  snapshot: { input: { type: "object" }, output: { type: "object" } },
  history: { input: { type: "object" }, output: { type: "object" } },
  statistics: { input: { type: "object" }, output: { type: "object" } },
  mode: { input: { type: "object" }, output: { type: "object" } },
  instructions: { input: { type: "object" }, output: { type: "object" } },
  control: { input: { type: "object" }, output: { type: "object" } },
}, events: {} })

const freePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer()
  probe.once("error", reject)
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})

/**
 * @param {object} options
 * @param {string} options.fixture Artifact prefix, for example "v2-headless".
 * @param {string} options.scenario
 * @param {string[]} options.limitations Printed as Scope lines on success.
 * @param {(evidence: any, body: any) => object} options.review Returns the assessment for one reviewer POST.
 * @param {(body: any, context: { userText: string, lastRole: string, toolMessages: any[] }) => { toolCalls?: { name: string, arguments: object }[], text?: string }} [options.agent]
 */
export async function headlessFixture({ fixture, scenario, limitations, review, agent }) {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const host = process.env.OPENCODE_BIN ?? "opencode"
  await mkdir("/tmp/opencode", { recursive: true })
  const temp = await mkdtemp(`/tmp/opencode/reviewer-${fixture}-`)
  await chmod(temp, 0o700)
  const artifacts = await mkdtemp(path.join(root, ".runtime", `${fixture}-${scenario}-`))
  const env = smokeEnvironment(temp)
  // /tmp/opencode may be group-writable. The server's private mode, instruction and
  // SQLite records correctly refuse that ancestry, so state lives under a private sticky-/tmp child.
  env.XDG_STATE_HOME = await mkdtemp("/tmp/reviewer-v2-private-state-")
  const project = path.join(temp, "project")
  for (const directory of [project, env.XDG_CONFIG_HOME, path.join(env.XDG_CONFIG_HOME, "opencode"), env.XDG_DATA_HOME, env.XDG_CACHE_HOME, path.join(env.XDG_STATE_HOME, "opencode")])
    await mkdir(directory, { recursive: true, mode: 0o700 })
  const policyFile = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode-reviewer.json")
  const result = { scenario, temp, artifacts, stateRoot: env.XDG_STATE_HOME, modelCalls: [], reviewPOSTs: [], events: [], replies: [], snapshots: [], services: [] }
  const until = async (label, predicate, timeout = 60000) => {
    const end = performance.now() + timeout
    do {
      const value = await predicate()
      if (value) return value
      await sleep(100)
    } while (performance.now() < end)
    throw new Error(`Timed out waiting for ${scenario}/${label}`)
  }

  let callCounter = 0
  const model = createServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
    const body = JSON.parse(text)
    const json = value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)) }
    if (req.url === "/review/chat/completions") {
      assert.equal(body.stream, false)
      assert.equal(body.messages.length, 2)
      assert.equal(body.messages[0].role, "system")
      const evidence = JSON.parse(body.messages[1].content)
      assert.ok(!body.tools, "The verdict request never declares tools")
      const assessment = review(evidence, body)
      result.reviewPOSTs.push({ at: Date.now(), model: body.model, assessment,
        evidence: { kind: evidence.kind, command: evidence.command, userPrompt: evidence.userPrompt, retrieval: evidence.retrieval, permission: evidence.permission } })
      return json({ choices: [{ message: { role: "assistant", content: JSON.stringify(assessment) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 20 } })
    }
    assert.equal(req.url, "/v1/chat/completions")
    const last = body.messages.at(-1)
    const toolMessages = body.messages.filter(message => message.role === "tool").map(message => ({ id: message.tool_call_id,
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }))
    const user = body.messages.filter(message => message.role === "user").at(-1)
    const userText = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "")
    result.modelCalls.push({ at: Date.now(), roles: body.messages.map(message => message.role), toolMessages, userText })
    const plan = agent ? agent(body, { userText, lastRole: last.role, toolMessages }) : (last.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "shell", arguments: { command: "echo HEADLESS_MARKER" } }] })
    const message = plan.toolCalls?.length ? { role: "assistant", content: null, tool_calls: plan.toolCalls.map((call, index) => ({ index, id: `headless-call-${++callCounter}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { role: "assistant", content: plan.text ?? "done" }
    const finish = message.tool_calls ? "tool_calls" : "stop"
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else json({ choices: [{ message, finish_reason: finish }] })
  })
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${model.address().port}`

  const version = execFileSync(host, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim()
  assertV2HostVersion(version)
  result.version = version
  smokeGitInit(temp, project)
  const { archive, packed, npmOptions } = await packFixtureArchive({ root, temp, env, expectedFiles: archiveFiles, extract: false })
  await publishObservation(path.join(artifacts, "npm-pack.json"), packed)
  const install = path.join(temp, "installed")
  await mkdir(install)
  await writeFile(path.join(install, "package.json"), JSON.stringify({ name: "headless-private-install", version: "0.0.0", private: true }))
  execFileSync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--legacy-peer-deps", "--omit=optional", "--package-lock=false", archive],
    { ...npmOptions, cwd: install })
  const installed = path.join(install, "node_modules/opencode-reviewer")
  await verifyFixturePackage(root, installed, archiveFiles)
  // The server entry only. No cli.json and no terminal exist in this fixture.
  await writeFile(path.join(project, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "fixture/fixture", update: "disable",
    plugins: [installed], permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: origin + "/v1", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }, null, 2))

  /** Atomic replacement of the policy file, as an editor or installer would write it. */
  const writePolicy = async policy => {
    const temporary = `${policyFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(policy, null, 2), { mode: 0o600 })
    await rename(temporary, policyFile)
  }
  const serverPolicy = overrides => ({ baseURL: origin + "/review", model: reviewerModel, stream: false, retrieval: false, timeoutMs: 60000, ...overrides })

  const runtime = await smokeRuntime(temp)
  const location = { directory: project }
  const registration = path.join(env.XDG_STATE_HOME, "opencode/service.json")
  let service, services = 0
  const startService = async () => {
    assert.equal(service, undefined, "Stop the running service first")
    const name = `headless-${++services}`
    const port = await freePort()
    await runtime.start("-d", "-s", name, "-c", project, "env", "XDG_STATE_HOME=" + env.XDG_STATE_HOME, "XDG_CONFIG_HOME=" + env.XDG_CONFIG_HOME,
      host, "serve", "--service", "--hostname", "127.0.0.1", "--port", String(port))
    const endpoint = await until("isolated service registration", async () => {
      try { const value = await Service.discover({ file: registration }); return value.url === `http://127.0.0.1:${port}` && value } catch { return false }
    })
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const info = await client.server.info()
    const subscription = new AbortController()
    void (async () => { try { for await (const event of client.event.subscribe({ signal: subscription.signal })) {
      if (event.type === "permission.asked" || event.type === "permission.replied") result.events.push({ at: Date.now(), type: event.type, service: name, location: event.location?.directory, data: event.data })
    } } catch {} })()
    service = { name, port, client, pid: info.pid, subscription }
    result.services.push({ name, port, pid: info.pid, startedAt: Date.now() })
    return service
  }
  /** Ends the service through the supervised tmux session and waits for its port to close. */
  const stopService = async () => {
    const current = service
    assert.ok(current, "No running service")
    current.subscription.abort()
    service = undefined
    runtime.tmux("kill-session", "-t", current.name)
    await until("service exit", async () => {
      try { await fetch(`http://127.0.0.1:${current.port}/api/info`, { signal: AbortSignal.timeout(1000) }); return false } catch { return true }
    }, 30000)
    result.services.find(entry => entry.name === current.name).stoppedAt = Date.now()
  }
  const rpc = () => service.client.rpc(reviewerRpc)
  const snapshot = async () => { const value = await rpc().snapshot({}, { location }); result.snapshots.push(value); return value }
  /** Boots the location and waits for the server reviewer to answer from the hosting process. */
  const verified = async (expectedReview) => {
    const identity = await until("server reviewer identity", async () => { try { return await rpc().identity({}, { location }) } catch { return false } })
    assert.equal(identity.pid, service.pid, "The reviewer RPC answers from the hosting service process")
    const value = await until("verified hosting", async () => { const snap = await snapshot(); return snap.hosting.status === "verified" && snap })
    if (expectedReview) assert.deepEqual(value.review, expectedReview)
    assert.equal(value.location.directory, project)
    return value
  }
  const asked = sessionID => result.events.filter(event => event.type === "permission.asked" && event.data.sessionID === sessionID)
  const replied = requestID => result.events.filter(event => event.type === "permission.replied" && event.data.requestID === requestID)
  const toolResult = id => result.modelCalls.flatMap(call => call.toolMessages).find(message => message.id === id)

  const finish = async error => {
    let exitCode = 0
    if (error) {
      exitCode = 1
      // A final snapshot and the server pane show where the server engine stood when the fixture failed.
      if (service) try { result.snapshots.push(await rpc().snapshot({}, { location })) } catch {}
      if (service) try { result.serverPane = runtime.tmux("capture-pane", "-p", "-J", "-S", "-400", "-t", service.name) } catch (paneError) { result.serverPane = String(paneError) }
      await publishObservation(path.join(artifacts, "failure.json"), { ...result, error: error instanceof Error ? String(error.stack) : JSON.stringify(error) }).catch(() => {})
      console.error(error)
    } else {
      await publishObservation(path.join(artifacts, "results.json"), { ...result, limitations })
      console.log(`PASS V2 headless server review (${scenario}): ${artifacts}`)
      for (const line of limitations) console.log(`Scope: ${line}`)
    }
    service?.subscription.abort()
    await runtime.dispose()
    model.close()
    process.exit(exitCode)
  }

  return { root, temp, artifacts, env, project, location, policyFile, origin, result, until, writePolicy, serverPolicy, startService, stopService,
    service: () => service, client: () => service.client, rpc, snapshot, verified, asked, replied, toolResult, finish }
}
