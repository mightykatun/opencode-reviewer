import type { Plugin } from "@opencode/plugin/tui"
import type { SessionModes } from "./session-mode.js"
import { uiText } from "./ui-text.js"

export interface HostModeCommandOptions {
  active(): boolean
  onChanged(root: string): void
  onRefresh(): unknown
}

/** Local native palette/slash commands, with no messages or model calls. */
export function setupHostModeCommands(context: Plugin.Context, modes: SessionModes, signal: AbortSignal,
  options: HostModeCommandOptions) {
  let modeCommand = 0
  const switchMode = async (enabled: boolean) => {
    if (!options.active() || signal.aborted) return
    const route = context.ui.router.current(), generation = ++modeCommand
    if (route.type !== "session") return
    try {
      const root = await modes.root(route.sessionID, signal)
      if (enabled) await modes.load(root, signal)
      if (generation !== modeCommand || signal.aborted || !options.active()) return
      // Disable also suspends unread state and an in-flight initial load. An
      // unchanged Enable supersedes stale commands without invalidating reviews.
      const changed = !enabled || !modes.enabled(root)
      const saving = modes.set(root, enabled)
      if (changed) options.onChanged(root)
      void options.onRefresh()
      try {
        await saving
        context.ui.toast.show({ message: uiText.sessionMode.saved(enabled), variant: "success" })
      } catch { context.ui.toast.show({ message: uiText.sessionMode.saveFailed(enabled), variant: "error" }) }
    } catch { if (!signal.aborted) context.ui.toast.show({ message: uiText.sessionMode.unavailable, variant: "error" }) }
  }
  context.keymap.layer(() => ({ mode: "global", commands: [
    { id: "reviewer.enable", title: uiText.commands.enable, group: uiText.commands.category, palette: true,
      slash: { name: "reviewer-enable" }, run: () => switchMode(true) },
    { id: "reviewer.disable", title: uiText.commands.disable, group: uiText.commands.category, palette: true,
      slash: { name: "reviewer-disable" }, run: () => switchMode(false) },
  ] }))
}
