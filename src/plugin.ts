import type { Plugin as ServerPlugin } from "@opencode/plugin"
import type { Plugin as CliPlugin } from "@opencode/plugin/tui"
import { setupCompanion } from "./companion.js"
import { setupCli, type CliPluginState } from "./cli-plugin.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import type { CompanionHandshake } from "./companion-protocol.js"
import type { PluginDependencies } from "./plugin-dependencies.js"
import type { FileIO } from "./file-access.js"
import type { DiagnosticObserver } from "./diagnostics.js"
import type { HistoryRenderProbe, NotificationBackendFactory } from "./tui.js"
import type { NotificationProcesses } from "./notification-process.js"
import { LinuxNotifications } from "./notification-linux.js"

export const pluginID = "opencode-reviewer"
type Context = ServerPlugin.Context | CliPlugin.Context
type Ready = { role: "server"; state: CompanionHandshake } | { role: "cli"; state: CliPluginState }

/** Embedding seam only; never read from plugin options. */
export type PluginSetupObserver = (ready: Ready, lifecycle: PluginLifecycle) => void | Promise<void>

function createPlugin(dependencies: PluginDependencies = {}, observe?: PluginSetupObserver) {
  return {
    id: pluginID,
    async setup(context: Context) {
      const lifecycle = new PluginLifecycle()
      await lifecycle.start(async () => {
        if ("ui" in context) {
          // Keep terminal APIs lazy so this shared file can also load on servers.
          const { Plugin } = await import("@opencode/plugin/tui")
          await Plugin.define({ id: pluginID, setup: async cli => {
            const state = await setupCli(cli, lifecycle, dependencies)
            await observe?.({ role: "cli", state }, lifecycle)
          } }).setup(context)
        } else {
          const state = await setupCompanion(context, lifecycle)
          await observe?.({ role: "server", state }, lifecycle)
        }
      })
      return () => lifecycle.stop()
    },
  }
}

export function withPluginSetup(observe: PluginSetupObserver) { return createPlugin({}, observe) }
export function withFileAccess(fileIO: FileIO) { return createPlugin({ fileIO }) }
export function withDiagnostics(observer: DiagnosticObserver) { return createPlugin({ observer }) }
export function withHistoryRenderProbe(historyProbe: HistoryRenderProbe, observer?: DiagnosticObserver) { return createPlugin({ historyProbe, observer }) }
export function withHistoryObservations(observe: HistoryRenderProbe["observe"], observer?: DiagnosticObserver,
  notifications?: NotificationBackendFactory) { return createPlugin({ historyProbe: { observe }, observer, notifications }) }
export function withNotifications(notifications: NotificationBackendFactory) { return createPlugin({ notifications }) }
export function withNotificationProcesses(factory: () => NotificationProcesses) {
  return withNotifications((click, config) => new LinuxNotifications(config, click, factory()))
}
export type { HistoryRenderProbe, DiagnosticObserver, NotificationBackendFactory }
export type { DiagnosticEvent } from "./diagnostics.js"

export default createPlugin()
