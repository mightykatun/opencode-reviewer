import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SessionModes } from "./session-mode.js"
import { uiText } from "./ui-text.js"

export function sessionModeCommands(api: TuiPluginApi, modes: SessionModes, changed: (root: string) => void) {
  let sequence = 0
  const latest = new Map<string, number>()
  const selected = () => {
    const route = api.route.current
    return route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  }
  return api.keymap.registerLayer({ commands: [true, false].map((enabled) => ({
    name: `opencode-reviewer.${enabled ? "enable" : "disable"}`,
    namespace: "palette", slashName: `reviewer-${enabled ? "enable" : "disable"}`,
    title: enabled ? uiText.commands.enable : uiText.commands.disable, category: uiText.commands.category,
    enabled: () => selected() !== undefined,
    run: async () => {
      const sessionID = selected()
      if (!sessionID) return
      const order = ++sequence
      let applied = false
      let root: string | undefined
      try {
        root = await modes.root(sessionID, api.lifecycle.signal)
        if ((latest.get(root) ?? 0) > order) return
        latest.set(root, order)
        // Unknown/corrupt saved mode must not become enabled through a failed read.
        if (enabled) await modes.load(root, api.lifecycle.signal)
        api.lifecycle.signal.throwIfAborted()
        if (latest.get(root) !== order) return
        // Re-saving an enabled root may retry failed persistence, but must not
        // invalidate its reviews or approval countdown. Disable still suspends
        // unread mode state and any in-flight initial load.
        const invalidate = !enabled || !modes.enabled(root)
        const persisted = modes.set(root, enabled)
        applied = true
        if (invalidate) changed(root)
        await persisted
        if (!api.lifecycle.signal.aborted && latest.get(root) === order) api.ui.toast({ variant: "success",
          message: uiText.sessionMode.saved(enabled) })
      } catch {
        if (!api.lifecycle.signal.aborted && (root === undefined || latest.get(root) === order)) api.ui.toast({ variant: "error", message: applied
          ? uiText.sessionMode.saveFailed(enabled)
          : uiText.sessionMode.unavailable })
      }
    },
  })) })
}
