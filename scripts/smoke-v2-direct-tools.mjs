// W1 synthetic compatibility-profile probe. Never loads the production reviewer.
// Public contracts inspected at the exact 2.0.26 source/package release:
// packages/plugin/src/{effect/tool.ts,promise/adapter.ts},
// packages/core/src/{tool.ts,tool/runtime.ts,codemode/tool.ts,tool/mcp.ts},
// packages/core/src/tool/plugin/shell.ts and packages/schema/src/tool.ts.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

// These functions are serialized into the isolated plugin. Keeping real function
// bodies here lets node --check also check the generated plugin's implementation.
function serverEffect(ctx) {
  return Effect.gen(function* () {
    const publisher = observationPublisher(ctx.options.observation), executions = new Set()
    const stopExecutions = yield* Deferred.make()
    const record = { version: ctx.app.version, location: ctx.location, errors: [], commands: [],
      api: "public Effect", before: [], after: [], invocations: [], contexts: [], transforms: [], catalogs: [], releaseA: false }
    // Only fixture filesystem observations cross a Promise boundary. Tool effects
    // stay effects, including typed errors, native execution and interruption.
    const publish = () => Effect.promise(async () => { await publisher.publish(record) })
    const copy = value => JSON.parse(JSON.stringify(value))
    const describe = tools => tools.map(({ id, name, description, options, input, output }) => ({ id, name, description, options,
      ...(id.startsWith("w1_mcp_") ? { input, output } : {}) }))
    let revision = 1, profile, contextHook, custom, retainedMcpCatalog, retainedMcpValue
    // Registered first, finalized last: the scoped control fiber and registrations
    // stop before the publisher closes. Retained custom executions are interrupted
    // and their observation finalizers settle before the final flush.
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      yield* Deferred.succeed(stopExecutions, undefined)
      yield* Effect.promise(() => Promise.allSettled([...executions]))
      record.cleaned = true
      yield* publish()
      yield* Effect.promise(() => publisher.close())
    }))
    const reportCause = cause => Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return
      record.errors.push(Cause.pretty(cause))
      yield* publish()
    })
    const catalog = label => Effect.gen(function* () {
      const tools = describe(yield* ctx.tool.list())
      if (retainedMcpCatalog) {
        assert.deepEqual(copy(describe(retainedMcpCatalog)), retainedMcpValue, "MCP refresh/disposal mutated the retained public catalog")
        record.retainedMcpCatalogUnchanged = true
      }
      record.catalogs.push({ label, tools, mcpServers: yield* ctx.mcp.list() })
      return tools
    })
    const enable = () => Effect.gen(function* () {
      assert.equal(profile, undefined, "profile must have a single owner")
      profile = yield* ctx.tool.transform(editor => {
        const changed = []
        for (const item of editor.list()) {
          const { pinned, ...compatible } = item.options ?? {}
          editor.update(item.id, draft => { draft.options = { ...compatible, codemode: false } })
          const updated = editor.get(item.id)
          assert.ok(updated)
          // Check the committed editor entry, not just the callback draft. The
          // Promise editor adapter would wrap execute even for an options-only
          // update, and its Effect.promise bridge turns rejections into defects.
          // The public Effect editor preserves the exact executor and schemas.
          for (const key of Object.keys(item).filter(key => key !== "options"))
            assert.equal(updated[key], item[key], `profile changed ${item.id}.${key}`)
          assert.deepEqual(updated.options, { ...compatible, codemode: false })
          assert.equal(Object.hasOwn(updated.options, "pinned"), false)
          changed.push({ id: item.id, before: item.options, after: updated.options,
            executorIdentical: updated.execute === item.execute,
            inputIdentical: updated.input === item.input, outputIdentical: updated.output === item.output })
        }
        record.transforms.push({ revision, changed })
      })
      contextHook = yield* ctx.session.hook("context", event => Effect.gen(function* () {
        const before = Object.keys(event.tools), definitions = { ...event.tools }
        delete event.tools.execute
        for (const name of before.filter(name => name !== "execute")) assert.equal(event.tools[name], definitions[name])
        record.contexts.push({ sessionID: event.sessionID, before, after: Object.keys(event.tools) })
        yield* publish()
      }))
    })
    yield* Effect.gen(function* () {
      const shell = (yield* ctx.tool.list()).find(tool => tool.id === "shell")
      assert.ok(shell, "native shell must exist")
      const typedFailure = () => Effect.fail(new ToolError({ message: "W1 sentinel tool failure", metadata: { fixture: "typed-failure" } }))
      // A public tool cannot ask permissions itself in 2.0.26. This fixture-local
      // custom executor delegates directly to the public native Effect executor,
      // preserving the invocation context. It is not native provenance.
      custom = yield* ctx.tool.transform(editor => {
        const capturedRevision = revision
        editor.namespace({ name: "w1", description: `W1 synthetic namespace revision ${capturedRevision}` })
        editor.add({ name: "failure", description: "W1 typed failure control",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { namespace: "w1", permission: "w1_fixture", codemode: false }, execute: typedFailure })
        editor.add({ name: "call", description: `W1 fixture revision ${capturedRevision}`,
          input: { type: "object", properties: { label: { type: "string" }, payload: { type: "string" } },
            required: ["label", "payload"], additionalProperties: false },
          options: { namespace: "w1", permission: "w1_fixture", codemode: true, pinned: true },
          execute: (input, context) => Effect.gen(function* () {
            const invocation = { input: copy(input), revision: capturedRevision, id: context.id,
              messageID: context.messageID, sessionID: context.sessionID, started: true, completed: false }
            record.invocations.push(invocation)
            let settled
            const settlement = new Promise(resolve => { settled = resolve })
            executions.add(settlement)
            const wait = predicate => Effect.gen(function* () {
              const deadline = Date.now() + 45000
              while (!predicate()) {
                if (Date.now() >= deadline) return yield* Effect.fail(new ToolError({ message: "W1 executor barrier timed out" }))
                yield* Effect.sleep("25 millis")
              }
            })
            return yield* Effect.gen(function* () {
              yield* publish()
              if (input.label === "cancel") {
                invocation.waitingForInterrupt = true
                yield* publish()
                yield* shell.execute({ command: "python3 fixture.py", workdir: ctx.options.external }, context)
                return yield* Effect.fail(new ToolError({ message: "W1 canceled permission unexpectedly executed" }))
              }
              if (input.label === "error") return yield* typedFailure()
              if (input.label === "A" || input.label === "B") {
                yield* wait(() => ["A", "B"].every(label => record.invocations.some(item => item.input.label === label)))
                invocation.bothStarted = true
                if (input.label === "A") yield* wait(() => record.releaseA)
                invocation.enteredShell = true
                yield* publish()
                const result = yield* shell.execute({ command: "python3 fixture.py", workdir: ctx.options.external }, context)
                invocation.shellResult = copy(result)
              }
              invocation.completed = true
              return { content: `W1 result ${capturedRevision} ${input.label} ${input.payload}` }
            }).pipe(
              Effect.raceFirst(Deferred.await(stopExecutions).pipe(Effect.flatMap(() => Effect.interrupt))),
              Effect.tapError(error => Effect.sync(() => { invocation.failure = error.message })),
              Effect.onInterrupt(() => Effect.sync(() => { invocation.interrupted = true })),
              Effect.ensuring(Effect.promise(async () => {
                try { invocation.settled = true; await publisher.publish(record) }
                finally { executions.delete(settlement); settled() }
              })),
            )
          }),
        })
      })
      yield* ctx.tool.hook("execute.before", event => Effect.gen(function* () { record.before.push(copy(event)); yield* publish() }))
      yield* ctx.tool.hook("execute.after", event => Effect.gen(function* () { record.after.push(copy(event)); yield* publish() }))
      yield* ctx.session.hook("title", event => Effect.sync(() => { event.result = "W1 direct-tool probe" }))
      yield* ctx.session.hook("http.request", event => Effect.sync(() => {
        if (new URL(event.request.url).hostname !== "127.0.0.1") throw Error("Non-fixture model endpoint")
      }))
      yield* ctx.session.hook("context", event => Effect.sync(() => {
        assert.equal(event.model.providerID, "fixture", "only the fixture model may dispatch")
      }))
      const initial = yield* ctx.tool.list(), initialCopy = copy(describe(initial))
      yield* catalog("initial")
      record.ready = true
      yield* publish()
      yield* Effect.gen(function* () {
        let sequence = 0
        while (true) {
          const command = yield* Effect.promise(() => readObservation(ctx.options.control, { optional: true }))
          if (command && command.sequence > sequence) {
            sequence = command.sequence
            if (command.type === "enable-refresh") {
              yield* enable()
              revision = 2
              yield* ctx.tool.reload()
              assert.deepEqual(copy(describe(initial)), initialCopy, "reload mutated an already-read catalog")
              record.initialCatalogRetained = true
            } else if (command.type === "retain-mcp-catalog") {
              retainedMcpCatalog = yield* ctx.tool.list()
              retainedMcpValue = copy(describe(retainedMcpCatalog))
              record.retainedMcpCatalog = retainedMcpValue
            } else if (command.type === "release-A") record.releaseA = true
            else if (command.type === "dispose-profile-and-custom") {
              assert.ok(profile && contextHook && custom)
              yield* contextHook.dispose
              yield* profile.dispose
              yield* profile.dispose // Public disposal is idempotent.
              profile = undefined
              yield* custom.dispose
              yield* custom.dispose
            } else if (command.type !== "catalog") throw Error(`Unknown server control: ${command.type}`)
            yield* catalog(command.type)
            record.commands.push({ sequence, type: command.type })
            yield* publish()
          }
          yield* Effect.sleep("40 millis")
        }
      }).pipe(Effect.tapCause(reportCause), Effect.forkScoped)
    }).pipe(Effect.tapCause(reportCause))
  })
}

function cliSetup(ctx) {
  const publisher = observationPublisher(ctx.options.observation), abort = new AbortController(), tasks = new Set()
  const record = { version: ctx.app.version, errors: [], asked: [], linked: [], replied: [], events: [], commands: [], writes: [] }
  const publish = () => publisher.publish(record)
  const options = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
  const own = fn => {
    const task = Promise.resolve().then(fn).catch(error => {
      if (!abort.signal.aborted) record.errors.push(String(error))
    }).finally(() => { tasks.delete(task); void publish() })
    tasks.add(task)
  }
  const stop = ctx.data.listen(({ details: event }) => {
    if (event.type.startsWith("session.execution.") || event.type.startsWith("permission."))
      record.events.push({ type: event.type, data: event.data })
    if (event.type === "permission.replied") record.replied.push(event.data)
    if (event.type === "permission.asked") {
      const request = event.data
      record.asked.push(request)
      own(async () => {
        const message = await ctx.client.session.message.get({ sessionID: request.sessionID, messageID: request.source.messageID }, options())
        const pending = await ctx.client.permission.get({ sessionID: request.sessionID, requestID: request.id }, options())
        record.linked.push({ request, message, pending })
      })
    }
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
          value = await ctx.client.session.prompt({ sessionID: session.id, text: "Run the isolated W1 synthetic tool probe." }, options())
        } else if (command.type === "reply") {
          const request = record.asked.find(item => item.id === command.requestID)
          assert.ok(request, "reply must target an observed fixture request")
          const input = { sessionID: request.sessionID, requestID: request.id }
          assert.deepEqual(await ctx.client.permission.get(input, options()), request)
          assert.equal(record.writes.some(item => item.requestID === request.id), false)
          record.writes.push(input)
          await publish()
          // One write, with no retry, using the generated public client shape.
          await ctx.client.permission.reply({ ...input, decision: "once" }, options())
        } else if (command.type === "read") {
          value = await ctx.client.session.message.get({ sessionID: command.sessionID, messageID: command.messageID }, options())
        } else if (command.type === "interrupt") {
          await ctx.client.session.interrupt({ sessionID: command.sessionID, continue: false }, options())
        } else if (command.type === "pending") {
          value = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
        } else if (command.type === "prompt") {
          value = await ctx.client.session.prompt({ sessionID: command.sessionID, text: "W1 future snapshot after disposal." }, options())
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
    await Promise.allSettled([...tasks])
    record.cleaned = true
    await publish()
    await publisher.close()
  }
}

runtimeArguments("smoke-v2-direct-tools.mjs")
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assertV2HostVersion(version)
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-direct-tools-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-direct-tools-")
const project = path.join(temp, "project"), external = path.join(temp, "external"), plugin = path.join(temp, "probe")
await Promise.all([mkdir(project), mkdir(external), mkdir(plugin), mkdir(path.join(temp, "config/opencode"), { recursive: true })])
execFileSync("git", ["init", "--quiet", project])
await writeFile(path.join(external, "fixture.py"), 'with open("executed", "a") as output:\n    output.write("once\\n")\nprint("W1 native shell result")\n')
await writeFile(path.join(project, "w1-discovery.txt"), "W1_NATIVE_DISCOVERY_SENTINEL\n")
const files = Object.fromEntries(["server", "cli", "server-control", "cli-control"].map(name => [name, path.join(artifacts, `${name}.json`)]))
const publisherImport = JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)
const imports = `import assert from 'node:assert/strict'\nimport { setTimeout as sleep } from 'node:timers/promises'\nimport { observationPublisher, readObservation } from ${publisherImport}\n`
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-direct-tools", type: "module",
  exports: { ".": "./server.mjs", "./tui": "./tui.mjs" } }))
// promise/tool publicly re-exports the shared Tool.Error class only. The server
// uses no Promise plugin adapter or Promise tool-domain methods.
await writeFile(path.join(plugin, "server.mjs"), `${imports}import { Plugin } from '@opencode/plugin/effect'\nimport { Error as ToolError } from '@opencode/plugin/promise/tool'\nimport { Cause, Deferred, Effect } from 'effect'\n${serverEffect}\nexport default Plugin.define({id:'research.v2.direct.server',effect:serverEffect})\n`)
await writeFile(path.join(plugin, "tui.mjs"), `${imports}import { Plugin } from '@opencode/plugin/tui'\n${cliSetup}\nexport default Plugin.define({id:'research.v2.direct.cli',setup:cliSetup})\n`)

const calls = [], mcpCalls = [], errors = [], waiting = new Map()
const mcpSessions = new Map(), mcpWire = { streams: [], notifications: [], catalogs: [], results: [] }
let mcpRevision = 1, mcpSessionSequence = 0
const controlPublishers = { server: observationPublisher(files["server-control"]), cli: observationPublisher(files["cli-control"]) }
const sequences = { server: 0, cli: 0 }
const toolName = "w1_call", failureToolName = "w1_failure", mcpName = "w1_mcp_echo-item", newMcpName = "w1_mcp_catalog-item"
const missingInput = { path: "w1-absent-input.txt" }, errorEquivalence = {}, discovery = {}, mcpRefresh = {}
const mcpCatalog = () => ({ tools: [{ name: "echo-item", description: `W1 local synthetic echo revision ${mcpRevision}`,
  inputSchema: { type: "object", properties: { payload: { type: "string" },
    ...(mcpRevision === 2 ? { revision: { type: "integer", enum: [2] } } : {}) },
    required: mcpRevision === 2 ? ["payload", "revision"] : ["payload"], additionalProperties: false } },
  ...(mcpRevision === 2 ? [{ name: "catalog-item", description: "W1 newly discovered tool revision 2",
    inputSchema: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"], additionalProperties: false } }] : [])] })
const response = (res, body, toolCalls, content = "W1 fixture finished") => {
  const message = toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls.map((call, index) => ({
    index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) },
  })) } : { role: "assistant", content }
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[message, null], [{}, toolCalls ? "tool_calls" : "stop"]])
      res.write(`data: ${JSON.stringify({ id: "w1-fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    res.end("data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: toolCalls ? "tool_calls" : "stop" }] }))
  }
}
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname
    if (pathname === "/mcp" && req.method !== "POST") {
      const sessionID = req.headers["mcp-session-id"], session = mcpSessions.get(sessionID)
      if (!session) { res.writeHead(404); res.end(); return }
      if (req.method === "DELETE") {
        for (const stream of session.streams) stream.end()
        mcpSessions.delete(sessionID)
        res.writeHead(204); res.end(); return
      }
      if (req.method !== "GET") { res.writeHead(405); res.end(); return }
      const streamRecord = { sessionID, openedRevision: mcpRevision, closed: false }
      mcpWire.streams.push(streamRecord)
      session.streams.add(res)
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" })
      res.write(": W1 owned catalog notification stream\n\n")
      res.once("close", () => { streamRecord.closed = true; session.streams.delete(res) })
      return
    }
    let text = ""
    for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024, "fixture request exceeded bound") }
    const body = JSON.parse(text)
    if (pathname === "/mcp") {
      mcpCalls.push(body)
      if (body.id === undefined) { res.writeHead(202); res.end(); return }
      let result
      if (body.method === "initialize") {
        const sessionID = `w1-mcp-${++mcpSessionSequence}`
        mcpSessions.set(sessionID, { streams: new Set() })
        res.setHeader("mcp-session-id", sessionID)
        result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "w1-mcp", version: "1" } }
      } else if (body.method === "tools/list") {
        result = mcpCatalog()
        mcpWire.catalogs.push({ revision: mcpRevision, sessionID: req.headers["mcp-session-id"], request: body, response: result })
      }
      else if (body.method === "tools/call") {
        assert.ok(["echo-item", "catalog-item"].includes(body.params.name))
        // The remote service intentionally accepts old echo arguments too. This
        // tests host snapshot validation, not immutable remote server behavior.
        if (body.params.name === "catalog-item") assert.equal(mcpRevision, 2)
        if (body.params.arguments.revision !== undefined) assert.equal(body.params.arguments.revision, 2)
        result = { content: [{ type: "text", text: `W1 MCP ${body.params.name} revision ${mcpRevision} ${body.params.arguments.payload}` }] }
        mcpWire.results.push({ revision: mcpRevision, request: body, response: result })
      } else if (body.method === "ping") result = {}
      else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown fixture method" } })); return }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
      return
    }
    assert.equal(req.url, "/v1/chat/completions")
    if (!body.tools?.length) { response(res, body, undefined, "W1 title"); return }
    const index = calls.length
    calls.push({ index, body })
    // Retain a real in-flight model request across profile changes. The driver
    // chooses exactly when its synthetic response crosses the host boundary.
    waiting.set(index, { res, body })
    res.once("close", () => {
      if (waiting.has(index)) { calls[index].aborted = true; waiting.delete(index) }
    })
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-direct-tools")
const observations = async () => {
  const [serverRecord, cli] = await Promise.all([readObservation(files.server, { optional: true }), readObservation(files.cli, { optional: true })])
  assert.deepEqual(errors, [])
  for (const value of [serverRecord, cli]) if (value) assert.deepEqual(value.errors, [])
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
  const result = await until(`${target} ${command.type}`, value => value[target]?.commands.some(item => item.sequence === sequence))
  return result[target].commands.find(item => item.sequence === sequence).value
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
const call = (id, label, payload) => ({ id, name: toolName, input: { label, payload } })
const names = body => body.tools.map(tool => tool.function.name)
const sourceItem = (message, source) => {
  assert.equal(message.type, "assistant")
  assert.equal(message.id, source.messageID)
  const matches = message.content.filter(item => item.type === "tool" && item.id === source.id)
  assert.equal(matches.length, 1, "source must select exactly one assistant item")
  return matches[0]
}
const errorControl = async (id, name, input, message) => {
  const observed = await until(`typed execute.after error for ${id}`, value => value.server?.after.some(item => item.id === id && item.status === "error"))
  const hooks = observed.server.after.filter(item => item.id === id)
  assert.equal(hooks.length, 1, "error control must execute and settle exactly once")
  const hook = hooks[0]
  assert.equal(hook.tool, name)
  assert.deepEqual(hook.input, input)
  assert.equal(hook.error._tag, "Tool.Error", "failure must remain typed, not become a defect")
  assert.equal(hook.error.message, message)
  const before = observed.server.before.filter(item => item.id === id)
  assert.equal(before.length, 1)
  assert.equal(before[0].messageID, hook.messageID)
  assert.equal(before[0].sessionID, hook.sessionID)
  assert.equal(before[0].tool, name)
  assert.deepEqual(before[0].input, input)
  let item
  await until(`durable error item for ${id}`, async () => {
    const value = await control("cli", { type: "read", sessionID: hook.sessionID, messageID: hook.messageID })
    item = sourceItem(value, hook)
    return item.state.status === "error"
  })
  assert.equal(item.name, name)
  assert.deepEqual(item.state.input, input)
  assert.equal(item.state.error.message, message)
  return { hook, item }
}
const modelError = (body, id, message) => {
  const results = body.messages.filter(item => item.role === "tool" && item.tool_call_id === id)
  assert.equal(results.length, 1, "next request must contain this exact failed call's result")
  assert.ok(JSON.stringify(results[0].content).includes(message), "model-facing error text must survive")
  return results[0]
}
const completedControl = async (expected, body) => {
  const observed = await until(`completed ${expected.id}`, value => value.server?.after.some(item => item.id === expected.id && item.status === "completed"))
  const hooks = observed.server.after.filter(item => item.id === expected.id)
  assert.equal(hooks.length, 1)
  const hook = hooks[0]
  assert.equal(hook.tool, expected.name)
  assert.deepEqual(hook.input, expected.input)
  let item
  await until(`durable completion ${expected.id}`, async () => {
    item = sourceItem(await control("cli", { type: "read", sessionID: hook.sessionID, messageID: hook.messageID }), hook)
    return item.state.status === "completed"
  })
  assert.equal(item.name, expected.name)
  assert.deepEqual(item.state.input, expected.input)
  const result = { hook, item }
  if (body) {
    const messages = body.messages.filter(item => item.role === "tool" && item.tool_call_id === expected.id)
    assert.equal(messages.length, 1)
    result.modelResult = messages[0]
  }
  return result
}
const approveCall = async expected => {
  const observed = await until(`permission for ${expected.id}`, value => value.cli?.linked.some(item => item.request.source.id === expected.id))
  const link = observed.cli.linked.find(item => item.request.source.id === expected.id)
  assert.equal(link.request.action, expected.name)
  assert.deepEqual(link.request, link.pending)
  const item = sourceItem(link.message, link.request.source)
  assert.equal(item.name, expected.name)
  assert.equal(item.state.status, "running")
  assert.deepEqual(item.state.input, expected.input)
  await control("cli", { type: "reply", requestID: link.request.id })
  return link
}
const limitations = [
  "Synthetic fixture only; no production reviewer, provider limits, real catalog cost, or reviewer transport assertions.",
  "Custom staged tool explicitly delegates to the public shell executor; it is not evidence of native/custom provenance or unchanged native shell arguments.",
  "Two distinct wrapper inputs intentionally use the same underlying shell command/workdir to obtain identical permission scopes.",
  "Profile uses audited fixture registrations; later arbitrary third-party executor/argument rewrites are not excluded.",
  "Refresh covers tool.reload and an actual MCP tools/list_changed SSE notification. Plugin unload/reload, aliases, and namespace collisions are not covered.",
  "Retained old Code Mode calls are asserted ambiguous at the outer source ID, never relabeled as direct.",
  "Effect profile asserts committed-editor executor/schema identity for each transform pass. Registry replay may independently recreate source registrations.",
  "Error equivalence covers a typed custom failure and actual native missing-file read; it does not establish equivalence for every native failure kind or Promise-plugin defect.",
  "Cancellation exercises native Effect interruption, pending-request removal and no shell execution, not a Promise-tool AbortSignal adapter.",
  "Code Mode tool-catalog search is unavailable while execute is removed. Native glob/grep and model discovery remain directly callable; this is not tool-search parity.",
  "Retained MCP definitions/executors do not freeze remote service behavior. The synthetic endpoint accepts legacy echo inputs after its catalog changes.",
]
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", update: "disable",
    plugins: [{ package: plugin, options: { observation: files.server, control: files["server-control"], external } }],
    permissions: [{ action: "external_directory", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" },
      { action: mcpName, resource: "*", effect: "ask" }, { action: newMcpName, resource: "*", effect: "ask" }],
    mcp: { servers: { "w1.mcp": { type: "remote", url: `${baseURL}/mcp`, oauth: false } } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${baseURL}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  const cli = { animations: false, attention: { notifications: false, sound: false },
    plugins: [{ package: plugin, options: { observation: files.cli, control: files["cli-control"] } }] }
  const cliPath = path.join(temp, "config/opencode/cli.json")
  await writeFile(cliPath, JSON.stringify(cli))
  const launch = ["-d", "-s", "v2-direct-tools", "-x", "160", "-y", "40", "-c", project,
    host, "--standalone", project]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, temp, config, cli, launch,
    socket: runtime.socket, supervisorPID: runtime.supervisorPID, limitations }, null, 2))
  await runtime.start(...launch)
  await control("cli", { type: "start" })

  // Baselines execute before profile registration, with real host tool dispatch,
  // execute.after errors, durable error items and a subsequent model request.
  const baseline = await modelRequest(0)
  assert.ok(names(baseline).includes(failureToolName) && names(baseline).includes("read"))
  await assert.rejects(readFile(path.join(project, missingInput.path)), { code: "ENOENT" })
  respond(0, [{ id: "baseline-error", name: failureToolName, input: {} }, { id: "baseline-read", name: "read", input: missingInput }])
  const old = await modelRequest(1)
  errorEquivalence.baseline = {
    custom: await errorControl("baseline-error", failureToolName, {}, "W1 sentinel tool failure"),
    nativeRead: await errorControl("baseline-read", "read", missingInput, `File not found: ${missingInput.path}`),
  }
  assert.deepEqual(errorEquivalence.baseline.custom.hook.error.metadata, { fixture: "typed-failure" })
  errorEquivalence.baseline.custom.modelResult = modelError(old, "baseline-error", "W1 sentinel tool failure")
  errorEquivalence.baseline.nativeRead.modelResult = modelError(old, "baseline-read", `File not found: ${missingInput.path}`)
  assert.equal((await observations()).server.transforms.length, 0, "baseline must precede profile registration")
  assert.ok(names(old).includes("execute"))
  assert.equal(names(old).includes(toolName), false)
  await control("server", { type: "enable-refresh" })
  const enabled = (await observations()).server
  assert.equal(enabled.initialCatalogRetained, true)
  const catalog = enabled.catalogs.at(-1).tools
  assert.equal(catalog.find(tool => tool.id === toolName).description, "W1 fixture revision 2")
  assert.deepEqual(catalog.find(tool => tool.id === toolName).options, { namespace: "w1", permission: "w1_fixture", codemode: false })
  assert.equal(catalog.find(tool => tool.id === mcpName)?.options.codemode, false, "namespaced MCP must participate in the profile")
  assert.ok(enabled.transforms.some(pass => pass.changed.some(tool => tool.before?.pinned === true)), "exercise pinned removal")
  assert.ok(enabled.transforms.every(pass => pass.changed.every(tool => tool.executorIdentical && tool.inputIdentical && tool.outputIdentical)))
  assert.ok(enabled.transforms.every(pass => ["shell", "read", toolName, failureToolName, mcpName].every(id => pass.changed.some(tool => tool.id === id))))
  respond(1, [{ id: "old-outer", name: "execute", input: { code:
    'const found=search({namespace:"w1",query:"call"}); const calls=await Promise.allSettled([tools.w1.call({label:"old-left",payload:"left"}),tools.w1.call({label:"old-right",payload:"right"})]); return {found,calls};' } }])
  const direct = await modelRequest(2)
  const oldInvocations = (await observations()).server.invocations.filter(item => item.input.label.startsWith("old-"))
  assert.equal(oldInvocations.length, 2)
  assert.ok(oldInvocations.every(item => item.revision === 1 && item.completed), "old executable snapshot retained revision 1")
  assert.equal(oldInvocations[0].id, oldInvocations[1].id, "nested calls retain their ambiguous shared outer source")
  const sessionID = oldInvocations[0].sessionID
  assert.equal(sessionID, errorEquivalence.baseline.custom.hook.sessionID)
  assert.equal(sessionID, errorEquivalence.baseline.nativeRead.hook.sessionID)
  const oldMessage = await control("cli", { type: "read", sessionID, messageID: oldInvocations[0].messageID })
  assert.equal(sourceItem(oldMessage, oldInvocations[0]).name, "execute")
  assert.equal(names(direct).includes("execute"), false)
  assert.ok(names(direct).includes(toolName) && names(direct).includes(mcpName))
  assert.deepEqual(direct.tools.find(tool => tool.function.name === toolName).function.parameters,
    { type: "object", properties: { label: { type: "string" }, payload: { type: "string" } }, required: ["label", "payload"], additionalProperties: false })
  const oldSearch = (await observations()).server.after.find(item => item.id === "old-outer" && item.tool === "execute")
  assert.equal(oldSearch.status, "completed")
  discovery.oldCodeModeSearch = JSON.parse(oldSearch.result.output.output).found
  assert.ok(discovery.oldCodeModeSearch.items.some(item => item.path === "tools.w1.call" && item.description === "W1 fixture revision 1"))
  discovery.direct = { toolNames: names(direct), publicCatalogIDs: catalog.map(tool => tool.id),
    instructionMentionsSearch: JSON.stringify(direct.messages.filter(item => ["system", "developer"].includes(item.role))).includes("search(") }
  assert.equal(discovery.direct.toolNames.includes("search"), false)
  assert.equal(discovery.direct.publicCatalogIDs.includes("search"), false)
  assert.ok(["glob", "grep", "opencode_models"].every(name => discovery.direct.toolNames.includes(name)))

  // Hold an actual v1 MCP model-request snapshot while a server notification
  // changes the catalog, without calling tool.reload or mcp.reload ourselves.
  await control("server", { type: "retain-mcp-catalog" })
  await until("owned MCP notification GET", () => [...mcpSessions.values()].some(session => session.streams.size))
  mcpRefresh.oldDefinition = direct.tools.find(tool => tool.function.name === mcpName)
  assert.deepEqual(mcpRefresh.oldDefinition.function.parameters.required, ["payload"])
  assert.equal(names(direct).includes(newMcpName), false)
  mcpRefresh.before = (await observations()).server.catalogs.at(-1)
  const previousCatalogCount = mcpWire.catalogs.length
  mcpRevision = 2
  const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" }
  for (const [sessionID, session] of mcpSessions) {
    for (const stream of session.streams) {
      mcpWire.notifications.push({ sessionID, revision: mcpRevision, notification })
      stream.write(`event: message\ndata: ${JSON.stringify(notification)}\n\n`)
    }
  }
  await until("notification triggers a changed tools/list response", () => mcpWire.catalogs.length > previousCatalogCount && mcpWire.catalogs.at(-1).revision === 2)
  await until("profile replays after actual MCP discovery refresh", async () => {
    await control("server", { type: "catalog" })
    const current = (await observations()).server.catalogs.at(-1)
    if (!current.tools.some(tool => tool.id === newMcpName)) return false
    mcpRefresh.after = current
    return true
  })
  for (const name of [mcpName, newMcpName]) assert.equal(mcpRefresh.after.tools.find(tool => tool.id === name).options.codemode, false)
  assert.deepEqual(mcpRefresh.after.tools.find(tool => tool.id === mcpName).input.required, ["payload", "revision"])
  assert.equal((await observations()).server.retainedMcpCatalogUnchanged, true)
  assert.deepEqual(direct.tools.find(tool => tool.function.name === mcpName), mcpRefresh.oldDefinition)

  const parallel = [call("direct-A", "A", "alpha"), call("direct-B", "B", "beta"),
    { id: "direct-mcp", name: mcpName, input: { payload: "namespace-check" } },
    { id: "transformed-error", name: failureToolName, input: {} }, { id: "transformed-read", name: "read", input: missingInput }]
  respond(2, parallel)
  const heldB = await until("both executors started and B directory published first", value =>
    value.server?.invocations.filter(item => ["A", "B"].includes(item.input.label)).length === 2 &&
    value.cli?.linked.some(item => item.request.action === "external_directory"))
  const firstDirectory = heldB.cli.linked.find(item => item.request.action === "external_directory")
  assert.equal(sourceItem(firstDirectory.message, firstDirectory.request.source).state.input.label, "B")
  assert.equal(heldB.cli.asked.filter(item => item.action === "external_directory").length, 1)
  await control("server", { type: "release-A" })
  const held = await until("two separate directory requests and MCP request", value => value.cli?.linked.length === 3)
  const directories = held.cli.asked.filter(item => item.action === "external_directory")
  assert.equal(directories.length, 2)
  assert.deepEqual(directories[0].resources, directories[1].resources)
  assert.notEqual(directories[0].source.id, directories[1].source.id)
  assert.equal(new Set(directories.map(item => item.id)).size, 2)
  for (const link of held.cli.linked) {
    assert.deepEqual(link.request, link.pending)
    assert.equal(link.request.sessionID, sessionID)
    const item = sourceItem(link.message, link.request.source)
    assert.equal(item.state.status, "running")
    const expected = parallel.find(call => call.id === item.id)
    assert.ok(expected, "permission must reference the exact model call ID")
    assert.equal(item.name, expected.name)
    assert.deepEqual(item.state.input, expected.input)
    const hooks = held.server.before.filter(hook => hook.id === item.id && hook.messageID === link.message.id)
    assert.equal(hooks.length, 1)
    assert.equal(hooks[0].sessionID, sessionID)
    assert.equal(hooks[0].tool, expected.name)
    assert.deepEqual(hooks[0].input, expected.input)
  }
  // Both requests are outstanding together. This is an actual negative window,
  // not an inference from the absence of a result in a single snapshot.
  const end = Date.now() + 1500
  do {
    const value = await observations()
    assert.deepEqual(value.cli.writes, [])
    assert.equal(mcpCalls.filter(call => call.method === "tools/call").length, 0)
    await assert.rejects(readFile(path.join(external, "executed")), { code: "ENOENT" })
    await sleep(75)
  } while (Date.now() < end)
  await writeFile(path.join(artifacts, "parallel-pending.txt"), capture())
  for (const directory of directories) {
    await control("cli", { type: "reply", requestID: directory.id })
    await until("independent shell stage", value => value.cli?.linked.some(item =>
      item.request.action === "shell" && item.request.source.id === directory.source.id))
  }
  const staged = (await observations()).cli
  const operations = staged.asked.filter(item => item.action === "shell")
  assert.equal(operations.length, 2)
  assert.deepEqual(operations[0].resources, operations[1].resources)
  assert.deepEqual(operations.map(item => item.source.id), directories.map(item => item.source.id))
  assert.equal(new Set([...directories, ...operations].map(item => item.id)).size, 4, "stages must have independent permission IDs")
  for (const link of staged.linked.filter(item => item.request.action === "shell")) {
    const expected = parallel.find(call => call.id === link.request.source.id)
    assert.deepEqual(sourceItem(link.message, link.request.source).state.input, expected.input)
  }
  for (const request of [...operations, staged.asked.find(item => item.action === mcpName)]) {
    assert.ok(request)
    await control("cli", { type: "reply", requestID: request.id })
  }
  const refreshed = await modelRequest(3)
  errorEquivalence.transformed = {
    custom: await errorControl("transformed-error", failureToolName, {}, "W1 sentinel tool failure"),
    nativeRead: await errorControl("transformed-read", "read", missingInput, `File not found: ${missingInput.path}`),
  }
  for (const kind of ["custom", "nativeRead"]) {
    const before = errorEquivalence.baseline[kind], after = errorEquivalence.transformed[kind]
    assert.equal(after.hook.sessionID, before.hook.sessionID)
    assert.deepEqual(after.hook.error, before.hook.error, `${kind} typed execute.after error must be unchanged`)
    assert.deepEqual(after.item.state.error, before.item.state.error, `${kind} durable error must be unchanged`)
    assert.deepEqual(after.item.state.metadata, before.item.state.metadata, `${kind} failure metadata must be unchanged`)
  }
  errorEquivalence.transformed.custom.modelResult = modelError(refreshed, "transformed-error", "W1 sentinel tool failure")
  errorEquivalence.transformed.nativeRead.modelResult = modelError(refreshed, "transformed-read", `File not found: ${missingInput.path}`)
  for (const kind of ["custom", "nativeRead"])
    assert.deepEqual(errorEquivalence.transformed[kind].modelResult.content, errorEquivalence.baseline[kind].modelResult.content,
      `${kind} model-facing error result must be unchanged`)
  assert.equal(await readFile(path.join(external, "executed"), "utf8"), "once\nonce\n")
  assert.equal(mcpCalls.filter(call => call.method === "tools/call").length, 1)
  assert.deepEqual(mcpCalls.find(call => call.method === "tools/call").params.arguments, { payload: "namespace-check" })
  const completed = (await observations()).server
  for (const label of ["A", "B"]) {
    const items = completed.invocations.filter(item => item.input.label === label)
    assert.equal(items.length, 1)
    assert.equal(items[0].revision, 2)
    assert.equal(items[0].bothStarted, true)
    assert.equal(items[0].completed, true)
    assert.match(JSON.stringify(items[0].shellResult), /W1 native shell result/)
  }
  assert.equal((await observations()).cli.writes.length, 5, "original staged/native MCP path still makes five once replies")
  mcpRefresh.retainedCall = await completedControl(parallel.find(item => item.id === "direct-mcp"), refreshed)
  assert.equal(mcpWire.results[0].revision, 2, "old snapshot executes after the remote catalog changed")
  assert.deepEqual(mcpWire.results[0].request.params.arguments, { payload: "namespace-check" })
  assert.ok(names(refreshed).includes(newMcpName))
  assert.equal(names(refreshed).includes("execute"), false)
  assert.deepEqual(refreshed.tools.find(tool => tool.function.name === mcpName).function.parameters.required, ["payload", "revision"])
  mcpRefresh.newDefinition = refreshed.tools.find(tool => tool.function.name === newMcpName)
  const refreshedCalls = [
    { id: "refreshed-echo", name: mcpName, input: { payload: "new-schema", revision: 2 } },
    { id: "refreshed-new", name: newMcpName, input: { payload: "new-catalog-tool" } },
    { id: "discovery-glob", name: "glob", input: { pattern: "w1-discovery.txt" } },
    { id: "discovery-grep", name: "grep", input: { pattern: "W1_NATIVE_DISCOVERY_SENTINEL", path: "w1-discovery.txt", literal: true } },
    { id: "discovery-models", name: "opencode_models", input: { query: "fixture", provider: "fixture", limit: 5 } },
  ]
  respond(3, refreshedCalls)
  mcpRefresh.refreshedPermissions = []
  for (const expected of refreshedCalls.slice(0, 2)) mcpRefresh.refreshedPermissions.push(await approveCall(expected))
  const retainedDirect = await modelRequest(4)
  mcpRefresh.refreshedCalls = []
  for (const expected of refreshedCalls.slice(0, 2)) mcpRefresh.refreshedCalls.push(await completedControl(expected, retainedDirect))
  discovery.native = {}
  for (const expected of refreshedCalls.slice(2)) discovery.native[expected.name] = await completedControl(expected, retainedDirect)
  assert.ok(discovery.native.glob.hook.result.output.some(item => item.path.endsWith("w1-discovery.txt")))
  assert.ok(discovery.native.grep.hook.result.output.some(item => item.line === 1 && item.text.includes("W1_NATIVE_DISCOVERY_SENTINEL")))
  assert.ok(discovery.native.opencode_models.hook.result.output.providers.some(provider =>
    provider.id === "fixture" && provider.models.some(model => model.id === "fixture/fixture")))
  assert.equal(mcpRefresh.refreshedCalls[0].hook.result.output, "W1 MCP echo-item revision 2 new-schema")
  assert.equal(mcpRefresh.refreshedCalls[1].hook.result.output, "W1 MCP catalog-item revision 2 new-catalog-tool")

  // Dispose the transforms after an outgoing direct request has captured them.
  // That request must still run the old executors, including errors and interruption.
  assert.ok(names(retainedDirect).includes(toolName))
  await control("server", { type: "dispose-profile-and-custom" })
  const disposed = (await observations()).server.catalogs.at(-1).tools
  assert.equal(disposed.some(tool => tool.id === toolName), false)
  assert.equal(disposed.find(tool => tool.id === mcpName).options.codemode, true)
  assert.equal(disposed.find(tool => tool.id === newMcpName).options.codemode, true)
  assert.equal((await observations()).server.retainedMcpCatalogUnchanged, true)
  mcpRefresh.afterDisposal = (await observations()).server.catalogs.at(-1)
  const retainedMcpCall = { id: "retained-mcp", name: newMcpName, input: { payload: "after-profile-disposal" } }
  respond(4, [call("direct-error", "error", "error-sentinel"), call("direct-cancel", "cancel", "abort-sentinel"), retainedMcpCall])
  mcpRefresh.retainedAfterDisposalPermission = await approveCall(retainedMcpCall)
  mcpRefresh.retainedAfterDisposal = await completedControl(retainedMcpCall)
  assert.equal(mcpRefresh.retainedAfterDisposal.hook.result.output, "W1 MCP catalog-item revision 2 after-profile-disposal")
  const failing = await until("retained error and cancel executors", value =>
    value.server?.after.some(item => item.id === "direct-error" && item.status === "error") &&
    value.server?.invocations.some(item => item.input.label === "cancel" && item.waitingForInterrupt) &&
    value.cli?.linked.some(item => item.request.source.id === "direct-cancel"))
  const failure = failing.server.after.find(item => item.id === "direct-error")
  assert.equal(failure.error.message, "W1 sentinel tool failure")
  assert.deepEqual(failure.error, errorEquivalence.baseline.custom.hook.error, "retained executor keeps the typed failure after disposal")
  const cancelLink = failing.cli.linked.find(item => item.request.source.id === "direct-cancel")
  assert.equal(cancelLink.request.action, "external_directory")
  assert.deepEqual(sourceItem(cancelLink.message, cancelLink.request.source).state.input,
    { label: "cancel", payload: "abort-sentinel" })
  let errorMessage
  await until("durable error item after execution hook", async () => {
    errorMessage = await control("cli", { type: "read", sessionID, messageID: failure.messageID })
    return sourceItem(errorMessage, failure).state.status === "error"
  })
  const errorItem = sourceItem(errorMessage, failure)
  assert.equal(errorItem.state.status, "error")
  assert.deepEqual(errorItem.state.error, errorEquivalence.baseline.custom.item.state.error)
  await control("cli", { type: "interrupt", sessionID })
  const canceled = await until("native Effect interruption propagation", value => value.server?.invocations.some(item =>
    item.input.label === "cancel" && item.interrupted && item.settled))
  assert.equal(canceled.server.invocations.find(item => item.input.label === "cancel").completed, false)
  assert.ok(canceled.server.invocations.filter(item => ["error", "cancel"].includes(item.input.label)).every(item => item.revision === 2))
  assert.deepEqual(await control("cli", { type: "pending", sessionID }), [])
  assert.equal(await readFile(path.join(external, "executed"), "utf8"), "once\nonce\n", "cancellation must not execute the held native operation")
  assert.equal(canceled.cli.writes.some(item => item.requestID === cancelLink.request.id), false)
  await control("cli", { type: "prompt", sessionID })
  const future = await modelRequest(5)
  assert.ok(names(future).includes("execute"), "disposing context hook restores generated execute")
  assert.equal(names(future).includes(toolName), false)
  assert.equal(names(future).includes(failureToolName), false)
  assert.equal(names(future).includes(mcpName), false, "disposing profile restores MCP Code Mode presentation")
  assert.equal(names(future).includes(newMcpName), false)
  respond(5, [{ id: "restored-search", name: "execute", input: { code: 'return search({namespace:"w1_mcp",query:"catalog-item"});' } }])
  const finished = await modelRequest(6)
  const restoredSearch = await completedControl({ id: "restored-search", name: "execute", input: { code: 'return search({namespace:"w1_mcp",query:"catalog-item"});' } }, finished)
  discovery.restoredCodeModeSearch = JSON.parse(restoredSearch.hook.result.output.output)
  assert.ok(discovery.restoredCodeModeSearch.items.some(item => item.path === 'tools.w1_mcp["catalog-item"]' && item.description === "W1 newly discovered tool revision 2"))
  respond(6)
  await until("final turn completed", value => value.cli?.events.some(event => event.type === "session.execution.succeeded"))
  await writeFile(cliPath, JSON.stringify({ ...cli, plugins: ["*", "-research.v2.direct.cli"] }))
  const cleaned = (await until("CLI unload drains observers", value => value.cli?.cleaned)).cli
  await sleep(500)
  assert.deepEqual(await readObservation(files.cli), cleaned)
  assert.equal(cleaned.writes.length, 8)
  assert.equal(cleaned.replied.length, 8)
  assert.equal(mcpCalls.filter(call => call.method === "tools/call").length, 4)
  const final = await observations()
  assert.ok(final.server.contexts.length >= 2)
  assert.ok(final.server.contexts.every(item => item.before.includes("execute") && !item.after.includes("execute")))
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, temp,
    assertions: ["old Code Mode request retained across activation/reload", "old nested calls remain outer-ID ambiguous",
      "Effect options-only transform preserves committed executor/schema identity and removes pinned",
      "baseline/transformed typed custom and native missing-read errors match in hooks and durable items",
      "baseline/transformed failures reach subsequent model context", "reload preserves prior catalog values", "direct model-facing schemas",
      "two concurrent same-tool calls with distinct inputs and identical scopes", "reverse directory and operation publication",
      "exact public source/argument matching", "four distinct staged permission IDs", "1500ms no-execution window",
      "eight once-only replies including original five-reply path", "namespaced local MCP direct call", "retained direct executors after registration disposal",
      "MCP SSE list_changed fetches changed/new tools and replays the profile", "old MCP request schema/source survives catalog refresh",
      "refreshed MCP direct tools execute and retained snapshot survives profile disposal", "native glob/grep/model discovery executes directly",
      "Code Mode tool search works before/after the profile and is unavailable in direct presentation",
      "typed error propagation", "native Effect interruption removes pending permission without execution",
      "future snapshot restores Code Mode", "CLI observer cleanup"],
    limitations, errorEquivalence, mcpRefresh, mcpWire, discovery, calls, mcpCalls, observations: final }, null, 2))
  console.log(`PASS V2 direct tools: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  try { await writeFile(path.join(artifacts, "failed.txt"), capture()) } catch { /* Host may have exited. */ }
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, errors,
    calls, mcpCalls, limitations, errorEquivalence, mcpRefresh, mcpWire, discovery,
    observations: await Promise.all([readObservation(files.server, { optional: true }), readObservation(files.cli, { optional: true })]).catch(() => null) }, null, 2))
  throw error
} finally {
  try { await Promise.all(Object.values(controlPublishers).map(publisher => publisher.close())) }
  finally {
    try { await runtime.dispose() }
    finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }
}
