// Real built plugin, native permissions and supervised terminal. Only model and desktop I/O are injected.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { connectionProbe } from "./smoke-connection.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

async function monitorSetup(ctx) {
  const publisher = observationPublisher(fixture.monitor), abort = new AbortController()
  const [memory, update] = ctx.storage.memory("steering-monitor", { initial: { sequence: 0,
    record: { connectionBirths: [], connectionDeletes: [], asked: [], replied: [], replies: {}, errors: [] } } })
  const record = JSON.parse(JSON.stringify(memory.record)), location = { directory: fixture.project }
  const options = () => ({ location, signal: AbortSignal.timeout(15000) })
  const save = () => { update(draft => { draft.record = JSON.parse(JSON.stringify(record)) }); return publisher.publish(record) }
  const off = ctx.data.listen(({ details }) => {
    if (details.type === "session.created") record.connectionBirths.push(details)
    if (details.type === "session.deleted") record.connectionDeletes.push(details)
    if (details.type === "permission.asked") record.asked.push(details.data)
    if (details.type === "permission.replied") record.replied.push(details.data)
    void save()
  })
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const command = await readObservation(fixture.control, { optional: true })
      abort.signal.throwIfAborted()
      if (command && command.sequence > memory.sequence) {
        update(draft => { draft.sequence = command.sequence })
        let value
        if (command.type === "connection-probe" || command.type === "start") {
          value = await ctx.client.session.create({ title: "Steering fixture", location,
            model: { providerID: "fixture", id: "fixture" } }, options())
          if (command.type === "start") {
            ctx.ui.router.navigate({ type: "session", sessionID: value.id })
            await ctx.client.session.prompt({ sessionID: value.id, text: "Run the fixture command." }, options())
          }
        } else if (command.type === "remove-probe") await ctx.client.session.remove({ sessionID: command.sessionID }, options())
        else if (command.type === "prompt") await ctx.client.session.prompt({ sessionID: command.sessionID, text: "Run the fixture command again." }, options())
        else if (command.type === "ready") value = ctx.keymap.commands().some(item => item.id === "reviewer.disable")
        else if (command.type === "pending") value = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
        else if (command.type === "history") ctx.keymap.dispatch("reviewer.history")
        else if (command.type === "statistics") ctx.keymap.dispatch("reviewer.lifetime")
        else throw Error("Unknown steering control")
        record.replies[command.sequence] = { value: value ?? null }
      }
      await save(); await publisher.flush()
      await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => { if (!abort.signal.aborted) { record.errors.push(String(error.stack)); void save() } })
  return async () => { abort.abort(); off(); await loop; await save(); await publisher.close() }
}

async function reviewerSetup(ctx) {
  const publisher = observationPublisher(fixture.notifications), events = [], handles = new Set()
  const cleanup = await production.withNotifications(() => ({
    async show(message, signal) {
      events.push(JSON.parse(JSON.stringify(message))); await publisher.publish(events); await publisher.flush()
      let resolve, closed = false
      const settled = new Promise(done => { resolve = done })
      const close = () => { if (closed) return; closed = true; signal.removeEventListener("abort", close); handles.delete(close); resolve() }
      handles.add(close); signal.addEventListener("abort", close, { once: true })
      if (signal.aborted) close()
      return { close, closed: settled, dispatched: Promise.resolve() }
    },
    async dispose() { for (const close of handles) close() },
  })).setup(ctx)
  return async () => { await cleanup(); await publisher.close() }
}

const { scenario } = runtimeArguments("smoke-v2-steering.mjs")
const fast = scenario === "fast-steering", cap = scenario === "normal-steering-cap", followUp = scenario === "normal-steering-follow-up"
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8" }).trim()
assertV2HostVersion(version)
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-steering-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-steering-"), env = smokeEnvironment(temp)
env.XDG_STATE_HOME = await mkdtemp("/tmp/reviewer-steering-state-")
await mkdir(path.join(env.XDG_STATE_HOME, "opencode"), { mode: 0o700 })
const project = path.join(temp, "project"), runtime = await smokeRuntime(temp)
const fixture = { project, monitor: path.join(artifacts, "monitor.json"), control: path.join(artifacts, "control.json"),
  notifications: path.join(artifacts, "notifications.json") }
const publishers = new Map()
const publish = async (file, value) => {
  let publisher = publishers.get(file)
  if (!publisher) { publisher = observationPublisher(file); publishers.set(file, publisher) }
  await publisher.publish(value); await publisher.flush()
}
const errors = [], reviews = [], mains = [], results = []
let sequence = 0, sessionID, server, completed = 0
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "steering")
const observe = () => readObservation(fixture.monitor, { optional: true })
const until = async (label, check, timeout = 20000) => {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    assert.deepEqual(errors, [])
    const record = await observe()
    assert.deepEqual(record?.errors ?? [], [])
    const value = await check(record)
    if (value) return value
    await sleep(40)
  }
  throw Error("Timed out: " + label)
}
const command = async value => {
  const id = ++sequence
  await publish(fixture.control, { ...value, sequence: id })
  return (await until(value.type, record => record?.replies[id])).value
}
const marker = () => readFile(path.join(project, "executed"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error })
const notifications = async () => await readObservation(fixture.notifications, { optional: true }) ?? []
const sse = (res, delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
const answer = (pending, message, finish = "stop") => {
  const { res, body } = pending
  if (body.stream) { res.writeHead(200, { "Content-Type": "text/event-stream" }); sse(res, message); sse(res, {}, finish); res.end("data: [DONE]\n\n") }
  else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }] })) }
}
const reason = "The requested command exceeds the allowed scope.", steering = "Use a read-only inspection instead."
const assessment = { safe: false, reason, steering, desc: "The fixture command writes a marker." }
const message = `Rejected by opencode-reviewer: ${reason} ${steering} Please start by resolving this. Ideally, the next shell tool call`
  + " you execute should fix this review issue. You may gather additional context before."
const followUpText = "I will inspect the project read-only instead.", followUpCommand = "ls"
const finishReview = index => {
  const res = reviews[index].res
  sse(res, { content: fast ? '"}' : JSON.stringify(assessment) }); sse(res, {}, "stop"); res.end("data: [DONE]\n\n")
}
const database = async () => {
  const file = path.join(env.XDG_STATE_HOME, "opencode/opencode-reviewer/history-v1.sqlite")
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    return { rows: db.prepare("SELECT * FROM history ORDER BY completed").all(), reasons: db.prepare("SELECT * FROM review_reasons").all(),
      rejections: db.prepare("SELECT * FROM auto_rejections").all(), totals: db.prepare("SELECT * FROM auto_rejection_totals").all(),
      meta: db.prepare("SELECT totals FROM meta WHERE id=1").get() }
  } catch (error) { if (error.code === "ERR_SQLITE_ERROR" && ((error.errcode & 255) === 5 || error.errcode === 14)) return; throw error }
  finally { db?.close() }
}
const quiet = async (index, replies, milliseconds = 1500) => {
  const end = performance.now() + milliseconds
  do {
    const record = await observe()
    assert.equal(record.replied.length, replies)
    assert.equal(reviews.length, index + 1)
    assert.equal(await marker(), replies >= 2 ? "executed\n" : "")
    await sleep(50)
  } while (performance.now() < end)
}
try {
  await mkdir(project, { recursive: true }); await mkdir(path.join(temp, "config/opencode"), { recursive: true })
  smokeGitInit(temp, project)
  server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw), pending = { res, body }
      if (req.url === "/review/chat/completions") {
        assert.equal(body.stream, true); assert.equal(body.tools, undefined)
        const evidence = JSON.parse(body.messages[1].content)
        assert.equal(evidence.command, followUp && reviews.length === 1 ? followUpCommand : "printf 'executed\\n' >> executed")
        reviews.push(pending)
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders()
      } else {
        assert.equal(req.url, "/v1/chat/completions")
        if (body.messages.at(-1).role === "tool") {
          results.push(body.messages.at(-1))
          // The corrected request is a new assistant step with text before its tool call.
          if (followUp && results.length === 1) answer(pending, { role: "assistant", content: followUpText, tool_calls: [{ index: 0, id: "follow-up",
            type: "function", function: { name: "shell", arguments: JSON.stringify({ command: followUpCommand }) } }] }, "tool_calls")
          else { answer(pending, { role: "assistant", content: "Fixture complete." }); completed++ }
        } else mains.push(pending)
      }
    } catch (error) { errors.push(String(error.stack)); res.destroy() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
  const prelude = helpers + '\nimport {setTimeout as sleep} from "node:timers/promises"\nconst fixture=' + JSON.stringify(fixture) + "\n"
  const monitor = path.join(temp, "monitor"), reviewer = path.join(temp, "reviewer"), title = path.join(temp, "title")
  for (const directory of [monitor, reviewer, title]) await mkdir(directory)
  const bundle = pathToFileURL(path.join(root, "dist/tui.js")).href
  await publish(path.join(monitor, "package.json"), { name: "steering-monitor", type: "module", exports: { "./tui": "./tui.mjs" } })
  await writeFile(path.join(monitor, "tui.mjs"), prelude + monitorSetup + '\nexport default {id:"fixture.steering.monitor",setup:monitorSetup}\n')
  await publish(path.join(reviewer, "package.json"), { name: "steering-production", type: "module", exports: { ".": "./index.mjs", "./tui": "./tui.mjs" } })
  await writeFile(path.join(reviewer, "index.mjs"), `export {default} from ${JSON.stringify(bundle)}\n`)
  await writeFile(path.join(reviewer, "tui.mjs"), prelude + `import * as production from ${JSON.stringify(bundle)}\n` + reviewerSetup + '\nexport default {id:"opencode-reviewer",setup:reviewerSetup}\n')
  await publish(path.join(title, "package.json"), { name: "steering-title", type: "module", exports: { ".": "./index.mjs" } })
  await writeFile(path.join(title, "index.mjs"), 'export default {id:"fixture.steering.title",async setup(ctx){const r=await ctx.session.hook("title",e=>{e.result="Steering fixture"});return ()=>r.dispose()}}\n')
  await publish(path.join(project, "opencode.json"), { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", update: "disable",
    plugins: [reviewer, title], permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: origin + "/v1", apiKey: "synthetic" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } })
  const cliPath = path.join(temp, "config/opencode/cli.json")
  const cli = { $schema: "https://opencode.ai/v2/cli.json", animations: false, mouse: true, attention: { notifications: false, sound: false },
    session: { permissions: "prompt" }, plugins: [{ package: reviewer, options: { baseURL: origin + "/review", model: "steering-reviewer",
      autoApprove: false, autoRejectSteering: true, maxSteeringRejections: 1, fastMode: fast, stream: true, retrieval: false,
      autoApproveDelaySeconds: fast ? 45 : 3, notify: true, notifySound: false, staleReminderSeconds: 0,
      notifications: { ended: { banner: false, sound: false }, error: { banner: false, sound: false } } } }, monitor] }
  await publish(cliPath, { ...cli, plugins: ["-opencode-reviewer", monitor] })
  await runtime.start("-d", "-s", "steering", "-x", "160", "-y", "48", "-c", project, "env", "XDG_STATE_HOME=" + env.XDG_STATE_HOME, host, "--standalone")
  await until("monitor", record => record, 60000)
  await connectionProbe({ create: budget => command({ type: "connection-probe", ...budget }),
    remove: (id, budget) => command({ type: "remove-probe", sessionID: id, ...budget }), observe, directory: project })
  await publish(cliPath, cli)
  await until("production runtime", () => command({ type: "ready" }))
  sessionID = (await command({ type: "start" })).id
  const count = cap ? 3 : 1
  for (let index = 0; index < count; index++) {
    if (index) await command({ type: "prompt", sessionID })
    await until("main model", () => mains.length === index + 1)
    answer(mains[index], { role: "assistant", content: null, tool_calls: [{ index: 0, id: "steering-" + index, type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: "printf 'executed\\n' >> executed" }) } }] }, "tool_calls")
    await until("review", () => reviews.length === index + 1)
    await quiet(index, index)
    assert.equal((await notifications()).filter(item => item.kind === "steered").length, index === 0 ? 0 : 1)
    if (!index) assert.deepEqual(await notifications(), [], "pending analysis stays silent")
    if (fast) {
      sse(reviews[index].res, { content: '{"safe":false,"reason":' + JSON.stringify(reason) + ',"steering":' + JSON.stringify(steering).slice(0, -1) })
      await quiet(index, index)
      assert.deepEqual(await notifications(), [], "an incomplete steering string cannot notify or reject")
      sse(reviews[index].res, { content: '","desc":"The fixture command writes a marker.' })
    } else finishReview(index)
    if (cap && index === 1) {
      await until("cap holds Unsafe", () => capture().includes("Unsafe"))
      assert.doesNotMatch(capture(), /Rejected in|Steering:/)
      await quiet(index, index, 4500)
      runtime.tmux("send-keys", "-t", "steering", "Enter") // native Allow once resets the session cap
    } else {
      if (!fast) {
        await until("rejection countdown", () => /Rejected in \d+s/.test(capture()))
        assert.match(capture(), /Reason for rejection:/); assert.match(capture(), /Steering:/)
        if (!index) assert.deepEqual(await notifications(), [], "armed steering countdown stays silent")
        assert.equal((await database()).reasons.length, index, "unresolved reason is memory-only")
      }
    }
    await until("native decision", record => record.replied.length === index + 1)
    const reply = (await observe()).replied[index]
    assert.equal(reply.reply, cap && index === 1 ? "once" : "reject")
    if (followUp) break
    if (fast) {
      assert.equal((await database()).rows.length, 0, "fast confirmation has no provisional saved report")
      await until("retained fast rejection", () => capture().includes("Finishing report"))
      finishReview(index)
    }
    await until("native continuation", () => completed === index + 1)
    if (!(cap && index === 1)) assert.ok(JSON.stringify(results[index]).includes(message), "exact steering message reaches the next native model turn")
    await until("saved report", async () => (await database())?.rows.length === index + 1)
    const db = await database()
    assert.equal(db.reasons.length, index + 1)
    assert.equal(db.reasons.at(-1).reason, reason)
    assert.equal(await marker(), cap && index >= 1 ? "executed\n" : "")
    await writeFile(path.join(artifacts, `stage-${index}.txt`), capture())
  }
  if (followUp) {
    await until("follow-up review", () => reviews.length === 2)
    assert.ok(JSON.stringify(results[0]).includes(message), "exact steering message with the closing sentence reaches the agent")
    const [system, user] = reviews[1].body.messages, evidence = JSON.parse(user.content)
    assert.match(system.content, /steeringFollowUp is context for a previously rejected request/)
    assert.equal(evidence.steeringFollowUp.steeringMessage, message)
    assert.equal(evidence.steeringFollowUp.rejectedOperation.category, "shell")
    assert.equal(evidence.steeringFollowUp.rejectedOperation.tool, "shell")
    assert.equal(evidence.steeringFollowUp.rejectedOperation.input.command, "printf 'executed\\n' >> executed")
    assert.deepEqual(evidence.steeringFollowUp.agentOutput, [{ type: "text", text: followUpText }])
    assert.equal(evidence.steeringFollowUp.omittedOlderItems, undefined)
    const res = reviews[1].res
    sse(res, { content: JSON.stringify({ safe: true, reason: "A read-only listing follows the steering.", steering: null, desc: "Lists the project." }) })
    sse(res, {}, "stop"); res.end("data: [DONE]\n\n")
    await until("follow-up rating", () => capture().includes("Reason for approval:"))
    await writeFile(path.join(artifacts, "follow-up.txt"), capture())
    runtime.tmux("send-keys", "-t", "steering", "Enter") // native Allow once
    await until("follow-up approval", record => record.replied.length === 2 && record.replied[1].reply === "once")
    await until("native continuation", () => completed === 1)
    assert.equal(await marker(), "", "the rejected command never ran")
    assert.equal((await command({ type: "pending", sessionID })).length, 0)
    await publish(path.join(artifacts, "results.json"), { outcome: "pass", version, scenario, sessionID, native: await observe() })
    console.log(`PASS V2 steering ${scenario}: ${artifacts}`)
  } else {
  const expected = cap ? 2 : 1
  await until("steered notifications", async () => (await notifications()).filter(item => item.kind === "steered").length === expected)
  const notices = (await notifications()).filter(item => item.kind === "steered")
  for (const [index, notice] of notices.entries()) {
    assert.equal(notice.title, "Reviewer rejected a permission"); assert.equal(notice.sessionID, sessionID)
    assert.deepEqual(notice.history, { session: sessionID, permission: (await observe()).asked[index && cap ? 2 : index].id })
  }
  const db = await database()
  assert.equal(db.rejections.length, expected)
  assert.ok(db.rejections.every(row => row.steering === steering))
  assert.ok(db.totals.every(row => row.count === expected))
  assert.equal(JSON.parse(db.meta.totals).activity.rejected, expected)
  assert.equal((await command({ type: "pending", sessionID })).length, 0)
  await command({ type: "history" })
  await until("saved Auto rejected label", () => capture().includes("Auto rejected"))
  await writeFile(path.join(artifacts, "history.txt"), capture())
  await command({ type: "statistics" })
  await until("automatic and manual rejection statistics", () => capture().includes(`Auto-rejected: ${expected} (`) && capture().includes("Rejected: 0 (0.0%)"))
  await writeFile(path.join(artifacts, "statistics.txt"), capture())
  await publish(path.join(artifacts, "results.json"), { outcome: "pass", version, scenario, sessionID, database: db, notices, native: await observe() })
  console.log(`PASS V2 steering ${scenario}: ${artifacts}`)
  }
} catch (error) {
  let screen = ""
  try { screen = capture() } catch { /* Startup may fail before the pane exists. */ }
  await writeFile(path.join(artifacts, "failure.txt"), String(error.stack) + "\n" + screen)
  throw error
} finally {
  await runtime.dispose()
  server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve))
  for (const publisher of publishers.values()) await publisher.close()
}
