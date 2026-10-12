// Native skill loading and real task/resume delegation against the built plugin.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, copyFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-skills.mjs")
const subagent = scenario === "subagent" || scenario === "subagent-view"
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8" }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-skills-")), project = path.join(temp, "project")
const skills = path.join(temp, "skills"), skillDir = path.join(skills, "fixture-skill")
const artifacts = path.join(root, ".runtime", "skills-" + scenario)
await mkdir(project); await mkdir(path.join(temp, "config")); await mkdir(artifacts, { recursive: true })
await mkdir(path.join(skillDir, "scripts"), { recursive: true }); await mkdir(path.join(skillDir, "docs"))
execFileSync("git", ["init", "--quiet", project])
const skillText = "# Fixture inspection\n\nUse only for inspecting the fixture project. Read [context](docs/context.md) and `scripts/check.py`. Loading this skill must not execute those scripts.\n"
await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: Inspect the fixture project\n---\n\n" + skillText)
await writeFile(path.join(skillDir, "scripts/check.py"), `# SUPPORTING_SCRIPT_TEXT\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(project, "support-executed"))}).write_text("must not execute")\n`)
await writeFile(path.join(skillDir, "docs/context.md"), "SUPPORTING_CONTEXT_TEXT\nSee [nested](nested.md).")
await writeFile(path.join(skillDir, "docs/nested.md"), "NESTED_REFERENCE_MUST_NOT_BE_READ")
await writeFile(path.join(project, "marker.py"), 'from pathlib import Path\nPath("delegated-executed").write_text("done")\nprint("Delegated fixture complete")\n')
const bundle = path.join(temp, "bundle.mjs"), plugin = path.join(temp, "plugin.mjs"), recordFile = path.join(temp, "observations.json")
await writeFile(recordFile, JSON.stringify({ asked: [], replies: [], children: [] }))
await copyFile(path.join(root, "dist/tui.js"), bundle)
await writeFile(plugin, `
import plugin, { withHistoryObservations } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { createEffect } from 'solid-js';
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
export default {id:'skill-fixture', tui:async (api, options) => {
  const data = {asked:[], replies:[], children:[], renders:[]};
  const publisher = observationPublisher(${JSON.stringify(recordFile)});
  const save = () => publisher.publish(data);
  api.event.on('permission.asked', event => {data.asked.push(event.properties); void save();});
  api.event.on('permission.replied', event => {data.replies.push(event.properties); void save();});
  createEffect(() => { data.route = api.route.current.params?.sessionID; void save(); });
  api.event.on('session.created', event => {if(event.properties.info.parentID) {
    data.children.push(event.properties.info);
    if (${scenario === "subagent-view"}) api.route.navigate('session', {sessionID:event.properties.info.id});
    void save();
  }});
  const run = ${scenario === "subagent-view"} ? withHistoryObservations(event => {
    if (event.stage === 'frame' && event.auto === 'countdown') {data.renders.push({...event, route:data.route}); void save();}
  }) : plugin.tui;
  await run(api, options); void save(); api.lifecycle.onDispose(async () => {save(); await publisher.close();});
} };
`)
const userPrompt = "Inspect the fixture project using its fixture skill, and run marker.py when delegated."
const firstPrompt = "DELEGATION FIRST: Load fixture-skill for the fixture project. Do not run its supporting scripts."
const latestPrompt = "DELEGATION LATEST: Run python3 marker.py to inspect the fixture output."
const calls = [], reviews = [], errors = []
let rootStep = 0, skillSent = false, bashSent = false, loaded = false, held, db
const records = () => readObservation(recordFile)
const stream = (res, message, toolCall = false) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  for (const [delta, finish_reason] of [[message, null], [{}, toolCall ? "tool_calls" : "stop"]])
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  res.end("data: [DONE]\n\n")
}
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      const evidence = JSON.parse(body.messages[1].content); reviews.push(evidence)
      assert.equal(evidence.userPrompt, userPrompt)
      if (subagent) assert.equal(evidence.delegation.prompt, evidence.kind === "skill" ? firstPrompt : latestPrompt)
      else assert.equal(evidence.delegation, undefined)
      if (evidence.kind === "skill") {
        assert.equal(evidence.skill.name, "fixture-skill"); assert.equal(evidence.skill.content.trim(), skillText.trim())
        assert.equal(evidence.skill.location, path.join(skillDir, "SKILL.md"))
        assert.deepEqual(evidence.files.map(file => file.filename), ["docs/context.md", "scripts/check.py"])
        assert.match(evidence.files[0].contents, /SUPPORTING_CONTEXT_TEXT/); assert.match(evidence.files[1].contents, /SUPPORTING_SCRIPT_TEXT/)
        assert.doesNotMatch(JSON.stringify(evidence), /NESTED_REFERENCE_MUST_NOT_BE_READ/)
        assert.match(body.messages[0].content, /BOTH routine, bounded risk AND clear relevance/)
        assert.equal(loaded, false)
      }
      const content = JSON.stringify({ safe: scenario !== "unsafe", desc: scenario === "unsafe" ? "The skill is not relevant to the requested work." : "Fixture skill and delegated work are relevant and bounded." })
      if (scenario === "fast") {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"safe":true,' }, finish_reason: null }] })}\n\n`)
        held = () => res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '"desc":"Fast skill report complete"}' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      } else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] })) }
      return
    }
    if (body.messages.some(m => m.role === "tool" && JSON.stringify(m.content).includes("<skill_content"))) loaded = true
    const latest = JSON.stringify(body.messages.filter(m => m.role === "user").at(-1)?.content)
    const tools = body.tools?.map(t => t.function.name) ?? []
    let tool, input
    if (subagent && tools.length) {
      if (latest.includes("DELEGATION FIRST")) {
        if (!skillSent) { skillSent = true; tool = "skill"; input = { name: "fixture-skill" } }
      } else if (latest.includes("DELEGATION LATEST")) {
        if (!bashSent) { bashSent = true; tool = "bash"; input = { command: "python3 marker.py", description: "Delegated fixture" } }
      } else if (rootStep < 2) {
        input = { description: "Fixture inspection", prompt: rootStep === 0 ? firstPrompt : latestPrompt, subagent_type: "general" }
        if (rootStep === 1) input.task_id = (await records()).children[0].id
        rootStep++; tool = "task"
      }
    } else if (!subagent && tools.includes("skill") && !skillSent) {
      skillSent = true; tool = "skill"; input = { name: "fixture-skill" }
    }
    stream(res, tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call-" + tool + "-" + rootStep, type: "function", function: { name: tool, arguments: JSON.stringify(input) } }] }
      : { role: "assistant", content: "Skill fixture complete." }, !!tool)
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "skills")
const send = (...keys) => runtime.tmux("send-keys", "-t", "skills", ...keys)
const until = async (check, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check(capture())) return; await sleep(80) }
  throw Error("Skill fixture timed out")
}
const history = () => {
  db ??= new DatabaseSync(path.join(temp, "state/opencode/opencode-reviewer/history-v1.sqlite"), { readOnly: true })
  return db.prepare("SELECT r.context,p.body FROM history h JOIN reviews r ON r.id=h.review JOIN payloads p ON p.id=h.id").all()
    .map(row => ({ context: JSON.parse(row.context), payload: JSON.parse(row.body) }))
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false, skills: { paths: [skills] },
    permission: { skill: "ask", bash: "ask", task: "allow" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "synthetic" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1500 } } } } } }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ plugin: [[plugin, { baseURL: base + "/review", model: "fixture", notify: false,
    autoApprove: true, autoApproveDelaySeconds: scenario === "subagent-view" ? 2 : 0, fastMode: scenario === "fast", stream: scenario === "fast",
    ...(scenario === "disabled" ? { reviewSkills: false } : {}) }]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await runtime.start("-d", "-s", "skills", "-x", scenario === "subagent-view" ? "80" : "160", "-y", "40", "-c", project, "env",
    ...Object.entries(env).map(([k, v]) => k + "=" + v), host, project, "--prompt", userPrompt)
  if (scenario === "subagent-view") {
    await until(async () => reviews.length === 1 && (await records()).route === (await records()).children[0]?.id, 90000)
    await sleep(500)
    assert.equal((await records()).replies.length, 0, "the configured countdown still applies while route-hidden")
    assert.doesNotMatch(capture(), /Allowed in|Permission analysis/)
    runtime.tmux("resize-window", "-t", "skills", "-x", "160", "-y", "40")
  }
  if (scenario === "disabled") {
    await until(s => s.includes("Permission required"), 90000); await sleep(500)
    assert.equal(reviews.length, 0); assert.doesNotMatch(capture(), /Permission analysis/); assert.equal(loaded, false)
    send("Enter"); await until(() => loaded)
  } else if (scenario === "unsafe") {
    await until(s => s.includes("✗ Unsafe"), 90000); await sleep(500)
    assert.equal(loaded, false); assert.equal((await records()).replies.length, 0)
    assert.doesNotMatch(capture(), /Allowed in|Allowing/)
  } else {
    if (scenario === "fast") {
      await until(s => loaded && held && s.includes("Auto-approved; finishing report"), 90000)
      assert.equal(history().length, 0); held()
    }
    const count = subagent ? 2 : 1
    await until(async () => (await records()).replies.length === count && loaded, 90000)
    await until(() => history().length === count)
    assert.deepEqual((await records()).replies.map(r => r.reply), Array(count).fill("once"))
    assert.ok(history().some(row => row.context.category === "skill"))
    if (subagent) {
      assert.deepEqual(reviews.map(r => r.kind), ["skill", "shell"])
      assert.equal(reviews[0].delegation.sessionID, reviews[1].delegation.sessionID)
      assert.notEqual(reviews[0].delegation.messageID, reviews[1].delegation.messageID)
      await until(async () => access(path.join(project, "delegated-executed")).then(() => true, () => false))
      if (scenario === "subagent-view") {
        const observed = await records(), child = observed.children[0].id
        assert.equal(observed.route, child, "approval must finish without returning to the root")
        assert.ok(observed.renders.some(r => r.route === child && !r.physical && r.seconds === 2),
          "hidden subagent review must start its configured countdown without report paint")
        assert.ok(observed.renders.some(r => r.route === child && r.seconds === 1), "countdown must advance in the child view")
        assert.doesNotMatch(capture(), /Permission analysis|Allowed in/)
      }
    }
  }
  await assert.rejects(access(path.join(project, "support-executed")), "supporting scripts must never execute during skill review/load")
  assert.deepEqual(errors, [])
  await writeFile(path.join(artifacts, "final.txt"), capture())
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ scenario, temp, reviews, records: await records(), calls }, null, 2))
  console.log(`PASS skills ${scenario}: native skill permission, bounded catalog/file evidence and scoped review; ${artifacts}`)
} catch (error) {
  await writeFile(path.join(artifacts, "failed.txt"), capture()).catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, temp, errors, reviews, calls }, null, 2))
  throw error
} finally { db?.close(); await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
