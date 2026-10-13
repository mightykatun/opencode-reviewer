import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const { parseSync } = createRequire(path.resolve("package.json"))("@babel/core")
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

for (const fixtureName of ["smoke-v2-review.mjs", "smoke-v2-notifications.mjs"]) {
  test(`${fixtureName}: disposal owns a late control read without consuming or dispatching its command`, async () => {
    const text = await readFile(new URL(`../scripts/${fixtureName}`, import.meta.url), "utf8")
    const ast = parseSync(text, { sourceType: "module", babelrc: false, configFile: false })
    const monitor = ast.program.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "monitorSetup")
    assert.ok(monitor)
    let source = text.slice(monitor.start, monitor.end)
    if (fixtureName === "smoke-v2-review.mjs") {
      // Only the fixed fixture monitor is evaluated. Its two public host imports
      // are recording stubs, not package/runtime code or a real-host acceptance.
      for (const line of ['const { Rpc } = await import("@opencode/plugin/rpc")', 'const { CliRenderEvents } = await import("@opentui/core")']) {
        assert.equal(source.split(line).length, 2)
        source = source.replace(line, "")
      }
    }
    const held = deferred(), entered = deferred(), snapshots = []
    let created = 0, closed = false, unsubscribed = false, memory
    const ctx = {
      app: { version: "fixture" },
      storage: { memory(_key, { initial }) { memory = structuredClone(initial); return [memory, update => update(memory)] } },
      data: { listen() { return () => { unsubscribed = true } } },
      ui: { router: { current: () => ({ type: "home" }), register: () => () => {} } },
      keymap: { mode: { current: () => "base" }, commands: () => [] },
      renderer: { root: { visible: false }, on() {}, off() {}, useMouse: false, width: 160, height: 40 },
      client: { rpc: () => ({}), session: { async create(_input, options) {
        created++
        options.signal.throwIfAborted()
        return { id: "must-not-create" }
      } } },
    }
    const publisher = () => ({ publish(value) { snapshots.push(structuredClone(value)); return Promise.resolve() },
      flush: async () => {}, close: async () => { closed = true } })
    const read = () => { entered.resolve(); return held.promise }
    const sleep = async (_ms, _value, { signal }) => { signal.throwIfAborted() }
    const setup = new Function("observationPublisher", "fixture", "readObservation", "sleep", "Rpc", "CliRenderEvents", "rpcDefinition",
      `${source}\nreturn monitorSetup`)(publisher, { project: "/fixture", initial: "/fixture", control: "control", monitor: "monitor" },
      read, sleep, { define: value => value }, { FRAME: "frame" }, () => ({}))
    const stop = await setup(ctx)
    await entered.promise
    let settled = false
    const stopping = stop().then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false, "disposal retains the real unresolved file read")
    assert.equal(unsubscribed, true)
    held.resolve({ sequence: 1, type: "connection-probe" })
    await stopping
    assert.equal(created, 0, "no native transaction starts after disposal")
    assert.equal(memory.sequence, 0, "a fresh monitor may still consume this unstarted command")
    assert.deepEqual(memory.record.replies, {})
    assert.deepEqual(snapshots.at(-1).errors, [])
    assert.equal(snapshots.at(-1).cleaned, true)
    assert.equal(closed, true)
  })
}

test("notification monitor reload repeats an aborted read without replaying side effects", async () => {
  const text = await readFile(new URL("../scripts/smoke-v2-notifications.mjs", import.meta.url), "utf8")
  const ast = parseSync(text, { sourceType: "module", babelrc: false, configFile: false })
  const monitor = ast.program.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "monitorSetup")
  const entered = deferred(), replied = deferred()
  let memory, reads = 0, writes = 0
  const ctx = { app: { version: "fixture" },
    storage: { memory(_key, { initial }) { memory ??= structuredClone(initial); return [memory, update => update(memory)] } },
    data: { listen: () => () => {} }, ui: { router: { current: () => ({ type: "home" }) } },
    keymap: { mode: { current: () => "base" } },
    client: { plugin: { list(_input, { signal }) {
      if (++reads > 1) return Promise.resolve({ data: [] })
      entered.resolve()
      return new Promise((_yes, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    } }, session: { create() { writes++; throw Error("No side effects") } } } }
  const publisher = () => ({ publish(value) {
    if (value.replies[1]) replied.resolve()
    return Promise.resolve()
  }, flush: async () => {}, close: async () => {} })
  const sleep = (_ms, _value, { signal }) => new Promise((_yes, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
  const setup = new Function("observationPublisher", "fixture", "readObservation", "sleep",
    `${text.slice(monitor.start, monitor.end)}\nreturn monitorSetup`)(publisher, { project: "/fixture", monitor: "monitor", control: "control" },
    async () => ({ sequence: 1, type: "plugins" }), sleep)
  const stopFirst = await setup(ctx)
  await entered.promise
  await stopFirst()
  assert.equal(memory.sequence, 0, "an interrupted read remains unconsumed")
  const stopSecond = await setup(ctx)
  await replied.promise
  await stopSecond()
  assert.equal(reads, 2)
  assert.equal(writes, 0)
  assert.equal(memory.sequence, 1)
  assert.deepEqual(memory.record.replies[1].value, { data: [] })
})

test("notification fixture acknowledges dispatch before held observation writes, which disposal still owns", async () => {
  const text = await readFile(new URL("../scripts/smoke-v2-notifications.mjs", import.meta.url), "utf8")
  const ast = parseSync(text, { sourceType: "module", babelrc: false, configFile: false })
  const setupNode = ast.program.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "reviewerSetup")
  const held = deferred(), snapshots = []
  let hold = false, backend, closed = false
  const publisher = () => ({ publish(record) {
    snapshots.push(structuredClone(record))
    return hold ? held.promise : Promise.resolve()
  }, flush: () => hold ? held.promise : Promise.resolve(), close: async () => { closed = true } })
  const production = { withHistoryObservations(_history, _options, factory) { return {
    async setup() { backend = factory(() => {}, { notifications: {} }); return () => backend.dispose() },
  } } }
  const setup = new Function("observationPublisher", "fixture", "readObservation", "production", "nativeSnapshot", "assert",
    `${text.slice(setupNode.start, setupNode.end)}\nreturn reviewerSetup`)(publisher,
    { notifications: { main: "observation" }, setupControl: "control" }, async () => ({ phase: "main" }), production, () => ({}), assert)
  const stop = await setup({})
  hold = true
  const abort = new AbortController()
  const handle = await backend.show({ kind: "attention", sessionID: "fixture" }, abort.signal)
  await handle.dispatched
  assert.equal(snapshots.at(-1).events.filter(event => event.type === "show").length, 1)
  let settled = false
  const stopping = stop().then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, "cleanup retains the actual observation write")
  assert.equal(closed, false)
  held.resolve()
  await stopping
  assert.equal(closed, true)
  assert.equal(snapshots.at(-1).cleaned, true)
  assert.equal(snapshots.at(-1).owned, 0)
})
