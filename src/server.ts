import type { Plugin } from "@opencode/plugin"
import { setupCompanion } from "./companion.js"
import { pluginID, type CompanionHandshake } from "./companion-protocol.js"
import type { FileIO } from "./file-access.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"

export { pluginID }
export type PluginSetupObserver = (ready: { role: "server"; state: CompanionHandshake }, lifecycle: PluginLifecycle) => void | Promise<void>

function createPlugin(fileIO?: FileIO, observe?: PluginSetupObserver) {
  return {
    id: pluginID,
    async setup(context: Plugin.Context) {
      const lifecycle = new PluginLifecycle()
      await lifecycle.start(async () => {
        const state = await setupCompanion(context, lifecycle, fileIO)
        await observe?.({ role: "server", state }, lifecycle)
      })
      return () => lifecycle.stop()
    },
  } satisfies Plugin.Plugin
}

export function withPluginSetup(observe: PluginSetupObserver) { return createPlugin(undefined, observe) }
export function withFileAccess(fileIO: FileIO) { return createPlugin(fileIO) }
export default createPlugin()
