import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import { setupCli } from "../src/cli-plugin.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"

test("invalid desktop settings do not disable otherwise valid review configuration", async () => {
  const life = new PluginLifecycle()
  try {
    const context = { app: { version: "unverified" }, options: { baseURL: "http://localhost:40999/v1", model: "reviewer",
      notify: "invalid", stream: true, autoApprove: true }, location: { directory: "/server/project" },
      client: { rpc: () => ({ handshake: async () => { throw Error("Companion unavailable") } }) } } as unknown as Plugin.Context
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
      const state = await setupCli({ app: { version: "unverified" }, options, location: { directory: "/server/project" },
        client: { rpc: () => ({ handshake: async () => { throw Error("Companion unavailable") } }) } } as unknown as Plugin.Context, life, { adapterOnly: true })
      assert.equal(state.config, undefined)
      assert.ok(state.configError)
    } finally { await life.stop() }
  }
})

test("CLI setup does not restrict activation to an explicit host-version list", async () => {
  for (const version of ["2.0.26", "2.0.27", "2.0.28", "2.1.0", "development"]) {
    const life = new PluginLifecycle(), location = { directory: "/server/project" }
    let handshakes = 0
    const context = { app: { version }, location, options: { baseURL: "http://localhost:40999/v1", model: "reviewer", notify: false },
      client: { rpc: () => ({ handshake: async () => {
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
    const context = { app: { version: clientVersion }, location, options: { baseURL: "http://localhost:40999/v1", model: "reviewer", notify: false },
      client: { rpc: () => ({ handshake: async () => {
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
