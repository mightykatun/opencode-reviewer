// Synthetic V2 public-API research only. Does not load or approve through the reviewer.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { transformAsync } from "@babel/core"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { readObservation } from "./smoke-observations.mjs"

runtimeArguments("smoke-v2-mouse-proof.mjs")
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assert.equal(version, "opencode v2.0.26")
await mkdir("/tmp/opencode", { recursive: true })
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-mouse-proof-")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-mouse-proof-"))
const project = path.join(temp, "project"), pluginDirectory = path.join(temp, "probe"), plugin = path.join(pluginDirectory, "tui.mjs")
await mkdir(project)
await mkdir(pluginDirectory)
await writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({ name: "research-v2-mouse-proof", type: "module", exports: { "./tui": "./tui.mjs" } }))
execFileSync("git", ["init", "--quiet", project])
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nPath("executed").write_text("unexpected approval")\n')
const observation = path.join(artifacts, "observations.json")
const jsx = `
import { Plugin } from '@opencode/plugin/tui'
import { CliRenderEvents } from '@opentui/core'
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}
export default Plugin.define({ id: 'research.v2.mouse-proof', setup(ctx) {
  const publisher = observationPublisher(${JSON.stringify(observation)})
  const result = { version: ctx.app.version, frames: 0, samples: [], asked: [], replies: [], errors: [], finalized: false }
  let panel, stopped = false
  const owns = (node, num) => !!node && (node.num === num || node.getChildren().some(child => owns(child, num)))
  const sample = kind => {
    if (stopped) return
    const probes = panel ? [[panel.x + 2, panel.y + 1], [panel.x + 2, panel.y + panel.height - 3]].map(([x,y]) => {
      const hit = ctx.renderer.hitTest(x,y); return { x,y,hit,owned:owns(panel,hit) }
    }) : []
    const value = { kind, at: Date.now(), frameId: ctx.renderer.frameId, mouse: ctx.renderer.useMouse,
      mode: ctx.keymap.mode.current(), route: ctx.ui.router.current().type,
      fullscreenCommand: ctx.keymap.commands().some(command => command.id === 'permission.prompt.fullscreen'),
      fullscreenShortcuts: ctx.keymap.shortcuts('permission.prompt.fullscreen'),
      panel: panel ? { num:panel.num, visible:panel.visible, destroyed:panel.isDestroyed, x:panel.x,y:panel.y,width:panel.width,height:panel.height } : null,
      probes }
    result.sample = value
    if (kind === 'frame') { result.frames++; result.frame = value }
    if (result.samples.length < 4096) result.samples.push(value)
    else result.errors.push('sample overflow')
    void publisher.publish(result)
  }
  // Center the synthetic probe under both the native palette and fullscreen portal.
  // This is not the production review panel or its placement contract.
  const off = ctx.ui.slot({ append: 'app', render: () => <box ref={value => panel=value}
    position="absolute" left={52} top={11} height={16} width={50} zIndex={1}
    padding={2} backgroundColor="#102030"><text>V2 MOUSE PROOF PANEL</text><text>READ ONLY SYNTHETIC OBSERVER</text></box> })
  const events = [ctx.data.on('permission.asked', event => { result.asked.push(event.data); sample('asked') }),
    ctx.data.on('permission.replied', event => { result.replies.push(event.data); sample('replied') })]
  const frame = () => sample('frame')
  ctx.renderer.on(CliRenderEvents.FRAME, frame)
  const timer = setInterval(() => sample('timer'), 100)
  ctx.keymap.layer(() => ({ mode:'global', priority:200, commands:[{bind:'f8',run:async () => {
    sample('final'); stopped=true; clearInterval(timer); result.finalized=true; await publisher.publish(result); await publisher.close()
  }}] }))
  sample('setup')
  return async () => { clearInterval(timer); ctx.renderer.off(CliRenderEvents.FRAME,frame); off(); events.forEach(fn=>fn()); if(!stopped) { stopped=true; await publisher.publish(result); await publisher.close() } }
} })
`
const compiled = await transformAsync(jsx, { filename: "v2-probe.jsx", configFile: false, babelrc: false,
  presets: [["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid" }]] })
await writeFile(plugin, compiled.code)
const calls = [], errors = []
let toolSent = false
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ url: req.url, body })
    const tool = body.tools?.find(item => item.function?.name === "shell")
    const doTool = !toolSent && !!tool
    if (doTool) toolSent = true
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "v2-mouse-proof", type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: "python3 fixture.py" }) } }] }
      : { role: "assistant", content: "V2 mouse research" }
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
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-mouse")
const send = key => runtime.tmux("send-keys", "-t", "v2-mouse", key)
const data = () => readObservation(observation, { optional: true })
const check = async record => {
  assert.deepEqual(errors, [])
  const executed = await readFile(path.join(project, "executed"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error })
  assert.equal(executed, "", "no native execution")
  if (!record) return
  assert.deepEqual(record.errors, [])
  assert.deepEqual(record.replies, [], "zero permission replies")
  assert.ok(record.samples.every(item => item.mouse === false && item.probes.every(probe => !probe.owned)), "no mouse override or false hit proof")
}
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do { const record = await data(), screen = capture(); await check(record); if (record && predicate(record, screen)) return record; await sleep(100) } while (Date.now() < end)
  throw Error(`Timed out waiting for ${label}`)
}
const controls = []
const hold = async (label, predicate) => {
  await until(label, predicate)
  const end = Date.now() + 4000
  do {
    const record = await data(), screen = capture(); await check(record)
    assert.ok(Date.now() - record.sample.at < 3000, "observer remains live")
    assert.ok(predicate(record, screen), label)
    await sleep(100)
  } while (Date.now() < end)
  const record = await data(), screen = capture()
  controls.push({ label, sample: record.sample, frame: record.frame,
    panelTextCaptured: screen.includes("V2 MOUSE PROOF PANEL"), paletteCaptured: screen.includes("Commands"), fullscreenCaptured: screen.includes("minimize") })
  await writeFile(path.join(artifacts, `${label}.txt`), screen)
  await writeFile(path.join(artifacts, `${label}.json`), JSON.stringify(record, null, 2))
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const config = { model: "fixture/fixture", update: "disable", permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 32000, output: 1000 } } } } } }
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  const cli = { mouse: false, animations: false, attention: { notifications: false, sound: false }, plugins: [pluginDirectory] }
  const launch = ["-d", "-s", "v2-mouse", "-x", "160", "-y", "40", "-c", project, "env",
    `OPENCODE_CLI_CONFIG_CONTENT=${JSON.stringify(cli)}`, host, "--standalone", project, "--prompt", "Run python3 fixture.py once."]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, temp, config, cli, launch, socket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
  await runtime.start(...launch)
  const visible = (record, screen) => record.asked.length === 1 && record.sample.probes.length === 2 && record.sample.mode === "base"
    && record.sample.fullscreenCommand && screen.includes("V2 MOUSE PROOF PANEL") && screen.includes("Permission") && !screen.includes("Commands") && !screen.includes("minimize")
  await hold("visible", visible)
  const panelNumber = (await data()).sample.panel.num
  send("C-p")
  await hold("dialog", (record, screen) => screen.includes("Commands") && !screen.includes("V2 MOUSE PROOF PANEL")
    && record.sample.panel?.num === panelNumber && record.sample.panel.visible)
  const dialogFrame = (await data()).frame.frameId
  send("Escape")
  // The palette's dismissal is asynchronous. A still-painted panel alone cannot
  // prove focus restoration, and sending ctrl+f too early is swallowed by it.
  await until("restored after dialog", (record, screen) => record.frame.frameId > dialogFrame && visible(record, screen))
  send("C-f")
  await hold("fullscreen", (record, screen) => screen.includes("minimize") && !screen.includes("V2 MOUSE PROOF PANEL")
    && record.sample.panel?.num === panelNumber && record.sample.panel.visible)
  send("C-f")
  await hold("restored", visible)
  send("F8")
  const record = await until("finalized", record => record.finalized)
  assert.equal(record.asked.length, 1)
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, temp, controls, calls,
    conclusion: "V2 public renderer hitTest lacks ownership with mouse=false; real dialog/fullscreen controls observed, zero permission replies or execution." }, null, 2))
  console.log(`PASS V2 mouse proof: ${artifacts}`)
} catch (error) {
  await writeFile(path.join(artifacts, "failed.txt"), capture()).catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, temp, errors, calls, observations: await data().catch(() => null) }, null, 2))
  throw error
} finally {
  await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
