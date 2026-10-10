import { createSignal, For, onCleanup } from "solid-js"
import { RGBA } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { lifetimeCost, lifetimeReport } from "./lifetime.js"
import { StatisticsController, type StatisticsState } from "./statistics-controller.js"
import type { HistoryStore } from "./history-store.js"
import { uiText } from "./ui-text.js"
import type { AncestryReader } from "./session-mode.js"

/** Independent accounting UI: no session writes and no dependency on review visibility. */
export function lifetimeTracker(api: TuiPluginApi, store: Pick<HistoryStore, "query" | "onCommit" | "onWriteFailure">,
  root: AncestryReader) {
  const [state, setState] = createSignal<StatisticsState>({ open: false, view: "lifetime", unavailable: false, ancestry: "none" })
  const controller = new StatisticsController(api.state.path.directory, store, root, setState)
  const stop = () => controller.dispose()
  api.lifecycle.signal.addEventListener("abort", stop, { once: true })
  if (api.lifecycle.signal.aborted) stop()
  const unregister = api.keymap.registerLayer({ commands: [{
    name: "opencode-reviewer.lifetime", namespace: "palette", title: uiText.commands.lifetime, category: uiText.commands.category,
    run: () => {
      if (api.lifecycle.signal.aborted) return
      const route = api.route.current
      const token = controller.open(route.name === "session" ? route.params?.sessionID as string | undefined : undefined)
      api.ui.dialog.replace(() => <StatisticsDialog api={api} controller={controller} state={state()} token={token} />,
        () => controller.close(token))
    },
  }] })
  api.lifecycle.onDispose(() => {
    controller.dispose()
    api.lifecycle.signal.removeEventListener("abort", stop)
    unregister()
  })
  return {
    text: () => state().unavailable ? uiText.lifetime.inlineUnavailable : state().totals?.requests
      ? [lifetimeCost(state().totals!), uiText.lifetime.ratings(state().totals!.safe, state().totals!.unsafe)].join("\n") : undefined,
  }
}

function StatisticsDialog(props: { api: TuiPluginApi; controller: StatisticsController; state: StatisticsState; token: number }) {
  const [hover, setHover] = createSignal<StatisticsState["view"]>()
  const selectedForeground = () => {
    const theme = props.api.theme.current
    if (theme.selectedListItemText.a !== 0) return theme.selectedListItemText
    const { r, g, b } = theme.accent
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255)
  }
  const depth = props.api.ui.dialog.depth
  const toggle = () => props.controller.select(props.state.view === "lifetime" ? "conversation" : "lifetime")
  const unregister = props.api.keymap.registerLayer({ priority: 110, mode: "modal",
    enabled: () => props.controller.current(props.token) && props.api.ui.dialog.depth === depth,
    bindings: [{ key: "tab", cmd: toggle }, { key: "return", cmd: () => props.api.ui.dialog.clear() }] })
  onCleanup(() => { unregister(); props.controller.close(props.token) })
  const message = () => {
    const state = props.state
    if (state.view === "lifetime") return state.unavailable ? uiText.lifetime.unavailable
      : state.totals ? lifetimeReport(state.totals) : uiText.lifetime.loading
    if (state.ancestry === "none") return uiText.lifetime.noConversation
    if (state.ancestry === "unavailable" || state.unavailable) return uiText.lifetime.conversationUnavailable
    if (!state.conversation) return uiText.lifetime.loading
    return lifetimeReport(state.conversation.totals)
  }
  // The public dialog stack supplies the modal frame, sizing and native Escape.
  return <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.api.theme.current.text}><b>{uiText.lifetime.title}</b></text>
        <text fg={props.api.theme.current.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>{uiText.lifetime.close}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <For each={["conversation", "lifetime"] as const}>{scope => {
          const active = () => props.state.view === scope
          return <box paddingLeft={1} paddingRight={1}
            backgroundColor={active() ? props.api.theme.current.accent
              : hover() === scope ? props.api.theme.current.backgroundElement : props.api.theme.current.backgroundPanel}
            onMouseOver={() => setHover(scope)} onMouseOut={() => setHover(undefined)}
            onMouseUp={event => {
              if (event.button !== 0 || props.api.renderer.getSelection()?.getSelectedText()) return
              props.controller.select(scope)
            }}>
            <text fg={active() ? selectedForeground() : props.api.theme.current.textMuted}>{uiText.lifetime.scopeTab(scope)}</text>
          </box>
        }}</For>
      </box>
      <text fg={props.api.theme.current.text}>{message()}</text>
      <text fg={props.api.theme.current.textMuted}>{uiText.lifetime.switchScope}</text>
    </box>
}
