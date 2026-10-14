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

async function connectionObserver() {
  const text = await readFile(new URL("../scripts/smoke-v2-lifecycle.mjs", import.meta.url), "utf8")
  const ast = parseSync(text, { sourceType: "module", babelrc: false, configFile: false })
  const node = ast.program.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "observeConnectionMarker")
  assert.ok(node)
  return new Function("assert", `${text.slice(node.start, node.end)}\nreturn observeConnectionMarker`)(assert)
}

test("lifecycle's independent RPC definition matches production read errors without adding handshake errors", async () => {
  const fixture = await readFile(new URL("../scripts/smoke-v2-lifecycle.mjs", import.meta.url), "utf8")
  const fixtureAST = parseSync(fixture, { sourceType: "module", babelrc: false, configFile: false })
  const definition = fixtureAST.program.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "handshakeDefinition")
  assert.ok(definition)
  const rpc = new Function(`${fixture.slice(definition.start, definition.end)}\nreturn handshakeDefinition()`)()
  const source = await readFile(new URL("../src/companion-protocol.ts", import.meta.url), "utf8")
  const ast = parseSync(source, { sourceType: "module", babelrc: false, configFile: false, parserOpts: { plugins: ["typescript"] } })
  const declarations = ast.program.body.flatMap(node => {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node
    return declaration?.type === "VariableDeclaration" ? declaration.declarations : []
  })
  const busy = declarations.find(node => node.id.name === "companionBusy")?.init
  const errors = declarations.find(node => node.id.name === "readErrors")?.init
  assert.equal(busy?.type, "StringLiteral")
  assert.equal(errors?.type, "TSAsExpression")
  assert.equal(errors.expression.type, "ObjectExpression")
  // Evaluate only this fixed literal error schema, never imports or host setup.
  const expected = new Function("companionBusy", `return (${source.slice(errors.expression.start, errors.expression.end)})`)(busy.value)
  assert.deepEqual(rpc.methods.invocation.errors, expected)
  assert.deepEqual(rpc.methods.evidence.errors, expected)
  assert.deepEqual(rpc.methods.handshake.errors, { scope: expected.scope }, "handshake admission has no capacity retry error")
})

test("cold startup independently observes the current real public marker without a native echo and owns subscriber return", async () => {
  const observe = await connectionObserver(), returned = deferred(), closing = deferred(), result = {}, saved = []
  const events = [{ type: "session.created", id: "unrelated" }, { type: "server.connected", id: "actual-current-marker" }]
  const abort = new AbortController()
  const ctx = { client: { event: { subscribe({ signal }) {
    assert.equal(signal, abort.signal)
    return { [Symbol.asyncIterator]() { return this }, next: async () => ({ done: false, value: events.shift() }),
      return() { returned.resolve(); return closing.promise } }
  } } } }
  let settled = false
  const pending = observe(ctx, abort.signal, result, async () => { saved.push(structuredClone(result)) }).then(() => { settled = true })
  await returned.promise
  assert.deepEqual(result, { publicConnection: { id: "actual-current-marker" } })
  assert.deepEqual(saved, [result])
  assert.equal(settled, false, "The real subscriber cleanup still owns physical settlement")
  closing.resolve({ done: true })
  await pending
  assert.equal(settled, true)
})

test("cold startup observer abort cannot record a late marker and retains the pending read and return", async () => {
  const observe = await connectionObserver(), read = deferred(), entered = deferred(), closing = deferred(), returned = deferred()
  const result = {}, abort = new AbortController()
  const ctx = { client: { event: { subscribe() {
    return { [Symbol.asyncIterator]() { return this }, next() { entered.resolve(); return read.promise },
      return() { returned.resolve(); return closing.promise } }
  } } } }
  let settled = false
  const pending = observe(ctx, abort.signal, result, async () => { assert.fail("No publication after abort") })
  const rejected = assert.rejects(pending, { name: "AbortError" }).then(() => { settled = true })
  await entered.promise
  abort.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  read.resolve({ done: false, value: { type: "server.connected", id: "late-marker" } })
  await returned.promise
  assert.deepEqual(result, {})
  assert.equal(settled, false)
  closing.resolve({ done: true })
  await rejected
  assert.equal(settled, true)
})

test("cold startup observer rejects an empty marker ID or an ended stream rather than inventing connection proof", async () => {
  const observe = await connectionObserver()
  for (const events of [[{ type: "server.connected", id: "" }], []]) {
    const result = {}, ctx = { client: { event: { async *subscribe() { yield* events } } } }
    await assert.rejects(observe(ctx, new AbortController().signal, result, async () => { assert.fail("Invalid marker must not be published") }))
    assert.deepEqual(result, {})
  }
})

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

for (const fixtureName of ["smoke-v2-review.mjs", "smoke-v2-notifications.mjs"]) {
  for (const type of ["connection-probe", "remove-probe"]) {
    test(`${fixtureName}: reload drains ${type} and preserves its reply without replaying the native write`, async () => {
      const text = await readFile(new URL(`../scripts/${fixtureName}`, import.meta.url), "utf8")
      const ast = parseSync(text, { sourceType: "module", babelrc: false, configFile: false })
      const monitor = ast.program.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "monitorSetup")
      let source = text.slice(monitor.start, monitor.end)
      if (fixtureName === "smoke-v2-review.mjs") {
        for (const line of ['const { Rpc } = await import("@opencode/plugin/rpc")', 'const { CliRenderEvents } = await import("@opentui/core")'])
          source = source.replace(line, "")
      }
      const entered = deferred(), response = deferred()
      const budgets = [], timeoutMs = type === "connection-probe" ? 8500 : 60000
      const signals = { any: AbortSignal.any, timeout(ms) { budgets.push(ms); return AbortSignal.timeout(ms) } }
      let memory, signal, writes = 0, closed = 0
      const transaction = (_input, options) => {
        writes++; signal = options.signal; entered.resolve()
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          response.promise.then(resolve)
        })
      }
      const ctx = { app: { version: "fixture" },
        storage: { memory(_key, { initial }) { memory ??= structuredClone(initial); return [memory, update => update(memory)] } },
        data: { listen: () => () => {} },
        ui: { router: { current: () => ({ type: "home" }), register: () => () => {} } },
        keymap: { mode: { current: () => "base" }, commands: () => [] },
        renderer: { root: { visible: false }, on() {}, off() {}, useMouse: false, width: 160, height: 40 },
        client: { rpc: () => ({}), session: { create: transaction, remove: transaction } } }
      const publisher = () => ({ publish: () => Promise.resolve(), flush: async () => {}, close: async () => { closed++ } })
      const sleep = (_ms, _value, { signal }) => new Promise((_yes, reject) => {
        if (signal.aborted) { reject(signal.reason); return }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      const setup = new Function("observationPublisher", "fixture", "readObservation", "sleep", "Rpc", "CliRenderEvents", "rpcDefinition", "AbortSignal",
        `${source}\nreturn monitorSetup`)(publisher, { project: "/fixture", initial: "/fixture", control: "control", monitor: "monitor" },
        async () => ({ sequence: 1, type, sessionID: "owned-probe", timeoutMs }), sleep, { define: value => value }, { FRAME: "frame" }, () => ({}), signals)
      const stopFirst = await setup(ctx)
      await entered.promise
      let settled = false
      const stopping = stopFirst().then(() => { settled = true })
      await Promise.resolve()
      assert.equal(signal.aborted, false, "Reload must not discard the reply to an already-dispatched prompt-free write")
      assert.deepEqual(budgets, [Math.min(15000, timeoutMs)], "Drain never raises the native RPC cap or remaining barrier budget")
      assert.equal(settled, false, "Disposal owns the exact native transaction through settlement")
      assert.equal(closed, 0)
      response.resolve(type === "connection-probe" ? { id: "owned-probe" } : undefined)
      await stopping
      const expected = { value: type === "connection-probe" ? { id: "owned-probe" } : null }
      assert.deepEqual(memory.record.replies[1], expected)
      assert.deepEqual(memory.record.errors, [])
      const stopSecond = await setup(ctx)
      await stopSecond()
      assert.equal(writes, 1, "The consumed control can never replay after reload")
      assert.deepEqual(memory.record.replies[1], expected)
      assert.equal(closed, 2)
    })
  }
}

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
