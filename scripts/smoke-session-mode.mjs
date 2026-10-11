// Real public commands, HTTP abort, native pending state and resume in an isolated TUI.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, access } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { notificationRecorder, assertNotificationAudio } from "./smoke-notification-recorder.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { activatePalette } from "./smoke-ui.mjs"

runtimeArguments("smoke-session-mode.mjs")

const root = path.resolve(import.meta.dirname, "..")
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8" }).trim()
assert.equal(version, "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-session-mode-"))
const project = path.join(temp, "project")
await mkdir(project)
await mkdir(path.join(temp, "config"))
execFileSync("git", ["init", "--quiet", project])
const plugin = path.join(temp, "reviewer.mjs")
await copyFile(path.join(root, "dist/tui.js"), plugin)
const notifications = process.argv.includes("--notifications")
const notificationRecords = notifications ? await notificationRecorder(plugin, temp) : undefined
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nPath("executed").write_text("unexpected")\n')
const calls = [], reviews = []
let aborted = false, release, sequence = 0, sessionID
const errors = []
const server = createServer(async (req, res) => {
  try {
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      const evidence = JSON.parse(body.messages[1].content)
      reviews.push(evidence)
      sessionID ??= evidence.session.root.id
      const reply = () => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ safe: true, desc: "Session mode fixture assessment." }) } }],
          usage: { prompt_tokens: 30, completion_tokens: 10 } }))
      }
      if (reviews.length === 1) {
        res.on("close", () => { if (!res.writableEnded) aborted = true })
        release = reply
      } else reply()
      return
    }
    const tool = body.tools?.find((item) => item.function?.name === "bash")
    const doTool = !!tool && body.messages.at(-1)?.role === "user"
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ id: `mode_${++sequence}`, type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "python3 fixture.py", description: "Session mode fixture" }) } }] }
      : { role: "assistant", content: "Session mode turn finished." }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish_reason) => ({ id: "mode", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason }] })
      res.write(`data: ${JSON.stringify(chunk(doTool ? { ...message, tool_calls: message.tool_calls.map((item, index) => ({ ...item, index })) } : message, null))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, doTool ? "tool_calls" : "stop"))}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: doTool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    }
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end("fixture failed") }
})
const runtime = await smokeRuntime(temp)
let screen = ""
const tmux = runtime.tmux
const capture = () => tmux("capture-pane", "-p", "-t", "mode")
const until = async (condition, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    await sleep(100)
    screen = capture()
    if (await condition(screen)) return
  }
  throw new Error("Timed out waiting for session-mode fixture state")
}
const send = (...keys) => tmux("send-keys", "-t", "mode", ...keys)
const save = async (name) => writeFile(path.join(root, `.runtime/session-mode-${name}.txt`), capture())
const palette = async (enabled) => {
  const title = `Reviewer: ${enabled ? "Enable" : "Disable"} for conversation`
  await activatePalette({ send, capture: () => tmux("capture-pane", "-p", "-e", "-t", "mode") }, title,
    s => s.includes(`Reviewer ${enabled ? "enabled" : "disabled"} for this conversation.`))
}
const unchanged = async () => assert.rejects(access(path.join(project, "executed")))
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const config = { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false,
    permission: { bash: "ask" }, provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture",
      options: { baseURL: `http://127.0.0.1:${port}/main`, apiKey: "fixture" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } } }
  const tuiFile = path.join(temp, "tui.json")
  await writeFile(tuiFile, JSON.stringify({ $schema: "https://opencode.ai/tui.json", plugin: [[plugin, {
    notify: notifications, baseURL: `http://127.0.0.1:${port}/review`, model: "fixture", autoApprove: true, autoApproveDelaySeconds: 8,
  }]] }))
  const env = { HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"),
    XDG_STATE_HOME: path.join(temp, "state"), XDG_CACHE_HOME: path.join(temp, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"),
    OPENCODE_TUI_CONFIG: tuiFile, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  const start = (...args) => runtime.start("-d", "-s", "mode", "-x", "160", "-y", "40", "-c", project,
    "env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), host, project, ...args)
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  await start("--prompt", "Run the first session mode fixture.")
  await until((s) => s.includes("Permission required") && reviews.length === 1, 90000)
  const mainCount = () => calls.filter((call) => call.url === "/main/chat/completions").length
  const before = mainCount()
  await palette(false)
  await until((s) => aborted && !s.includes("Permission analysis") && s.includes("Permission required"))
  if (notificationRecords) await until(async () => (await notificationRecords()).some(r => r.event === "notification" && r.title === "Session needs attention"))
  release()
  await sleep(300)
  await save("disabled-in-flight")
  assert.equal(mainCount(), before)
  assert.equal(reviews.length, 1)
  await palette(true)
  await until((s) => reviews.length === 2 && s.includes("Allowed in"))
  await save("enabled-countdown")
  await palette(false)
  await palette(true)
  await until((s) => reviews.length === 3 && s.includes("Auto-approval canceled"))
  const end = Date.now() + 8500
  while (Date.now() < end) {
    assert.match(capture(), /Permission required/)
    assert.doesNotMatch(capture(), /Allowed in|Checking…|Allowing…/)
    await unchanged()
    await sleep(200)
  }
  assert.equal(mainCount(), before, "local controls must not prompt the main model")
  await save("manual-after-reenable")
  send("Escape")
  await until((s) => !s.includes("Permission required") && s.includes("tab agents"))
  await sleep(500)
  const slashBefore = mainCount()
  send("-l", "/reviewer-disable")
  await until((s) => s.includes("reviewer-disable"))
  send("Enter")
  await until((s) => s.includes("Reviewer disabled for this conversation."))
  await save("slash-disabled")
  assert.equal(mainCount(), slashBefore, "slash action must not become an assistant prompt")
  const storeDirectory = path.join(temp, "state/opencode/opencode-reviewer/session-mode-v1")
  const records = await readdir(storeDirectory)
  assert.equal(records.length, 1)
  assert.deepEqual(JSON.parse(await readFile(path.join(storeDirectory, records[0]), "utf8")), { version: 1, enabled: false })
  tmux("kill-session", "-t", "mode")
  await start("--session", sessionID)
  await until((s) => s.includes("tab agents") && s.includes("Run the first session mode fixture."), 90000)
  send("-l", "Run the resumed session mode fixture.")
  send("Enter")
  await until((s) => s.includes("Permission required"), 90000)
  await sleep(2300)
  if (notificationRecords) {
    const records = await notificationRecords()
    const latestAsk = records.findLast(r => r.event === "permission.asked")
    assert.ok(records.some(r => r.event === "notification" && r.title === "Session needs attention" && r.at >= latestAsk.at),
      "a new permission in a resumed disabled conversation must still notify without review")
  }
  assert.equal(reviews.length, 3, "resumed disabled root must not call the reviewer")
  assert.doesNotMatch(capture(), /Permission analysis|Allowed in/)
  await save("resumed-disabled")
  await palette(true)
  await until((s) => reviews.length === 4 && s.includes("Allowed in"))
  assert.equal(reviews[3].session.root.id, sessionID)
  assert.equal(reviews[3].userPrompt, "Run the resumed session mode fixture.")
  await save("resumed-enabled")
  send("Escape")
  await until((s) => !s.includes("Permission required"))
  await unchanged()
  assert.deepEqual(errors, [])
  for (const call of calls.filter((call) => call.url === "/main/chat/completions")) {
    assert.doesNotMatch(JSON.stringify(call.body.messages), /reviewer-enable|reviewer-disable|Reviewer (?:enabled|disabled) for this conversation\.|Permission analysis/)
  }
  await writeFile(path.join(root, ".runtime/session-mode-results.json"), JSON.stringify({ version, reviews: reviews.length,
    aborted, persisted: true, resumedRoot: true, localCommandsOnly: true, tombstoneSurvived: true, temp }, null, 2))
  if (notificationRecords) {
    const records = await notificationRecords()
    assertNotificationAudio(assert, records)
    await writeFile(path.join(root, ".runtime/session-mode-notifications.json"), JSON.stringify(records, null, 2))
    console.log("PASS session-mode notifications: disabled in-flight review and resumed disabled conversation both require attention without model calls")
  }
  console.log(`PASS session-mode: in-flight HTTP abort, palette enable/disable, slash local action, countdown tombstone, atomic persistence and real host resume; ${reviews.length} reviews. Isolated files: ${temp}`)
} catch (error) {
  try { screen = capture() } catch {}
  await writeFile(path.join(root, ".runtime/session-mode-failed.txt"), `${screen}\n${error.stack}\n${temp}\n`)
  console.error(screen)
  throw error
} finally {
  await runtime.dispose()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
