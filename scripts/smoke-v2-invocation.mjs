// Archived production companion, invocation and evidence readers on OpenCode 2.0.26.
// Default is read-only evidence; review adds one advisory reviewer response.
// No flags; linux/git/python3/tmux/bundle/npm-pack/tar.
// Build first. Host execution requires the inventory owner's explicit grant.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, lstat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"
import { rpcDefinition } from "./smoke-v2-rpc.mjs"

// Observer only: no transforms, executor wrapping, or permission writes.
async function serverSetup(ctx) {
  const publisher = observationPublisher(fixture.observations + "/server-" + randomUUID() + ".json")
  const record = { version: ctx.app.version, location: ctx.location, errors: [], after: [], ready: false }
  const save = () => publisher.publish(record)
  const registrations = []
  registrations.push(await ctx.session.hook("title", event => { event.result = "Phase 2 invocation fixture" }))
  registrations.push(await ctx.session.hook("http.request", event => {
    assert.equal(new URL(event.request.url).origin, fixture.origin)
  }))
  registrations.push(await ctx.session.hook("context", event => {
    assert.equal(event.model.providerID, "fixture")
    assert.equal(event.model.id, "fixture")
  }))
  registrations.push(await ctx.tool.hook("execute.after", async event => {
    record.after.push(JSON.parse(JSON.stringify(event)))
    await save()
  }))
  record.catalog = (await ctx.tool.list()).map(({ id, name, options }) => ({ id, name, options }))
  record.ready = true
  await save()
  return async () => {
    for (const registration of registrations.toReversed()) await registration.dispose()
    record.cleaned = true
    await save()
    await publisher.close()
  }
}

// Installed on the server only, after the unchanged default-export baseline.
// Forward every operation to native fs; observe reviewer I/O, never tool execution.
function observedFilePlugin(production, nativeIO) {
  return { id: "opencode-reviewer", async setup(ctx) {
    assert.equal("ui" in ctx, false, "FileIO injection belongs to the server consumer")
    const publisher = observationPublisher(fixture.fileIO)
    const record = { role: "server", moduleURL: fixture.moduleURL, location: ctx.location,
      ready: false, cleaned: false, realpath: 0, open: 0, calls: [] }
    const save = async () => { await publisher.publish(record); await publisher.flush() }
    const observe = async (method, args) => {
      record[method]++
      record.calls.push({ origin: "server", method, path: String(args[0]), consumer: new Error().stack })
      await save()
      return nativeIO[method](...args)
    }
    const plugin = production.withFileAccess({
      realpath: (...args) => observe("realpath", args), open: (...args) => observe("open", args),
    })
    const cleanup = await plugin.setup(ctx)
    record.ready = true
    await save()
    return async () => {
      try { await cleanup?.() }
      finally { record.cleaned = true; await save(); await publisher.close() }
    }
  } }
}

// The CLI monitor imports the actual archived reader. Baseline observations use
// ctx.client itself. Only explicitly named rejection controls wrap copied reads.
async function monitorSetup(ctx, reviewerState) {
  const rpc = ctx.client.rpc(Rpc.define(rpcDefinition()))
  const publisher = observationPublisher(fixture.monitor), abort = new AbortController()
  const record = { version: ctx.app.version, ready: true, errors: [], asked: [], replied: [], progress: [], replies: {} }
  const location = { directory: fixture.initial }
  const signal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
  const options = () => ({ location, signal: signal() })
  const save = () => publisher.publish(record)
  const off = ctx.data.listen(({ details }) => {
    if (details.type === "permission.asked") record.asked.push(details.data)
    if (details.type === "permission.replied") record.replied.push(details.data)
    if (details.type === "session.tool.progress") record.progress.push(details.data)
    void save()
  })
  const read = async (request, scope, client = ctx.client) => {
    try { return { value: await production.readPendingInvocation(client, scope, request, signal()) ?? null } }
    catch (error) { return { error: { type: error.type, message: String(error) } } }
  }
  const readEvidence = async (request, scope, collection, client = ctx.client) => {
    try { return { value: await production.readHostEvidence(client, scope, request, collection, signal()) ?? null } }
    catch (error) { return { error: { type: error.type, message: String(error) } } }
  }
  const evidenceControls = async (request, scope, collection) => {
    const results = []
    for (const kind of ["evidence-request", "evidence-input", "evidence-source", "evidence-permission",
      "evidence-command", "evidence-kind", "evidence-final-request", "evidence-final-epoch"]) {
      const calls = [], originals = []
      let collected = false
      const changed = (name, value) => {
        calls.push(name)
        const copy = structuredClone(value)
        if (name === "evidence") {
          collected = true
          originals.push(structuredClone(value))
          assert.equal(copy.result.status, "ready")
          if (kind === "evidence-request") copy.request.resources.push("fixture-mismatch")
          if (kind === "evidence-input") copy.invocation.input.command += " # wrong"
          if (kind === "evidence-source") copy.invocation.callID += "-wrong"
          if (kind === "evidence-permission") copy.result.evidence.permission.id += "-wrong"
          if (kind === "evidence-command") copy.result.evidence.command += " # wrong"
          if (kind === "evidence-kind") copy.result.evidence.kind = "edit"
        }
        if (collected && name === "permission" && kind === "evidence-final-request") copy.resources.push("fixture-mismatch")
        if (collected && name === "handshake" && kind === "evidence-final-epoch") copy.epoch = "00000000-0000-4000-8000-000000000000"
        return copy
      }
      const forbidden = name => () => { calls.push(name); throw Error("Unexpected evidence reader action: " + name) }
      const client = {
        rpc: definition => {
          const actual = ctx.client.rpc(definition)
          return { invocation: async (...args) => changed("invocation", await actual.invocation(...args)),
            handshake: async (...args) => changed("handshake", await actual.handshake(...args)),
            evidence: async (...args) => {
              const [query] = args
              assert.deepEqual(Object.keys(query).sort(), ["epoch", "location", "options", "requestID", "sessionID", "timeoutMs"])
              assert.deepEqual(query.options, collection)
              assert.ok(query.timeoutMs > 0 && query.timeoutMs <= 5000)
              return changed("evidence", await actual.evidence(...args))
            } }
        },
        session: { get: async (...args) => changed("session", await ctx.client.session.get(...args)),
          message: { get: async (...args) => changed("message", await ctx.client.session.message.get(...args)) },
          prompt: forbidden("prompt"), interrupt: forbidden("interrupt") },
        message: { list: async (...args) => changed("history", await ctx.client.message.list(...args)) },
        permission: { get: async (...args) => changed("permission", await ctx.client.permission.get(...args)),
          reply: forbidden("permission.reply"), rules: forbidden("permission.rules") },
      }
      const result = await readEvidence(request, scope, collection, client)
      assert.deepEqual(result, { value: null }, kind)
      assert.equal(calls.filter(name => name === "evidence").length, 1)
      assert.ok(!calls.some(name => ["prompt", "interrupt", "permission.reply", "permission.rules"].includes(name)))
      results.push({ kind, result, calls, originals })
    }
    return results
  }
  const rejectionControls = async (request, scope) => {
    const results = []
    for (const kind of ["invalid-request", "invalid-scope", "missing-source", "request-copy", "captured-input", "captured-epoch",
      "captured-source", "message-input", "final-request", "final-epoch"]) {
      const calls = [], originals = []
      const changed = (name, value) => {
        calls.push(name)
        const copy = structuredClone(value)
        originals.push({ name, value: structuredClone(value) })
        if (name === "invocation" && copy) {
          if (kind === "request-copy") copy.request.resources = [...copy.request.resources, "fixture-mismatch"]
          if (kind === "captured-input") copy.invocation.input.command += " # fixture changed copy"
          if (kind === "captured-epoch") copy.invocation.epoch += "-wrong"
          if (kind === "captured-source") copy.invocation.callID += "-wrong"
        }
        if (name === "message" && kind === "message-input")
          copy.content.find(item => item.type === "tool" && item.id === request.source.id).state.input.command += " # wrong"
        if (name === "permission" && kind === "final-request") copy.resources = [...copy.resources, "fixture-mismatch"]
        if (name === "handshake" && kind === "final-epoch") copy.epoch = "00000000-0000-4000-8000-000000000000"
        return copy
      }
      const forbidden = name => () => { calls.push(name); throw Error("Unexpected reader action: " + name) }
      // A minimal read-only facade records exactly which public calls the actual
      // reader makes. Mutations never reach ctx.client or the server's capture.
      const client = {
        rpc: definition => {
          const actual = ctx.client.rpc(definition)
          return { invocation: async (...args) => changed("invocation", await actual.invocation(...args)),
            handshake: async (...args) => changed("handshake", await actual.handshake(...args)) }
        },
        session: { get: async (...args) => changed("session", await ctx.client.session.get(...args)),
          message: { get: async (...args) => changed("message", await ctx.client.session.message.get(...args)) },
          prompt: forbidden("prompt"), interrupt: forbidden("interrupt") },
        message: { list: async (...args) => changed("history", await ctx.client.message.list(...args)) },
        permission: { get: async (...args) => changed("permission", await ctx.client.permission.get(...args)),
          reply: forbidden("permission.reply"), rules: forbidden("permission.rules") },
      }
      const input = structuredClone(request), at = structuredClone(scope)
      if (kind === "invalid-request") input.resources = "invalid"
      if (kind === "invalid-scope") at.location.directory = "relative"
      if (kind === "missing-source") delete input.source
      const result = await read(input, at, client)
      assert.deepEqual(result, { value: null }, kind)
      assert.ok(!calls.some(name => ["prompt", "interrupt", "permission.reply", "permission.rules"].includes(name)))
      if (kind.startsWith("invalid-") || kind === "missing-source") assert.deepEqual(calls, [], "Unavailable mandatory identity performs no public reads")
      else if (kind === "request-copy") assert.deepEqual(calls, ["invocation"])
      else if (["captured-input", "captured-epoch", "captured-source", "message-input"].includes(kind))
        assert.deepEqual(calls, ["invocation", "message"])
      else assert.ok(calls.includes("permission"))
      results.push({ kind, result, calls, originals })
    }
    return results
  }
  let seen = 0
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const command = await readObservation(fixture.control, { optional: true })
      if (command && command.sequence > seen) {
        seen = command.sequence
        let value
        if (command.type === "status") {
          const target = command.directory ? { directory: command.directory } : location
          const at = { location: target, signal: signal() }
          value = { plugins: await ctx.client.plugin.list({ location: target }, at) }
          try { value.handshake = await rpc.handshake(target, at) }
          catch (error) { value.error = { type: error.type, message: String(error) } }
        } else if (command.type === "start") {
          value = await ctx.client.session.create({ location, model: { providerID: "fixture", id: "fixture" } }, options())
          ctx.ui.router.navigate({ type: "session", sessionID: value.id })
          await ctx.client.session.prompt({ sessionID: value.id, text: command.text }, options())
        } else if (command.type === "prompt") {
          value = await ctx.client.session.prompt({ sessionID: command.sessionID, text: command.text,
            ...(command.files ? { files: command.files } : {}) }, options())
        } else if (command.type === "move") {
          await ctx.client.session.move({ sessionID: command.sessionID, directory: command.directory }, options())
        } else if (command.type === "interrupt") {
          await ctx.client.session.interrupt({ sessionID: command.sessionID, continue: false }, options())
        } else if (command.type === "pending") {
          value = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
        } else if (command.type === "review") {
          assert.equal(fixture.review, true)
          assert.ok(reviewerState.config)
          assert.equal(reviewerState.config.autoApprove, false)
          const request = await ctx.client.permission.get({ sessionID: command.sessionID, requestID: command.requestID }, options())
          const owned = await production.readPendingInvocation(ctx.client, command.scope, request, signal())
          assert.ok(owned)
          let identified = 0
          const work = production.evaluateHostReview(ctx.client, owned.snapshot, reviewerState.config,
            reviewerState.prompts, signal(), () => { identified++ })
          try { value = { assessment: await work, identified } }
          finally { await work.settled }
        } else if (["read", "controls", "evidence", "evidence-controls"].includes(command.type)) {
          const request = await ctx.client.permission.get({ sessionID: command.sessionID, requestID: command.requestID }, options())
          if (command.type === "controls") value = await rejectionControls(request, command.scope)
          else if (command.type === "evidence-controls") value = await evidenceControls(request, command.scope, command.options)
          else {
            const message = await ctx.client.session.message.get({ sessionID: request.sessionID, messageID: request.source.messageID }, options())
            value = { request, message, result: command.type === "evidence"
              ? await readEvidence(request, command.scope, command.options) : await read(request, command.scope) }
          }
        } else throw Error("Unknown invocation fixture command: " + command.type)
        record.replies[seen] = { value: value ?? null }
        await save()
      }
      await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => { if (!abort.signal.aborted) { record.errors.push(String(error)); void save() } })
  await save()
  return async () => {
    off(); abort.abort(); await loop
    record.cleaned = true
    await save(); await publisher.close()
  }
}

const { scenario } = runtimeArguments("smoke-v2-invocation.mjs")
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-invocation-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-invocation-")
const env = smokeEnvironment(temp), runtime = await smokeRuntime(temp)
const host = process.env.OPENCODE_BIN ?? "opencode"
const project = path.join(temp, "project"), initial = path.join(project, "invocation"), inputs = path.join(initial, "inputs")
const external = path.join(temp, "external"), targets = [path.join(initial, "target.txt"), path.join(external, "target.txt")]
const moved = path.join(project, "moved"), movedInputs = path.join(moved, "inputs")
const observationDirectory = path.join(artifacts, "observations"), monitorPath = path.join(artifacts, "monitor.json")
const controlPath = path.join(artifacts, "control.json"), cliPath = path.join(temp, "config/opencode/cli.json")
const fileIOPath = path.join(artifacts, "server-file-io.json")
const serverPath = path.join(project, "opencode.json")
const archiveFiles = ["dist/tui.js", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].sort()
const publishers = new Map(), calls = [], waiting = new Map(), errors = [], evidence = {}, negativeWindows = []
const network = { reviewPOSTs: 0, mcpToolCalls: 0 }
let expectedReviewPOSTs = 0
let sequence = 0, version, modelServer, mcpServer
const publish = async (file, value) => {
  let publisher = publishers.get(file)
  if (!publisher) { publisher = observationPublisher(file); publishers.set(file, publisher) }
  await publisher.publish(value); await publisher.flush()
}
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-invocation")
const observations = async () => {
  const cli = await readObservation(monitorPath, { optional: true })
  const servers = await Promise.all((await readdir(observationDirectory)).filter(file => file.endsWith(".json"))
    .map(file => readObservation(path.join(observationDirectory, file))))
  assert.deepEqual(errors, [])
  if (cli) { assert.deepEqual(cli.errors, []); assert.deepEqual(cli.replied, []) }
  for (const server of servers) {
    assert.deepEqual(server.errors, [])
    assert.ok(server.after.every(item => item.tool === "execute" || item.status !== "completed"), "No held leaf may complete")
  }
  assert.equal(network.mcpToolCalls, 0)
  assert.ok(network.reviewPOSTs <= expectedReviewPOSTs, "No reviewer request outside its explicit advisory control")
  return { cli, servers }
}
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    const state = await observations(), value = await predicate(state)
    if (value) return value
    await sleep(50)
  } while (Date.now() < end)
  throw Error("Timed out waiting for " + label)
}
const command = async input => {
  const id = ++sequence
  await publish(controlPath, { ...input, sequence: id })
  const reply = await until("monitor " + input.type, value => value.cli?.replies[id])
  return reply.value
}
const modelRequest = async index => {
  await until("model request " + index, () => waiting.has(index))
  return calls[index].body
}
const respond = (index, toolCalls) => {
  const held = waiting.get(index)
  assert.ok(held)
  for (const call of toolCalls) assert.ok(held.body.tools.some(tool => tool.function.name === call.name), "Use an actual outgoing tool name")
  calls[index].response = toolCalls
  waiting.delete(index)
  const message = { role: "assistant", content: null, tool_calls: toolCalls.map((call, index) => ({ index,
    id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) }
  if (held.body.stream) {
    held.res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[message, null], [{}, "tool_calls"]])
      held.res.write(`data: ${JSON.stringify({ id: "phase2-fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    held.res.end("data: [DONE]\n\n")
  } else {
    held.res.writeHead(200, { "Content-Type": "application/json" })
    held.res.end(JSON.stringify({ choices: [{ message, finish_reason: "tool_calls" }] }))
  }
}
const negativeWindow = async (sessionID, expected, label) => {
  const started = performance.now(), end = started + 1500
  let samples = 0
  do {
    await observations()
    const pending = await command({ type: "pending", sessionID })
    assert.deepEqual(pending.toSorted((a, b) => a.id.localeCompare(b.id)), expected.toSorted((a, b) => a.id.localeCompare(b.id)),
      "The complete raw native requests remain unchanged")
    await assert.rejects(readFile(path.join(inputs, "executed")), { code: "ENOENT" })
    await assert.rejects(readFile(path.join(movedInputs, "executed")), { code: "ENOENT" })
    for (const target of targets) assert.equal(await readFile(target, "utf8"), "PHASE2_BEFORE\n")
    samples++
    await sleep(75)
  } while (performance.now() < end)
  negativeWindows.push({ label, durationMs: performance.now() - started, samples, requestIDs: expected.map(item => item.id) })
}
const pendingCount = async (sessionID, count) => until(count + " native pending requests", async () => {
  const pending = await command({ type: "pending", sessionID })
  assert.ok(pending.length <= count)
  return pending.length === count && pending
})
const interrupt = async sessionID => {
  await command({ type: "interrupt", sessionID })
  await pendingCount(sessionID, 0)
}
const readActual = (request, scope) => command({ type: "read", sessionID: request.sessionID, requestID: request.id, scope })
const collection = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewSkills: true, reviewTools: true, maxFiles: 8, maxEvidenceBytes: 65536 }
const readEvidence = (request, scope, options = collection) => command({ type: "evidence",
  sessionID: request.sessionID, requestID: request.id, scope, options })
const assertDirect = (row, expected, scope, sessionID, prompt) => {
  assert.equal(row.request.source.type, "tool")
  assert.equal(row.request.source.id, expected.id)
  assert.equal(row.request.sessionID, sessionID)
  assert.equal(row.message.id, row.request.source.messageID)
  assert.equal(row.message.type, "assistant")
  const items = row.message.content.filter(item => item.type === "tool" && item.id === expected.id)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, expected.name)
  assert.equal(items[0].state.status, "running")
  assert.deepEqual(items[0].state.input, expected.input)
  assert.equal(row.result.error, undefined)
  const value = row.result.value
  assert.ok(value, "The archived production reader must accept exact direct linkage")
  assert.deepEqual(value.snapshot.scope, scope)
  assert.equal(value.snapshot.request.id, row.request.id)
  assert.deepEqual(value.snapshot.request.source, { assistantID: row.message.id, id: expected.id })
  assert.equal(value.invocation.callID, expected.id)
  assert.equal(value.invocation.assistantID, row.message.id)
  assert.equal(value.invocation.sessionID, sessionID)
  assert.equal(value.invocation.tool, expected.name)
  assert.deepEqual(value.invocation.input, expected.input)
  assert.deepEqual(value.invocation.location, scope.location)
  assert.equal(value.invocation.project.directory, project)
  assert.equal(value.invocation.epoch, scope.epoch)
  assert.equal(value.conversation.current.id, sessionID)
  assert.equal(value.conversation.root.id, sessionID)
  assert.equal(value.conversation.userPrompt, prompt)
  assert.ok(value.conversation.rootMessageID)
  assert.deepEqual(value.conversation.limitations, [])
}
const limits = [
  "Uses the archived default server companion and production invocation/evidence readers, followed by server-only observed native FileIO. The review scenario adds one advisory evaluation; no production controller/UI, approval or history integration.",
  "One local standalone host. No remote workspace, disconnect, native cache reconciliation or multi-terminal proof.",
  "Rejection controls mutate copies only at the reader boundary, never the actual pending requests, captured calls or tool executors.",
  "Native Code Mode ambiguity is exercised using two native MCP-dispatch calls under one execute source; it does not establish MCP category evidence readiness.",
  "Initial/nested/resumed native descendants retain root intent and omit unproven exact delegation; no unique native delegation association is claimed.",
  "An attachment-only root blocks older textual intent. Moving an idle interrupted session tests new invocation location, not a mid-execution move or retained pending write.",
  "Reload tests a continuously pending call whose capture is lost at companion unload. No missed call is reconstructed from durable inputs.",
  "Server FileIO observations prove the archived server consumer calls native fs for shell evidence. This standalone host does not establish remote-filesystem isolation.",
]
try {
  version = execFileSync(host, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim()
  assertV2HostVersion(version)
  await Promise.all([inputs, external, observationDirectory, path.dirname(cliPath)].map(directory => mkdir(directory, { recursive: true })))
  smokeGitInit(temp, project)
  await writeFile(path.join(inputs, "fixture.py"), 'with open("executed", "a") as output:\n    output.write("PHASE2 UNEXPECTED EXECUTION\\n")\n')
  for (const target of targets) await writeFile(target, "PHASE2_BEFORE\n")
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
  assert.equal(manifest.engines.opencode, ">=2.0.0 <3")
  assert.deepEqual(manifest.exports, { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" })
  modelServer = createServer(async (req, res) => {
    try {
      if (req.url === "/review/chat/completions") {
        network.reviewPOSTs++
        assert.equal(scenario, "review")
        assert.equal(network.reviewPOSTs, 1)
        assert.equal(req.method, "POST")
        let text = ""
        for await (const chunk of req) { text += chunk; assert.ok(text.length < 1024 * 1024) }
        const body = JSON.parse(text), data = JSON.parse(body.messages[1].content)
        assert.equal(body.model, "phase3-advisory-reviewer")
        assert.equal(body.stream, false)
        assert.match(body.messages[0].content, /permission\.action="shell"/)
        assert.equal(data.permission.action, "shell")
        assert.deepEqual(data.permission.resources, ["python3 fixture.py"])
        assert.equal(data.permission.type, undefined)
        assert.equal(data.location.directory, initial)
        assert.equal(data.cwd, inputs)
        assert.equal(data.files[0].contents, await readFile(path.join(inputs, "fixture.py"), "utf8"))
        evidence.advisoryPayload = body
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true, desc: "The isolated fixture appends a marker to a local file." }) }, finish_reason: "stop" }] }))
        return
      }
      if (req.url?.startsWith("/review")) { network.reviewPOSTs++; throw Error("Unexpected reviewer path") }
      assert.equal(req.method, "POST")
      assert.equal(req.url, "/v1/chat/completions")
      let text = ""
      for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
      const body = JSON.parse(text), index = calls.length
      assert.ok(body.tools?.length, "The title hook suppresses auxiliary model requests")
      calls.push({ index, body }); waiting.set(index, { res, body })
      res.once("close", () => { if (waiting.has(index)) { calls[index].aborted = true; waiting.delete(index) } })
    } catch (error) { errors.push(String(error)); res.destroy() }
  })
  // Read-only discovery endpoints plus an execution sentinel. Permissions must
  // stop both nested calls before a tools/call request reaches this server.
  mcpServer = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return }
      let text = ""
      for await (const chunk of req) { text += chunk; assert.ok(text.length < 1024 * 1024) }
      const body = JSON.parse(text)
      if (body.id === undefined) { res.writeHead(202); res.end(); return }
      let result
      if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "phase2-invocation", version: "1.0.0" } }
      else if (body.method === "tools/list") result = { tools: [{ name: "held-call", description: "PHASE2_INVOCATION_HELD_CALL",
        inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } }] }
      else if (body.method === "tools/call") { network.mcpToolCalls++; throw Error("Held MCP call executed") }
      else if (body.method === "ping") result = {}
      else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
        error: { code: -32601, message: "Unknown fixture method" } })); return }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
    } catch (error) { errors.push(String(error)); res.destroy() }
  })
  await Promise.all([modelServer, mcpServer].map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))))
  const origin = `http://127.0.0.1:${modelServer.address().port}`
  const fixture = { initial, observations: observationDirectory, monitor: monitorPath, control: controlPath, fileIO: fileIOPath, origin, review: scenario === "review",
    moduleURL: pathToFileURL(path.join(installed, "dist/tui.js")).href }
  const companion = path.join(temp, "companion"), observer = path.join(temp, "observer"), monitor = path.join(temp, "monitor")
  const observedCompanion = path.join(temp, "observed-companion")
  await Promise.all([companion, observer, monitor, observedCompanion].map(directory => mkdir(directory)))
  const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
  const prelude = helpers + '\nimport assert from "node:assert/strict"\n'
    + 'import {setTimeout as sleep} from "node:timers/promises"\nconst fixture=' + JSON.stringify(fixture) + "\n"
  await publish(path.join(companion, "package.json"), { name: "phase2-archived-companion", type: "module", exports: { ".": "./index.mjs" } })
  // Exact archived default export, without an embedding setup observer or context proxy.
  await writeFile(path.join(companion, "index.mjs"), `export {default} from ${JSON.stringify(fixture.moduleURL)}\n`)
  await publish(path.join(observedCompanion, "package.json"), { name: "phase2-observed-companion", type: "module", exports: { ".": "./index.mjs" } })
  await writeFile(path.join(observedCompanion, "index.mjs"), prelude
    + `\nimport * as production from ${JSON.stringify(fixture.moduleURL)}\n`
    + 'import {open as nativeOpen, realpath as nativeRealpath} from "node:fs/promises"\n'
    + observedFilePlugin + '\nexport default observedFilePlugin(production,{open:nativeOpen,realpath:nativeRealpath})\n')
  await publish(path.join(observer, "package.json"), { name: "phase2-native-observer", type: "module", exports: { ".": "./index.mjs" } })
  await writeFile(path.join(observer, "index.mjs"), prelude + serverSetup + '\nexport default {id:"fixture.invocation.server",setup:serverSetup}\n')
  await publish(path.join(monitor, "package.json"), { name: "phase2-reader-monitor", type: "module", exports: { "./tui": "./tui.mjs" } })
  await writeFile(path.join(monitor, "tui.mjs"), prelude + `\nimport * as production from ${JSON.stringify(fixture.moduleURL)}\n`
    + 'import {Rpc} from "@opencode/plugin/rpc"\n' + rpcDefinition + "\n" + monitorSetup
    + '\nexport default {id:"fixture.invocation.monitor",async setup(ctx){return production.withAdapterSetup(async(ready,life)=>{assert.equal(ready.role,"cli");life.addCleanup(await monitorSetup(ctx,ready.state))}).setup(ctx)}}\n')
  for (const file of [path.join(companion, "index.mjs"), path.join(observedCompanion, "index.mjs"), path.join(observer, "index.mjs"), path.join(monitor, "tui.mjs")])
    execFileSync(process.execPath, ["--check", file], { env, timeout: 10000 })
  const permissions = [{ action: "*", resource: "*", effect: "allow" },
    ...["shell", "edit", "external_directory", "invocation_*"].map(action => ({ action, resource: "*", effect: "ask" }))]
  const config = { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", update: "disable",
    experimental: { subagent_depth: 3 },
    agents: { "phase2-child": { mode: "all", model: "fixture/fixture", description: "Isolated native context probe", permissions } },
    plugins: [companion, observer], permissions,
    mcp: { servers: { invocation: { type: "remote", url: `http://127.0.0.1:${mcpServer.address().port}/mcp` } } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: origin + "/v1", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
  const cli = { $schema: "https://opencode.ai/v2/cli.json", animations: false, attention: { notifications: false, sound: false }, plugins: [{ package: monitor,
    options: { baseURL: origin + "/review", model: "phase3-advisory-reviewer", stream: false, autoApprove: false, notify: false, notifySound: false } }] }
  await publish(serverPath, config); await publish(cliPath, cli)
  await publish(path.join(artifacts, "setup.json"), { version, temp, fixture, archive, packed, config, cli, limits,
    socket: runtime.socket, supervisorPID: runtime.supervisorPID })
  await runtime.start("-d", "-s", "v2-invocation", "-x", "160", "-y", "40", "-c", initial, host, "--standalone", initial)
  await until("monitor", state => state.cli?.ready)
  const status = await until("archived default companion", async () => {
    const state = await command({ type: "status" })
    return state.handshake && state.plugins.data.find(item => item.id === "opencode-reviewer")?.state.status === "active" && state
  })
  assert.equal(status.handshake.protocol, 1)
  assert.equal(status.handshake.hostVersion, version.slice("opencode v".length))
  assert.equal(status.handshake.location.directory, initial)
  assert.equal(status.handshake.project.directory, project)
  assert.equal(status.plugins.data.find(item => item.id === "opencode-reviewer")?.state.status, "active")
  const scope = { location: status.handshake.location, epoch: status.handshake.epoch }
  evidence.initialHandshake = status.handshake
  const firstPrompt = "PHASE2 ROOT FIRST: inspect the isolated pending shell requests without granting permission."
  const session = await command({ type: "start", text: firstPrompt }), sessionID = session.id
  const firstModel = await modelRequest(0)
  assert.ok(firstModel.tools.some(tool => tool.function.name === "execute"), "Native Code Mode remains enabled")
  const shell = firstModel.tools.find(tool => tool.function.name === "shell")
  assert.ok(shell)
  const expected = ["A", "B"].map(label => ({ id: "phase2-shell-" + label, name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 " + label, workdir: "inputs" } }))
  respond(0, expected)
  const direct = await pendingCount(sessionID, 2)
  assert.deepEqual(direct[0].resources, direct[1].resources)
  assert.deepEqual(direct[0].resources, ["python3 fixture.py"])
  evidence.direct = []
  for (const request of direct) {
    assert.equal(request.action, "shell")
    const row = await readActual(request, scope), call = expected.find(item => item.id === request.source.id)
    assert.ok(call); assertDirect(row, call, scope, sessionID, firstPrompt)
    evidence.direct.push(row)
  }
  assert.notDeepEqual(evidence.direct[0].result.value.invocation.input, evidence.direct[1].result.value.invocation.input)
  evidence.controls = await command({ type: "controls", sessionID, requestID: direct[0].id, scope })
  for (const request of direct) {
    const row = await readActual(request, scope)
    assertDirect(row, expected.find(item => item.id === request.source.id), scope, sessionID, firstPrompt)
    assert.deepEqual(row.request, request, "Controls did not mutate native pending data")
  }
  evidence.shellEvidence = []
  for (const request of direct) {
    const row = await readEvidence(request, scope)
    const value = row.result.value
    assert.ok(value, "Production server shell evidence must be available")
    assert.equal(value.result.status, "ready")
    const report = value.result.evidence
    assert.equal(report.kind, "shell")
    assert.equal(report.command, expected.find(item => item.id === request.source.id).input.command)
    assert.equal(report.cwd, inputs)
    assert.equal(report.userPrompt, firstPrompt)
    assert.equal(report.files.length, 1)
    assert.equal(report.files[0].status, "captured")
    assert.equal(report.files[0].contents, await readFile(path.join(inputs, "fixture.py"), "utf8"))
    evidence.shellEvidence.push(row)
  }
  evidence.disabledShell = await readEvidence(direct[0], scope, { ...collection, reviewBash: false })
  assert.equal(evidence.disabledShell.result.value.result.status, "disabled")
  evidence.evidenceControls = await command({ type: "evidence-controls", sessionID, requestID: direct[0].id, scope, options: collection })
  if (scenario === "review") {
    expectedReviewPOSTs = 1
    evidence.advisory = await command({ type: "review", sessionID, requestID: direct[0].id, scope })
    assert.equal(evidence.advisory.identified, 1)
    assert.deepEqual({ safe: evidence.advisory.assessment.safe, desc: evidence.advisory.assessment.desc },
      { safe: true, desc: "The isolated fixture appends a marker to a local file." })
    assert.equal(network.reviewPOSTs, 1)
  }
  await negativeWindow(sessionID, direct, "concurrent equal-resource direct calls and rejection controls")
  await interrupt(sessionID)

  const latestPrompt = "PHASE2 ROOT LATEST: examine the separate local edit and external-directory stages."
  await command({ type: "prompt", sessionID, text: latestPrompt })
  const editModel = await modelRequest(1)
  assert.ok(editModel.tools.some(tool => tool.function.name === "execute"))
  // Prefer the actual advertised patch tool. Never expose a nested write tool by
  // changing the native catalog, options, or model context.
  const patch = editModel.tools.find(tool => tool.function.name === "patch")
  const write = editModel.tools.find(tool => tool.function.name === "write")
  assert.ok(patch || write, "The pinned host must advertise a native direct edit tool")
  const editCalls = targets.map((target, index) => ({ id: "phase2-edit-" + index, name: (patch ?? write).function.name,
    input: patch ? { patchText: `*** Begin Patch\n*** Update File: ${index ? target : "target.txt"}\n@@\n-PHASE2_BEFORE\n+PHASE2_AFTER_${index}\n*** End Patch` }
      : { path: index ? target : "target.txt", content: `PHASE2_AFTER_${index}\n` } }))
  respond(1, editCalls)
  const edits = await pendingCount(sessionID, 2)
  evidence.edits = []
  for (const request of edits) {
    const expected = editCalls.find(item => item.id === request.source.id), row = await readActual(request, scope)
    assert.ok(expected); assertDirect(row, expected, scope, sessionID, latestPrompt)
    assert.notEqual(row.result.value.conversation.rootMessageID, evidence.direct[0].result.value.conversation.rootMessageID)
    evidence.edits.push(row)
  }
  const local = edits.find(item => item.source.id === editCalls[0].id), outside = edits.find(item => item.source.id === editCalls[1].id)
  assert.equal(local.action, "edit"); assert.equal(outside.action, "external_directory")
  assert.notEqual(local.id, outside.id)
  assert.equal(local.metadata.files.length, 1)
  assert.match(local.metadata.files[0].patch, /-PHASE2_BEFORE\n\+PHASE2_AFTER_0/)
  assert.equal(outside.metadata?.files, undefined)
  evidence.editEvidence = await readEvidence(local, scope)
  assert.equal(evidence.editEvidence.result.value?.result.status, "ready")
  const localReport = evidence.editEvidence.result.value.result.evidence
  assert.equal(localReport.kind, "edit")
  assert.equal(localReport.changes[0].patch, local.metadata.files[0].patch)
  assert.equal(localReport.userPrompt, latestPrompt)
  evidence.directoryEvidence = await readEvidence(outside, scope)
  assert.equal(evidence.directoryEvidence.result.value?.result.status, "ready")
  assert.equal(evidence.directoryEvidence.result.value.result.evidence.kind, "external-directory")
  assert.equal(evidence.directoryEvidence.result.value.result.evidence.files, undefined)
  evidence.disabledEdit = await readEvidence(local, scope, { ...collection, reviewEdits: false })
  assert.equal(evidence.disabledEdit.result.value?.result.status, "disabled")
  evidence.enabledDirectory = await readEvidence(outside, scope, { ...collection, reviewEdits: false })
  assert.equal(evidence.enabledDirectory.result.value?.result.status, "ready")
  await negativeWindow(sessionID, edits, "direct edit and independent external-directory request")
  await interrupt(sessionID)

  await command({ type: "prompt", sessionID, text: "PHASE2 NESTED: discover the held-call fixture using native Code Mode search." })
  const searchModel = await modelRequest(2)
  const execute = searchModel.tools.find(tool => tool.function.name === "execute")
  assert.ok(execute)
  assert.equal(execute.function.parameters.properties.code.type, "string")
  respond(2, [{ id: "phase2-search", name: execute.function.name,
    input: { code: 'return search({namespace:"invocation",query:"PHASE2_INVOCATION_HELD_CALL"});' } }])
  const nestedModel = await modelRequest(3)
  const searchEvent = await until("native catalog search result", state => state.servers.flatMap(item => item.after)
    .find(item => item.id === "phase2-search" && item.status === "completed"))
  const discovered = JSON.parse(searchEvent.result.output.output)
  const selected = discovered.items.filter(item => item.description === "PHASE2_INVOCATION_HELD_CALL")
  assert.equal(selected.length, 1)
  // The emitted exact path is fixture input, never a method of joining evidence.
  assert.equal(selected[0].path, 'tools.invocation["held-call"]')
  evidence.discovery = { selected: selected[0], result: discovered }
  assert.ok(nestedModel.tools.some(tool => tool.function.name === execute.function.name))
  respond(3, [{ id: "phase2-nested", name: execute.function.name, input: { code:
    `return await Promise.allSettled([${selected[0].path}({label:"A"}),${selected[0].path}({label:"B"})]);` } }])
  const nested = await pendingCount(sessionID, 2)
  assert.equal(new Set(nested.map(item => item.id)).size, 2)
  assert.deepEqual(nested[0].source, nested[1].source, "Concurrent nested calls share the outer source")
  evidence.nested = []
  for (const request of nested) {
    assert.equal(request.action, "invocation_held-call")
    assert.equal(request.source.id, "phase2-nested")
    const row = await readActual(request, scope)
    assert.deepEqual(row.result, { value: null }, "The production reader must leave actual nested requests unavailable")
    const source = row.message.content.filter(item => item.type === "tool" && item.id === request.source.id)
    assert.equal(source.length, 1); assert.equal(source[0].name, execute.function.name)
    evidence.nested.push(row)
    assert.deepEqual((await readEvidence(request, scope)).result, { value: null }, "Evidence must not recover ambiguous nested identities")
  }
  await negativeWindow(sessionID, nested, "native Code Mode ambiguity remains pending")
  await interrupt(sessionID)

  const reloadPrompt = "PHASE2 RELOAD: retain this native shell permission while the companion reloads."
  await command({ type: "prompt", sessionID, text: reloadPrompt })
  const reloadModel = await modelRequest(4)
  const reloadCall = { id: "phase2-reload", name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 missed capture", workdir: "inputs" } }
  assert.ok(reloadModel.tools.some(tool => tool.function.name === reloadCall.name))
  respond(4, [reloadCall])
  const held = await pendingCount(sessionID, 1)
  evidence.beforeReload = await readActual(held[0], scope)
  assertDirect(evidence.beforeReload, reloadCall, scope, sessionID, reloadPrompt)
  await negativeWindow(sessionID, held, "capture present before companion unload")
  await publish(serverPath, { ...config, plugins: [companion, observer, "-opencode-reviewer"] })
  await until("companion unavailable with native request still pending", async () =>
    (await command({ type: "status" })).error?.type === "rpc.unavailable")
  await negativeWindow(sessionID, held, "companion disabled, native request unchanged")
  await publish(serverPath, config)
  const reloaded = await until("fresh companion epoch", async () => {
    const status = await command({ type: "status" }); return status.handshake?.epoch !== scope.epoch && status.handshake
  })
  const freshScope = { location: reloaded.location, epoch: reloaded.epoch }
  evidence.afterReload = { handshake: reloaded, oldScope: await readActual(held[0], scope), freshScope: await readActual(held[0], freshScope) }
  assert.equal(evidence.afterReload.oldScope.result.error?.type, "scope")
  assert.deepEqual(evidence.afterReload.freshScope.result, { value: null }, "A new epoch must not reconstruct the old pending call")
  await negativeWindow(sessionID, held, "new epoch has no missed-startup capture")
  await writeFile(path.join(artifacts, "pending.txt"), capture())
  await interrupt(sessionID)
  // Replace only the reviewer installation with its FileIO embedding seam. The
  // native executors/catalog remain untouched and new calls get a new epoch.
  await publish(serverPath, { ...config, plugins: [observedCompanion, observer] })
  const observedHandshake = await until("observed server consumer epoch", async () => {
    const status = await command({ type: "status" })
    const io = await readObservation(fileIOPath, { optional: true })
    return io?.ready && status.handshake?.epoch !== freshScope.epoch && status.handshake
  })
  const observedScope = { epoch: observedHandshake.epoch, location: observedHandshake.location }
  await command({ type: "prompt", sessionID, text: "PHASE2 SERVER FILES: inspect the pending shell using the server-owned collector." })
  const ioModel = await modelRequest(5)
  assert.ok(ioModel.tools.some(tool => tool.function.name === shell.function.name))
  const ioCall = { id: "phase2-observed-io", name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 server-owned IO", workdir: "inputs" } }
  respond(5, [ioCall])
  const ioPending = await pendingCount(sessionID, 1)
  const beforeIO = await readObservation(fileIOPath)
  assert.equal(beforeIO.open, 0)
  assert.equal((await readEvidence(ioPending[0], observedScope, { ...collection, reviewBash: false })).result.value?.result.status, "disabled")
  assert.deepEqual(await readObservation(fileIOPath), beforeIO, "Disabled collection must not probe the injected filesystem")
  evidence.observedServerEvidence = await readEvidence(ioPending[0], observedScope)
  assert.equal(evidence.observedServerEvidence.result.value?.result.status, "ready")
  const report = evidence.observedServerEvidence.result.value.result.evidence
  assert.equal(report.files[0].contents, await readFile(path.join(inputs, "fixture.py"), "utf8"))
  const observedIO = await readObservation(fileIOPath)
  assert.equal(observedIO.role, "server")
  assert.ok(observedIO.open > 0 && observedIO.realpath > 0)
  assert.ok(observedIO.calls.every(call => call.origin === "server" && call.consumer.includes("dist/tui.js")))
  evidence.observedFileIO = observedIO
  await negativeWindow(sessionID, ioPending, "injected server FileIO supplies snapshots without permission writes")
  await interrupt(sessionID)
  const rootIntent = "PHASE2 ROOT INTENT: examine native descendant shell requests; the delegation is optional context, not replacement intent."
  await command({ type: "prompt", sessionID, text: rootIntent })
  const parentModel = await modelRequest(6)
  const subagent = parentModel.tools.find(tool => tool.function.name === "subagent")
  assert.ok(subagent, "Use the advertised native subagent executor without catalog transforms")
  const spawn = (id, prompt) => ({ id, name: subagent.function.name,
    input: { agent: "phase2-child", description: "Native evidence context probe", prompt, model: "fixture/fixture" } })
  respond(6, [spawn("phase2-native-child", "PHASE2 CHILD BRIEF: inspect fixture.py without approving it.")])
  const childID = await until("actual native child progress", state => state.cli?.progress.find(event =>
    event.sessionID === sessionID && event.id === "phase2-native-child" && typeof event.metadata?.sessionID === "string")?.metadata.sessionID)
  const childModel = await modelRequest(7)
  assert.ok(childModel.tools.some(tool => tool.function.name === shell.function.name))
  const childCall = { id: "phase2-child-shell", name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 child", workdir: "inputs" } }
  respond(7, [childCall, spawn("phase2-native-nested", "PHASE2 NESTED BRIEF: independently inspect the same fixture.")])
  const nestedID = await until("actual native nested child progress", state => state.cli?.progress.find(event =>
    event.sessionID === childID && event.id === "phase2-native-nested" && typeof event.metadata?.sessionID === "string")?.metadata.sessionID)
  const nestedRequest = await modelRequest(8)
  assert.ok(nestedRequest.tools.some(tool => tool.function.name === shell.function.name))
  respond(8, [{ id: "phase2-nested-shell", name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 nested", workdir: "inputs" } }])
  evidence.nativeDescendants = []
  for (const [descendant, parent] of [[childID, sessionID], [nestedID, childID]]) {
    const [request] = await pendingCount(descendant, 1)
    const row = await readEvidence(request, observedScope), value = row.result.value
    assert.ok(value, "Native descendant direct-call evidence must retain genuine root intent")
    assert.equal(value.conversation.current.id, descendant)
    assert.equal(value.conversation.current.parentID, parent)
    assert.equal(value.conversation.root.id, sessionID)
    assert.equal(value.conversation.userPrompt, rootIntent)
    assert.deepEqual(value.conversation.delegation, { sessionID: descendant, parentSessionID: parent, messageID: null, prompt: null })
    assert.ok(value.conversation.limitations.some(text => text.includes("Exact immediate subagent delegation is unavailable")))
    assert.equal(value.result.status, "ready")
    assert.equal(value.result.evidence.userPrompt, rootIntent)
    assert.equal(value.result.evidence.files[0].contents, await readFile(path.join(inputs, "fixture.py"), "utf8"))
    evidence.nativeDescendants.push({ descendant, parent, request, row })
    await negativeWindow(descendant, [request], "native descendant root intent retained with optional delegation omitted")
  }
  await interrupt(sessionID)
  await interrupt(childID)
  await interrupt(nestedID)
  const resumeIntent = "PHASE2 ROOT RESUME INTENT: inspect the resumed child's pending shell without substituting its new delegation brief."
  await command({ type: "prompt", sessionID, text: resumeIntent })
  await modelRequest(9)
  const resume = spawn("phase2-native-resume", "PHASE2 RESUMED BRIEF: continue the isolated inspection.")
  resume.input.sessionID = childID
  respond(9, [resume])
  await modelRequest(10)
  respond(10, [{ id: "phase2-resumed-shell", name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 resumed", workdir: "inputs" } }])
  const [resumedPending] = await pendingCount(childID, 1)
  evidence.resumed = await readEvidence(resumedPending, observedScope)
  assert.equal(evidence.resumed.result.value?.conversation.current.id, childID)
  assert.equal(evidence.resumed.result.value.conversation.userPrompt, resumeIntent)
  assert.equal(evidence.resumed.result.value.conversation.delegation.prompt, null)
  assert.equal(evidence.resumed.result.value.result.status, "ready")
  await negativeWindow(childID, [resumedPending], "resumed native child uses new genuine root intent and omitted delegation")
  await interrupt(sessionID)
  await interrupt(childID)

  await command({ type: "prompt", sessionID, text: "", files: [{
    uri: "data:text/plain;base64," + Buffer.from("PHASE2 attachment-only context\n").toString("base64"), name: "fixture-context.txt" }] })
  await modelRequest(11)
  respond(11, [{ id: "phase2-attachment-only", name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 attachment only", workdir: "inputs" } }])
  const [attachmentPending] = await pendingCount(sessionID, 1)
  evidence.attachmentOnly = await readEvidence(attachmentPending, observedScope)
  assert.ok(evidence.attachmentOnly.result.value)
  assert.equal(evidence.attachmentOnly.result.value.conversation.userPrompt, null)
  assert.equal(evidence.attachmentOnly.result.value.result.evidence.userPrompt, null)
  assert.ok(evidence.attachmentOnly.result.value.conversation.limitations.some(text => text.includes("no older prompt was substituted")))
  await negativeWindow(sessionID, [attachmentPending], "latest attachment-only root cannot reuse older textual intent")
  await interrupt(sessionID)

  // Restore the default archived installation before creating another location,
  // so no concurrent server FileIO observers share a publication destination.
  await publish(serverPath, config)
  await until("default companion restored", async () => {
    const io = await readObservation(fileIOPath)
    const status = await command({ type: "status" })
    return io.cleaned && status.handshake && status.handshake.epoch !== observedScope.epoch
  })
  await mkdir(movedInputs, { recursive: true })
  await writeFile(path.join(movedInputs, "fixture.py"), 'with open("executed", "a") as output:\n    output.write("PHASE2 MOVED UNEXPECTED EXECUTION\\n")\n')
  await command({ type: "move", sessionID, directory: moved })
  const relocated = await until("moved location companion", async () => {
    const status = await command({ type: "status", directory: moved })
    return status.handshake?.location.directory === moved && status.handshake
  })
  const relocatedScope = { location: relocated.location, epoch: relocated.epoch }
  await command({ type: "prompt", sessionID, text: "PHASE2 MOVED INTENT: inspect the new literal working directory." })
  await modelRequest(12)
  respond(12, [{ id: "phase2-moved-shell", name: shell.function.name,
    input: { command: "python3 fixture.py # PHASE2 moved", workdir: "inputs" } }])
  const [movedPending] = await pendingCount(sessionID, 1)
  evidence.moved = await readEvidence(movedPending, relocatedScope)
  assert.equal(evidence.moved.result.value?.invocation.location.directory, moved)
  assert.equal(evidence.moved.result.value.result.evidence.cwd, movedInputs)
  assert.equal(evidence.moved.result.value.result.evidence.files[0].contents, await readFile(path.join(movedInputs, "fixture.py"), "utf8"))
  assert.notEqual(evidence.moved.result.value.result.evidence.files[0].contents, evidence.shellEvidence[0].result.value.result.evidence.files[0].contents)
  assert.equal(evidence.shellEvidence[0].result.value.invocation.location.directory, initial)
  evidence.movedOldScope = await readEvidence(movedPending, observedScope)
  assert.equal(evidence.movedOldScope.result.error?.type, "scope", "An old location/epoch cannot adopt the moved invocation")
  await negativeWindow(sessionID, [movedPending], "moved invocation uses new server files without execution")
  await interrupt(sessionID)
  await negativeWindow(sessionID, [], "all interrupted without replies or execution")
  assert.equal(calls.length, 13, "Only the thirteen explicitly controlled native model requests were dispatched")
  await publish(cliPath, { ...cli, plugins: ["*", "-fixture.invocation.monitor"] })
  const cleaned = await until("monitor cleanup", state => state.cli?.cleaned && state.cli)
  await sleep(300)
  assert.deepEqual(await readObservation(monitorPath), cleaned)
  await publish(path.join(artifacts, "results.json"), { outcome: "pass", scenario, version, temp, archiveFiles, evidence,
    negativeWindows, network, calls, observations: await observations(), limits })
  console.log(`PASS V2 archived invocation/evidence ${scenario}: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  try { await writeFile(path.join(artifacts, "failed.txt"), capture()) } catch { /* Host may not have started. */ }
  await publish(path.join(artifacts, "failure.json"), { version, temp, error: String(error), stack: error.stack,
    evidence, negativeWindows, network, calls, errors, limits,
    monitor: await readObservation(monitorPath, { optional: true }).catch(() => null) })
  throw error
} finally {
  try { await runtime.dispose() }
  finally {
    for (const server of [modelServer, mcpServer]) if (server) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    }
    await Promise.all([...publishers.values()].map(publisher => publisher.close()))
  }
}
