// W3 synthetic effective-evidence probe, unmodified OpenCode 2.0.26.
// Public Effect hooks only; native shell/skill executors are never wrapped.
// Pinned source: core/src/{tool.ts,shell.ts,skill.ts,permission.ts},
// core/src/tool/plugin/{shell.ts,skill.ts}, core/src/session/move.ts,
// plugin/src/effect/{tool.ts,shell.ts,skill.ts,permission.ts} and client types.
// Inventory owner registers shell-rewrite (default), skill-reload, moved-location, edit-preview.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

// Serialized real function bodies let node --check cover plugin implementation.
function serverEffect(ctx) {
  return Effect.gen(function* () {
    const locationKey = ctx.location.directory === ctx.options.moved ? "B" : "A"
    assert.equal(ctx.location.directory, locationKey === "A" ? ctx.options.initial : ctx.options.moved)
    const publisher = observationPublisher(ctx.options.observations[locationKey])
    const copy = value => JSON.parse(JSON.stringify(value))
    const record = { version: ctx.app.version, location: copy(ctx.location), locationKey, errors: [], commands: [],
      before: [], rewritten: [], shells: [], evaluations: [], after: [], catalogs: [], transforms: [], skillCatalogs: [] }
    const publish = () => Effect.promise(async () => { await publisher.publish(record) })
    const shellGate = yield* Deferred.make(), skillGate = yield* Deferred.make()
    let definitionRevision = "A", skillRevision = "A"
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      record.cleaned = true
      yield* publish()
      yield* Effect.promise(() => publisher.close())
    }))
    const report = cause => Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return
      record.errors.push(Cause.pretty(cause))
      yield* publish()
    })
    const catalog = label => Effect.gen(function* () {
      const tools = yield* ctx.tool.list()
      record.catalogs.push({ label, tools: tools.filter(item => ["shell", "skill"].includes(item.id))
        .map(({ id, name, description, options }) => ({ id, name, description, options })) })
      const skills = yield* ctx.skill.list()
      record.skillCatalogs.push({ label, value: copy(skills) })
      yield* publish()
    })
    yield* Effect.gen(function* () {
      // Native tools are already direct in 2.0.26. Only mark descriptions to
      // compare the retained model definition with a subsequently rebuilt catalog.
      yield* ctx.tool.transform(editor => {
        for (const id of ["shell", "skill"]) {
          const original = editor.get(id)
          assert.ok(original)
          editor.update(id, draft => { draft.description = `${original.description}\nW3 definition ${definitionRevision}` })
          const changed = editor.get(id)
          for (const key of Object.keys(original).filter(key => !["description", "options"].includes(key))) assert.equal(changed[key], original[key])
          assert.deepEqual(changed.options, original.options)
          record.transforms.push({ id, revision: definitionRevision, executorIdentical: changed.execute === original.execute,
            inputIdentical: changed.input === original.input, outputIdentical: changed.output === original.output })
        }
      })
      yield* ctx.skill.transform(editor => {
        editor.add({ id: "w3-evidence", name: "W3 evidence", description: "Synthetic W3 skill selection probe",
          path: ctx.options.skillPath, content: `W3_SKILL_CONTENT_${skillRevision}\nUse only the isolated W3 fixture.` })
      })
      yield* ctx.session.hook("title", event => Effect.sync(() => { event.result = "W3 effective evidence" }))
      yield* ctx.session.hook("http.request", event => Effect.sync(() => {
        assert.equal(new URL(event.request.url).hostname, "127.0.0.1", "fixture provider must be loopback")
      }))
      yield* ctx.session.hook("context", event => Effect.sync(() => {
        assert.equal(event.model.providerID, "fixture")
        assert.equal(event.model.id, "fixture")
      }))
      // Observer deliberately precedes a later mutable hook. Its copied input is
      // invocation-bound, but cannot claim to be the last effective input.
      yield* ctx.tool.hook("execute.before", event => Effect.gen(function* () {
        record.before.push({ event: copy(event), location: copy(ctx.location) })
        yield* publish()
      }))
      yield* ctx.tool.hook("execute.before", event => Effect.gen(function* () {
        if (ctx.options.scenario !== "shell-rewrite" || event.tool !== "shell") return
        assert.ok(["w3-shell-A", "w3-shell-B"].includes(event.id))
        const previous = copy(event)
        // Collapse both distinct inputs before shell creation. Any observer trying
        // to recover call identity from command/cwd text now has two candidates.
        event.input = { ...event.input, command: "python3 fixture.py # W3 execute.before shared", workdir: ctx.options.inputDirectory }
        record.rewritten.push({ previous, event: copy(event) })
        yield* publish()
      }))
      yield* ctx.shell.hook("create.before", event => Effect.gen(function* () {
        // Preserve the exact public key set, without copying environment values.
        const describe = () => ({ keys: Object.keys(event).sort(), command: event.command, cwd: event.cwd,
          timeout: event.timeout, shell: event.shell, envKeys: Object.keys(event.env).sort() })
        const item = { before: describe() }
        record.shells.push(item)
        if (ctx.options.scenario === "shell-rewrite") {
          assert.equal(record.shells.length <= 2, true)
          assert.equal(event.command, "python3 fixture.py # W3 execute.before shared")
          // Ordinals are fixture-local shell observations, NEVER permission/call
          // identifiers. No join from this row to a source call is asserted.
          const ordinal = record.shells.length
          event.command = `python3 fixture.py # W3 shell.create.before ${ordinal}`
          event.cwd = ctx.options.finalDirectories[ordinal - 1]
          item.after = describe()
          item.held = true
          yield* publish()
          yield* Deferred.await(shellGate)
          item.released = true
        } else item.after = describe()
        yield* publish()
      }).pipe(Effect.tapCause(report)))
      yield* ctx.permission.hook("evaluate", event => Effect.gen(function* () {
        const item = { event: copy(event) }
        record.evaluations.push(item)
        if (event.action === "skill" && event.resources.includes("w3-evidence")) {
          assert.equal(event.effect, "ask")
          // Pinned native skill.ts selects before this hook. This is a CURRENT
          // catalog read at a controlled barrier, not a public selected snapshot.
          item.catalogAtPostSelectionBarrier = copy(yield* ctx.skill.list())
          item.held = true
          yield* publish()
          yield* Deferred.await(skillGate)
          item.released = true
        }
        // Never mutate the effect, resources, source, or message.
        assert.deepEqual(copy(event), item.event)
        yield* publish()
      }).pipe(Effect.tapCause(report)))
      yield* ctx.tool.hook("execute.after", event => Effect.gen(function* () {
        record.after.push(copy(event))
        yield* publish()
      }))
      yield* catalog("initial")
      record.ready = true
      yield* publish()
      yield* Effect.gen(function* () {
        let sequence = 0
        while (true) {
          const command = yield* Effect.promise(() => readObservation(ctx.options.controls[locationKey], { optional: true }))
          if (command && command.sequence > sequence) {
            sequence = command.sequence
            if (command.type === "definitions-B") {
              definitionRevision = "B"
              yield* ctx.tool.reload()
            } else if (command.type === "release-shells") {
              assert.equal(record.shells.filter(item => item.held).length, 2)
              yield* Deferred.succeed(shellGate, undefined)
            } else if (command.type === "release-skill") {
              assert.equal(record.evaluations.filter(item => item.held).length, 1)
              yield* Deferred.succeed(skillGate, undefined)
            } else if (command.type === "skill-B") {
              assert.ok(record.evaluations.some(item => item.released && item.event.action === "skill"))
              skillRevision = "B"
              yield* ctx.skill.reload()
            } else throw Error(`Unknown W3 server command: ${command.type}`)
            yield* catalog(command.type)
            record.commands.push({ sequence, type: command.type })
            yield* publish()
          }
          yield* Effect.sleep("40 millis")
        }
      }).pipe(Effect.tapCause(report), Effect.forkScoped)
    }).pipe(Effect.tapCause(report))
  })
}

function cliSetup(ctx) {
  const publisher = observationPublisher(ctx.options.observation), abort = new AbortController(), tasks = new Set()
  const record = { version: ctx.app.version, errors: [], asked: [], linked: [], replied: [], commands: [], events: [] }
  const publish = () => publisher.publish(record)
  const options = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const own = fn => {
    const task = Promise.resolve().then(fn).catch(error => {
      if (!abort.signal.aborted) record.errors.push(String(error))
    }).finally(() => { tasks.delete(task); void publish() })
    tasks.add(task)
  }
  const stop = ctx.data.listen(({ details: event }) => {
    if (event.type.startsWith("permission.") || event.type === "session.moved" || event.type.startsWith("session.execution."))
      record.events.push({ type: event.type, data: event.data })
    if (event.type === "permission.replied") record.replied.push(event.data)
    if (event.type === "permission.asked") {
      const request = event.data
      record.asked.push(request)
      own(async () => {
        assert.equal(request.source?.type, "tool")
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
          const session = await ctx.client.session.create({ location: { directory: ctx.options.initial },
            model: { providerID: "fixture", id: "fixture" } }, options())
          ctx.ui.router.navigate({ type: "session", sessionID: session.id })
          await ctx.client.session.prompt({ sessionID: session.id, text: "Run the isolated W3 evidence probe. Use w3-evidence only if requested by the fixture." }, options())
          value = session
        } else if (command.type === "pending") value = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
        else if (command.type === "read") value = await ctx.client.session.message.get({ sessionID: command.sessionID, messageID: command.messageID }, options())
        else if (command.type === "session") value = await ctx.client.session.get({ sessionID: command.sessionID }, options())
        else if (command.type === "skills") value = await ctx.client.skill.list({ location: { directory: command.directory } }, options())
        else if (command.type === "interrupt") await ctx.client.session.interrupt({ sessionID: command.sessionID, continue: false }, options())
        else if (command.type === "move") await ctx.client.session.move({ sessionID: command.sessionID, directory: command.directory }, options())
        else if (command.type === "prompt") await ctx.client.session.prompt({ sessionID: command.sessionID, text: "Run the W3 probe at the moved location." }, options())
        else throw Error(`Unknown W3 CLI command: ${command.type}`)
        // Deliberately no permission.reply capability in this control protocol.
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

const { scenario } = runtimeArguments("smoke-v2-effective-evidence.mjs")
assert.ok(["shell-rewrite", "skill-reload", "moved-location", "edit-preview"].includes(scenario))
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assertV2HostVersion(version)
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-effective-evidence-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-effective-evidence-")
const project = path.join(temp, "project"), initial = path.join(project, "A"), moved = path.join(project, "B")
const plugin = path.join(temp, "probe"), inputDirectory = path.join(initial, "inputs")
const finalDirectories = [path.join(initial, "final-1"), path.join(initial, "final-2")]
const skillPath = path.join(initial, "skill/SKILL.md")
const editTargets = [path.join(initial, "target.txt"), path.join(temp, "external/target.txt")]
const sentinelDirectories = [inputDirectory, ...finalDirectories, path.join(moved, "inputs")]
await Promise.all([...sentinelDirectories, path.dirname(skillPath), plugin, path.join(temp, "config/opencode")]
  .map(directory => mkdir(directory, { recursive: true })))
execFileSync("git", ["init", "--quiet", project])
for (const directory of sentinelDirectories) await writeFile(path.join(directory, "fixture.py"),
  'with open("executed", "a") as output:\n    output.write("W3 UNEXPECTED EXECUTION\\n")\n')
await writeFile(skillPath, "W3_DISK_CONTENT_IS_NOT_THE_TRANSFORMED_CATALOG\n")
if (scenario === "edit-preview") {
  await mkdir(path.dirname(editTargets[1]))
  for (const file of editTargets) await writeFile(file, "W3_BEFORE\n")
}
const files = Object.fromEntries(["A", "B", "cli", "A-control", "B-control", "cli-control"].map(name => [name, path.join(artifacts, `${name}.json`)]))
const publisherImport = JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)
const imports = `import assert from 'node:assert/strict'\nimport { setTimeout as sleep } from 'node:timers/promises'\nimport { observationPublisher, readObservation } from ${publisherImport}\n`
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-effective-evidence", type: "module",
  exports: { ".": "./server.mjs", "./tui": "./tui.mjs" } }))
await writeFile(path.join(plugin, "server.mjs"), `${imports}import { Plugin } from '@opencode/plugin/effect'\nimport { Cause, Deferred, Effect } from 'effect'\n${serverEffect}\nexport default Plugin.define({id:'research.v2.evidence.server',effect:serverEffect})\n`)
await writeFile(path.join(plugin, "tui.mjs"), `${imports}import { Plugin } from '@opencode/plugin/tui'\n${cliSetup}\nexport default Plugin.define({id:'research.v2.evidence.cli',setup:cliSetup})\n`)

const calls = [], errors = [], waiting = new Map(), evidence = {}, negativeWindows = []
const controls = Object.fromEntries(["A", "B", "cli"].map(name => [name, observationPublisher(files[`${name}-control`])]))
const sequences = { A: 0, B: 0, cli: 0 }
const response = (res, body, toolCalls) => {
  const message = { role: "assistant", content: null, tool_calls: toolCalls.map((call, index) => ({
    index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) },
  })) }
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[message, null], [{}, "tool_calls"]])
      res.write(`data: ${JSON.stringify({ id: "w3-fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    res.end("data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: "tool_calls" }] }))
  }
}
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions")
    let text = ""
    for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
    const body = JSON.parse(text), index = calls.length
    assert.ok(body.tools?.length, "title hook must suppress auxiliary model generation")
    calls.push({ index, body })
    waiting.set(index, { res, body })
    res.once("close", () => { if (waiting.has(index)) { calls[index].aborted = true; waiting.delete(index) } })
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-effective-evidence")
const observations = async () => {
  const entries = await Promise.all(["A", "B", "cli"].map(async name => [name, await readObservation(files[name], { optional: true })]))
  assert.deepEqual(errors, [])
  for (const [, record] of entries) if (record) assert.deepEqual(record.errors, [])
  return Object.fromEntries(entries)
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
  await controls[target].publish({ ...command, sequence })
  await controls[target].flush()
  const result = await until(`${target} ${command.type}`, value => value[target]?.commands.some(item => item.sequence === sequence))
  return result[target].commands.find(item => item.sequence === sequence).value
}
const modelRequest = async index => {
  await until(`model request ${index}`, () => waiting.has(index))
  return calls[index].body
}
const respond = (index, toolCalls) => {
  const held = waiting.get(index)
  assert.ok(held)
  for (const call of toolCalls) assert.ok(held.body.tools.some(tool => tool.function.name === call.name))
  waiting.delete(index)
  calls[index].response = toolCalls
  response(held.res, held.body, toolCalls)
}
const sourceItem = link => {
  assert.equal(link.request.source.type, "tool")
  assert.deepEqual(link.pending, link.request)
  assert.equal(link.message.type, "assistant")
  assert.equal(link.message.id, link.request.source.messageID)
  const matches = link.message.content.filter(item => item.type === "tool" && item.id === link.request.source.id)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].state.status, "running")
  return matches[0]
}
const skill = catalog => {
  const selected = catalog.data.filter(item => item.id === "w3-evidence")
  assert.equal(selected.length, 1)
  return selected[0]
}
const negativeWindow = async (sessionID, expectedIDs, label) => {
  const started = Date.now(), end = started + 1500
  let samples = 0
  do {
    const value = await observations()
    assert.deepEqual(value.cli.replied, [])
    assert.ok([value.A, value.B].filter(Boolean).every(record => record.after.every(item => item.status !== "completed")))
    const pending = await control("cli", { type: "pending", sessionID })
    assert.deepEqual(pending.map(item => item.id).sort(), [...expectedIDs].sort())
    for (const directory of sentinelDirectories) await assert.rejects(readFile(path.join(directory, "executed")), { code: "ENOENT" })
    if (scenario === "edit-preview") for (const file of editTargets) assert.equal(await readFile(file, "utf8"), "W3_BEFORE\n")
    samples++
    await sleep(75)
  } while (Date.now() < end)
  negativeWindows.push({ label, durationMs: Date.now() - started, samples, pendingIDs: expectedIDs })
}
const interrupt = async sessionID => {
  await control("cli", { type: "interrupt", sessionID })
  await until("interruption removes native pending requests", async () =>
    (await control("cli", { type: "pending", sessionID })).length === 0)
  assert.deepEqual((await observations()).cli.replied, [])
}
const limitations = [
  "Synthetic controlled installation only, not production reviewer parity, provenance proof or enforcement against arbitrary later plugins.",
  "Shell-hook rows have fixture ordinals only. No timing, command-text, environment, or last-call join assigns them to permission sources.",
  "Skill A selection is inferred from pinned native source ordering and the controlled post-selection permission barrier. No public selected-content snapshot or pre-reply tool output is exposed; the call is interrupted without approval.",
  "Moved-location covers continuously observed local same-project moves after interrupting a held step, not a workspace/remote filesystem, queued active-step handoff, reconnect, or companion unload/restart recovery.",
  "Description-only registry reload contrasts model definition A with current definition B, but does not expose a public pending-call definition lookup.",
  "All native permissions remain pending through observation and are removed only by session interruption. No permission reply, tool result or native shell execution is authorized.",
]
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", update: "disable",
    plugins: [{ package: plugin, options: { scenario, initial, moved, inputDirectory, finalDirectories, skillPath,
      observations: { A: files.A, B: files.B }, controls: { A: files["A-control"], B: files["B-control"] } } }],
    permissions: [{ action: "shell", resource: "*", effect: "ask" }, { action: "skill", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${baseURL}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  const cli = { animations: false, attention: { notifications: false, sound: false },
    plugins: [{ package: plugin, options: { initial, observation: files.cli, control: files["cli-control"] } }] }
  const cliPath = path.join(temp, "config/opencode/cli.json")
  await writeFile(cliPath, JSON.stringify(cli))
  const launch = ["-d", "-s", "v2-effective-evidence", "-x", "160", "-y", "40", "-c", initial, host, "--standalone", initial]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, scenario, temp, config, cli, launch,
    socket: runtime.socket, supervisorPID: runtime.supervisorPID, limitations }, null, 2))
  await runtime.start(...launch)
  const session = await control("cli", { type: "start" }), sessionID = session.id
  const model = await modelRequest(0)
  await until("server setup", value => value.A?.ready)
  if (scenario === "shell-rewrite") {
    // Native shell's context hook regenerates its advertised description. Skill
    // has no such override, so use that unmodified executor's definition marker.
    evidence.advertisedDefinition = model.tools.find(tool => tool.function.name === "skill")
    assert.match(evidence.advertisedDefinition.function.description, /W3 definition A/)
    await control("A", { type: "definitions-B" })
    evidence.currentDefinition = (await observations()).A.catalogs.at(-1).tools.find(tool => tool.id === "skill")
    assert.match(evidence.currentDefinition.description, /W3 definition B/)
    const expected = ["A", "B"].map(label => ({ id: `w3-shell-${label}`, name: "shell",
      input: { command: `python3 fixture.py # W3 model ${label}`, workdir: inputDirectory } }))
    respond(0, expected)
    const barrier = await until("two concurrent native shell hooks", value => value.A?.shells.filter(item => item.held).length === 2)
    assert.equal(barrier.cli.asked.length, 0, "native permission preparation follows the shell hook barrier")
    assert.equal(barrier.A.before.length, 2)
    assert.deepEqual(barrier.A.shells[0].before, barrier.A.shells[1].before)
    for (const row of barrier.A.shells) {
      assert.deepEqual(row.before.keys, ["command", "cwd", "env", "shell", "timeout"])
      assert.notEqual(row.before.command, row.after.command)
      assert.notEqual(row.before.cwd, row.after.cwd)
    }
    await control("A", { type: "release-shells" })
    const held = await until("two native shell permissions", value => value.cli?.linked.length === 2)
    const links = held.cli.linked
    assert.ok(links.every(link => link.request.action === "shell"))
    assert.equal(new Set(links.map(link => link.request.id)).size, 2)
    assert.equal(new Set(links.map(link => link.request.source.id)).size, 2)
    assert.deepEqual(links[0].request.resources, links[1].request.resources)
    assert.deepEqual(links[0].request.resources, ["python3 fixture.py"])
    for (const link of links) {
      const item = sourceItem(link), call = expected.find(call => call.id === item.id)
      assert.ok(call)
      assert.equal(link.request.sessionID, sessionID)
      assert.equal(item.name, "shell")
      assert.deepEqual(item.state.input, call.input)
      const before = held.A.before.filter(row => row.event.id === item.id && row.event.messageID === link.message.id && row.event.sessionID === sessionID)
      const rewritten = held.A.rewritten.filter(row => row.event.id === item.id && row.event.messageID === link.message.id && row.event.sessionID === sessionID)
      assert.equal(before.length, 1)
      assert.equal(rewritten.length, 1)
      assert.deepEqual(before[0].event.input, call.input)
      assert.notDeepEqual(rewritten[0].event.input, item.state.input)
      assert.equal(before[0].location.directory, initial)
    }
    evidence.shell = { links, observer: held.A.before, rewrites: held.A.rewritten, unjoinedShellRows: held.A.shells,
      conclusion: "Exact direct source IDs survive, but durable input precedes rewrites. Final shell command/cwd rows have no call ID and identical pre-rewrite text cannot disambiguate them." }
    await negativeWindow(sessionID, links.map(link => link.request.id), "two shell permissions pending")
  } else if (scenario === "skill-reload") {
    evidence.before = await control("cli", { type: "skills", directory: initial })
    assert.match(skill(evidence.before).content, /W3_SKILL_CONTENT_A/)
    respond(0, [{ id: "w3-skill", name: "skill", input: { id: "w3-evidence" } }])
    const barrier = await until("native skill post-selection evaluation barrier", value => value.A?.evaluations.some(row => row.held))
    const evaluation = barrier.A.evaluations.find(row => row.held)
    assert.equal(evaluation.event.source.id, "w3-skill")
    assert.match(skill(evaluation.catalogAtPostSelectionBarrier).content, /W3_SKILL_CONTENT_A/)
    assert.equal(barrier.cli.asked.length, 0)
    await control("A", { type: "release-skill" })
    const held = await until("native skill permission pending", value => value.cli?.linked.length === 1)
    const link = held.cli.linked[0], item = sourceItem(link)
    assert.equal(link.request.action, "skill")
    assert.equal(link.request.sessionID, sessionID)
    assert.deepEqual(link.request.source, evaluation.event.source)
    assert.deepEqual(link.request.resources, ["w3-evidence"])
    assert.equal(item.name, "skill")
    assert.deepEqual(item.state.input, { id: "w3-evidence" })
    await control("A", { type: "skill-B" })
    evidence.after = await control("cli", { type: "skills", directory: initial })
    assert.match(skill(evidence.after).content, /W3_SKILL_CONTENT_B/)
    assert.equal(skill(evidence.before).path, skill(evidence.after).path)
    assert.equal(JSON.stringify(link.request).includes("W3_SKILL_CONTENT_"), false)
    assert.equal(JSON.stringify(item).includes("W3_SKILL_CONTENT_"), false)
    const currentMessage = await control("cli", { type: "read", sessionID, messageID: link.message.id })
    assert.deepEqual(sourceItem({ ...link, message: currentMessage }), item)
    evidence.skill = { link, evaluation, currentMessage,
      selectedContentProof: "Pinned native source selects before permission.evaluate; A is the sole controlled catalog at that barrier. Public output/snapshot of the selected object is unavailable before approval." }
    await negativeWindow(sessionID, [link.request.id], "skill selected under A remains pending with catalog B")
  } else if (scenario === "edit-preview") {
    const expected = [
      { id: "w3-write-local", name: "write", input: { path: "target.txt", content: "W3_AFTER\n" } },
      { id: "w3-write-external", name: "write", input: { path: editTargets[1], content: "W3_EXTERNAL_AFTER\n" } },
    ]
    respond(0, expected)
    const held = await until("independent native edit and external-directory stages", value => value.cli?.linked.length === 2)
    const links = held.cli.linked
    assert.equal(new Set(links.map(link => link.request.id)).size, 2)
    for (const link of links) {
      const item = sourceItem(link), call = expected.find(call => call.id === item.id)
      assert.ok(call)
      assert.equal(item.name, "write")
      assert.deepEqual(item.state.input, call.input)
      assert.equal(link.request.sessionID, sessionID)
    }
    const local = links.find(link => link.request.source.id === "w3-write-local")
    const external = links.find(link => link.request.source.id === "w3-write-external")
    assert.equal(local.request.action, "edit")
    assert.equal(external.request.action, "external_directory")
    const previews = local.request.metadata.files
    assert.equal(previews.length, 1)
    assert.equal(previews[0].status, "modified")
    assert.equal(previews[0].additions, 1)
    assert.equal(previews[0].deletions, 1)
    assert.match(previews[0].patch, /-W3_BEFORE\n\+W3_AFTER/)
    assert.equal(local.request.resources[0], previews[0].file)
    assert.equal(external.request.resources.length, 1)
    assert.ok(external.request.resources[0].startsWith(path.dirname(editTargets[1])))
    assert.equal(external.request.metadata?.files, undefined, "external approval precedes native preview construction")
    evidence.edits = { links, conclusion: "Native write exposes the pending edit preview; external-directory authorization is a separate earlier stage with exact source arguments and no constructed edit preview yet." }
    await negativeWindow(sessionID, links.map(link => link.request.id), "edit preview and separate external stage, unchanged targets")
  } else {
    const input = { command: "python3 fixture.py # W3 location", workdir: "inputs" }
    respond(0, [{ id: "w3-location-A", name: "shell", input }])
    const first = await until("location A permission", value => value.cli?.linked.length === 1)
    const linkA = first.cli.linked[0]
    assert.equal(linkA.request.action, "shell")
    assert.deepEqual(sourceItem(linkA).state.input, input)
    assert.equal(first.A.before[0].location.directory, initial)
    await negativeWindow(sessionID, [linkA.request.id], "location A pending")
    await interrupt(sessionID)
    await control("cli", { type: "move", sessionID, directory: moved })
    let relocated
    await until("public session location B", async () => {
      relocated = await control("cli", { type: "session", sessionID })
      return relocated.location.directory === moved
    })
    await control("cli", { type: "prompt", sessionID })
    await modelRequest(1)
    respond(1, [{ id: "w3-location-B", name: "shell", input }])
    const second = await until("location B companion and permission", value => value.B?.before.length === 1 && value.cli?.linked.length === 2)
    const linkB = second.cli.linked.find(link => link.request.source.id === "w3-location-B")
    assert.ok(linkB)
    assert.equal(linkB.request.action, "shell")
    assert.deepEqual(sourceItem(linkB).state.input, input)
    assert.equal(linkB.request.sessionID, sessionID)
    assert.equal(second.B.before[0].location.directory, moved)
    assert.equal(second.A.before[0].location.directory, initial)
    assert.equal(second.A.before[0].location.project.directory, project)
    assert.equal(second.B.before[0].location.project.directory, project)
    assert.equal(Object.hasOwn(linkA.message, "path"), false)
    assert.equal(Object.hasOwn(linkB.message, "path"), false)
    const oldMessage = await control("cli", { type: "read", sessionID, messageID: linkA.message.id })
    evidence.location = { relocated, linkA, linkB, oldMessage, captureA: second.A.before[0], captureB: second.B.before[0],
      conclusion: "Same session and relative workdir use distinct live invocation locations. Current session B cannot replace retained invocation A; no missed-capture recovery is established." }
    await negativeWindow(sessionID, [linkB.request.id], "location B pending")
  }
  await writeFile(path.join(artifacts, "pending.txt"), capture())
  await interrupt(sessionID)
  await negativeWindow(sessionID, [], "after interruption, zero replies and execution")
  await writeFile(cliPath, JSON.stringify({ ...cli, plugins: ["*", "-research.v2.evidence.cli"] }))
  const cleaned = (await until("CLI observation cleanup", value => value.cli?.cleaned)).cli
  await sleep(300)
  assert.deepEqual(await readObservation(files.cli), cleaned)
  const final = await observations()
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, scenario, temp,
    evidence, negativeWindows, limitations, calls, observations: final }, null, 2))
  console.log(`PASS V2 effective evidence (${scenario}): ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  try { await writeFile(path.join(artifacts, "failed.txt"), capture()) } catch { /* Host may have exited. */ }
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack,
    scenario, calls, errors, evidence, negativeWindows, limitations,
    observations: await Promise.all(["A", "B", "cli"].map(name => readObservation(files[name], { optional: true }))).catch(() => null) }, null, 2))
  throw error
} finally {
  try { await Promise.all(Object.values(controls).map(publisher => publisher.close())) }
  finally {
    try { await runtime.dispose() }
    finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }
}
