// Synthetic pinned-host native family queue probe. No reviewer or permission replies.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

function cliSetup(ctx) {
  const publisher = observationPublisher(ctx.options.observation), abort = new AbortController()
  const record = { errors: [], commands: [], asked: [], replied: [], sessions: {} }
  const publish = () => publisher.publish(record)
  const options = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const off = ctx.data.listen(({ details: event }) => {
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
        if (command.type === "create") {
          const location = ctx.location ?? ctx.data.location.default(), model = { providerID: "fixture", id: "fixture" }
          for (const [role, parent] of [["ROOT"], ["CHILD", "ROOT"], ["NESTED", "CHILD"], ["SIBLING", "ROOT"]]) {
            record.sessions[role] = await ctx.client.session.create({ title: `WQUEUE_${role}`, location, model,
              ...(parent ? { parentID: record.sessions[parent].id } : {}) }, options())
          }
          ctx.ui.router.navigate({ type: "session", sessionID: record.sessions.ROOT.id })
        } else if (command.type === "prompt") {
          await ctx.client.session.prompt({ sessionID: record.sessions[command.role].id, text: `WQUEUE_${command.role}` }, options())
        } else if (command.type === "snapshot") {
          value = { family: ctx.data.session.family(record.sessions.ROOT.id), pending: {} }
          for (const [role, session] of Object.entries(record.sessions)) {
            ctx.data.session.permission.invalidate(session.id)
            await ctx.data.session.permission.sync(session.id)
            value.pending[role] = await ctx.client.permission.list({ sessionID: session.id }, options())
          }
        } else if (command.type === "interrupt") {
          await ctx.client.session.interrupt({ sessionID: record.sessions[command.role].id, continue: false }, options())
        } else if (command.type === "route") {
          ctx.ui.router.navigate({ type: "session", sessionID: record.sessions[command.role].id })
        } else throw Error(`Unknown control ${command.type}`)
        record.commands.push({ sequence, type: command.type, value })
        await publish()
      }
      await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => { if (!abort.signal.aborted) { record.errors.push(String(error)); void publish() } })
  void publish()
  return async () => { off(); abort.abort(); await loop; record.cleaned = true; await publish(); await publisher.close() }
}

const { hostVersions } = runtimeArguments("smoke-v2-native-queue.mjs")
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assert.ok(hostVersions.includes(version), "An explicitly selected verification host")
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-native-queue-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-native-queue-")
const project = path.join(temp, "project"), plugin = path.join(temp, "plugin")
await Promise.all([mkdir(project), mkdir(plugin)])
execFileSync("git", ["init", "--quiet", project])
await writeFile(path.join(project, "queue.py"), 'from pathlib import Path\nPath("executed").write_text("unexpected")\n')
const observation = path.join(artifacts, "observations.json"), controlFile = path.join(artifacts, "control.json")
const controlPublisher = observationPublisher(controlFile)
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-native-queue", type: "module", exports: { "./tui": "./tui.mjs" } }))
await writeFile(path.join(plugin, "tui.mjs"), `import { Plugin } from '@opencode/plugin/tui'\nimport { setTimeout as sleep } from 'node:timers/promises'\nimport { observationPublisher, readObservation } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}\n${cliSetup}\nexport default Plugin.define({id:'research.v2.native-queue',setup:cliSetup})\n`)
const errors = [], calls = [], sent = new Set(), windows = []
const server = createServer(async (req, res) => {
  try {
    let text = ""
    for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
    const body = JSON.parse(text)
    calls.push(body)
    const user = body.messages?.filter(message => message.role === "user").at(-1)
    const role = JSON.stringify(user).match(/WQUEUE_(ROOT|CHILD|NESTED|SIBLING)/)?.[1]
    const tool = body.tools?.some(tool => tool.function.name === "shell") && role && !sent.has(role)
    if (tool) sent.add(role)
    const message = tool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `queue-${role}`, type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: `python3 queue.py WQUEUE_${role}` }) } }] }
      : { role: "assistant", content: "Queue probe" }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [delta, finish_reason] of [[message, null], [{}, tool ? "tool_calls" : "stop"]])
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? "tool_calls" : "stop" }] }))
    }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-queue")
const observe = async () => {
  assert.deepEqual(errors, [])
  const value = await readObservation(observation, { optional: true })
  if (value) { assert.deepEqual(value.errors, []); assert.deepEqual(value.replied, []) }
  await assert.rejects(readFile(path.join(project, "executed")), { code: "ENOENT" })
  return value
}
const until = async (label, predicate) => {
  const end = Date.now() + 45000
  do {
    const value = await observe()
    if (value && await predicate(value)) return value
    await sleep(80)
  } while (Date.now() < end)
  throw Error(`Timed out: ${label}`)
}
let sequence = 0
const control = async command => {
  const id = ++sequence
  await controlPublisher.publish({ ...command, sequence: id }); await controlPublisher.flush()
  const value = await until(command.type, value => value.commands.some(item => item.sequence === id))
  return value.commands.find(item => item.sequence === id).value
}
// Only inspect the native permission prompt region, excluding message text and titles.
const prompted = screen => {
  const index = screen.indexOf("Permission required")
  return index < 0 ? "" : screen.slice(index)
}
const hold = async (label, expected, pendingRoles) => {
  await until(label, () => prompted(capture()).includes(`python3 queue.py WQUEUE_${expected}`))
  const start = Date.now()
  do {
    await observe()
    assert.ok(prompted(capture()).includes(`python3 queue.py WQUEUE_${expected}`), `${label}: native front remains stable`)
    await sleep(100)
  } while (Date.now() - start < 1500)
  const snapshot = await control({ type: "snapshot" })
  for (const role of ["ROOT", "CHILD", "NESTED", "SIBLING"]) assert.equal(snapshot.pending[role].length, pendingRoles.includes(role) ? 1 : 0)
  windows.push({ label, expected, durationMs: Date.now() - start, snapshot })
  await writeFile(path.join(artifacts, `${label}.txt`), capture())
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const config = { model: "fixture/fixture", update: "disable", permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 32000, output: 1000 } } } } } }
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  const cli = { animations: false, attention: { notifications: false, sound: false }, session: { permissions: "prompt" },
    plugins: [{ package: plugin, options: { observation, control: controlFile } }] }
  await mkdir(path.join(temp, "config/opencode"), { recursive: true })
  const cliPath = path.join(temp, "config/opencode/cli.json")
  await writeFile(cliPath, JSON.stringify(cli))
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, temp, config, cli, socket: runtime.socket }))
  await runtime.start("-d", "-s", "v2-queue", "-x", "160", "-y", "40", "-c", project, host, "--standalone", project)
  await control({ type: "create" })
  // Deep-only membership is observed before any direct child or root request.
  await control({ type: "prompt", role: "NESTED" })
  await hold("deep-only", "NESTED", ["NESTED"])
  await control({ type: "prompt", role: "SIBLING" })
  await until("sibling permission", value => value.asked.length === 2)
  await control({ type: "prompt", role: "CHILD" })
  await until("child permission", value => value.asked.length === 3)
  const state = await observe(), beforeRoot = await control({ type: "snapshot" })
  const byID = Object.fromEntries(Object.entries(state.sessions).map(([role, session]) => [session.id, role]))
  const familyOrder = beforeRoot.family.filter(id => id !== state.sessions.ROOT.id).map(id => byID[id])
  assert.equal(new Set(familyOrder).size, 3)
  assert.ok(familyOrder.includes("NESTED"))
  await hold("family-order", familyOrder[0], ["CHILD", "NESTED", "SIBLING"])
  await control({ type: "prompt", role: "ROOT" })
  await hold("root-priority", "ROOT", ["ROOT", "CHILD", "NESTED", "SIBLING"])
  await control({ type: "interrupt", role: "ROOT" })
  await control({ type: "snapshot" })
  await hold("family-restored", familyOrder[0], ["CHILD", "NESTED", "SIBLING"])
  for (const role of ["CHILD", "NESTED", "SIBLING"]) await control({ type: "interrupt", role })
  const final = await control({ type: "snapshot" })
  assert.ok(Object.values(final.pending).every(items => items.length === 0))
  await writeFile(cliPath, JSON.stringify({ ...cli, plugins: ["*", "-research.v2.native-queue"] }))
  const cleaned = await until("cleanup", value => value.cleaned)
  await sleep(300)
  assert.deepEqual(await observe(), cleaned)
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, familyOrder, windows, calls,
    limitations: "Native permission membership/order only. No forms, autoaccept, notification or reviewer approval coverage; no permission replies.", observations: cleaned }, null, 2))
  console.log(`PASS V2 native queue: ${artifacts}`)
} catch (error) {
  await writeFile(path.join(artifacts, "failed.txt"), capture()).catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, calls, windows,
    observations: await readObservation(observation, { optional: true }) }, null, 2))
  throw error
} finally {
  try { await controlPublisher.close() }
  finally { try { await runtime.dispose() } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
