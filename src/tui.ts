import type { Plugin } from "@opencode/plugin/tui"
import { setupCli, type CliPluginState } from "./cli-plugin.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import type { PluginDependencies } from "./plugin-dependencies.js"
import type { DiagnosticObserver } from "./diagnostics.js"
import type { HistoryRenderProbe, NotificationBackendFactory } from "./embedding-types.js"
import type { NotificationProcesses } from "./notification-process.js"

export const pluginID = "opencode-reviewer"
type Ready = { role: "cli"; state: CliPluginState }

/** Embedding seam only. Never read from plugin options. */
export type PluginSetupObserver = (ready: Ready, lifecycle: PluginLifecycle) => void | Promise<void>

function createPlugin(dependencies: PluginDependencies = {}, observe?: PluginSetupObserver) {
  return {
    id: pluginID,
    async setup(context: Plugin.Context) {
      const lifecycle = new PluginLifecycle()
      await lifecycle.start(async () => {
        const state = await setupCli(context, lifecycle, dependencies)
        await observe?.({ role: "cli", state }, lifecycle)
      })
      return () => lifecycle.stop()
    },
  } satisfies Plugin.Definition
}

export function withPluginSetup(observe: PluginSetupObserver) { return createPlugin({}, observe) }
export function withDiagnostics(observer: DiagnosticObserver) { return createPlugin({ observer }) }
export function withHistoryRenderProbe(historyProbe: HistoryRenderProbe, observer?: DiagnosticObserver) { return createPlugin({ historyProbe, observer }) }
export function withHistoryObservations(observe: HistoryRenderProbe["observe"], observer?: DiagnosticObserver,
  notifications?: NotificationBackendFactory, setup?: PluginSetupObserver) { return createPlugin({ historyProbe: { observe }, observer, notifications }, setup) }
export function withNotifications(notifications: NotificationBackendFactory) { return createPlugin({ notifications }) }
export function withNotificationProcesses(factory: () => NotificationProcesses) {
  return createPlugin({ notificationProcesses: factory })
}
export type { HistoryRenderProbe, DiagnosticObserver, NotificationBackendFactory }
export type { DiagnosticEvent } from "./diagnostics.js"

export default createPlugin()
