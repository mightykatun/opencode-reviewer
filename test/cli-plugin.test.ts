import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { EventEmitter, on } from "node:events"
import type { Plugin } from "@opencode/plugin/tui"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { viewerFeed } from "../src/viewer-feed.js"
import { setupCli } from "../src/cli-plugin.js"
import { viewerFixture } from "./viewer-fixture.js"

test("each subscription filters location, fences old snapshots and recovers from a restarted reviewer", async t => {
  const life = new PluginLifecycle()
  t.after(() => life.stop())
  const location = { directory: "/project" }
  let revision = 4
  let nonce = "10000000-1000-4000-8000-100000000000"
  let off = 0
  const events = new EventEmitter()
  const changed = (event: { location: typeof location }) => events.emit("changed", event)
  const publish: (number | undefined)[] = []
  const client = { rpc: () => ({
    events: { async *subscribe(name: string, { signal }: { signal: AbortSignal }) {
      assert.equal(name, "changed")
      try {
        for await (const [event] of on(events, name, { signal })) yield event
      } finally { off++ }
    } },
    identity: async (_input: unknown, opts: { location: unknown }) => {
      assert.deepEqual(opts.location, location)
      return { nonce, pid: 5 }
    },
    snapshot: async () => ({ location, revision, views: [], review: { enabled: false, reason: "no-policy" } }),
  }) } as unknown as Plugin.Context["client"]
  viewerFeed(client, location, life, data => publish.push(data?.revision))
  await tick()
  revision = 5
  changed({ location: { directory: "/other" } })
  await tick()
  assert.deepEqual(publish, [4])
  changed({ location })
  await tick()
  revision = 3
  changed({ location })
  await tick()
  assert.deepEqual(publish, [4, 5])
  nonce = "invalid"
  changed({ location })
  await tick()
  nonce = "20000000-1000-4000-8000-100000000000"
  changed({ location })
  await tick()
  assert.deepEqual(publish, [4, 5, undefined, 3])
  await life.stop()
  assert.equal(off, 1)
})

test("viewer setup subscribes per location without reading terminal settings and replaces subscriptions after a gap", async t => {
  const f = viewerFixture()
  t.after(() => f.life.stop())
  const life = new PluginLifecycle()
  t.after(() => life.stop())
  const calls: string[] = []
  let connected!: () => void
  let retired = 0
  const ctx = Object.create(f.ctx) as Plugin.Context
  Object.defineProperties(ctx, {
    client: { value: { ...f.ctx.client, rpc: () => ({
      events: { async *subscribe(_name: string, { signal }: { signal: AbortSignal }) {
        try { yield* on(new EventEmitter(), "changed", { signal }) }
        finally { retired++ }
      } },
      identity: async () => ({ nonce: "10000000-1000-4000-8000-100000000000", pid: 1 }),
      statistics: async () => null,
      snapshot: async (_input: unknown, { location }: { location: { directory: string } }) => {
        calls.push(location.directory)
        return { ...f.snapshot, location }
      },
    }) } },
    data: { value: { ...f.ctx.data, on: (_name: string, cb: typeof connected) => { connected = cb
      return () => {} } } },
    ui: { value: { ...f.ctx.ui, tabs: { enabled: () => true, list: () => [{ sessionID: "other" }, { sessionID: "child" }] } } },
  })
  setupCli(ctx, life, {})
  await tick()
  assert.deepEqual(calls.sort(), ["/other", "/server/project"])
  connected()
  await tick()
  assert.equal(retired, 2)
  assert.equal(calls.length, 4)
  await life.stop()
  assert.equal(retired, 4)
})
