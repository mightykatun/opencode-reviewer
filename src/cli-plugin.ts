import type { Plugin } from "@opencode/plugin/tui"
import { parseConfig, type Config } from "./config.js"
import { companionRpc, readHandshake, supportedHostVersion, type CompanionHandshake } from "./companion-protocol.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { uiText } from "./ui-text.js"
import type { PluginDependencies } from "./plugin-dependencies.js"
import { localStateRoot } from "./local-state.js"
import { BUILTIN_PROMPTS, loadPrompts } from "./prompts.js"
import { withDeadline } from "./deadline.js"
import { loadHostRuntime } from "./host-runtime-loader.js"
import { parseNotificationConfig, type NotificationConfig } from "./notification-config.js"
import type { setupHostRuntime } from "./host-runtime.js"

export interface CliPluginState {
  config?: Config
  configError?: string
  notificationConfig?: NotificationConfig
  companion?: CompanionHandshake
  dependencies: PluginDependencies
  stateRoot: string
  prompts: typeof BUILTIN_PROMPTS
  /** Non-enumerable embedding inspection, never configuration or diagnostics. */
  readonly runtime?: ReturnType<typeof setupHostRuntime>
}

/** Configuration and handshake precede scope-pinned production admission. */
export async function setupCli(context: Plugin.Context, lifecycle: PluginLifecycle, dependencies: PluginDependencies): Promise<CliPluginState> {
  const state: CliPluginState = { dependencies, stateRoot: localStateRoot(), prompts: BUILTIN_PROMPTS }
  try { state.notificationConfig = parseNotificationConfig(context.options) } catch { /* Invalid desktop options disable notifications only. */ }
  try { state.config = parseConfig(state.notificationConfig ? context.options : { ...context.options,
    notify: false, notifySound: false, notificationSoundDirectory: undefined, staleReminderSeconds: 0, notifications: {} }) }
  catch (error) { state.configError = error instanceof Error ? error.message : uiText.review.invalidConfiguration }
  if (state.config) {
    try {
      state.prompts = await withDeadline(lifecycle.signal, 5000, signal => {
        const pending = loadPrompts(state.config!.instructions, signal)
        // A deadline ends the caller's wait, not ownership of open-file cleanup.
        lifecycle.addCleanup(() => pending.then(() => {}, () => {}))
        return pending
      }, "Prompt configuration lookup")
    } catch (error) {
      lifecycle.signal.throwIfAborted()
      state.config = undefined
      state.configError = error instanceof Error ? error.message : uiText.review.invalidConfiguration
    }
  }
  if (context.app.version !== supportedHostVersion) return state
  const current = context.location ?? context.data.location.default()
  const location = { directory: current.directory, ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}) }
  // Uses this terminal's connected client. No service discovery, credentials or
  // terminal-local evidence fallback when the companion is unavailable.
  try {
    const response = await context.client.rpc(companionRpc).handshake(location, {
      location, signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(1500)]),
    })
    lifecycle.signal.throwIfAborted()
    state.companion = readHandshake(response, location)
  } catch { lifecycle.signal.throwIfAborted() }
  if (!dependencies.adapterOnly) {
    const { setupHostRuntime } = await loadHostRuntime()
    lifecycle.signal.throwIfAborted()
    Object.defineProperty(state, "runtime", { value: setupHostRuntime(context, state, lifecycle) })
  }
  return state
}
