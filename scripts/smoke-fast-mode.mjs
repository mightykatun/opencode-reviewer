// Real permission writes, streamed reviewer transport and production history.
// Notification clicks use the existing isolated backend, not the desktop bus.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-fast-mode.mjs")
const streaming = scenario !== "nonstream"
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8" }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-fast-mode-")), project = path.join(temp, "project")
const artifacts = path.join(root, ".runtime", "fast-mode-" + scenario)
await mkdir(project); await mkdir(path.join(temp, "config")); await mkdir(artifacts, { recursive: true })
execFileSync("git", ["init", "--quiet", project])
const bundle = path.join(temp, "bundle.mjs"), plugin = path.join(temp, "plugin.mjs"), records = path.join(temp, "observations.json")
await copyFile(path.join(root, "dist/tui.js"), bundle)
await writeFile(plugin, `
import { withNotifications } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
import { createEffect } from 'solid-js';
export default { id: 'fast-mode-fixture', tui: async (api, options) => {
  const data = { asked: [], replies: [], notifications: [], clicks: 0 };
  let click;
  const publisher = observationPublisher(${JSON.stringify(records)});
  const save = () => publisher.publish(data);
  const activate = () => { const event = data.notifications.find(e => e.kind === 'approved');
    if (event) { data.clicks++; click(event.sessionID, event.history); void save(); } };
  createEffect(() => { data.route = api.route.current.name === 'session' ? api.route.current.params.sessionID : undefined; void save(); });
  for (const [type, key] of [['permission.asked', 'asked'], ['permission.replied', 'replies']])
    api.event.on(type, event => { data[key].push(event.properties); void save(); });
  await withNotifications(callback => { click = callback; return {
    show: async event => { data.notifications.push({...event, at: Date.now()}); await save(); return {close() {}}; }, dispose() {}
  }; })(api, options);
  const off = api.keymap.registerLayer({priority: 200, mode: 'base', bindings: [
    {key:'f6', cmd:async () => { data.other ??= (await api.client.session.create({directory:api.state.path.directory, title:'Other fast conversation'}, {throwOnError:true})).data.id;
      api.route.navigate('session', {sessionID:data.other}); void save(); }},
    {key:'f7', cmd:() => api.keymap.dispatchCommand('opencode-reviewer.disable')},
    {key:'f8', cmd:() => api.keymap.dispatchCommand('opencode-reviewer.enable')},
    {key:'f9', cmd:activate}
  ]});
  const offModal = api.keymap.registerLayer({priority:200, mode:'modal', bindings:[{key:'f9', cmd:activate}]});
  api.lifecycle.onDispose(async () => {off(); offModal(); save(); await publisher.close();});
} };
`)
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nimport sys\nwith Path("executions").open("a") as f:\n    f.write(sys.argv[1] + "\\n")\n')
const calls = [], firstBodies = [], secondBodies = [], errors = []
let stage = 0, first, firstClosedEarly = false, db, disabledAt, enabledAt
const stream = (res, desc, safe = true) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ safe, desc }) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
}
const json = (res, desc) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true, desc }) }, finish_reason: "stop" }] })) }
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      assert.equal(body.stream, streaming)
      const isFirst = JSON.stringify(body.messages[1]).includes("fixture.py first")
      const bodies = isFirst ? firstBodies : secondBodies; bodies.push(body)
      if (!isFirst || bodies.length > 1) {
        const desc = isFirst ? "FIRST FAST REPORT corrected" : "SECOND FAST REPORT"
        if (streaming) stream(res, desc, !isFirst); else json(res, desc)
        return
      }
      if (streaming) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders() }
      first = {
        rating: () => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"safe":true,"desc":"FIRST FAST REPORT' }, finish_reason: null }] })}\n\n`),
        finish: () => {
          if (!streaming) { json(res, "FIRST FAST REPORT"); return }
          if (scenario === "error") { res.destroy(); return }
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: scenario === "retry" ? '\",\"extra\":1}' : '\"}' }, finish_reason: null }] })}\n\n`)
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
        },
      }
      res.on("close", () => { if (!res.writableEnded) firstClosedEarly = true })
      return
    }
    const doTool = stage < 2 && body.tools?.some(tool => tool.function?.name === "bash")
    const label = stage === 0 ? "first" : "second"
    if (doTool) stage++
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "fast-" + label, type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "python3 fixture.py " + label, description: "Fast fixture " + label }) } }] }
      : { role: "assistant", content: "Fast fixture complete." }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[message, null], [{}, doTool ? "tool_calls" : "stop"]])
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "fast")
const send = (...keys) => runtime.tmux("send-keys", "-t", "fast", ...keys)
const data = () => readObservation(records)
const executed = async () => (await readFile(path.join(project, "executions"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
const saved = () => {
  db ??= new DatabaseSync(path.join(temp, "state/opencode/opencode-reviewer/history-v1.sqlite"), { readOnly: true })
  return db.prepare("SELECT h.permission,h.outcome,p.body FROM history h JOIN payloads p ON p.id=h.id ORDER BY h.completed,h.tie,h.id").all()
    .map(row => ({ ...row, payload: JSON.parse(row.body) }))
}
const until = async (check, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check(capture())) return; await sleep(80) }
  throw Error("Fast fixture timed out")
}
const save = name => writeFile(path.join(artifacts, name + ".txt"), capture())
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false, permission: { bash: "ask" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "synthetic" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } } }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ plugin: [[plugin, { baseURL: base + "/review", model: "fixture", autoApprove: true,
    fastMode: true, stream: streaming, autoApproveDelaySeconds: 45, timeoutMs: 120000, staleReminderSeconds: 0 }]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await runtime.start("-d", "-s", "fast", "-x", "160", "-y", "40", "-c", project, "env",
    ...Object.entries(env).map(([k, v]) => k + "=" + v), host, project, "--prompt", "Run both isolated fast-mode fixture steps.")
  await until(s => first && s.includes("Permission analysis") && s.includes("Permission required"), 90000)
  if (streaming) {
    if (scenario === "hidden") { send("C-x", "b"); await until(s => !s.includes("Permission analysis")) }
    if (scenario === "dialog") { send("C-p"); await until(s => s.includes("Commands")) }
    first.rating()
    if (["hidden", "dialog"].includes(scenario)) {
      await sleep(600); assert.deepEqual(await executed(), [])
      if (scenario === "hidden") send("C-x", "b"); else send("Escape")
    }
    await until(async s => (await executed()).includes("first") && s.includes("Auto-approved; finishing report"), 15000)
    await until(async () => (await data()).notifications.some(e => e.kind === "approved"))
    await until(async () => (await data()).asked.length === 2 && secondBodies.length === 1)
    assert.deepEqual(await executed(), ["first"])
    assert.equal(firstClosedEarly, false, "native resolution must not cancel the unfinished response")
    assert.equal(saved().length, 0, "partial report stays memory-only")
    assert.ok((await data()).notifications.every(e => !["attention", "unsafe"].includes(e.kind)))
    assert.doesNotMatch(capture(), /Allowed in|SECOND FAST REPORT/)
    await save("approved-live")
    send("C-x", "b"); await until(s => !s.includes("Permission analysis"))
    send("F6"); await until(async () => { const d = await data(); return d.other && d.route === d.other })
    send("F9"); await until(s => s.includes("FIRST FAST REPORT") && s.includes("Auto-approved; finishing report"))
    assert.doesNotMatch(capture(), /Analysis history/); await save("notification-live")
    disabledAt = Date.now(); send("F7"); await until(s => s.includes("Reviewer disabled for this conversation."))
    assert.match(capture(), /Auto-approved; finishing report/)
    send("C-p"); await until(s => s.includes("Commands")); send("F9")
    await until(async () => (await data()).clicks === 2)
    first.finish()
    if (scenario !== "error") await until(() => saved().some(row => row.payload.desc.startsWith("FIRST FAST REPORT")))
    else await sleep(500)
    send("Escape")
    if (scenario !== "error") {
      await until(s => s.includes("Analysis history") && s.includes("FIRST FAST REPORT"))
      assert.equal(saved()[0].payload.safe, scenario !== "retry")
      await save("notification-finished-during-dialog")
      enabledAt = Date.now(); send("F8"); await until(s => s.includes("Reviewer enabled for this conversation."))
      await until(() => secondBodies.length >= 2)
      await sleep(350); assert.deepEqual(await executed(), ["first"], "fast approval needs physical visibility, not history cover")
      send("Escape")
    } else {
      await sleep(5300); assert.doesNotMatch(capture(), /Analysis history|FIRST FAST REPORT/)
      enabledAt = Date.now(); send("F8"); await until(s => s.includes("Reviewer enabled for this conversation."))
    }
  } else {
    await sleep(500); assert.deepEqual(await executed(), [])
    first.finish()
  }
  await until(async () => (await executed()).length === 2, 15000)
  await until(s => s.includes("Fast fixture complete.") && !s.includes("Permission analysis"))
  await until(() => saved().length === (scenario === "error" ? 1 : 2))
  await until(async () => (await data()).notifications.filter(e => e.kind === "approved").length === 2)
  await until(async () => (await data()).notifications.some(e => e.kind === "ended"))
  const snapshot = await data(), callsBefore = calls.length
  assert.ok(snapshot.notifications.every(e => e.kind !== "unsafe" && (e.kind !== "attention"
    || (e.at >= disabledAt && e.at <= enabledAt))), "only explicitly disabled pending work may send attention")
  send("F9")
  if (scenario === "error") { await sleep(5300); assert.doesNotMatch(capture(), /Analysis history|SECOND FAST REPORT/) }
  else await until(s => s.includes("Analysis history") && s.includes("FIRST FAST REPORT") && s.includes("1/2"))
  assert.equal(calls.length, callsBefore)
  assert.deepEqual((await data()).replies.map(r => r.reply), ["once", "once"])
  assert.deepEqual(await executed(), ["first", "second"])
  assert.equal(firstBodies.length, scenario === "retry" ? 2 : 1)
  if (scenario === "retry") assert.deepEqual(firstBodies[1].messages.slice(0, firstBodies[0].messages.length), firstBodies[0].messages)
  assert.deepEqual(errors, [])
  await save("final")
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ scenario, temp, ...await data(), history: saved(), calls }, null, 2))
  console.log(`PASS fast-mode ${scenario}: early once-only approval, retained response, correct notification target and history; ${artifacts}`)
} catch (error) {
  await save("failed").catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, temp, errors,
    observations: await data().catch(() => null), calls }, null, 2))
  throw error
} finally {
  db?.close(); await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
