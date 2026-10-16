import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { CliPluginState } from "../src/cli-plugin.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { setupCliReconnect } from "../src/cli-reconnect.js"

test("the reviewer relinquishes a stalled shared source instead of pinning native reconnection to its old marker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let now = 0, opens = 0, aborted = 0, native!: (event: { id: string }) => void
  t.mock.method(performance, "now", () => now)
  const location = { directory: "/fixture/project" }
  const companion = { protocol: 1 as const, hostVersion: "development", epoch: "10000000-1000-4000-8000-100000000000",
    location, project: { id: "project", directory: location.directory, canonical: location.directory } }
  const api = OpenCode.make({ baseUrl: "http://fixture.invalid", fetch: async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/api/event")
    const id = "event-" + ++opens
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ type: "server.connected", id, created: 1, data: {} }) + "\n\n"))
      init!.signal!.addEventListener("abort", () => { aborted++; try { controller.error(init!.signal!.reason) } catch {} }, { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
  } })
  const client = { ...api, rpc: () => ({ handshake: async () => companion }) }
  const firstAbort = new AbortController(), life = new PluginLifecycle()
  const first = api.event.subscribe({ signal: firstAbort.signal })[Symbol.asyncIterator]()
  const initial = await first.next()
  const ctx = { location, client, data: { on: (_type: string, callback: typeof native) => { native = callback; return () => {} } } } as unknown as Plugin.Context
  const state = { connectionID: initial.value!.id, companion, config: {}, dependencies: {} } as CliPluginState
  let installs = 0
  setupCliReconnect(ctx, state, life, () => ({ generation: ++installs }))
  t.after(async () => { firstAbort.abort(); await first.return?.(); await life.stop(); await life.settled() })
  await settle()
  // The native watchdog owns only its subscriber, not the shared transport.
  firstAbort.abort(); await first.return?.()
  now += 45000; t.mock.timers.tick(45000); await settle(); await settle()
  assert.equal(aborted, 1, "The reviewer's own idle boundary must release the remaining shared-source subscription")
  const nextAbort = new AbortController()
  const next = api.event.subscribe({ signal: nextAbort.signal })[Symbol.asyncIterator]()
  try {
    const marker = await next.next()
    assert.notEqual(marker.value!.id, initial.value!.id)
    native({ id: marker.value!.id })
    now += 250; t.mock.timers.tick(250); await settle(); await settle()
    assert.equal(opens, 2)
    assert.equal(installs, 2)
    assert.equal(state.connectionID, marker.value!.id)
  } finally { nextAbort.abort(); await next.return?.() }
})
