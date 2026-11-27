import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { archiveFiles, reviewerRpc } from "./smoke-v2-headless-support.mjs"
import { managedReviewer, verifiedSnapshot } from "./smoke-v2-rpc.mjs"
import { smokeEnvironment, smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { packFixtureArchive } from "./smoke-package.mjs"
import { publishObservation, readObservation } from "./smoke-observations.mjs"
import { activatePalette } from "./smoke-ui.mjs"

const { scenario } = runtimeArguments("smoke-v2-lifecycle.mjs")
const detach = scenario === "viewer-attach-detach"
const sounds = scenario === "viewer-settings-sounds"
const root = path.resolve(import.meta.dirname, "..")
const artifacts = await mkdtemp(path.join(root, ".runtime", `v2-lifecycle-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-lifecycle-")
const env = smokeEnvironment(temp)
env.XDG_STATE_HOME = await mkdtemp("/tmp/reviewer-lifecycle-state-")
await mkdir(path.join(env.XDG_STATE_HOME, "opencode"), { mode: 0o700 })
const project = path.join(temp, "project")
const config = path.join(env.XDG_CONFIG_HOME, "opencode")
const runtime = await smokeRuntime(temp)
const host = process.env.OPENCODE_BIN ?? "opencode"
const report = "Cold startup advisory report."
let reviews = 0
let releaseVerdict
const heldVerdict = new Promise(resolve => { releaseVerdict = resolve })
let executions = 0
const model = createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  if (body.model === "reviewer") {
    reviews++
    if (detach) await heldVerdict
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 12 }, choices: [{ finish_reason: "stop", message: { role: "assistant",
      content: JSON.stringify({ safe: true, reason: "The user requested a marker.", desc: report }) } }] }))
    return
  }
  if (body.messages.at(-1)?.role === "tool") {
    assert.match(JSON.stringify(body.messages.at(-1).content), /COLD_MARKER/)
    executions++
  }
  const message = executions ? { role: "assistant", content: "Done." } : { role: "assistant", content: null, tool_calls: [{ index: 0, id: "cold-marker", type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: "echo COLD_MARKER" }) } }] }
  const finish = message.tool_calls ? "tool_calls" : "stop"
  if (body.stream) {
    response.setHeader("Content-Type", "text/event-stream")
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  } else {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ choices: [{ message, finish_reason: finish }] }))
  }
})
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "cold-viewer")
// A short square wave that cannot be mistaken for any bundled MP3.
function wave(amplitude) {
  const data = Buffer.alloc(44 + 256)
  data.write("RIFF")
  data.writeUInt32LE(data.length - 8, 4)
  data.write("WAVEfmt ", 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(8000, 24)
  data.writeUInt32LE(16000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write("data", 36)
  data.writeUInt32LE(256, 40)
  let offset = 44
  while (offset < data.length) {
    data.writeInt16LE(amplitude, offset)
    data.writeInt16LE(-amplitude, offset + 2)
    offset += 4
  }
  return data
}
try {
  await mkdir(project)
  await mkdir(config, { recursive: true })
  smokeGitInit(temp, project)
  const { installed } = await packFixtureArchive({ root, temp, env, expectedFiles: archiveFiles })
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve))
  const baseURL = `http://127.0.0.1:${model.address().port}/v1`
  const policyFile = path.join(config, "opencode-reviewer.json")
  const serverPolicy = { baseURL, model: "reviewer", retrieval: false, apiKey: "fixture-verdict-secret",
    autoApprove: detach, autoApproveDelaySeconds: 3 }
  await publishObservation(policyFile, { server: serverPolicy, tui: { notify: false, notifySound: false } })
  await publishObservation(path.join(config, "opencode.json"), { model: "fixture/session", plugins: [installed], update: "disable",
    permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL, apiKey: "fixture" },
      models: { session: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } })
  const viewerConfig = path.join(temp, "viewer-config")
  await mkdir(path.join(viewerConfig, "opencode"), { recursive: true })
  let viewer = installed
  const played = path.join(artifacts, "player.json")
  if (sounds) {
    viewer = path.join(temp, "recording-viewer")
    await mkdir(viewer)
    await publishObservation(path.join(viewer, "package.json"), { name: "fixture-recording-viewer", type: "module", exports: { "./tui": "./index.mjs" } })
    const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
    await writeFile(path.join(viewer, "index.mjs"), helpers + `
import { withNotificationProcesses } from ${JSON.stringify(pathToFileURL(path.join(installed, "dist/tui.js")).href)}
export default { id: "opencode-reviewer", async setup(ctx) {
  const publisher = observationPublisher(${JSON.stringify(played)})
  const calls = []
  const stop = await withNotificationProcesses(() => ({
    start(command, args) {
      const call = { command }
      calls.push(call)
      const result = (async () => {
        if (command === "paplay" || command === "pw-play") call.wave = (await fs.readFile(args.at(-1))).toString("base64")
        await publisher.publish(calls)
        await publisher.flush()
        return { code: 0, stdout: "", stderr: "" }
      })()
      return { result, started: Promise.resolve(true) }
    },
    dispose: async () => {}
  })).setup(ctx)
  return async () => {
    await stop()
    await publisher.close()
  }
} }
`)
  }
  await publishObservation(path.join(viewerConfig, "opencode/cli.json"), { plugins: [viewer], animations: false, session: { permissions: "prompt" } })
  const service = await managedReviewer({ runtime, env, directory: project, host })
  const { client } = service
  const session = await client.session.create({ title: "Cold viewer", location: { directory: project } })
  await publishObservation(path.join(artifacts, "startup-snapshot.json"), await verifiedSnapshot(service, project))
  await client.session.prompt({ sessionID: session.id, text: "Run echo COLD_MARKER once." })
  const until = async (label, check) => {
    const end = performance.now() + 60000
    do {
      const value = await check()
      if (value) return value
      await sleep(50)
    } while (performance.now() < end)
    throw Error("Timed out waiting for " + label)
  }
  const before = await until("pending server attempt", async () =>
    (await service.snapshot()).views.find(row => row.head && row.root === session.id && row.attempt
      && (detach ? reviews === 1 : row.view.assessment?.desc === report)))
  await publishObservation(path.join(artifacts, "before-attach.json"), before)
  const attach = () => runtime.start("-d", "-s", "cold-viewer", "-x", "160", "-y", "40", "-c", project,
    "env", "XDG_STATE_HOME=" + env.XDG_STATE_HOME, "XDG_CONFIG_HOME=" + viewerConfig, host, "--session", session.id, project)
  await attach()
  await until("cold viewer displays the existing report", () => {
    const screen = capture()
    assert.doesNotMatch(screen, /\b\d+ plugins? failed \/plugins\b/, "The installed viewer failed to load")
    return screen.includes(detach ? "Evaluating" : report)
  })
  await writeFile(path.join(artifacts, "cold-viewer.txt"), capture())
  if (detach) {
    releaseVerdict()
    await until("painted countdown", () => /Allowed in \d+s/.test(capture()))
    runtime.tmux("kill-session", "-t", "cold-viewer")
    const confirmed = await until("server finishes while detached", async () => executions === 1
      && (await service.snapshot()).recent.find(item => item.permissionID === before.view.request.id && item.attempt === before.attempt))
    assert.equal(confirmed.decision, "once")
    await attach()
    await until("native conversation restored", () => capture().includes("COLD_MARKER"))
    await activatePalette({ send: (...keys) => runtime.tmux("send-keys", "-t", "cold-viewer", ...keys),
      capture: () => runtime.tmux("capture-pane", "-p", "-e", "-t", "cold-viewer") },
    "Reviewer: Report history", screen => screen.includes("Analysis history") && screen.includes(report))
    assert.match(capture(), /Auto approved/)
    assert.match(capture(), /1\/1/)
    await writeFile(path.join(artifacts, "reattached-history.txt"), capture())
    const rpc = client.rpc(reviewerRpc)
    const options = { location: { directory: project } }
    const history = await rpc.history({ sessionID: session.id }, options)
    const statistics = await rpc.statistics({ sessionID: session.id }, options)
    assert.equal(history.total, 1)
    assert.equal(history.record.context.permission, before.view.request.id)
    assert.equal(statistics.conversation.totals.requests, 1)
    assert.equal(statistics.conversation.totals.activity.autoApproved, 1)
    await publishObservation(path.join(artifacts, "reattached-records.json"), { history, statistics })
  } else {
    const after = (await service.snapshot()).views.find(row => row.view.request.id === before.view.request.id)
    assert.equal(after.attempt, before.attempt)
  }
  if (sounds) {
    const directory = path.join(config, "private-sounds")
    await mkdir(directory)
    await writeFile(path.join(directory, "attention.wav"), wave(5000))
    // notify is the master switch for banners, sounds and reminders. Only the attention sound stays on.
    await publishObservation(policyFile, { server: serverPolicy, tui: { notify: true, notifySound: true, staleReminderSeconds: 0,
      notificationSoundDirectory: directory, notifications: { attention: { banner: false, sound: true }, unsafe: { banner: false, sound: false },
        question: { banner: false, sound: false }, approved: { banner: false, sound: false }, steered: { banner: false, sound: false },
        ended: { banner: false, sound: false }, error: { banner: false, sound: false } } } })
    const changed = await until("new viewer sound settings", async () => {
      const snapshot = await service.snapshot()
      return snapshot.tui?.customSounds && snapshot
    })
    assert.equal(changed.views.find(item => item.view.request.id === before.view.request.id)?.attempt, before.attempt)
    assert.equal(JSON.stringify(changed).includes(directory), false)
    assert.equal(JSON.stringify(changed).includes(serverPolicy.apiKey), false)
    await sleep(1500)
    assert.equal(reviews, 1)
    assert.equal(await readObservation(played, { optional: true }), undefined)
    await client.session.interrupt({ sessionID: session.id, continue: false })
    await until("first permission interrupted", async () => !(await client.permission.list({ sessionID: session.id })).length)
    await client.session.prompt({ sessionID: session.id, text: "Run echo COLD_MARKER again." })
    await until("viewer hands the custom sound to its player", async () => (await readObservation(played, { optional: true }))?.length)
    assert.deepEqual(await readObservation(played), [{ command: "paplay", wave: wave(3277).toString("base64") }])
  }
  await sleep(1500)
  assert.equal(reviews, sounds ? 2 : 1)
  assert.equal(executions, detach ? 1 : 0)
  const pending = (await client.permission.list({ sessionID: session.id })).map(item => item.id)
  if (sounds) {
    assert.equal(pending.length, 1)
    assert.notEqual(pending[0], before.view.request.id)
  } else assert.deepEqual(pending, detach ? [] : [before.view.request.id])
  await publishObservation(path.join(artifacts, "results.json"), { before, after: await service.snapshot(), reviews, executions })
  console.log(`PASS cold viewer startup: ${artifacts}`)
} catch (error) {
  let screen = ""
  try { screen = capture() } catch {}
  await writeFile(path.join(artifacts, "failure.txt"), String(error.stack) + "\n" + screen)
  throw error
} finally {
  await runtime.dispose()
  model.closeAllConnections()
  model.close()
}
