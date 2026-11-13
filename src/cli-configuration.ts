import { parseConfig, type Config } from "./config.js"
import { parseNotificationConfig, type NotificationConfig } from "./notification-config.js"
import { BUILTIN_PROMPTS, loadPrompts } from "./prompts.js"
import { withDeadline } from "./deadline.js"
import type { TransportOwnership } from "./transport-ownership.js"
import { uiText } from "./ui-text.js"

export interface CliConfiguration {
  reviewerOptions?: Readonly<Record<string, unknown>>
  config?: Config
  configError?: string
  notificationConfig?: NotificationConfig
  prompts: typeof BUILTIN_PROMPTS
}

/** Return settings only after their owned prompt reads settle or time out.
 * Admission, not this worker, decides whether the result is still current. */
export async function readCliConfiguration(options: Record<string, unknown>, signal: AbortSignal,
  reads: TransportOwnership): Promise<CliConfiguration> {
  signal.throwIfAborted()
  const state: CliConfiguration = { reviewerOptions: options, prompts: BUILTIN_PROMPTS }
  try { state.notificationConfig = parseNotificationConfig(options) } catch { /* Invalid desktop options disable notifications only. */ }
  try { state.config = parseConfig(state.notificationConfig ? options : { ...options,
    notify: false, notifySound: false, notificationSoundDirectory: undefined, staleReminderSeconds: 0, notifications: {} }) }
  catch (error) { state.configError = error instanceof Error ? error.message : uiText.review.invalidConfiguration }
  if (state.config) {
    try {
      state.prompts = await withDeadline(signal, 5000,
        signal => reads.track(loadPrompts(state.config!.instructions, signal)), "Prompt configuration lookup")
    } catch (error) {
      signal.throwIfAborted()
      state.config = undefined
      state.configError = error instanceof Error ? error.message : uiText.review.invalidConfiguration
    }
  }
  signal.throwIfAborted()
  return state
}
