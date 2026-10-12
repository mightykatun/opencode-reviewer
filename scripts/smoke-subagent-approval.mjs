// Real native task/permission flow with root-only reviewer presentation.
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

const { scenario } = runtimeArguments("smoke-subagent-approval.mjs")
const fast = scenario === "fast" || scenario === "fast-nonstream"
const streaming = !["nonstream", "fast-nonstream"].includes(scenario)
const negative = ["dialog", "fullscreen", "hide", "unrelated"].includes(scenario)
const delay = fast ? 45 : scenario === "zero" ? 0 : negative ? 4 : 8
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8" }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-subagent-approval-")), project = path.join(temp, "project")
const artifacts = await mkdtemp(path.join(root, ".runtime", "subagent-approval-" + scenario + "-"))
await mkdir(project); await mkdir(path.join(temp, "config"))
execFileSync("git", ["init", "--quiet", project])
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nimport sys\nwith Path("executions").open("a") as f: f.write(sys.argv[1] + "\\n")\n')
const bundle = path.join(temp, "bundle.mjs"), plugin = path.join(temp, "plugin.mjs"), records = path.join(artifacts, "observations.json")
await copyFile(path.join(root, "dist/tui.js"), bundle)
await writeFile(plugin, `
import { withHistoryObservations } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
import { createEffect } from 'solid-js';
import { CliRenderEvents, TextRenderable } from '@opentui/core';
export default {id:'subagent-approval-fixture', tui:async (api, options) => {
  const data = {asked:[], replies:[], renders:[], scenes:[], notifications:[], errors:[]};
  const publisher = observationPublisher(${JSON.stringify(records)});
  const save = () => publisher.publish(data);
  let click, previous;
  createEffect(() => {data.route = api.route.current.params?.sessionID; void save();});
  api.event.on('session.created', event => {
    const info = event.properties.info;
    if (!info.parentID && !data.root) data.root = info.id;
    if (info.parentID === data.root && !data.child) {
      data.child = info.id;
      void (async () => {
        const create = async (parentID, title) => (await api.client.session.create({directory:api.state.path.directory, parentID, title}, {throwOnError:true})).data.id;
        data.sibling = await create(data.root, 'F34 sibling');
        data.nested = await create(data.child, 'F34 nested');
        data.other = await create(undefined, 'Unrelated conversation');
        await save();
      })().catch(error => {data.errors.push(String(error)); void save();});
    }
    void save();
  });
  api.event.on('permission.asked', event => {data.asked.push({...event.properties, at:Date.now()}); void save();});
  api.event.on('permission.replied', event => {data.replies.push({...event.properties, at:Date.now(), route:data.route}); void save();});
  const text = (node, wanted) => {
    if (!node.visible || node.isDestroyed) return;
    if (node instanceof TextRenderable && node.plainText === wanted) return node;
    for (const child of node.getChildren()) { const found = text(child, wanted); if (found) return found; }
  };
  const scene = () => {
    const physical = wanted => { const node = text(api.renderer.root, wanted); return !!node && api.renderer.hitTest(node.x, node.y) === node.num; };
    const covers = [];
    const inspect = (node, parent) => {
      if (!node.visible || node.isDestroyed) return;
      if (parent && node.x <= 2 && node.y <= 1 && node.x + node.width >= api.renderer.width - 2 && node.y + node.height >= api.renderer.height - 2
        && (node.y < parent.y || node.y + node.height > parent.y + parent.height)) covers.push({node:node.num, y:node.y, height:node.height, parentY:parent.y, parentHeight:parent.height});
      for (const child of node.getChildren()) inspect(child,node);
    };
    inspect(api.renderer.root);
    const value = {route:data.route, width:api.renderer.width, live:physical('Permission analysis'), history:physical('Analysis history'), covers,
      ancestry:[data.route,data.child,data.root].map(id=>id && ({id,parent:api.state.session.get(id)?.parentID,known:!!api.state.session.get(id)}))};
    const signature = JSON.stringify(value);
    if (signature !== previous) {previous = signature; data.scenes.push({...value, at:Date.now()}); void save();}
  };
  api.renderer.on(CliRenderEvents.FRAME, scene);
  await withHistoryObservations(event => {
    if (event.stage === 'frame' && event.auto && data.renders.length < 512) {
      data.renders.push({...event, route:data.route, wallAt:Date.now()}); void save();
    }
  }, undefined, callback => {click = callback; return {show:async event => {
    data.notifications.push(event); await save(); return {close(){}};
  }, dispose(){}};})(api, options);
  const off = api.keymap.registerLayer({priority:200, mode:'base', bindings:[
    ...[['f6','child'],['f7','sibling'],['f8','nested'],['f9','root'],['f10','other']].map(([key, field]) => ({key, cmd:() => {
      if (data[field]) api.route.navigate('session', {sessionID:data[field]});
    }})),
    {key:'f11', cmd:() => {const event = data.notifications.find(e => e.kind === 'approved'); if (event) click(event.sessionID,event.history);}}
  ]});
  api.lifecycle.onDispose(async () => {off(); api.renderer.off(CliRenderEvents.FRAME,scene); save(); await publisher.close();});
}};
`)
const calls = [], reviews = [], errors = []
let delegated = false, step = 0, db
const chunk = (content, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`
const server = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const part of req) raw += part
    const body = JSON.parse(raw); calls.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      assert.equal(body.stream, streaming)
      if (streaming) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders() }
      const entry = { at: Date.now(), body, rate() {res.write(chunk('{"safe":true,"desc":"F34 report'));}, finish() {
        entry.finishedAt = Date.now()
        if (streaming) res.end(chunk('"}') + chunk("", "stop") + "data: [DONE]\n\n")
        else {res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: {
          content: '{"safe":true,"desc":"F34 report"}' }, finish_reason: "stop" }] }));}
      } }
      reviews.push(entry); return
    }
    const child = JSON.stringify(body.messages.filter(m => m.role === "user").at(-1)?.content).includes("F34_DELEGATION")
    let tool, input
    if (body.tools?.some(t => t.function.name === "bash")) {
      if (!child && !delegated) { delegated = true; tool = "task"; input = {subagent_type:"general", description:"F34 fixture", prompt:"F34_DELEGATION: Run python3 fixture.py first and python3 fixture.py second."} }
      else if (child && step < 2) {tool = "bash"; input = {command:"python3 fixture.py " + (step++ ? "second" : "first"), description:"F34 fixture execution"};}
    }
    const message = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "f34-" + tool + step, type: "function", function: { name: tool, arguments: JSON.stringify(input) } }] }
      : { role: "assistant", content: "F34 fixture complete." }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[message, null], [{}, tool ? "tool_calls" : "stop"]])
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) {errors.push(String(error)); res.destroy();}
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "subagent")
const send = (...keys) => runtime.tmux("send-keys", "-t", "subagent", ...keys)
const data = () => readObservation(records)
const executed = async () => (await readFile(path.join(project, "executions"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
const until = async (check, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {if (await check(capture())) return; await sleep(80);}
  throw Error("Subagent approval fixture timed out")
}
const navigate = async (key, field) => {send(key); await until(async () => {const d = await data(); return d.route === d[field];});}
const saved = () => {
  db ??= new DatabaseSync(path.join(temp, "state/opencode/opencode-reviewer/history-v1.sqlite"), { readOnly: true })
  return db.prepare("SELECT h.permission,p.body FROM history h JOIN payloads p ON p.id=h.id").all()
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model:"fixture/fixture", small_model:"fixture/fixture", autoupdate:false, permission:{bash:"ask", task:"allow"},
    provider:{fixture:{npm:"@ai-sdk/openai-compatible", options:{baseURL:base + "/main",apiKey:"synthetic"}, models:{fixture:{name:"Fixture",limit:{context:32000,output:1500}}}}} }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({plugin:[[plugin,{baseURL:base + "/review",model:"fixture",autoApprove:true,fastMode:fast,stream:streaming,
    autoApproveDelaySeconds:delay,timeoutMs:120000,notifySound:false,staleReminderSeconds:0}]]}))
  const env = {OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_CONFIG:"",OPENCODE_CONFIG_DIR:path.join(temp,"config"),OPENCODE_TUI_CONFIG:tui,
    OPENCODE_DISABLE_AUTOUPDATE:"1",OPENCODE_DISABLE_PROJECT_CONFIG:"1",OPENCODE_DISABLE_DEFAULT_PLUGINS:"1",OPENCODE_DISABLE_MODELS_FETCH:"1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS:"1",OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:"1"}
  await runtime.start("-d","-s","subagent","-x","160","-y","40","-c",project,"env",...Object.entries(env).map(([k,v])=>k+"="+v),host,project,
    "--prompt","Delegate both isolated fixture steps to a general subagent.")
  await until(async s => reviews.length === 1 && (await data()).other && s.includes("Permission analysis"), 90000)
  const activeCountdown = !fast && delay > 0
  if (activeCountdown) {
    if (streaming) reviews[0].rate()
    reviews[0].finish()
    await until(s => s.includes(`Allowed in ${delay}s`))
  }
  // The pinned host presents native permissions only at root. Prove that its
  // actual fullscreen cancellation cannot be erased by subsequent child browsing.
  if (scenario === "fullscreen") {send("C-f"); await until(s => s.includes("minimize"));}
  // Its sidebar command is also root-only; hiding must remain explicit across
  // descendant navigation rather than treating the absent child sidebar as hide.
  if (scenario === "hide") {send("C-x", "b"); await until(s => !s.includes("Permission analysis"));}
  await navigate("F6","child")
  await until(s => !s.includes("Permission analysis"))
  if (negative) {
    if (scenario === "dialog") {send("C-p"); await until(s => s.includes("Commands"));}
    if (scenario === "unrelated") await navigate("F10","other")
    await sleep((delay + 1) * 1000)
    assert.deepEqual(await executed(), [])
    assert.equal((await data()).replies.length, 0)
    if (scenario === "dialog") {send("Escape"); await until(s => !s.includes("Commands"));}
    await navigate("F9","root")
    if (scenario === "hide") send("C-x", "b")
    await until(s => s.includes("Auto-approval canceled"))
    await sleep(600); assert.deepEqual(await executed(), [])
  } else {
    await navigate("F7","sibling"); await navigate("F8","nested")
    runtime.tmux("resize-window","-t","subagent","-x","80","-y","40")
    await until(async s => (await data()).scenes.at(-1)?.width === 80 && !s.includes("Permission analysis"))
    if (activeCountdown) {
      runtime.tmux("resize-window","-t","subagent","-x","160","-y","40")
      await until(async () => (await data()).scenes.at(-1)?.width === 160)
      await navigate("F9","root"); await until(s => s.includes("Allowed in"))
      await navigate("F8","nested")
    } else {
      if (streaming) reviews[0].rate()
      if (!fast || !streaming) reviews[0].finish()
    }
    await until(async () => (await executed()).length === 1)
    const first = (await data()).replies[0]
    assert.notEqual(first.route,(await data()).root,"approval completes while browsing a descendant")
    if (activeCountdown) {
      const started = (await data()).renders.find(r => r.auto === "countdown").wallAt
      assert.ok(first.at - started < delay * 1000 + 2200,"returning to root did not restart the countdown")
    }
    if (fast && streaming) {
      assert.equal(saved().length,0,"unfinished fast report is not persisted")
      runtime.tmux("resize-window","-t","subagent","-x","160","-y","40")
      await navigate("F9","root"); await until(s => s.includes("Auto-approved; finishing report"))
      await navigate("F8","nested"); reviews[0].finish()
    }
    await until(() => reviews.length === 2)
    if (streaming) reviews[1].rate()
    if (!fast || !streaming) {await sleep(300); assert.deepEqual(await executed(),["first"]);}
    reviews[1].finish()
    if (!fast && delay > 0) {
      await until(async () => (await data()).renders.some(r => r.auto === "countdown" && r.wallAt >= reviews[1].finishedAt))
      await sleep(1200)
      await navigate("F9", "root")
      await until(s => s.includes("Allowed in"))
      assert.doesNotMatch(capture(), new RegExp(`Allowed in ${delay}s`), "a report completed while hidden returns with elapsed time")
      await navigate("F8", "nested")
    }
    await until(async () => (await executed()).length === 2)
    await until(() => saved().length === 2)
    const observed = await data()
    assert.deepEqual(observed.replies.map(r=>r.reply),["once","once"])
    assert.ok(observed.replies.every(r=>r.route !== observed.root))
    if (!fast && delay > 0) assert.ok(observed.replies[1].at - reviews[1].finishedAt < delay * 1000 + 2200,
      "root return did not restart a countdown that began while hidden")
    assert.ok(observed.scenes.filter(s=>[observed.child,observed.sibling,observed.nested].includes(s.route)).every(s=>!s.live && !s.history))
    assert.ok(observed.notifications.every(n=>!["attention","unsafe","error"].includes(n.kind)))
    runtime.tmux("resize-window","-t","subagent","-x","160","-y","40")
    send("F11"); await until(s=>s.includes("Analysis history") && s.includes("F34 report"))
    assert.equal((await data()).route,observed.root,"approval click returns to root-only report history")
    assert.doesNotMatch(capture(),/Allowed in|Permission analysis/)
    assert.equal(reviews.length,2)
  }
  assert.deepEqual(errors,[]); assert.deepEqual((await data()).errors,[])
  await writeFile(path.join(artifacts,"final.txt"),capture())
  await writeFile(path.join(artifacts,"results.json"),JSON.stringify({scenario,temp,observations:await data(),calls},null,2))
  console.log(`PASS subagent approval ${scenario}: root-only panel, route-scoped automation; ${artifacts}`)
} catch (error) {
  await writeFile(path.join(artifacts,"failed.txt"),capture()).catch(()=>{})
  await writeFile(path.join(artifacts,"failure.json"),JSON.stringify({error:String(error),stack:error.stack,temp,errors,calls},null,2))
  throw error
} finally {db?.close(); await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
