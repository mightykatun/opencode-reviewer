import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import { setupCli } from "../src/cli-plugin.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"

test("invalid desktop settings do not disable otherwise valid review configuration", async () => {
  const life = new PluginLifecycle()
  try {
    const context = { app: { version: "unverified" }, options: { baseURL: "http://localhost:40999/v1", model: "reviewer",
      notify: "invalid", stream: true, autoApprove: true } } as unknown as Plugin.Context
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
      const state = await setupCli({ app: { version: "unverified" }, options } as unknown as Plugin.Context, life, { adapterOnly: true })
      assert.equal(state.config, undefined)
      assert.ok(state.configError)
    } finally { await life.stop() }
  }
})
