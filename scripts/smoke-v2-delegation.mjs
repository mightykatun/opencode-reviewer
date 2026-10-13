// W4 synthetic delegation probe, stock OpenCode 2.0.26, public APIs only.
// Inventory owner registers exactly initial-resume (default) and coalesced, no flags.
// No native executor wrapping, prompt/metadata rewriting, or permission replies.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

// Serialize real function bodies so node --check also checks plugin syntax.
function serverEffect(ctx) {
  return Effect.gen(function* () {
    const publisher = observationPublisher(ctx.options.observation)
    const copy = value => JSON.parse(JSON.stringify(value))
    const record = { version: ctx.app.version, errors: [], prompts: [], contexts: [], before: [], after: [], returns: [] }
    const publish = () => Effect.promise(() => publisher.publish(record))
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      record.cleaned = true
      yield* publish()
      yield* Effect.promise(() => publisher.close())
    }))
    yield* Effect.gen(function* () {
      yield* ctx.tool.transform(editor => editor.add({
        name: "w4_return", description: "Return synthetic fixture text without any side effects.",
        input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
        execute: (_input, context) => Effect.gen(function* () {
          record.returns.push({ sessionID: context.sessionID, messageID: context.messageID, id: context.id })
          yield* publish()
          return { content: "W4_TOOL_ONLY_RESULT" }
        }),
      }))
      yield* ctx.session.hook("title", event => Effect.sync(() => { event.result = "W4 delegation" }))
      yield* ctx.session.hook("prompt", event => Effect.gen(function* () {
        record.prompts.push(copy(event))
        yield* publish()
      }))
      yield* ctx.session.hook("context", event => Effect.gen(function* () {
        assert.equal(event.model.providerID, "fixture")
        assert.equal(event.model.id, "fixture")
        record.contexts.push({ sessionID: event.sessionID, keys: Object.keys(event).sort(), messages: copy(event.messages) })
        yield* publish()
      }))
      yield* ctx.session.hook("http.request", event => Effect.sync(() => {
        assert.equal(new URL(event.request.url).hostname, "127.0.0.1")
        assert.equal(event.kind, "primary")
        // Fixture routing only. This public hook identifies a SESSION, not an
        // assistant or a consumed input. Never use this header as a parent link.
        event.request.headers.set("x-w4-session", event.sessionID)
      }))
      for (const phase of ["before", "after"]) yield* ctx.tool.hook(`execute.${phase}`, event => Effect.gen(function* () {
        record[phase].push(copy(event))
        yield* publish()
      }))
      record.ready = true
      yield* publish()
    }).pipe(Effect.tapCause(cause => Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return
      record.errors.push(Cause.pretty(cause))
      yield* publish()
    })))
  })
}

function cliSetup(ctx) {
  const publisher = observationPublisher(ctx.options.observation), abort = new AbortController(), tasks = new Set()
  const record = { version: ctx.app.version, errors: [], events: [], linked: [], commands: [] }
  const publish = () => publisher.publish(record)
  const options = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const own = fn => {
    const task = Promise.resolve().then(fn).catch(error => {
      if (!abort.signal.aborted) record.errors.push(String(error))
    }).finally(() => { tasks.delete(task); void publish() })
    tasks.add(task)
  }
  const stop = ctx.data.listen(({ details: event }) => {
    // Preserve host durable envelopes, not observer arrival timestamps. They
    // order deliveries within an aggregate even if client callbacks interleave.
    if (event.durable || event.type.startsWith("permission.") || event.type === "session.tool.progress") record.events.push(event)
    if (event.type === "permission.asked") own(async () => {
      const request = event.data
      assert.equal(request.source?.type, "tool")
      const message = await ctx.client.session.message.get({ sessionID: request.sessionID, messageID: request.source.messageID }, options())
      const pending = await ctx.client.permission.get({ sessionID: request.sessionID, requestID: request.id }, options())
      record.linked.push({ request, message, pending })
    })
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
          const session = await ctx.client.session.create({ location: { directory: ctx.options.project }, agent: "w4",
            model: { providerID: "fixture", id: "fixture" } }, options())
          ctx.ui.router.navigate({ type: "session", sessionID: session.id })
          const input = await ctx.client.session.prompt({ sessionID: session.id,
            text: "Run the isolated W4 delegation fixture using the explicit fixture/fixture model for every subagent." }, options())
          value = { session, input }
        } else if (command.type === "snapshot") {
          const session = await ctx.client.session.get({ sessionID: command.sessionID }, options())
          const messages = await ctx.client.session.context({ sessionID: command.sessionID }, options())
          const inbox = await ctx.client.session.inbox.list({ sessionID: command.sessionID }, options())
          const permissions = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
          value = { session, messages, inbox, permissions }
        } else if (command.type === "prompt") value = await ctx.client.session.prompt({ sessionID: command.sessionID,
          text: command.text, delivery: command.delivery }, options())
        else if (command.type === "synthetic") value = await ctx.client.session.synthetic({ sessionID: command.sessionID,
          text: "W4_SYNTHETIC_NOT_A_USER", delivery: "steer" }, options())
        else if (command.type === "interrupt") await ctx.client.session.interrupt({ sessionID: command.sessionID, continue: false }, options())
        else throw Error(`Unknown W4 CLI command: ${command.type}`)
        // No permission.reply, inbox mutation, metadata write, or shell API here.
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

const { scenario } = runtimeArguments("smoke-v2-delegation.mjs")
assert.ok(["initial-resume", "coalesced"].includes(scenario))
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assertV2HostVersion(version)
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-delegation-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-delegation-")
const project = path.join(temp, "project"), plugin = path.join(temp, "probe")
await Promise.all([project, plugin, path.join(temp, "config/opencode")].map(directory => mkdir(directory, { recursive: true })))
execFileSync("git", ["init", "--quiet", project])
const files = Object.fromEntries(["server", "cli", "control"].map(name => [name, path.join(artifacts, `${name}.json`)]))
const imports = `import assert from 'node:assert/strict'\nimport {setTimeout as sleep} from 'node:timers/promises'\nimport {observationPublisher,readObservation} from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}\n`
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-delegation", type: "module",
  exports: { ".": "./server.mjs", "./tui": "./tui.mjs" } }))
await writeFile(path.join(plugin, "server.mjs"), `${imports}import {Plugin} from '@opencode/plugin/effect'\nimport {Cause,Effect} from 'effect'\n${serverEffect}\nexport default Plugin.define({id:'research.v2.delegation.server',effect:serverEffect})\n`)
await writeFile(path.join(plugin, "tui.mjs"), `${imports}import {Plugin} from '@opencode/plugin/tui'\n${cliSetup}\nexport default Plugin.define({id:'research.v2.delegation.cli',setup:cliSetup})\n`)

const calls = [], errors = [], waiting = new Map(), evidence = {}, negativeWindows = [], sessions = new Set()
const controls = observationPublisher(files.control)
let sequence = 0
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions")
    const sessionID = req.headers["x-w4-session"]
    assert.equal(typeof sessionID, "string")
    let text = ""
    for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
    const body = JSON.parse(text)
    assert.ok(body.tools?.length, "auxiliary generations must be suppressed")
    assert.equal(body.model, "fixture")
    assert.equal(body.stream, true, "W4 uses a held streaming response to expose native step.started")
    assert.ok(!waiting.has(sessionID), "one held model call per session; retries are outside this probe")
    const call = { index: calls.length, sessionID, ordinal: calls.filter(item => item.sessionID === sessionID).length, body }
    calls.push(call)
    waiting.set(sessionID, { call, res })
    // In 2.0.26 Step.Started is published on provider output, not HTTP dispatch.
    // Emit harmless assistant text, then hold before any tool-call bytes. This
    // exposes the real step ID without manufacturing an assistant association.
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ id: "w4-fixture", object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: "W4 controlled step.\n" }, finish_reason: null }],
    })}\n\n`)
    res.once("close", () => {
      if (waiting.get(sessionID)?.call === call) { call.aborted = true; waiting.delete(sessionID) }
    })
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-delegation")
const observations = async () => {
  const cli = await readObservation(files.cli, { optional: true }), server = await readObservation(files.server, { optional: true })
  assert.deepEqual(errors, [])
  for (const item of [cli, server]) if (item) assert.deepEqual(item.errors, [])
  if (cli) assert.equal(cli.events.some(event => event.type === "permission.replied"), false)
  if (server) assert.equal(server.after.some(event => event.tool === "shell" && event.status === "completed"), false)
  return { cli, server }
}
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    const value = await observations()
    if (await predicate(value)) return value
    await sleep(50)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${label}`)
}
const control = async command => {
  const id = ++sequence
  await controls.publish({ ...command, sequence: id })
  await controls.flush()
  const value = await until(`CLI ${command.type}`, value => value.cli?.commands.some(item => item.sequence === id))
  return value.cli.commands.find(item => item.sequence === id).value
}
const snapshot = sessionID => control({ type: "snapshot", sessionID })
const events = (cli, sessionID, type) => cli.events.filter(event => event.data.sessionID === sessionID && event.type === type)
  .sort((a, b) => a.durable.seq - b.durable.seq)
const modelRequest = async (sessionID, ordinal) => {
  await until(`held model request ${ordinal}`, () => waiting.get(sessionID)?.call.ordinal === ordinal)
  return waiting.get(sessionID).call
}
const respond = (sessionID, toolCalls) => {
  const held = waiting.get(sessionID)
  assert.ok(held)
  for (const call of toolCalls) assert.ok(held.call.body.tools.some(tool => tool.function.name === call.name), call.name)
  waiting.delete(sessionID)
  held.call.response = toolCalls
  const message = { role: "assistant", content: null, tool_calls: toolCalls.map((call, index) => ({
    index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) },
  })) }
  for (const [delta, finish_reason] of [[message, null], [{}, "tool_calls"]]) held.res.write(`data: ${JSON.stringify({
    id: "w4-fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`)
  held.res.end("data: [DONE]\n\n")
}
const shellCall = id => ({ id, name: "shell", input: { command: "printf W4_HELD_NATIVE_SHELL", workdir: project } })
const returnCall = id => ({ id, name: "w4_return", input: {} })
const subagentCall = (id, prompt, sessionID) => ({ id, name: "subagent", input: {
  agent: "w4", description: "W4 native delegation probe", prompt, model: "fixture/fixture", ...(sessionID ? { sessionID } : {}),
} })
const toolItem = (messages, callID) => {
  const matches = messages.filter(message => message.type === "assistant").flatMap(message => message.content
    .filter(item => item.type === "tool" && item.id === callID).map(item => ({ message, item })))
  assert.equal(matches.length, 1)
  return matches[0]
}
const nativeChild = async (parentID, callID) => {
  const observed = await until("native subagent progress with child session identity", value => value.cli?.events.some(event =>
    event.type === "session.tool.progress" && event.data.sessionID === parentID && event.data.id === callID &&
    typeof event.data.metadata.sessionID === "string"))
  const progress = observed.cli.events.filter(event => event.type === "session.tool.progress" &&
    event.data.sessionID === parentID && event.data.id === callID && typeof event.data.metadata.sessionID === "string")
  const childIDs = new Set(progress.map(event => event.data.metadata.sessionID))
  assert.equal(childIDs.size, 1)
  const selected = [...childIDs][0]
  const state = await snapshot(selected)
  assert.equal(state.session.parentID, parentID)
  assert.equal(state.session.model.providerID, "fixture")
  assert.equal(state.session.model.id, "fixture")
  const parentCall = toolItem((await snapshot(parentID)).messages, callID)
  assert.equal(parentCall.item.name, "subagent")
  for (const event of progress) assert.equal(event.data.assistantMessageID, parentCall.message.id)
  evidence.nativeCalls ??= []
  evidence.nativeCalls.push({ parentID, childID: selected, progress, ...parentCall })
  sessions.add(selected)
  return selected
}

// The controlled fixture has no retry/compaction/reload. The exact source ID
// joins permission -> assistant -> step. Ordered delivered IDs below establish
// a consumed INPUT SET using the pinned runner's promote-before-context-load
// contract, not a public unique assistant parent. Never call this delegation.
const boundary = async (label, sessionID, ordinal, expectedUsers, expectedSynthetic = [], excluded = []) => {
  const call = await modelRequest(sessionID, ordinal)
  const observed = await until(`${label} step and context observations`, value =>
    value.cli && events(value.cli, sessionID, "session.step.started").length === ordinal + 1 &&
    value.server?.contexts.filter(item => item.sessionID === sessionID).length === ordinal + 1)
  const steps = events(observed.cli, sessionID, "session.step.started"), step = steps[ordinal]
  assert.equal(step.durable.aggregateID, sessionID)
  const ledger = observed.cli.events.filter(event => event.durable?.aggregateID === sessionID && event.durable.seq <= step.durable.seq)
    .sort((a, b) => a.durable.seq - b.durable.seq)
  assert.equal(ledger[0].type, "session.created", "observer must cover this session from creation")
  for (let index = 1; index < ledger.length; index++) assert.equal(ledger[index].durable.seq, ledger[index - 1].durable.seq + 1,
    "a missing or duplicate durable event invalidates the controlled causal subset")
  assert.equal(Object.hasOwn(step.data, "inboxID"), false)
  const deliveries = events(observed.cli, sessionID, "session.inbox.delivered").filter(event => event.durable.seq < step.durable.seq)
  const admitted = events(observed.cli, sessionID, "session.inbox.enqueued")
  const state = await snapshot(sessionID)
  assert.deepEqual(state.messages.filter(item => item.type === "user").map(item => item.id), expectedUsers)
  assert.deepEqual(state.messages.filter(item => item.type === "synthetic").map(item => item.id), expectedSynthetic)
  assert.deepEqual(deliveries.map(event => event.data.inboxID), state.messages
    .filter(item => ["user", "synthetic"].includes(item.type)).map(item => item.id))
  for (const delivery of deliveries) {
    assert.equal(delivery.durable.aggregateID, sessionID)
    const entries = admitted.filter(event => event.data.inboxID === delivery.data.inboxID)
    assert.equal(entries.length, 1)
    assert.ok(entries[0].durable.seq < delivery.durable.seq)
    const message = state.messages.find(item => item.id === delivery.data.inboxID)
    assert.equal(message.type, entries[0].data.item.type)
  }
  const context = observed.server.contexts.filter(item => item.sessionID === sessionID)[ordinal]
  assert.equal(context.keys.includes("assistantMessageID"), false)
  for (const id of [...expectedUsers, ...expectedSynthetic]) {
    const messages = context.messages.filter(item => item.id === id)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, "user", "synthetic records also become model-facing user-role messages")
  }
  for (const id of excluded) {
    assert.ok(state.inbox.some(item => item.id === id))
    assert.equal(state.messages.some(item => item.id === id), false)
    assert.equal(context.messages.some(item => item.id === id), false)
    assert.equal(deliveries.some(item => item.data.inboxID === id), false)
  }
  const previousSeq = steps[ordinal - 1]?.durable.seq ?? -1
  const newInputs = deliveries.filter(event => event.durable.seq > previousSeq).map(event => event.data.inboxID)
  const result = { label, sessionID, step, ledger, callIndex: call.index, state, context, deliveries, newInputs,
    orderedGenuineUserIDs: expectedUsers, syntheticIDs: expectedSynthetic, excludedIDs: excluded,
    association: "Pinned-runner causal input subset only; no public unique parent delegation association." }
  evidence[label] = result
  return result
}
const genuineInputs = async sessionID => {
  const state = await snapshot(sessionID)
  return state.messages.filter(item => item.type === "user").map(item => item.id)
}
const heldSource = async (label, sessionID, callID, proof) => {
  const observed = await until(`${label} held native shell permission`, value => value.cli?.linked.some(link =>
    link.request.sessionID === sessionID && link.request.source.id === callID))
  const links = observed.cli.linked.filter(link => link.request.sessionID === sessionID && link.request.source.id === callID)
  assert.equal(links.length, 1)
  const link = links[0]
  assert.equal(link.request.action, "shell")
  assert.deepEqual(link.request, link.pending)
  assert.equal(link.request.source.messageID, proof.step.data.assistantMessageID)
  assert.equal(link.message.id, proof.step.data.assistantMessageID)
  assert.equal(link.message.type, "assistant")
  assert.equal(Object.hasOwn(link.message, "parentID"), false)
  const { item } = toolItem([link.message], callID)
  assert.equal(item.name, "shell")
  assert.equal(item.state.status, "running")
  assert.deepEqual(item.state.input, shellCall(callID).input)
  const before = observed.server.before.filter(event => event.id === callID && event.sessionID === sessionID && event.messageID === link.message.id)
  assert.equal(before.length, 1)
  proof.permissionSource = link
  await negativeWindow(label, sessionID, [link.request.id])
  return link
}
const negativeWindow = async (label, sessionID, requestIDs) => {
  const started = Date.now()
  let samples = 0
  do {
    const state = await snapshot(sessionID)
    assert.deepEqual(state.permissions.map(item => item.id).sort(), [...requestIDs].sort())
    const value = await observations()
    assert.equal(value.cli.events.some(event => event.type === "session.shell.started"), false)
    samples++
    await sleep(75)
  } while (Date.now() - started < 1000)
  negativeWindows.push({ label, sessionID, requestIDs, samples, durationMs: Date.now() - started })
}
const interrupt = async sessionID => {
  await control({ type: "interrupt", sessionID })
  await until("native pending requests removed by interruption", async () => (await snapshot(sessionID)).permissions.length === 0)
}
const sourceReferences = {
  baseline: "opencode-2.0.26/packages/",
  runner: "core/src/session/runner/llm.ts:161-191,205-251 (promote then load context, allocate assistant separately)",
  promotion: "core/src/session/inbox.ts:458-487,496-550 (durable ordered delivery; steers coalesce, queued input excluded mid-work)",
  projection: "core/src/session/projector.ts:618-658 (inbox ID preserved and genuine/synthetic type retained)",
  modelRole: "core/src/session/runner/to-llm-message.ts:269-288 (both become user role with retained IDs)",
  nativeChild: "core/src/tool/plugin/subagent.ts:153-218 (parent validation, native creation/resume and normal prompt admission)",
  eventContract: "schema/src/session-event.ts:203-223,328-342 (no assistant-to-inbox field)",
  stepPublication: "core/src/session/runner/publish-llm-event.ts:101-115,407-408 (native step ID published on provider output)",
}
const limitations = [
  "Synthetic controlled stock-2.0.26 probe, not reviewer integration or general delegation parity.",
  "Ordered delivered input subsets use durable per-session sequence numbers, persisted IDs/types, held model boundaries and pinned runner causal source. No timestamp, nearest-user, command-text or last-call identity joins.",
  "Context hooks and model HTTP requests lack assistant IDs. Their session-local ordinals are fixture control barriers only, not a deployable immutable call lookup.",
  "Even a proven ordered input subset is not a host-designated unique immediate delegation. No exact-delegation field is manufactured. An ordered collection requires a separate product decision.",
  "Only streaming initial-resume and coalesced are covered. Siblings, retries, compaction, duplicate/concurrent admission, reload/reconnect and attachment-only root intent are not covered.",
  "The queued follow-up is shown pending and excluded, not subsequently executed. All shell permissions are interrupted without replies; the command contains no writes even if a host unexpectedly runs it.",
]
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  const permissions = [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "*", effect: "ask" }]
  const config = { model: "fixture/fixture", default_agent: "w4", update: "disable", experimental: { subagent_depth: 3 }, permissions,
    agents: { w4: { mode: "all", model: "fixture/fixture", description: "Synthetic W4 probe", permissions } },
    plugins: [{ package: plugin, options: { observation: files.server } }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
  const cli = { animations: false, attention: { notifications: false, sound: false },
    plugins: [{ package: plugin, options: { project, observation: files.cli, control: files.control } }] }
  const cliPath = path.join(temp, "config/opencode/cli.json")
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  await writeFile(cliPath, JSON.stringify(cli))
  const launch = ["-d", "-s", "v2-delegation", "-x", "160", "-y", "40", "-c", project, host, "--standalone", project]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ scenario, version, temp, config, cli, launch,
    socket: runtime.socket, supervisorPID: runtime.supervisorPID, sourceReferences, limitations }, null, 2))
  await runtime.start(...launch)
  const start = await control({ type: "start" }), rootID = start.session.id
  sessions.add(rootID)
  const rootProof = await boundary("root", rootID, 0, [start.input.id])
  respond(rootID, [subagentCall("w4-initial", "W4_INITIAL_NATIVE_CHILD")])
  const childID = await nativeChild(rootID, "w4-initial")
  await modelRequest(childID, 0)
  const initialIDs = await genuineInputs(childID)
  assert.equal(initialIDs.length, 1)
  const initial = await boundary("initial", childID, 0, initialIDs)
  assert.deepEqual(initial.newInputs, initialIDs)
  assert.equal(initial.state.messages.find(item => item.id === initialIDs[0]).text,
    "You are a subagent spawned by another session.\nW4_INITIAL_NATIVE_CHILD")
  // Root intent is a distinct persisted root user, never substituted with a child brief.
  assert.equal(initialIDs.includes(start.input.id), false)
  evidence.rootIntent = rootProof.state.messages.find(item => item.id === start.input.id)
  if (scenario === "initial-resume") {
    respond(childID, [shellCall("w4-initial-shell")])
    await heldSource("initial", childID, "w4-initial-shell", initial)
    await interrupt(childID)
    await modelRequest(rootID, 1)
    respond(rootID, [subagentCall("w4-resume", "W4_RESUMED_NATIVE_CHILD", childID)])
    assert.equal(await nativeChild(rootID, "w4-resume"), childID)
    await modelRequest(childID, 1)
    const resumedIDs = await genuineInputs(childID)
    assert.equal(resumedIDs.length, 2)
    assert.equal(resumedIDs[0], initialIDs[0])
    const resumed = await boundary("resumed", childID, 1, resumedIDs)
    assert.deepEqual(resumed.newInputs, [resumedIDs[1]])
    assert.equal(resumed.state.messages.find(item => item.id === resumedIDs[1]).text, "W4_RESUMED_NATIVE_CHILD")
    respond(childID, [returnCall("w4-continuation")])
    const continuation = await boundary("tool-only", childID, 2, resumedIDs)
    assert.deepEqual(continuation.newInputs, [])
    const returned = toolItem(continuation.state.messages, "w4-continuation")
    assert.equal(returned.item.state.status, "completed")
    assert.equal(returned.message.id, resumed.step.data.assistantMessageID)
    respond(childID, [shellCall("w4-resumed-shell"), subagentCall("w4-nested", "W4_NESTED_NATIVE_CHILD")])
    const nestedID = await nativeChild(childID, "w4-nested")
    await modelRequest(nestedID, 0)
    const nestedIDs = await genuineInputs(nestedID)
    assert.equal(nestedIDs.length, 1)
    assert.equal(resumedIDs.includes(nestedIDs[0]), false)
    const nested = await boundary("nested", nestedID, 0, nestedIDs)
    assert.equal(nested.state.messages.find(item => item.id === nestedIDs[0]).text,
      "You are a subagent spawned by another session.\nW4_NESTED_NATIVE_CHILD")
    respond(nestedID, [shellCall("w4-nested-shell")])
    await heldSource("resumed-tool-only", childID, "w4-resumed-shell", continuation)
    await heldSource("nested", nestedID, "w4-nested-shell", nested)
  } else {
    // These admissions happen while the initial child's model response is held.
    // Delivery mode is the explicit public caller choice, never a rewritten hook.
    const queued = await control({ type: "prompt", sessionID: childID, text: "W4_QUEUED_FOLLOW_UP", delivery: "queue" })
    const first = await control({ type: "prompt", sessionID: childID, text: "W4_STEER_ONE", delivery: "steer" })
    const second = await control({ type: "prompt", sessionID: childID, text: "W4_STEER_TWO", delivery: "steer" })
    const synthetic = await control({ type: "synthetic", sessionID: childID })
    const admittedIDs = [queued.id, first.id, second.id, synthetic.id]
    assert.equal(new Set(admittedIDs).size, 4)
    const held = await snapshot(childID)
    assert.deepEqual(held.inbox.map(item => item.id), admittedIDs)
    assert.deepEqual(held.messages.filter(item => ["user", "synthetic"].includes(item.type)).map(item => item.id), initialIDs)
    evidence.admittedWhileHeld = { queued, first, second, synthetic, state: held }
    respond(childID, [returnCall("w4-coalesce-boundary")])
    const coalesced = await boundary("coalesced", childID, 1, [...initialIDs, first.id, second.id], [synthetic.id], [queued.id])
    assert.deepEqual(coalesced.newInputs, [first.id, second.id, synthetic.id])
    assert.deepEqual(coalesced.state.inbox.map(item => item.id), [queued.id])
    const observed = await observations()
    assert.equal(observed.server.prompts.some(item => item.messageID === synthetic.id), false)
    for (const id of [first.id, second.id]) assert.equal(observed.server.prompts
      .filter(item => item.sessionID === childID && item.messageID === id).length, 1)
    assert.ok(calls.find(item => item.index === coalesced.callIndex).body.messages.some(item =>
      item.role === "user" && JSON.stringify(item.content).includes("W4_SYNTHETIC_NOT_A_USER")), "wire role is not genuine user provenance")
    respond(childID, [shellCall("w4-coalesced-shell")])
    await heldSource("coalesced", childID, "w4-coalesced-shell", coalesced)
  }
  await writeFile(path.join(artifacts, "pending.txt"), capture())
  // Interrupt root first to stop foreground native jobs before their descendants
  // can settle and advance the parent. Explicit descendant interruptions reconcile.
  for (const sessionID of sessions) await interrupt(sessionID)
  for (const sessionID of sessions) await negativeWindow("after interruption", sessionID, [])
  await writeFile(cliPath, JSON.stringify({ ...cli, plugins: ["*", "-research.v2.delegation.cli"] }))
  const cleaned = (await until("CLI observation cleanup", value => value.cli?.cleaned)).cli
  await sleep(300)
  assert.deepEqual(await readObservation(files.cli), cleaned)
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", scenario, version, temp,
    evidence, negativeWindows, sourceReferences, limitations, calls, observations: await observations() }, null, 2))
  console.log(`PASS V2 delegation (${scenario}): ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  try { await writeFile(path.join(artifacts, "failed.txt"), capture()) } catch { /* Host may have exited. */ }
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack,
    scenario, evidence, calls, errors, negativeWindows, sourceReferences, limitations,
    observations: await Promise.all([files.cli, files.server].map(file => readObservation(file, { optional: true }))).catch(() => null) }, null, 2))
  throw error
} finally {
  try { await controls.close() }
  finally {
    try { await runtime.dispose() }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
}
