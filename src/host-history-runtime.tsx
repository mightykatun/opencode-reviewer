import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show, untrack } from "solid-js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import type { HostPanelBounds, HostSidebarAnchor } from "./host-review-panel.js"
import { HistoryController, type HistoryViewState } from "./history-controller.js"
import { StatisticsController, type StatisticsState } from "./statistics-controller.js"
import { HostHistoryView, type HostHistoryInput } from "./host-history-view.js"
import { setupHostStatistics } from "./host-statistics-view.js"
import type { HistoryReader } from "./history-refresh.js"
import type { HistoryRenderProbe } from "./embedding-types.js"
import { uiText } from "./ui-text.js"

export interface HostHistoryRuntimeOptions {
  rootRoute(): string | undefined
  sidebarOwner(): HostSidebarAnchor | undefined
  sidebarGeometry(): HostPanelBounds | undefined
  reader: HistoryReader
  available(): boolean
  historyProbe?: HistoryRenderProbe
}

export function setupHostHistory(context: Plugin.Context, lifecycle: PluginLifecycle, options: HostHistoryRuntimeOptions) {
  const connected = () => !lifecycle.signal.aborted && options.available()
  // The RPC resolves the named session on the server.
  const session = async (id: string) => id
  const [state, setState] = createSignal<HistoryViewState>({ open: false, status: "loading", reset: 0 })
  const browser = new HistoryController(options.reader, session, setState)
  const historyInput: HostHistoryInput | undefined = options.historyProbe
    ? { interactive: () => false, scroll: () => {} } : undefined
  const [statisticsState, setStatisticsState] = createSignal<StatisticsState>({
    open: false, view: "lifetime", unavailable: false, ancestry: "none",
  })
  const statistics = new StatisticsController(options.reader, session, setStatisticsState)
  const statisticsUI = setupHostStatistics(context, statistics, statisticsState, connected)
  lifecycle.addCleanup(() => {
    statisticsUI.close()
    statistics.dispose()
    browser.dispose()
  })
  const selected = () => connected() ? options.rootRoute() : undefined
  context.keymap.layer(() => ({ mode: "global", commands: [{
    id: "reviewer.history", title: uiText.commands.history, group: uiText.commands.category,
    slash: { name: "reviewer-history" }, enabled: () => !!selected(),
    run: () => {
      const session = selected()
      if (session) browser.open(session)
    },
  }] }))
  context.keymap.layer(() => ({ priority: 100, mode: "global", enabled: () => !!selected(), commands: [{
    id: "reviewer.history.toggle", title: uiText.commands.history, group: uiText.commands.category,
    bind: "alt+h", palette: true,
    run: (_input, event) => {
      const keyboard = !!event?.sequence
      if (keyboard && context.keymap.mode.current() !== "base") return false
      const session = selected()
      if (!session) return
      if (keyboard && browser.isCurrent(session)) browser.close()
      else browser.open(session)
    },
  }] }))
  const render = () => {
    createEffect(() => {
      const session = selected()
      untrack(() => browser.route(session))
    })
    return <Show when={state().open && selected()} keyed>{session =>
      <HostHistoryView context={context} controller={browser} state={state} session={session}
        rootSession={selected} sidebarOwner={options.sidebarOwner} sidebarGeometry={options.sidebarGeometry}
        input={historyInput} />
    }</Show>
  }
  return { browser, state, statistics, statisticsState, lifetimeText: statisticsUI.text, render, historyInput }
}
