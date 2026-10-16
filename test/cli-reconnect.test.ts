import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin/tui"
import { setupCliReconnect } from "../src/cli-reconnect.js"
import type { CliPluginState } from "../src/cli-plugin.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"

const location = { directory: "/server/project", workspaceID: "workspace" }
const handshake = (epoch = "10000000-1000-4000-8000-100000000000") => ({ protocol: 1 as const, hostVersion: "development", epoch,
  location, project: { id: "project", directory: "/server", canonical: "/server" } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function events() {
  const queue: ({ type: string; id: string } | Error | null)[] = []
  let wake = () => {}, subscriptions = 0, closed = 0
  const put = (event: (typeof queue)[number]) => { queue.push(event); wake() }
  return { marker: (id: string) => put({ type: "server.connected", id }), fail: () => put(Error("Network disconnected")),
    end: () => put(null), subscriptions: () => subscriptions, closed: () => closed,
    async *subscribe({ signal }: { signal: AbortSignal }) {
      subscriptions++
      try {
        while (!signal.aborted) {
          if (!queue.length) {
            const aborted = () => wake()
            try {
              await new Promise<void>(resolve => {
                wake = resolve; signal.addEventListener("abort", aborted, { once: true })
              })
            } finally { signal.removeEventListener("abort", aborted) }
          }
          signal.throwIfAborted()
          const event = queue.shift()
          if (event === null) return
          if (event instanceof Error) throw event
          if (event) yield event
        }
      } finally { closed++ }
    } }
}
function fixture(t: TestContext, options: { read?: (signal: AbortSignal, attempt: number) => Promise<unknown>;
  cleanup?: () => Promise<void>; optionalCleanup?: () => Promise<void>; checkpoint?: () => void; initialFallback?: boolean } = {}) {
  let native!: (event: { id: string }) => void, now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const life = new PluginLifecycle(), source = events(), calls: AbortSignal[] = []
  const installations: { signal: AbortSignal; client: unknown; state: CliPluginState; cleaned: boolean }[] = []
  const client = { event: source, rpc: () => ({ handshake: (at: unknown, request: { location: unknown; signal: AbortSignal }) => {
    assert.deepEqual(at, location); assert.deepEqual(request.location, location)
    calls.push(request.signal)
    return options.read?.(request.signal, calls.length) ?? Promise.resolve(handshake())
  } }) }
  const ctx = { location, client, data: { on: (type: string, listener: typeof native) => {
    assert.equal(type, "server.connected"); native = listener
    return () => { native = () => {} }
  } } } as unknown as Plugin.Context
  const state = { connectionID: "initial", companion: options.initialFallback ? undefined : handshake(), config: {}, dependencies: {} } as CliPluginState
  const checkpoints: unknown[] = []
  const recovery = setupCliReconnect(ctx, state, life, (context, next, child) => {
    const value = { signal: child.signal, client: context.client, state: next, cleaned: false }
    installations.push(value)
    child.addCleanup(async () => { await options.cleanup?.(); value.cleaned = true })
    if (options.optionalCleanup) child.addCleanup(options.optionalCleanup, false)
    return value
  }, value => { checkpoints.push(value); options.checkpoint?.() })
  t.after(() => life.stop())
  return { life, source, state, calls, installations, checkpoints, recovery, ctx, native: (id: string) => native({ id }),
    async advance(ms = 0) { now += ms; t.mock.timers.tick(ms); await settle(); await settle() } }
}

test("the continuous public subscriber and delayed native echo leave the admitted generation untouched", async t => {
  const f = fixture(t)
  f.source.marker("initial"); f.native("initial"); await f.advance()
  assert.equal(f.installations.length, 1); assert.equal(f.calls.length, 0)
  assert.equal(f.source.closed(), 0, "Connection observation must not end at its initial marker")
  assert.equal(f.recovery.current(), f.installations[0])
  await f.life.stop(); assert.equal(f.installations[0]!.signal.aborted, true); assert.equal(f.source.closed(), 1)
})

test("network loss retires immediately and reconnect admits a fresh handshake only after native caches agree", async t => {
  const f = fixture(t)
  f.source.marker("initial"); await f.advance()
  f.source.fail(); await f.advance()
  assert.equal(f.installations[0]!.signal.aborted, true); assert.equal(f.recovery.current(), undefined)
  assert.equal(f.state.companion, undefined); assert.equal(f.state.connectionID, undefined)
  await f.advance(250); f.source.marker("next"); await f.advance()
  assert.equal(f.calls.length, 0, "A client-only replacement cannot adopt old native caches")
  f.native("next"); await f.advance()
  assert.equal(f.calls.length, 1); assert.equal(f.installations.length, 2)
  assert.equal(f.state.connectionID, "next"); assert.deepEqual(f.state.companion, handshake())
  assert.equal(f.installations[0]!.cleaned, true)
  assert.deepEqual(f.checkpoints, [f.installations[0]])
})

test("a native-first reconnect fences synchronously and cannot use an old client's marker", async t => {
  const f = fixture(t)
  f.source.marker("initial"); await f.advance()
  f.native("next")
  assert.equal(f.installations[0]!.signal.aborted, true)
  await f.advance(); assert.equal(f.calls.length, 0)
  f.source.marker("next"); await f.advance()
  assert.equal(f.installations.length, 2)
  f.native("next"); f.source.marker("next"); await f.advance()
  assert.equal(f.installations.length, 2, "Duplicate markers cannot restart an admitted generation")
})

test("new pending snapshots cannot be installed until the old generation's physical cleanup settles", async t => {
  const held = deferred<void>()
  const f = fixture(t, { cleanup: () => held.promise })
  f.source.marker("initial"); await f.advance()
  f.native("next"); f.source.marker("next"); await f.advance()
  assert.equal(f.calls.length, 0); assert.equal(f.recovery.current(), undefined)
  held.resolve(); await f.advance()
  assert.equal(f.calls.length, 1); assert.equal(f.installations.length, 2)
})

test("connection churn aborts an old handshake, owns late settlement, and admits only the latest epoch", async t => {
  const held = deferred<unknown>(), fresh = handshake("20000000-1000-4000-8000-100000000000")
  const f = fixture(t, { read: async (_signal, attempt) => attempt === 1 ? held.promise : fresh })
  f.source.marker("initial"); await f.advance()
  f.native("second"); f.source.marker("second"); await f.advance()
  assert.equal(f.calls.length, 1)
  f.native("third"); f.source.marker("third"); await f.advance()
  assert.equal(f.calls[0]!.aborted, true); assert.equal(f.calls.length, 1)
  held.resolve(handshake()); await f.advance()
  assert.equal(f.calls.length, 2); assert.equal(f.installations.length, 2)
  assert.equal(f.state.connectionID, "third"); assert.deepEqual(f.state.companion, fresh)
})

test("a canceled physical read cannot install after timeout or overlap a replacement handshake", async t => {
  const held = deferred<unknown>()
  const f = fixture(t, { read: async (_signal, attempt) => attempt === 1 ? held.promise : handshake() })
  f.source.marker("initial"); await f.advance()
  f.native("second"); f.source.marker("second"); await f.advance()
  await f.advance(1500); await f.advance(8500)
  assert.equal(f.calls[0]!.aborted, true); assert.equal(f.recovery.current(), undefined)
  f.native("third"); f.source.marker("third"); await f.advance()
  assert.equal(f.calls.length, 1)
  held.resolve(handshake()); await f.advance()
  assert.equal(f.installations.length, 2); assert.equal(f.state.connectionID, "third")
})

test("invalid reconnect handshake stays manual until a genuinely new connection", async t => {
  const f = fixture(t, { read: async (_signal, attempt) => attempt === 1 ? { ...handshake(), location: { directory: "/foreign" } } : handshake() })
  f.source.marker("initial"); await f.advance()
  f.native("second"); f.source.marker("second"); await f.advance()
  assert.equal(f.state.companion, undefined); assert.equal(f.state.connectionID, "second")
  assert.equal(f.calls.length, 1); assert.equal(f.installations.length, 2)
  f.native("second"); f.source.marker("second"); await f.advance(20000)
  assert.equal(f.calls.length, 1)
  f.native("third"); f.source.marker("third"); await f.advance()
  assert.deepEqual(f.state.companion, handshake()); assert.equal(f.installations.length, 3)
})

test("startup fallback is not promoted by the same initial marker but can recover on a new connection", async t => {
  const f = fixture(t, { initialFallback: true })
  f.source.marker("initial"); await f.advance()
  assert.equal(f.calls.length, 0)
  f.native("next"); f.source.marker("next"); await f.advance()
  assert.equal(f.calls.length, 1); assert.deepEqual(f.state.companion, handshake())
})

test("subscriber loss cannot promote startup fallback on a replay of the same failed connection marker", async t => {
  const f = fixture(t, { initialFallback: true })
  f.source.marker("initial"); await f.advance()
  f.source.fail(); await f.advance(); await f.advance(250)
  f.source.marker("initial"); await f.advance()
  assert.equal(f.calls.length, 0); assert.equal(f.state.companion, undefined)
  f.native("next"); f.source.marker("next"); await f.advance()
  assert.equal(f.calls.length, 1); assert.deepEqual(f.state.companion, handshake())
})

test("unload aborts reconnect work and owns late handshake settlement without installing", async t => {
  const held = deferred<unknown>()
  const f = fixture(t, { read: async () => held.promise })
  f.source.marker("initial"); await f.advance()
  f.native("next"); f.source.marker("next"); await f.advance()
  const stopped = f.life.stop()
  assert.equal(f.calls[0]!.aborted, true)
  let drained = false
  const draining = f.life.settled().then(() => { drained = true })
  await f.advance(); assert.equal(drained, false)
  held.resolve(handshake()); await stopped; await draining
  assert.equal(f.installations.length, 1); assert.equal(f.recovery.current(), undefined)
  assert.equal(f.source.closed(), 1)
})

test("a replacement public client retires the old subscriber even while its original transport stays healthy", async t => {
  const f = fixture(t), next = events()
  f.source.marker("initial"); await f.advance()
  const old = f.ctx.client, client = { event: next, rpc: old.rpc }
  Object.assign(f.ctx, { client })
  f.native("replacement"); await f.advance()
  assert.equal(f.source.closed(), 1)
  await f.advance(250)
  next.marker("replacement"); await f.advance()
  assert.equal(f.installations.length, 2)
  assert.equal(f.installations[1]!.client, client)
  assert.notEqual(f.installations[1]!.client, old)
})

test("source EOF is a disconnect, but malformed or mismatched markers cannot admit any new companion", async t => {
  const f = fixture(t)
  f.source.marker("initial"); await f.advance(); f.source.end(); await f.advance()
  assert.equal(f.installations[0]!.signal.aborted, true)
  await f.advance(250)
  for (const id of ["", "bad\0marker", "x".repeat(1025)]) {
    f.native(id); f.source.marker(id); await f.advance()
    assert.equal(f.calls.length, 0)
  }
  f.native("native-only"); f.source.marker("client-only"); await f.advance()
  assert.equal(f.calls.length, 0); assert.equal(f.recovery.current(), undefined)
  f.native("client-only"); await f.advance()
  assert.equal(f.calls.length, 1)
})

test("reconnection retries only settled transient reads within one ten-second budget", async t => {
  const f = fixture(t, { read: async () => { throw { type: "rpc.unavailable" } } })
  f.source.marker("initial"); await f.advance()
  f.native("second"); f.source.marker("second"); await f.advance()
  for (let elapsed = 250; elapsed <= 10000; elapsed += 250) await f.advance(250)
  assert.ok(f.calls.length > 1 && f.calls.length <= 40)
  assert.equal(f.installations.length, 2); assert.equal(f.state.companion, undefined)
  const count = f.calls.length
  await f.advance(20000); assert.equal(f.calls.length, count)
  assert.ok(f.calls.every(signal => signal.aborted))
})

test("a settled reconnect timeout uses a fresh attempt signal without overlapping physical reads", async t => {
  const f = fixture(t, { read: async (signal, attempt) => {
    if (attempt === 1) await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
    return handshake()
  } })
  f.source.marker("initial"); await f.advance()
  f.native("second"); f.source.marker("second"); await f.advance()
  await f.advance(1500); assert.equal(f.calls.length, 1)
  await f.advance(250); assert.equal(f.calls.length, 2)
  assert.notEqual(f.calls[0], f.calls[1]); assert.deepEqual(f.state.companion, handshake())
})

test("a failed continuity checkpoint cannot strand the old generation or silently erase once-only protection", async t => {
  const f = fixture(t, { checkpoint: () => { throw Error("Checkpoint unavailable") } })
  f.source.marker("initial"); await f.advance()
  f.native("next"); f.source.marker("next"); await f.advance()
  assert.equal(f.installations[0]!.signal.aborted, true); assert.equal(f.installations[0]!.cleaned, true)
  assert.equal(f.recovery.current(), undefined); assert.equal(f.calls.length, 0)
  assert.equal(f.state.companion, undefined)
})

test("a transient reconnect reset recovers without requiring another connection marker", async t => {
  const f = fixture(t, { read: async (_signal, attempt) => {
    if (attempt === 1) throw Object.assign(Error("temporary reset"), { code: "ECONNRESET" })
    return handshake()
  } })
  f.source.marker("initial"); await f.advance()
  f.native("next"); f.source.marker("next"); await f.advance()
  await f.advance(250)
  assert.deepEqual(f.state.companion, handshake())
  assert.equal(f.state.connectionID, "next")
  assert.equal(f.calls.length, 2)
})

test("a replaced companion epoch admits a fresh generation on the unchanged connection", async t => {
  const fresh = handshake("20000000-1000-4000-8000-100000000000")
  const f = fixture(t, { read: async () => fresh })
  f.source.marker("initial"); await f.advance(); await f.advance(2000)
  assert.equal(f.installations.length, 2)
  assert.equal(f.installations[0]!.signal.aborted, true)
  assert.deepEqual(f.state.companion, fresh)
  assert.equal(f.state.connectionID, "initial")
})

test("healthy companion checks cannot remount a controller or reset its continuity", async t => {
  const f = fixture(t)
  f.source.marker("initial"); await f.advance()
  await f.advance(2000); await f.advance(2000)
  assert.equal(f.calls.length, 2)
  assert.equal(f.installations.length, 1)
  assert.deepEqual(f.checkpoints, [])
})

test("a transport wrapper can recover but certificate and authentication failures stay terminal", async t => {
  for (const failure of [
    { reason: "Transport", cause: { code: "ECONNRESET" } },
    { reason: "Transport", cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } },
    { reason: "UnexpectedStatus", cause: { status: 401 } },
  ]) await t.test(JSON.stringify(failure), async t => {
    const transient = "code" in failure.cause && failure.cause.code === "ECONNRESET"
    const f = fixture(t, { read: async (_signal, attempt) => { if (attempt === 1) throw failure; return handshake() } })
    f.source.marker("initial"); await f.advance()
    f.native("next"); f.source.marker("next"); await f.advance(); await f.advance(250)
    assert.equal(f.calls.length, transient ? 2 : 1)
    assert.deepEqual(f.state.companion, transient ? handshake() : undefined)
    await f.advance(2000)
    assert.equal(f.installations.length, 2, "Health checks cannot promote a terminal fallback")
  })
})

test("optional observer cleanup stays owned but cannot prevent fresh review admission", async t => {
  const held = deferred<void>()
  const f = fixture(t, { optionalCleanup: () => held.promise })
  try {
    f.source.marker("initial"); await f.advance()
    f.native("next"); f.source.marker("next"); await f.advance()
    assert.equal(f.installations.length, 2)
    let settled = false
    const stopped = f.life.stop()
    const draining = f.life.settled().then(() => { settled = true })
    await f.advance(); assert.equal(settled, false, "New admission must not discard ownership of optional cleanup")
    held.resolve(); await stopped; await draining
  } finally { held.resolve(); await f.life.stop() }
})
