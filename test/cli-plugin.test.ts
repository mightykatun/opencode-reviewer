import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin/tui"
import { setupCli } from "../src/cli-plugin.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"

const initialConnectionID = "evt_initial_connection"
const connectedEvents = { async *subscribe() { yield { type: "server.connected" as const, id: initialConnectionID } } }

test("invalid desktop settings do not disable otherwise valid review configuration", async () => {
  const life = new PluginLifecycle()
  try {
    const context = { app: { version: "unverified" }, options: { baseURL: "http://localhost:40999/v1", model: "reviewer",
      notify: "invalid", stream: true, autoApprove: true }, location: { directory: "/server/project" },
      data: { on: () => () => {} },
      client: { event: connectedEvents, rpc: () => ({ handshake: async () => { throw Error("Companion unavailable") } }) } } as unknown as Plugin.Context
    const state = await setupCli(context, life, { adapterOnly: true })
    assert.equal(state.config?.model, "reviewer")
    assert.equal(state.config?.autoApprove, true)
    assert.equal(state.config?.stream, true)
    assert.equal(state.config?.notify, false)
    assert.equal(state.notificationConfig, undefined)
    assert.equal(state.configError, undefined)
  } finally { await life.stop() }
})
test("desktop normalization cannot conceal unknown options or invalid review settings", async () => {
  for (const options of [{ baseURL: "invalid", model: "reviewer", notify: "invalid" },
    { baseURL: "http://localhost:40999/v1", model: "reviewer", notify: "invalid", unknownOption: true }]) {
    const life = new PluginLifecycle()
    try {
      const state = await setupCli({ app: { version: "unverified" }, options, location: { directory: "/server/project" }, data: { on: () => () => {} },
        client: { event: connectedEvents, rpc: () => ({ handshake: async () => { throw Error("Companion unavailable") } }) } } as unknown as Plugin.Context, life, { adapterOnly: true })
      assert.equal(state.config, undefined)
      assert.ok(state.configError)
    } finally { await life.stop() }
  }
})

test("CLI setup does not restrict activation to an explicit host-version list", async () => {
  for (const version of ["2.0.26", "2.0.27", "2.0.28", "2.1.0", "development"]) {
    const life = new PluginLifecycle(), location = { directory: "/server/project" }
    let handshakes = 0
    const context = { app: { version }, location, data: { on: () => () => {} }, options: { baseURL: "http://localhost:40999/v1", model: "reviewer", notify: false },
      client: { event: connectedEvents, rpc: () => ({ handshake: async () => {
        handshakes++
        return { protocol: 1, hostVersion: version, epoch: "10000000-1000-4000-8000-100000000000", location,
          project: { id: "project", directory: "/server", canonical: "/server" } }
      } }) } } as unknown as Plugin.Context
    try {
      const state = await setupCli(context, life, { adapterOnly: true })
      assert.equal(handshakes, 1)
      assert.equal(state.companion?.hostVersion, version)
      assert.equal(state.config?.model, "reviewer")
    } finally { await life.stop() }
  }
})

test("CLI setup binds the connected companion protocol/scope independently of descriptive version numbers", async () => {
  const location = { directory: "/server/project" }
  for (const [clientVersion, serverVersion] of [["2.0.27", "2.0.26"], ["2.0.26", "2.0.27"], ["2.0.28", "2.0.27"]]) {
    const life = new PluginLifecycle()
    let handshakes = 0
    const context = { app: { version: clientVersion }, location, data: { on: () => () => {} }, options: { baseURL: "http://localhost:40999/v1", model: "reviewer", notify: false },
      client: { event: connectedEvents, rpc: () => ({ handshake: async () => {
        handshakes++
        return { protocol: 1, hostVersion: serverVersion, epoch: "10000000-1000-4000-8000-100000000000", location,
          project: { id: "project", directory: "/server", canonical: "/server" } }
      } }) } } as unknown as Plugin.Context
    try {
      const state = await setupCli(context, life, { adapterOnly: true })
      assert.equal(state.companion?.hostVersion, serverVersion)
      assert.equal(handshakes, 1)
    } finally { await life.stop() }
  }
})

const startupLocation = { directory: "/server/project", workspaceID: "workspace" }
const startupHandshake = () => ({ protocol: 1, hostVersion: "development", epoch: "10000000-1000-4000-8000-100000000000",
  location: { ...startupLocation }, project: { id: "project", directory: "/server", canonical: "/server" } })
function startup(t: TestContext, handshake: (signal: AbortSignal, attempt: number) => Promise<unknown>, options = {},
  event = connectedEvents as { subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type: string; id?: string }> }) {
  let now = 0, connected: ((event: { id: string }) => void) | undefined, removed = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const life = new PluginLifecycle(), calls: { location: unknown; signal: AbortSignal }[] = []
  const context = { location: startupLocation, options: { baseURL: "http://localhost:40999/v1", model: "reviewer", notify: true, ...options },
    data: { on: (type: string, listener: (event: { id: string }) => void) => {
      assert.equal(type, "server.connected"); assert.equal(connected, undefined); connected = listener
      return () => { removed++; connected = undefined }
    } }, client: { event, rpc: () => ({ handshake: (location: unknown, request: { signal: AbortSignal; location: unknown }) => {
      assert.deepEqual(request.location, startupLocation); calls.push({ location, signal: request.signal })
      return handshake(request.signal, calls.length)
    } }) } } as unknown as Plugin.Context
  const pending = setupCli(context, life, { adapterOnly: true })
  return { life, pending, calls, connect: (id = "evt_reconnected") => connected?.({ id }), removed: () => removed,
    async advance(ms = 0) { now += ms; t.mock.timers.tick(ms); await settle() } }
}
const untilAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true })
})

test("startup waits for the real initial connection before dispatching its first handshake", async t => {
  let release!: () => void, closed = false
  const marker = new Promise<void>(resolve => { release = resolve })
  const event = { async *subscribe({ signal }: { signal: AbortSignal }) {
    try {
      yield { type: "provider.updated" }
      await Promise.race([marker, untilAbort(signal)])
      yield { type: "server.connected", id: initialConnectionID }
    } finally { closed = true }
  } }
  const f = startup(t, async () => {
    assert.equal(closed, true, "Connection subscriber has returned before RPC dispatch")
    return startupHandshake()
  }, {}, event)
  try {
    await f.advance(); assert.equal(f.calls.length, 0)
    await f.advance(750); f.connect(initialConnectionID); release(); await f.advance()
    assert.deepEqual((await f.pending).companion, startupHandshake())
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0]!.signal.aborted, true, "Settled startup still closes its read signal")
  } finally { release(); await f.life.stop() }
})

test("an already-connected client's current marker admits startup without a new connection event", async t => {
  const f = startup(t, async () => startupHandshake())
  try {
    await f.advance()
    assert.deepEqual((await f.pending).companion, startupHandshake())
    assert.equal(f.calls.length, 1)
  } finally { await f.life.stop() }
})

test("the native bridge's delayed echo of the admitted marker does not abort the initial handshake", async t => {
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  const f = startup(t, async () => held)
  try {
    await f.advance(); assert.equal(f.calls.length, 1)
    f.connect(initialConnectionID); await f.advance()
    assert.equal(f.calls[0]!.signal.aborted, false)
    release(startupHandshake()); await f.advance()
    const state = await f.pending
    assert.deepEqual(state.companion, startupHandshake())
    assert.equal(state.connectionID, initialConnectionID)
    assert.equal(f.calls.length, 1)
  } finally { release(startupHandshake()); await f.life.stop() }
})

test("a marker superseded by a different native connection before handoff cannot admit the old generation", async t => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const event = { async *subscribe() { await held; yield { type: "server.connected", id: initialConnectionID } } }
  const f = startup(t, async () => startupHandshake(), {}, event)
  try {
    await f.advance(); f.connect("evt_new_connection"); release(); await f.advance()
    const state = await f.pending
    assert.equal(state.companion, undefined)
    assert.equal(state.connectionID, undefined, "conflicting initial observations cannot exempt either marker")
    assert.equal(f.calls.length, 0)
  } finally { release(); await f.life.stop() }
})

test("waiting for connection consumes the original startup budget rather than resetting it", async t => {
  let release!: () => void
  const marker = new Promise<void>(resolve => { release = resolve })
  const event = { async *subscribe({ signal }: { signal: AbortSignal }) {
    await Promise.race([marker, untilAbort(signal)])
    yield { type: "server.connected", id: initialConnectionID }
  } }
  const f = startup(t, untilAbort, {}, event)
  try {
    await f.advance(); await f.advance(9000)
    assert.equal(f.calls.length, 0)
    release(); await f.advance(); assert.equal(f.calls.length, 1)
    await f.advance(999); assert.equal(f.calls[0]!.signal.aborted, false)
    await f.advance(1)
    const state = await f.pending
    assert.equal(state.companion, undefined)
    assert.equal(state.connectionID, initialConnectionID, "companion timeout cannot discard the verified marker")
    assert.equal(f.calls[0]!.signal.aborted, true)
    assert.equal(f.calls.length, 1)
  } finally { release(); await f.life.stop() }
})

test("connection timeout retains subscription cleanup ownership and never dispatches an RPC", async t => {
  let release!: () => void, closing = false, closed = false
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const event = { async *subscribe({ signal }: { signal: AbortSignal }) {
    try { await untilAbort(signal); yield { type: "server.connected", id: initialConnectionID } }
    finally { closing = true; await cleanup; closed = true }
  } }
  const f = startup(t, async () => startupHandshake(), {}, event)
  try {
    await f.advance(); await f.advance(10000)
    const state = await f.pending
    assert.equal(state.companion, undefined)
    assert.equal(state.connectionID, undefined)
    assert.equal(closing, true); assert.equal(closed, false)
    assert.equal(f.calls.length, 0)
    let drained = false
    const stopping = f.life.stop()
    const draining = f.life.settled().then(() => { drained = true })
    await f.advance(); assert.equal(drained, false)
    release(); await stopping; await draining; assert.equal(closed, true)
    await f.advance(20000); assert.equal(f.calls.length, 0)
  } finally { release(); await f.life.stop() }
})

test("a failed or marker-free event source stays manual without a speculative handshake", async t => {
  for (const fail of [false, true]) {
    const event = { async *subscribe() {
      yield { type: "provider.updated" }
      if (fail) throw Error("Connection failed")
    } }
    const f = startup(t, async () => startupHandshake(), {}, event)
    try {
      await f.advance()
      const state = await f.pending
      assert.equal(state.companion, undefined)
      assert.equal(state.connectionID, undefined)
      assert.equal(f.calls.length, 0)
    } finally { await f.life.stop(); t.mock.restoreAll(); t.mock.timers.reset() }
  }
})

test("unload while waiting for the initial connection aborts and drains the subscriber", async t => {
  let closed = false
  const event = { async *subscribe({ signal }: { signal: AbortSignal }) {
    try { await untilAbort(signal); yield { type: "server.connected", id: initialConnectionID } }
    finally { closed = true }
  } }
  const f = startup(t, async () => startupHandshake(), {}, event)
  try {
    const rejected = assert.rejects(f.pending, error => error === f.life.signal.reason)
    await f.advance(); await f.life.stop(); await rejected
    assert.equal(closed, true); assert.equal(f.calls.length, 0)
  } finally { await f.life.stop() }
})

test("startup retries a settled handshake timeout using the same connected scope and fresh signal", async t => {
  const f = startup(t, (signal, attempt) => attempt === 1 ? untilAbort(signal) : Promise.resolve(startupHandshake()))
  try {
    await f.advance(); assert.equal(f.calls.length, 1)
    await f.advance(1499); assert.equal(f.calls[0]!.signal.aborted, false)
    await f.advance(1); assert.equal(f.calls[0]!.signal.aborted, true); assert.equal(f.calls.length, 1)
    await f.advance(249); assert.equal(f.calls.length, 1)
    await f.advance(1)
    const state = await f.pending
    assert.deepEqual(state.companion, startupHandshake())
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls.map(call => call.location), [startupLocation, startupLocation])
    assert.notEqual(f.calls[0]!.signal, f.calls[1]!.signal)
    assert.equal(f.removed(), 1)
  } finally { await f.life.stop() }
})

test("startup recovers from an RPC that is not yet registered", async t => {
  const f = startup(t, async (_signal, attempt) => {
    if (attempt < 3) throw { type: "rpc.unavailable" }
    return startupHandshake()
  })
  try {
    await f.advance(); await f.advance(250); await f.advance(250)
    assert.deepEqual((await f.pending).companion, startupHandshake())
    assert.equal(f.calls.length, 3)
  } finally { await f.life.stop() }
})

test("attempt timeouts and connection changes cannot extend the shared startup deadline", async t => {
  const f = startup(t, untilAbort)
  try {
    await f.advance()
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt === 3) f.connect()
      await f.advance(1500); await f.advance(250)
    }
    assert.equal(f.calls.length, 6)
    await f.advance(1249); assert.equal(f.calls[5]!.signal.aborted, false)
    await f.advance(1)
    assert.equal((await f.pending).companion, undefined)
    assert.equal(f.calls[5]!.signal.aborted, true)
    assert.equal(f.calls.length, 6)
  } finally { await f.life.stop() }
})

test("unavailable startup has one fixed ten-second budget and no post-fallback retries", async t => {
  const f = startup(t, async () => { throw { type: "rpc.unavailable" } })
  try {
    await f.advance()
    for (let elapsed = 250; elapsed <= 10000; elapsed += 250) await f.advance(250)
    const state = await f.pending
    assert.equal(state.companion, undefined)
    assert.equal(state.connectionID, initialConnectionID)
    assert.ok(state.config); assert.ok(state.notificationConfig)
    assert.ok(f.calls.length > 1 && f.calls.length <= 40)
    const count = f.calls.length
    f.connect(); await f.advance(20000)
    assert.equal(f.calls.length, count)
    assert.equal(f.removed(), 1)
  } finally { await f.life.stop() }
})

test("startup never overlaps or accepts a timed-out physical read that ignores cancellation", async t => {
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  const f = startup(t, async () => held)
  try {
    await f.advance(); await f.advance(1500); await f.advance(8500)
    const state = await f.pending
    assert.equal(state.companion, undefined); assert.equal(f.calls.length, 1)
    assert.equal(state.connectionID, initialConnectionID)
    let settled = false, stopped = false
    const stopping = f.life.stop().then(() => { stopped = true })
    const draining = f.life.settled().then(() => { settled = true })
    await f.advance(); assert.equal(stopped, false); assert.equal(settled, false)
    release(startupHandshake()); await f.advance(); await stopping; await draining
    assert.equal(state.companion, undefined); assert.equal(f.calls.length, 1)
  } finally { release(startupHandshake()); await f.life.stop() }
})

test("startup retries only after a canceled physical read settles and discards its late success", async t => {
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  const f = startup(t, (_signal, attempt) => attempt === 1 ? held : Promise.resolve(startupHandshake()))
  try {
    await f.advance(); await f.advance(1500); await f.advance(2000)
    assert.equal(f.calls.length, 1)
    release({ ...startupHandshake(), epoch: "20000000-1000-4000-8000-100000000000" })
    await f.advance(); await f.advance(250)
    const state = await f.pending
    assert.deepEqual(state.companion, startupHandshake()); assert.equal(f.calls.length, 2)
    assert.equal(state.connectionID, initialConnectionID)
  } finally { release(startupHandshake()); await f.life.stop() }
})

test("a startup connection event fences the previous handshake before fresh admission", async t => {
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  const f = startup(t, (_signal, attempt) => attempt === 1 ? held : Promise.resolve(startupHandshake()))
  try {
    await f.advance(); f.connect()
    assert.equal(f.calls[0]!.signal.aborted, true)
    release({ ...startupHandshake(), epoch: "20000000-1000-4000-8000-100000000000" })
    await f.advance(); await f.advance(250)
    const state = await f.pending
    assert.deepEqual(state.companion, startupHandshake()); assert.equal(f.calls.length, 2)
    assert.equal(state.connectionID, "evt_reconnected")
  } finally { release(startupHandshake()); await f.life.stop() }
})

test("malformed handshakes and scoped or unexpected errors stay terminal", async t => {
  for (const response of [{ ...startupHandshake(), protocol: 2 }, { ...startupHandshake(), epoch: "invalid" },
    { ...startupHandshake(), location: { directory: "/other" } }, { ...startupHandshake(), location: { ...startupLocation, workspaceID: "other" } },
    { ...startupHandshake(), hostVersion: "" }, { ...startupHandshake(), project: { id: "p", directory: "relative", canonical: "/server" } }]) {
    const f = startup(t, async () => response)
    try { await f.advance(); assert.equal((await f.pending).companion, undefined); assert.equal(f.calls.length, 1) }
    finally { await f.life.stop(); t.mock.restoreAll(); t.mock.timers.reset() }
  }
  for (const error of [{ type: "scope" }, { type: "rpc.internal" }, Error("unexpected")]) {
    const f = startup(t, async () => { throw error })
    try {
      await f.advance()
      const state = await f.pending
      assert.equal(state.companion, undefined); assert.equal(state.connectionID, initialConnectionID)
      assert.equal(f.calls.length, 1)
    }
    finally { await f.life.stop(); t.mock.restoreAll(); t.mock.timers.reset() }
  }
})

for (const phase of ["attempt", "backoff"] as const) test(`unload during startup ${phase} prevents retry and activation`, async t => {
  const f = startup(t, phase === "attempt" ? untilAbort : async () => { throw { type: "rpc.unavailable" } })
  try {
    const rejected = assert.rejects(f.pending, error => error === f.life.signal.reason)
    await f.advance(); await f.life.stop(); await rejected
    f.connect(); await f.advance(20000)
    assert.equal(f.calls.length, 1); assert.equal(f.removed(), 1)
  } finally { await f.life.stop() }
})

test("invalid review configuration does not wait for companion recovery", async t => {
  const f = startup(t, async () => { throw { type: "rpc.unavailable" } }, { model: "" })
  try {
    await f.advance()
    const state = await f.pending
    assert.equal(state.config, undefined); assert.ok(state.notificationConfig)
    assert.equal(state.connectionID, initialConnectionID)
    assert.equal(f.calls.length, 1)
  } finally { await f.life.stop() }
})

test("verified startup follows a native generation change even when the replacement companion fails", async t => {
  let reject!: (error: unknown) => void
  const held = new Promise((_, no) => { reject = no })
  const f = startup(t, (_signal, attempt) => attempt === 1 ? held : Promise.reject(Error("Unavailable companion")))
  try {
    await f.advance(); f.connect("evt_replacement")
    assert.equal(f.calls[0]!.signal.aborted, true)
    reject(Error("Old generation")); await f.advance(); await f.advance(250)
    const state = await f.pending
    assert.equal(state.companion, undefined)
    assert.equal(state.connectionID, "evt_replacement")
    assert.equal(f.calls.length, 2)
  } finally { reject(Error("Disposed")); await f.life.stop() }
})

test("native markers alone cannot verify marker-free startup", async t => {
  let release!: () => void
  const held = new Promise<void>(yes => { release = yes })
  const event = { async *subscribe() { await held; yield { type: "provider.updated" } } }
  const f = startup(t, async () => startupHandshake(), {}, event)
  try {
    await f.advance(); f.connect(initialConnectionID); release(); await f.advance()
    const state = await f.pending
    assert.equal(state.connectionID, undefined); assert.equal(state.companion, undefined)
    assert.equal(f.calls.length, 0)
  } finally { release(); await f.life.stop() }
})

test("malformed public markers never admit an initial-echo exemption", async t => {
  const event = { async *subscribe() {
    for (const id of [undefined, "", "bad\0marker", "x".repeat(1025)]) yield { type: "server.connected", id }
  } }
  const f = startup(t, async () => startupHandshake(), {}, event)
  try {
    await f.advance()
    const state = await f.pending
    assert.equal(state.connectionID, undefined); assert.equal(state.companion, undefined)
    assert.equal(f.calls.length, 0)
  } finally { await f.life.stop() }
})
