// Pinned-host resource probe. Runs actual built reviewer components in a synthetic app slot.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { transformAsync } from "@babel/core"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation } from "./smoke-observations.mjs"

runtimeArguments("smoke-style-retirement.mjs")
const root = path.resolve(import.meta.dirname, "..")
const host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim(), "1.18.35")
await mkdir("/tmp/opencode", { recursive: true })
const temp = await mkdtemp("/tmp/opencode/reviewer-style-retirement-")
const artifacts = path.join(root, ".runtime/style-retirement")
await mkdir(artifacts, { recursive: true })
const project = path.join(temp, "project")
await mkdir(project)
await mkdir(path.join(temp, "config"))
execFileSync("git", ["init", "--quiet", project])
const bundle = path.join(temp, "bundle.mjs")
let source = await readFile(path.join(root, "dist/tui.js"), "utf8")
// Instrument exactly the reviewer allocation/retirement without changing its policy.
const allocation = "const syntax = SyntaxStyle.fromStyles(reviewSyntaxStyles(props.api.theme.current));"
const retirement = /async function retireDefaultMarkdownStyle\((\w+), (\w+)\) \{/g
assert.equal(source.split(allocation).length, 2)
assert.equal([...source.matchAll(retirement)].length, 1)
source = source.replace(allocation, allocation + " globalThis.__styleProbe.created(syntax);")
  .replace(retirement, (match, style, readers) => match + ` globalThis.__styleProbe.retired(${style}, ${readers});`)
await writeFile(bundle, source + "\nexport { ReviewDescription, ReviewLoading };\n")
const record = path.join(temp, "proof.json")
const wrapper = path.join(temp, "probe.mjs")
const jsx = `
import { createSignal, Show } from 'solid-js'
import { CliRenderEvents, CodeRenderable, MarkdownRenderable } from '@opentui/core'
import { ReviewDescription, ReviewLoading } from ${JSON.stringify(pathToFileURL(bundle).href)}
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}
const publisher = observationPublisher(${JSON.stringify(record)})
const result = { hostVersion: '1.18.35', contract: 'Pinned default Markdown callbacks only; highlightingDone is latest-only, not an all-reader fence.', phases: [], styles: [], errors: [], highWater: {}, postDestroyReads: 0, lateReads: [], overlaps: [], unsupportedAsync: [], frames: 0, streamUpdates: 0, themeChanges: 0, mounts: 0 }
let api, description, phase = 'startup', frame = 0, active, scanner, stream, sequence, setActive, setScanner, setStream, setText, setSequence
const refs = new WeakMap(), styles = new Map(), nodes = new Map()
const now = () => Math.round(performance.now() * 1000) / 1000
function highWater() {
  const pending = result.styles.filter(s => s.retiredAt !== undefined && s.destroyedAt === undefined).length
  result.highWater[phase] = Math.max(result.highWater[phase] ?? 0, pending)
}
function walk(node, reachable = new Set()) {
  if (!node || node.isDestroyed) return
  reachable.add(node.num)
  if (node instanceof CodeRenderable || node instanceof MarkdownRenderable) nodes.set(node.num, new WeakRef(node))
  for (const child of node.getChildren()) walk(child, reachable)
  return reachable
}
function owners(style) {
  const reachable = walk(api.renderer.root)
  const value = { live: 0, detached: 0, destroyed: 0, highlighting: 0 }
  for (const [id, weak] of nodes) {
    const node = weak.deref()
    if (!node) { nodes.delete(id); continue }
    if (node.syntaxStyle !== style) continue
    if (node.isDestroyed) value.destroyed++
    else if (reachable.has(node.num)) value.live++
    else value.detached++
    // isHighlighting can remain true on a destroyed node. The promise counts
    // below cover captured latest promises, not every outstanding transaction.
    if (node instanceof CodeRenderable && node.isHighlighting) value.highlighting++
  }
  return value
}
globalThis.__styleProbe = {
  created(style) {
    const item = { id: result.styles.length + 1, phase, createdAt: now(), nativeEntries: style.getStyleCount() }
    result.styles.push(item); refs.set(style, item); styles.set(item.id, new WeakRef(style))
    const destroy = style.destroy
    style.destroy = function() {
      if (item.destroyedAt !== undefined) { item.duplicateDestroy = (item.duplicateDestroy ?? 0) + 1; return destroy.call(this) }
      item.ownersAtDestroy = owners(this); item.pendingLatestAtDestroy = item.pendingLatest
      item.destroyPhase = phase
      const value = destroy.call(this)
      item.destroyedAt = now(); item.retainedMs = item.destroyedAt - item.retiredAt
      try { this.getStyleCount(); result.errors.push('destroy did not invalidate native style') } catch { item.nativeInvalidated = true }
      return value
    }
    for (const name of ['getStyle', 'getStyleId', 'resolveStyleId', 'mergeStyles', 'getAllStyles', 'getRegisteredNames']) {
      const original = style[name]
      style[name] = function(...args) {
        if (item.destroyedAt !== undefined) { result.postDestroyReads++; if (result.lateReads.length < 32) result.lateReads.push({ id: item.id, name, phase, at: now(), stack: new Error().stack, owners: owners(this) }) }
        return original.apply(this, args)
      }
    }
  },
  retired(style, latest) {
    const item = refs.get(style); item.retiredAt = now(); item.retirePhase = phase; item.ownersAtRetire = owners(style)
    item.pendingLatest = latest.length
    for (const reader of latest) Promise.resolve(reader).then(() => { item.pendingLatest-- }, () => { item.pendingLatest-- })
    highWater()
  },
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, timeout = 15000) {
  const end = performance.now() + timeout
  while (!check()) { if (performance.now() > end) throw Error('probe wait timed out: ' + phase); await pause(20) }
}
function snapshot(label) {
  const alive = result.styles.filter(s => s.destroyedAt === undefined)
  const retired = alive.filter(s => s.retiredAt !== undefined)
  const references = alive.map(s => ({ id: s.id, ...owners(styles.get(s.id).deref()) }))
  const point = { label, at: now(), frames: frame, created: result.styles.length, destroyed: result.styles.length - alive.length,
    pendingRetired: retired.length, nativeEntries: alive.reduce((n,s) => n+s.nativeEntries,0), references,
    scheduler: api.renderer.getSchedulerState(), liveRequests: api.renderer.liveRequestCount, streamUpdates: result.streamUpdates, themeChanges: result.themeChanges }
  result.phases.push(point)
  return point
}
async function save() { result.frames = frame; await publisher.publish(result) }
function codes(node, depth = 0) {
  return [...(node instanceof CodeRenderable ? [{ node, depth }] : []), ...node.getChildren().flatMap(child => codes(child, depth + 1))]
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function changeTheme() { api.theme.set(api.theme.selected === 'opencode' ? 'catppuccin' : 'opencode'); result.themeChanges++ }
function nestedReport() {
  setText('# Nested report\\n\\n> quote **bold** and https://example.invalid\\n\\n- outer item\\n  - nested item with \\x60code\\x60\\n\\n    \\x60\\x60\\x60typescript\\n    const nested = 1;\\n    \\x60\\x60\\x60\\n')
  if (active()) { setSequence(n => n + 1); result.mounts++ } else setActive(true)
  const all = codes(description)
  const deepest = all.filter(item => item.node.filetype === 'markdown').sort((a,b) => b.depth - a.depth)[0]
  if (!deepest || deepest.depth < 2) throw Error('missing nested default Markdown descendant')
  return { ...deepest, count: all.length, maxDepth: Math.max(...all.map(item => item.depth)) }
}
let streamTimer
function streaming(enabled, interval = 40) {
  clearInterval(streamTimer); streamTimer = undefined; setStream(enabled)
  if (enabled) streamTimer = setInterval(() => {
    const n = ++result.streamUpdates
    setText('# Resource probe\\n\\nInline **bold** and \\x60code\\x60.\\n\\n\\x60\\x60\\x60typescript\\nconst frame = ' + n + ';\\nconsole.log(frame)\\n\\x60\\x60\\x60\\n\\nStream ' + n)
  }, interval)
}
async function cycle(label, count, interval, remount = false) {
  phase = label; snapshot(label + '-start')
  for (let i = 0; i < count; i++) {
    if (!api.theme.set(i % 2 ? 'opencode' : 'catppuccin')) throw Error('missing pinned theme')
    result.themeChanges++
    if (remount) { setSequence(n => n + 1); result.mounts++ }
    await pause(interval)
    snapshot(label + '-' + (i + 1))
  }
  await save()
}
export default { id: 'reviewer-style-retirement', tui: async input => {
  api = input
  ;[active, setActive] = createSignal(true)
  ;[scanner, setScanner] = createSignal(false)
  ;[stream, setStream] = createSignal(false)
  ;[sequence, setSequence] = createSignal(1)
  const [text, update] = createSignal('# Resource probe\\n\\n\\x60\\x60\\x60typescript\\nconst value = 1;\\n\\x60\\x60\\x60')
  setText = update
  api.kv.set('animations_enabled', true)
  api.slots.register({ slots: { app: () => <box position="absolute" top={0} right={0} width={60} height={20} zIndex={3} backgroundColor={api.theme.current.backgroundPanel}>
    <Show when={scanner()}><ReviewLoading api={api} retrying={false} /></Show>
    <Show when={active()}><Show when={sequence()} keyed>{_key => <ReviewDescription api={api} text={text()} streaming={stream()} ref={node => { description = node; nodes.set(node.num, new WeakRef(node)) }} />}</Show></Show>
  </box> } })
  const onFrame = () => { frame++; walk(api.renderer.root) }
  api.renderer.on(CliRenderEvents.FRAME, onFrame)
  api.lifecycle.onDispose(async () => {
    clearInterval(streamTimer); api.renderer.off(CliRenderEvents.FRAME, onFrame)
    await publisher.close()
  })
  async function run() {
    try {
      await wait(() => frame > 1 && result.styles.length > 0)
      phase = 'warm'; await pause(1000); snapshot('warm')
      await cycle('idle-theme', 12, 100)
      setScanner(true)
      await cycle('scanner-theme', 40, 80)
      streaming(true)
      await cycle('scanner-stream-theme', 40, 80)
      await cycle('scanner-stream-remount', 40, 80, true)
      streaming(true, 10)
      await cycle('rapid-stream-theme', 40, 80)
      setScanner(false); streaming(false)
      phase = 'idle'; await api.renderer.idle(); await pause(100); snapshot('idle')
      // Positive control: public live ownership explicitly prevents global idle.
      // Distinct from the scanner's 40 ms updates, which may leave idle gaps.
      phase = 'live-control'; api.renderer.requestLive()
      let controlIdle = false
      const idleControl = api.renderer.idle().then(() => { controlIdle = true })
      await cycle('live-control', 16, 80, true)
      result.idleBlockedWhileLive = !controlIdle
      snapshot('live-held'); api.renderer.dropLive()
      phase = 'control-release'; await idleControl; await pause(100); snapshot('control-released')
      // Keep every default callback unchanged. Delay the first parser dispatch
      // of a newly mounted nested CodeRenderable, then optionally let B finish
      // before A. This exercises the actual default revision/destruction guards.
      for (const action of ['theme', 'dispose']) for (const overlap of [false, true]) {
        phase = 'default-' + action + (overlap ? '-overlap' : '-initial')
        api.renderer.requestLive()
        const { node: code, depth, count, maxDepth } = nestedReport()
        const base = code.treeSitterClient, originalHighlight = code.onHighlight, originalChunks = code.onChunks
        const gate = deferred(), first = deferred(), second = deferred()
        const data = { action, overlap, depth, descendants: count, maxDepth, calls: 0, initialHighlighting: code.isHighlighting }
        const proxy = new Proxy(base, { get(target, key) {
          if (key === 'highlightOnce') return async (...args) => {
            const call = ++data.calls
            if (call === 1) { first.resolve(); await gate.promise }
            const value = await target.highlightOnce(...args)
            if (call === 2) second.resolve()
            return value
          }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        code.treeSitterClient = proxy; code.requestRender()
        await first.promise
        const a = code.highlightingDone, held = refs.get(code.syntaxStyle)
        let aSettled = false; void a.then(() => { aSettled = true })
        if (overlap) {
          code.content += '\\nB completes before A'; code.requestRender()
          await second.promise
          const b = code.highlightingDone
          data.distinctPromises = a !== b
          await b; data.bCompletedBeforeA = !aSettled
        }
        if (action === 'theme') {
          changeTheme()
          data.descendantsHandedOff = codes(description).every(({ node }) => node.syntaxStyle === description.syntaxStyle)
        } else setActive(false)
        // Negative-observation window: do not release the deliberately held A.
        await pause(100)
        data.aStillPending = !aSettled
        data.retiredBeforeA = held.destroyedAt !== undefined
        snapshot(phase + '-held')
        gate.resolve(); await a
        await wait(() => held.destroyedAt !== undefined)
        data.defaultCallbacksUnchanged = code.onHighlight === originalHighlight && code.onChunks === originalChunks
        if (!code.isDestroyed) code.treeSitterClient = base
        result.overlaps.push(data)
        snapshot(phase + '-released'); api.renderer.dropLive(); await api.renderer.idle()
      }
      result.defaultPostDestroyReads = result.postDestroyReads
      // Deliberately unsupported mutation seam: custom async callbacks can hold
      // context.syntaxStyle after a newer transaction completes. Reproduce that
      // limitation explicitly; never count this as default-renderer coverage.
      for (const callback of ['onHighlight', 'onChunks']) {
        phase = 'unsupported-async-' + callback; api.renderer.requestLive()
        const { node: code } = nestedReport()
        const original = code[callback], gate = deferred(), first = deferred(), second = deferred()
        const data = { callback, calls: 0, oldStyleReadRejected: false }
        code[callback] = async (value, context) => {
          const call = ++data.calls
          // Preserve the default synchronous callback before adding this custom
          // asynchronous use of its captured style.
          const output = original ? original(value, context) : value
          if (call === 1) {
            first.resolve(); await gate.promise
            try { context.syntaxStyle.getStyle('keyword') }
            catch (error) { data.oldStyleReadRejected = /destroyed/.test(String(error)) }
          }
          if (call === 2) second.resolve()
          return output
        }
        code.requestRender(); await first.promise
        const a = code.highlightingDone, held = refs.get(code.syntaxStyle)
        let aSettled = false; void a.then(() => { aSettled = true })
        code.content += '\\nB supersedes the custom reader A'; code.requestRender()
        await second.promise
        const b = code.highlightingDone
        data.distinctPromises = a !== b
        await b; data.bCompletedBeforeA = !aSettled
        changeTheme(); await wait(() => held.destroyedAt !== undefined)
        data.retiredWhileCustomAOwnedStyle = !aSettled
        gate.resolve(); await a
        if (!code.isDestroyed) code[callback] = original
        result.unsupportedAsync.push(data)
        snapshot(phase); api.renderer.dropLive(); await api.renderer.idle()
      }
      setActive(false)
      phase = 'component-disposal'; await api.renderer.idle(); await pause(100); snapshot('component-disposed')
      result.done = true
    } catch (error) { result.errors.push(String(error)); result.done = true }
    await save(); await publisher.close()
  }
  // Let host slot registration complete before the measured sequence starts.
  void run()
} }
`
const compiled = await transformAsync(jsx, { filename: "style-probe.tsx", babelrc: false, configFile: false,
  presets: [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }]] })
await writeFile(wrapper, compiled.code)
const tui = path.join(temp, "tui.json")
await writeFile(tui, JSON.stringify({ plugin: [wrapper], theme: "opencode" }))
const runtime = await smokeRuntime(temp)
let outcome = "failed"
try {
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"),
    OPENCODE_TUI_CONFIG: tui, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await runtime.start("-d", "-s", "style", "-x", "160", "-y", "40", "-c", project, "env", ...Object.entries(env).map(([k,v]) => k + "=" + v), host, project)
  const end = Date.now() + 120000
  let proof
  while (Date.now() < end) {
    proof = await readObservation(record, { optional: true })
    if (proof?.done) break
    await sleep(200)
  }
  assert.equal(proof?.done, true, "probe completes")
  await writeFile(path.join(artifacts, "result.json"), JSON.stringify(proof, null, 2))
  assert.deepEqual(proof.errors, [])
  assert.equal(proof.defaultPostDestroyReads, 0, "default callbacks never read a retired style")
  assert.equal(proof.postDestroyReads, 2, "both unsupported custom async-reader controls reproduce their limitation")
  assert.ok(proof.lateReads.every(read => read.phase.startsWith("unsupported-async-")))
  const at = label => proof.phases.find(s => s.label === label)
  assert.equal(at("idle").pendingRetired, 0, "production workload drains at idle")
  assert.equal(proof.idleBlockedWhileLive, true, "positive control proves global idle remains blocked")
  assert.equal(at("live-held").pendingRetired, 0, "unrelated live ownership does not retain styles")
  assert.equal(at("control-released").pendingRetired, 0, "releasing live ownership drains control")
  assert.equal(proof.overlaps.length, 4)
  for (const item of proof.overlaps) {
    assert.ok(item.depth >= 2 && item.descendants >= 3, "exercise actual nested default Markdown descendants")
    assert.equal(item.initialHighlighting, false, "intercept the new descendant before initial highlighting")
    assert.equal(item.aStillPending, true, "A stays owned across retirement observation")
    assert.equal(item.retiredBeforeA, item.overlap, "superseded A is not claimed as a captured latest reader")
    assert.equal(item.defaultCallbacksUnchanged, true)
    if (item.overlap) { assert.equal(item.distinctPromises, true); assert.equal(item.bCompletedBeforeA, true) }
    if (item.action === "theme") assert.equal(item.descendantsHandedOff, true)
  }
  assert.equal(proof.unsupportedAsync.length, 2)
  for (const item of proof.unsupportedAsync) {
    assert.equal(item.distinctPromises, true)
    assert.equal(item.bCompletedBeforeA, true)
    assert.equal(item.retiredWhileCustomAOwnedStyle, true)
    assert.equal(item.oldStyleReadRejected, true, "custom async mutation is explicitly outside the production contract")
  }
  assert.equal(at("component-disposed").created, at("component-disposed").destroyed, "component disposal releases every native style")
  assert.ok(proof.styles.every(s => s.nativeInvalidated), "public native access rejects every destroyed handle")
  assert.ok(proof.styles.every(s => s.pendingLatestAtDestroy === 0 && s.ownersAtDestroy.live === 0), "synchronous handoff and captured latest waits precede release; older arbitrary callbacks are not fenced")
  outcome = "passed"
  console.log(JSON.stringify({ outcome, artifacts, created: proof.styles.length, phases: proof.phases.filter(s => /^(warm|idle|live-held|control-released|component-disposed)$/.test(s.label)) }, null, 2))
} finally {
  try {
    await writeFile(path.join(artifacts, "screen.txt"), runtime.tmux("capture-pane", "-p", "-t", "style"))
    await writeFile(path.join(artifacts, "screen.ansi"), runtime.tmux("capture-pane", "-p", "-e", "-t", "style"))
  } finally { await runtime.dispose() }
  console.log("Isolated files: " + temp)
}
