// Installed five-file production archive and genuine stock V2 events. The only
// production dependency replaced is the desktop backend. Build first; the serial
// runtime runner owns host admission, and fixtures never rebuild implicitly.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, lstat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

// Read-only public native cache observations, shared by the two independent
// observers. No cache writes, synthetic events, forms, controllers or FRAMEs.
function nativeSnapshot(ctx, root) {
  const family = [root, ...ctx.data.session.family(root).filter(id => id !== root)]
  const members = family.map(sessionID => ({ sessionID,
    permissions: ctx.data.session.permission.list(sessionID),
    forms: ctx.data.session.form.list(sessionID),
    status: ctx.data.session.status(sessionID) }))
  return JSON.parse(JSON.stringify({ root, family, members,
    globalForms: ctx.data.session.form.list("global", { directory: fixture.project }) }))
}

async function titleSetup(ctx) {
  // Suppress auxiliary title generation, not primary model requests or tools.
  const registration = await ctx.session.hook("title", event => { event.result = "V2 notification fixture" })
  return () => registration.dispose()
}

async function monitorSetup(ctx) {
  const publisher = observationPublisher(fixture.monitor), abort = new AbortController()
  const record = { ready: true, version: ctx.app.version, connections: [], events: [], replies: {}, manual: [], errors: [], cleaned: false }
  const location = { directory: fixture.project }
  const options = () => ({ location, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const save = () => {
    record.route = JSON.parse(JSON.stringify(ctx.ui.router.current()))
    record.mode = ctx.keymap.mode.current()
    return publisher.publish(record)
  }
  const off = ctx.data.listen(({ details }) => {
    if (details.type === "server.connected") record.connections.push(JSON.parse(JSON.stringify(details)))
    if (details.type.startsWith("permission.") || details.type.startsWith("form.")
      || details.type.startsWith("session.execution.") || details.type.startsWith("session.step.")) {
      record.events.push(JSON.parse(JSON.stringify(details)))
    }
    void save()
  })
  let sequence = 0
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const command = await readObservation(fixture.control, { optional: true })
      if (command && command.sequence > sequence) {
        sequence = command.sequence
        let value
        if (command.type === "start") {
          value = await ctx.client.session.create({ title: "V2 notification fixture", location,
            model: { providerID: "fixture", id: "fixture" } }, options())
          await ctx.data.session.sync(value.id)
          ctx.ui.router.navigate({ type: "session", sessionID: value.id })
          await ctx.client.session.prompt({ sessionID: value.id, text: command.text }, options())
        } else if (command.type === "prompt") {
          value = await ctx.client.session.prompt({ sessionID: command.sessionID, text: command.text }, options())
        } else if (command.type === "snapshot") {
          value = { native: nativeSnapshot(ctx, command.sessionID),
            pending: await ctx.client.permission.list({ sessionID: command.sessionID }, options()),
            forms: await ctx.client.session.form.list({ sessionID: command.sessionID }, options()),
            session: await ctx.client.session.get({ sessionID: command.sessionID }, options()) }
        } else if (command.type === "message") {
          value = await ctx.client.session.message.get({ sessionID: command.sessionID, messageID: command.messageID }, options())
        } else if (command.type === "form") {
          value = await ctx.client.session.form.get({ sessionID: command.sessionID, formID: command.formID }, options())
        } else if (command.type === "answer") {
          // Verified SessionFormReplyInput in the pinned public client. Stock
          // question.ts maps its real first question to the field key q0.
          const detail = await ctx.client.session.form.get({ sessionID: command.sessionID, formID: command.formID }, options())
          assert.equal(detail.state.status, "pending")
          assert.equal(detail.metadata.kind, "question")
          assert.equal(detail.fields[0].key, "q0")
          assert.equal(command.answer, "Proceed")
          record.manual.push({ type: "answer", sessionID: command.sessionID, formID: command.formID, answer: { q0: command.answer } })
          await ctx.client.session.form.reply({ sessionID: command.sessionID, formID: command.formID,
            answer: { q0: command.answer } }, options())
        } else if (command.type === "once") {
          const pending = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
          assert.equal(pending[0]?.id, command.requestID, "Explicit manual driver resolves only the actual queue front")
          assert.equal(pending[0].action, "shell")
          record.manual.push({ type: "once", sessionID: command.sessionID, requestID: command.requestID })
          await ctx.client.permission.reply({ sessionID: command.sessionID, requestID: command.requestID, decision: "once" }, options())
        } else if (command.type === "interrupt") {
          record.manual.push({ type: "interrupt", sessionID: command.sessionID })
          await ctx.client.session.interrupt({ sessionID: command.sessionID, continue: false }, options())
        } else if (command.type === "plugins") {
          value = await ctx.client.plugin.list({ location }, options())
        } else throw Error("Unknown notification monitor control: " + command.type)
        record.replies[sequence] = { value: value ?? null }
        await save(); await publisher.flush()
      }
      await save()
      await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => { if (!abort.signal.aborted) { record.errors.push(String(error.stack ?? error)); void save() } })
  await save(); await publisher.flush()
  return async () => {
    off(); abort.abort(); await loop // Retain every actual client call through settlement.
    record.cleaned = true
    await save(); await publisher.flush(); await publisher.close()
  }
}

async function reviewerSetup(ctx) {
  const phase = (await readObservation(fixture.setupControl)).phase
  const publisher = observationPublisher(fixture.notifications[phase])
  const record = { phase, events: [], owned: 0, disposed: false, cleaned: false, errors: [] }
  const handles = new Map()
  const save = () => publisher.publish(record)
  const backend = (_click, config) => {
    record.config = { notify: config.notify, notifySound: config.notifySound,
      staleReminderSeconds: config.staleReminderSeconds, notifications: config.notifications }
    void save()
    return {
      async show(message, signal) {
        assert.equal(record.disposed, false)
        signal.throwIfAborted()
        const id = record.events.filter(event => event.type === "show").length + 1
        let resolve, closed = false
        const settled = new Promise(done => { resolve = done })
        const close = () => {
          if (closed) return
          closed = true; signal.removeEventListener("abort", close); handles.delete(id)
          record.owned--; record.events.push({ type: "close", id, at: performance.now() })
          resolve(); void save()
        }
        handles.set(id, { close, settled })
        signal.addEventListener("abort", close, { once: true })
        record.owned++
        record.events.push({ type: "show", id, at: performance.now(),
          message: JSON.parse(JSON.stringify(message)), native: nativeSnapshot(ctx, message.sessionID) })
        await save(); await publisher.flush()
        return { close, closed: settled, dispatched: Promise.resolve() }
      },
      async dispose() {
        if (record.disposed) return
        record.disposed = true
        const pending = [...handles.values()]
        for (const handle of pending) handle.close()
        await Promise.all(pending.map(handle => handle.settled))
        record.events.push({ type: "disposed", at: performance.now() })
        await save(); await publisher.flush()
      },
    }
  }
  // Keep default production runtime, controller, UI, cache reconciliation and
  // transport intact. This setup observer only reads readiness facts.
  const cleanup = await production.withHistoryObservations(() => {}, undefined, backend, ready => {
    if (ready.role !== "cli") return
    record.ready = true
    record.state = { config: !!ready.state.config, configError: ready.state.configError,
      companion: ready.state.companion, runtime: !!ready.state.runtime }
    void save()
  }).setup(ctx)
  await save(); await publisher.flush()
  return async () => {
    await cleanup()
    assert.equal(handles.size, 0, "Production disposal settles all injected desktop handles")
    record.cleaned = true
    await save(); await publisher.flush(); await publisher.close()
  }
}

const { scenario, hostVersions } = runtimeArguments("smoke-v2-notifications.mjs")
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-notifications-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-notifications-")
const env = smokeEnvironment(temp), runtime = await smokeRuntime(temp)
// New private sticky-/tmp child only: do not chmod existing user directories or
// weaken production SQLite ancestry checks below group-writable /tmp/opencode.
env.XDG_STATE_HOME = await mkdtemp("/tmp/reviewer-v2-notification-state-")
await mkdir(path.join(env.XDG_STATE_HOME, "opencode"), { mode: 0o700 })
const project = path.join(temp, "project"), cliPath = path.join(temp, "config/opencode/cli.json")
const monitorPath = path.join(artifacts, "monitor.json"), controlPath = path.join(artifacts, "control.json")
const setupControl = path.join(artifacts, "setup-control.json")
const notifications = Object.fromEntries(["main", "invalid", "no-companion"].map(phase => [phase, path.join(artifacts, `notifications-${phase}.json`)]))
const archiveFiles = ["dist/tui.js", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].sort()
const reminderMs = 8000
const script = 'import sys\nfrom pathlib import Path\nwith Path("executed").open("a") as output:\n    output.write(sys.argv[1] + "\\n")\nprint("NATIVE_NOTIFICATION_EXECUTED", sys.argv[1])\n'
const publishers = new Map(), calls = [], errors = [], negativeWindows = [], transactions = [], evidence = []
const mainRequests = new Map()
let version, server, cli, config, phase = scenario === "unavailable-review" ? "invalid" : "main", sequence = 0
let sessionID, expectedReplies = 0, allowedManual = 0, expectedReviews = scenario === "manual-handoff" ? 2 : 0
const publish = async (file, value) => {
  let publisher = publishers.get(file)
  if (!publisher) { publisher = observationPublisher(file); publishers.set(file, publisher) }
  await publisher.publish(value); await publisher.flush()
}
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-notifications")
const saveCapture = async name => {
  await writeFile(path.join(artifacts, name + ".txt"), capture())
  await writeFile(path.join(artifacts, name + ".ansi.txt"), runtime.tmux("capture-pane", "-p", "-e", "-t", "v2-notifications"))
}
const execution = () => readFile(path.join(project, "executed"), "utf8").catch(error => {
  if (error.code === "ENOENT") return null
  throw error
})
const events = (record, type, id = sessionID) => record.events.filter(event => event.type === type && event.data.sessionID === id)
const reviewCalls = () => calls.filter(call => call.url === "/review/chat/completions")
const observation = async () => {
  assert.deepEqual(errors, [])
  assert.ok(reviewCalls().length <= expectedReviews, "No unplanned production reviewer POST")
  const record = await readObservation(monitorPath, { optional: true })
  if (record) {
    assert.deepEqual(record.errors, [])
    const replied = record.events.filter(event => event.type === "permission.replied")
    assert.ok(replied.length <= expectedReplies, "No automatic or duplicate permission reply")
    assert.ok(record.manual.length <= allowedManual, "Only explicit admitted user controls")
    for (const event of replied) {
      assert.equal(event.data.reply, "once")
      assert.ok(record.manual.some(manual => manual.type === "once" && manual.sessionID === event.data.sessionID
        && manual.requestID === event.data.requestID), "Every reply is attributable to an explicit fixture manual action")
    }
  }
  return record
}
const attention = async () => {
  const value = await readObservation(notifications[phase], { optional: true })
  if (value) {
    assert.deepEqual(value.errors, [])
    for (const event of value.events.filter(event => event.type === "show")) {
      assert.equal(event.message.banner, true)
      assert.equal(event.message.sound, false)
      assert.equal(event.message.history, undefined, "Manual attention and turn notices are not automatic approval notices")
      assert.notEqual(event.message.kind, "approved")
    }
  }
  return value
}
const shows = value => value?.events.filter(event => event.type === "show") ?? []
const until = async (label, predicate, timeout = 60000) => {
  const end = performance.now() + timeout
  do {
    const record = await observation(), value = await predicate(record)
    if (value) return value
    await sleep(60)
  } while (performance.now() < end)
  throw Error(`Timed out waiting for ${scenario}/${label}`)
}
const command = async input => {
  const id = ++sequence
  await publish(controlPath, { ...input, sequence: id })
  return (await until("monitor " + input.type, record => record?.replies[id])).value
}
const snapshot = () => command({ type: "snapshot", sessionID })
const quiet = async (label, count, duration = 1500, check = () => {}) => {
  const at = performance.now(), end = at + duration
  let samples = 0
  do {
    const record = await observation(), value = await attention()
    assert.equal(shows(value).length, count, "No extra or premature notification: " + label)
    await check(record, value)
    samples++; await sleep(75)
  } while (performance.now() < end)
  negativeWindows.push({ label, samples, durationMs: performance.now() - at, notifications: count,
    replies: recordReplies(await observation()).length, reviewPOSTs: reviewCalls().length })
}
const recordReplies = record => record.events.filter(event => event.type === "permission.replied")
const prompt = tag => `NOTIFICATIONS:${tag}. Perform only the requested isolated notification fixture operation.`
const start = async tag => {
  const session = await command({ type: "start", text: prompt(tag) })
  sessionID = session.id
  await until("actual primary request " + tag, () => mainRequests.get(tag)?.[0])
  return session
}
const send = (request, message, finishReason = "stop") => {
  const { res, body } = request
  assert.equal(res.destroyed, false, "Held native model transaction is still owned")
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`)
    res.end("data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }))
  }
}
const releaseTools = (tag, tools) => {
  const request = mainRequests.get(tag)[0]
  for (const tool of tools) assert.ok(request.body.tools.some(item => item.function.name === tool.name), "Actually advertised direct native tool")
  send(request, { role: "assistant", content: null, tool_calls: tools.map((tool, index) => ({ index, id: tool.id,
    type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } })) }, "tool_calls")
}
const shell = label => ({ id: "native-notification-" + label, name: "shell", input: { command: "python3 fixture.py " + label } })
const assertFront = (shown, kind, id) => {
  const pending = shown.native.members.flatMap(member => member.permissions ?? [])
  if (kind === "attention") assert.equal(pending[0]?.id, id, "Only actual native queue-front permission owns desktop attention")
  else {
    assert.deepEqual(pending, [], "Questions do not jump native permission blockers")
    assert.equal(shown.native.members.flatMap(member => member.forms ?? [])[0]?.id, id, "Actual native form owns question attention")
  }
  assert.equal(shown.message.kind, kind)
  assert.equal(shown.message.sessionID, sessionID)
}
const awaitShows = async count => until("exact notification count " + count, async () => {
  const value = await attention()
  assert.ok(shows(value).length <= count, "No notification replay while waiting")
  return shows(value).length === count && value
})
const reminder = async (count, initial, kind, id) => {
  // A sustained interval, not a sleep followed by one instantaneous assertion.
  await quiet("full configured reminder delay after initial/handoff", count, reminderMs - 2000)
  const value = await awaitShows(count + 1), next = shows(value).at(-1)
  assertFront(next, kind, id)
  assert.equal(next.message.title, initial.message.title + " (Reminder)")
  assert.ok(next.at - initial.at >= reminderMs, "Backend-observed dispatches retain the full real configured reminder interval")
  return value
}
const manualOnce = async request => {
  allowedManual++; expectedReplies++
  await command({ type: "once", sessionID, requestID: request.id })
  await until("matching actual native manual once", record => recordReplies(record).some(event => event.data.requestID === request.id))
}
const interrupt = async () => {
  allowedManual++
  await command({ type: "interrupt", sessionID })
  await until("actual interrupted execution", record => events(record, "session.execution.interrupted").length
    || events(record, "session.execution.failed").some(event => event.data.error.type === "aborted"))
}
const limits = [
  "Exact installed five-file archive, stock V2 native tool executors, real primary/reviewer HTTP and actual durable execution/permission/form events. No synthetic events, fake controllers, native forms or cache mutations.",
  "Only the exported desktop-backend seam is injected. No actual desktop processes, GNOME focus, audible playback, live-provider judgment or audio/desktop acceptance.",
  "One isolated standalone host/terminal and public client user controls. Manual once replies and form answers are explicit fixture actions, never reviewer automatic replies. No Always/reject or permission-rule mutation.",
  "Native question tool creates the production form. Pinned public SessionFormReplyInput uses session.form.reply with formID and an answer object; there is no guessed form.submit API.",
  ...(scenario === "unavailable-review" ? ["The independent monitor observes the real initial server.connected event before public CLI configuration activates notification-only fallback. Reconnect still revokes an active generation; pre-connection plugin startup is not acceptance evidence from this case."] : []),
]

try {
  version = execFileSync(host, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim()
  assert.ok(hostVersions.includes(version), "An explicitly selected stock verification host")
  await mkdir(project); await mkdir(path.dirname(cliPath), { recursive: true })
  execFileSync("git", ["init", "--quiet", project], { env, timeout: 10000 })
  await writeFile(path.join(project, "fixture.py"), script)
  const output = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", temp], {
    cwd: root, env: { ...env, npm_config_cache: path.join(temp, "npm-cache"), npm_config_ignore_scripts: "true" }, encoding: "utf8", timeout: 60000 }))
  const packed = Array.isArray(output) ? output : Object.values(output)
  assert.equal(packed.length, 1)
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), archiveFiles)
  const archive = path.join(temp, packed[0].filename), install = path.join(temp, "installed")
  await mkdir(install)
  assert.deepEqual(execFileSync("tar", ["-tzf", archive], { env, encoding: "utf8", timeout: 10000 }).trim().split("\n").sort(),
    archiveFiles.map(file => "package/" + file).sort())
  execFileSync("tar", ["-xzf", archive, "-C", install], { env, timeout: 10000 })
  const installed = path.join(install, "package")
  for (const file of archiveFiles) {
    assert.equal((await lstat(path.join(installed, file))).isSymbolicLink(), false)
    assert.deepEqual(await readFile(path.join(installed, file)), await readFile(path.join(root, file)))
  }
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"))
  assert.equal(manifest.name, "opencode-reviewer")
  assert.deepEqual(manifest.exports, { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" })
  server = createServer(async (req, res) => {
    let settle
    const transaction = { url: req.url, closed: false, finished: false, settled: new Promise(resolve => { settle = resolve }) }
    transactions.push(transaction)
    res.once("finish", () => { transaction.finished = true; settle() })
    res.once("close", () => { transaction.closed = true; settle() })
    try {
      assert.equal(req.method, "POST")
      let text = ""
      for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
      const body = JSON.parse(text)
      calls.push({ url: req.url, body })
      if (req.url === "/review/chat/completions") {
        assert.equal(scenario, "manual-handoff", "Unavailable review/forms/execution never dispatch a reviewer POST")
        assert.ok(reviewCalls().length <= 2)
        assert.equal(body.model, "v2-production-notifications")
        assert.equal(body.stream, false)
        assert.equal(body.messages.length, 2)
        const data = JSON.parse(body.messages[1].content)
        assert.equal(data.kind, "shell")
        assert.equal(data.tool, "shell")
        assert.ok(["first", "second"].some(label => data.command === shell(label).input.command))
        assert.equal(data.userPrompt, prompt("handoff"))
        assert.equal(data.location.directory, project)
        assert.equal(data.permission.action, "shell")
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true,
          desc: "Isolated manual notification marker." }) }, finish_reason: "stop" }] }))
        return
      }
      assert.equal(req.url, "/v1/chat/completions")
      assert.ok(body.tools.some(tool => tool.function.name === "execute"), "Native Code Mode remains installed")
      const lastUser = body.messages.filter(message => message.role === "user").at(-1)
      const tag = JSON.stringify(lastUser?.content).match(/NOTIFICATIONS:([a-z-]+)/)?.[1]
      assert.ok(tag, "Actual fixture user prompt identifies the owned primary transaction")
      const requests = mainRequests.get(tag) ?? []
      requests.push({ res, body }); mainRequests.set(tag, requests)
      assert.ok(requests.length <= (tag === "handoff" || tag === "forms" ? 2 : 1), "No extra primary retry/continuation")
      if (requests.length === 1) return // Controlled genuine primary response.
      const results = body.messages.filter(message => message.role === "tool")
      if (tag === "handoff") {
        assert.equal(results.length, 2)
        for (const label of ["first", "second"]) {
          const result = results.find(result => result.tool_call_id === shell(label).id)
          assert.ok(result)
          assert.match(JSON.stringify(result.content), new RegExp("NATIVE_NOTIFICATION_EXECUTED.*" + label))
        }
      } else {
        assert.equal(tag, "forms")
        assert.equal(results.length, 1)
        assert.equal(results[0].tool_call_id, "native-notification-question")
        assert.match(JSON.stringify(results[0].content), /Proceed/)
      }
      send(requests.at(-1), { role: "assistant", content: "Native notification operation complete." })
    } catch (error) { errors.push(String(error.stack ?? error)); res.destroy() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const fixture = { project, monitor: monitorPath, control: controlPath, setupControl, notifications }
  const reviewer = path.join(temp, "reviewer"), monitor = path.join(temp, "monitor"), title = path.join(temp, "title")
  await Promise.all([reviewer, monitor, title].map(directory => mkdir(directory)))
  const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
  const prelude = helpers + '\nimport assert from "node:assert/strict"\nimport {setTimeout as sleep} from "node:timers/promises"\n'
    + `const fixture=${JSON.stringify(fixture)}\n` + nativeSnapshot + "\n"
  const moduleURL = pathToFileURL(path.join(installed, "dist/tui.js")).href
  await publish(path.join(reviewer, "package.json"), { name: "v2-notification-installed-entrypoints", type: "module",
    exports: { ".": "./index.mjs", "./tui": "./tui.mjs" } })
  await writeFile(path.join(reviewer, "index.mjs"), `export {default} from ${JSON.stringify(moduleURL)}\n`)
  await writeFile(path.join(reviewer, "tui.mjs"), prelude + `import * as production from ${JSON.stringify(moduleURL)}\n`
    + reviewerSetup + '\nexport default {id:"opencode-reviewer",setup:reviewerSetup}\n')
  await publish(path.join(monitor, "package.json"), { name: "v2-notification-independent-monitor", type: "module", exports: { "./tui": "./tui.mjs" } })
  await writeFile(path.join(monitor, "tui.mjs"), prelude + monitorSetup + '\nexport default {id:"fixture.notifications.monitor",setup:monitorSetup}\n')
  await publish(path.join(title, "package.json"), { name: "v2-notification-title-observer", type: "module", exports: { ".": "./index.mjs" } })
  await writeFile(path.join(title, "index.mjs"), titleSetup + '\nexport default {id:"fixture.notifications.title",setup:titleSetup}\n')
  for (const file of [path.join(reviewer, "tui.mjs"), path.join(monitor, "tui.mjs"), path.join(title, "index.mjs")])
    execFileSync(process.execPath, ["--check", file], { env, timeout: 10000 })
  config = { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", update: "disable", plugins: [reviewer, title],
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: origin + "/v1", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
  const options = { baseURL: origin + "/review", model: "v2-production-notifications", stream: false, autoApprove: false,
    timeoutMs: 120000, notify: true, notifySound: false, staleReminderSeconds: reminderMs / 1000,
    notifications: Object.fromEntries(["attention", "unsafe", "question", "approved", "ended", "error"].map(kind => [kind,
      { banner: kind === "attention" || kind === "question" || scenario === "execution" && ["ended", "error"].includes(kind), sound: false }])) }
  cli = { $schema: "https://opencode.ai/v2/cli.json", animations: false, attention: { notifications: false, sound: false },
    session: { permissions: "prompt" }, plugins: [{ package: reviewer,
      options: { ...options, ...(phase === "invalid" ? { fileIO: {} } : {}) } }, monitor] }
  await publish(setupControl, { phase })
  // The unavailable-review check activates a fresh generation after the actual
  // initial connection. A pre-connection runtime is correctly revoked by that
  // event; this fixture does not claim pre-connection startup acceptance.
  const startupCli = scenario === "unavailable-review" ? { ...cli, plugins: ["-opencode-reviewer", monitor] } : cli
  await publish(path.join(project, "opencode.json"), config); await publish(cliPath, startupCli)
  await publish(path.join(artifacts, "setup.json"), { version, scenario, archive, packed, installed, moduleURL, config, cli,
    startupCli, temp, environment: { HOME: env.HOME, XDG_STATE_HOME: env.XDG_STATE_HOME }, socket: runtime.socket, supervisorPID: runtime.supervisorPID, limits })
  await runtime.start("-d", "-s", "v2-notifications", "-x", "160", "-y", "40", "-c", project,
    "env", "XDG_STATE_HOME=" + env.XDG_STATE_HOME, host, "--standalone", project)
  const ready = await until("independent observer", record => record?.ready && record)
  assert.equal(ready.version, version.slice("opencode v".length))
  if (scenario === "unavailable-review") {
    await until("actual initial connection before notification-only activation", record => record.connections?.length === 1)
    await publish(cliPath, cli)
  }
  const productionReady = await until("actual production notification runtime", async () => {
    const value = await attention()
    return value?.ready && !value.disposed && value.config?.staleReminderSeconds === reminderMs / 1000 && value
  })
  assert.equal(productionReady.config.staleReminderSeconds, reminderMs / 1000)
  assert.equal(productionReady.state.runtime, scenario !== "unavailable-review")
  if (scenario !== "unavailable-review") {
    assert.equal(productionReady.state.config, true)
    assert.equal(productionReady.state.companion.protocol, 1)
    assert.deepEqual(productionReady.state.companion.location, { directory: project })
  }

  if (scenario === "manual-handoff") {
    await start("handoff")
    releaseTools("handoff", [shell("first"), shell("second")])
    const requests = await until("two actual native shell permissions", record => {
      const values = events(record, "permission.asked").map(event => event.data)
      return values.length === 2 && values
    })
    const pending = await snapshot()
    assert.equal(pending.pending.length, 2)
    assert.deepEqual(pending.native.members[0].permissions, pending.pending, "Actual native cache order, not event-arrival guesses")
    for (const request of requests) {
      assert.equal(request.action, "shell")
      const tool = [shell("first"), shell("second")].find(tool => tool.id === request.source.id)
      assert.ok(tool); assert.deepEqual(request.resources, [tool.input.command])
      const message = await command({ type: "message", sessionID, messageID: request.source.messageID })
      const part = message.content.find(part => part.type === "tool" && part.id === tool.id)
      assert.equal(part.name, "shell"); assert.equal(part.state.status, "running"); assert.deepEqual(part.state.input, tool.input)
    }
    await until("two actual advisory reviewer POSTs", () => reviewCalls().length === 2)
    for (const request of requests) {
      const payloads = reviewCalls().map(call => JSON.parse(call.body.messages[1].content))
      const payload = payloads.find(value => value.permission.id === request.id)
      assert.ok(payload, "Each genuine native permission owns exactly its production reviewer POST")
      assert.equal(payload.permission.sessionID, sessionID)
      assert.equal(payload.permission.source.assistantID, request.source.messageID)
      assert.equal(payload.permission.source.id, request.source.id)
      assert.deepEqual(payload.permission.resources, request.resources)
      assert.equal(payload.operation.input.command, request.resources[0])
    }
    const initial = shows(await awaitShows(1))[0]
    assertFront(initial, "attention", pending.pending[0].id)
    assert.doesNotMatch(initial.message.title, /\(Reminder\)$/)
    await quiet("queued second permission has no initial alert or execution", 1, 1500, async record => {
      assert.deepEqual((await snapshot()).pending, pending.pending)
      assert.deepEqual(recordReplies(record), []); assert.equal(await execution(), null)
    })
    await saveCapture("two-native-permissions")
    await manualOnce(pending.pending[0])
    const firstLabel = pending.pending[0].source.id.replace("native-notification-", "")
    await until("only explicitly approved first marker executes", async () => await execution() === firstLabel + "\n")
    const handed = await awaitShows(2), next = shows(handed)[1]
    assertFront(next, "attention", pending.pending[1].id)
    assert.doesNotMatch(next.message.title, /\(Reminder\)$/, "Handoff sends the second request's initial alert")
    assert.ok(handed.events.some(event => event.type === "close" && event.id === initial.id), "Queue loss closes the first handle")
    await reminder(2, next, "attention", pending.pending[1].id)
    const secondPending = await snapshot()
    assert.deepEqual(secondPending.pending, [pending.pending[1]])
    assert.equal(await execution(), firstLabel + "\n", "Reminders never approve or execute")
    await manualOnce(pending.pending[1])
    const secondLabel = pending.pending[1].source.id.replace("native-notification-", "")
    await until("second explicit once executes exactly once", async () => await execution() === firstLabel + "\n" + secondLabel + "\n")
    await until("real primary tool-result continuation completes", record => events(record, "session.execution.succeeded").length === 1)
    await until("resolved attention handles settle", async () => (await attention()).owned === 0)
    await quiet("resolved permissions cancel reminders beyond another full interval", 3, reminderMs + 1500, async record => {
      assert.deepEqual((await snapshot()).pending, [])
      assert.equal(recordReplies(record).length, 2); assert.equal(reviewCalls().length, 2)
      assert.equal(await execution(), firstLabel + "\n" + secondLabel + "\n")
    })
    evidence.push({ requests, nativeOrder: pending.pending, notifications: shows(await attention()), execution: await execution() })
  } else if (scenario === "forms") {
    await start("forms")
    const tool = { id: "native-notification-question", name: "question", input: { questions: [{ header: "Choice",
      question: "Choose the isolated fixture answer.", options: [{ label: "Proceed", description: "Finish this fixture." }] }] } }
    releaseTools("forms", [tool])
    const form = await until("genuine native question-created form", record => {
      const created = record.events.filter(event => event.type === "form.created" && event.data.form.sessionID === sessionID)
      assert.ok(created.length <= 1)
      return created[0]?.data.form
    })
    const detail = await command({ type: "form", sessionID, formID: form.id })
    assert.equal(detail.state.status, "pending")
    assert.equal(detail.metadata.kind, "question")
    assert.equal(detail.metadata.tool.id, tool.id)
    assert.equal(detail.fields[0].key, "q0"); assert.equal(detail.fields[0].type, "string")
    assert.deepEqual(detail.fields[0].options, [{ value: "Proceed", label: "Proceed", description: "Finish this fixture." }])
    const message = await command({ type: "message", sessionID, messageID: detail.metadata.tool.messageID })
    const part = message.content.find(part => part.type === "tool" && part.id === tool.id)
    assert.equal(part.name, "question"); assert.equal(part.state.status, "running"); assert.deepEqual(part.state.input, tool.input)
    const initial = shows(await awaitShows(1))[0]
    assertFront(initial, "question", form.id)
    await reminder(1, initial, "question", form.id)
    await until("actual native question UI", () => capture().includes("Choose the isolated fixture answer."))
    await saveCapture("native-question")
    allowedManual++
    await command({ type: "answer", sessionID, formID: form.id, answer: "Proceed" })
    const replied = await until("actual native form reply", record => events(record, "form.replied")[0])
    assert.equal(replied.data.id, form.id); assert.deepEqual(replied.data.answer, { q0: "Proceed" })
    await until("real question tool continuation succeeds", record => events(record, "session.execution.succeeded").length === 1)
    const answered = await command({ type: "form", sessionID, formID: form.id })
    assert.deepEqual(answered.state, { status: "answered", answer: { q0: "Proceed" } })
    await until("answered form handle physically settles", async () => (await attention()).owned === 0)
    await quiet("answer resolution cancels reminders beyond a full interval", 2, reminderMs + 1500, async record => {
      const value = await snapshot()
      assert.deepEqual(value.pending, []); assert.deepEqual(value.forms, [])
      assert.deepEqual(recordReplies(record), []); assert.equal(reviewCalls().length, 0); assert.equal(await execution(), null)
    })
    evidence.push({ form, detail, answered, replied, notifications: shows(await attention()) })
  } else if (scenario === "execution") {
    await start("ended")
    await until("actual first active execution", record => events(record, "session.execution.started").length === 1)
    await quiet("active execution is not an ended notification", 0)
    send(mainRequests.get("ended")[0], { role: "assistant", content: "Native ended fixture." })
    await until("actual successful terminal execution", record => events(record, "session.execution.succeeded").length === 1)
    assert.equal(shows(await awaitShows(1))[0].message.kind, "ended")
    await command({ type: "prompt", sessionID, text: prompt("error") })
    const failure = await until("real error primary transaction and active execution", record => mainRequests.get("error")?.[0]
      && events(record, "session.execution.started").length === 2
      && mainRequests.get("error")[0])
    await quiet("active error-target step does not prematurely notify", 1)
    failure.res.writeHead(400, { "Content-Type": "application/json" })
    failure.res.end(JSON.stringify({ error: { message: "Owned fixture terminal provider failure", type: "invalid_request_error" } }))
    const terminal = await until("actual non-aborted failed execution", record => events(record, "session.execution.failed").find(event => event.data.error.type !== "aborted"))
    assert.equal(shows(await awaitShows(2))[1].message.kind, "error")
    await command({ type: "prompt", sessionID, text: prompt("aborted") })
    await until("held native execution is actually active", record => mainRequests.get("aborted")?.[0]
      && events(record, "session.execution.started").length === 3)
    await quiet("held third execution is silent until terminal fact", 2)
    await interrupt()
    await until("aborted native HTTP transaction physically closes", () => mainRequests.get("aborted")[0].res.destroyed)
    await quiet("actual aborted execution suppresses both ended and error notices", 2, reminderMs + 1500, async record => {
      assert.equal(events(record, "session.execution.succeeded").length, 1)
      assert.equal(events(record, "session.execution.failed").filter(event => event.data.error.type !== "aborted").length, 1)
      assert.deepEqual(recordReplies(record), []); assert.equal(reviewCalls().length, 0)
      assert.deepEqual((await snapshot()).pending, []); assert.equal(await execution(), null)
    })
    const record = await observation()
    const active = events(record, "session.execution.started"), steps = events(record, "session.step.started")
    assert.equal(active.length, 3)
    assert.equal(new Set(active.map(event => event.id)).size, 3, "Three distinct genuine execution births")
    const executionEvents = record.events.filter(event => event.type.startsWith("session.execution."))
    for (const event of executionEvents) assert.equal(event.durable.aggregateID, sessionID, "Terminal facts belong to the actual native root aggregate")
    assert.equal(executionEvents.length, 6, "Three execution births and three native terminal facts, not inferred model outcomes")
    assert.ok(executionEvents.every((event, index) => !index || event.durable.seq > executionEvents[index - 1].durable.seq))
    // step.started belongs to received assistant output, not HTTP dispatch. A
    // held response or rejected HTTP request need not create an assistant step.
    // Native execution births and terminals, not invented step events, own these
    // acceptance assertions. Retain any observed step facts as fixture data.
    for (const shown of shows(await attention())) assert.equal(shown.message.sessionID, sessionID)
    evidence.push({ terminal, active, steps, nativeEvents: record.events, notifications: shows(await attention()) })
  } else {
    // Both real causes, on two freshly created roots. No forged handshake or
    // observer-failure injection: reject actual user review options, then remove
    // the actual server companion using the documented plugin directive.
    assert.equal(productionReady.state.config, false)
    assert.match(productionReady.state.configError, /Unknown opencode-reviewer setting: fileIO/)
    assert.equal(productionReady.state.companion.protocol, 1)
    for (const targetPhase of ["invalid", "no-companion"]) {
      if (targetPhase === "no-companion") {
        await publish(cliPath, { ...cli, plugins: ["-opencode-reviewer", monitor] })
        const cleaned = await until("invalid-review production backend fully unloaded", async () => { const value = await attention(); return value?.cleaned && value })
        assert.equal(cleaned.owned, 0); assert.equal(cleaned.disposed, true)
        await publish(path.join(project, "opencode.json"), { ...config, plugins: ["-opencode-reviewer", title] })
        await until("actual server companion removed", async () => {
          const value = await command({ type: "plugins" })
          return !value.data.some(plugin => plugin.id === "opencode-reviewer" && plugin.state.status === "active")
        })
        phase = targetPhase; await publish(setupControl, { phase })
        cli = { ...cli, plugins: [{ package: reviewer, options }, monitor] }
        await publish(cliPath, cli)
        const value = await until("production notification-only runtime without companion", async () => { const value = await attention(); return value?.ready && value })
        assert.equal(value.state.config, true); assert.equal(value.state.companion, undefined); assert.equal(value.state.runtime, false)
      }
      await start(targetPhase)
      const tool = shell(targetPhase)
      releaseTools(targetPhase, [tool])
      const request = await until("actual pending shell with review unavailable", record => events(record, "permission.asked")[0]?.data)
      assert.equal(request.source.id, tool.id); assert.deepEqual(request.resources, [tool.input.command])
      const initial = shows(await awaitShows(1))[0]
      assertFront(initial, "attention", request.id)
      await reminder(1, initial, "attention", request.id)
      assert.equal(reviewCalls().length, 0); assert.equal(await execution(), null)
      assert.doesNotMatch(capture(), /Permission analysis|Allowed in/)
      await saveCapture("notification-only-" + targetPhase)
      await interrupt()
      await until("actual interruption clears unavailable-review request", async () => (await snapshot()).pending.length === 0)
      await until("notification-only interruption closes owned handle", async () => (await attention()).owned === 0)
      await quiet("unavailable review interruption cannot reply/execute/replay reminder", 2, reminderMs + 1500, async record => {
        assert.deepEqual((await snapshot()).pending, []); assert.deepEqual(recordReplies(record), [])
        assert.equal(reviewCalls().length, 0); assert.equal(await execution(), null)
        assert.doesNotMatch(capture(), /Permission analysis|Allowed in/)
      })
      evidence.push({ phase: targetPhase, request, state: (await attention()).state, notifications: shows(await attention()) })
    }
  }

  const final = await observation(), finalAttention = await attention()
  const expectedShows = scenario === "manual-handoff" ? 3 : 2
  assert.equal(shows(finalAttention).length, expectedShows)
  assert.equal(recordReplies(final).length, scenario === "manual-handoff" ? 2 : 0)
  assert.equal(reviewCalls().length, expectedReviews)
  assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length,
    scenario === "execution" ? 3 : scenario === "unavailable-review" ? 2 : 2)
  await saveCapture("final")
  await publish(cliPath, { ...cli, plugins: ["-opencode-reviewer", "-fixture.notifications.monitor"] })
  const cleaned = await until("monitor owned transactions and final publication settle", record => record?.cleaned && record)
  const backendCleaned = await until("production desktop backend handles and final publication settle", async () => { const value = await attention(); return value?.cleaned && value })
  assert.equal(backendCleaned.disposed, true); assert.equal(backendCleaned.owned, 0)
  assert.equal(backendCleaned.events.filter(event => event.type === "disposed").length, 1)
  assert.equal(backendCleaned.events.filter(event => event.type === "close").length, expectedShows)
  await sleep(300)
  assert.deepEqual(await observation(), cleaned, "No independent observer callback after final flush/close")
  assert.deepEqual(await attention(), backendCleaned, "No backend callback after final flush/close")
  await publish(path.join(artifacts, "results.json"), { outcome: "pass", version, scenario, temp, archiveFiles, evidence,
    calls, reviewPOSTs: reviewCalls().length, replies: recordReplies(cleaned), negativeWindows, observations: cleaned,
    notifications: backendCleaned, execution: await execution(), limits })
  console.log(`PASS V2 installed production notifications ${scenario}: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  await saveCapture("failed").catch(() => {})
  await publish(path.join(artifacts, "failure.json"), { version, scenario, phase, temp, error: String(error), stack: error.stack,
    errors, calls, negativeWindows, evidence, observations: await readObservation(monitorPath, { optional: true }).catch(() => null),
    notifications: await readObservation(notifications[phase], { optional: true }).catch(() => null), limits })
  throw error
} finally {
  try { await runtime.dispose() }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await Promise.allSettled(transactions.map(transaction => transaction.settled))
    await Promise.all([...publishers.values()].map(publisher => publisher.close()))
  }
}
