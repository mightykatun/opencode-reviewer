// Real built plugin, native worktree, session move and permissions in a supervised terminal.
// Only model and desktop I/O are injected. A root conversation's subagent moves into a
// native git worktree, like an agent that isolates its work, then asks for a shell
// permission there. The root's home composition must review and approve it.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeGit, smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { connectionProbe } from "./smoke-connection.mjs"
import { managedReviewer, verifiedSnapshot } from "./smoke-v2-rpc.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

async function monitorSetup(ctx) {
  const publisher = observationPublisher(fixture.monitor), abort = new AbortController()
  const [memory, update] = ctx.storage.memory("worktree-monitor", { initial: { sequence: 0,
    record: { connectionBirths: [], connectionDeletes: [], moves: [], asked: [], replied: [], replies: {}, errors: [] } } })
  const record = JSON.parse(JSON.stringify(memory.record)), location = { directory: fixture.project }
  const options = (at = location) => ({ location: at, signal: AbortSignal.timeout(15000) })
  const save = () => {
    record.route = JSON.parse(JSON.stringify(ctx.ui.router.current()))
    update(draft => { draft.record = JSON.parse(JSON.stringify(record)) })
    return publisher.publish(record)
  }
  const off = ctx.data.listen(({ details }) => {
    if (details.type === "session.created") record.connectionBirths.push(details)
    if (details.type === "session.deleted") record.connectionDeletes.push(details)
    if (details.type === "session.moved") record.moves.push(details.data)
    if (details.type === "permission.asked") record.asked.push({ ...details.data, location: details.location })
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
          value = await ctx.client.session.create({ title: "Worktree fixture", location,
            model: { providerID: "fixture", id: "fixture" } }, options())
          if (command.type === "start") {
            ctx.ui.router.navigate({ type: "session", sessionID: value.id })
            await ctx.client.session.prompt({ sessionID: value.id, text: fixture.rootPrompt }, options())
          }
        } else if (command.type === "remove-probe") await ctx.client.session.remove({ sessionID: command.sessionID }, options())
        else if (command.type === "ready") value = ctx.keymap.commands().some(item => item.id === "reviewer.disable")
        else if (command.type === "child") {
          value = await ctx.client.session.create({ title: "Worktree subagent", parentID: command.sessionID, location,
            model: { providerID: "fixture", id: "fixture" } }, options())
        } else if (command.type === "worktree") {
          // Native worktree creation, exactly what an agent's worktree tool does.
          const session = await ctx.client.session.get({ sessionID: command.sessionID }, options())
          value = await ctx.client.worktree.create({ projectID: session.projectID, name: "fixture-subagent" }, options())
        } else if (command.type === "move") {
          await ctx.client.session.move({ sessionID: command.sessionID, directory: command.directory }, options())
        } else if (command.type === "family") {
          await ctx.data.session.sync(command.sessionID)
          const root = ctx.data.session.root(command.sessionID)
          value = { session: ctx.data.session.get(command.sessionID), root, family: ctx.data.session.family(root) }
        } else if (command.type === "prompt") {
          await ctx.client.session.prompt({ sessionID: command.sessionID, text: command.text }, options())
        } else if (command.type === "pending") {
          value = await ctx.client.permission.list({ sessionID: command.sessionID }, options(command.location ?? location))
        } else if (command.type === "evict-worktree") {
          await ctx.client.debug.location.evict({ location: { directory: command.directory } }, options())
        } else if (command.type === "child-queue") {
          ctx.data.session.permission.invalidate(command.sessionID)
          try { await ctx.data.session.permission.sync(command.sessionID); value = "readable" }
          catch { value = "unreadable" }
        } else throw Error("Unknown worktree control")
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

const { scenario } = runtimeArguments("smoke-v2-worktree.mjs")
const removed = scenario === "normal-removed-worktree"
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8" }).trim()
assertV2HostVersion(version)
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-worktree-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-worktree-"), env = smokeEnvironment(temp)
env.XDG_STATE_HOME = await mkdtemp("/tmp/reviewer-worktree-state-")
await mkdir(path.join(env.XDG_STATE_HOME, "opencode"), { mode: 0o700 })
const project = path.join(temp, "project"), runtime = await smokeRuntime(temp)
const rootPrompt = "Delegate the fixture command to a subagent working in its own worktree."
const fixture = { project, rootPrompt, monitor: path.join(artifacts, "monitor.json"), control: path.join(artifacts, "control.json"),
  notifications: path.join(artifacts, "notifications.json") }
const fixtureCommand = "printf 'executed\\n' >> executed"
const publishers = new Map()
const publish = async (file, value) => {
  let publisher = publishers.get(file)
  if (!publisher) { publisher = observationPublisher(file); publishers.set(file, publisher) }
  await publisher.publish(value); await publisher.flush()
}
const errors = [], reviews = [], mains = []
let sequence = 0, sessionID, child, worktree, server, completed = 0
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "worktree")
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
const marker = directory => readFile(path.join(directory, "executed"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error })
const notifications = async () => await readObservation(fixture.notifications, { optional: true }) ?? []
const sse = (res, delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
const answer = (pending, message, finish = "stop") => {
  const { res, body } = pending
  if (body.stream) { res.writeHead(200, { "Content-Type": "text/event-stream" }); sse(res, message); sse(res, {}, finish); res.end("data: [DONE]\n\n") }
  else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }] })) }
}
const database = async () => {
  const file = path.join(env.XDG_STATE_HOME, "opencode/opencode-reviewer/history-v2.sqlite")
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    return { rows: db.prepare("SELECT * FROM history ORDER BY completed").all(), reviews: db.prepare("SELECT context FROM reviews").all() }
  } catch (error) { if (error.code === "ERR_SQLITE_ERROR" && ((error.errcode & 255) === 5 || error.errcode === 14)) return; throw error }
  finally { db?.close() }
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
        reviews.push(pending)
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders()
      } else {
        assert.equal(req.url, "/v1/chat/completions")
        if (body.messages.at(-1).role === "tool") { answer(pending, { role: "assistant", content: "Fixture complete." }); completed++ }
        else mains.push(pending)
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
  await publish(path.join(monitor, "package.json"), { name: "worktree-monitor", type: "module", exports: { "./tui": "./tui.mjs" } })
  await writeFile(path.join(monitor, "tui.mjs"), prelude + monitorSetup + '\nexport default {id:"fixture.worktree.monitor",setup:monitorSetup}\n')
  await publish(path.join(reviewer, "package.json"), { name: "worktree-production", type: "module", exports: { ".": "./index.mjs", "./tui": "./tui.mjs" } })
  await writeFile(path.join(reviewer, "index.mjs"), `export {default} from ${JSON.stringify(pathToFileURL(path.join(root, "dist/server.js")).href)}\n`)
  await writeFile(path.join(reviewer, "tui.mjs"), prelude + `import * as production from ${JSON.stringify(bundle)}\n` + reviewerSetup + '\nexport default {id:"opencode-reviewer",setup:reviewerSetup}\n')
  await publish(path.join(title, "package.json"), { name: "worktree-title", type: "module", exports: { ".": "./index.mjs" } })
  await writeFile(path.join(title, "index.mjs"), 'export default {id:"fixture.worktree.title",async setup(ctx){const r=await ctx.session.hook("title",e=>{e.result="Worktree fixture"});return ()=>r.dispose()}}\n')
  await publish(path.join(project, "opencode.json"), { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", update: "disable",
    plugins: [reviewer, title],
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: origin + "/v1", apiKey: "synthetic" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } })
  // Commit the configuration, so the native worktree checkout loads the same plugins.
  const git = args => smokeGit(temp, project, args).trim()
  git(["add", "--", "opencode.json"])
  git(["-c", "user.name=Reviewer Fixture", "-c", "user.email=reviewer@example.invalid", "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "--no-gpg-sign", "-m", "Initial fixture commit"])
  const cliPath = path.join(temp, "config/opencode/cli.json")
  const cli = { $schema: "https://opencode.ai/v2/cli.json", animations: false, mouse: true, attention: { notifications: false, sound: false },
    session: { permissions: "prompt" }, plugins: [reviewer, monitor] }
  await publish(path.join(path.dirname(cliPath), "opencode-reviewer.json"), { server: {
      baseURL: origin + "/review", model: "worktree-reviewer",
      autoApprove: true, fastMode: false, stream: true, retrieval: false, autoApproveDelaySeconds: 3 }, tui: {
      notify: true, notifySound: false, staleReminderSeconds: 0,
      notifications: { ended: { banner: false, sound: false }, error: { banner: false, sound: false } } } })
  await publish(cliPath, { ...cli, plugins: ["-opencode-reviewer", monitor] })
  const service = await managedReviewer({ runtime, env, directory: project, host })
  await runtime.start("-d", "-s", "worktree", "-x", "160", "-y", "48", "-c", project, "env", "XDG_STATE_HOME=" + env.XDG_STATE_HOME, host)
  await until("monitor", record => record, 60000)
  await connectionProbe({ create: budget => command({ type: "connection-probe", ...budget }),
    remove: (id, budget) => command({ type: "remove-probe", sessionID: id, ...budget }), observe, directory: project })
  const enableReviewer = async () => {
    await publish(cliPath, cli)
    await verifiedSnapshot(service, project)
    await until("production runtime", () => command({ type: "ready" }))
  }
  if (!removed) await enableReviewer()

  // The root conversation lives in the project. Its first turn ends without tools.
  sessionID = (await command({ type: "start" })).id
  await until("root main model", () => mains.length === 1)
  answer(mains[0], { role: "assistant", content: "Root ready." })
  child = await command({ type: "child", sessionID })
  assert.equal(child.parentID, sessionID)
  worktree = (await command({ type: "worktree", sessionID })).directory
  assert.ok(path.isAbsolute(worktree)); assert.notEqual(worktree, project)
  await command({ type: "move", sessionID: child.id, directory: worktree })
  // move() acknowledges inbox admission. The native session moves at a later step boundary.
  await until("native session moved to the worktree", record =>
    record?.moves.some(move => move.sessionID === child.id && move.location.directory === worktree))
  const moved = await command({ type: "family", sessionID: child.id })
  assert.equal(moved.session.location.directory, worktree, "The subagent now lives in the worktree location")
  assert.equal(moved.root, sessionID)
  assert.ok(moved.family.includes(child.id), "The native family still holds the moved subagent")

  const owner = removed ? sessionID : child.id, directory = removed ? project : worktree
  const prompt = removed ? "Run the fixture command in the root project." : "Run the fixture command in your worktree."
  if (removed) {
    // Removing the checkout does not remove its session or its place in the native family.
    await command({ type: "evict-worktree", directory: worktree })
    git(["worktree", "remove", worktree])
    assert.ok((await command({ type: "family", sessionID })).family.includes(child.id))
    assert.equal(await command({ type: "child-queue", sessionID: child.id }), "unreadable")
    await enableReviewer()
  }
  await verifiedSnapshot(service, directory)
  await command({ type: "prompt", sessionID: owner, text: prompt })
  await until("permission owner's main model", () => mains.length === 2)
  answer(mains[1], { role: "assistant", content: null, tool_calls: [{ index: 0, id: "worktree-shell", type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: fixtureCommand }) } }] }, "tool_calls")
  const asked = await until("native worktree permission", record => record?.asked[0])
  assert.equal(asked.sessionID, owner)
  assert.equal(asked.location?.directory, directory)
  await until("home composition review", () => reviews.length === 1, 30000)
  const evidence = JSON.parse(reviews[0].body.messages[1].content)
  assert.equal(evidence.command, fixtureCommand)
  assert.equal(evidence.cwd, directory)
  assert.equal(evidence.userPrompt, removed ? prompt : rootPrompt)
  assert.equal(await marker(directory), "", "Nothing runs before approval")
  sse(reviews[0].res, { content: JSON.stringify({ safe: true, reason: "The command appends one fixture marker.", desc: "Appends a marker in the worktree." }) })
  sse(reviews[0].res, {}, "stop"); reviews[0].res.end("data: [DONE]\n\n")
  await until("countdown on the root route", () => /Allowed in \d+s/.test(capture()))
  assert.deepEqual((await observe()).route, { type: "session", sessionID }, "The user stays on the root conversation")
  await writeFile(path.join(artifacts, "countdown.txt"), capture())
  const reply = await until("automatic native once reply", record => record.replied[0])
  assert.deepEqual(reply, { sessionID: owner, requestID: asked.id, reply: "once" })
  await until("native continuation", () => completed === 1)
  assert.equal(await marker(directory), "executed\n")
  if (!removed) assert.equal(await marker(project), "", "The command ran in the worktree only")
  assert.deepEqual(await command({ type: "pending", sessionID: owner, location: { directory } }), [])
  const db = await until("saved report", async () => (await database())?.rows.length === 1 && database())
  assert.equal(db.reviews.length, 1, "Exactly one composition reviewed the request")
  const context = JSON.parse(db.reviews[0].context)
  assert.equal(db.rows[0].root, createHash("sha256").update(JSON.stringify([sessionID])).digest("hex"), "History is indexed by the native root session")
  assert.equal(context.root, sessionID); assert.equal(context.session, owner); assert.equal(context.permission, asked.id)
  assert.deepEqual((await notifications()).filter(item => item.kind === "attention"), [], "An automatic approval never needs attention")
  const native = await observe()
  assert.equal(native.asked.length, 1); assert.equal(native.replied.length, 1)
  await publish(path.join(artifacts, "results.json"), { outcome: "pass", version, scenario, sessionID, child: child.id, worktree, context, native })
  console.log(`PASS V2 worktree ${scenario}: ${artifacts}`)
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
