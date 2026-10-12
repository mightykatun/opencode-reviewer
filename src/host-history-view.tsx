import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import { CliRenderEvents, CodeRenderable, ScrollBoxRenderable, type BoxRenderable, type MarkdownRenderable, type Renderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { HistoryController, HistoryViewState } from "./history-controller.js"
import type { HistoryCover } from "./history-cover.js"
import { historyLayout, historyMetadata } from "./history-layout.js"
import { hostPanelOwnsHit, type HostPanelBounds, type HostPanelNode, type HostSidebarAnchor } from "./host-review-panel.js"
import { HostReviewDescription } from "./review-description.js"
import { uiText } from "./ui-text.js"

export interface HostHistoryProofInput {
  session: string
  root?: string
  current: boolean
  route: { type: string; sessionID?: string }
  mode: string
  mouse: boolean
  width: number
  height: number
  anchor?: { owner: unknown; sessionID: string; node: HostPanelNode }
  bounds?: HostPanelBounds
  panel?: HostPanelNode
  heading?: HostPanelNode
  footer?: HostPanelNode
  hitTest(x: number, y: number): number
}

const coordinates = ["x", "y", "width", "height"] as const
function sameBounds(left: HostPanelBounds, right: HostPanelBounds) {
  return coordinates.every(key => left[key] === right[key])
}
function fits(node: HostPanelNode | undefined, parent: HostPanelBounds): node is HostPanelNode {
  return !!node && node.visible && !node.isDestroyed && coordinates.every(key => Number.isFinite(node[key]))
    && node.width > 0 && node.height > 0 && node.x >= parent.x && node.y >= parent.y
    && node.x + node.width <= parent.x + parent.width && node.y + node.height <= parent.y + parent.height
}

/** History cover and keyboard browsing share real heading/footer paint. A mounted
 * root overlay, remembered geometry or mouse-disabled hit grid is not proof. */
export class HostHistoryPresentationProof {
  private painted?: { owner: unknown; session: string; nodes: HostPanelNode[]; bounds: number[]; hits: number[] }
  invalidate() { this.painted = undefined }
  visible(input: HostHistoryProofInput, frame = false): boolean {
    const fail = () => { this.invalidate(); return false }
    const { anchor, panel, heading, footer, bounds } = input
    if (!input.current || input.root !== input.session || input.route.type !== "session"
      || input.route.sessionID !== input.session || input.mode !== "base" || !input.mouse
      || !anchor || anchor.sessionID !== input.session || !bounds
      || !fits(anchor.node, { x: 0, y: 0, width: input.width, height: input.height })
      || !fits(panel, anchor.node) || !sameBounds(panel, anchor.node) || !sameBounds(bounds, anchor.node)
      || panel.width < 4 || panel.height < 4 || !fits(heading, panel) || !fits(footer, panel)
      || heading.width < 2 || heading.height < 1 || footer.width < 2 || footer.height < 1
      || heading.y + heading.height > footer.y) return fail()
    const footerFits = (node: HostPanelNode): boolean => node.getChildren().filter(child => child.visible && !child.isDestroyed)
      .every(child => fits(child, footer) && footerFits(child))
    if (!footerFits(footer)) return fail()
    const hits = [heading, footer].map(node => input.hitTest(node.x + 1, node.y + (node === footer && node.height > 1 ? 1 : 0)))
    if (!hostPanelOwnsHit(heading, hits[0]!) || !hostPanelOwnsHit(footer, hits[1]!)) return fail()
    const nodes = [anchor.node, panel, heading, footer]
    const geometry = [input.width, input.height, ...nodes.flatMap(node => coordinates.map(key => node[key]))]
    if (frame) this.painted = { owner: anchor.owner, session: input.session, nodes, bounds: geometry, hits }
    const painted = this.painted
    if (!painted || painted.owner !== anchor.owner || painted.session !== input.session
      || nodes.some((node, i) => node !== painted.nodes[i])
      || geometry.some((value, i) => value !== painted.bounds[i]) || hits.some((hit, i) => hit !== painted.hits[i])) return fail()
    return true
  }
}

export interface HostHistoryInput {
  interactive(): boolean
  scroll(amount: number, page: boolean): void
}
export interface HostHistoryViewProps {
  context: Plugin.Context
  controller: HistoryController
  state(): HistoryViewState
  /** Stable root identity for this history mount, including exact-request opens. */
  session: string
  rootSession(): string | undefined
  sidebarOwner(): HostSidebarAnchor | undefined
  sidebarGeometry(): HostPanelBounds | undefined
  /** Install setupHostHistoryCover before mounting the live/history siblings. */
  cover: HistoryCover
  input?: HostHistoryInput
  /** Allows the enclosing runtime to recheck a covered normal countdown on FRAME. */
  onPresented?(): void
}

/** Keep this listener alive across history close/remount. The exact old painted
 * hits may bridge a same-frame close, but never a later FRAME without an owner.
 * Register before panel listeners and pass the returned cleanup to the lifecycle. */
export function setupHostHistoryCover(context: Plugin.Context, cover: HistoryCover): () => void {
  const frame = () => cover.beginFrame()
  context.renderer.on(CliRenderEvents.FRAME, frame)
  return () => { context.renderer.off(CliRenderEvents.FRAME, frame); cover.frame() }
}

function highlightingComplete(node: Renderable): boolean {
  return !(node instanceof CodeRenderable && node.isHighlighting) && node.getChildren().every(highlightingComplete)
}

function HistoryButton(props: { context: Plugin.Context; label: string; disabled?: boolean; run(): void }) {
  const [hover, setHover] = createSignal(false)
  return <box paddingLeft={1} paddingRight={1} flexShrink={0}
    backgroundColor={hover() && !props.disabled ? props.context.theme.background.action.primary.focused : props.context.theme.background.raised.high}
    onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}
    onMouseUp={event => { event.stopPropagation(); if (event.button === 0 && !props.disabled) props.run() }}>
    <text fg={props.disabled ? props.context.theme.text.muted : hover() ? props.context.theme.text.action.primary.focused : props.context.theme.text.base}>{props.label}</text>
  </box>
}

/** Absolute sibling over the live panel. Its enclosing app-slot parent owns the
 * measured native sidebar frame; this component never reveals or sizes a sidebar. */
export function HostHistoryView(props: HostHistoryViewProps) {
  const { context, controller } = props
  let panel: BoxRenderable | undefined, heading: BoxRenderable | undefined, footer: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined, description: MarkdownRenderable | undefined
  let restored = false, measured = "", reset = props.state().reset
  const proof = new HostHistoryPresentationProof()
  const rootRoute = () => {
    const route = context.ui.router.current()
    return props.rootSession() === props.session && route.type === "session" && route.sessionID === props.session
      && props.state().open && controller.isCurrent(props.session)
  }
  const visible = () => rootRoute() && props.sidebarOwner()?.sessionID === props.session && !!props.sidebarGeometry()
  const interactive = (frame = false) => {
    const anchor = props.sidebarOwner()
    return proof.visible({ session: props.session, root: props.rootSession(), current: props.state().open && controller.isCurrent(props.session),
      route: context.ui.router.current(), mode: context.keymap.mode.current(), mouse: context.renderer.useMouse,
      width: context.renderer.width, height: context.renderer.height, bounds: props.sidebarGeometry(),
      anchor: anchor && { ...anchor, node: anchor.node as HostPanelNode }, panel: panel as HostPanelNode | undefined,
      heading: heading as HostPanelNode | undefined, footer: footer as HostPanelNode | undefined,
      hitTest: (x, y) => context.renderer.hitTest(x, y) }, frame)
  }
  const release = props.cover.mount(props.session, hit => interactive() && hostPanelOwnsHit(panel as HostPanelNode | undefined, hit), () => { interactive(true) })
  const record = () => props.state().status === "ready" ? props.state().selection?.record : undefined
  const selection = () => props.state().status === "ready" ? props.state().selection : undefined
  const index = () => uiText.history.index(selection()?.rank ?? 0, selection()?.total ?? 0)
  const layout = createMemo(() => historyLayout(record() ? uiText.history.outcomes[record()!.outcome] : undefined, index(),
    Math.max(0, (props.sidebarGeometry()?.width ?? 42) - 4)))
  const scrollBy = (amount: number, page: boolean) => {
    if (!interactive() || !scroll || scroll.isDestroyed) return
    scroll.scrollBy(amount * (page ? Math.max(1, scroll.height - 1) : 1))
    // Do not replace a saved offset with the collapsed loading/Markdown extent.
    if (restored) controller.recordScroll(scroll.scrollTop)
  }
  if (props.input) { props.input.interactive = interactive; props.input.scroll = scrollBy }
  const navigate = (direction: "older" | "newer") => { if (interactive()) controller.navigate(direction) }
  const close = () => { if (rootRoute() && context.keymap.mode.current() === "base") controller.close() }
  context.keymap.layer(() => ({ priority: 100, mode: "base", enabled: () => interactive(), commands: [
    { bind: "left", run: () => navigate("older") }, { bind: "right", run: () => navigate("newer") },
    { bind: "up", run: () => scrollBy(-1, false) }, { bind: "down", run: () => scrollBy(1, false) },
    { bind: "pageup", run: () => scrollBy(-1, true) }, { bind: "pagedown", run: () => scrollBy(1, true) },
  ] }))
  // Explicit close remains available with mouse:false; it grants no cover or
  // browsing proof and cannot consume Escape from an unrelated native modal.
  context.keymap.layer(() => ({ priority: 100, mode: "base", enabled: rootRoute,
    commands: [{ bind: "escape", run: close }] }))
  createEffect(() => {
    if (reset === props.state().reset) return
    reset = props.state().reset; restored = false; measured = ""
    scroll?.scrollTo(controller.scroll)
  })
  createEffect(() => {
    context.ui.router.current(); context.keymap.mode.current(); props.rootSession(); props.sidebarOwner(); props.sidebarGeometry()
    untrack(() => { proof.invalidate(); props.cover.frame(); props.onPresented?.() })
  })
  const frame = () => {
    interactive(true)
    props.onPresented?.()
    if (!scroll || scroll.isDestroyed || !visible() || props.state().status !== "ready") return
    if (!restored) {
      if (record() && (!description || description.isDestroyed || !description.getChildrenCount() || !highlightingComplete(description))) return
      // Highlighting precedes Yoga/scrollbar layout. Restore only after its
      // measured extent survives a complete real frame, not a timer.
      const extent = `${scroll.scrollHeight}:${scroll.viewport.height}:${description?.height ?? 0}`
      if (extent !== measured) { measured = extent; context.renderer.requestRender(); return }
      scroll.scrollTo(controller.scroll); restored = true
    } else controller.recordScroll(scroll.scrollTop)
  }
  const resize = () => { proof.invalidate(); props.cover.frame(); props.onPresented?.() }
  context.renderer.on(CliRenderEvents.FRAME, frame)
  context.renderer.on(CliRenderEvents.RESIZE, resize)
  onCleanup(() => {
    context.renderer.off(CliRenderEvents.FRAME, frame); context.renderer.off(CliRenderEvents.RESIZE, resize)
    proof.invalidate(); release()
    if (props.input?.interactive === interactive) { props.input.interactive = () => false; props.input.scroll = () => {} }
    props.onPresented?.()
  })
  const arrows = () => <>
    <HistoryButton context={context} label={uiText.history.older} disabled={!selection()?.older} run={() => navigate("older")} />
    <Show when={layout().rows !== 3}><text fg={context.theme.text.base}>{index()}</text></Show>
    <HistoryButton context={context} label={uiText.history.newer} disabled={!selection()?.newer} run={() => navigate("newer")} />
  </>
  return <box ref={(value: BoxRenderable) => { panel = value }} position="absolute" left={0} top={0} width="100%" height="100%" zIndex={2}
    visible={visible()} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={context.theme.background.raised.base}>
    <box ref={(value: BoxRenderable) => { heading = value }} flexDirection="row" justifyContent="space-between" flexShrink={0}
      backgroundColor={context.theme.background.raised.base}>
      <text fg={context.theme.text.base}><b>{uiText.history.heading}</b></text>
      <HistoryButton context={context} label={uiText.history.close} run={close} />
    </box>
    <Show when={record()}>{value => <text marginTop={1} flexShrink={0} fg={value().payload.safe ? context.theme.text.feedback.success.base : context.theme.text.feedback.error.base}>
      <b>{value().payload.safe ? uiText.review.safe : uiText.review.unsafe}</b>
    </text>}</Show>
    <Show when={selection()?.unreadable}><text marginTop={1} flexShrink={0} fg={context.theme.text.feedback.warning.base}><b>{uiText.history.unreadable}</b></text></Show>
    <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} marginTop={1} flexGrow={1} minHeight={0} contentOptions={{ minHeight: 0 }}
      scrollbarOptions={{ trackOptions: { backgroundColor: context.theme.background.raised.base, foregroundColor: context.theme.scrollbar.base } }}>
      <Show when={record()}>{value => <>
        <HostReviewDescription context={context} text={value().payload.desc} streaming={false} ref={value => { description = value }} />
        <box marginTop={1} flexShrink={0}><text fg={context.theme.text.muted} flexShrink={0}>{historyMetadata(value())}</text></box>
      </>}</Show>
      <Show when={!selection()?.entry}><text fg={context.theme.text.base} flexShrink={0}>{props.state().status === "loading"
        ? uiText.history.loading : props.state().status === "error" ? uiText.history.unavailable : uiText.history.empty}</text></Show>
    </scrollbox>
    <box ref={(value: BoxRenderable) => { footer = value }} marginTop={1} paddingTop={1} minHeight={3} flexShrink={0}
      border={selection()?.entry ? ["top"] : undefined} borderColor={context.theme.border.base} backgroundColor={context.theme.background.raised.base}>
      <Show when={selection()?.entry}>
        <box flexDirection={layout().rows === 1 ? "row" : "column"} justifyContent="space-between" gap={layout().rows === 1 ? 1 : 0}>
          <Show when={layout().label}>{label => <box flexDirection="row"><HistoryButton context={context} label={label()} disabled run={() => {}} /></box>}</Show>
          <box flexGrow={1} alignItems="flex-end">
            <Show when={layout().rows === 3}><text fg={context.theme.text.base}>{index()}</text></Show>
            <box flexDirection="row" gap={1}>{arrows()}</box>
          </box>
        </box>
      </Show>
    </box>
  </box>
}
