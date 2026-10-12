// Synthetic W5 public-API probe. No production reviewer/controller or approval writes.
// Scenarios: mouse-on, mouse-off. Register in runtime-inventory before running.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { transformAsync } from "@babel/core"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-v2-root-presentation.mjs")
assert.ok(["mouse-on", "mouse-off"].includes(scenario))
const mouse = scenario === "mouse-on"
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assert.equal(version, "opencode v2.0.26")
await mkdir("/tmp/opencode", { recursive: true })
await mkdir(path.join(root, ".runtime"), { recursive: true })
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-root-presentation-")
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-root-presentation-${scenario}-`))
const project = path.join(temp, "project"), pluginDirectory = path.join(temp, "probe")
const observation = path.join(artifacts, "observations.json"), controlFile = path.join(artifacts, "control.json")
const controlsPublisher = observationPublisher(controlFile)
await mkdir(project)
await mkdir(pluginDirectory)
execFileSync("git", ["init", "--quiet", project])
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nPath("executed").write_text("unexpected approval")\n')
await writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({ name: "research-v2-root-presentation", type: "module", exports: { "./tui": "./tui.mjs" } }))
const report = "# W5 MARKDOWN BODY\n\n**Read only** synthetic report.\n\nCommand: `python3 fixture.py`.\n\nNo approval is dispatched."
const jsx = `
import { Plugin } from '@opencode/plugin/tui'
import { CliRenderEvents, CodeRenderable, SyntaxStyle } from '@opentui/core'
import { createEffect, createSignal, onCleanup, untrack } from 'solid-js'
import { setTimeout as sleep } from 'node:timers/promises'
import { observationPublisher, readObservation } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}
export default Plugin.define({ id:'research.v2.root-presentation', setup(ctx) {
  const publisher = observationPublisher(${JSON.stringify(observation)})
  const abort = new AbortController(), pendingHighlights = new Set(), highlights = new WeakMap()
  const result = { version:ctx.app.version, samples:[], lifecycle:[], highlights:[], commands:[], asked:[], replies:[], errors:[], frames:0 }
  const [rootID, setRootID] = createSignal(), [sidebar, setSidebar] = createSignal()
  const [geometry, setGeometry] = createSignal(undefined, { equals:(a,b) => JSON.stringify(a) === JSON.stringify(b) })
  const style = SyntaxStyle.fromStyles({ default:{fg:'#eeeeee'}, 'markup.heading':{fg:'#70c0ff',bold:true},
    'markup.strong':{bold:true}, 'markup.raw':{fg:'#80e0a0'}, punctuation:{fg:'#bbbbbb'} })
  let panel, heading, markdown, footer, serial = 0, stopped = false, finalizing = false, closing
  const publish = () => publisher.publish(result)
  const options = () => ({ signal:AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const rect = node => node && !node.isDestroyed ? { num:node.num, x:node.x, y:node.y, width:node.width, height:node.height, visible:node.visible } : null
  const owns = (node, hit) => !!node && !node.isDestroyed && (node.num === hit || node.getChildren().some(child => owns(child,hit)))
  const descendants = node => !node || node.isDestroyed ? [] : [node, ...node.getChildren().flatMap(descendants)]
  const rootRoute = () => { const route=ctx.ui.router.current(); return !!rootID() && route.type === 'session' && route.sessionID === rootID() }
  const visible = () => rootRoute() && sidebar()?.sessionID === rootID() && !!geometry()
  const codes = () => descendants(markdown).filter(node => node instanceof CodeRenderable).map(node => {
    const promise=node.highlightingDone
    let state=highlights.get(node)
    if (!state || state.promise !== promise) {
      state={promise,settled:false}; highlights.set(node,state)
      const task=Promise.resolve(promise).then(() => {
        state.settled=true
        if (!stopped && !finalizing) {
          result.highlights.push({num:node.num,at:Date.now(),frameId:ctx.renderer.frameId,current:node.highlightingDone === promise})
          ctx.renderer.requestRender()
        }
      }).catch(error => { result.errors.push(String(error)) }).finally(() => pendingHighlights.delete(task))
      pendingHighlights.add(task)
    }
    return {num:node.num,filetype:node.filetype,highlighting:node.isHighlighting,settled:state.settled}
  })
  const sample = kind => {
    if (stopped) return
    try {
      const owner=sidebar(), anchor=rect(owner?.node), box=rect(panel), code=codes()
      const probes=[['heading',heading],['markdown',markdown],['footer',footer]].map(([name,node]) => {
        const bounds=rect(node)
        if (!bounds || bounds.width < 2 || bounds.height < 1) return {name,owned:false,bounds}
        const x=bounds.x+1, y=bounds.y, hit=ctx.renderer.hitTest(x,y)
        return {name,x,y,hit,owned:owns(node,hit),panelOwned:owns(panel,hit),bounds}
      })
      const matchingGeometry=!!anchor && !!box && anchor.visible && box.visible && visible()
        && ['x','y','width','height'].every(key => anchor[key] === box[key])
        && anchor.width > 0 && anchor.height > 0 && anchor.x >= ctx.renderer.width/2
        && anchor.x+anchor.width <= ctx.renderer.width && anchor.y >= 0 && anchor.y+anchor.height <= ctx.renderer.height
      const highlightReady=!!markdown && !markdown.isDestroyed && markdown.content === ${JSON.stringify(report)}
        && !markdown.streaming && code.length > 0 && code.every(item => item.settled && !item.highlighting)
      // Preserve raw physical observations separately from the public modal input gate.
      // A timer is never a FRAME, and root identity/mount state never substitutes for hit ownership.
      const owned=matchingGeometry && probes.every(probe => probe.owned && probe.panelOwned)
      const mode=ctx.keymap.mode.current()
      const candidate=!!(rootRoute() && ctx.renderer.useMouse && owned && highlightReady && mode === 'base')
      const value={kind,at:Date.now(),frameId:ctx.renderer.frameId,route:JSON.parse(JSON.stringify(ctx.ui.router.current())),mode,
        mouse:ctx.renderer.useMouse,width:ctx.renderer.width,height:ctx.renderer.height,
        sidebar:owner ? {id:owner.id,sessionID:owner.sessionID,anchor} : null,panel:box,probes,code,
        matchingGeometry,highlightReady,owned:!!owned,ownershipCandidate:candidate,
        rootFrameProof:kind === 'frame' && candidate,
        fullscreenCommand:ctx.keymap.commands().some(command => command.id === 'permission.prompt.fullscreen')}
      result.sample=value
      if (kind === 'frame') { result.frame=value; result.frames++ }
      if (result.samples.length >= 16384) throw Error('sample overflow')
      result.samples.push(value)
    } catch(error) { result.errors.push(String(error)) }
    void publish()
  }
  // The native root sidebar supplies the geometry. No inferred preference, fixed
  // center coordinates, descendant panel, private UI import, or native dialog patch.
  const offSidebar=ctx.ui.slot({prepend:'sidebar.content',render:input => {
    const id=++serial
    let node
    result.lifecycle.push({event:'sidebar-mount',id})
    createEffect(() => { setSidebar({id,sessionID:input.sessionID,node}); untrack(() => sample('sidebar-update')) })
    onCleanup(() => {
      if (sidebar()?.id === id) { setSidebar(undefined); setGeometry(undefined) }
      result.lifecycle.push({event:'sidebar-cleanup',id}); sample('sidebar-cleanup')
    })
    return <box ref={value => node=value} height={16} width="100%" flexShrink={0} />
  }})
  const offApp=ctx.ui.slot({append:'app',render:() => <box ref={value => panel=value}
    position="absolute" left={geometry()?.x ?? 0} top={geometry()?.y ?? 0}
    width={geometry()?.width ?? 0} height={geometry()?.height ?? 0}
    visible={visible()} zIndex={1} padding={1} backgroundColor="#102030">
    <text ref={value => heading=value}>W5 ROOT REPORT</text>
    <markdown ref={value => markdown=value} content={${JSON.stringify(report)}} syntaxStyle={style}
      fg="#eeeeee" conceal={true} streaming={false} width="100%" flexShrink={0} />
    <box flexGrow={1} />
    <text ref={value => footer=value}>W5 HELD: NO REPLY</text>
  </box>})
  const events=[ctx.data.on('permission.asked',event => { result.asked.push(event.data); sample('asked') }),
    ctx.data.on('permission.replied',event => { result.replies.push(event.data); sample('replied') })]
  const frame=() => {
    sample('frame')
    // Layout read after a genuine frame; a changed anchor needs a subsequent frame
    // with matching panel bounds before it can produce proof.
    const node=sidebar()?.node
    setGeometry(rootRoute() && node && !node.isDestroyed && node.visible && node.width > 0 && node.height > 0
      ? {x:node.x,y:node.y,width:node.width,height:node.height} : undefined)
  }
  ctx.renderer.on(CliRenderEvents.FRAME,frame)
  const timer=setInterval(() => { sample('timer'); ctx.renderer.requestRender() },100)
  const pending = async () => {
    if (result.asked.length !== 1) throw Error('expected one held permission')
    const request=result.asked[0]
    return ctx.client.permission.get({sessionID:request.sessionID,requestID:request.id},options())
  }
  const navigate = name => {
    if (!['root','child','nested','sibling'].includes(name) || !result[name]) throw Error('unknown route control')
    ctx.ui.router.navigate({type:'session',sessionID:result[name]})
  }
  const loop=(async () => {
    let sequence=0
    while (!abort.signal.aborted && !finalizing) {
      const command=await readObservation(${JSON.stringify(controlFile)},{optional:true})
      if (command && command.sequence > sequence) {
        sequence=command.sequence
        let value
        if (command.type === 'start') {
          const location=ctx.location ?? ctx.data.location.default(), model={providerID:'fixture',id:'fixture'}
          const parent=await ctx.client.session.create({title:'W5 ROOT',location,model},options())
          const child=await ctx.client.session.create({title:'W5 CHILD',parentID:parent.id,location,model},options())
          const nested=await ctx.client.session.create({title:'W5 NESTED',parentID:child.id,location,model},options())
          const sibling=await ctx.client.session.create({title:'W5 SIBLING',parentID:parent.id,location,model},options())
          Object.assign(result,{root:parent.id,child:child.id,nested:nested.id,sibling:sibling.id,
            parents:{child:child.parentID,nested:nested.parentID,sibling:sibling.parentID}})
          setRootID(parent.id); navigate('root')
          value=await ctx.client.session.prompt({sessionID:parent.id,text:'Run python3 fixture.py once.'},options())
        } else if (command.type === 'route') navigate(command.route)
        else if (command.type === 'sidebar-toggle') ctx.keymap.dispatch('session.sidebar.toggle')
        else if (command.type === 'modal') {
          ctx.ui.dialog.set({size:'large',centered:true})
          ctx.ui.dialog.show(() => <box padding={2}><text>W5 PUBLIC MODAL</text><text>Held permission remains unresolved.</text></box>)
        } else if (command.type === 'pending') value=await pending()
        else if (command.type === 'finalize') { value=await pending(); finalizing=true }
        else throw Error('unknown fixture control: '+command.type)
        result.commands.push({sequence,type:command.type,value})
        sample('control'); await publisher.flush()
      }
      if (!finalizing) await sleep(50,undefined,{signal:abort.signal})
    }
  })().catch(error => { if (!abort.signal.aborted) { result.errors.push(String(error)); void publish() } })
  const stop=() => closing ??= (async () => {
    finalizing=true; clearInterval(timer); abort.abort(); await loop
    ctx.renderer.off(CliRenderEvents.FRAME,frame); events.forEach(off => off())
    offSidebar(); offApp()
    // End real Markdown readers before releasing the style they captured.
    markdown?.destroyRecursively()
    await Promise.allSettled([...pendingHighlights])
    style.destroy()
    result.cleaned=true; sample('cleanup'); stopped=true
    await publish(); await publisher.flush(); await publisher.close()
  })()
  // Finalize is a driver-owned end-of-observation command, not a permission reply.
  void loop.then(() => { if (finalizing && !abort.signal.aborted) return stop() })
  sample('setup')
  return stop
}})
`
const compiled = await transformAsync(jsx, { filename: "v2-root-presentation.jsx", configFile: false, babelrc: false,
  presets: [["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid" }]] })
assert.ok(compiled?.code)
await writeFile(path.join(pluginDirectory, "tui.mjs"), compiled.code)
await writeFile(path.join(artifacts, "probe.jsx"), jsx)

const calls = [], errors = [], controls = []
let toolSent = false
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ url: req.url, body })
    const tool = body.tools?.find(item => item.function?.name === "shell")
    const doTool = !toolSent && !!tool
    if (doTool) toolSent = true
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "w5-held-shell", type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: "python3 fixture.py" }) } }] }
      : { role: "assistant", content: "W5 synthetic presentation research" }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [delta, finish_reason] of [[message, null], [{}, doTool ? "tool_calls" : "stop"]])
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: doTool ? "tool_calls" : "stop" }] }))
    }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = (ansi = false) => runtime.tmux("capture-pane", "-p", ...(ansi ? ["-e"] : []), "-t", "v2-root")
const send = key => runtime.tmux("send-keys", "-t", "v2-root", key)
const data = () => readObservation(observation, { optional: true })
const check = async record => {
  assert.deepEqual(errors, [])
  const executed = await readFile(path.join(project, "executed"), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error })
  assert.equal(executed, null, "zero native shell execution")
  if (!record) return
  assert.deepEqual(record.errors, [])
  assert.deepEqual(record.replies, [], "zero permission replies")
  assert.ok(record.asked.length <= 1, "one native request only")
  for (const sample of record.samples) {
    assert.equal(sample.mouse, mouse, "never force mouse tracking")
    if (!mouse) {
      assert.equal(sample.rootFrameProof, false, "mouse disabled never supplies positive proof")
      assert.ok(sample.probes.every(probe => !probe.owned), "no mouse-disabled hit ownership")
    }
    if (sample.route.type !== "session" || sample.route.sessionID !== record.root)
      assert.equal(sample.rootFrameProof, false, "no descendant/non-root frame proof")
  }
}
const until = async (label, predicate, timeout = 45000) => {
  const end = Date.now() + timeout
  do {
    const record = await data(); await check(record)
    if (record && predicate(record, capture())) return record
    await sleep(100)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${scenario}/${label}`)
}
let sequence = 0, lastFrame = -1
const command = async (type, fields = {}) => {
  const id = ++sequence
  await controlsPublisher.publish({ sequence: id, type, ...fields })
  await controlsPublisher.flush()
  const record = await until(`control ${type}/${id}`, record => record.commands.some(item => item.sequence === id))
  return record.commands.find(item => item.sequence === id)
}
const rootShown = (record, screen) => record.asked.length === 1 && [record.sample, record.frame].every(sample =>
  sample && sample.route.type === "session" && sample.route.sessionID === record.root && sample.mode === "base"
  && sample.matchingGeometry && sample.highlightReady && sample.fullscreenCommand
  && sample.ownershipCandidate === mouse)
  && record.frame.rootFrameProof === mouse && screen.includes("W5 ROOT REPORT")
  && screen.includes("W5 MARKDOWN BODY") && screen.includes("W5 HELD: NO REPLY")
  && !screen.includes("Commands") && !screen.includes("minimize")
const noProof = record => [record.sample, record.frame].every(sample => sample && !sample.ownershipCandidate && !sample.rootFrameProof)
const hiddenRoute = route => (record, screen) => noProof(record) && [record.sample, record.frame].every(sample =>
  sample.route.type === "session" && sample.route.sessionID === record[route] && !sample.sidebar && !sample.panel?.visible)
  && !screen.includes("W5 ROOT REPORT") && !screen.includes("W5 MARKDOWN BODY") && !screen.includes("W5 HELD: NO REPLY")
const hold = async (label, predicate, duration = 2000) => {
  const matches = (record, screen) => record.frame?.frameId > lastFrame && predicate(record, screen)
  await until(label, matches)
  const held = await command("pending")
  const baseline = await data()
  let sampleIndex = baseline.samples.length
  const expectedProof = baseline.frame.rootFrameProof
  const start = Date.now(), end = start + duration
  let firstFrame, record, screen
  do {
    record = await data(); screen = capture(); await check(record)
    assert.ok(matches(record, screen), `${label}: stable real presentation control`)
    assert.ok(Date.now() - record.sample.at < 3000, "observer remains live")
    assert.deepEqual(held.value, record.asked[0], "exact native request remains pending")
    for (const sample of record.samples.slice(sampleIndex)) {
      assert.equal(sample.ownershipCandidate, expectedProof, `${label}: no transient ownership reversal in observation window`)
      if (sample.kind === "frame") assert.equal(sample.rootFrameProof, expectedProof, `${label}: every real frame agrees`)
    }
    sampleIndex = record.samples.length
    firstFrame ??= record.frame.frameId
    await sleep(100)
  } while (Date.now() < end)
  assert.ok(record.frame.frameId > firstFrame, "negative/positive window spans multiple genuine frames")
  lastFrame = record.frame.frameId
  controls.push({ label, windowMs: Date.now() - start, firstFrame, frame: record.frame, pending: held.value })
  await writeFile(path.join(artifacts, `${label}.txt`), screen)
  await writeFile(path.join(artifacts, `${label}.ansi.txt`), capture(true))
  await writeFile(path.join(artifacts, `${label}.json`), JSON.stringify(record, null, 2))
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const config = { model: "fixture/fixture", update: "disable", permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 32000, output: 1000 } } } } } }
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  // Leave sidebar preference at the isolated host's default. An inline 'auto'
  // would override the disk preference changed by the real native Hide command.
  const cli = { mouse, animations: false, attention: { notifications: false, sound: false }, session: { permissions: "prompt" }, plugins: [pluginDirectory] }
  const launch = ["-d", "-s", "v2-root", "-x", "160", "-y", "40", "-c", project, "env",
    `OPENCODE_CLI_CONFIG_CONTENT=${JSON.stringify(cli)}`, host, "--standalone", project]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, scenario, temp, config, cli, launch, socket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
  await runtime.start(...launch)
  await command("start")
  await hold("root-initial", rootShown)
  const initial = await data()
  assert.equal(initial.parents.child, initial.root)
  assert.equal(initial.parents.sibling, initial.root)
  assert.equal(initial.parents.nested, initial.child)
  assert.equal(initial.asked[0].sessionID, initial.root)
  for (const route of ["child", "nested", "sibling"]) {
    await command("route", { route })
    await hold(`wide-${route}`, hiddenRoute(route), 3000)
  }
  await command("route", { route: "root" })
  await hold("root-return", rootShown)
  // Test automatic narrow hiding before an explicit native Show can opt into a
  // narrow sidebar. No fixture command forces sidebar visibility on resize.
  runtime.tmux("resize-window", "-t", "v2-root", "-x", "100", "-y", "40")
  await hold("narrow-root", (record, screen) => record.sample.width === 100 && hiddenRoute("root")(record, screen), 3000)
  for (const route of ["child", "nested"]) {
    await command("route", { route })
    await hold(`narrow-${route}`, hiddenRoute(route), 3000)
  }
  await command("route", { route: "root" })
  await hold("narrow-root-return", hiddenRoute("root"), 3000)
  runtime.tmux("resize-window", "-t", "v2-root", "-x", "160", "-y", "40")
  await hold("wide-restored", rootShown)
  await command("sidebar-toggle")
  await hold("native-sidebar-hidden", hiddenRoute("root"), 3000)
  await command("sidebar-toggle")
  await hold("native-sidebar-restored", rootShown)
  // Open the real palette without selecting a command or answering the permission.
  send("C-p")
  await hold("native-palette", (record, screen) => noProof(record) && screen.includes("Commands"), 3000)
  send("Escape")
  await hold("palette-restored", rootShown)
  await command("modal")
  await hold("public-modal", (record, screen) => noProof(record) && screen.includes("W5 PUBLIC MODAL"), 3000)
  send("Escape")
  await hold("modal-restored", rootShown)
  send("C-f")
  await hold("native-permission-fullscreen", (record, screen) => noProof(record) && screen.includes("minimize"), 3000)
  send("C-f")
  await hold("fullscreen-restored", rootShown)
  const final = await command("finalize")
  const cleaned = await until("final publication and cleanup", record => record.cleaned)
  assert.deepEqual(final.value, cleaned.asked[0])
  await sleep(500)
  assert.deepEqual(await data(), cleaned, "no callbacks after final flush/close")
  await check(cleaned)
  assert.equal(cleaned.asked.length, 1)
  assert.ok(toolSent)
  assert.ok(cleaned.highlights.length > 0, "real public highlighting promises settled")
  const mounts = cleaned.lifecycle.filter(item => item.event === "sidebar-mount").map(item => item.id).sort()
  assert.deepEqual(cleaned.lifecycle.filter(item => item.event === "sidebar-cleanup").map(item => item.id).sort(), mounts)
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, scenario, temp, controls, calls,
    conclusion: "Synthetic public root-sidebar/app geometry, Markdown highlighting, frame ownership and native cover controls only. Zero permission replies and zero native shell execution.",
    limitations: "No production controller/reviewer, countdown, cancellation tombstone, fresh approval verification, retained response, history cover or tab-switch acceptance. Mouse-disabled captures never establish positive physical proof. This does not close the V2 presentation gate." }, null, 2))
  console.log(`PASS V2 root presentation (${scenario}): ${artifacts}`)
} catch (error) {
  await writeFile(path.join(artifacts, "failed.txt"), capture()).catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, temp, errors, calls, controls, observations: await data().catch(() => null) }, null, 2))
  throw error
} finally {
  try { await controlsPublisher.close() }
  finally {
    try { await runtime.dispose() }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
}
