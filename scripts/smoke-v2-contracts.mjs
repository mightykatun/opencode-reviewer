// Phase-0 public-contract probe. Synthetic host only, never loads the reviewer.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-v2-contracts.mjs")
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assertV2HostVersion(version)
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-contracts-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-contracts-")
const project = path.join(temp, "project"), plugin = path.join(temp, "probe")
await mkdir(project)
await mkdir(plugin)
await mkdir(path.join(temp, "config/opencode"), { recursive: true })
smokeGitInit(temp, project)
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nPath("executed").write_text("once")\n')
const observation = path.join(artifacts, "cli.json"), serverObservation = path.join(artifacts, "server.json")
const publisherImport = JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-contracts", type: "module",
  exports: { ".": "./server.mjs", "./tui": "./tui.mjs" } }))
await writeFile(path.join(plugin, "server.mjs"), `
import { Plugin } from '@opencode/plugin'
import { observationPublisher } from ${publisherImport}
export default Plugin.define({ id:'research.v2.contracts.server', async setup(ctx) {
  const publisher = observationPublisher(${JSON.stringify(serverObservation)})
  const result = { version:ctx.app.version, location:ctx.location, tools:[], before:[], evaluations:[], errors:[], shadowCalls:0 }
  const publish = () => publisher.publish(result)
  try {
    result.tools = await ctx.tool.list()
    if (${JSON.stringify(scenario)} === 'shadow-shell') {
      const original=result.tools.find(tool=>tool.id==='shell')
      if(!original) throw Error('Native shell missing')
      await ctx.tool.transform(editor => editor.add({...original, execute:async(input,context) => {
        result.shadowCalls++; await publish(); return original.execute(input,context)
      }}))
      const replacement=(await ctx.tool.list()).find(tool=>tool.id==='shell')
      result.shadow={before:JSON.parse(JSON.stringify(original)),after:JSON.parse(JSON.stringify(replacement)),
        beforeKeys:Object.keys(original).sort(),afterKeys:Object.keys(replacement).sort()}
    }
    await ctx.tool.hook('execute.before', event => { result.before.push(JSON.parse(JSON.stringify(event))); void publish() })
    await ctx.permission.hook('evaluate', event => { result.evaluations.push(JSON.parse(JSON.stringify(event))); void publish() })
    await publish()
  } catch(error) { result.errors.push(String(error)); await publish(); await publisher.close(); throw error }
  return async () => { result.cleaned=true; await publish(); await publisher.close() }
} })
`)
await writeFile(path.join(plugin, "tui.mjs"), `
import { Plugin } from '@opencode/plugin/tui'
import { observationPublisher } from ${publisherImport}
export default Plugin.define({ id:'research.v2.contracts.cli', setup(ctx) {
  const publisher = observationPublisher(${JSON.stringify(observation)})
  const abort = new AbortController(), tasks = new Set()
  const result = { version:ctx.app.version, runtime:process.versions, options:ctx.options,
    contextKeys:Object.keys(ctx), clientKeys:Object.keys(ctx.client), uiKeys:Object.keys(ctx.ui),
    dialogKeys:Object.keys(ctx.ui.dialog), location:ctx.location, asked:[], replied:[], events:[], errors:[], ticks:0, writes:0 }
  const publish = () => publisher.publish(result)
  const own = fn => { const task = Promise.resolve().then(fn).catch(error => result.errors.push(String(error))).finally(() => { tasks.delete(task); void publish() }); tasks.add(task) }
  const requestOptions = () => ({signal:AbortSignal.any([abort.signal, AbortSignal.timeout(10000)])})
  const stop = ctx.data.listen(({details:event}) => {
    if (result.events.length < 512) result.events.push({type:event.type,data:event.data})
    if (event.type === 'permission.replied') result.replied.push(event.data)
    if (event.type === 'permission.asked') {
      result.asked.push(event.data)
      own(async () => {
        const r=event.data
        result.session=await ctx.client.session.get({sessionID:r.sessionID}, requestOptions())
        result.message=await ctx.client.session.message.get({sessionID:r.sessionID,messageID:r.source.messageID}, requestOptions())
        result.messages=await ctx.client.message.list({sessionID:r.sessionID,limit:20,order:'desc'}, requestOptions())
        result.pending=await ctx.client.permission.list({sessionID:r.sessionID}, requestOptions())
        result.locationPending=await ctx.client.permission.request.list({location:result.session.location}, requestOptions())
        result.skills=await ctx.client.skill.list({location:result.session.location}, requestOptions())
        result.server=await ctx.client.server.info(requestOptions())
        const missing='ses_00000000000000000000000000'
        try { await ctx.client.session.get({sessionID:missing}, requestOptions()); result.missingUnexpectedSuccess=true }
        catch(error) { result.missing={requested:missing, name:error?.name, message:error?.message, value:JSON.parse(JSON.stringify(error))} }
        result.captured=true
      })
    }
    void publish()
  })
  const timer=setInterval(() => { result.ticks++; void publish() },100)
  ctx.keymap.layer(() => ({mode:'global',priority:200,commands:[{bind:'f8',run:() => own(async () => {
    if(result.writes || !result.captured) return
    const r=result.asked[0]
    const current=await ctx.client.permission.get({sessionID:r.sessionID,requestID:r.id},requestOptions())
    if(JSON.stringify(current)!==JSON.stringify(r)) throw Error('Pending request changed')
    result.writes++
    const value=await ctx.client.permission.reply({sessionID:r.sessionID,requestID:r.id,decision:'once'},requestOptions())
    result.replyReturn= value === undefined ? 'undefined' : value
    result.replySettled=true
  })}]}))
  void publish()
  return async () => { clearInterval(timer); stop(); abort.abort(); await Promise.allSettled([...tasks]);
    result.cleaned=true; await publish(); await publisher.close() }
} })
`)
const calls = [], errors = []
let toolSent = false
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ url: req.url, body })
    const doTool = !toolSent && body.tools?.some(item => item.function?.name === "shell")
    if (doTool) toolSent = true
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "contract-shell", type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: "python3 fixture.py" }) } }] }
      : { role: "assistant", content: "Contract probe complete" }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [delta, finish_reason] of [[message, null], [{}, doTool ? "tool_calls" : "stop"]])
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: doTool ? "tool_calls" : "stop" }] }))
    }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-contracts")
const data = () => readObservation(observation, { optional: true })
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    assert.deepEqual(errors, [])
    const record = await data()
    if (record) { assert.deepEqual(record.errors, []); if (await predicate(record)) return record }
    await sleep(100)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${label}`)
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const config = { model: "fixture/fixture", update: "disable", plugins: [plugin], permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 32000, output: 1000 } } } } } }
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  const cli = { animations: false, attention: { notifications: false, sound: false },
    plugins: [{ package: plugin, options: { sentinel: "phase-0" } }] }
  const cliPath = path.join(temp, "config/opencode/cli.json")
  await writeFile(cliPath, JSON.stringify(cli))
  const launch = ["-d", "-s", "v2-contracts", "-x", "160", "-y", "40", "-c", project,
    host, "--standalone", project, "--prompt", "Run python3 fixture.py once."]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, temp, config, cli, launch, socket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
  await runtime.start(...launch)
  const initial = await until("native permission and public reads", record => record.captured)
  assert.equal(initial.asked.length, 1)
  assert.equal(initial.options.sentinel, "phase-0")
  assert.equal(initial.message.id, initial.asked[0].source.messageID)
  assert.equal(initial.message.type, "assistant")
  assert.equal(initial.pending[0].id, initial.asked[0].id)
  assert.equal(initial.session.location.directory, project)
  assert.equal(initial.missingUnexpectedSuccess, undefined)
  assert.equal(initial.missing.value._tag, "SessionNotFoundError")
  assert.equal(initial.missing.value.sessionID, initial.missing.requested)
  const hook = await readObservation(serverObservation)
  assert.deepEqual(hook.errors, [])
  if (scenario === "shadow-shell") {
    assert.deepEqual(hook.shadow.before, hook.shadow.after, "a custom replacement retains the native public catalog data")
    assert.deepEqual(hook.shadow.beforeKeys, hook.shadow.afterKeys)
    assert.equal(hook.shadowCalls, 1, "the replacement executor, not the unmodified registry entry, ran")
  }
  assert.equal(hook.before.length, 1)
  assert.equal(hook.evaluations.length, 1)
  assert.equal(hook.evaluations[0].source.id, initial.asked[0].source.id)
  // Actual pending window: the observational companion must never resolve it.
  const end = Date.now() + 2500
  do {
    const held = await data()
    assert.equal(held.writes, 0)
    assert.deepEqual(held.replied, [])
    await assert.rejects(readFile(path.join(project, "executed")), { code: "ENOENT" })
    await sleep(100)
  } while (Date.now() < end)
  await writeFile(path.join(artifacts, "pending.txt"), capture())
  runtime.tmux("send-keys", "-t", "v2-contracts", "F8")
  const replied = await until("one confirmed native once", record => record.replySettled && record.replied.length === 1)
  assert.equal(replied.replyReturn, "undefined")
  assert.equal(replied.writes, 1)
  await until("native execution outcome", record => record.events.some(event => event.type === "session.execution.succeeded"))
  assert.equal(await readFile(path.join(project, "executed"), "utf8"), "once")
  await writeFile(cliPath, JSON.stringify({ ...cli, plugins: ["*", "-research.v2.contracts.cli"] }))
  const cleaned = await until("plugin disable cleanup", record => record.cleaned)
  await sleep(500)
  assert.deepEqual(await data(), cleaned, "unloaded plugin publishes no further callbacks")
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, temp, scenario,
    assertions: ["real native shell permission", "linked public message", "session and location pending reads", "exact missing-session error",
      "observational server hooks", "2500ms no-reply/no-execution window", "single native once with void result", "execution succeeded", "disable drains and stops callbacks"],
    calls }, null, 2))
  console.log(`PASS V2 contracts (${scenario}): ${artifacts}`)
} catch (error) {
  await writeFile(path.join(artifacts, "failed.txt"), capture()).catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, errors, calls, observations: await data().catch(() => null) }, null, 2))
  throw error
} finally {
  await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
