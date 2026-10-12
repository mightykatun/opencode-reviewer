// Controlled native-host baseline, production delivery-capacity and desktop
// action/EOF interleavings. All desktop processes are isolated fixture transports.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, copyFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-notification-w4.mjs")
const baselineScenario = scenario === "baseline" || scenario === "baseline-permission"
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8" }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-notification-w4-")), project = path.join(temp, "project")
const artifacts = path.join(root, ".runtime", "notification-w4-" + scenario)
await mkdir(project); await mkdir(path.join(temp, "config")); await mkdir(artifacts, { recursive: true })
execFileSync("git", ["init", "--quiet", project])
const bundle = path.join(temp, "bundle.mjs"), plugin = path.join(temp, "plugin.mjs"), records = path.join(temp, "records.json")
await writeFile(records, JSON.stringify({ events: [], starts: [], actions: [], peak: 0 }))
await copyFile(path.join(root, "dist/tui.js"), bundle)
await writeFile(plugin, `
import { withNotificationProcesses } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
import { existsSync } from 'node:fs';
import { createEffect } from 'solid-js';
export default { id: 'notification-w4', tui: async (api, options) => {
  const scenario = ${JSON.stringify(scenario)};
  const data = { events: [], starts: [], actions: [], peak: 0, released: false };
  let releaseBaseline, sequence = 0, baselinePermission, staleQuestion;
  const publisher = observationPublisher(${JSON.stringify(records)});
  const save = () => publisher.publish(data);
  const baseline = new Promise(resolve => { releaseBaseline = resolve });
  const children = new Set(), banners = [];
  // A deterministic fake terminal identity enables the real activation pipeline
  // inside tmux. No desktop command escapes the injected process transport.
  if (scenario === 'click') {
    for (const key of ['TMUX', 'STY', 'SSH_CONNECTION', 'SSH_TTY']) delete process.env[key];
    process.env.GNOME_TERMINAL_SERVICE = ':1.123';
    process.env.GNOME_TERMINAL_SCREEN = '/org/gnome/Terminal/screen/00000000_0000_0000_0000_000000000001';
  }
  const processFactory = () => ({
    start(command, args, ms, signal, line) {
      let resolve, finished = false;
      const result = new Promise(yes => { resolve = yes });
      const item = { command, args, line, id: String(++sequence), finish: () => {
        if (finished) return; finished = true; children.delete(item);
        resolve({code: 0, stdout: command === 'gdbus' && args.includes('org.gnome.Shell.SearchProvider2.GetSubsearchResultSet') ? "(['00000000-0000-0000-0000-000000000001'],)" : ''}); void save();
      } };
      children.add(item); data.peak = Math.max(data.peak, children.size);
      data.starts.push({command, args, at: Date.now(), id: item.id});
      signal.addEventListener('abort', item.finish, {once:true});
      if (command === 'notify-send') { banners.push(item); queueMicrotask(() => line?.(item.id)); }
      if (command === 'gdbus' || (scenario !== 'capacity' && command !== 'notify-send') || data.released) queueMicrotask(item.finish);
      void save(); return {result, cancel:item.finish};
    }, dispose() { for (const item of children) item.finish(); }
  });
  for (const type of ['permission.asked','permission.replied','question.asked','question.replied']) api.event.on(type, event => {
    if (type === 'question.asked') staleQuestion = event.properties;
    data.events.push({type, ...event.properties, at:Date.now()}); void save();
  });
  api.event.on('message.updated', event => {
    const message = event.properties.info;
    if (message.role === 'assistant' && !message.summary && message.time.completed && message.finish === 'stop') { data.completed = true; void save(); }
  });
  api.event.on('session.idle', () => { data.idles = (data.idles ?? 0) + 1; void save(); });
  api.event.on('session.status', event => { if (event.properties.status.type === 'idle') { data.idles = (data.idles ?? 0) + 1; void save(); } });
  createEffect(() => { data.route = api.route.current.name === 'session' ? api.route.current.params.sessionID : undefined; void save(); });
  const on = api.event.on.bind(api.event);
  const baselineScenario = scenario === 'baseline' || scenario === 'baseline-permission';
  const wrapped = !baselineScenario && scenario !== 'question-reconcile' ? api : {...api,
    event: {...api.event, on(type, callback) { return on(type, event => {
      if (baselineScenario && type === 'permission.asked') {
        baselinePermission ??= event.properties.id;
        if (scenario === 'baseline' || event.properties.id === baselinePermission) return;
      }
      if (scenario === 'question-reconcile' && ['question.replied','question.rejected'].includes(type)) return;
      callback(event);
    }); }},
    client: new Proxy(api.client, {get(target, key) {
      if (scenario === 'question-reconcile' && key === 'question') return new Proxy(api.client.question, {get(target, key) {
        if (key !== 'list') return Reflect.get(target, key, target);
        return async (...args) => {
          const value = await api.client.question.list(...args);
          if (!data.released && staleQuestion) return {...value, data:[staleQuestion]};
          return value;
        };
      }});
      if (!baselineScenario || key !== 'permission') return Reflect.get(target, key, target);
      return new Proxy(api.client.permission, {get(target, key) { if (key !== 'list') return Reflect.get(target, key, target); return async (...args) => {
      data.baselineHeld = true; void save(); await baseline;
      const value = await api.client.permission.list(...args); data.baselineRead = true; void save(); return value;
    }; }}); }})
  };
  await withNotificationProcesses(processFactory)(wrapped, options);
  const release = () => { data.released = true; releaseBaseline(); if (scenario === 'capacity') for (const item of children) item.finish(); void save(); };
  const control = setInterval(() => { if (!data.released && existsSync(${JSON.stringify(path.join(temp, "release"))})) release(); }, 50);
  const off = api.keymap.registerLayer({priority:200, mode:'base', bindings:[
    {key:'f6', cmd:release},
    {key:'f7', cmd:async () => { data.other ??= (await api.client.session.create({directory:api.state.path.directory,title:'Other W4 conversation'}, {throwOnError:true})).data.id;
      api.route.navigate('session',{sessionID:data.other}); void save(); }},
    {key:'f8', cmd:() => { const old = banners.find(b => b.args.at(-1) === 'Reviewer approved a permission');
      const newer = banners.find(b => b.args.at(-1) === 'Session ended');
      if (!old || !newer) throw Error('Missing click banners');
      old.line('default'); newer.line('default'); newer.finish(); data.actions.push('old-action','new-action','new-eof'); void save(); }},
    {key:'f9', cmd:() => { banners.find(b => b.args.at(-1) === 'Reviewer approved a permission').finish(); data.actions.push('old-eof'); void save(); }}
  ]});
  const offModal = api.keymap.registerLayer({priority:200, mode:'modal', bindings:[{key:'f6',cmd:release}]});
  api.lifecycle.onDispose(async () => {off(); offModal(); clearInterval(control); releaseBaseline(); save(); await publisher.close();});
} };
`)
let sent = false, reviewCount = 0, questionSent = false
const count = scenario === "capacity" ? 70 : scenario === "baseline-permission" ? 2 : scenario === "question-reconcile" ? 0 : 1
const errors = []
const heldReviews = []
const question = index => ({ index, id: "question", type: "function", function: { name: "question", arguments: JSON.stringify({ questions: [{ header: "W4", question: "W4 controlled question", options: [{ label: "Done", description: "Complete fixture" }] }] }) } })
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    if (req.url === "/review/chat/completions") {
      reviewCount++
      const release = () => {
        if (res.writableEnded) return
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true, desc: "W4 safe report" }) }, finish_reason: "stop" }] }))
      }
      if (scenario === "capacity") heldReviews.push({ id: JSON.parse(body.messages[1].content).permission.id, release })
      else release()
      return
    }
    const main = body.tools?.some(t => t.function?.name === "bash")
    let tools
    if (main && !sent) {
      sent = true
      tools = Array.from({ length: count }, (_, index) => ({ index, id: "bash-" + index, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf 'W4 fixture\\n'", description: "W4 command " + index }) } }))
      if (baselineScenario || scenario === "question-reconcile") { tools.push(question(count)); questionSent = true }
    } else if (main && scenario === "capacity" && !questionSent) { tools = [question(0)]; questionSent = true }
    const message = tools ? { role: "assistant", tool_calls: tools } : { role: "assistant", content: main ? "W4 fixture complete." : "W4 title" }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [delta, finish_reason] of [[message, null], [{}, tools ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "w4", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: tools ? "tool_calls" : "stop" }] })) }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
let screen = ""
const data = () => readObservation(records)
const send = (...keys) => runtime.tmux("send-keys", "-t", "w4", ...keys)
const until = async (check, timeout = 90000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    assert.deepEqual(errors, []); screen = runtime.tmux("capture-pane", "-p", "-t", "w4")
    if (await check(screen)) return
    await sleep(80)
  }
  throw Error("W4 fixture timed out: " + screen)
}
const banners = d => d.starts.filter(s => s.command === "notify-send")
const sounds = d => d.starts.filter(s => s.command === "paplay" || s.command === "pw-play")
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false, permission: { bash: "ask", question: "allow" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 32000, output: 16000 } } } } } }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ plugin: [[plugin, { baseURL: base + "/review", model: "fixture", notify: true, notifySound: scenario === "capacity",
    notifications: { approved: { sound: true } },
    staleReminderSeconds: 0, autoApprove: !baselineScenario, reviewBash: !baselineScenario, autoApproveDelaySeconds: 0, timeoutMs: 120000 }]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await runtime.start("-d", "-s", "w4", "-x", "160", "-y", "40", "-c", project, "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), host, project, "--prompt", "Run the isolated W4 notification fixture.")
  if (baselineScenario) {
    await until(async s => s.includes("Permission required") && (await data()).events.some(e => e.type === "question.asked"))
    await sleep(500); assert.deepEqual(banners(await data()), [])
    send("F6"); await until(async () => (await data()).baselineRead)
    await sleep(500); assert.deepEqual(banners(await data()), [])
    send("Enter")
    if (scenario === "baseline-permission") {
      await until(async s => s.includes("Permission required") && banners(await data()).some(b => b.args.at(-1) === "Session needs attention"))
      assert.equal(banners(await data()).filter(b => b.args.at(-1) === "Session needs attention").length, 1)
      assert.equal((await data()).events.filter(e => e.type === "permission.replied").length, 1)
      send("Enter")
    }
    await until(async s => s.includes("W4 controlled question") && banners(await data()).some(b => b.args.at(-1) === "Agent has a question"))
    assert.equal(banners(await data()).filter(b => b.args.at(-1) === "Agent has a question").length, 1)
    assert.equal(reviewCount, 0)
  } else if (scenario === "question-reconcile") {
    await until(async s => s.includes("W4 controlled question") && banners(await data()).some(b => b.args.at(-1) === "Agent has a question"))
    send("Enter")
    await until(async () => { const d = await data(); return d.completed && d.idles && d.events.some(e => e.type === "question.replied") })
    // Keep the stale question across multiple healthy polls and final idle checks.
    await sleep(4500)
    assert.deepEqual(banners(await data()).map(b => b.args.at(-1)), ["Agent has a question"])
    const idles = (await data()).idles
    await writeFile(path.join(temp, "release"), "release")
    await until(async () => banners(await data()).some(b => b.args.at(-1) === "Session ended"))
    await sleep(4500)
    assert.deepEqual(banners(await data()).map(b => b.args.at(-1)), ["Agent has a question", "Session ended"])
    assert.equal((await data()).idles, idles, "completion recovery requires no extra idle event")
    assert.equal(reviewCount, 0)
  } else if (scenario === "capacity") {
    await until(() => heldReviews.length === count)
    heldReviews.toSorted((a, b) => a.id < b.id ? -1 : 1)[0].release()
    await until(async () => sounds(await data()).length === 1)
    // Cross the approval-sound interval with a held player. Later sounds in
    // this same conversation must still wait for its physical settlement.
    await sleep(2100)
    for (const review of heldReviews) review.release()
    await until(async () => (await data()).events.filter(e => e.type === "permission.replied").length === count, 150000)
    await until(async s => s.includes("W4 controlled question") && banners(await data()).some(b => b.args.at(-1) === "Agent has a question"))
    const before = await data()
    assert.equal(banners(before).filter(b => b.args.at(-1) === "Reviewer approved a permission").length, 16)
    assert.equal(sounds(before).length, 1, "same-session notifications must not overlap")
    assert.ok(before.peak <= 24)
    assert.ok(!sounds(before).some(s => s.args.at(-1).endsWith("question.wav")))
    await writeFile(path.join(temp, "release"), "release")
    await until(async () => (await data()).released)
    await until(async () => banners(await data()).filter(b => b.args.at(-1) === "Reviewer approved a permission").length === count)
    await until(async () => sounds(await data()).some(s => s.args.at(-1).endsWith("question.wav")))
    assert.equal(reviewCount, count)
    assert.ok((await data()).peak <= 24)
    assert.ok(!banners(await data()).some(b => /attention|Unsafe/.test(b.args.at(-1))))
  } else {
    await until(async () => banners(await data()).some(b => b.args.at(-1) === "Session ended"))
    const origin = (await data()).route
    send("F7"); await until(async () => { const d = await data(); return d.other && d.route === d.other })
    send("F8"); await until(async () => (await data()).route === origin)
    assert.doesNotMatch(screen, /Analysis history/)
    send("F9"); await until(async () => (await data()).actions.includes("old-eof"))
    await sleep(700)
    screen = runtime.tmux("capture-pane", "-p", "-t", "w4")
    assert.doesNotMatch(screen, /Analysis history/, "late old approval EOF must not open its saved report")
    assert.equal((await data()).route, origin)
    assert.equal((await data()).starts.filter(s => s.args.includes("org.gnome.Shell.SearchProvider2.ActivateResult")).length, 1)
  }
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ scenario, temp, reviewCount, ...await data() }, null, 2))
  await writeFile(path.join(artifacts, "screen.txt"), screen)
  console.log(`PASS W4 ${scenario}: controlled native-host interleaving; ${artifacts}`)
} catch (error) {
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, temp, screen, errors, data: await data().catch(() => null) }, null, 2))
  throw error
} finally { await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
