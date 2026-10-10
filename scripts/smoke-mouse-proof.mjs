// F32 validation only. Register normal|fast in runtime-inventory.mjs, then build first.
// Real pinned host; read-only observations never substitute for production proof.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-mouse-proof.mjs")
assert.ok(["normal", "fast"].includes(scenario))
const fast = scenario === "fast", delay = 2, holdMs = (delay + 2) * 1000, pollMs = 100
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assert.equal(version, "1.18.35", "fixture requires the pinned host")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime", `mouse-proof-${scenario}-`))
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-mouse-proof-"))
const project = path.join(temp, "project"), bundle = path.join(temp, "bundle.mjs")
await mkdir(project); await mkdir(path.join(temp, "config"))
execFileSync("git", ["init", "--quiet", project])
await copyFile(path.join(root, "dist/tui.js"), bundle)
const bundleSHA256 = createHash("sha256").update(await readFile(bundle)).digest("hex")
const observationFile = path.join(artifacts, "observations.json"), plugin = path.join(temp, "observer.mjs")

// Serialized as a function so node --check also parses the injected observer body.
async function observer(api, options, file, observationPublisher, withHistoryObservations, CliRenderEvents, ScrollBoxRenderable) {
  const records = { renders: [], diagnostics: [], asked: [], replies: [], errors: [], dropped: 0, finalized: false }
  const publisher = observationPublisher(file), previous = new Map()
  let panelNumber, lastBounds, stopped = false
  const save = () => publisher.publish(records)
  const children = node => [...node.getChildren(), ...(node instanceof ScrollBoxRenderable ? [node.wrapper] : [])]
  const find = (node, num) => {
    if (node.num === num) return node
    for (const child of children(node)) { const found = find(child, num); if (found) return found }
  }
  const owns = (node, num) => node.num === num || children(node).some(child => owns(child, num))
  const region = node => ({ num: node.num, type: node.constructor.name, x: node.x, y: node.y,
    width: node.width, height: node.height, visible: node.visible, destroyed: node.isDestroyed })
  const snapshot = () => {
    const panel = panelNumber === undefined ? undefined : find(api.renderer.root, panelNumber)
    if (panel) lastBounds = region(panel)
    const probe = (label, x, y) => {
      const hit = api.renderer.hitTest(x, y), owner = find(api.renderer.root, hit)
      return { label, x, y, hit, owned: !!panel && owns(panel, hit), owner: owner ? region(owner) : null }
    }
    return { useMouse: api.renderer.useMouse, dialogOpen: api.ui.dialog.open, dialogDepth: api.ui.dialog.depth,
      width: api.renderer.width, height: api.renderer.height, panel: panel ? region(panel) : null,
      // A public dialog can unmount the live panel. Keep probing its last coordinates,
      // but never mistake those cached coordinates for a currently mounted owner.
      probeBounds: lastBounds ?? null,
      probes: lastBounds ? [probe("heading", lastBounds.x + 2, lastBounds.y + 1),
        probe("rating", lastBounds.x + 2, lastBounds.y + 3), probe("footer", lastBounds.x + 2, lastBounds.y + lastBounds.height - 3)] : [] }
  }
  const append = (key, value) => {
    if (stopped) return
    if (records[key].length < 2048) records[key].push(value); else records.dropped++
    return save()
  }
  const observe = event => {
    if (stopped) return
    panelNumber = event.panel
    const { at, ...state } = event
    const value = { ...state, ...snapshot() }, signature = JSON.stringify(value)
    if (previous.get(event.stage) === signature) return
    previous.set(event.stage, signature)
    return append("renders", { at, wallAt: Date.now(), ...value })
  }
  const offEvents = [["permission.asked", "asked"], ["permission.replied", "replies"]].map(([type, key]) =>
    api.event.on(type, event => { void append(key, { wallAt: Date.now(), ...event.properties }) }))
  await withHistoryObservations(observe, event => append("diagnostics", { ...event, wallAt: Date.now() }))(api, options)
  // Frame observations and periodic read-only samples are separate: a timer sample
  // is never advertised as a fresh paint, and an idle renderer need not repaint.
  const frame = () => {
    if (stopped) return
    records.frame = { at: Date.now(), frameId: api.renderer.frameId, ...snapshot() }
    void save()
  }
  api.renderer.on(CliRenderEvents.FRAME, frame)
  const timer = setInterval(() => {
    if (stopped) return
    try { records.sample = { at: Date.now(), frameId: api.renderer.frameId, ...snapshot() }; void save() }
    catch (error) { void append("errors", String(error)) }
  }, 100)
  const off = api.keymap.registerLayer({ priority: 200, mode: "base", bindings: [{ key: "f8", cmd: async () => {
    clearInterval(timer)
    stopped = true
    records.finalized = true
    save()
    await publisher.close()
  } }] })
  await save()
  api.lifecycle.onDispose(async () => {
    clearInterval(timer); off(); offEvents.forEach(dispose => dispose())
    api.renderer.off(CliRenderEvents.FRAME, frame)
    if (stopped) return
    stopped = true
    save()
    await publisher.close()
  })
}
await writeFile(plugin, `
import { withHistoryObservations } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
import { CliRenderEvents, ScrollBoxRenderable } from '@opentui/core';
const observer = ${observer.toString()};
export default { id: 'mouse-proof-observer', tui: (api, options) => observer(api, options,
  ${JSON.stringify(observationFile)}, observationPublisher, withHistoryObservations, CliRenderEvents, ScrollBoxRenderable) };
`)
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nwith Path("executions").open("a") as f:\n    f.write("executed\\n")\n')
const desc = "MOUSE PROOF REPORT. Writes only the requested isolated marker."
const calls = [], errors = [], samples = []
let toolSent = false, releaseReview, reviewClosedEarly = false
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ at: Date.now(), url: req.url, body })
    if (req.url === "/review/chat/completions") {
      assert.equal(calls.filter(call => call.url === req.url).length, 1, "exactly one reviewer POST")
      assert.equal(body.stream, fast)
      if (!fast) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true, desc }) }, finish_reason: "stop" }] }))
      } else {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ safe: true, desc }).slice(0, -2) }, finish_reason: null }] })}\n\n`)
        releaseReview = () => {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '"}' }, finish_reason: null }] })}\n\n`)
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
        }
        res.on("close", () => { if (!res.writableEnded) reviewClosedEarly = true })
      }
      return
    }
    assert.equal(req.url, "/main/chat/completions")
    const doTool = !toolSent && body.tools?.some(tool => tool.function?.name === "bash")
    if (doTool) toolSent = true
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "mouse-proof", type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "python3 fixture.py", description: "Write isolated mouse-proof marker" }) } }] }
      : { role: "assistant", content: "Mouse proof fixture finished." }
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
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "mouse-proof")
const send = (...keys) => runtime.tmux("send-keys", "-t", "mouse-proof", ...keys)
const data = () => readObservation(observationFile, { optional: true })
const executions = async () => {
  try { return await readFile(path.join(project, "executions"), "utf8") }
  catch (error) { if (error.code === "ENOENT") return ""; throw error }
}
const assertNoApproval = async record => {
  assert.deepEqual(errors, [], "fixture server stays healthy")
  assert.equal(await executions(), "", "native command must not execute")
  if (!record) return
  assert.deepEqual(record.errors, [])
  assert.equal(record.dropped, 0, "observation history must be complete")
  assert.deepEqual(record.replies, [], "no native permission reply")
  assert.ok(!record.diagnostics.some(event => event.phase === "approval-reply"), "no automatic reply dispatch diagnostic")
  assert.ok(record.renders.every(event => event.useMouse === false && event.probes.every(probe => !probe.owned)
    && !event.eligible && !event.physical && !event.covered
    && !["countdown", "allowing", "approved"].includes(event.auto)), "missing hit proof must never authorize approval")
  if (record.sample) assert.equal(record.sample.useMouse, false, "mouse stays disabled")
  if (record.frame) assert.equal(record.frame.useMouse, false, "paint never enables mouse")
}
const until = async (label, predicate, timeout = 20000) => {
  const end = Date.now() + timeout
  do {
    const record = await data(), screen = capture()
    await assertNoApproval(record)
    if (record && await predicate(record, screen)) return record
    await sleep(pollMs)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${label}: ${scenario}`)
}
const save = async name => {
  await writeFile(path.join(artifacts, name + ".txt"), capture())
  await writeFile(path.join(artifacts, name + ".ansi"), runtime.tmux("capture-pane", "-p", "-e", "-t", "mouse-proof"))
  await writeFile(path.join(artifacts, name + ".json"), JSON.stringify(await data(), null, 2))
}
const visible = (record, screen) => screen.includes("Permission analysis") && screen.includes("MOUSE PROOF REPORT")
  && screen.includes("✓ Safe") && screen.includes("Permission required") && !record.sample?.dialogOpen
  && record.sample?.panel?.visible && record.sample.probes.length === 3
const noHits = sample => assert.ok(sample.probes.every(probe => !probe.owned), "all recorded panel probes lack ownership")
const hold = async (label, check) => {
  const start = Date.now()
  do {
    const record = await data(), screen = capture()
    assert.ok(record?.sample, "periodic public-API sample exists")
    assert.ok(Date.now() - record.sample.at < 3000, "observer remains live throughout negative window")
    await assertNoApproval(record)
    noHits(record.sample)
    check(record, screen)
    assert.doesNotMatch(screen, /Allowed in \d+s|Auto-approved; finishing report/)
    samples.push({ label, at: Date.now(), panelText: screen.includes("Permission analysis"), reportText: screen.includes("MOUSE PROOF REPORT"),
      fullscreen: screen.includes("minimize"), ...record.sample })
    await sleep(pollMs)
  } while (Date.now() - start < holdMs)
  await save(label)
}
const controls = async phase => {
  await until(`${phase} visible panel`, visible)
  await hold(`${phase}-visible`, (record, screen) => assert.ok(visible(record, screen)))
  send("C-p")
  await until("public command palette", (record, screen) => record.sample?.dialogOpen && screen.includes("Commands") && !screen.includes("Permission analysis"))
  await hold(`${phase}-dialog`, (record, screen) => {
    assert.equal(record.sample.dialogOpen, true)
    assert.match(screen, /Commands/)
    assert.doesNotMatch(screen, /Permission analysis|MOUSE PROOF REPORT/)
  })
  send("Escape")
  const restored = await until("panel after public dialog", visible)
  const panelNumber = restored.sample.panel.num, at = Date.now()
  send("C-f")
  await until("native permission fullscreen", (record, screen) => record.frame?.at >= at
    && !record.sample?.dialogOpen && screen.includes("minimize") && !screen.includes("Permission analysis"))
  await hold(`${phase}-fullscreen`, (record, screen) => {
    assert.equal(record.sample.dialogOpen, false, "native fullscreen is not a public dialog")
    assert.equal(record.sample.panel?.num, panelNumber, "native fullscreen covers the same mounted panel")
    assert.equal(record.sample.panel.visible, true, "logical visibility is not physical ownership")
    assert.match(screen, /minimize/)
    assert.match(screen, /Allow once.*Allow always.*Reject/)
    assert.doesNotMatch(screen, /Permission analysis|MOUSE PROOF REPORT/)
  })
  send("C-f")
  await until("panel after native fullscreen", visible)
  await hold(`${phase}-restored`, (record, screen) => assert.ok(visible(record, screen)))
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false, permission: { bash: "ask" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } } }
  const settings = { notify: false, baseURL: base + "/review", model: "fixture", autoApprove: true, fastMode: fast,
    stream: fast, autoApproveDelaySeconds: delay, timeoutMs: 120000, staleReminderSeconds: 0 }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ theme: "opencode", plugin: [[plugin, settings]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_MOUSE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  const launch = ["-d", "-s", "mouse-proof", "-x", "160", "-y", "40", "-c", project, "env",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`), host, project, "--prompt", "Run python3 fixture.py once to write the isolated marker."]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ scenario, version, bundleSHA256, temp, delay, holdMs, config, settings, launch,
    supervisorSocket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
  await runtime.start(...launch)
  await until("Safe report physically captured", visible, 90000)
  if (fast) {
    assert.ok(releaseReview, "stream is held after a Safe preview")
    await until("parsed Safe preview", record => record.diagnostics.some(event => event.phase === "first-rating")
      && record.renders.some(event => event.stage === "frame" && !event.final))
    await controls("preview")
    assert.equal(reviewClosedEarly, false)
    assert.ok(!(await data()).diagnostics.some(event => event.phase === "final-validation"), "preview controls precede transport completion")
    releaseReview()
  }
  await until("final report painted without proof", record => record.diagnostics.some(event => event.phase === "final-validation")
    && record.renders.some(event => event.stage === "frame" && event.final && event.painted && event.contentMatches
      && !event.streaming && !event.highlighting && event.children > 0))
  await controls("final")
  send("F8")
  const record = await until("explicit final observation flush", record => record.finalized)
  assert.equal(record.asked.length, 1)
  assert.equal(calls.filter(call => call.url === "/review/chat/completions").length, 1)
  assert.equal(reviewClosedEarly, false)
  await save("finalized")
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", scenario, version, bundleSHA256, temp, samples, calls,
    conclusion: "Visible Safe report lacks hit ownership with mouse disabled; no automatic reply or execution. Dialog and native fullscreen controls remain blocked." }, null, 2))
  console.log(`PASS mouse-proof ${scenario}: captured visible report, missing hit proof, no approval, dialog/fullscreen controls; ${artifacts}`)
} catch (error) {
  await save("failed").catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, temp, errors,
    observations: await data().catch(() => null), samples, calls }, null, 2))
  throw error
} finally {
  await runtime.dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
