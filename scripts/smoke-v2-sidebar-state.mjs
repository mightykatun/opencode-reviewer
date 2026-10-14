// Synthetic V2 public-state probe. No reviewer, model prompt, or permission replies.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { readObservation } from "./smoke-observations.mjs"

runtimeArguments("smoke-v2-sidebar-state.mjs")
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assertV2HostVersion(version)
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
await mkdir("/tmp/opencode", { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-sidebar-state-"))
const controls = []

// Separate, serial hosts keep startup environment precedence independently testable.
for (const variant of ["disk", "env"]) {
  const temp = await mkdtemp("/tmp/opencode/reviewer-v2-sidebar-state-")
  const project = path.join(temp, "project"), plugin = path.join(temp, "probe")
  const destination = path.join(artifacts, variant), cliPath = path.join(temp, "config/opencode/cli.json")
  await mkdir(destination)
  await mkdir(project)
  await mkdir(plugin)
  await mkdir(path.dirname(cliPath), { recursive: true })
  smokeGitInit(temp, project)
  await writeFile(path.join(project, "opencode.json"), JSON.stringify({ update: "disable" }))
  const observation = path.join(destination, "observations.json")
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-sidebar-state", type: "module", exports: { "./tui": "./tui.mjs" } }))
  await writeFile(path.join(plugin, "tui.mjs"), `
import { Plugin } from '@opencode/plugin/tui'
import { CliRenderEvents } from '@opentui/core'
import { createEffect, onCleanup } from 'solid-js'
import { readFileSync } from 'node:fs'
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}
export default Plugin.define({ id:'research.v2.sidebar-state', setup(ctx) {
  const publisher = observationPublisher(${JSON.stringify(observation)})
  const abort = new AbortController(), tasks = new Set(), sidebars = new Map(), panels = new Map()
  const result = { version:ctx.app.version, frames:0, samples:[], lifecycle:[], commands:[], asked:[], replies:[], executions:[], errors:[] }
  let serial = 0, stopped = false
  const publish = () => publisher.publish(result)
  const sample = kind => {
    if (stopped) return
    try {
      // Independent documented inputs, deliberately NOT called the host's reactive config.
      const disk = JSON.parse(readFileSync(${JSON.stringify(cliPath)}, 'utf8'))
      const inline = JSON.parse(process.env.OPENCODE_CLI_CONFIG_CONTENT || '{}')
      const command = ctx.keymap.commands().find(item => item.id === 'session.sidebar.toggle')
      const value = { kind, at:Date.now(), frameId:ctx.renderer.frameId,
        route:ctx.ui.router.current(), mode:ctx.keymap.mode.current(),
        sidebar:[...sidebars.values()], panels:[...panels.values()], ownPanel:ctx.ui.panel.current() ?? null,
        command:command ? { id:command.id, title:command.title, shortcuts:ctx.keymap.shortcuts(command.id) } : null,
        input:{ disk:disk.session?.sidebar ?? null, env:inline.session?.sidebar ?? null,
          candidate:inline.session?.sidebar ?? disk.session?.sidebar ?? 'auto' } }
      result.sample=value
      if (kind === 'frame') { result.frames++; result.frame=value }
      if (result.samples.length >= 4096) throw Error('sample overflow')
      result.samples.push(value)
    } catch(error) { result.errors.push(String(error)) }
    void publish()
  }
  const own = fn => {
    const task=Promise.resolve().then(fn).catch(error => result.errors.push(String(error))).finally(() => { tasks.delete(task); sample('task') })
    tasks.add(task)
  }
  const offSidebar=ctx.ui.slot({ append:'sidebar.content', render:input => {
    const id=++serial
    result.lifecycle.push({event:'sidebar-mount',id})
    createEffect(() => { sidebars.set(id,{sessionID:input.sessionID}); sample('sidebar-update') })
    onCleanup(() => { sidebars.delete(id); result.lifecycle.push({event:'sidebar-cleanup',id}); sample('sidebar-cleanup') })
    return null
  } })
  const offPanel=ctx.ui.slot({ append:'session.panel', render:input => {
    const id=++serial
    createEffect(() => { panels.set(id,{name:input.name,sessionID:input.sessionID,presentation:input.presentation,width:input.width,focused:input.focused}); sample('panel-update') })
    onCleanup(() => { panels.delete(id); sample('panel-cleanup') })
    return null
  } })
  const offEvents=[ctx.data.on('permission.asked',event => { result.asked.push(event.data); sample('asked') }),
    ctx.data.on('permission.replied',event => { result.replies.push(event.data); sample('replied') }),
    ctx.data.on('session.execution.started',event => { result.executions.push(event.data); sample('execution') })]
  const frame=() => sample('frame')
  ctx.renderer.on(CliRenderEvents.FRAME,frame)
  const timer=setInterval(() => { sample('timer'); ctx.renderer.requestRender() },100)
  const navigate = sessionID => { if(sessionID) { ctx.ui.router.navigate({type:'session',sessionID}); sample('navigate') } }
  ctx.keymap.layer(() => ({mode:'global',priority:200,commands:[
    {bind:'f6',run:() => navigate(result.root)}, {bind:'f7',run:() => navigate(result.child)},
    {bind:'f8',run:() => {
      sample('before-native-command'); const before=result.sample
      ctx.keymap.dispatch('session.sidebar.toggle')
      sample('after-native-command'); result.commands.push({before,after:result.sample}); void publish()
    }}
  ]}))
  own(async () => {
    const options=() => ({signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])})
    const parent=await ctx.client.session.create({title:'SIDEBAR STATE ROOT',location:ctx.location},options())
    const child=await ctx.client.session.create({title:'SIDEBAR STATE CHILD',parentID:parent.id,location:ctx.location},options())
    result.root=parent.id; result.child=child.id; result.childParent=child.parentID
    navigate(parent.id)
  })
  sample('setup')
  return async () => {
    clearInterval(timer); ctx.renderer.off(CliRenderEvents.FRAME,frame); offEvents.forEach(off => off())
    abort.abort(); await Promise.allSettled([...tasks]); offSidebar(); offPanel()
    sample('cleanup'); stopped=true; result.cleaned=true; await publish(); await publisher.close()
  }
} })
`)
  const cli = { animations: false, attention: { notifications: false, sound: false }, session: { sidebar: "auto" }, plugins: [plugin] }
  const inline = variant === "env" ? { session: { sidebar: "hide" } } : {}
  const writeCLI = async value => {
    await writeFile(`${cliPath}.next`, JSON.stringify(value))
    await rename(`${cliPath}.next`, cliPath)
  }
  await writeCLI(cli)
  const runtime = await smokeRuntime(temp)
  const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-sidebar")
  const send = key => runtime.tmux("send-keys", "-t", "v2-sidebar", key)
  const data = () => readObservation(observation, { optional: true })
  const check = record => {
    if (!record) return
    assert.deepEqual(record.errors, [])
    assert.deepEqual(record.asked, [])
    assert.deepEqual(record.replies, [])
    assert.deepEqual(record.executions, [])
  }
  const until = async (label, predicate, timeout = 45000) => {
    const end = Date.now() + timeout
    do {
      const record = await data(); check(record)
      if (record && predicate(record)) return record
      await sleep(100)
    } while (Date.now() < end)
    throw Error(`Timed out waiting for ${variant}/${label}`)
  }
  // Reachable shortcut sets matter here, not duplicate registrations across route mounts.
  // Preserve the unmodified command observation in each sample/frame artifact.
  const publicState = sample => ({ sidebar: sample.sidebar,
    command: sample.command && { ...sample.command, shortcuts: [...new Set(sample.command.shortcuts)].sort() },
    panels: sample.panels, ownPanel: sample.ownPanel, mode: sample.mode })
  // This is a painted native-title control, not geometry or hit-test ownership proof.
  const paintedSidebar = screen => screen.split("\n").some(line => line.slice(118).includes("SIDEBAR STATE ROOT"))
  let lastFrame = 0
  const hold = async (label, route, sidebar, disk) => {
    const matches = record => record.frame?.frameId > lastFrame && [record.sample, record.frame].every(sample =>
      sample.route.type === "session" && sample.route.sessionID === record[route]
      && sample.sidebar.length === Number(sidebar) && (!sidebar || sample.sidebar[0].sessionID === record.root)
      && sample.command?.title === (sidebar ? "Hide sidebar" : "Show sidebar")
      && sample.input.disk === disk && sample.input.env === (inline.session?.sidebar ?? null)
      && sample.panels.length === 0 && sample.ownPanel === null)
    await until(label, matches)
    const start = Date.now(), end = start + 1500
    let firstFrame, record, screen
    do {
      record = await data(); check(record); screen = capture()
      assert.ok(matches(record), `${variant}/${label}: stable public state`)
      assert.equal(paintedSidebar(screen), sidebar, `${variant}/${label}: real native sidebar title at right`)
      assert.ok(Date.now() - record.sample.at < 3000, "observer remains live")
      firstFrame ??= record.frame.frameId
      await sleep(100)
    } while (Date.now() < end)
    assert.ok(record.frame.frameId > firstFrame, "settled window spans multiple native frames")
    lastFrame = record.frame.frameId
    const control = { variant, label, windowMs: Date.now() - start, firstFrame, frame: record.frame, publicState: publicState(record.frame), paintedSidebar: paintedSidebar(screen) }
    controls.push(control)
    await writeFile(path.join(destination, `${label}.txt`), screen)
    await writeFile(path.join(destination, `${label}.json`), JSON.stringify(record, null, 2))
    return control
  }
  try {
    const launch = ["-d", "-s", "v2-sidebar", "-x", "160", "-y", "40", "-c", project, "env",
      `OPENCODE_CLI_CONFIG_CONTENT=${JSON.stringify(inline)}`, host, "--standalone", project]
    await writeFile(path.join(destination, "setup.json"), JSON.stringify({ version, temp, cli, inline, launch, socket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
    await runtime.start(...launch)
    const initialized = await until("created root and child", record => record.root && record.child)
    assert.equal(initialized.childParent, initialized.root)
    if (variant === "disk") {
      await hold("root-auto", "root", true, "auto")
      send("F7")
      const auto = await hold("child-auto", "child", false, "auto")
      await writeCLI({ ...cli, session: { sidebar: "hide" } })
      const hide = await hold("child-hide", "child", false, "hide")
      assert.deepEqual(hide.publicState, auto.publicState, "descendant public observations coincide")
      // A descendant's unchanged observations cannot themselves acknowledge config application.
      // Root return is the independent witness that the native watcher consumed hide.
      send("F6")
      await hold("root-hide", "root", false, "hide")
      send("F7")
      const hideConfirmed = await hold("child-hide-confirmed", "child", false, "hide")
      assert.deepEqual(hideConfirmed.publicState, auto.publicState)
      await writeCLI(cli)
      await hold("child-auto-reloaded", "child", false, "auto")
      send("F6")
      await hold("root-auto-reloaded", "root", true, "auto")
      send("F7")
      const confirmed = await hold("child-auto-confirmed", "child", false, "auto")
      assert.deepEqual(confirmed.publicState, hideConfirmed.publicState)
      send("F6")
      await hold("root-before-command", "root", true, "auto")
      send("F8")
      await hold("native-hide", "root", false, "hide")
      send("F8")
      await hold("native-show", "root", true, "auto")
    } else {
      await hold("env-hide-over-disk-auto", "root", false, "auto")
      send("F7")
      await hold("env-child", "child", false, "auto")
      send("F6")
      await hold("env-root-before-command", "root", false, "auto")
      send("F8")
      // Native explicit show can open the root sidebar locally despite the env preference.
      const shown = await hold("env-native-show", "root", true, "auto")
      assert.equal(shown.frame.input.candidate, "hide")
      send("F7")
      await hold("env-child-after-command", "child", false, "auto")
      send("F6")
      await hold("env-root-remounted", "root", false, "auto")
    }
    const beforeCleanup = await data()
    await writeFile(path.join(destination, "commands.json"), JSON.stringify(beforeCleanup.commands, null, 2))
    assert.equal(beforeCleanup.commands.length, variant === "disk" ? 2 : 1)
    const currentCLI = JSON.parse(await readFile(cliPath, "utf8"))
    await writeCLI({ ...currentCLI, plugins: ["*", "-research.v2.sidebar-state"] })
    const cleaned = await until("plugin cleanup", record => record.cleaned)
    await sleep(500)
    assert.deepEqual(await data(), cleaned, "no post-cleanup observation callbacks")
    const mounts = cleaned.lifecycle.filter(item => item.event === "sidebar-mount").map(item => item.id).sort()
    assert.ok(mounts.length > 0)
    assert.deepEqual(cleaned.lifecycle.filter(item => item.event === "sidebar-cleanup").map(item => item.id).sort(), mounts)
  } catch (error) {
    await writeFile(path.join(destination, "failed.txt"), capture()).catch(() => {})
    await writeFile(path.join(destination, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, observations: await data().catch(() => null) }, null, 2))
    throw error
  } finally { await runtime.dispose() }
}
await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, controls,
  conclusion: "In these controls, descendant sidebar slot, reachable toggle/title, panel and mode observations coincide for auto and hide. Root frames independently confirm config reloads. Disk/env reads expose configured inputs, not a same-commit host preference or physical presentation contract; the env/native-show control also has a local visibility override. No claim of exhaustive API impossibility.",
}, null, 2))
console.log(`PASS V2 sidebar state: ${artifacts}`)
