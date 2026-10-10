// Real TUI, production SQLite on both adapters, actual root/descendant metadata.
// Dashboard actions perform no model calls or permission writes.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { tsImport } from "tsx/esm/api"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation, publishObservation } from "./smoke-observations.mjs"
import { activatePalette, renditionRows } from "./smoke-ui.mjs"

runtimeArguments("smoke-statistics.mjs")

const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8" }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-statistics-")), project = path.join(temp, "project")
const artifacts = path.join(root, ".runtime/statistics")
await mkdir(project); await mkdir(path.join(temp, "config")); await mkdir(artifacts, { recursive: true })
execFileSync("git", ["init", "--quiet", project])
const bundle = path.join(temp, "bundle.mjs"), wrapper = path.join(temp, "wrapper.mjs"), info = path.join(temp, "sessions.json")
const ancestryControl = path.join(temp, "ancestry-control.json"), ancestryProbe = path.join(temp, "ancestry.json")
await publishObservation(ancestryControl, { release: false })
await copyFile(path.join(root, "dist/tui.js"), bundle)
await writeFile(wrapper, `import plugin from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher, readObservation } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
import { createEffect } from 'solid-js';
export default { id: 'statistics-fixture', tui: async (api, options) => {
  let ids = await readObservation(${JSON.stringify(info)}, {optional:true}) ?? {};
  const facts = { reads: {}, active: 0, maximum: 0, aborted: 0 };
  const probePublisher = observationPublisher(${JSON.stringify(ancestryProbe)});
  const publisher = observationPublisher(${JSON.stringify(info)});
  const probe = () => probePublisher.publish(facts);
  const held = id => id && (id === ids.stalled || id === ids.historyStalled);
  const sessions = new Proxy(api.state.session, { get(target, key) {
    if (key === 'get') return id => held(id) ? undefined : target.get(id);
    return Reflect.get(target, key);
  }});
  const state = new Proxy(api.state, { get(target, key) { return key === 'session' ? sessions : Reflect.get(target, key); }});
  const session = new Proxy(api.client.session, { get(target, key) {
    if (key !== 'get') return Reflect.get(target, key);
    return async (params, opts) => {
      if (!held(params.sessionID)) return target.get(params, opts);
      facts.reads[params.sessionID] = (facts.reads[params.sessionID] || 0) + 1;
      facts.active++; facts.maximum = Math.max(facts.maximum, facts.active); await probe();
      try {
        // Deliberately ignores abort until released, like a noncooperative host transport.
        while (!(await readObservation(${JSON.stringify(ancestryControl)})).release)
          await new Promise(resolve => setTimeout(resolve, 50));
        if (opts.signal.aborted) facts.aborted++;
        return { data: api.state.session.get(params.sessionID) };
      } finally { facts.active--; await probe(); }
    };
  }});
  const client = new Proxy(api.client, { get(target, key) { return key === 'session' ? session : Reflect.get(target, key); }});
  const adapted = new Proxy(api, { get(target, key) { return key === 'client' ? client : key === 'state' ? state : Reflect.get(target, key); }});
  await plugin.tui(adapted, options);
  let permissions = 0, replies = 0;
  api.event.on('permission.asked', () => permissions++); api.event.on('permission.replied', () => replies++);
  const save = () => publisher.publish({...ids, permissions, replies, route:api.route.current.params?.sessionID});
  createEffect(() => { api.route.current; void save(); });
  const off = api.keymap.registerLayer({ commands: [
    {name:'fixture.prepare', namespace:'palette', title:'Fixture: Prepare statistics', run:async () => {
      ids.root = api.route.current.params.sessionID;
      const create = async (title, parentID) => (await api.client.session.create({directory:api.state.path.directory, title, parentID}, {throwOnError:true})).data.id;
      ids.child = await create('Statistics child', ids.root); ids.deep = await create('Statistics deep child', ids.child);
       ids.other = await create('Statistics other root');
       for (const name of ['stalled','latest','historyStalled','historyLatest']) ids[name] = await create('Ownership ' + name);
       await save();
    }},
     ...['root','child','deep','other','stalled','latest','historyStalled','historyLatest'].map(name => ({name:'fixture.'+name, namespace:'palette', title:'Fixture: '+name,
      run:() => api.route.navigate('session', {sessionID:ids[name]})}))
  ]});
   api.lifecycle.onDispose(async () => { off(); save(); probe(); await Promise.all([publisher.close(), probePublisher.close()]); });
} };`)
const { HistorySQL } = await tsImport("../src/history-schema.ts", import.meta.url)
const { encodeEvent } = await tsImport("../src/history-records.ts", import.meta.url)
const { privateDatabase } = await tsImport("../src/history-storage-worker.ts", import.meta.url)
const file = path.join(temp, "state/opencode/opencode-reviewer/history-v1.sqlite")
const runtime = await smokeRuntime(temp)
let calls = 0, sql, ids, sequence = 0
const server = createServer(async (req, res) => {
  for await (const chunk of req) void chunk
  calls++; res.writeHead(200, { "Content-Type": "text/event-stream" })
  const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  res.end(frame({ role: "assistant", content: "Statistics fixture ready." }, null) + frame({}, "stop") + "data: [DONE]\n\n")
})
const send = (...keys) => runtime.tmux("send-keys", "-t", "statistics", ...keys)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "statistics")
const selectedScope = scope => renditionRows(runtime.tmux("capture-pane", "-p", "-e", "-t", "statistics")).some(row => {
  const at = row.text.indexOf(scope)
  return row.text.includes("Conversation") && row.text.includes("Lifetime") && at >= 0
    && row.backgrounds.slice(at - 1, at + scope.length + 1).every(color => color === "157,124,216")
})
const until = async (check, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check(capture())) return; await sleep(100) }
  throw new Error(`Statistics wait timed out: ${capture()}`)
}
const save = name => writeFile(path.join(artifacts, `${name}.txt`), capture())
const palette = async title => {
  const postcondition = title === "Reviewer: Statistics" ? s => s.includes("Reviewer statistics") && selectedScope("Lifetime")
    : title === "Reviewer: Report history" ? s => s.includes("Analysis history")
    : title === "Reviewer: Disable for conversation" ? s => s.includes("Reviewer disabled for this conversation.")
    : title === "Fixture: Prepare statistics" ? async () => !!(await readObservation(info, { optional: true }))?.deep
    : async () => (await readObservation(info)).route === ids[title.slice("Fixture: ".length)]
  await activatePalette({ send, capture: () => runtime.tmux("capture-pane", "-p", "-e", "-t", "statistics") }, title, postcondition)
}
const open = async () => { await palette("Reviewer: Statistics"); await until(s => s.includes("Reviewer statistics") && selectedScope("Lifetime")) }
const close = async () => { send("Escape"); await until(s => !s.includes("Reviewer statistics")) }
const check = async (lines, scope) => {
  await until(s => selectedScope(scope) && lines.every(line => s.includes(line)))
  assert.doesNotMatch(capture(), /\[Conversation\]|\[Lifetime\]|Recorded Reviewer activity|Partial history:|\(partial history\)|before history tracking/)
}
const rootLines = ["Reviews: 3", "Retries: 3", "Tokens: 1.2k in 90 out", "Cost: $0.0900", "Safe: 2 (66.7%)", "Unsafe: 1 (33.3%)",
  "Auto-approved: 2 (66.7%)", "Average time to full report: 0.20s", "Average time to rating: 0.10s"]
const lifetimeLines = ["Reviews: 4", "Retries: 4", "Tokens: 3.2k in 120 out", "Cost: $0.1200", "Safe: 3 (75.0%)", "Unsafe: 1 (25.0%)",
  "Auto-approved: 3 (75.0%)", "Average time to full report: 0.40s", "Average time to rating: 0.20s"]
const seed = (session, owner, n, safe) => {
  const context = { scope: project, root: owner, session, review: `r-${n}`, permission: `p-${n}`, category: "bash",
    configuredModel: "fixture", provider: "https://fixture.invalid/v1" }
  const apply = event => sql.apply("statistics-fixture", ++sequence, encodeEvent({ context, at: 1, ...event }))
  apply({ type: "attemptDispatched", attempt: "first", retry: "initial" })
  apply({ type: "attemptFinalized", attempt: "first", usage: { input: n, output: 10, cost: 0.01 } })
  apply({ type: "attemptDispatched", attempt: "second", retry: "format" })
  apply({ type: "attemptFinalized", attempt: "second", usage: { input: n + 20, output: 20, cost: 0.02 } })
  apply({ type: "reviewAccepted", accepted: { safe, completedAt: 2, timing: { fullReportMs: n, ratingMs: n / 2 } } })
  apply({ type: "approvalConfirmed", approval: "confirmed", automatic: safe })
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false, provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", options: { baseURL: base, apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } } }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ plugin: [[wrapper, { notify: false, baseURL: base, model: "fixture" }]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  const start = (...args) => runtime.start("-d", "-s", "statistics", "-x", "160", "-y", "40", "-c", project, "env",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`), host, project, ...args)
  await start("--prompt", "Say ready.")
  await until(s => s.includes("Statistics fixture ready.") && s.includes("tab agents"), 90000)
  await until(() => calls >= 2); await sleep(500)
  await palette("Fixture: Prepare statistics")
  await until(async () => { ids = await readObservation(info, { optional: true }); return !!ids?.deep })
  privateDatabase(file); sql = new HistorySQL(new DatabaseSync(file))
  seed(ids.root, ids.root, 100, true); seed(ids.child, ids.root, 200, false); seed(ids.deep, ids.root, 300, true)
  seed(ids.other, ids.other, 1000, true)
  const before = sql.query({ type: "totals" }), modelCalls = calls
  await open(); await check(lifetimeLines, "Lifetime"); await save("lifetime")
  send("Tab"); await check(rootLines, "Conversation"); await save("conversation-root")
  // Exercise click switching as well as the public dialog-mode Tab binding.
  const line = capture().split("\n").findIndex(line => line.includes("Conversation") && line.includes("Lifetime"))
  const x = capture().split("\n")[line].indexOf("Lifetime") + 2
  for (const release of [false, true]) send("-l", `\x1b[<0;${x};${line + 1}${release ? "m" : "M"}`)
  await check(lifetimeLines, "Lifetime"); await close()
  for (const child of ["child", "deep"]) {
    await palette(`Fixture: ${child}`); await open(); send("Tab"); await check(rootLines, "Conversation"); await save(child); await close()
  }
  await palette("Fixture: other"); await open(); send("Tab")
  await check(["Reviews: 1", "Tokens: 2k in 30 out", "Safe: 1 (100.0%)"], "Conversation"); await save("other-root"); await close()
  assert.deepEqual(sql.query({ type: "totals" }), before, "switching/reopening does not account new work")
  await palette("Fixture: root"); await palette("Reviewer: Disable for conversation")
  await open(); send("Tab"); await check(rootLines, "Conversation"); await save("disabled"); await close()
  runtime.tmux("kill-session", "-t", "statistics")
  await start("--session", ids.deep); await until(s => s.includes("Subagent"), 90000)
  await open(); send("Tab"); await check(rootLines, "Conversation"); await save("resumed-descendant")
  seed(ids.deep, ids.root, 400, true)
  await check(["Reviews: 4", "Retries: 4", "Tokens: 2k in 120 out", "Safe: 3 (75.0%)"], "Conversation"); await save("shared-update")
  const persisted = sql.query({ type: "totals" })
  await close(); runtime.tmux("kill-session", "-t", "statistics")
  sql.close(); sql = undefined
  const old = new DatabaseSync(file); old.exec("DROP TABLE conversation_totals"); old.close()
  await start("--session", ids.root); await until(s => s.includes("tab agents"), 90000)
  await open(); send("Tab")
  await check(["Reviews: 4", "Tokens: 2k in 120 out"], "Conversation"); await save("retained-v1-baseline")
  sql = new HistorySQL(new DatabaseSync(file))
  assert.deepEqual(sql.query({ type: "totals" }), persisted)
  assert.equal(calls, modelCalls, "statistics browsing and resume do not invoke models")
  const facts = await readObservation(info)
  assert.equal(facts.permissions, 0); assert.equal(facts.replies, 0)
  // Actual production controller -> coordinator -> SessionModes composition,
  // driven through public UI commands while its host metadata read ignores abort.
  seed(ids.latest, ids.latest, 777, false)
  const ancestry = () => readObservation(ancestryProbe)
  const releaseAncestry = release => publishObservation(ancestryControl, { release })
  await close(); await palette("Fixture: stalled")
  for (let n = 0; n < 4; n++) {
    await open(); send("Tab"); await until(s => selectedScope("Conversation") && s.includes("Loading"))
    await close()
  }
  await palette("Fixture: latest"); await open(); send("Tab")
  await until(s => selectedScope("Conversation") && s.includes("Loading"))
  assert.equal((await ancestry()).reads[ids.stalled], 1)
  assert.equal((await ancestry()).active, 1)
  await releaseAncestry(true)
  await check(["Reviews: 1", "Tokens: 1.5k in 30 out", "Unsafe: 1 (100.0%)"], "Conversation")
  await save("ancestry-statistics-recovered"); await close()
  await until(async () => (await ancestry()).active === 0)
  await releaseAncestry(false)
  const context = { scope: project, root: ids.historyLatest, session: ids.historyLatest, review: 'ownership-report',
    permission: 'ownership-permission', category: 'bash', configuredModel: 'fixture', provider: 'https://fixture.invalid/v1' }
  sql.apply("ownership-fixture", 1, encodeEvent({ type: 'permissionResolved', context, at: 3, outcome: 'manual',
    payload: { safe: false, completedAt: 3, desc: 'Newest ancestry history report' } }))
  await palette("Fixture: historyStalled")
  const openHistory = async () => { await palette("Reviewer: Report history"); await until(s => s.includes("Analysis history")) }
  for (let n = 0; n < 4; n++) {
    await openHistory(); await until(s => s.includes("Loading history"))
    send("Escape"); await until(s => !s.includes("Analysis history"))
  }
  await palette("Fixture: historyLatest"); await openHistory()
  assert.equal((await ancestry()).reads[ids.historyStalled], 1)
  assert.equal((await ancestry()).active, 1)
  await releaseAncestry(true)
  await until(s => s.includes("Newest ancestry history report"))
  await save("ancestry-history-recovered")
  const ownership = await ancestry()
  assert.equal(ownership.maximum, 1); assert.equal(ownership.active, 0); assert.equal(ownership.aborted, 2)
  assert.equal(calls, modelCalls)
  await writeFile(path.join(artifacts, "ancestry.json"), JSON.stringify(ownership, null, 2))
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ temp, ids, calls, status: "passed" }, null, 2))
  console.log(`PASS statistics: both scopes, root/child/deep ancestry, independent roots, Tab/click, disabled mode, restart, shared persistence, partial v1 baseline, held ancestry reopen storms and newest-selection recovery in statistics/history; ${temp}`)
} catch (error) {
  await save("failed").catch(() => {})
  await writeFile(path.join(artifacts, "failure.txt"), `${error.stack}\n${temp}`)
  throw error
} finally {
  await publishObservation(ancestryControl, { release: true })
  sql?.close(); await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
