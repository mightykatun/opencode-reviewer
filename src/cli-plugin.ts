import type { Plugin } from "@opencode/plugin/tui"
import { parseConfig, type Config } from "./config.js"
import { companionRpc, readHandshake, type CompanionHandshake } from "./companion-protocol.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { uiText } from "./ui-text.js"
import type { PluginDependencies } from "./plugin-dependencies.js"
import { localStateRoot } from "./local-state.js"
import { BUILTIN_PROMPTS, loadPrompts } from "./prompts.js"
import { DeadlineError, remainingTime, withDeadline } from "./deadline.js"
import { TransportOwnership } from "./transport-ownership.js"
import timers from "node:timers/promises"
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
  const current = context.location ?? context.data.location.default()
  const location = { directory: current.directory, ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}) }
  // Load before admission so no asynchronous import separates the scoped
  // handshake from installing the runtime's permanent reconnect revocation.
  const runtime = dependencies.adapterOnly ? undefined : await loadHostRuntime()
  lifecycle.signal.throwIfAborted()
  const reads = new TransportOwnership()
  lifecycle.addCleanup(() => reads.settled())
  let generation = 0, connection = new AbortController()
  let off = context.data.on("server.connected", () => {
    generation++
    connection.abort()
    connection = new AbortController()
  })
  const stop = () => { off(); off = () => {}; connection.abort() }
  lifecycle.addCleanup(stop)
  // Startup only: one fixed budget, sequential physical reads, no fallback
  // promotion or reuse of a controller after a connection changes.
  try {
    const admission = await withDeadline(lifecycle.signal, 10000, async signal => {
      while (!signal.aborted) {
        const turn = generation, connected = connection.signal
        let pending: Promise<unknown> | undefined
        try {
          const response = await withDeadline(signal, 1500, attempt => {
            const request = AbortSignal.any([attempt, connected])
            request.throwIfAborted()
            return pending = reads.track(context.client.rpc(companionRpc).handshake(location, { location, signal: request }))
          }, "Companion handshake")
          signal.throwIfAborted()
          if (turn === generation) {
            // Invalid protocol/scope/epoch data is terminal, never retried.
            return { companion: readHandshake(response, location), generation: turn }
          }
        } catch (error) {
          signal.throwIfAborted()
          if (!state.config || (turn === generation && !(error instanceof DeadlineError)
            && (!error || typeof error !== "object" || !("type" in error) || error.type !== "rpc.unavailable"))) return
        }
        // Abort ends the caller's wait, not the transaction. Do not overlap
        // attempts even when a client ignores cancellation or settles late.
        await pending?.then(() => {}, () => {})
        signal.throwIfAborted()
        if (remainingTime(signal) <= 250) return
        await timers.setTimeout(250, undefined, { signal })
      }
    }, "Companion startup")
    // Deadline callbacks produce data only. Fence the final promise handoff
    // before installing the runtime's permanent reconnect revocation.
    if (admission?.generation === generation) state.companion = admission.companion
  } catch { lifecycle.signal.throwIfAborted() }
  finally { stop() }
  if (runtime) {
    lifecycle.signal.throwIfAborted()
    Object.defineProperty(state, "runtime", { value: runtime.setupHostRuntime(context, state, lifecycle) })
  }
  return state
}
