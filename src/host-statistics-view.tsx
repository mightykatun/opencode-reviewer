import { createSignal, For, onCleanup } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { lifetimeCost, lifetimeReport } from "./lifetime.js"
import type { StatisticsController, StatisticsScope, StatisticsState } from "./statistics-controller.js"
import { uiText } from "./ui-text.js"

export function hostStatisticsMessage(state: StatisticsState): string {
  if (state.view === "lifetime") return state.unavailable ? uiText.lifetime.unavailable
    : state.totals ? lifetimeReport(state.totals) : uiText.lifetime.loading
  if (state.ancestry === "none") return uiText.lifetime.noConversation
  if (state.ancestry === "unavailable" || state.unavailable) return uiText.lifetime.conversationUnavailable
  if (state.ancestry !== "ready" || !state.conversation) return uiText.lifetime.loading
  return lifetimeReport(state.conversation.totals)
}

export interface HostStatisticsViewProps {
  context: Plugin.Context
  controller: StatisticsController
  state(): StatisticsState
  token: number
}

/** The native dialog owns frame, input mode and disposal. Its component layer
 * follows that ownership, never an inferred dialog.open or dialog.depth value. */
export function HostStatisticsView(props: HostStatisticsViewProps) {
  const { context, controller, token } = props
  const [hover, setHover] = createSignal<StatisticsScope>()
  const current = () => controller.current(token)
  const select = (scope: StatisticsScope) => { if (current()) controller.select(scope) }
  const close = () => { if (current()) context.ui.dialog.clear() }
  context.keymap.layer(() => ({ priority: 110, mode: "modal", enabled: current, commands: [
    { bind: "tab", title: uiText.lifetime.switchScope, run: () => select(props.state().view === "lifetime" ? "conversation" : "lifetime") },
    { bind: "escape", title: uiText.lifetime.close, run: () => {
      if (context.renderer.getSelection()) { context.renderer.clearSelection(); return }
      close()
    } },
    { bind: "return", title: uiText.lifetime.close, run: close },
  ] }))
  onCleanup(() => controller.close(token))
  return <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={context.theme.text.base}><b>{uiText.lifetime.title}</b></text>
      <text fg={context.theme.text.muted} onMouseUp={event => {
        event.stopPropagation()
        if (event.button === 0 && !context.renderer.getSelection()?.getSelectedText()) close()
      }}>{uiText.lifetime.close}</text>
    </box>
    <box flexDirection="row" gap={1}>
      <For each={["conversation", "lifetime"] as const}>{scope => {
        const active = () => props.state().view === scope
        return <box paddingLeft={1} paddingRight={1}
          backgroundColor={active() ? context.theme.background.action.primary.selected
            : hover() === scope ? context.theme.background.raised.high : context.theme.background.raised.base}
          onMouseOver={() => setHover(scope)} onMouseOut={() => setHover(undefined)}
          onMouseUp={event => {
            event.stopPropagation()
            if (event.button === 0 && !context.renderer.getSelection()?.getSelectedText()) select(scope)
          }}>
          <text fg={active() ? context.theme.text.action.primary.selected : context.theme.text.muted}>{uiText.lifetime.scopeTab(scope)}</text>
        </box>
      }}</For>
    </box>
    <text fg={context.theme.text.base}>{hostStatisticsMessage(props.state())}</text>
    <text fg={context.theme.text.muted}>{uiText.lifetime.switchScope}</text>
  </box>
}

/** The caller owns the statistics controller and persistence lifecycle. Call from
 * plugin setup or a stable component so native keymap cleanup follows its owner. */
export function setupHostStatistics(context: Plugin.Context, controller: StatisticsController,
  state: () => StatisticsState, enabled: () => boolean = () => true) {
  let activeToken: number | undefined
  const open = (session?: string) => {
    if (!enabled()) return
    const token = controller.open(session)
    if (!controller.current(token)) return
    activeToken = token
    context.ui.dialog.show(() => {
      context.ui.dialog.set({ size: "large", centered: true })
      return <HostStatisticsView context={context} controller={controller} state={state} token={token} />
    }, () => { controller.close(token); if (activeToken === token) activeToken = undefined })
  }
  context.keymap.layer(() => ({ mode: "global", commands: [{ id: "reviewer.lifetime", title: uiText.commands.lifetime,
    group: uiText.commands.category, palette: true, slash: { name: "reviewer-stats" }, enabled, run: () => {
      const route = context.ui.router.current()
      open(route.type === "session" ? route.sessionID : undefined)
    } }] }))
  return {
    open,
    close: () => { if (activeToken !== undefined && controller.current(activeToken)) context.ui.dialog.clear() },
    text: () => state().unavailable ? uiText.lifetime.inlineUnavailable : state().totals?.requests
      ? [lifetimeCost(state().totals!), uiText.lifetime.ratings(state().totals!.safe, state().totals!.unsafe)].join("\n") : undefined,
  }
}
