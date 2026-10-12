// Installed five-file production archive: actual controller, UI and reviewer.
// Scenarios: advisory (nonstream), normal (SSE), fast (held SSE preview/remainder),
// normal-mouse-off, normal-cancel, normal-descendant, fast-descendant.
// Build first. Do not execute a host until the main session grants approval.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, lstat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

// Independent public wire schema. No production imports in either observer.
function rpcDefinition() {
  const text = { type: "string", minLength: 1, maxLength: 16384 }
  const location = { type: "object", properties: { directory: text, workspaceID: text },
    required: ["directory"], additionalProperties: false }
  return { id: "opencode-reviewer", methods: {
    handshake: { input: location, output: { type: "object", properties: {
      protocol: { const: 1 }, hostVersion: text, epoch: { type: "string", format: "uuid" }, location,
      project: { type: "object", properties: { id: text, directory: text, canonical: text },
        required: ["id", "directory", "canonical"], additionalProperties: false },
    }, required: ["protocol", "hostVersion", "epoch", "location", "project"], additionalProperties: false },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } } },
    invocation: { input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text },
      required: ["location", "epoch", "sessionID", "requestID"], additionalProperties: false },
    output: { anyOf: [{ type: "null" }, { type: "object", properties: {
      request: { type: "object" }, invocation: { type: "object" },
    }, required: ["request", "invocation"], additionalProperties: false }] },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } } },
  }, events: {} }
}

// Title interception suppresses auxiliary model calls only. Native tools, inputs,
// context, executors, HTTP requests and permission decisions are never modified.
async function serverSetup(ctx) {
  const registration = await ctx.session.hook("title", event => { event.result = "V2 production review fixture" })
  return () => registration.dispose()
}

async function monitorSetup(ctx) {
  const { Rpc } = await import("@opencode/plugin/rpc")
  const rpc = ctx.client.rpc(Rpc.define(rpcDefinition()))
  const publisher = observationPublisher(fixture.monitor), abort = new AbortController()
  const record = { version: ctx.app.version, ready: true, errors: [], asked: [], replied: [], replies: {}, cleaned: false }
  const location = { directory: fixture.initial }
  const options = () => ({ location, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const save = () => {
    record.route = JSON.parse(JSON.stringify(ctx.ui.router.current()))
    record.mouse = ctx.renderer.useMouse
    return publisher.publish(record)
  }
  const off = ctx.data.listen(({ details }) => {
    if (details.type === "permission.asked") record.asked.push(details.data)
    if (details.type === "permission.replied") record.replied.push(details.data)
    void save()
  })
  let sequence = 0
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const command = await readObservation(fixture.control, { optional: true })
      if (command && command.sequence > sequence) {
        sequence = command.sequence
        let value
        if (command.type === "status") {
          value = { plugins: await ctx.client.plugin.list({ location }, options()) }
          try { value.handshake = await rpc.handshake(location, options()) }
          catch (error) { value.failure = JSON.parse(JSON.stringify(error)) }
        }
        else if (command.type === "start") {
          value = await ctx.client.session.create({ title: "V2 production review fixture", location,
            model: { providerID: "fixture", id: "fixture" } }, options())
          ctx.ui.router.navigate({ type: "session", sessionID: value.id })
          await ctx.client.session.prompt({ sessionID: value.id, text: command.text }, options())
         } else if (command.type === "child") {
           value = await ctx.client.session.create({ title: "V2 production review descendant", parentID: command.sessionID,
             location, model: { providerID: "fixture", id: "fixture" } }, options())
           await ctx.data.session.sync(value.id)
           assert.equal(ctx.data.session.root(value.id), command.sessionID)
           assert.ok(ctx.data.session.family(command.sessionID).includes(value.id))
         } else if (command.type === "navigate") {
           ctx.ui.router.navigate({ type: "session", sessionID: command.sessionID })
           value = { route: ctx.ui.router.current(), root: ctx.data.session.root(command.sessionID),
             session: ctx.data.session.get(command.sessionID) }
         } else if (command.type === "pending") value = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
        else if (command.type === "inspect") {
          const request = await ctx.client.permission.get({ sessionID: command.sessionID, requestID: command.requestID }, options())
          value = { request, session: await ctx.client.session.get({ sessionID: command.sessionID }, options()),
            message: await ctx.client.session.message.get({ sessionID: command.sessionID, messageID: request.source.messageID }, options()),
             captured: await rpc.invocation({ location, epoch: command.epoch, sessionID: command.sessionID,
               requestID: command.requestID }, options()),
             native: { root: ctx.data.session.root(command.sessionID), family: ctx.data.session.family(command.sessionID),
               session: ctx.data.session.get(command.sessionID), permissions: ctx.data.session.permission.list(command.sessionID),
               route: ctx.ui.router.current() } }
        } else if (command.type === "message") value = await ctx.client.session.message.get({ sessionID: command.sessionID,
          messageID: command.messageID }, options())
        else if (command.type === "interrupt") await ctx.client.session.interrupt({ sessionID: command.sessionID, continue: false }, options())
        else throw Error("Unknown V2 review fixture control: " + command.type)
        record.replies[sequence] = { value: value ?? null }
        await save(); await publisher.flush()
      }
      await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => { if (!abort.signal.aborted) { record.errors.push(error instanceof Error ? String(error.stack) : JSON.stringify(error)); void save() } })
  await save(); await publisher.flush()
  return async () => {
    off(); abort.abort(); await loop
    record.cleaned = true
    await save(); await publisher.flush(); await publisher.close()
  }
}

const { scenario } = runtimeArguments("smoke-v2-review.mjs")
const streaming = scenario !== "advisory", automatic = scenario !== "advisory", fast = scenario.startsWith("fast")
const negative = scenario.includes("-"), descendant = scenario.endsWith("-descendant")
const mouseOff = scenario === "normal-mouse-off", approvalDelaySeconds = fast ? 45 : 8
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-review-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-review-")
const env = smokeEnvironment(temp), runtime = await smokeRuntime(temp)
const project = path.join(temp, "project"), initial = path.join(project, "invocation"), inputs = path.join(initial, "inputs")
const monitorPath = path.join(artifacts, "monitor.json"), controlPath = path.join(artifacts, "control.json")
const presentationPath = path.join(artifacts, "presentation.json")
const cliPath = path.join(temp, "config/opencode/cli.json")
const archiveFiles = ["dist/tui.js", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].sort()
const prompt = "Run python3 fixture.py once in inputs. It appends the isolated V2_REVIEW_EXECUTED marker and prints it."
const script = 'from pathlib import Path\nwith Path("executed").open("a") as output:\n    output.write("V2_REVIEW_EXECUTED\\n")\nprint("V2_REVIEW_EXECUTED")\n'
const description = "V2 local marker report.\n\nThe script writes one isolated marker."
const assessment = { safe: true, desc: description }
const toolCall = { id: "v2-production-review-shell", name: "shell", input: { command: "python3 fixture.py", workdir: "inputs" } }
const publishers = new Map(), calls = [], errors = [], negativeWindows = []
let version, modelServer, mainResponse, reviewResponse, sessionID, childSession, request, inspection, handshake, sequence = 0
let reviewPOSTs = 0, reviewCompleted = false, allowWrites = false
const publish = async (file, value) => {
  let publisher = publishers.get(file)
  if (!publisher) { publisher = observationPublisher(file); publishers.set(file, publisher) }
  await publisher.publish(value); await publisher.flush()
}
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-review")
const saveCapture = async name => {
  await writeFile(path.join(artifacts, name + ".txt"), capture())
  await writeFile(path.join(artifacts, name + ".ansi.txt"), runtime.tmux("capture-pane", "-p", "-e", "-t", "v2-review"))
}
const executed = () => readFile(path.join(inputs, "executed"), "utf8").catch(error => {
  if (error.code === "ENOENT") return null
  throw error
})
const observations = async () => {
  const record = await readObservation(monitorPath, { optional: true })
  assert.deepEqual(errors, [])
  assert.ok(reviewPOSTs <= 1, "One production reviewer POST, no correction or transport retry")
  if (record) {
    assert.deepEqual(record.errors, [])
    assert.ok(record.asked.length <= 1, "Only one native shell permission is expected")
    assert.ok(record.replied.length <= (allowWrites ? 1 : 0), "Only the production automatic path may reply once")
    for (const reply of record.replied) {
      assert.equal(reply.reply, "once")
      assert.equal(reply.sessionID, sessionID)
      assert.equal(reply.requestID, request.id)
    }
  }
  const marker = await executed()
  // Native Python can create the append target just before flushing its line.
  // Only an admitted automatic write may expose that transient empty file.
  assert.ok(marker === null || allowWrites && (marker === "" || marker === "V2_REVIEW_EXECUTED\n"), "No unexpected or duplicate execution")
  return record
}
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    const record = await observations(), value = await predicate(record)
    if (value) return value
    await sleep(60)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${scenario}/${label}`)
}
const command = async input => {
  const id = ++sequence
  await publish(controlPath, { ...input, sequence: id })
  const reply = await until("monitor " + input.type, record => record?.replies[id])
  return reply.value
}
const negativeWindow = async (label, expectedPending, expectedReplies, expectedExecution, expectedReviewPOSTs,
  durationMs = 1500, check = () => {}) => {
  const start = performance.now(), end = start + durationMs
  let samples = 0
  do {
    const pending = await command({ type: "pending", sessionID })
    assert.deepEqual(pending, expectedPending, "Complete raw native pending data remains unchanged")
    const record = await observations()
    assert.deepEqual(record.replied, expectedReplies, "No new permission write in negative window")
    assert.equal(await executed(), expectedExecution, "No new native execution in negative window")
     assert.equal(reviewPOSTs, expectedReviewPOSTs, "No extra reviewer dispatch")
     await check(record, capture())
    samples++
    await sleep(75)
  } while (performance.now() < end)
  negativeWindows.push({ label, durationMs: performance.now() - start, samples, pending: expectedPending,
    replies: expectedReplies, execution: expectedExecution, reviewPOSTs: expectedReviewPOSTs })
}
const presentation = () => readObservation(presentationPath, { optional: true })
const rootPending = (record, screen) => {
  assert.deepEqual(record.route, { type: "session", sessionID })
  assert.equal(record.mouse, !mouseOff, "Production preserves explicit fixture mouse preference")
  assert.ok(screen.includes("Permission analysis"))
  assert.ok(screen.includes("✓ Safe"))
  assert.doesNotMatch(screen, /Allowed in/)
}
const cancelledRoot = (record, screen) => {
  rootPending(record, screen)
  assert.ok(screen.includes("Auto-approval canceled"), "Countdown cancellation tombstone remains visible")
}
const hiddenDescendant = (record, screen) => {
  assert.deepEqual(record.route, { type: "session", sessionID: childSession.id })
  assert.equal(record.mouse, true)
  assert.doesNotMatch(screen, /Permission analysis|V2 local marker report\.|Allowed in|Auto-approved; finishing report/,
    "The entire reviewer panel is absent on the real descendant route")
}
const navigate = async target => {
  const value = await command({ type: "navigate", sessionID: target })
  assert.deepEqual(value.route, { type: "session", sessionID: target })
  assert.equal(value.root, sessionID)
  await until("native route " + target, record => record?.route.type === "session" && record.route.sessionID === target)
  return value
}
const interruptPending = async (check = () => {}) => {
  await command({ type: "interrupt", sessionID })
  await until("native permission cleared after interruption", async () => (await command({ type: "pending", sessionID })).length === 0)
  await until("reviewer cleared after negative-case interruption", () => !capture().includes("Permission analysis"))
  await negativeWindow("negative-case interruption has no approval or execution", [], [], null, 1, 1500, (record, screen) => {
    assert.doesNotMatch(screen, /Permission analysis/)
    check(record, screen)
  })
}
const sse = (res, content, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0,
  delta: content === undefined ? {} : { content }, finish_reason }] })}\n\n`)
const finishReview = () => {
  assert.ok(reviewResponse && !reviewCompleted)
  if (streaming) {
    sse(reviewResponse, fast ? '"}' : JSON.stringify(assessment))
    sse(reviewResponse, undefined, "stop")
    reviewResponse.end("data: [DONE]\n\n")
  } else {
    reviewResponse.writeHead(200, { "Content-Type": "application/json" })
    reviewResponse.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(assessment) }, finish_reason: "stop" }] }))
  }
  reviewCompleted = true
}
const limits = [
  "One installed default archive with separate server companion and global CLI configuration. The independent monitor never imports production code or replies to permissions.",
  "One standalone Linux OpenCode 2.0.26 host, one direct native shell call and a loopback reviewer. No live-provider judgment, remote workspace, multi-terminal, disconnect or tab-switch acceptance.",
  "Mouse capture is explicitly configured only by the isolated fixture, never forced by production. Countdown cases require an observed real physical FRAME before click/navigation; this is not full presentation/cover acceptance.",
  "Descendant cases navigate a real child while a root request is pending; they do not exercise descendant-owned native queue ordering. No disabled kinds, uncertain writes, production history, statistics or notification acceptance.",
]
try {
  version = execFileSync(host, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim()
  assert.equal(version, "opencode v2.0.26")
  await Promise.all([inputs, path.dirname(cliPath)].map(directory => mkdir(directory, { recursive: true })))
  execFileSync("git", ["init", "--quiet", project], { env, timeout: 10000 })
  await writeFile(path.join(inputs, "fixture.py"), script)
  const packedOutput = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", temp],
    { cwd: root, env: { ...env, npm_config_cache: path.join(temp, "npm-cache"), npm_config_ignore_scripts: "true" }, encoding: "utf8", timeout: 60000 }))
  const packed = Array.isArray(packedOutput) ? packedOutput : Object.values(packedOutput)
  assert.equal(packed.length, 1)
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), archiveFiles)
  const archive = path.join(temp, packed[0].filename), install = path.join(temp, "installed")
  await mkdir(install)
  assert.deepEqual(execFileSync("tar", ["-tzf", archive], { env, encoding: "utf8", timeout: 10000 }).trim().split("\n").sort(),
    archiveFiles.map(file => "package/" + file).sort())
  execFileSync("tar", ["-xzf", archive, "-C", install], { env, timeout: 10000 })
  const installed = path.join(install, "package")
  for (const file of archiveFiles) {
    assert.equal((await lstat(path.join(installed, file))).isSymbolicLink(), false)
    assert.deepEqual(await readFile(path.join(installed, file)), await readFile(path.join(root, file)))
  }
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"))
  assert.equal(manifest.name, "opencode-reviewer")
  assert.equal(manifest.engines.opencode, "2.0.26")
  assert.deepEqual(manifest.exports, { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" })
  modelServer = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST")
      let text = ""
      for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
      const body = JSON.parse(text)
      calls.push({ url: req.url, body })
      if (req.url === "/review/chat/completions") {
        reviewPOSTs++
        assert.equal(reviewPOSTs, 1)
        assert.equal(body.model, "v2-production-reviewer")
        assert.equal(body.stream, streaming)
        assert.equal(body.messages.length, 2)
        assert.equal(body.messages[0].role, "system")
        assert.match(body.messages[0].content, /permission\.action="shell"/)
        assert.equal(body.messages[1].role, "user")
        const evidence = JSON.parse(body.messages[1].content)
        assert.equal(evidence.kind, "shell")
        assert.equal(evidence.tool, "shell")
        assert.equal(evidence.command, toolCall.input.command)
        assert.deepEqual(evidence.operation.input, toolCall.input)
        assert.equal(evidence.userPrompt, prompt)
        assert.equal(evidence.location.directory, initial)
        assert.equal(evidence.cwd, inputs)
        assert.deepEqual(evidence.execution, { tool: "shell", requestedWorkdir: "inputs", canonicalCwd: inputs,
          cwdSource: "tool.workdir relative to invocation.location.directory" })
        assert.equal(evidence.project.directory, project)
        assert.equal(evidence.permission.action, "shell")
        assert.deepEqual(evidence.permission.resources, [toolCall.input.command])
        assert.equal(evidence.permission.type, undefined, "No fabricated V1 permission")
        assert.equal(evidence.files.length, 1)
        assert.equal(evidence.files[0].status, "captured")
        assert.equal(evidence.files[0].contents, script)
        reviewResponse = res
        res.once("close", () => { if (!reviewCompleted) errors.push("Reviewer response closed before its controlled terminal EOF") })
        if (streaming) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders() }
        return
      }
      assert.equal(req.url, "/v1/chat/completions")
      assert.ok(body.tools?.some(tool => tool.function.name === "execute"), "Native Code Mode search/execution remains installed")
      const mainCalls = calls.filter(call => call.url === req.url)
      assert.ok(mainCalls.length <= 2, "Only initial request and tool-result continuation")
      if (mainCalls.length === 1) {
        assert.ok(body.tools.some(tool => tool.function.name === toolCall.name), "Use the actually advertised direct native shell")
        mainResponse = { res, body }
        return
      }
      assert.ok(allowWrites, "Advisory must not resume native execution")
      const toolResults = body.messages.filter(message => message.role === "tool")
      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].tool_call_id, toolCall.id)
      assert.match(JSON.stringify(toolResults[0].content), /V2_REVIEW_EXECUTED/, "Actual native tool response reaches the main model")
      const message = { role: "assistant", content: "V2 fixture complete." }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`)
        sse(res, undefined, "stop"); res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }))
      }
    } catch (error) { errors.push(String(error)); res.destroy() }
  })
  await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${modelServer.address().port}`
  const fixture = { initial, monitor: monitorPath, control: controlPath }
  const observer = path.join(temp, "observer"), monitor = path.join(temp, "monitor")
  const reviewer = path.join(temp, "reviewer")
  await mkdir(reviewer)
  await publish(path.join(reviewer, "package.json"), { name: "v2-review-archive-entrypoints", type: "module",
    exports: { ".": "./index.mjs", "./tui": "./tui.mjs" } })
  const archived = `export {default} from ${JSON.stringify(pathToFileURL(path.join(installed, "dist/tui.js")).href)}\n`
  await writeFile(path.join(reviewer, "index.mjs"), archived)
  await writeFile(path.join(reviewer, "tui.mjs"), (automatic ? await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
    + `\nimport * as production from ${JSON.stringify(pathToFileURL(path.join(installed, "dist/tui.js")).href)}\n`
     + `export default {id:"opencode-reviewer",async setup(ctx){const p=observationPublisher(${JSON.stringify(presentationPath)});const cleanup=await production.withHistoryObservations(value=>p.publish(value)).setup(ctx);return async()=>{await cleanup();await p.close()}}}\n`
    : archived))
  await Promise.all([observer, monitor].map(directory => mkdir(directory)))
  const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
  const prelude = helpers + '\nimport assert from "node:assert/strict"\n'
    + 'import {setTimeout as sleep} from "node:timers/promises"\nconst fixture=' + JSON.stringify(fixture) + "\n"
  await publish(path.join(observer, "package.json"), { name: "v2-review-title-observer", type: "module", exports: { ".": "./index.mjs" } })
  await writeFile(path.join(observer, "index.mjs"), serverSetup + '\nexport default {id:"fixture.review.title",setup:serverSetup}\n')
  await publish(path.join(monitor, "package.json"), { name: "v2-review-independent-monitor", type: "module", exports: { "./tui": "./tui.mjs" } })
  await writeFile(path.join(monitor, "tui.mjs"), prelude + rpcDefinition + "\n" + monitorSetup
    + '\nexport default {id:"fixture.review.monitor",setup:monitorSetup}\n')
  for (const file of [path.join(observer, "index.mjs"), path.join(monitor, "tui.mjs")])
    execFileSync(process.execPath, ["--check", file], { env, timeout: 10000 })
  const config = { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", update: "disable",
    plugins: [reviewer, observer], permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: origin + "/v1", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
   // Approval cases explicitly configure mouse capture in the isolated fixture,
   // except the intentional mouse-off negative. Production never changes it;
   // advisory retains the host default.
  // Native autoaccept is explicitly disabled.
  const cli = { $schema: "https://opencode.ai/v2/cli.json", animations: false, attention: { notifications: false, sound: false },
     ...(automatic ? { mouse: !mouseOff } : {}),
    session: { permissions: "prompt" }, plugins: [{ package: reviewer, options: { baseURL: origin + "/review", model: "v2-production-reviewer",
       stream: streaming, autoApprove: automatic, fastMode: fast, autoApproveDelaySeconds: approvalDelaySeconds,
      timeoutMs: 120000, notify: false, notifySound: false, staleReminderSeconds: 0 } }, monitor] }
  await publish(path.join(project, "opencode.json"), config); await publish(cliPath, cli)
  await publish(path.join(artifacts, "setup.json"), { version, scenario, temp, archive, packed, installed,
    moduleURL: pathToFileURL(path.join(installed, "dist/tui.js")).href, config, cli, limits,
    socket: runtime.socket, supervisorPID: runtime.supervisorPID })
  await runtime.start("-d", "-s", "v2-review", "-x", "160", "-y", "40", "-c", initial, host, "--standalone", initial)
  const ready = await until("independent monitor", record => record?.ready && record)
  assert.equal(ready.version, "2.0.26")
   const status = await until("active production companion", async () => {
     const value = await command({ type: "status" })
     return value.handshake && value.plugins.data.find(item => item.id === "opencode-reviewer")?.state.status === "active" && value
   })
  assert.equal(status.plugins.data.find(item => item.id === "opencode-reviewer")?.state.status, "active")
  handshake = status.handshake
  assert.equal(handshake.protocol, 1)
  assert.equal(handshake.hostVersion, "2.0.26")
  assert.deepEqual(handshake.location, { directory: initial })
  assert.equal(handshake.project.directory, project)
  assert.match(handshake.epoch, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
  const session = await command({ type: "start", text: prompt })
  sessionID = session.id
  await until("controlled initial native model request", () => mainResponse)
  const nativeMessage = { role: "assistant", content: null, tool_calls: [{ index: 0, id: toolCall.id, type: "function",
    function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } }] }
  if (mainResponse.body.stream) {
    mainResponse.res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[nativeMessage, null], [{}, "tool_calls"]])
      mainResponse.res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    mainResponse.res.end("data: [DONE]\n\n")
  } else {
    mainResponse.res.writeHead(200, { "Content-Type": "application/json" })
    mainResponse.res.end(JSON.stringify({ choices: [{ message: nativeMessage, finish_reason: "tool_calls" }] }))
  }
  request = await until("native shell permission", record => record?.asked[0])
  assert.equal(request.sessionID, sessionID)
  assert.equal(request.action, "shell")
  assert.deepEqual(request.resources, [toolCall.input.command])
  assert.equal(request.source.type, "tool")
  assert.equal(request.source.id, toolCall.id)
   inspection = await command({ type: "inspect", sessionID, requestID: request.id, epoch: handshake.epoch })
   await publish(path.join(artifacts, "inspection.json"), inspection)
  assert.deepEqual(inspection.request, request)
  assert.equal(inspection.session.id, sessionID)
  assert.equal(inspection.session.parentID, undefined)
  assert.equal(inspection.session.location.directory, initial)
  assert.equal(inspection.session.projectID, handshake.project.id)
  assert.equal(inspection.message.id, request.source.messageID)
  const nativeTool = inspection.message.content.filter(item => item.type === "tool" && item.id === toolCall.id)
  assert.equal(nativeTool.length, 1)
  assert.equal(nativeTool[0].name, "shell")
  assert.equal(nativeTool[0].state.status, "running")
  assert.deepEqual(nativeTool[0].state.input, toolCall.input)
  assert.deepEqual(inspection.captured.request, request)
  assert.deepEqual(inspection.captured.invocation, { sessionID, assistantID: request.source.messageID, callID: toolCall.id,
    tool: "shell", input: toolCall.input, location: handshake.location, project: handshake.project, epoch: handshake.epoch })
  await until("production reviewer POST", () => reviewResponse)
  const payload = JSON.parse(calls.find(call => call.url === "/review/chat/completions").body.messages[1].content)
  const { metadataStatus, source, ...permission } = payload.permission
  assert.ok(metadataStatus)
  assert.deepEqual({ ...permission, source: { type: "tool", messageID: source.assistantID, id: source.id } }, request)
  assert.equal(payload.conversation.current.id, sessionID)
  assert.equal(payload.conversation.root.id, sessionID)
  assert.equal(payload.conversation.current.location.directory, initial)
  assert.equal(payload.conversation.current.projectID, handshake.project.id)
  assert.deepEqual(payload.limitations, ["Optional effective native tool definition is not included; exact captured arguments and pending permission scope are retained.",
    "Only literal Python/shell source and supported cat/head file operands are collected. Files are full review-time snapshots, not command output. Imports, dependencies, other runtimes and calls inside source files are not recursively inspected."])
  await until("rendered production evaluating panel", () => capture().includes("Permission analysis"))
  await saveCapture("evaluating")
  await negativeWindow("review response held", [request], [], null, 1)
  if (descendant) {
    childSession = await command({ type: "child", sessionID })
    assert.equal(childSession.parentID, sessionID)
    assert.equal(childSession.location.directory, initial)
    assert.equal(childSession.projectID, handshake.project.id)
    await publish(path.join(artifacts, "child.json"), childSession)
  }
  if (fast) {
    if (descendant) {
      await navigate(childSession.id)
      await until("reviewer absent before fast Safe preview", () => !capture().includes("Permission analysis"))
      await saveCapture("descendant-before-preview")
      await negativeWindow("descendant route before fast preview has no reply", [request], [], null, 1, 1500, hiddenDescendant)
    } else allowWrites = true
    sse(reviewResponse, '{"safe":true,"desc":' + JSON.stringify(description).slice(0, -1))
    if (descendant) {
      await negativeWindow("hidden fast Safe preview has no automatic write", [request], [], null, 1, 1500, hiddenDescendant)
      assert.equal(reviewCompleted, false)
      await saveCapture("descendant-preview-held")
      finishReview()
      await negativeWindow("fast response completes while descendant-hidden without approval", [request], [], null, 1, 1500, hiddenDescendant)
      await saveCapture("descendant-completed")
      // Never return to root: a never-armed fast report may become eligible on
      // its first genuine root presentation, which is not this negative case.
      await interruptPending(hiddenDescendant)
    } else {
      await until("production fast once reply and marker execution", async record => record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
      assert.equal(reviewCompleted, false, "Fast approval must precede terminal assessment/EOF")
      await until("rendered retained fast report", () => {
        const screen = capture()
        return screen.includes("Permission analysis") && screen.includes("✓ Safe") && screen.includes("V2 local marker report.")
          && screen.includes("Auto-approved; finishing report") && !screen.includes("Allowed in")
      })
      await saveCapture("fast-retained")
      await negativeWindow("fast retained response has no duplicate reply or execution", [], (await observations()).replied, "V2_REVIEW_EXECUTED\n", 1)
      finishReview()
    }
  } else {
    finishReview()
    await until("rendered validated Safe report", () => {
      const screen = capture()
      return screen.includes("Permission analysis") && screen.includes("✓ Safe") && screen.includes("V2 local marker report.")
        && screen.includes("The script writes one isolated marker.")
    })
    await saveCapture("safe-report")
    if (scenario === "advisory") {
      await negativeWindow("completed advisory report remains pending", [request], [], null, 1)
      assert.doesNotMatch(capture(), /Allowed in/)
      await command({ type: "interrupt", sessionID })
      await negativeWindow("advisory interruption has no approval or execution", [], [], null, 1)
    } else if (mouseOff) {
      const proof = await until("completed mouse-off report observation", async () => {
        const value = await presentation()
        return value?.final && value.contentMatches && value.painted && !value.streaming && value
      })
      assert.equal(proof.mouse, false)
      assert.equal(proof.physical, false)
      assert.notEqual(proof.auto, "countdown")
      await publish(path.join(artifacts, "mouse-off-proof.json"), proof)
      await negativeWindow("completed Safe report stays manual with mouse off", [request], [], null, 1,
        approvalDelaySeconds * 1000 + 1500, rootPending)
      await saveCapture("mouse-off-pending")
      await interruptPending()
    } else {
      const proof = await until("painted normal countdown", async () => {
        const value = await presentation()
        return value?.stage === "frame" && value.auto === "countdown" && value.physical && value.final
          && value.root === sessionID && /Allowed in \d+s/.test(capture()) && value
      }, 15000)
      assert.equal(proof.mouse, true)
      await publish(path.join(artifacts, "countdown-proof.json"), proof)
      await saveCapture("countdown")
      if (scenario === "normal-cancel") {
        const rows = capture().split("\n"), row = rows.findIndex(line => /Allowed in \d+s/.test(line) && line.includes("Cancel"))
        assert.ok(row >= 0, "Actual painted countdown and Cancel control share a row")
        const index = rows[row].indexOf("Cancel")
        assert.ok(index >= 0)
        const column = Array.from(rows[row].slice(0, index)).length
        // SGR coordinates are one-based. Click the painted label interior,
        // never invoke the callback or fabricate presentation readiness.
        const x = column + 2, y = row + 1
        await publish(path.join(artifacts, "cancel-click.json"), { x, y, row: rows[row], proof })
        runtime.tmux("send-keys", "-t", "v2-review", "-l", `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`)
        await until("real Cancel click tombstone", () => capture().includes("Auto-approval canceled"), 3000)
        await saveCapture("cancelled")
        await negativeWindow("Cancel remains manual past the original countdown", [request], [], null, 1,
          approvalDelaySeconds * 1000 + 1500, cancelledRoot)
        await interruptPending()
      } else if (descendant) {
        await navigate(childSession.id)
        await until("reviewer absent after countdown route loss", () => !capture().includes("Permission analysis"))
        await saveCapture("descendant-countdown-cancelled")
        await negativeWindow("descendant route blocks approval past the original countdown", [request], [], null, 1,
          approvalDelaySeconds * 1000 + 1500, hiddenDescendant)
        await navigate(sessionID)
        await until("root return preserves cancellation tombstone", () => capture().includes("Auto-approval canceled"))
        await saveCapture("root-return-cancelled")
        await negativeWindow("root return cannot rearm the canceled countdown", [request], [], null, 1,
          approvalDelaySeconds * 1000 + 1500, cancelledRoot)
        await interruptPending()
      } else {
        await negativeWindow("normal countdown remains pending", [request], [], null, 1)
        allowWrites = true
        await until("production normal once reply and marker execution", async record => record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
      }
    }
  }
  if (allowWrites) {
    await until("actual native tool-result continuation", () => calls.filter(call => call.url === "/v1/chat/completions").length === 2)
    const completed = await command({ type: "message", sessionID, messageID: request.source.messageID })
    const result = completed.content.filter(item => item.type === "tool" && item.id === toolCall.id)
    assert.equal(result.length, 1)
    assert.equal(result[0].name, "shell")
    assert.equal(result[0].state.status, "completed")
    assert.deepEqual(result[0].state.input, toolCall.input)
    assert.match(JSON.stringify(result[0].state), /V2_REVIEW_EXECUTED/)
    await until("production report cleared after completion", () => !capture().includes("Permission analysis"))
    await negativeWindow("resolved automatic request stays once-only", [], (await observations()).replied, "V2_REVIEW_EXECUTED\n", 1)
  }
  assert.equal(reviewCompleted, true)
  assert.equal(reviewPOSTs, 1)
  assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, allowWrites ? 2 : 1)
  const final = await observations()
  assert.equal(final.asked.length, 1)
  assert.equal(final.replied.length, allowWrites ? 1 : 0)
  assert.deepEqual(final.route, { type: "session", sessionID: fast && descendant ? childSession.id : sessionID })
  if (automatic) assert.equal(final.mouse, !mouseOff)
  if (negative) assert.equal(await executed(), null)
  await saveCapture("final")
  // Disable only the independent observer, preserving production registration.
  // Its final publication is explicitly flushed/closed before supervisor teardown.
  await publish(cliPath, { ...cli, plugins: [cli.plugins[0], "-fixture.review.monitor"] })
  const cleaned = await until("monitor final flush/close", record => record?.cleaned && record)
  await sleep(300)
  assert.deepEqual(await readObservation(monitorPath), cleaned, "No observer callback after final close")
  await publish(path.join(artifacts, "results.json"), { outcome: "pass", version, scenario, temp, handshake, inspection,
     assessment, reviewCompleted, reviewPOSTs, calls, childSession, negativeWindows, observations: cleaned, execution: await executed(), limits })
  console.log(`PASS V2 installed production review ${scenario}: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  await saveCapture("failed").catch(() => {})
  await publish(path.join(artifacts, "failure.json"), { version, scenario, temp, error: String(error), stack: error.stack,
    errors, handshake, inspection, request, calls, reviewPOSTs, reviewCompleted, negativeWindows, limits,
    observations: await readObservation(monitorPath, { optional: true }).catch(() => null) })
  throw error
} finally {
  try { await runtime.dispose() }
  finally {
    if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)) }
    await Promise.all([...publishers.values()].map(publisher => publisher.close()))
  }
}
