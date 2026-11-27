import type { Plugin } from "@opencode/plugin/tui"
import { uiText } from "./ui-text.js"

export function setupHostModeCommands(context: Plugin.Context, active: () => boolean,
  set: (sessionID: string, enabled: boolean) => Promise<unknown>) {
  const switchMode = async (enabled: boolean) => {
    const route = context.ui.router.current()
    if (!active() || route.type !== "session") return
    try {
      await set(route.sessionID, enabled)
      if (active()) context.ui.toast.show({ message: uiText.sessionMode.saved(enabled), variant: "success" })
    } catch {
      if (active()) context.ui.toast.show({ message: uiText.sessionMode.saveFailed, variant: "error" })
    }
  }
  context.keymap.layer(() => ({ mode: "global", enabled: active, commands: [
    { id: "reviewer.enable", title: uiText.commands.enable, group: uiText.commands.category, palette: true,
      slash: { name: "reviewer-enable" }, run: () => switchMode(true) },
    { id: "reviewer.disable", title: uiText.commands.disable, group: uiText.commands.category, palette: true,
      slash: { name: "reviewer-disable" }, run: () => switchMode(false) },
  ] }))
}
