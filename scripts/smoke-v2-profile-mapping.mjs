// W2 synthetic mapping probe on the unmodified public 2.0.26 host.
// One default scenario, no flags, no reviewer build or production plugin.
// Source research: core/src/{tool.ts,tool/mcp.ts,session/model-request.ts}.
// Only public Effect transforms/hooks and public CLI client methods run in-host.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

// Serialized functions keep the generated plugin bodies covered by node --check.
function serverEffect(ctx) {
  return Effect.gen(function* () {
    const publisher = observationPublisher(ctx.options.observation)
    const record = { version: ctx.app.version, errors: [], commands: [], catalogs: [], transforms: [],
      replacements: [], contexts: [], before: [], after: [], invocations: [] }
    const copy = value => JSON.parse(JSON.stringify(value))
    // Native input/output values may be Effect schemas, not serializable JSON.
    // Preserve their references in profile assertions; serialize the JSON schemas
    // of the synthetic MCP/custom entries whose full descriptive shape we compare.
    const describe = tools => copy(tools.map(({ execute, input, output, ...tool }) => ({ ...tool,
      ...([ctx.options.collisionID, "w2_alias"].includes(tool.id) ? { input, output } : {}),
      publicKeys: [...Object.keys(tool), ...(input === undefined ? [] : ["input"]), ...(output === undefined ? [] : ["output"])].sort() })))
    const publish = () => Effect.promise(() => publisher.publish(record))
    const fail = cause => Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return
      record.errors.push(Cause.pretty(cause))
      yield* publish()
    })
    let profile, directHook, replacement, aliasHook, revision = 1
    let retained, retainedValue
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      record.cleaned = true
      yield* publish()
      yield* Effect.promise(() => publisher.close())
    }))
    const catalog = label => Effect.gen(function* () {
      const tools = yield* ctx.tool.list()
      if (retained) {
        assert.deepEqual(describe(retained), retainedValue, "rebuild must not mutate an already-read catalog")
        record.retainedCatalogUnchanged = true
      }
      record.catalogs.push({ label, tools: describe(tools), mcpServers: yield* ctx.mcp.list() })
    })
    const enable = () => Effect.gen(function* () {
      assert.equal(profile, undefined)
      profile = yield* ctx.tool.transform(editor => {
        const changed = []
        for (const item of editor.list()) {
          const { pinned, ...compatible } = item.options ?? {}
          editor.update(item.id, draft => { draft.options = { ...compatible, codemode: false } })
          const updated = editor.get(item.id)
          assert.ok(updated)
          for (const key of Object.keys(item).filter(key => key !== "options"))
            assert.equal(updated[key], item[key], `profile changed ${item.id}.${key}`)
          assert.deepEqual(updated.options, { ...compatible, codemode: false })
          changed.push({ id: item.id, executorIdentical: updated.execute === item.execute,
            inputIdentical: updated.input === item.input, outputIdentical: updated.output === item.output })
        }
        record.transforms.push(changed)
      })
      directHook = yield* ctx.session.hook("context", event => Effect.sync(() => { delete event.tools.execute }))
      retained = yield* ctx.tool.list()
      retainedValue = describe(retained)
    })
    const install = () => Effect.gen(function* () {
      assert.equal(replacement, undefined)
      replacement = yield* ctx.tool.transform(editor => {
        const original = editor.get(ctx.options.collisionID), native = editor.get("read")
        assert.ok(original && native)
        const capturedRevision = revision
        const executor = kind => (input, context) => Effect.gen(function* () {
          const marker = `W2 CUSTOM ${kind} revision ${capturedRevision} ${input.payload ?? input.path}`
          record.invocations.push({ kind, revision: capturedRevision, marker, input: copy(input),
            id: context.id, messageID: context.messageID, sessionID: context.sessionID })
          yield* publish()
          return { content: marker, output: marker }
        })
        // Deliberately replace the executor only, keeping *all* descriptive fields.
        // Unlike an options-only Promise transform, Effect does not wrap executors.
        const { id, ...definition } = original
        editor.add({ ...definition, execute: executor("replacement") })
        const updated = editor.get(id)
        assert.deepEqual(describe([updated]), describe([original]))
        assert.notEqual(updated.execute, original.execute)
        for (const key of Object.keys(original).filter(key => !["execute", "options"].includes(key)))
          assert.equal(updated[key], original[key])
        record.replacements.push({ revision: capturedRevision, id, descriptiveFieldsIdentical: true,
          executorIdentical: false, publicKeys: Object.keys(updated).sort() })
        // The alias returns structured output as well as text. The pinned host
        // defects before execute.after if output is returned without a schema
        // (core/src/tool/runtime.ts:45-46), even when the executor itself ran.
        editor.add({ name: "w2_alias", description: "W2 synthetic alias target", input: native.input, output: { type: "string" },
          options: { codemode: false }, execute: executor("alias") })
        assert.equal(editor.get("read").execute, native.execute, "alias does not replace the native registry entry")
      })
      aliasHook = yield* ctx.session.hook("context", event => Effect.gen(function* () {
        const native = event.tools.read, target = event.tools.w2_alias
        assert.ok(native && target)
        event.tools.read = target
        assert.equal(event.tools.read, target, "alias must use the exact same definition object")
        delete event.tools.w2_alias
        record.contexts.push({ sessionID: event.sessionID, alias: "read", target: "w2_alias",
          sameObject: true, native: copy(native), advertised: copy(event.tools.read) })
        yield* publish()
      }))
    })
    yield* Effect.gen(function* () {
      yield* ctx.tool.hook("execute.before", event => Effect.gen(function* () { record.before.push(copy(event)); yield* publish() }))
      yield* ctx.tool.hook("execute.after", event => Effect.gen(function* () { record.after.push(copy(event)); yield* publish() }))
      yield* ctx.session.hook("title", event => Effect.sync(() => { event.result = "W2 profile mapping probe" }))
      yield* ctx.session.hook("http.request", event => Effect.sync(() => {
        assert.equal(new URL(event.request.url).origin, ctx.options.modelOrigin, "only the owned model endpoint may dispatch")
      }))
      yield* ctx.session.hook("context", event => Effect.sync(() => { assert.equal(event.model.providerID, "fixture") }))
      record.ready = true
      yield* publish()
      yield* Effect.gen(function* () {
        let sequence = 0
        while (true) {
          const command = yield* Effect.promise(() => readObservation(ctx.options.control, { optional: true }))
          if (command && command.sequence > sequence) {
            sequence = command.sequence
            if (command.type === "enable") yield* enable()
            else if (command.type === "replace-and-alias") yield* install()
            else if (command.type === "reload") { revision = 2; yield* ctx.tool.reload() }
            else if (command.type === "dispose-mapping") {
              assert.ok(aliasHook && replacement)
              yield* aliasHook.dispose
              yield* replacement.dispose
              yield* replacement.dispose // Public disposal is idempotent.
              yield* ctx.tool.reload()
            } else if (command.type === "dispose-profile") {
              assert.ok(profile && directHook)
              yield* directHook.dispose
              yield* profile.dispose
            } else if (command.type !== "catalog") throw Error(`Unknown server control: ${command.type}`)
            yield* catalog(command.type)
            record.commands.push({ sequence, type: command.type })
            yield* publish()
          }
          yield* Effect.sleep("40 millis")
        }
      }).pipe(Effect.tapCause(fail), Effect.forkScoped)
    }).pipe(Effect.tapCause(fail))
  })
}

function cliSetup(ctx) {
  const publisher = observationPublisher(ctx.options.observation), abort = new AbortController()
  const record = { version: ctx.app.version, errors: [], commands: [], events: [], asked: [], replied: [] }
  const publish = () => publisher.publish(record)
  const options = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
  const stop = ctx.data.listen(({ details: event }) => {
    if (event.type.startsWith("session.execution.") || event.type.startsWith("permission."))
      record.events.push({ type: event.type, data: event.data })
    if (event.type === "permission.asked") record.asked.push(event.data)
    if (event.type === "permission.replied") record.replied.push(event.data)
    void publish()
  })
  const loop = (async () => {
    let sequence = 0
    while (!abort.signal.aborted) {
      const command = await readObservation(ctx.options.control, { optional: true })
      if (command && command.sequence > sequence) {
        sequence = command.sequence
        let value
        if (command.type === "start") {
          const session = await ctx.client.session.create({ location: ctx.location ?? ctx.data.location.default(),
            model: { providerID: "fixture", id: "fixture" } }, options())
          ctx.ui.router.navigate({ type: "session", sessionID: session.id })
          await ctx.client.session.prompt({ sessionID: session.id, text: "Run the isolated W2 synthetic mapping probe." }, options())
          value = session.id
        } else if (command.type === "read") {
          value = await ctx.client.session.message.get({ sessionID: command.sessionID, messageID: command.messageID }, options())
        } else if (command.type === "pending") {
          value = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
        } else throw Error(`Unknown CLI control: ${command.type}`)
        record.commands.push({ sequence, type: command.type, value })
        await publish()
      }
      await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => { if (!abort.signal.aborted) { record.errors.push(String(error)); void publish() } })
  void publish()
  return async () => {
    stop()
    abort.abort()
    await loop
    record.cleaned = true
    await publish()
    await publisher.close()
  }
}

runtimeArguments("smoke-v2-profile-mapping.mjs")
const host = process.env.OPENCODE_BIN ?? "opencode"
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-profile-mapping-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-profile-mapping-")
await mkdir(path.join(temp, "state/opencode"), { recursive: true, mode: 0o700 })
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000, env: smokeEnvironment(temp) }).trim()
assertV2HostVersion(version)
const project = path.join(temp, "project"), plugin = path.join(temp, "probe")
await Promise.all([mkdir(project), mkdir(plugin), mkdir(path.join(temp, "config/opencode"), { recursive: true })])
execFileSync("git", ["init", "--quiet", project], { env: smokeEnvironment(temp) })
await writeFile(path.join(project, "w2-native.txt"), "W2_NATIVE_READ_MARKER\n")
const files = Object.fromEntries(["server", "cli", "server-control", "cli-control"].map(name => [name, path.join(artifacts, `${name}.json`)]))
const publisherImport = JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)
const imports = `import assert from 'node:assert/strict'\nimport { setTimeout as sleep } from 'node:timers/promises'\nimport { observationPublisher, readObservation } from ${publisherImport}\n`
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-profile-mapping", type: "module",
  exports: { ".": "./server.mjs", "./tui": "./tui.mjs" } }))
await writeFile(path.join(plugin, "server.mjs"), `${imports}import { Plugin } from '@opencode/plugin/effect'\nimport { Cause, Effect } from 'effect'\n${serverEffect}\nexport default Plugin.define({id:'research.v2.mapping.server',effect:serverEffect})\n`)
await writeFile(path.join(plugin, "tui.mjs"), `${imports}import { Plugin } from '@opencode/plugin/tui'\n${cliSetup}\nexport default Plugin.define({id:'research.v2.mapping.cli',setup:cliSetup})\n`)

const collisionID = "a_b_echo", rawServers = ["a.b", "a_b"]
const inputSchema = { type: "object", properties: { payload: { type: "string" } }, required: ["payload"], additionalProperties: false }
// Identical descriptive catalogs deliberately cannot identify the winning server.
const mcpCatalog = { tools: [{ name: "echo", description: "W2 colliding synthetic echo", inputSchema }] }
const calls = [], mcpWire = [], errors = [], waiting = new Map(), proofs = {}
const controlPublishers = { server: observationPublisher(files["server-control"]), cli: observationPublisher(files["cli-control"]) }
const sequences = { server: 0, cli: 0 }
const response = (res, body, toolCalls, content = "W2 fixture finished") => {
  const message = toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls.map((call, index) => ({
    index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) },
  })) } : { role: "assistant", content }
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[message, null], [{}, toolCalls ? "tool_calls" : "stop"]])
      res.write(`data: ${JSON.stringify({ id: "w2-fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    res.end("data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: toolCalls ? "tool_calls" : "stop" }] }))
  }
}
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname
    const rawServer = rawServers.find(name => pathname === `/mcp/${name}`)
    // Stateless Streamable HTTP; no unowned persistent notification stream.
    if (rawServer && req.method !== "POST") { res.writeHead(405); res.end(); return }
    let text = ""
    for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
    const body = JSON.parse(text)
    if (rawServer) {
      const item = { server: rawServer, request: body }
      mcpWire.push(item)
      if (body.id === undefined) { res.writeHead(202); res.end(); return }
      let result
      if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: rawServer, version: "1" } }
      else if (body.method === "tools/list") result = mcpCatalog
      else if (body.method === "tools/call") {
        assert.equal(body.params.name, "echo")
        assert.equal(typeof body.params.arguments.payload, "string")
        item.marker = `W2 MCP ${rawServer} ${body.params.arguments.payload}`
        result = { content: [{ type: "text", text: item.marker }] }
      } else if (body.method === "ping") result = {}
      else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown fixture method" } }))
        return
      }
      item.response = result
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
      return
    }
    assert.equal(pathname, "/v1/chat/completions")
    if (!body.tools?.length) { response(res, body, undefined, "W2 title"); return }
    const index = calls.length
    calls.push({ index, body })
    waiting.set(index, { res, body })
    res.once("close", () => {
      if (waiting.has(index)) { calls[index].aborted = true; waiting.delete(index) }
    })
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-profile-mapping")
const observations = async () => {
  const [serverRecord, cli] = await Promise.all([readObservation(files.server, { optional: true }), readObservation(files.cli, { optional: true })])
  assert.deepEqual(errors, [])
  for (const value of [serverRecord, cli]) if (value) assert.deepEqual(value.errors, [])
  if (cli) { assert.deepEqual(cli.asked, [], "no pending permission coverage is intended"); assert.deepEqual(cli.replied, []) }
  return { server: serverRecord, cli }
}
const until = async (label, predicate, timeout = 60000) => {
  const deadline = Date.now() + timeout
  do {
    const value = await observations()
    if (await predicate(value)) return value
    await sleep(50)
  } while (Date.now() < deadline)
  throw Error(`Timed out waiting for ${label}`)
}
const control = async (target, command) => {
  const sequence = ++sequences[target]
  await controlPublishers[target].publish({ ...command, sequence })
  await controlPublishers[target].flush()
  const value = await until(`${target} ${command.type}`, value => value[target]?.commands.some(item => item.sequence === sequence))
  return value[target].commands.find(item => item.sequence === sequence).value
}
const modelRequest = async index => {
  await until(`model request ${index}`, () => waiting.has(index))
  return calls[index].body
}
const respond = (index, toolCalls) => {
  const pending = waiting.get(index)
  assert.ok(pending, `model request ${index} must still be retained`)
  waiting.delete(index)
  calls[index].response = toolCalls ?? "text"
  response(pending.res, pending.body, toolCalls)
}
const names = body => body.tools.map(tool => tool.function.name)
const definition = (body, name) => body.tools.find(tool => tool.function.name === name)
const currentCatalog = async () => (await observations()).server.catalogs.at(-1).tools
const collision = tools => {
  const matches = tools.filter(tool => tool.id === collisionID)
  assert.equal(matches.length, 1, "the public final catalog contains only one surviving collision entry")
  return matches[0]
}
const call = (id, name, payload) => ({ id, name, input: { payload } })
const nativeCall = id => ({ id, name: "read", input: { path: "w2-native.txt" } })
// The pinned native input-repair hook runs before alias resolution. Use the
// advertised native read schema so it preserves these arguments for the alias.
const aliasCall = (id, value) => ({ id, name: "read", input: { path: value } })
const completed = async (expected, next, marker, executedName = expected.name) => {
  const observed = await until(`execute.after ${expected.id}`, value => value.server?.after.some(item => item.id === expected.id))
  const before = observed.server.before.filter(item => item.id === expected.id), after = observed.server.after.filter(item => item.id === expected.id)
  assert.equal(before.length, 1)
  assert.equal(after.length, 1)
  const hook = after[0]
  assert.equal(before[0].tool, expected.name, "before-hook sees the model-facing name")
  assert.equal(hook.tool, executedName, "after-hook sees the selected executor's effective name")
  assert.equal(hook.status, "completed")
  assert.deepEqual(before[0].input, expected.input)
  assert.deepEqual(hook.input, expected.input)
  assert.equal(before[0].sessionID, hook.sessionID)
  assert.equal(before[0].messageID, hook.messageID)
  assert.ok(JSON.stringify(hook.result).includes(marker), "actual executor result must contain its marker")
  let item
  await until(`durable completion ${expected.id}`, async () => {
    const message = await control("cli", { type: "read", sessionID: hook.sessionID, messageID: hook.messageID })
    assert.equal(message.id, hook.messageID)
    assert.equal(message.type, "assistant")
    const matches = message.content.filter(item => item.type === "tool" && item.id === expected.id)
    assert.equal(matches.length, 1)
    item = matches[0]
    return item.state.status === "completed"
  })
  assert.equal(item.name, expected.name)
  assert.deepEqual(item.state.input, expected.input)
  assert.ok(JSON.stringify(item.state).includes(marker), "durable result must contain the executor marker")
  const results = next.messages.filter(item => item.role === "tool" && item.tool_call_id === expected.id)
  assert.equal(results.length, 1)
  assert.ok(JSON.stringify(results[0].content).includes(marker), "subsequent model context must contain the executor marker")
  return { before: before[0], after: hook, item, modelResult: results[0] }
}
const mcpResult = payload => {
  const results = mcpWire.filter(item => item.request.method === "tools/call" && item.request.params.arguments.payload === payload)
  assert.equal(results.length, 1, "each MCP invocation must select exactly one raw endpoint")
  return results[0]
}
const limitations = [
  "Synthetic mapping probe only; no production reviewer or shadow-shell rerun.",
  "MCP uses an initial fixture-local allow rule; custom tools use native default allow. No permission replies or runtime permission-rule writes, and no pending-permission source-mapping claim.",
  "Catalog field equality is deliberately shown insufficient for provenance. Function identity is fixture observation, not an authenticated owner/history token.",
  "Collision winner is observed through actual endpoint calls, not assumed from arrival or configuration order. Only the surviving MCP registration executes.",
  "Reload/dispose covers public tool registrations and a context hook, not plugin unload/reload, arbitrary later hooks, or an atomic configuration-change veto.",
  "Retained snapshots preserve captured custom revisions; they do not freeze arbitrary mutable closures or remote MCP behavior.",
  "No claim of automatic detection of unsupported third-party transforms, authoritative native provenance, or acceptance of the controlled-profile trust model.",
]
const contraryObservations = [
  { artifact: ".runtime/v2-profile-mapping-XQsHQ4/failure.json", runner: ".runtime/runtime-run-XkxmXe/results.json",
    observation: "The payload-schema alias failed with a typed missing-payload error. Native input repair used the registry read schema before alias resolution and removed payload, leaving {}. The fixture now uses native read input and path arguments." },
  { artifact: ".runtime/v2-profile-mapping-XdMsrZ/failure.json", runner: ".runtime/runtime-run-vEIESm/results.json",
    observation: "The native-input alias executor ran and recorded its revision-1 marker, but returned output without an output schema. The next model request contained the unknown error Tool result declared output without an output schema, and execute.after was absent. The fixture now explicitly declares the alias output schema." },
]
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", update: "disable",
    plugins: [{ package: plugin, options: { observation: files.server, control: files["server-control"], collisionID, modelOrigin: baseURL } }],
    permissions: [{ action: collisionID, resource: "*", effect: "allow" }],
    mcp: { servers: Object.fromEntries(rawServers.map(name => [name, { type: "remote", url: `${baseURL}/mcp/${name}`, oauth: false }])) },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${baseURL}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
  const configText = JSON.stringify(config), configPath = path.join(project, "opencode.json")
  await writeFile(configPath, configText)
  const cli = { animations: false, attention: { notifications: false, sound: false },
    plugins: [{ package: plugin, options: { observation: files.cli, control: files["cli-control"] } }] }
  const cliPath = path.join(temp, "config/opencode/cli.json")
  await writeFile(cliPath, JSON.stringify(cli))
  const launch = ["-d", "-s", "v2-profile-mapping", "-x", "160", "-y", "40", "-c", project, host, "--standalone", project]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, temp, config, cli, launch,
    socket: runtime.socket, supervisorPID: runtime.supervisorPID, limitations, contraryObservations }, null, 2))
  await runtime.start(...launch)
  await until("server ready and both raw MCP catalogs fetched", value => value.server?.ready && rawServers.every(name =>
    mcpWire.some(item => item.server === name && item.request.method === "tools/list")))
  await until("collision reaches public catalog", async () => {
    await control("server", { type: "catalog" })
    return (await currentCatalog()).some(tool => tool.id === collisionID)
  })
  const rawCatalog = collision(await currentCatalog())
  assert.equal(rawCatalog.options.codemode, true)
  assert.equal(rawCatalog.options.namespace, "a_b")
  assert.equal(rawCatalog.name, "echo")
  assert.deepEqual(rawCatalog.publicKeys, ["description", "id", "input", "name", "options", "output"])
  proofs.collision = { rawPairs: rawServers.map(server => ({ server, tool: "echo", effectiveID: collisionID })), publicEntry: rawCatalog }
  await control("server", { type: "enable" })
  const baselineCatalog = await currentCatalog(), baselineEntry = collision(baselineCatalog)
  const sessionID = await control("cli", { type: "start" })
  const baseline = await modelRequest(0)
  assert.equal(names(baseline).filter(name => name === collisionID).length, 1)
  assert.equal(names(baseline).includes("execute"), false)
  const baselineCalls = [call("baseline-mcp", collisionID, "baseline"), nativeCall("baseline-native")]
  respond(0, baselineCalls)
  const retainedMcp = await modelRequest(1), first = mcpResult("baseline")
  proofs.collision.executedServer = first.server
  proofs.baseline = [await completed(baselineCalls[0], retainedMcp, first.marker),
    await completed(baselineCalls[1], retainedMcp, "W2_NATIVE_READ_MARKER")]

  // This request already captured MCP. Installing a metadata-identical custom
  // executor must affect the following request, not this retained one.
  await control("server", { type: "replace-and-alias" })
  assert.deepEqual(collision(await currentCatalog()), baselineEntry)
  const retainedCall = call("retained-mcp", collisionID, "retained-before-replacement")
  respond(1, [retainedCall])
  const revisionOne = await modelRequest(2), retainedResult = mcpResult(retainedCall.input.payload)
  assert.equal(retainedResult.server, first.server)
  proofs.retainedMcp = await completed(retainedCall, revisionOne, retainedResult.marker)
  assert.deepEqual(definition(revisionOne, collisionID), definition(baseline, collisionID), "custom replacement does not change advertised metadata")
  assert.deepEqual(definition(revisionOne, "read").function.parameters, definition(baseline, "read").function.parameters)
  assert.equal(names(revisionOne).includes("w2_alias"), false)
  assert.notDeepEqual(definition(revisionOne, "read"), definition(baseline, "read"))
  assert.deepEqual((await currentCatalog()).find(tool => tool.id === "read"), baselineCatalog.find(tool => tool.id === "read"),
    "request-local alias leaves native read in the public final catalog")

  // Capture revision inside each transform replay, not in a mutable executor
  // closure. A held request must execute revision 1 after reload publishes 2.
  await control("server", { type: "reload" })
  assert.deepEqual(collision(await currentCatalog()), baselineEntry)
  const firstCustom = [call("custom-r1", collisionID, "after-reload"), aliasCall("alias-r1", "after-reload")]
  respond(2, firstCustom)
  const revisionTwo = await modelRequest(3)
  proofs.reloadRetained = [await completed(firstCustom[0], revisionTwo, "W2 CUSTOM replacement revision 1 after-reload"),
    await completed(firstCustom[1], revisionTwo, "W2 CUSTOM alias revision 1 after-reload", "w2_alias")]
  assert.equal(mcpWire.filter(item => item.request.method === "tools/call").length, 2, "custom replacement must not call MCP")

  // Public disposal reveals MCP/native definitions. The request retained before
  // disposal still owns both the replacement and same-object alias executors.
  await control("server", { type: "dispose-mapping" })
  assert.deepEqual(await currentCatalog(), baselineCatalog)
  const secondCustom = [call("custom-r2", collisionID, "after-disposal"), aliasCall("alias-r2", "after-disposal")]
  respond(3, secondCustom)
  const restored = await modelRequest(4)
  proofs.disposalRetained = [await completed(secondCustom[0], restored, "W2 CUSTOM replacement revision 2 after-disposal"),
    await completed(secondCustom[1], restored, "W2 CUSTOM alias revision 2 after-disposal", "w2_alias")]
  assert.deepEqual(definition(restored, "read"), definition(baseline, "read"))
  assert.deepEqual(definition(restored, collisionID), definition(baseline, collisionID))
  assert.equal(mcpWire.filter(item => item.request.method === "tools/call").length, 2)
  const restoredCalls = [call("restored-mcp", collisionID, "restored"), nativeCall("restored-native")]
  respond(4, restoredCalls)
  const finalRequest = await modelRequest(5), restoredResult = mcpResult("restored")
  assert.equal(restoredResult.server, first.server)
  proofs.restored = [await completed(restoredCalls[0], finalRequest, restoredResult.marker),
    await completed(restoredCalls[1], finalRequest, "W2_NATIVE_READ_MARKER")]
  respond(5)
  await until("final turn completed", value => value.cli?.events.some(event => event.type === "session.execution.succeeded"))
  assert.deepEqual(await control("cli", { type: "pending", sessionID }), [])
  await control("server", { type: "dispose-profile" })
  assert.deepEqual(collision(await currentCatalog()), rawCatalog)
  const final = await observations()
  assert.equal(final.server.retainedCatalogUnchanged, true)
  assert.equal(final.server.invocations.length, 4)
  for (const [id, kind, revision] of [["custom-r1", "replacement", 1], ["alias-r1", "alias", 1],
    ["custom-r2", "replacement", 2], ["alias-r2", "alias", 2]]) {
    const matches = final.server.invocations.filter(item => item.id === id)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].kind, kind)
    assert.equal(matches[0].revision, revision)
    assert.equal(matches[0].sessionID, sessionID)
  }
  assert.equal(final.server.before.length, 9)
  assert.equal(final.server.after.length, 9)
  assert.equal(final.server.contexts.length, 2)
  assert.ok(final.server.contexts.every(item => item.sameObject))
  assert.ok(final.server.replacements.some(item => item.revision === 2))
  assert.ok(final.server.transforms.length >= 3)
  assert.ok(final.server.transforms.every(pass => pass.every(item => item.executorIdentical && item.inputIdentical && item.outputIdentical)))
  assert.equal(mcpWire.filter(item => item.request.method === "tools/call").length, 3)
  assert.equal(await readFile(configPath, "utf8"), configText, "fixture must not rewrite permission configuration")
  // A real post-completion observation window catches delayed permission events.
  const end = Date.now() + 750
  do { await observations(); await sleep(50) } while (Date.now() < end)
  await writeFile(path.join(artifacts, "completed.txt"), capture())
  await writeFile(cliPath, JSON.stringify({ ...cli, plugins: ["*", "-research.v2.mapping.cli"] }))
  const cleaned = (await until("CLI observer cleanup", value => value.cli?.cleaned)).cli
  await sleep(250)
  assert.deepEqual(await readObservation(files.cli), cleaned)
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, temp,
    assertions: ["two raw MCP catalogs collapse to one public effective ID", "actual MCP endpoint identifies surviving executor",
      "custom replacement has identical public metadata and different actual result", "same-object native-looking alias executes custom target",
      "before-hook and durable name remain read while after-hook identifies w2_alias", "retained MCP request survives replacement",
      "retained revision 1 executes after public reload publishes revision 2", "retained revision 2 and alias execute after registration disposal",
      "future request executes restored MCP and native read mappings", "Effect profile preserves committed executors and schemas",
      "no permission requests/replies, no runtime rules writes", "CLI observer cleanup"],
    limitations, contraryObservations, proofs, calls, mcpWire, observations: await observations() }, null, 2))
  console.log(`PASS V2 profile mapping: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  try { await writeFile(path.join(artifacts, "failed.txt"), capture()) } catch { /* Host may have exited. */ }
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, errors,
    calls, mcpWire, proofs, limitations, contraryObservations,
    observations: await Promise.all([readObservation(files.server, { optional: true }), readObservation(files.cli, { optional: true })]).catch(() => null) }, null, 2))
  throw error
} finally {
  try { await Promise.all(Object.values(controlPublishers).map(publisher => publisher.close())) }
  finally {
    try { await runtime.dispose() }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
}
