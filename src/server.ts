import type { Plugin } from "@opencode/plugin"
import { pluginID, type CompanionHandshake } from "./companion-protocol.js"
import type { FileIO } from "./file-access.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import { setupServerRuntime, type ServerRuntime, type ServerRuntimeDependencies } from "./server-runtime.js"

export { pluginID }
/** The handshake stays the observed state for fixtures. The runtime is a non-enumerable inspection seam. */
export interface ServerPluginState extends CompanionHandshake { readonly runtime?: ServerRuntime }
export type PluginSetupObserver = (ready: { role: "server"; state: ServerPluginState }, lifecycle: PluginLifecycle) => void | Promise<void>

function createPlugin(dependencies: ServerRuntimeDependencies = {}, observe?: PluginSetupObserver) {
  return {
    id: pluginID,
    async setup(context: Plugin.Context) {
      const lifecycle = new PluginLifecycle()
      await lifecycle.start(async () => {
        const runtime = await setupServerRuntime(context, lifecycle, dependencies)
        const state: ServerPluginState = { ...runtime.companion.handshake }
        Object.defineProperty(state, "runtime", { get: () => runtime })
        await observe?.({ role: "server", state }, lifecycle)
      })
      return () => lifecycle.stop()
    },
  } satisfies Plugin.Plugin
}

export function withPluginSetup(observe: PluginSetupObserver) { return createPlugin({}, observe) }
export function withFileAccess(fileIO: FileIO) { return createPlugin({ fileIO }) }
/** Embedding seam for fixtures: explicit policy file, registration and hosting fakes. */
export function withServerDependencies(dependencies: ServerRuntimeDependencies, observe?: PluginSetupObserver) { return createPlugin(dependencies, observe) }
export default createPlugin()
/** Fixture and embedding seam: the embedded worker source this role runs. Never an option. */
export { HistoryStore, historyWorkerSource } from "./history-store.js"
