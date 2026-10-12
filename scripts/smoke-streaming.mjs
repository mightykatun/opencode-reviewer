// Real TUI with manually released SSE phases. All commands and files are isolated.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, copyFile, writeFile, readFile, access } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { smokeRuntime, smokeMetrics } from "./smoke-runtime.mjs"
import { seedLifetime, readLifetime, assertLegacyUntouched } from "./smoke-lifetime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation } from "./smoke-observations.mjs"
import { activatePalette } from "./smoke-ui.mjs"

const { scenario } = runtimeArguments("smoke-streaming.mjs")
const streaming = scenario !== "nonstream"
const maxOutputTokens = scenario === "truncated" ? 4096 : 2048
const throwingObserver = process.argv.includes("--observer-throws")
const staticAnimations = process.argv.includes("--static")
const name = `streaming-${scenario}${staticAnimations ? "-static" : ""}${throwingObserver ? "-throwing-observer" : ""}`
const root = path.resolve(import.meta.dirname, "..")
const host = process.env.OPENCODE_BIN ?? "opencode"
const hostVersion = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assert.equal(hostVersion, "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-streaming-"))
await seedLifetime(temp)
const project = path.join(temp, "project")
await mkdir(project)
await mkdir(path.join(temp, "config"))
execFileSync("git", ["init", "--quiet", project])
const plugin = path.join(temp, "reviewer.mjs")
const bundle = path.join(temp, "reviewer-bundle.mjs")
const diagnosticsFile = path.join(temp, "diagnostics.json")
await copyFile(path.join(root, "dist/tui.js"), bundle)
// The observer owns this isolated, capped artifact. The production plugin owns no logger/store.
await writeFile(plugin, `
import plugin, { withDiagnostics } from ${JSON.stringify(pathToFileURL(bundle).href)}
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}
const file = ${JSON.stringify(diagnosticsFile)}
const events = []
let dropped = 0
const publisher = observationPublisher(file)
const persist = () => publisher.publish({ version: 1, dropped, events })
const tui = withDiagnostics((event) => {
  if (events.length < 512) events.push(event)
  else dropped++
  const pending = persist()
  if (${throwingObserver}) { void pending.catch(() => {}); throw new Error("Injected observer failure") }
  return pending
})
export default { id: plugin.id, tui: async (...args) => {
  await tui(...args)
  args[0].lifecycle.onDispose(async () => { persist(); await publisher.close() })
} }
`)
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nimport time\nPath("executed").write_text(str(time.time_ns() // 1000000))\n')
const marker = path.join(project, "executed")
const delay = 3
const code = '```python\n# PAINTED_CODE\nfruit = "apple"\nprint(fruit)\n```'
const prefix = `STREAM START\n\nLiteral: \`\x1b[2J\u202e\`\n\n${code}\n\n`
const longText = Array.from({ length: 55 }, (_, i) => `STREAM ROW ${String(i + 1).padStart(2, "0")}.`).join("\n\n")
const encoded = (text) => JSON.stringify(text).slice(1, -1)
const calls = [], reviews = [], errors = []
const reviewBodies = []
let toolSent = false
const server = createServer(async (req, res) => {
  try {
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      assert.equal(body.stream, streaming)
      assert.equal(body.max_tokens, maxOutputTokens)
      reviewBodies.push(text)
      if (scenario === "truncated" && reviewBodies.length > 1) assert.equal(text, reviewBodies[0], "stream regeneration repeats the exact request")
      if (!streaming) {
        assert.equal(body.stream_options, undefined)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.flushHeaders()
        reviews.push({ done: () => {
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ safe: true, desc: prefix + "Final non-stream report." }) } }],
            usage: { prompt_tokens: 40, completion_tokens: 20 } }))
          metrics.mark("terminal-sent", reviews.length)
        } })
        return
      }
      assert.deepEqual(body.stream_options, { include_usage: true })
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.flushHeaders()
      const review = { aborted: false, ended: false,
        content: (content) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`),
        stop: (reason = "stop") => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`),
        done: () => {
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 20 } })}\n\n`)
          res.end("data: [DONE]\n\n")
          review.ended = true
          metrics.mark("terminal-sent", reviews.indexOf(review) + 1)
        },
        break: () => res.destroy(),
      }
      res.on("close", () => { if (!res.writableEnded) review.aborted = true })
      reviews.push(review)
      return
    }
    const tool = body.tools?.find((item) => item.function?.name === "bash")
    const doTool = !!tool && !toolSent
    if (doTool) toolSent = true
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ id: "stream_tool", type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "python3 fixture.py", description: "Streaming UI fixture" }) } }] }
      : { role: "assistant", content: "Streaming fixture done." }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish_reason) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
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
const metrics = smokeMetrics(server, { pollIntervalMs: 100, hostVersion })
const runtime = await smokeRuntime(temp)
const tmux = runtime.tmux
let screen = "", outcome = "failed"
const capture = () => tmux("capture-pane", "-p", "-t", "stream")
const send = (...keys) => tmux("send-keys", "-t", "stream", ...keys)
const sidebar = (s) => s.split("\n").map((line) => line.slice(118)).join("\n")
const noLoading = (s) => assert.doesNotMatch(sidebar(s), / Evaluating| Retrying|\[⋯\]|[■⬝]/, "a streamed rating must hide the entire loading indicator")
const until = async (condition, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    await sleep(100)
    screen = capture()
    if (await condition(screen)) return
  }
  throw new Error("Timed out waiting for streaming fixture state")
}
const save = async (stage) => {
  await writeFile(path.join(root, `.runtime/${name}-${stage}.txt`), capture())
  await writeFile(path.join(root, `.runtime/${name}-${stage}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "stream"))
  metrics.mark(stage, reviews.length)
}
const unchanged = () => assert.rejects(access(marker))
const pendingFor = async (ms, check = () => {}) => {
  const end = Date.now() + ms
  do {
    screen = capture()
    assert.match(screen, /Permission required/)
    assert.match(screen, /Allow once.*Allow always.*Reject/)
    assert.doesNotMatch(sidebar(screen), /Allowed in|Checking…|Allowing…/)
    await unchanged()
    check(screen)
    await sleep(100)
  } while (Date.now() < end)
}
const palette = async (title) => {
  const postcondition = title === "Disable animations" ? s => s.includes("[⋯]")
    : title === "Reviewer: Statistics" ? s => s.includes("Reviewer statistics")
    : title.includes("Disable") ? s => s.includes("Reviewer disabled for this conversation.")
    : s => s.includes("Reviewer enabled for this conversation.")
  await activatePalette({ send, capture: () => tmux("capture-pane", "-p", "-e", "-t", "stream") }, title, postcondition)
}
const wheel = (button) => send("-l", `\x1b[<${button};140;20M`)
const firstRow = (s) => sidebar(s).match(/STREAM ROW \d+/)?.[0]
const validateDiagnostics = async () => {
  const automated = !["cancel", "manual", "error"].includes(scenario)
  let record
  await until(async () => {
    record = await readObservation(diagnosticsFile, { optional: true })
    if (!record) return false
    return automated ? record.events.some((event) => event.phase === "approval-reply") : record.events.some((event) => event.phase === "first-display")
  })
  assert.equal(record.version, 1)
  assert.equal(record.dropped, 0)
  assert.ok(record.events.length <= 512 && Buffer.byteLength(JSON.stringify(record)) <= 131072)
  const phases = new Set(["dispatch", "headers", "first-content", "first-rating", "final-validation", "context.session", "context.message",
    "context.messages", "context.projects", "context.tool-ids", "context.definition", "approval-verification", "approval-read", "approval-reply",
    "pending-refresh", "first-display", "final-render", "approval-countdown"])
  const events = record.events
  for (const [index, event] of events.entries()) {
    assert.ok(phases.has(event.phase))
    for (const [key, value] of Object.entries(event)) {
      assert.ok(["phase", "at", "duration", "review", "attempt", "call"].includes(key))
      if (key === "phase") continue
      assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0)
      if (["review", "attempt", "call"].includes(key)) assert.ok(Number.isSafeInteger(value))
    }
    assert.ok(event.at >= (events[index - 1]?.at ?? 0))
  }
  assert.doesNotMatch(JSON.stringify(record), /fixture\.py|STREAM START|PAINTED_CODE|http:|ses_|per_|msg_|apiKey|"messages"\s*:|"headers"\s*:/)
  const dispatched = events.filter((event) => event.phase === "dispatch")
  assert.equal(dispatched.length, reviews.length, "one client dispatch per server attempt")
  if (["retry", "truncated"].includes(scenario)) {
    assert.equal(dispatched[0].review, dispatched[1].review)
    assert.deepEqual(dispatched.map((event) => event.attempt), [0, 1])
  }
  if (scenario === "disable") assert.notEqual(dispatched[0].review, dispatched[1].review)
  for (const dispatch of dispatched) {
    assert.ok(dispatch.review > 0)
    const attempt = events.filter((event) => event.review === dispatch.review && event.attempt === dispatch.attempt)
    const names = ["dispatch", "headers", "first-content", "first-rating", "final-validation"]
    const times = names.map((name) => attempt.find((event) => event.phase === name)).filter(Boolean)
    assert.deepEqual(times.slice(0, 4).map((event) => event.phase), names.slice(0, 4))
    for (const [index, event] of times.entries()) {
      assert.equal(attempt.filter((item) => item.phase === event.phase).length, 1)
      assert.ok(event.at >= (times[index - 1]?.at ?? 0))
      assert.ok(Math.abs(event.duration - (event.at - dispatch.at)) < 0.01)
    }
    const context = events.filter((event) => event.review === dispatch.review && event.phase.startsWith("context."))
    assert.ok(context.some((event) => event.phase === "context.message" && event.at <= dispatch.at))
    assert.ok(context.some((event) => event.phase === "context.messages" && event.at <= dispatch.at))
    assert.ok(context.every((event) => event.call >= 1))
    assert.ok(attempt.some((event) => event.phase === "first-display" && event.at >= times[2].at))
  }
  const validations = events.filter((event) => event.phase === "final-validation")
  assert.equal(validations.length, scenario === "retry" ? 2 : automated ? 1 : 0)
  if (automated) {
    const last = dispatched.at(-1)
    const ordered = [validations.at(-1), ...["final-render", "approval-countdown", "approval-verification", "approval-reply"]
      .map((phase) => events.find((event) => event.review === last.review && event.phase === phase))]
    assert.ok(ordered.every(Boolean))
    for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i].at >= ordered[i - 1].at)
  }
  await writeFile(path.join(root, `.runtime/${name}-client-diagnostics.json`), JSON.stringify(record, null, 2))
  console.log(`CLIENT ${name}: ${JSON.stringify(dispatched.map((dispatch) => ({ review: dispatch.review, attempt: dispatch.attempt,
    phases: events.filter((event) => event.review === dispatch.review && event.attempt === dispatch.attempt
      && ["headers", "first-content", "first-rating", "final-validation"].includes(event.phase))
      .map((event) => ({ phase: event.phase, duration: Math.round(event.duration * 1000) / 1000 })) })))}`)
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const config = { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false,
    permission: { bash: "ask" }, provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture",
      options: { baseURL: `http://127.0.0.1:${port}/main`, apiKey: "fixture" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } } }
  const tuiFile = path.join(temp, "tui.json")
  await writeFile(tuiFile, JSON.stringify({ $schema: "https://opencode.ai/tui.json", plugin: [[plugin, {
    notify: false, baseURL: `http://127.0.0.1:${port}/review`, model: "fixture", stream: streaming, timeoutMs: 120000,
    autoApprove: true, autoApproveDelaySeconds: delay, maxOutputTokens,
  }]] }))
  const env = { HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"),
    XDG_STATE_HOME: path.join(temp, "state"), XDG_CACHE_HOME: path.join(temp, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"),
    OPENCODE_TUI_CONFIG: tuiFile, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  await runtime.start("-d", "-s", "stream", "-x", "160", "-y", "40", "-c", project,
    "env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), host, project, "--prompt", "Run the isolated streaming fixture.")
  await until((s) => s.includes("Permission required") && reviews.length === 1 && sidebar(s).includes(" Evaluating"), 90000)
  await save("evaluating")
  if (staticAnimations) {
    await palette("Disable animations")
    await until((s) => sidebar(s).includes("[⋯] Evaluating"))
    assert.doesNotMatch(sidebar(screen), /[■⬝]{8}/)
    await save("static-evaluating")
  }
  let current = reviews[0]
  if (streaming) {
    current.content('{"safe":true,')
    await until((s) => sidebar(s).includes("✓ Safe") && !sidebar(s).includes(" Evaluating"))
    await pendingFor(delay * 1000 + 300, (s) => {
      assert.match(sidebar(s), /✓ Safe/)
      noLoading(s)
      assert.doesNotMatch(sidebar(s), /token:|lifetime:/)
    })
    await save("rating-only")
    const ratingOnly = await readObservation(diagnosticsFile)
    assert.ok(ratingOnly.events.some((event) => event.phase === "first-display" && event.attempt === 0),
      "first-display must observe the rating frame before any description is sent")
    current.content('"desc":"' + encoded(prefix + longText))
    await until((s) => sidebar(s).includes("STREAM START") && sidebar(s).includes("PAINTED_CODE") && sidebar(s).includes("\\u001b[2J\\u202e"))
    await pendingFor(500, noLoading)
    await save("partial-description")
  } else await pendingFor(300, (s) => assert.doesNotMatch(sidebar(s), /✓ Safe|STREAM START/))

  if (["complete", "retry", "truncated"].includes(scenario)) {
    for (let i = 0; i < 20 && sidebar(capture()).includes("STREAM START"); i++) { wheel(65); await sleep(40) }
    await until((s) => !sidebar(s).includes("STREAM START") && !!firstRow(s))
    const before = firstRow(screen)
    current.content(encoded("\n\nAPPENDED BELOW VIEWPORT"))
    await sleep(200)
    assert.equal(firstRow(capture()), before, "chunk updates must retain the user's scroll position")
    await save("scrolled-chunk")
  }

  if (["retry", "truncated"].includes(scenario)) {
    if (scenario === "retry") current.content('","extra":true}') // Valid transport, invalid assessment contract.
    current.stop(scenario === "truncated" ? "length" : "stop"); current.done()
    await until((s) => reviews.length === 2 && sidebar(s).includes(" Retrying"))
    assert.doesNotMatch(sidebar(screen), /✓ Safe|✗ Unsafe|STREAM ROW|STREAM START|PAINTED_CODE|APPENDED/)
    if (staticAnimations) assert.match(sidebar(screen), /\[⋯\] Retrying/)
    await pendingFor(500)
    await save("retry-cleared")
    current = reviews[1]
    current.content('{"desc":"' + encoded(`CORRECTED START\n\n${code}\n\nCorrected explanation.`))
    await until((s) => sidebar(s).includes("CORRECTED START") && sidebar(s).includes("PAINTED_CODE"))
    assert.doesNotMatch(sidebar(screen), /✓ Safe|✗ Unsafe/)
    assert.match(sidebar(screen), / Retrying| Evaluating/, "description-first retries keep loading until a rating arrives")
    if (staticAnimations) assert.match(sidebar(screen), /\[⋯\]/)
    await save("retry-scroll-reset")
    current.content('","safe":true}')
  } else if (scenario === "cancel" || scenario === "manual") {
    send(scenario === "manual" ? "Enter" : "Escape")
    await until((s) => current.aborted && !s.includes("Permission required") && !s.includes("Permission analysis"))
    current.content(encoded("LATE CONTENT") + '"}'); current.stop(); current.done()
    await sleep(300)
    assert.doesNotMatch(capture(), /Permission analysis|LATE CONTENT|✓ Safe/)
    if (scenario === "manual") {
      await until(async () => access(marker).then(() => true, () => false))
    } else await unchanged()
    await save(scenario === "manual" ? "native-approved-during-stream" : "native-cancelled")
  } else if (scenario === "disable") {
    await palette("Reviewer: Disable for conversation")
    await until((s) => current.aborted && !s.includes("Permission analysis") && s.includes("Permission required"))
    await pendingFor(400)
    await save("disabled")
    const old = current
    await palette("Reviewer: Enable for conversation")
    await until((s) => reviews.length === 2 && sidebar(s).includes(" Evaluating"))
    current = reviews[1]
    old.content(encoded("LATE OLD CONTENT") + '"}'); old.stop(); old.done()
    current.content('{"safe":true,"desc":"' + encoded(`REENABLED START\n\n${code}`) + '"}')
    await until((s) => sidebar(s).includes("REENABLED START"))
    assert.doesNotMatch(sidebar(screen), /STREAM START|LATE OLD CONTENT/)
    await save("reenabled-fresh")
  } else if (scenario === "error") {
    current.break()
    await until((s) => sidebar(s).includes("! Analysis unavailable"))
    await pendingFor(delay * 1000 + 300, (s) => assert.doesNotMatch(sidebar(s), /✓ Safe|STREAM START|PAINTED_CODE| Evaluating/))
    await save("failed-clear")
    send("Escape")
    await until((s) => !s.includes("Permission required"))
  } else if (streaming) {
    current.content(encoded("\n\nFINAL REPORT LINE") + '"}')
  }

  if (!["cancel", "manual", "error"].includes(scenario)) {
    if (streaming) {
      await until((s) => sidebar(s).includes("✓ Safe"))
      await pendingFor(300, noLoading)
      current.stop()
      // A full JSON object and finish metadata are still provisional without DONE/EOF.
      await pendingFor(delay * 1000 + 300, noLoading)
      await save("complete-json-not-terminal")
    }
    let scrolledRow
    if (scenario === "complete") scrolledRow = firstRow(capture())
    if (scenario === "hidden") {
      send("C-x", "b")
      await until((s) => !s.includes("Permission analysis") && s.includes("Permission required"))
    }
    if (scenario === "dialog") {
      send("C-p")
      await until((s) => s.includes("Commands") && !s.includes("Permission analysis"))
    }
    if (scenario === "narrow") {
      tmux("resize-window", "-t", "stream", "-x", "80", "-y", "24")
      await until((s) => !s.includes("Permission analysis") && s.includes("Permission required"))
    }
    if (scenario === "fullscreen") {
      send("C-f")
      await until((s) => s.includes("minimize") && !s.includes("Permission analysis"))
    }
    const terminalAt = Date.now()
    current.done()
    if (["hidden", "dialog", "narrow", "fullscreen"].includes(scenario)) {
      await sleep(delay * 1000 + 300)
      await unchanged()
      assert.doesNotMatch(capture(), /Permission analysis|Allowed in/)
      await save("completed-covered")
      if (scenario === "hidden") send("C-x", "b")
      else if (scenario === "dialog") send("Escape")
      else if (scenario === "fullscreen") send("C-f")
      else tmux("resize-window", "-t", "stream", "-x", "160", "-y", "40")
    }
    await until((s) => sidebar(s).includes(`Allowed in ${delay}s`) && !sidebar(s).includes(" Evaluating"))
    const renderedAt = Date.now()
    if (scrolledRow) assert.equal(firstRow(screen), scrolledRow, "final validation must not remount/reset the scrolled report")
    assert.match(sidebar(screen), /✓ Safe/)
    assert.match(screen, /Allow once.*Allow always.*Reject/)
    assert.doesNotMatch(sidebar(screen), / Retrying| Evaluating/)
    await save("validated-full-countdown")
    if (scenario === "truncated") {
      await until(s => sidebar(s).includes("token: 80 in 40 out") && sidebar(s).includes("1 ✓ 0 ✗"), 3000)
      await save("retry-usage-and-one-rating")
    }
    if (scenario !== "complete") {
      assert.match(sidebar(screen), /PAINTED_CODE|print\(fruit\)/, "final report code must be painted before the full countdown")
      const ansi = tmux("capture-pane", "-p", "-e", "-t", "stream")
      assert.match(ansi, /\x1b\[[0-9;]*3[;m][^\n]*PAINTED_CODE/, "final code comment must have rendered syntax emphasis")
    }
    await until(async () => access(marker).then(() => true, () => false), 10000)
    const executedAt = Number(await readFile(marker, "utf8"))
    assert.ok(executedAt - terminalAt >= delay * 1000, "native execution must follow validation plus the full delay")
    assert.ok(executedAt - renderedAt >= delay * 1000 - 300, "the observed complete frame receives a full countdown")
    await until((s) => !s.includes("Permission required") && !s.includes("Permission analysis"))
    await save("resolved")
  }
  assert.equal(reviews.length, ["retry", "truncated", "disable"].includes(scenario) ? 2 : 1)
  assert.deepEqual(errors, [])
  for (const call of calls.filter((call) => call.url === "/main/chat/completions")) {
    assert.doesNotMatch(JSON.stringify(call.body.messages), /STREAM START|CORRECTED START|Permission analysis|reviewer-disable|reviewer-enable/)
  }
  await validateDiagnostics()
  if (process.argv.includes("--stats")) {
    assert.ok(["complete", "retry", "truncated", "nonstream"].includes(scenario), "stats fixture requires a completed automatic review")
    await palette("Reviewer: Statistics")
    await until(s => s.includes("Reviewer statistics") && s.includes("Auto-approved: 1 (100.0%)"))
    assert.match(screen, /Reviews: 1/)
    assert.match(screen, /Safe: 1 \(100\.0%\)/)
    assert.ok(screen.includes(`Retries: ${reviews.length - 1}`))
    assert.ok(screen.includes(`Tokens: ${40 * reviews.length} in ${20 * reviews.length} out`))
    assert.doesNotMatch(screen, /partial history/)
    const totals = readLifetime(temp)
    assert.equal(totals.requests, reviews.length)
    assert.equal(totals.safe, 1); assert.equal(totals.activity.reviews, 1)
    assert.equal(totals.activity.retries, reviews.length - 1)
    assert.equal(totals.activity.autoApproved, 1)
    await save("lifetime-dialog")
    send("Escape")
  }
  await assertLegacyUntouched(temp)
  outcome = "passed"
  console.log(`PASS ${name}: delayed rating/text/terminal phases, final-only approval, ${scenario} lifecycle${staticAnimations ? ", static scanner labels" : ""}; ${reviews.length} review request(s). Isolated files: ${temp}`)
} catch (error) {
  try { screen = capture() } catch {}
  await writeFile(path.join(root, `.runtime/${name}-failed.txt`), `${screen}\n${error.stack}\n${temp}\n`)
  await writeFile(path.join(root, `.runtime/${name}-failed-requests.json`), JSON.stringify(calls, null, 2))
  console.error(screen)
  throw error
} finally {
  await runtime.dispose()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await writeFile(path.join(root, `.runtime/${name}-metrics.json`), JSON.stringify(metrics.snapshot(outcome), null, 2))
}
