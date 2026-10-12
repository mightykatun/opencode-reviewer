// Real OpenCode TUI, native MCP/custom tools and deterministic local model responses.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { smokeMetrics, smokeRuntime } from "./smoke-runtime.mjs"
import { reviewerAudit, sendReviewStream } from "./smoke-reviewer.mjs"
import { permissionStagePlan, runPermissionStages } from "./smoke-stages.mjs"
import { notificationRecorder, assertNotificationAudio } from "./smoke-notification-recorder.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { activatePalette } from "./smoke-ui.mjs"

const root = path.resolve(import.meta.dirname, "..")
const { scenario } = runtimeArguments("smoke-permissions.mjs")
const flag = (name) => process.argv.includes(`--${name}`)
const auto = flag("auto"), disabled = flag("disabled"), correction = flag("correction")
const plan = permissionStagePlan(scenario, { auto, disabled, correction, held: flag("held"), cancel: flag("cancel"),
  unsafe: flag("unsafe"), error: flag("error"), nativeBashEnabled: flag("native-bash-enabled") })
if (flag("plan")) { console.log(JSON.stringify(plan, null, 2)); process.exit(0) }
const { seedLifetime, readLifetime, assertLegacyUntouched } = await import("./smoke-lifetime.mjs")
const hostBinary = process.env.OPENCODE_BIN ?? "opencode"
const hostVersion = execFileSync(hostBinary, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
const stream = flag("stream")
const approvalSound = flag("approval-sound")
const notificationOptions = { notify: flag("notifications"),
  ...(approvalSound ? { notifications: { approved: { sound: true } } } : {}) }
const mcp = scenario.startsWith("mcp"), custom = scenario.startsWith("custom"), directory = scenario.startsWith("external-")
const patch = scenario === "external-patch"
const fixtureModel = patch ? "gpt-fixture" : "fixture"
const mcpName = flag("resource-whitespace") ? " fixture " : "fixture"
const resourceURI = flag("resource-whitespace") ? " fixture://remote/item " : "fixture://remote/item"
const tag = [scenario, ...process.argv.slice(3).map((arg) => arg.replace(/^--/, ""))].join("-")
const temp = await mkdtemp(path.join(tmpdir(), "review-permissions-"))
const project = path.join(temp, "project"), outside = path.join(temp, "outside")
await mkdir(project); await mkdir(outside); await mkdir(path.join(temp, "config/tools"), { recursive: true })
execFileSync("git", ["init", "--quiet", project])
const target = path.join(outside, "note.txt")
await writeFile(target, "before fixture\n")
const plugin = path.join(temp, "reviewer.mjs")
await copyFile(path.join(root, "dist/tui.js"), plugin)
const notificationRecords = flag("notifications") ? await notificationRecorder(plugin, temp) : undefined
const tool = scenario === "mcp" ? "fixture_inspect" : scenario === "mcp-resource" ? "read_mcp_resource"
  : custom ? "local_demo" : patch ? "apply_patch" : scenario === "external-search" ? "grep" : scenario === "external-edit" ? "edit" : "read"
const input = scenario === "mcp" ? { target: "fixture://remote/item" } : scenario === "mcp-resource" ? { server: mcpName, uri: resourceURI }
  : custom ? { target: "isolated fixture" } : patch ? { patchText: `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch` }
  : scenario === "external-search" ? { path: outside, pattern: "fixture" }
  : scenario === "external-edit" ? { filePath: target, oldString: "before fixture", newString: "after fixture" } : { filePath: target }
const customPermission = scenario === "custom-bash" ? "bash" : "fixture_allowance"
if (custom) await writeFile(path.join(temp, "config/tools/local_demo.ts"), `
import { appendFile } from "node:fs/promises"
export default {
  description: "Append one line to the isolated fixture log after requesting permission.",
  args: { target: { type: "string", description: "Fixture target" } },
  async execute(args, context) {
    await appendFile(${JSON.stringify(path.join(project, "before-permission"))}, "entered\\n")
    await context.ask({ permission: ${JSON.stringify(customPermission)}, patterns: ["fixture-target"], always: ["*"], metadata: { operation: "append fixture log", target: args.target } })
    await appendFile(${JSON.stringify(path.join(project, "executions"))}, "executed\\n")
    return "Fixture custom operation completed."
  }
}
`)

await seedLifetime(temp, { usage: { input: 100, output: 20, cost: 0.01 }, storageError: flag("storage-error") })

const requests = [], rpc = [], perRequest = new Map()
const fixtureErrors = [], terminalAttempts = []
const audit = reviewerAudit({ stream })
let sent = false, completed = false, executions = 0, release
const prompt = `Perform the isolated ${scenario} fixture operation once.`
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/mcp" && req.method !== "POST") { res.writeHead(405); res.end(); return }
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    if (req.url === "/mcp") {
      rpc.push(body)
      if (body.id === undefined) { res.writeHead(202); res.end(); return }
      let result
      if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } }
      else if (body.method === "tools/list") result = { tools: [{ name: "inspect", description: "Read an isolated fixture item", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } }] }
      else if (body.method === "resources/list") result = { resources: [{ name: "Fixture item", uri: resourceURI, mimeType: "text/plain" }] }
      else if (body.method === "resources/templates/list") result = { resourceTemplates: [] }
      else if (body.method === "tools/call" || body.method === "resources/read") {
        executions++
        result = body.method === "tools/call" ? { content: [{ type: "text", text: "Remote fixture result" }] }
          : { contents: [{ uri: body.params.uri, text: "Remote fixture result", mimeType: "text/plain" }] }
      } else throw new Error(`Unexpected MCP method ${body.method}`)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); return
    }
    requests.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      const previousNotifications = notificationRecords ? (await notificationRecords()).filter(r => r.event === "notification").length : 0
      const observation = audit.request(req.method, text)
      assert.equal(body.messages[0].content.includes("Take extra care"), auto && !flag("no-extra-careful"),
        "extra-careful guidance follows its switch independently of auto-approval")
      const evidence = JSON.parse(body.messages[1].content)
      const attempt = (perRequest.get(evidence.permission.id) ?? 0) + 1
      perRequest.set(evidence.permission.id, attempt)
      if (flag("held") && requests.filter((entry) => entry.url.startsWith("/review")).length === 1) await new Promise((resolve) => { release = resolve })
      if (flag("error")) { res.writeHead(401); res.end("PRIVATE fixture error"); return }
      const content = correction && attempt === 1 ? "bad JSON" : JSON.stringify({ safe: !flag("unsafe"),
        desc: stream ? "Bounded **isolated** fixture operation.\n\nOnly the current allowance is assessed. Café fixture." : "Bounded isolated fixture operation. Only the current allowance is assessed." })
      const usage = !flag("no-usage") && !(flag("missing-usage") && attempt === 1)
        ? { prompt_tokens: 100, completion_tokens: 20,
          ...(stream ? { prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 } } : {}) } : undefined
      if (stream) {
        await sendReviewStream(res, { content, usage, observation,
          phase: (event) => metrics.mark(event, reviews().length),
          beforeTerminal: async () => {
            if (notificationRecords && scenario === "mcp") assert.equal(
              (await notificationRecords()).filter(r => r.event === "notification").length, previousNotifications,
              "streamed previews and corrections must not emit attention/countdown notifications before terminal validation")
            if (mcp) assert.equal(executions, 0, "MCP cannot execute before terminal review completion")
            if (custom) await assert.rejects(readFile(path.join(project, "executions")))
            if (directory) assert.equal(await readFile(target, "utf8"), "before fixture\n", "directory/edit/patch cannot modify the target from a preview")
            assert.doesNotMatch(capture().split("\n").map((line) => line.slice(118)).join("\n"), /Allowed in|Checking…|Allowing…/,
              "full JSON, stop and usage frames must not start auto-approval before DONE/EOF")
          },
        })
      } else {
        observation.usage(usage)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ model: "review", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], ...(usage ? { usage } : {}) }))
      }
      observation.response(content, correction && attempt === 1)
      terminalAttempts.push(reviews().length)
      return
    }
    if (body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_fixture")) completed = true
    const use = !sent && body.tools?.some((entry) => entry.function?.name === tool)
    if (use) sent = true
    const delta = use ? { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: tool, arguments: JSON.stringify(input) } }] }
      : { role: "assistant", content: "Fixture complete." }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [chunk, finish_reason] of [[delta, null], [{}, use ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: chunk, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "fixture", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: delta, finish_reason: use ? "tool_calls" : "stop" }] }))
    }
  } catch (error) {
    fixtureErrors.push(String(error))
    if (res.headersSent) res.destroy()
    else { res.writeHead(500); res.end(String(error)) }
  }
})
const metrics = smokeMetrics(server, { pollIntervalMs: 80, hostVersion })
let outcome = "failed"
const runtime = await smokeRuntime(temp)
const tmux = runtime.tmux
let screen = "", started = false
let lastCountdown
const capture = () => tmux("capture-pane", "-p", "-t", "smoke")
const until = async (check, ms = 90000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { await sleep(80); screen = capture(); if (await check(screen)) return }
  throw new Error(`Timed out waiting for ${tag}`)
}
const reviews = () => requests.filter((entry) => entry.url === "/review/chat/completions")
const save = async (name) => {
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  await writeFile(path.join(root, `.runtime/permission-${tag}-${name}.txt`), capture())
  await writeFile(path.join(root, `.runtime/permission-${tag}-${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "smoke"))
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const config = { model: `fixture/${fixtureModel}`, small_model: `fixture/${fixtureModel}`, autoupdate: false,
    permission: { bash: "ask", edit: patch ? "allow" : "ask", read: "allow", grep: "allow", external_directory: "ask", fixture_inspect: "ask", fixture_allowance: "ask" },
    ...(mcp ? { mcp: { [mcpName]: { type: "remote", url: `http://127.0.0.1:${port}/mcp`, oauth: false } } } : {}),
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/main`, apiKey: "fixture" }, models: { [fixtureModel]: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } },
  }
  if (scenario === "mcp-resource") config.permission.read = "ask"
  if (!flag("unpriced")) config.provider.review = { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/review` },
    models: { review: { name: "Review", limit: { context: 32000, output: 1000 }, cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } } } }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ theme: "opencode", plugin: [[plugin, { ...notificationOptions, baseURL: `http://127.0.0.1:${port}/review`, model: "review",
    ...plan.settings, autoApprove: auto, ...(flag("no-extra-careful") ? { extraCareful: false } : {}), autoApproveDelaySeconds: 2, stream }]] }))
  const env = { HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"), XDG_STATE_HOME: path.join(temp, "state"), XDG_CACHE_HOME: path.join(temp, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  metrics.mark("tmux-start-dispatched")
  await runtime.start("-d", "-s", "smoke", "-x", "160", "-y", "40", "-c", project, "env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), hostBinary, project, "--prompt", prompt)
  metrics.mark("tmux-start-acknowledged")
  started = true
  const expected = flag("error") ? "Analysis unavailable" : flag("unsafe") ? "✗ Unsafe" : "✓ Safe"
  const callsFor = (stage) => reviews().filter((entry) => JSON.parse(entry.body.messages[1].content).kind === stage.kind)
  const unchanged = async () => {
    assert.equal(executions, 0)
    if (custom) {
      assert.match(await readFile(path.join(project, "before-permission"), "utf8"), /entered/)
      await assert.rejects(readFile(path.join(project, "executions")))
    }
    if (directory) assert.equal(await readFile(target, "utf8"), "before fixture\n")
  }
  await runPermissionStages(plan, {
    pending: async (stage, index) => {
      await until((s) => s.includes("Permission required") && (!stage.reviewed || callsFor(stage).length > 0))
      if (index > 0 && lastCountdown) assert.ok(Date.now() - lastCountdown >= 1750, "each preceding directory countdown must finish before the edit review")
      metrics.mark("native-permission-visible", reviews().length)
      await unchanged()
    },
    held: async () => {
      await until((s) => !!release && s.includes("Permission analysis") && /[■⬝]{8}|\[⋯\]/.test(s))
      if (flag("stats")) assert.doesNotMatch(screen, /token:|lifetime:/, "loading must not show historical lifetime by itself")
      await save("loading")
      metrics.mark("held-review-released", reviews().length)
      release()
      release = undefined
    },
    hidden: async () => {
      const before = reviews().length
      await sleep(2500)
      assert.equal(reviews().length, before, "a disabled native stage must not start a review")
      assert.doesNotMatch(capture(), /Permission analysis/)
    },
    assessment: async (stage) => {
      await until((s) => s.includes(expected) && callsFor(stage).length === stage.attempts && (!stream || flag("error") || terminalAttempts.length === reviews().length))
      metrics.mark("review-visible", reviews().length)
      const stageCalls = callsFor(stage)
      const evidence = JSON.parse(stageCalls[0].body.messages[1].content)
      assert.equal(evidence.kind, stage.kind)
      assert.equal(evidence.tool, tool)
      assert.equal(evidence.userPrompt, prompt)
      assert.equal(evidence.location.instanceDirectory, project)
      assert.equal(evidence.permission.tool.callID, "call_fixture")
      assert.equal(evidence.permission.type, stage.permission)
      if (stage.kind === "edit") {
        assert.equal(evidence.changes[0].path, target)
        assert.match(evidence.changes[0].diff, /-before fixture\n\+after fixture/)
      } else if (!directory) assert.deepEqual(evidence.input, input)
      else assert.deepEqual(evidence.permission.patterns, [`${outside}/*`])
      if (patch) {
        assert.deepEqual(evidence.operation.patchOperations, [{ operation: "delete", path: target }])
        assert.deepEqual(evidence.operation.input, {})
        assert.equal(evidence.partial, true)
        assert.doesNotMatch(JSON.stringify(evidence), /before fixture|patchText/)
      }
      if (mcp) {
        assert.equal(evidence.origin.server, mcpName)
        assert.equal(evidence.definition.status, "unavailable")
        assert.equal(rpc.filter((entry) => ["tools/call", "resources/read"].includes(entry.method)).length, 0)
        if (scenario === "mcp-resource") {
          assert.deepEqual(evidence.permission.metadata, { server: mcpName, uri: resourceURI })
          assert.deepEqual(evidence.permission.patterns, [`mcp:${mcpName}:${resourceURI}`])
          assert.deepEqual(evidence.permission.always, [`mcp:${mcpName}:*`])
        }
      }
      if (custom) assert.equal(evidence.definition.status, "included")
      assert.doesNotMatch(JSON.stringify(evidence), /autoApprove|countdown/)
      if (correction && !flag("error")) {
        assert.equal(stageCalls.length, 2)
        assert.match(stageCalls[1].body.messages[3].content, /Format validation failed/)
      }
      if (flag("stats")) {
        const missing = flag("no-usage") || flag("error") || flag("missing-usage")
        if (missing) {
          assert.doesNotMatch(capture(), /token:|lifetime:/, "invalid/missing request usage must hide the entire stats block")
        } else {
          const attempts = stage.attempts
          await until((s) => s.includes(`token: ${100 * attempts} in ${20 * attempts} out`) && s.includes("lifetime:"), 5000)
          const rows = screen.split("\n").map((line) => line.slice(118).trim())
          const first = rows.findIndex((line) => line.startsWith("token:"))
          assert.ok(first >= 0)
          if (flag("unpriced")) {
            assert.match(rows[first + 1], /^lifetime:/)
            assert.doesNotMatch(rows.join("\n"), /^cost:/m)
            assert.match(rows.join("\n"), /partial pricing/)
          } else {
            assert.match(rows[first + 1], /^cost: \$/)
            assert.match(rows[first + 2], flag("storage-error") ? /^lifetime: usage unavailable$/ : /^lifetime: \$/)
          }
        }
      }
    },
    capture: async (_, index) => save(index === 0 ? "pending" : "edit-pending"),
    countdown: async () => {
      await until((s) => s.includes("Allowed in 2s"))
      assert.equal(terminalAttempts.length, reviews().length, "all format attempts must finish before countdown")
      metrics.mark("countdown-visible", reviews().length)
      lastCountdown = Date.now()
      await unchanged()
    },
    cancel: async () => {
      const lines = screen.split("\n"), row = lines.findIndex((line) => line.includes("Allowed in")), x = lines[row].indexOf("Cancel") + 2
      for (const suffix of ["M", "m"]) tmux("send-keys", "-t", "smoke", "-l", `\x1b[<0;${x};${row + 1}${suffix}`)
      await until((s) => s.includes("Auto-approval canceled"), 3000)
      await sleep(2500)
      assert.match(capture(), /Permission required/)
      await unchanged()
    },
    manual: async (stage) => {
      if (stage.reviewed && stage.action === "manual") await sleep(2500)
      assert.match(capture(), /Permission required/)
      assert.doesNotMatch(capture(), /Allowed in/)
      tmux("send-keys", "-t", "smoke", "Enter")
    },
  })
  await until(() => completed, 15000)
  if (lastCountdown && !flag("cancel")) assert.ok(Date.now() - lastCountdown >= 1750, "each request needs a full visible countdown")
  await until((s) => !s.includes("Permission required") && !s.includes("Permission analysis"), 5000)
  metrics.mark("permission-and-panel-resolved", reviews().length)
  if (mcp) assert.equal(executions, 1)
  if (scenario === "mcp-resource") assert.equal(rpc.find(entry => entry.method === "resources/read").params.uri, resourceURI)
  if (custom) assert.equal(await readFile(path.join(project, "executions"), "utf8"), "executed\n")
  if (patch) {
    await assert.rejects(readFile(target), { code: "ENOENT" })
    if (!disabled) {
      assert.equal(perRequest.size, 1, "directory approval alone resumes the already-allowed patch")
      assert.ok(reviews().every(entry => JSON.parse(entry.body.messages[1].content).kind === "external-directory"))
    }
  }
  if (scenario === "external-edit") {
    assert.equal(await readFile(target, "utf8"), "after fixture\n")
    const stages = new Map(reviews().map((entry) => { const e = JSON.parse(entry.body.messages[1].content); return [e.permission.id, e.kind] }))
    assert.deepEqual([...stages.values()], plan.reviewKinds)
  }
  if (scenario === "external-read" || scenario === "external-search") {
    const outputs = requests.filter((entry) => entry.url.startsWith("/main")).flatMap((entry) => entry.body.messages)
      .filter((message) => message.role === "tool" && message.tool_call_id === "call_fixture")
    assert.match(JSON.stringify(outputs), /before fixture/, "native access actually returned the fixture contents")
  }
  for (const entry of requests.filter((entry) => entry.url.startsWith("/main"))) assert.doesNotMatch(JSON.stringify(entry.body.messages), /Take extra care|Permission analysis|Allowed in|countdown/)
  if (flag("stats")) {
    const recorded = flag("no-usage") || flag("error") ? 0 : [...perRequest.values()].reduce((sum, attempts) => sum + attempts - (flag("missing-usage") ? 1 : 0), 0)
    const rated = flag("error") ? 0 : perRequest.size
    const approved = auto && !flag("unsafe") && !flag("error") && !flag("cancel") ? plan.reviewKinds.length : 0
    await activatePalette({ send: (...keys) => tmux("send-keys", "-t", "smoke", ...keys),
      capture: () => tmux("capture-pane", "-p", "-e", "-t", "smoke") }, "Reviewer: Statistics", s => s.includes("Reviewer statistics"))
    await until((s) => s.includes("Reviewer statistics") && s.includes(flag("storage-error") ? "Lifetime usage unavailable" : `Auto-approved: ${approved} (`), 5000)
    if (!flag("storage-error")) {
      // The SQL seed contributes one received POST and $0.01; legacy 999 seeds are excluded.
      // Missing usage contributes nothing; unpriced usage retains its token counts.
      const total = 1 + recorded, priced = 1 + (flag("unpriced") ? 0 : recorded)
      const cost = (0.01 + (flag("unpriced") ? 0 : recorded * (stream ? 0.000115 : 0.00014))).toFixed(4)
      assert.equal(screen.match(/Tokens: \d+ in \d+ out(?: \(partial coverage\))?/)?.[0], `Tokens: ${100 * total} in ${20 * total} out`)
      assert.equal(screen.match(/Cost: \$\d+\.\d{4}(?: \(partial pricing\))?/)?.[0], `Cost: $${cost}${priced < total ? " (partial pricing)" : ""}`)
      const retries = [...perRequest.values()].reduce((sum, attempts) => sum + attempts - 1, 0)
      assert.equal(screen.match(/Retries: \d+(?: \(partial history\))?/)?.[0], `Retries: ${retries}`)
      assert.doesNotMatch(screen, /partial history/)
      const saved = readLifetime(temp)
      assert.equal(saved.requests, total)
      assert.equal(saved.activity.usageRequests, total)
      assert.equal(saved.activity.retries, retries)
      assert.equal(saved.activity.autoApproved, approved)
      assert.equal(saved.cost.toFixed(4), cost)
      if (!flag("cancel")) {
        assert.equal(screen.match(/Reviews: \d+/)?.[0], `Reviews: ${rated}`)
        const percentage = count => rated ? `${(count / rated * 100).toFixed(1)}%` : "n/a"
        for (const [label, count] of [["Safe", flag("unsafe") ? 0 : rated], ["Unsafe", flag("unsafe") ? rated : 0], ["Auto-approved", approved]]) {
          assert.ok(screen.includes(`${label}: ${count} (${percentage(count)})`))
        }
        if (rated) {
          const full = screen.match(/Average time to full report: (\d+\.\d+)s/)?.[1]
          const rating = screen.match(/Average time to rating: (\d+\.\d+)s/)?.[1]
          assert.ok(full !== undefined && rating !== undefined && Number(full) >= Number(rating))
          if (stream) assert.ok(Number(full) > Number(rating), "streamed rating precedes the full report")
          else assert.equal(full, rating)
        } else assert.match(screen, /Average time to full report: unavailable/)
      }
    }
    assert.doesNotMatch(screen, /Permission analysis/)
    await save("lifetime-dialog")
    tmux("send-keys", "-t", "smoke", "Escape")
  }
  await save("resolved")
  await assertLegacyUntouched(temp)
  assert.deepEqual(fixtureErrors, [], "fixture transport and pre-terminal assertions must succeed")
  audit.verify(plan.reviewKinds, plan.attemptsPerReview)
  assert.equal(metrics.snapshot().counts.byRole.reviewer.requests, audit.snapshot().posts)
  await writeFile(path.join(root, `.runtime/permission-${tag}-requests.json`), JSON.stringify({ requests, rpc }, null, 2))
  if (notificationRecords) {
    await sleep(500)
    const records = await notificationRecords()
    const banners = records.filter(record => record.event === "notification")
    assert.ok(banners.length)
    assert.ok(banners.every(record => record.summary.startsWith("Opencode (") && record.summary.endsWith(")")))
    assert.equal(banners.filter(record => record.title.startsWith("Reviewer will approve permission")).length, 0)
    const approved = auto && !flag("unsafe") && !flag("error") && !flag("cancel") ? plan.reviewKinds.length : 0
    assert.equal(banners.filter(record => record.title === "Reviewer approved a permission").length, approved,
      "only successful automatic approvals emit the enabled approval banner")
    assert.equal(records.filter(record => record.event === "sound" && record.kind === "approved").length,
      approvalSound ? approved : 0, "approval audio follows the explicit sound setting; its default is silent")
    assertNotificationAudio(assert, records)
    await writeFile(path.join(root, `.runtime/permission-${tag}-notifications.json`), JSON.stringify(records, null, 2))
    console.log(`PASS ${tag} notifications: ${banners.map(record => record.title).join("; ")}`)
  }
  console.log(`PASS ${tag}: real native ${tool}, correct evidence/prompt routing, ${reviews().length} reviewer attempts, once-only fixture completion and panel cleanup. ${temp}`)
  outcome = "passed"
} catch (error) {
  if (started) { try { await save("failed") } catch {} }
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  await writeFile(path.join(root, `.runtime/permission-${tag}-failed.json`), JSON.stringify({ requests, rpc, temp, error: String(error) }, null, 2))
  console.error(screen, temp)
  throw error
} finally {
  release?.()
  await runtime.dispose()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  metrics.mark("fixture-disposed")
  await mkdir(path.join(root, ".runtime"), { recursive: true })
  const measurement = { ...metrics.snapshot(outcome), payloadAudit: audit.snapshot() }
  await writeFile(path.join(root, `.runtime/permission-${tag}-metrics.json`), JSON.stringify(measurement, null, 2))
  console.log(`METRICS ${tag}: ${JSON.stringify(measurement.counts)}; .runtime/permission-${tag}-metrics.json`)
}
