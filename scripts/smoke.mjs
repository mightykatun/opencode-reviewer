// Real, isolated OpenCode TUI + deterministic local HTTP fixtures. No paid model.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile, access, copyFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { smokeMetrics, smokeRuntime } from "./smoke-runtime.mjs"
import { reviewerAudit, assertReviewerReuse } from "./smoke-reviewer.mjs"
import { runPermissionStages } from "./smoke-stages.mjs"
import { smokeScenario, runSmokeFamily } from "./smoke-scenarios.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { activatePalette } from "./smoke-ui.mjs"
import { notificationRecorder, assertNotificationAudio } from "./smoke-notification-recorder.mjs"

const root = path.resolve(import.meta.dirname, "..")
const hostBinary = process.env.OPENCODE_BIN ?? "opencode"
const { scenario } = runtimeArguments("smoke.mjs")
const measureReuse = process.argv.includes("--measure-reuse")
const notifications = process.argv.includes("--notifications")
const approvalSound = process.argv.includes("--approval-sound")
const reminders = process.argv.includes("--reminders")
const networkRetry = process.argv.includes("--network-retry")
const descriptor = smokeScenario(scenario)
const { auto, visibilityLoss, autoDelay, isEdit, isExternal, disabledReview, heldReview, correction,
  withUsage, knownPricing, configFailure, plan, initialWidth } = descriptor
if (process.argv.includes("--plan")) { console.log(JSON.stringify(plan, null, 2)); process.exit(0) }
const hostVersion = execFileSync(hostBinary, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
const fixtureModel = scenario === "patch" ? "gpt-fixture" : "fixture"
const formattedDescription = "Counts two fruit names.\n\n- **Output:** prints the count.\n- **File:** writes to `executed-marker`.\n- *Literal:* `\x1b[2J\u202e`.\n\n### Details\n\n[Documentation](https://example.com/review)"
const finalLine = "FINAL ANALYSIS LINE"
const longDescription = [formattedDescription, ...Array.from({ length: 60 }, (_, i) => `Analysis detail ${String(i + 1).padStart(2, "0")}.`), finalLine].join("\n\n")
const codeDescription = '```python\n# RENDERED CODE FIXTURE\nfruit_count = len(["apple", "pear"])\nprint(fruit_count)\n```'
const autoLongDescription = [formattedDescription, codeDescription, ...Array.from({ length: 60 }, (_, i) => `Analysis detail ${String(i + 1).padStart(2, "0")}.`), codeDescription, finalLine].join("\n\n")
const conversationDescription = "### Conversation heading\n\n**conversation_bold** *conversation_emphasis* `conversation_code`\n\n[conversation_link](https://example.com/conversation)"

function styleAt(ansi, text, index = ansi.indexOf(text)) {
  assert.ok(index >= 0, `styled text should contain ${text}`)
  const style = { fg: undefined, bg: undefined, bold: false, italic: false, underline: false }
  for (const match of ansi.slice(0, index).matchAll(/\x1b\[([\d;]*)m/g)) {
    const codes = match[1].split(";").map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        style[code === 38 ? "fg" : "bg"] = codes.slice(i + 2, i + 5).join(",")
        i += 4
      } else if (code === 0) Object.assign(style, { fg: undefined, bg: undefined, bold: false, italic: false, underline: false })
      else if (code === 1 || code === 22) style.bold = code === 1
      else if (code === 3 || code === 23) style.italic = code === 3
      else if (code === 4 || code === 24) style.underline = code === 4
      else if (code === 39) style.fg = undefined
      else if (code === 49) style.bg = undefined
    }
  }
  return style
}

function assertConversationStyles(ansi) {
  for (const [review, conversation, emphasis] of [
    ["Output:", "conversation_bold", "bold"],
    ["Literal:", "conversation_emphasis", "italic"],
    ["Details", "Conversation heading", "bold"],
    ["Documentation", "conversation_link", "underline"],
    ["executed-marker", "conversation_code"],
  ]) {
    const actual = styleAt(ansi, review)
    const native = styleAt(ansi, conversation)
    assert.equal(actual.fg, native.fg, `${review} should use the conversation's theme color`)
    if (emphasis) assert.ok(actual[emphasis] && native[emphasis], `${review} should retain ${emphasis} formatting`)
    else {
      assert.equal(actual.bold, native.bold, "inline code should use the conversation's text weight")
      assert.equal(actual.italic, native.italic, "inline code should use the conversation's text emphasis")
    }
  }
}

// Fixture text before the scrollbar uses single-cell characters. Keep ANSI
// offsets so assertions inspect the rendered terminal colors, not plugin state.
function cellAt(ansi, row, column) {
  const lines = ansi.split("\n")
  const line = lines[row] ?? ""
  const start = lines.slice(0, row).reduce((sum, text) => sum + text.length + 1, 0)
  let x = 0
  for (const match of line.matchAll(/\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)|\x1b\[[\d;]*m|./gu)) {
    if (match[0].startsWith("\x1b")) continue
    if (x++ === column) return { character: match[0], ...styleAt(ansi, match[0], start + match.index) }
  }
  // tmux trims trailing blanks but retains their final rendition/background.
  return { character: " ", ...styleAt(ansi, "", start + line.length) }
}

function assertScrollbarTheme(ansi) {
  const panel = styleAt(ansi, "Permission analysis").bg
  const muted = styleAt(ansi, "#").fg
  assert.ok(panel && muted && panel !== muted, "fixture needs distinct track and thumb colors")
  const cells = Array.from({ length: 34 }, (_, i) => cellAt(ansi, i + 5, 157))
  assert.ok(cells.some((cell) => /[█▀▄]/u.test(cell.character)), "overflow must render a scrollbar thumb")
  assert.ok(cells.some((cell) => cell.bg === panel && cell.character === " "), "scrollbar track should use the panel background")
  for (const cell of cells.filter((cell) => /[█▀▄]/u.test(cell.character))) {
    assert.equal(cell.fg, muted, "scrollbar thumb should use the active theme's muted text color")
    assert.equal(cell.bg, panel, "scrollbar thumb background should use the active panel color")
  }
  return { panel, muted }
}
const temp = await mkdtemp(path.join(tmpdir(), "opencode-reviewer-"))
const { seedLifetime, readLifetime, assertLegacyUntouched } = await import("./smoke-lifetime.mjs")
// Load the built plugin away from the checkout to catch unbundled source assets.
const pluginFile = path.join(temp, "reviewer.mjs")
await copyFile(path.join(root, "dist/tui.js"), pluginFile)
const notificationRecords = notifications ? await notificationRecorder(pluginFile, temp) : undefined
const project = path.join(temp, "project")
await mkdir(project)
execFileSync("git", ["init", "--quiet", project])
const commandDirectory = isExternal ? path.join(temp, "outside") : project
if (commandDirectory !== project) await mkdir(commandDirectory)
await mkdir(path.join(temp, "config"))
await seedLifetime(temp, { usage: process.argv.includes("--seed-lifetime") ? { input: 10, output: 2, cost: 0.01 } : undefined })
const source = 'from pathlib import Path\nfruits = ["apple", "pear"]\nprint(len(fruits))\nPath("executed-marker").write_text(str(len(fruits)))\n'
  + (auto ? 'import time\nwith Path("execution-log").open("a") as log:\n    log.write(str(time.time_ns() // 1000000) + "\\n")\n' : "")
await writeFile(path.join(commandDirectory, "fruits.py"), source)
const stalledFile = path.join(temp, "stalled-open-entered")
if (scenario === "stalled-file") {
  const base = path.join(temp, "reviewer-base.mjs")
  await copyFile(pluginFile, base)
  await writeFile(pluginFile, `
import plugin, { withFileAccess } from ${JSON.stringify(pathToFileURL(base).href)}
import { open, realpath, writeFile } from "node:fs/promises"
export default { id: plugin.id, tui: withFileAccess({ realpath,
  open: async (...args) => {
    if (args[0] !== ${JSON.stringify(path.join(commandDirectory, "fruits.py"))}) return open(...args)
    await writeFile(${JSON.stringify(stalledFile)}, "entered")
    return new Promise(() => {})
  }
}) }
`)
}
const editOriginals = { "note.txt": "before\n", "delete.txt": "DELETE-SENTINEL\n", "move.txt": "MOVE-SENTINEL\n" }
if (isEdit) for (const [name, text] of Object.entries(editOriginals)) await writeFile(path.join(project, name), text)
const toolName = descriptor.tool
const toolInput = scenario === "patch" ? { patchText: "*** Begin Patch\n*** Add File: added.txt\n+created\n*** Update File: note.txt\n@@\n-before\n+after\n*** Delete File: delete.txt\n*** Update File: move.txt\n*** Move to: moved.txt\n@@\n-MOVE-SENTINEL\n+relocated\n*** End Patch" }
  : scenario === "write" ? { filePath: path.join(project, "note.txt"), content: "after\n" }
  : isEdit ? { filePath: path.join(project, "note.txt"), oldString: "before", newString: "after" }
  : { command: "python3 fruits.py", description: "Count fruit names", ...(isExternal ? { workdir: "../outside" } : {}) }
const userPrompt = isEdit ? "Make the proposed fixture file changes." : "Count the fruit names in fruits.py using python3 fruits.py."
const assertEditsUnchanged = async () => {
  for (const [name, text] of Object.entries(editOriginals)) assert.equal(await readFile(path.join(project, name), "utf8"), text, "plugin must not apply pending edits")
  for (const name of ["added.txt", "moved.txt"]) await assert.rejects(access(path.join(project, name)))
}
const customPrompts = path.join(temp, "review-prompts")
if (scenario === "edit" || configFailure) {
  await mkdir(customPrompts)
  if (configFailure) await writeFile(path.join(customPrompts, "PERMISSION-REVIEW-CONTRACT.md"), "disallowed override")
  else {
    await writeFile(path.join(customPrompts, "EDIT-REVIEW-PROMPT.md"), "CUSTOM EDIT FIXTURE: explain the proposed changes and omissions.")
  }
}
const calls = []
const events = []
const record = (event) => events.push({ event, at: Date.now() })
let toolSent = false
let reviewerCalls = 0
let reviewerAborted = false
let releaseReview
let reviewHeldAt
let releasedReviews = 0
const audit = reviewerAudit()
const handleRequest = async (req, res) => {
  try {
    assert.equal(req.socket.localPort, (req.url === "/review/chat/completions" ? reviewerServer : server).address().port,
      "reviewer requests must use their separate origin")
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      const observation = audit.request(req.method, text)
      assert.equal(req.headers.authorization, "Bearer fixture-review-key")
      reviewerCalls++
      record(`review-request-${reviewerCalls}`)
      if (auto) {
        await assert.rejects(access(path.join(commandDirectory, "executed-marker")), "review request must precede native execution")
        if (isEdit) await assertEditsUnchanged()
      }
      if (descriptor.error) { res.writeHead(401); res.end("fixture authentication failure"); record("review-error"); return }
      if (networkRetry && reviewerCalls <= 2) {
        observation.transportRetry()
        res.writeHead(reviewerCalls === 1 ? 429 : 503, { "Retry-After": "1" })
        res.end("PRIVATE transient fixture failure")
        record(`transient-response-${reviewerCalls}`)
        return
      }
      const reply = () => {
        res.writeHead(200, { "Content-Type": "application/json" })
        const content = correction && reviewerCalls === 1
          ? '{"safe":"yes","desc":"Incorrect boolean type."}'
          : JSON.stringify({ safe: !descriptor.unsafe, desc: descriptor.stalled ? "Source contents unavailable after a bounded file-access timeout." : descriptor.long ? auto ? autoLongDescription : longDescription : isEdit ? "Proposed file changes. Partial coverage where diffs are omitted." : "Counts two fruit names, prints the count, and writes it to executed-marker." })
        const usage = withUsage ? { prompt_tokens: 500, completion_tokens: 20 } : undefined
        observation.usage(usage)
        observation.response(content, correction && reviewerCalls === 1)
        res.end(JSON.stringify({ choices: [{ message: { content, reasoning_content: "HIDDEN-REASONING-SENTINEL" } }],
          ...(usage ? { model: "review-fixture", usage } : {}),
        }))
        record(`review-response-${reviewerCalls}`)
      }
      if (scenario === "edit" && reviewerCalls === 1) await writeFile(path.join(customPrompts, "EDIT-REVIEW-PROMPT.md"), "CHANGED AFTER STARTUP")
      if (heldReview) {
        res.on("close", () => { if (!res.writableEnded) reviewerAborted = true })
        reviewHeldAt = Date.now()
        releaseReview = () => {
          assert.ok(reviewerAborted && res.destroyed, "release must follow observed client cancellation")
          releasedReviews++
          reply()
          releaseReview = undefined
        }
      } else reply()
      return
    }
    const tools = body.tools ?? []
    const tool = tools.find((item) => item.function?.name === toolName)
    const doTool = !!tool && !toolSent
    if (doTool) toolSent = true
    const message = doTool
      ? { role: "assistant", content: scenario === "correction" ? conversationDescription : null, tool_calls: [{ id: "call_fixture", type: "function", function: { name: toolName, arguments: JSON.stringify(toolInput) } }] }
      : { role: "assistant", content: "Fixture complete." }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish_reason) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })
      const delta = doTool
        ? { role: "assistant", content: message.content, tool_calls: message.tool_calls.map((t, index) => ({ index, ...t })) }
        : message
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, doTool ? "tool_calls" : "stop"))}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "fixture", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message, finish_reason: doTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  } catch (error) {
    record(`fixture-error: ${error}`)
    res.writeHead(500)
    res.end(String(error))
  }
}
const server = createServer(handleRequest)
const reviewerServer = createServer(handleRequest)
const metrics = smokeMetrics(server, { pollIntervalMs: 100, hostVersion, origin: "main" })
metrics.attach(reviewerServer, "reviewer")
let outcome = "failed"
const runtime = await smokeRuntime(temp)
const tmux = runtime.tmux
let screen = ""
let tmuxStarted = false
const failAfterListen = process.argv.includes("--fail-after-listen")
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  await new Promise((resolve, reject) => {
    reviewerServer.once("error", reject)
    reviewerServer.listen(0, "127.0.0.1", resolve)
  })
  if (failAfterListen) throw new Error("Injected post-listen startup failure")
  const port = server.address().port
  const reviewPort = reviewerServer.address().port
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `fixture/${fixtureModel}`,
    small_model: `fixture/${fixtureModel}`,
    autoupdate: false,
    permission: { bash: "ask", edit: "ask", external_directory: "ask" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `http://127.0.0.1:${port}/main`, apiKey: "fixture-only" }, models: { [fixtureModel]: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } },
  }
  if (knownPricing) config.provider.reviewer = {
    npm: "@ai-sdk/openai-compatible", name: "Reviewer fixture",
    options: { baseURL: `http://127.0.0.1:${reviewPort}/review`, apiKey: "fixture-review-key" },
    models: { "review-fixture": { name: "Review fixture", limit: { context: 32000, output: 1000 }, cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } } },
  }
  const tuiFile = path.join(temp, "tui.json")
  await writeFile(tuiFile, JSON.stringify({
    $schema: "https://opencode.ai/tui.json",
    theme: scenario === "correction" ? "tokyonight" : "opencode",
    plugin: [[pluginFile, { notify: notifications, ...(approvalSound ? { notifications: { approved: { sound: true } } } : {}),
      staleReminderSeconds: reminders ? 1 : 60, baseURL: `http://127.0.0.1:${reviewPort}/review`, model: "review-fixture", apiKey: "fixture-review-key",
      ...plan.settings,
      ...(scenario === "edit" || configFailure ? { instructions: customPrompts } : {}),
      ...(scenario === "patch" ? { maxFiles: 2 } : {}),
      ...(auto ? { autoApprove: true, autoApproveDelaySeconds: autoDelay } : {}),
    }]],
  }))
  const env = {
    HOME: temp,
    XDG_CONFIG_HOME: path.join(temp, "config"),
    XDG_DATA_HOME: path.join(temp, "data"),
    XDG_STATE_HOME: path.join(temp, "state"),
    XDG_CACHE_HOME: path.join(temp, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: path.join(temp, "config"),
    OPENCODE_TUI_CONFIG: tuiFile,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  }
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  tmuxStarted = true
  metrics.mark("tmux-start-dispatched")
  await runtime.start("-d", "-s", "smoke", "-x", String(initialWidth), "-y", scenario === "cancel" ? "24" : "40", "-c", project,
    "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    hostBinary, project,
    "--prompt", userPrompt)
  metrics.mark("tmux-start-acknowledged")
  const capture = () => tmux("capture-pane", "-p", "-t", "smoke")
  const until = async (condition, timeout = 90000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(100)
      screen = capture()
      if (await condition(screen)) return
    }
    throw new Error("Timed out waiting for expected terminal state")
  }
  const expected = scenario === "error" || scenario === "auto-error" || configFailure ? "! Analysis unavailable" : ["external", "patch", "auto-unsafe", "stalled-file"].includes(scenario) ? "✗ Unsafe" : "✓ Safe"
  const spinnerFrame = (s) => s.split("\n").find((line) => /[■⬝]{8}/.test(line.slice(initialWidth - 42)))?.match(/[■⬝]{8}/)?.[0]
  const hasExpected = (s) => disabledReview ? !hasPanel(s) : heldReview ? !!spinnerFrame(s) : s.includes(expected)
  const hasPanel = (s) => /Permission analysis|Counts two fruit names|Analysis unavailable/.test(s)
  const toggleSidebar = () => tmux("send-keys", "-t", "smoke", "C-x", "b")
  // SGR terminal mouse events enter the real host input path. Coordinates are
  // one-based; wheel = 64/65, left drag = press 0 / motion 32 / release 0.
  const mouse = (button, x, y, release = false) => tmux("send-keys", "-t", "smoke", "-l", `\x1b[<${button};${x};${y}${release ? "m" : "M"}`)
  const drag = async (from, to) => {
    mouse(0, 158, from)
    await sleep(100)
    const step = Math.sign(to - from)
    for (let y = from + step; step > 0 ? y <= to : y >= to; y += step) {
      mouse(32, 158, y)
      await sleep(20)
    }
    mouse(0, 158, to, true)
  }
  const wheelToEnd = async () => {
    // Bounded even with the fixed footer and fenced-code sections in auto-scroll.
    for (let i = 0; i < 260 && !capture().includes(finalLine); i++) {
      mouse(65, 140, 20)
      await sleep(40)
    }
    await until((s) => s.includes(finalLine), 10000)
    assert.ok(!screen.includes("Counts two fruit names"), "wheel should move the analysis viewport")
    assert.match(screen, /Allow once.*Allow always.*Reject/, "native approval controls must survive scrolling")
  }
  const assertUsage = async () => {
    const input = correction ? 1000 : 500, output = correction ? 40 : 20
    if (scenario === "correction" || descriptor.scroll) {
      for (let i = 0; i < 30 && !capture().includes("ratings: 1 ✓ 0 ✗"); i++) { mouse(65, 140, 20); await sleep(40) }
    }
    await until((s) => s.includes(`token: ${input} in ${output} out`), 5000)
    const ansi = tmux("capture-pane", "-p", "-e", "-t", "smoke")
    assert.equal(styleAt(ansi, `token: ${input} in ${output} out`).fg, styleAt(ansi, "fullscreen").fg, "usage footer must use the active theme's muted color")
    const sidebarText = screen.split("\n").map((line) => line.slice(118)).join("\n")
    if (knownPricing) assert.match(sidebarText, correction ? /cost: \$0\.0011/ : /cost: \$0\.0005/)
    else assert.doesNotMatch(sidebarText, /cost:\s*\$/, "unknown pricing must not invent a cost")
    await until((s) => s.includes(knownPricing ? "lifetime: $" : "lifetime: cost unavailable"), 5000)
    await until((s) => s.includes(scenario === "patch" ? "ratings: 0 ✓ 1 ✗" : "ratings: 1 ✓ 0 ✗"), 5000)
    const lifetimeAnsi = tmux("capture-pane", "-p", "-e", "-t", "smoke")
    assert.equal(styleAt(lifetimeAnsi, "lifetime:").fg, styleAt(lifetimeAnsi, "fullscreen").fg)
    if (knownPricing) {
      const rows = screen.split("\n").map((line) => line.slice(118).trim())
      const first = rows.findIndex((line) => line === `token: ${input} in ${output} out`)
      assert.match(rows[first + 1] ?? "", /^cost: \$/)
      assert.match(rows[first + 2] ?? "", /^lifetime: \$/)
    }
    await writeFile(path.join(root, `.runtime/${scenario}-usage.ansi`), ansi)
  }
  async function runApprovalFamily() {
    const save = async (name) => {
      screen = capture()
      assert.doesNotMatch(screen, /HIDDEN-REASONING-SENTINEL/)
      await writeFile(path.join(root, `.runtime/${scenario}-${name}.txt`), screen)
      const ansi = tmux("capture-pane", "-p", "-e", "-t", "smoke")
      await writeFile(path.join(root, `.runtime/${scenario}-${name}.ansi`), ansi)
      return ansi
    }
    const unchanged = async () => {
      await assert.rejects(access(path.join(commandDirectory, "executed-marker")))
      await assert.rejects(access(path.join(commandDirectory, "execution-log")))
      if (isEdit) await assertEditsUnchanged()
    }
    // Keep inspecting native pending state throughout a delay, not just at its end.
    const pendingFor = async (ms, check) => {
      const deadline = Date.now() + ms
      do {
        screen = capture()
        assert.match(screen, /Permission required/)
        assert.match(screen, /Allow once.*Allow always.*Reject/)
        assert.doesNotMatch(screen, /HIDDEN-REASONING-SENTINEL/)
        await unchanged()
        check?.(screen)
        await sleep(100)
      } while (Date.now() < deadline)
    }
    const reviews = () => calls.filter((call) => call.url === "/review/chat/completions")
    const noFooter = (s) => assert.doesNotMatch(s, /Allowed in|Checking…|Allowing…|Auto-approval|Cancel/)
    const countdown = async (stage = "pending") => {
      await until((s) => s.includes("✓ Safe") && s.includes(`Allowed in ${autoDelay}s`))
      metrics.mark("countdown-visible", reviewerCalls)
      const started = Date.now()
      record(`${stage}-countdown-visible`)
      const footerRow = screen.split("\n").findIndex((line) => line.includes("Allowed in"))
      assert.ok(footerRow >= 36, "countdown belongs at the bottom of the 40-row sidebar")
      assert.match(screen, /Allow once.*Allow always.*Reject/)
      assert.match(screen, isEdit ? /Proposed file changes/ : /Counts two fruit names/,
        "assessment must be painted before the full countdown is visible")
      await unchanged()
      const ansi = await save(stage)
      if (scenario === "auto-shell" && !networkRetry) await assertUsage()
      if (networkRetry) assert.doesNotMatch(capture(), /token: \d+ in \d+ out|lifetime:/, "unreported failed POSTs leave report-wide usage unknown")
      assert.equal(styleAt(ansi, "✓ Safe").fg, "127,216,143")
      assert.equal(styleAt(ansi, "✓ Safe").bold, true)
      for (const property of ["fg", "bg"]) {
        assert.equal(styleAt(ansi, "Allowed in")[property], styleAt(ansi, "Allow once")[property], "selected auto control must match the native permission button")
        assert.equal(styleAt(ansi, "Cancel")[property], styleAt(ansi, "Allow always")[property], "unselected auto control must match the native permission button")
      }
      return { started, footerRow }
    }
    const clickFooter = (label, row) => {
      const x = capture().split("\n")[row].indexOf(label) + 2
      assert.ok(x > 118, `${label} must be the sidebar control`)
      mouse(0, x, row + 1)
      mouse(0, x, row + 1, true)
      record(`clicked-${label}`)
    }
    const canceled = descriptor.cancel || visibilityLoss
    const manualResult = descriptor.unsafe || descriptor.error
    let started
    if (scenario === "auto-zero") {
      // Allow normal host startup; a zero-second footer may pass between captures.
      await until(() => events.some((event) => event.event === "review-response-1"))
    }
    if (scenario === "auto-initially-hidden") {
      await until((s) => s.includes("Permission required") && events.some((event) => event.event === "review-response-1"))
      await pendingFor(autoDelay * 1000 + 500, (s) => { assert.ok(!hasPanel(s)); noFooter(s) })
      assert.equal(reviewerCalls, 1, "hidden assessment must complete without starting automation")
      await save("initially-hidden")
      tmux("resize-window", "-t", "smoke", "-x", "160", "-y", "40")
    }
    if (manualResult) {
      await until((s) => s.includes(expected) && s.includes("Permission required"))
      const ansi = await save("pending")
      assert.equal(styleAt(ansi, expected).fg, scenario === "auto-unsafe" ? "224,108,117" : "245,167,66")
      assert.equal(styleAt(ansi, expected).bold, true, "status icon and text must be bold")
      if (scenario === "auto-error") {
        assert.match(screen, /Reviewer HTTP 401/)
        assert.doesNotMatch(screen, /fixture outage|✓ Safe|✗ Unsafe/)
      }
      await pendingFor(autoDelay * 1000 + 500, (s) => { assert.ok(s.includes(expected)); noFooter(s) })
      await save("past-deadline")
      tmux("send-keys", "-t", "smoke", "Escape")
    } else if (scenario !== "auto-zero") {
      let stage = await countdown()
      started = stage.started
      if (scenario === "auto-external") {
        let directory
        await runPermissionStages(plan, {
          pending: async (_, index) => {
            if (!index) return
            await until(s => reviewerCalls === 2 && s.includes("Shell command") && s.includes(`Allowed in ${autoDelay}s`), 10000)
            const secondRequested = events.find(event => event.event === "review-request-2").at
            assert.ok(secondRequested - started >= autoDelay * 1000 - 250, "directory approval must wait a full countdown")
            await unchanged() // Directory approval alone must never execute the command.
          },
          assessment: async (_, index) => {
            if (!index) {
              directory = JSON.parse(reviews()[0].body.messages[1].content)
              assert.equal(directory.permission.type, "external_directory")
              assert.deepEqual(directory.permission.metadata.directories, [commandDirectory])
              assert.deepEqual(directory.permission.patterns, [`${commandDirectory}/*`])
              assert.deepEqual(directory.permission.always, [`${commandDirectory}/*`])
            } else {
              const bash = JSON.parse(reviews()[1].body.messages[1].content)
              assert.equal(bash.permission.type, "bash")
              assert.notEqual(bash.permission.id, directory.permission.id)
              assert.equal(bash.permission.tool.callID, directory.permission.tool.callID)
              assert.deepEqual(bash.permission.patterns, ["python3 fruits.py"])
              assert.equal(bash.cwd, commandDirectory)
              assert.equal(bash.files[0].contents, source)
            }
          },
          capture: async () => {},
          countdown: async (_, index) => {
            if (!index) await pendingFor(Math.max(0, started + autoDelay * 1000 - 250 - Date.now()), s => assert.match(s, /Allowed in \d+s/))
            else { stage = await countdown("bash-pending"); started = stage.started }
          },
        })
      }
      const { footerRow } = stage
      if (descriptor.scroll) {
        const renderedCode = (s) => {
          assert.match(s, /RENDERED CODE FIXTURE/)
          assert.match(s, /fruit_count = len/)
          assert.match(s, /print\(fruit_count\)/)
          assert.doesNotMatch(s, /```|\*\*Output:\*\*|HIDDEN-REASONING-SENTINEL/)
        }
        renderedCode(screen)
        const codeAnsi = tmux("capture-pane", "-p", "-e", "-t", "smoke")
        assertScrollbarTheme(codeAnsi)
        assert.equal(styleAt(codeAnsi, '"apple"').fg, "127,216,143", "fenced code must be highlighted when the full countdown appears")
        assert.equal(styleAt(codeAnsi, "# RENDERED CODE FIXTURE").italic, true, "code comments must have rendered syntax styling")
        const stableTick = async () => {
          const count = screen.match(/Allowed in (\d+)s/)?.[1]
          assert.ok(count, "scrolling must not cancel the countdown")
          const viewport = (s) => s.split("\n").slice(5, footerRow - 2).map((line) => line.slice(118)).join("\n")
          const before = viewport(screen)
          await until((s) => /Allowed in \d+s/.test(s) && s.match(/Allowed in (\d+)s/)?.[1] !== count, 3000)
          assert.equal(viewport(screen), before, "countdown ticks must retain the analysis scroll position")
          assert.equal(screen.split("\n").findIndex((line) => line.includes("Allowed in")), footerRow, "footer must stay fixed")
          renderedCode(screen)
        }
        await stableTick()
        assert.ok(!screen.includes(finalLine), "long Markdown including code must overflow")
        await wheelToEnd()
        await assertUsage()
        await stableTick()
        await save("wheel-final")
        const thumbRow = () => {
          const ansi = tmux("capture-pane", "-p", "-e", "-t", "smoke")
          const row = Array.from({ length: footerRow - 7 }, (_, i) => i + 5).find((y) => /[█▀▄]/u.test(cellAt(ansi, y, 157).character))
          assert.notEqual(row, undefined, "scrollbar drag needs a visible thumb")
          return row + 1
        }
        await drag(thumbRow(), 6)
        await until((s) => s.includes("Counts two fruit names") && s.includes("print(fruit_count)") && !s.includes(finalLine), 5000)
        await stableTick()
        await save("drag-top")
        await drag(thumbRow(), footerRow - 2)
        await until((s) => s.includes(finalLine), 5000)
        await stableTick()
        await save("scrolled")
      }
      if (descriptor.cancel) {
        clickFooter("Cancel", footerRow)
        await until((s) => s.includes("Auto-approval canceled"), 3000)
        toggleSidebar()
        await until((s) => !hasPanel(s), 3000)
        toggleSidebar()
      } else if (visibilityLoss) {
        if (scenario === "auto-hide") toggleSidebar()
        else if (scenario === "auto-dialog") tmux("send-keys", "-t", "smoke", "C-p")
        else if (scenario === "auto-fullscreen") tmux("send-keys", "-t", "smoke", "C-f")
        else tmux("resize-window", "-t", "smoke", "-x", "80", "-y", "24")
        await until((s) => !hasPanel(s) && (scenario === "auto-dialog" ? s.includes("Commands")
          : scenario === "auto-fullscreen" ? s.includes("minimize") : s.includes("Permission required")), 3000)
        record("panel-hidden")
        await save("hidden")
        await sleep(300) // Give the native covering view a complete rendered frame.
        await unchanged()
        if (scenario === "auto-hide") toggleSidebar()
        else if (scenario === "auto-dialog") tmux("send-keys", "-t", "smoke", "Escape")
        else if (scenario === "auto-fullscreen") tmux("send-keys", "-t", "smoke", "C-f")
        else tmux("resize-window", "-t", "smoke", "-x", "160", "-y", "40")
        await until((s) => s.includes("Permission analysis"), 3000)
        record("panel-restored")
        await save("restored")
      } else if (scenario === "auto-immediate") {
        const x = screen.split("\n")[footerRow].indexOf("Cancel") + 2
        mouse(35, x, footerRow + 1)
        await until(() => {
          const ansi = tmux("capture-pane", "-p", "-e", "-t", "smoke")
          return ["fg", "bg"].every((property) =>
            styleAt(ansi, "Cancel")[property] === styleAt(ansi, "Allow once")[property]
            && styleAt(ansi, "Allowed in")[property] === styleAt(ansi, "Allow always")[property])
        }, 3000)
        await unchanged()
        await save("hover-cancel")
        clickFooter("Allowed in", footerRow)
      } else if (scenario === "auto-manual") {
        tmux("send-keys", "-t", "smoke", "Enter")
        record("native-enter")
      }
      if (canceled) {
        try {
          await until((s) => s.includes("Auto-approval canceled"), 3000)
        } catch (error) {
          // Retain the original failure, plus the outcome after the old deadline.
          await sleep(Math.max(0, started + autoDelay * 1000 + 1000 - Date.now()))
          await save("past-deadline")
          record(await access(path.join(commandDirectory, "executed-marker")).then(() => "unexpected-native-execution", () => "no-native-execution"))
          throw error
        }
        await save("canceled")
        await pendingFor(Math.max(500, autoDelay * 1000 + 500 - (Date.now() - started)), (s) => {
          assert.match(s, /Auto-approval canceled/)
          assert.doesNotMatch(s, /Allowed in|Checking…|Allowing…/)
        })
        await save("past-deadline")
        tmux("send-keys", "-t", "smoke", "Escape")
      } else if (!["auto-immediate", "auto-manual"].includes(scenario)) {
        await pendingFor(Math.max(0, started + autoDelay * 1000 - 250 - Date.now()), (s) => assert.match(s, /Allowed in \d+s/))
      }
    }
    if (!canceled && !manualResult) {
      await until(async () => isEdit ? await readFile(path.join(project, "note.txt"), "utf8") === "after\n"
        : access(path.join(commandDirectory, "execution-log")).then(() => true, () => false), 10000)
      record("native-side-effect-observed")
      if (scenario === "auto-immediate" || scenario === "auto-manual") {
        assert.ok(Date.now() - started < autoDelay * 1000 - 1000, "native side effect must precede the full delay")
        await save("early-execution")
        await sleep(Math.max(0, autoDelay * 1000 + 500 - (Date.now() - started)))
      } else if (started) assert.ok(Date.now() - started >= autoDelay * 1000 - 250, "approval must wait for the full countdown")
      if (isEdit) {
        assert.equal(await readFile(path.join(project, "note.txt"), "utf8"), "after\n")
        for (const name of ["delete.txt", "move.txt"]) assert.equal(await readFile(path.join(project, name), "utf8"), editOriginals[name])
      } else {
        assert.equal(await readFile(path.join(commandDirectory, "executed-marker"), "utf8"), "2")
        const executions = (await readFile(path.join(commandDirectory, "execution-log"), "utf8")).trim().split("\n")
        assert.equal(executions.length, 1, "native tool must execute exactly once, including after the original deadline")
        assert.ok(Number(executions[0]) >= events.find((event) => event.event === `review-response-${networkRetry ? 3 : 1}`).at,
          "even zero delay requires a completed reviewer response before native execution")
      }
    }
    await until((s) => !s.includes("Permission required") && !hasPanel(s), 10000)
    metrics.mark("permission-and-panel-resolved", reviewerCalls)
    // Successful native tools continue the conversation; Escape ends the turn.
    // Observe that request, rather than mistaking a generated title for a reply.
    if (!canceled && !manualResult) await until(() => calls.some((call) => call.url === "/main/chat/completions"
      && call.body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_fixture")), 10000)
    if (canceled || manualResult) await unchanged()
    assert.ok(!events.some((event) => event.event.startsWith("fixture-error:")), "fixture HTTP handler must not fail")
    assert.equal(reviewerCalls, networkRetry ? 3 : scenario === "auto-external" ? 2 : 1)
    if (networkRetry) for (let attempt = 1; attempt <= 2; attempt++) {
      assert.ok(events.find(e => e.event === `review-request-${attempt + 1}`).at - events.find(e => e.event === `transient-response-${attempt}`).at >= 950,
        "real host must honor the provider cooldown before its next POST")
    }
    for (const review of reviews()) {
      assert.match(review.body.messages[0].content, /Take extra care/)
      assert.doesNotMatch(JSON.stringify(review.body), /autoApprove|countdown|automatic approval/)
      const sent = JSON.parse(review.body.messages[1].content)
      assert.equal(sent.userPrompt, userPrompt)
      assert.equal(sent.session.root.directory, project)
      if (isEdit) {
        assert.equal(sent.kind, "edit")
        assert.equal(sent.permission.type, "edit")
        assert.equal(sent.tool, "edit")
        assert.equal(sent.changes[0].path, path.join(project, "note.txt"))
        assert.match(sent.changes[0].diff, /-before\n\+after/)
      } else if (sent.kind === "external-directory") {
        assert.equal(sent.tool, "bash")
        assert.deepEqual(sent.operation.input, toolInput)
        assert.ok(!("files" in sent))
      } else {
        assert.equal(sent.command, "python3 fruits.py")
        assert.equal(sent.cwd, commandDirectory)
        assert.equal(sent.files[0].contents, source)
      }
    }
    for (const call of calls.filter((call) => call.url === "/main/chat/completions")) {
      assert.doesNotMatch(JSON.stringify(call.body.messages), /Take extra care|autoApprove|countdown|automatic approval|Auto-approval|Allowed in|Permission analysis|HIDDEN-REASONING-SENTINEL/)
      const invocations = call.body.messages.flatMap((message) => message.tool_calls ?? []).filter((tool) => tool.id === "call_fixture")
      assert.ok(invocations.length <= 1, "generating-agent history must retain a single original invocation")
      for (const tool of invocations) {
        assert.equal(tool.function.name, toolName)
        assert.deepEqual(JSON.parse(tool.function.arguments), toolInput, "automation must not alter generating-agent tool input")
      }
    }
    await save("resolved")
    await writeFile(path.join(root, `.runtime/${scenario}-requests.json`), JSON.stringify(calls, null, 2))
    await writeFile(path.join(root, `.runtime/${scenario}-events.json`), JSON.stringify(events, null, 2))
    console.log(`PASS ${scenario}: ${manualResult ? "bold themed manual result; no footer/execution across delay" : canceled ? "permanent cancellation; native pending beyond deadline" : "native once-only side effect and reviewer-before-execution"}; ${reviewerCalls} review(s), extra-careful prompt, unchanged generating-agent input, clean panel removal. Isolated files: ${temp}`)
  }
  async function runAdvisoryFamily() {
    const assertReviewLayout = (screen, width) => {
      if (disabledReview) {
        assert.ok(!hasPanel(screen), "disabled reviews must remain hidden")
        assert.match(screen, /Allow once.*Allow always.*Reject/, "disabling reviews must not disable native approval")
        return
      }
      const lines = screen.split("\n")
      const headingLine = lines.findIndex((line) => line.includes("Permission analysis"))
      assert.ok(headingLine >= 0, "permission analysis heading should be visible")
      const column = lines[headingLine].indexOf("Permission analysis")
      assert.equal(column, width - 40, "overlay heading should align with the native sidebar padding")
      const status = heldReview ? spinnerFrame(screen) : expected
      assert.ok(status, "pending reviews should have an animated scanner")
      const reviewLine = lines.findIndex((line) => line.includes(status))
      assert.equal(reviewLine, headingLine + 2, "status should have its own line beneath the heading")
      assert.ok(screen.includes("Permission required"), "native permission should remain visible")
      assert.equal(lines[reviewLine].indexOf(status), column, "status should align with the heading")
      const controlsLine = lines.findIndex((line) => line.includes("Allow once"))
      assert.ok(controlsLine > headingLine, "native approval controls should remain visible beside the overlay")
      assert.equal(lines.filter((line) => line.includes(status)).length, 1, "review must not be duplicated in a bottom bar")
      const sidebarText = lines.map((line) => line.slice(width - 42)).join("\n")
      assert.doesNotMatch(sidebarText, /\b(?:SAFE|UNSAFE)\b/, "rating labels should use title case")
      assert.doesNotMatch(sidebarText, /Analyzing|\.\.\./, "the loading indicator should not include redundant text")
      assert.doesNotMatch(sidebarText, /Context|LSP|OpenCode|project:main|Fixture complete\./, "overlay must cover the native sidebar title, sections, and footer")
      if (scenario === "correction" || scenario === "external") {
        assert.equal(lines.findIndex((line) => line.includes("Counts two fruit names")), reviewLine + 2, "analysis should follow the status on a separate line")
      } else if (heldReview || scenario === "error" || configFailure) {
        assert.doesNotMatch(sidebarText, /✓ Safe|✗ Unsafe/, "pending or failed reviews must not fabricate a rating")
      }
      if (scenario === "error") assert.match(sidebarText, /Reviewer HTTP 401/)
      if (configFailure) assert.match(sidebarText, /Contract prompt overrides/)
      if (scenario === "correction") {
        assert.ok(screen.includes("Output: prints the count."), "formatted list should be visible")
        assert.ok(screen.includes("File: writes to executed-marker."), "inline code should render without backticks")
        assert.ok(!screen.includes("**Output:**"), "emphasis markers should be concealed")
        assert.ok(screen.includes("\\u001b[2J\\u202e"), "controls and bidi must stay escaped inside Markdown")
      }
    }
    const formattingReady = (s) => scenario === "correction"
      ? s.includes("File: writes to executed-marker.") && s.includes("\\u001b[2J\\u202e") && s.includes("Documentation")
      : isEdit && !heldReview && !configFailure && !disabledReview ? s.includes("Proposed file changes") : scenario !== "external" || s.includes("Counts two fruit names")
    if (scenario === "stalled-file") {
      await until(async (s) => s.includes("Permission required") && !!spinnerFrame(s) && await access(stalledFile).then(() => true, () => false))
      assert.equal(reviewerCalls, 0, "the filesystem stall precedes the model request")
      const start = Date.now()
      tmux("send-keys", "-t", "smoke", "C-p")
      await until((s) => s.includes("Commands") && !hasPanel(s), 3000)
      tmux("send-keys", "-t", "smoke", "Escape")
      await until((s) => s.includes(expected) && s.includes("Source contents unavailable"), 5000)
      assert.ok(Date.now() - start < 5000, "optional file I/O must not consume the 30-second review deadline")
      assert.equal(reviewerCalls, 1)
      const omitted = JSON.parse(calls.find((call) => call.url === "/review/chat/completions").body.messages[1].content).files[0]
      assert.equal(omitted.contents, undefined)
      assert.match(omitted.status, /File capture timed out/)
      console.log("PASS stalled-file UI: palette remained interactive during stalled open; bounded omission reached reviewer")
    }
    if (scenario === "cancel") {
      await until((s) => s.includes("Permission required") && reviewerCalls > 0)
      // Deliberately exceed the old six-second response race while the HTTP reply
      // remains held. This is a slow-UI regression, not a response synchronization.
      await sleep(6500)
      screen = capture()
      assert.ok(Date.now() - reviewHeldAt > 6000)
      assert.equal(releasedReviews, 0)
      assert.ok(releaseReview && !reviewerAborted, "review must remain pending throughout slow UI interaction")
      assert.ok(!hasPanel(screen) && !screen.includes("Context"), "a narrow terminal must not open the sidebar or show a bottom-bar fallback")
      await writeFile(path.join(root, ".runtime/cancel-sidebar-hidden.txt"), screen)
      toggleSidebar()
    }
    await until((screen) => screen.includes("Permission required") && hasExpected(screen) && formattingReady(screen) && (configFailure || disabledReview || reviewerCalls > 0))
    metrics.mark(heldReview ? "loading-visible" : disabledReview ? "disabled-permission-visible" : "review-visible", reviewerCalls)
    if (disabledReview) {
      await sleep(2200) // Include a reconciliation interval; disabled work must not start later.
      screen = capture()
    }
    assertReviewLayout(screen, initialWidth)
    assert.match(screen, /Permission required/, "real native approval should be visible")
    assert.match(screen, isEdit ? /Edit / : /python3 fruits\.py/)
    assert.ok(hasExpected(screen), "review status should render alongside approval")
    assert.ok(!screen.includes("opencode-reviewer:"), "the plugin should not display a title header")
    const firstReview = calls.find((call) => call.url === "/review/chat/completions")
    const sent = firstReview && JSON.parse(firstReview.body.messages[1].content)
    if (configFailure || disabledReview) assert.equal(reviewerCalls, 0, "invalid or disabled reviews must not send evidence")
    else {
      assert.ok(firstReview)
      assert.equal(sent.userPrompt, userPrompt)
      assert.equal(sent.session.root.directory, project)
      assert.equal(sent.session.root.projectID, sent.session.rootProject.id)
      assert.equal(sent.session.rootProject.worktree, project)
      assert.equal(sent.session.rootProject.vcs, "git")
      if (isEdit) {
        assert.equal(sent.kind, "edit")
        assert.equal(sent.tool, toolName)
        assert.equal(sent.permission.type, "edit")
        assert.equal(sent.permission.tool.callID, "call_fixture")
        assert.equal(sent.location.instanceDirectory, project)
        assert.ok(!("command" in sent) && !("metadata" in sent.permission))
        assert.match(firstReview.body.messages[0].content, /exactly two fields/)
        assert.match(firstReview.body.messages[0].content, scenario === "edit" ? /CUSTOM EDIT FIXTURE/ : /Explain the proposed file changes/)
        if (scenario === "patch") {
          assert.equal(sent.partial, true)
          assert.deepEqual(sent.changes.map((change) => change.operation), ["add", "update", "delete", "move"])
          assert.deepEqual(sent.changes.map((change) => change.status), ["included", "included", "omitted", "omitted"])
          assert.equal(sent.changes[3].movePath, path.join(project, "moved.txt"))
          assert.ok(!firstReview.body.messages[1].content.includes("DELETE-SENTINEL"))
          assert.ok(!firstReview.body.messages[1].content.includes("MOVE-SENTINEL"))
          for (const change of sent.changes.slice(2)) {
            assert.equal(change.warning, `[!] File ${JSON.stringify(change.path)} not included in context.`)
            assert.match(change.delta, /: \+\d+ −\d+ lines$/)
          }
        } else {
          assert.equal(sent.partial, false)
          assert.equal(sent.changes[0].path, path.join(project, "note.txt"))
          assert.match(sent.changes[0].diff, /-before\n\+after/)
        }
      } else if (sent.kind === "external-directory") {
        assert.equal(sent.tool, "bash")
        assert.deepEqual(sent.operation.input, toolInput)
        assert.equal(sent.location.instanceDirectory, project)
        assert.equal(sent.permission.type, "external_directory")
        assert.ok(!("files" in sent))
      } else {
        assert.equal(sent.command, "python3 fruits.py")
        assert.equal(sent.cwd, commandDirectory)
        assert.equal(sent.files[0].contents, scenario === "stalled-file" ? undefined : source)
        assert.equal(sent.execution.instanceDirectory, project)
        assert.equal(sent.execution.instanceWorktree, project)
        assert.equal(sent.execution.canonicalCwd, commandDirectory)
        assert.equal(sent.execution.requestedWorkdir, scenario === "external" ? "../outside" : null)
        assert.equal(sent.permission.type, scenario === "external" ? "external_directory" : "bash")
      }
    }
    if (isEdit) await assertEditsUnchanged()
    await assert.rejects(access(path.join(commandDirectory, "executed-marker")), "plugin must not execute/approve the command")
    if (correction) {
      assert.equal(reviewerCalls, 2)
      const second = calls.filter((call) => call.url === "/review/chat/completions")[1].body
      assert.match(second.messages[3].content, /Format validation failed/)
      assert.equal(second.messages[0].content, firstReview.body.messages[0].content, "prompts are a startup snapshot, not reloaded on correction")
      assert.match(screen, isEdit ? /Proposed file changes/ : /Counts two fruit names/)
      await sleep(400)
      assert.match(capture(), /Permission required/, "Safe must remain advisory")
    } else assert.equal(reviewerCalls, configFailure || disabledReview ? 0 : 1)
    await writeFile(path.join(root, `.runtime/${scenario}-pending.txt`), screen)
    const styledScreen = tmux("capture-pane", "-p", "-e", "-t", "smoke")
    if (withUsage && scenario !== "correction") await assertUsage()
    if (!withUsage) assert.doesNotMatch(screen.split("\n").map((line) => line.slice(initialWidth - 42)).join("\n"), /token: \d+ in \d+ out|lifetime:/, "missing endpoint usage must leave no request or standalone lifetime footer")
    await writeFile(path.join(root, `.runtime/${scenario}-pending.ansi`), styledScreen)
    if (!disabledReview) assert.match(styledScreen.split("\n").find((line) => line.includes("Permission analysis")) ?? "", /\x1b\[1m/, "overlay heading should be bold")
    if (scenario === "correction" || scenario === "external") {
      assert.equal(styleAt(styledScreen, expected).fg, scenario === "correction" ? "195,232,141" : "224,108,117", "rating text and icon must use the selected theme's success/error color")
    }
    if (scenario === "error") {
      assert.equal(styleAt(styledScreen, expected).fg, "245,167,66", "unavailable must use the theme warning color")
      assert.equal(styleAt(styledScreen, expected).bold, true)
    }
    if (scenario === "correction") {
      assertConversationStyles(styledScreen)
      const initialScrollbar = assertScrollbarTheme(styledScreen)
      assert.ok(!screen.includes(finalLine), "long analysis must initially overflow")
      await wheelToEnd()
      await assertUsage()
      await writeFile(path.join(root, ".runtime/correction-wheel-final.txt"), screen)
      await drag(38, 6)
      await until((s) => formattingReady(s) && !s.includes(finalLine), 10000)
      await drag(6, 40)
      await until((s) => s.includes(finalLine), 10000)
      await writeFile(path.join(root, ".runtime/correction-drag-final.txt"), screen)
      await drag(38, 6)
      await until(formattingReady, 10000)
      tmux("resize-window", "-t", "smoke", "-x", "80", "-y", "24")
      await until((s) => s.includes("Permission required") && !hasPanel(s) && !s.includes("Context") && s.split("\n").length === 25)
      await writeFile(path.join(root, ".runtime/correction-sidebar-hidden.txt"), screen)
      toggleSidebar()
      await until((s) => s.includes(expected) && formattingReady(s) && s.includes("Permission analysis"), 10000)
      assertReviewLayout(screen, 80)
      await writeFile(path.join(root, ".runtime/correction-narrow-pending.txt"), screen)
      toggleSidebar()
      await until((s) => s.includes("Permission required") && !hasPanel(s) && !s.includes("Context"), 10000)
      tmux("resize-window", "-t", "smoke", "-x", "160", "-y", "40")
      await until((s) => s.includes("Permission required") && s.includes("enter confirm") && !hasPanel(s) && !s.includes("Context") && s.split("\n").length === 41)
      await writeFile(path.join(root, ".runtime/correction-wide-hidden.txt"), screen)
      toggleSidebar()
      await until((s) => s.includes(expected) && formattingReady(s) && s.includes("Permission analysis"), 10000)
      assertReviewLayout(screen, 160)
      tmux("send-keys", "-t", "smoke", "C-p")
      await until((s) => s.includes("Commands") && !hasPanel(s), 10000)
      await writeFile(path.join(root, ".runtime/correction-dialog.txt"), screen)
      tmux("send-keys", "-t", "smoke", "Escape")
      await until((s) => s.includes("Permission required") && s.includes(expected) && formattingReady(s), 10000)
      assertReviewLayout(screen, 160)
      tmux("send-keys", "-t", "smoke", "C-x", "t")
      await until((s) => s.includes("Themes") && !hasPanel(s), 10000)
      tmux("send-keys", "-t", "smoke", "-l", "opencode")
      await until((s) => s.includes("Themes") && s.includes("opencode"), 10000)
      tmux("send-keys", "-t", "smoke", "Enter")
      await until((s) => s.includes("Permission analysis") && s.includes(expected) && formattingReady(s), 10000)
      const changedTheme = tmux("capture-pane", "-p", "-e", "-t", "smoke")
      assertConversationStyles(changedTheme)
      const changedScrollbar = assertScrollbarTheme(changedTheme)
      assert.notEqual(changedScrollbar.panel, initialScrollbar.panel, "live theme change must update the track")
      assert.notEqual(changedScrollbar.muted, initialScrollbar.muted, "live theme change must update the thumb")
      assert.equal(styleAt(changedTheme, expected).fg, "127,216,143", "rating should follow a live theme change")
      assert.notEqual(styleAt(changedTheme, "executed-marker").fg, styleAt(styledScreen, "executed-marker").fg, "analysis code colors should update with the theme")
      await writeFile(path.join(root, ".runtime/correction-theme-changed.ansi"), changedTheme)
      await wheelToEnd()
      await writeFile(path.join(root, ".runtime/correction-theme-wheel-final.txt"), screen)
      tmux("send-keys", "-t", "smoke", "C-f")
      await until((s) => s.includes("Permission required") && s.includes("minimize"), 10000)
      await writeFile(path.join(root, ".runtime/correction-permission-fullscreen.txt"), screen)
      await writeFile(path.join(root, ".runtime/correction-permission-fullscreen.ansi"), tmux("capture-pane", "-p", "-e", "-t", "smoke"))
      assert.match(screen, /Allow once.*Allow always.*Reject/, "fullscreen native approval controls must remain visible")
      assert.match(screen, /python3 fruits\.py/, "fullscreen must retain the exact native command")
      assert.ok(!hasPanel(screen) && !screen.includes(finalLine), "native fullscreen portal should cover the analysis overlay")
      console.log("Native permission fullscreen layering: analysis covered; native command and all approval controls visible")
      tmux("send-keys", "-t", "smoke", "C-f")
      await until((s) => s.includes("Permission analysis") && s.includes("fullscreen") && !s.includes("minimize"), 10000)
      assert.equal(reviewerCalls, 2, "resizing or toggling the sidebar must not restart the review")
    }
    if (scenario === "external") {
      assert.match(screen, /✗ Unsafe/)
      assert.deepEqual(sent.permission.metadata.directories, [commandDirectory])
      assert.deepEqual(sent.permission.patterns, [`${commandDirectory}/*`])
      assert.deepEqual(sent.permission.always, [`${commandDirectory}/*`])
      // Authorize only the directory boundary. OpenCode must still ask for bash.
      metrics.mark("native-directory-allow-dispatched", reviewerCalls)
      tmux("send-keys", "-t", "smoke", "Enter")
      await until((s) => s.includes("Permission required") && s.includes("Shell command") && s.includes("✗ Unsafe") && formattingReady(s) && reviewerCalls === 2, 10000)
      metrics.mark("review-visible", reviewerCalls)
      const next = JSON.parse(calls.filter((call) => call.url === "/review/chat/completions")[1].body.messages[1].content)
      assert.equal(next.permission.type, "bash")
      assert.notEqual(next.permission.id, sent.permission.id)
      assert.equal(next.permission.tool.callID, sent.permission.tool.callID)
      assert.deepEqual(next.permission.patterns, ["python3 fruits.py"])
      assert.equal(next.cwd, commandDirectory)
      assert.equal(next.session.root.directory, project)
      assert.equal(next.files[0].contents, source)
      assertReviewLayout(screen, initialWidth)
      await assert.rejects(access(path.join(commandDirectory, "executed-marker")))
      await writeFile(path.join(root, ".runtime/external-bash-pending.txt"), screen)
    }
    if (scenario === "external-disabled") {
      tmux("send-keys", "-t", "smoke", "Enter")
      await until((s) => s.includes("Permission required") && s.includes("Shell command"), 10000)
      await sleep(2200)
      assertReviewLayout(capture(), initialWidth)
      assert.equal(reviewerCalls, 0, "disabled directory and bash switches suppress both stages")
      await assert.rejects(access(path.join(commandDirectory, "executed-marker")))
    }
    if (scenario === "cancel") {
      const initialFrame = spinnerFrame(screen)
      await until((s) => !!spinnerFrame(s) && spinnerFrame(s) !== initialFrame, 1500)
      const loadingLine = styledScreen.split("\n")[3]
      for (const match of loadingLine.matchAll(/[■⬝]/g)) {
        const color = styleAt(loadingLine, match[0], match.index).fg?.split(",")
        assert.ok(color?.length === 3 && color[0] === color[1] && color[1] === color[2], "scanner cells should be gray")
      }
      await activatePalette({ send: (...keys) => tmux("send-keys", "-t", "smoke", ...keys),
        capture: () => tmux("capture-pane", "-p", "-e", "-t", "smoke") }, "Disable animations", s => s.includes("[⋯]"))
      await until((s) => s.includes("Permission analysis") && s.includes("[⋯]"), 10000)
      assert.ok(!spinnerFrame(screen), "disabled animations should use a static indicator")
      assert.doesNotMatch(screen, /Analyzing/)
      await writeFile(path.join(root, ".runtime/cancel-static-indicator.txt"), screen)
      toggleSidebar()
      await until((s) => s.includes("Permission required") && !hasPanel(s) && !s.includes("Context"), 10000)
      assert.equal(reviewerCalls, 1, "hiding the sidebar must not restart the pending review")
    }
    // A real human-style keystroke, not a plugin/API permission write.
    metrics.mark(correction ? "native-allow-dispatched" : "native-reject-dispatched", reviewerCalls)
    tmux("send-keys", "-t", "smoke", correction ? "Enter" : "Escape")
    await until((s) => !s.includes("Permission required") && !hasPanel(s), 10000)
    metrics.mark("permission-and-panel-resolved", reviewerCalls)
    if (scenario === "edit") {
      await until(async () => await readFile(path.join(project, "note.txt"), "utf8") === "after\n", 10000)
      assert.equal(await readFile(path.join(project, "delete.txt"), "utf8"), editOriginals["delete.txt"])
    } else if (scenario === "correction") {
      // The generated sidebar title can also be "Fixture complete." before bash
      // finishes. Observe execution, rather than mistaking that title for a reply.
      await until(async (s) => s.includes("Fixture complete.") && await access(path.join(commandDirectory, "executed-marker")).then(() => true, () => false), 10000)
      await access(path.join(commandDirectory, "executed-marker"))
    } else {
      if (heldReview) {
        await until(() => reviewerAborted, 10000)
        assert.equal(releasedReviews, 0, "HTTP abort must precede the held response release")
        releaseReview()
        assert.equal(releasedReviews, 1)
        await until((s) => s.includes("tab agents") && !s.includes("Permission required") && !hasPanel(s), 10000)
      } else await sleep(300)
      await assert.rejects(access(path.join(commandDirectory, "executed-marker")))
      assert.ok(!hasPanel(capture()), "late response must not resurrect panel")
      if (isEdit) await assertEditsUnchanged()
    }
    if (scenario === "cancel") {
      toggleSidebar()
      await until((s) => s.includes("Context"), 10000)
      assert.ok(!hasPanel(screen), "reopening the sidebar after cancellation must not restore the review")
    }
    assert.match(capture(), /Context/, "native sidebar sections should remain after the temporary review is removed")
    if (scenario === "edit") {
      let originalAverages
      const showLifetime = async () => {
        await activatePalette({ send: (...keys) => tmux("send-keys", "-t", "smoke", ...keys),
          capture: () => tmux("capture-pane", "-p", "-e", "-t", "smoke") }, "Reviewer: Statistics", s => s.includes("Reviewer statistics"))
        await until((s) => s.includes("Reviewer statistics") && s.includes("Reviews: 1") && s.includes("Average time to rating:"), 10000)
        assert.match(screen, /Cost: \$0\.0011/)
        assert.match(screen, /Tokens: 1000 in 40 out/)
        assert.match(screen, /Retries: 1/)
        assert.match(screen, /Safe: 1 \(100\.0%\)/, "one final rating survives restart despite two format attempts")
        assert.match(screen, /Unsafe: 0 \(0\.0%\)/)
        assert.match(screen, /Auto-approved: 0 \(0\.0%\)/, "native manual approval is not auto-approval")
        const averages = [screen.match(/Average time to full report: (\d+\.\d+)s/)?.[1], screen.match(/Average time to rating: (\d+\.\d+)s/)?.[1]]
        assert.ok(averages.every(value => value !== undefined))
        assert.equal(averages[0], averages[1], "non-streamed rating arrives with the full report")
        if (originalAverages) assert.deepEqual(averages, originalAverages, "running averages survive restart")
        originalAverages = averages
        assert.doesNotMatch(screen, /Permission analysis/)
      }
      await showLifetime()
      await writeFile(path.join(root, ".runtime/edit-lifetime-dialog.txt"), screen)
      // Reuse the isolated HOME/state, but start a new host/plugin instance without a prompt.
      tmux("kill-session", "-t", "smoke")
      await runtime.start("-d", "-s", "smoke", "-x", "160", "-y", "40", "-c", project,
        "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), hostBinary, project)
      await until((s) => s.includes("Ask anything"), 90000)
      await showLifetime()
      assert.equal(reviewerCalls, 2, "opening lifetime stats and restarting must not make reviewer requests")
      await writeFile(path.join(root, ".runtime/edit-lifetime-restarted.txt"), screen)
    }
    await writeFile(path.join(root, `.runtime/${scenario}-resolved.txt`), capture())
    await writeFile(path.join(root, `.runtime/${scenario}-requests.json`), JSON.stringify(calls, null, 2))
    console.log(`PASS ${scenario}: native approval, exact evidence, advisory behavior, panel cleanup${scenario === "cancel" ? ", >6s held response, observed HTTP cancellation, released late response and clean sidebar remount at 80x24" : scenario === "correction" ? ", long-analysis wheel/drag, live scrollbar theme and native fullscreen layering" : ""}. Isolated files: ${temp}`)
  }
  async function runRenderingFamily() {
    // Rendering scenarios retain their native advisory/approval lifecycle and
    // independently assert colors, highlighting, scrolling, and remount identity.
    return auto ? runApprovalFamily() : runAdvisoryFamily()
  }
  await runSmokeFamily(descriptor, { approval: runApprovalFamily, advisory: runAdvisoryFamily, rendering: runRenderingFamily })
  audit.verify(plan.reviewKinds, plan.attemptsPerReview + (networkRetry ? 2 : 0))
  assert.equal(metrics.snapshot().counts.byRole.reviewer.requests, audit.snapshot().posts)
  if (measureReuse) assertReviewerReuse(metrics.snapshot())
  if (notificationRecords) {
    if (reminders) {
      const before = (await notificationRecords()).filter(record => record.event === "notification" && record.title.endsWith(" (Reminder)")).length
      await sleep(1500)
      const after = (await notificationRecords()).filter(record => record.event === "notification" && record.title.endsWith(" (Reminder)")).length
      assert.equal(after, before, "native permission resolution must stop reminders")
      if (["auto-unsafe", "auto-error", "auto-cancel"].includes(scenario)) assert.ok(before >= 2, "unresolved manual wait must repeat")
      else assert.equal(before, 0, "automatic approval must suppress reminders even across multiple intervals")
    }
    const successfulAuto = auto && !descriptor.cancel && !visibilityLoss && !descriptor.unsafe && !descriptor.error && scenario !== "auto-manual"
    if (successfulAuto) {
      await until(async () => (await notificationRecords()).some(record => record.event === "sound" && record.kind === "ended"), 10000)
    } else await sleep(500)
    const records = await notificationRecords()
    const banners = records.filter(record => record.event === "notification")
    assert.ok(banners.length, "the real host must emit a notification")
    const countdowns = banners.filter(record => record.title.startsWith("Reviewer will approve permission"))
    assert.equal(countdowns.length, 0, "auto-approval countdowns must not send notifications")
    const approvals = banners.filter(record => record.title === "Reviewer approved a permission")
    const attention = banners.filter(record => record.title === "Session needs attention")
    assert.equal(records.filter(record => record.event === "sound" && record.kind === "approved").length,
      successfulAuto && approvalSound ? plan.reviewKinds.length : 0,
      "only successful automatic approvals with explicitly enabled audio may play approval sounds")
    if (successfulAuto) {
      assert.equal(approvals.length, plan.reviewKinds.length)
      assert.equal(attention.length, 0)
      assert.ok(!records.some(record => record.event === "sound" && record.kind === "attention"), "successful auto-approval must not play attention audio")
      assert.ok(banners.some(record => record.title === "Session ended"))
    } else if (scenario === "auto-unsafe") {
      assert.equal(attention.length, 0); assert.equal(approvals.length, 0)
      assert.equal(banners.filter(record => record.title === "Unsafe permission needs human approval").length, 1)
      assert.ok(records.some(record => record.event === "sound" && record.kind === "unsafe"))
      assert.ok(!records.some(record => record.event === "sound" && record.kind === "attention"))
    } else if (["auto-error", "error", "bash-disabled", "edit-disabled", "external-disabled", "correction"].includes(scenario)) {
      assert.ok(attention.length >= 1); assert.equal(countdowns.length, 0); assert.equal(approvals.length, 0)
    } else if (descriptor.cancel || visibilityLoss) {
      assert.equal(attention.length, 1); assert.equal(approvals.length, 0)
    }
    assertNotificationAudio(assert, records)
    await writeFile(path.join(root, `.runtime/${scenario}-notifications.json`), JSON.stringify(records, null, 2))
    console.log(`PASS ${scenario} notifications: ${banners.map(record => record.title).join("; ")}; configured approval audio and normalized recorded sounds verified.`)
  }
  await assertLegacyUntouched(temp)
  if (["correction", "auto-shell"].includes(scenario)) {
    await until(() => readLifetime(temp).activity.reviews === 1 &&
      (scenario !== "auto-shell" || readLifetime(temp).activity.autoApproved === 1), 5000)
    const totals = readLifetime(temp)
    assert.equal(totals.safe, 1); assert.equal(totals.unsafe, 0)
    assert.equal(totals.activity.retries, correction ? 1 : networkRetry ? 2 : 0)
    assert.equal(totals.requests, (correction ? 2 : 1) + (process.argv.includes("--seed-lifetime") ? 1 : 0))
  }
  outcome = "passed"
} catch (error) {
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  if (tmuxStarted) {
    try {
      screen = tmux("capture-pane", "-p", "-t", "smoke")
      await writeFile(path.join(root, `.runtime/${scenario}-failed.ansi`), tmux("capture-pane", "-p", "-e", "-t", "smoke"))
    } catch { /* Keep request/error diagnostics even if the host exited. */ }
  }
  await writeFile(path.join(root, `.runtime/${scenario}-failed.txt`), `${screen}\n${error.stack}\nIsolated files: ${temp}\n`)
  await writeFile(path.join(root, `.runtime/${scenario}-failed-requests.json`), JSON.stringify(calls, null, 2))
  await writeFile(path.join(root, `.runtime/${scenario}-failed-events.json`), JSON.stringify(events, null, 2))
  console.error(screen)
  console.error(`Isolated diagnostic files: ${temp}`)
  console.error(`Requests received: ${calls.length}`)
  throw error
} finally {
  await runtime.dispose()
  releaseReview = undefined
  for (const listener of [server, reviewerServer]) listener.closeAllConnections()
  await Promise.all([server, reviewerServer].map((listener) => new Promise((resolve) => listener.close(resolve))))
  metrics.mark("fixture-disposed")
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  const measurement = { ...metrics.snapshot(outcome), payloadAudit: audit.snapshot() }
  await writeFile(path.join(root, `.runtime/${scenario}-metrics.json`), JSON.stringify(measurement, null, 2))
  console.log(`METRICS ${scenario}: ${JSON.stringify(measurement.counts)}; .runtime/${scenario}-metrics.json`)
  assert.equal(server.listening, false, "fixture HTTP server must close even after startup failure")
  assert.equal(reviewerServer.listening, false, "reviewer HTTP server must close even after startup failure")
  if (failAfterListen) console.log("PASS post-listen cleanup: fixture HTTP server closed")
}
