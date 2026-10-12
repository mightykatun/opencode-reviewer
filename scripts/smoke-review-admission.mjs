// Real 64-way native tool fanout and bounded reviewer HTTP in the pinned TUI.
// Noncooperative physical settlement is controlled in the source regressions.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-review-admission.mjs")
assert.equal(scenario, "fanout64")
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-admission-")), project = path.join(temp, "project")
const artifacts = path.join(root, ".runtime", "review-admission-" + scenario)
await mkdir(project); await mkdir(path.join(temp, "config")); await mkdir(artifacts, { recursive: true })
execFileSync("git", ["init", "--quiet", project])
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nPath("executions").write_text("unexpected execution")\n')
const bundle = path.join(temp, "bundle.mjs"), plugin = path.join(temp, "plugin.mjs"), records = path.join(temp, "observations.json")
await copyFile(path.join(root, "dist/tui.js"), bundle)
await writeFile(plugin, `
import reviewer from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
export default { id: 'review-admission-fixture', tui: async (api, options) => {
  const data = { asked: [], replies: [], commands: [] };
  const publisher = observationPublisher(${JSON.stringify(records)});
  const save = () => publisher.publish(data);
  for (const [event, key] of [['permission.asked', 'asked'], ['permission.replied', 'replies']])
    api.event.on(event, value => { data[key].push(value.properties); void save(); });
  await reviewer.tui(api, options);
  const off = api.keymap.registerLayer({priority:200, mode:'base', bindings:[
    {key:'f7', cmd:async () => { await api.keymap.dispatchCommand('opencode-reviewer.disable'); data.commands.push('disable'); void save(); }},
    {key:'f8', cmd:async () => { await api.keymap.dispatchCommand('opencode-reviewer.enable'); data.commands.push('enable'); void save(); }}
  ]});
  api.lifecycle.onDispose(async () => { off(); save(); await publisher.close(); });
  await save();
} };
`)

const reviews = [], calls = [], errors = []
let sent = false, releaseAutomatically = false, active = 0, maximum = 0
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      assert.equal(body.stream, false)
      const evidence = JSON.parse(body.messages[1].content)
      active++; maximum = Math.max(maximum, active)
      const entry = { id: evidence.permission.id, closed: false, completed: false, release: () => {
        if (entry.closed || entry.completed) return
        entry.completed = true
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true, desc: "ADMISSION REPORT: harmless isolated fixture." }) }, finish_reason: "stop" }] }))
      } }
      let settled = false
      const finish = () => { if (!settled) { settled = true; active-- }; entry.closed = true }
      res.on("finish", finish); res.on("close", finish)
      reviews.push(entry)
      if (releaseAutomatically) entry.release()
      return
    }
    assert.equal(req.url, "/main/chat/completions")
    const tool = body.tools?.some(item => item.function?.name === "bash") && !sent
    if (tool) sent = true
    const message = tool ? { role: "assistant", tool_calls: Array.from({ length: 64 }, (_, index) => ({
      index, id: `admission_${index}`, type: "function", function: { name: "bash", arguments: JSON.stringify({
        command: `python3 fixture.py ${index}`, description: `Admission fixture ${index}`,
      }) },
    })) } : { role: "assistant", content: "Admission fixture." }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [delta, finish_reason] of [[message, null], [{}, tool ? "tool_calls" : "stop"]])
        res.write(`data: ${JSON.stringify({ id: "admission", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? "tool_calls" : "stop" }] }))
    }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "admission")
const send = (...keys) => runtime.tmux("send-keys", "-t", "admission", ...keys)
const data = () => readObservation(records)
const unchanged = async () => {
  assert.equal(await readFile(path.join(project, "executions"), "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error }), undefined)
  assert.deepEqual((await data()).replies, [])
  assert.ok(maximum <= 4, `reviewer concurrency exceeded four: ${maximum}`)
  assert.deepEqual(errors, [])
}
const until = async (condition, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    assert.deepEqual(errors, [])
    if (await condition(capture())) return
    await sleep(80)
  }
  throw new Error("Admission fixture timed out")
}
const save = name => writeFile(path.join(artifacts, name + ".txt"), capture())
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false, permission: { bash: "ask" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "fixture" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 16000 } } } } } }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ plugin: [[plugin, { baseURL: base + "/review", model: "fixture", notify: false,
    autoApprove: false, stream: false, timeoutMs: 120000 }]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"),
    OPENCODE_TUI_CONFIG: tui, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await runtime.start("-d", "-s", "admission", "-x", "160", "-y", "40", "-c", project, "env",
    ...Object.entries(env).map(([key, value]) => key + "=" + value), host, project, "--prompt", "Prepare the isolated 64-command admission fixture.")
  await until(async screen => (await readObservation(records, { optional: true }))?.asked.length === 64
    && reviews.length >= 4 && screen.includes("Permission analysis"), 90000)
  await sleep(600); await unchanged()
  assert.equal(reviews.length, 4); assert.equal(active, 4)
  const asked = (await data()).asked.toSorted((a, b) => a.id < b.id ? -1 : 1)
  assert.equal(new Set(asked.map(req => req.sessionID)).size, 1)
  assert.ok(reviews.some(review => review.id === asked[0].id), "native-front request is in the first admitted group")
  await save("fanout-held")

  const mainCalls = calls.filter(call => call.url === "/main/chat/completions").length
  send("F7")
  await until(screen => screen.includes("Reviewer disabled for this conversation.") && reviews.every(review => review.closed))
  await sleep(600); await unchanged()
  assert.equal(reviews.length, 4, "sixty waiting requests must not dispatch while disabled")
  assert.equal(active, 0)
  await save("disabled-queue")
  send("F8")
  await until(() => reviews.length >= 8)
  await sleep(600); await unchanged()
  assert.equal(reviews.length, 8); assert.equal(active, 4)
  const resumed = reviews.slice(4).map(review => review.id)
  assert.equal(new Set(resumed).size, 4)
  assert.ok(resumed.includes(asked[0].id), "native-front request is admitted before background work on re-enable")
  assert.ok(resumed.every(id => asked.some(request => request.id === id)))
  for (const old of reviews.slice(0, 4)) old.release()
  const front = reviews.slice(4).find(review => review.id === asked[0].id)
  assert.ok(front); front.release()
  await until(screen => reviews.length === 9 && screen.includes("ADMISSION REPORT"))
  await sleep(600); await unchanged()
  assert.equal(reviews.length, 9, "one settled response hands off exactly one slot")
  assert.ok(!resumed.includes(reviews[8].id), "one slot admits fresh waiting work without re-reviewing a running/completed request")
  await save("native-front-completed")

  releaseAutomatically = true
  for (const review of reviews) review.release()
  await until(() => reviews.length === 68 && reviews.filter(review => review.completed).length === 64 && active === 0, 30000)
  await sleep(600); await unchanged()
  assert.equal(new Set(reviews.slice(4).map(review => review.id)).size, 64)
  assert.equal(calls.filter(call => call.url === "/main/chat/completions").length, mainCalls)
  for (const call of calls.filter(call => call.url === "/main/chat/completions"))
    assert.doesNotMatch(JSON.stringify(call.body.messages), /reviewer-enable|reviewer-disable|Reviewer (?:enabled|disabled) for this conversation\./)
  await save("all-reports-complete")
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ scenario, temp, maximum, reviews, observations: await data(), calls }, null, 2))
  console.log(`PASS review admission ${scenario}: 64 native requests, maximum ${maximum} reviewer HTTP requests, disable/re-enable and one-slot handoff; ${artifacts}`)
} catch (error) {
  await save("failed").catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, temp, maximum, active,
    reviews, errors, observations: await data().catch(() => undefined), calls }, null, 2))
  throw error
} finally {
  await runtime.dispose(); server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
