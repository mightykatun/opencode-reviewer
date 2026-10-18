import { createEffect, createMemo, createSignal, Index, Match, onCleanup, Show, Switch, untrack } from "solid-js"
import { CliRenderEvents, CodeRenderable, RGBA, ScrollBoxRenderable, type BoxRenderable, type MarkdownRenderable, type Renderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { Config } from "./config.js"
import { displayText, type RequestIdentity, type View } from "./controller.js"
import { scannerFrame, SCANNER_FRAME_COUNT, SCANNER_INTERVAL_MS } from "./appearance.js"
import { HostReviewDescription } from "./review-description.js"
import { HostReviewMetadata } from "./host-review-metadata.js"
import { ReviewGeometryProof, type ReviewLayout, type ReviewRegion } from "./review-geometry.js"
import { uiText } from "./ui-text.js"
import { usageText } from "./usage.js"
import type { HistoryRenderProbe } from "./embedding-types.js"

export type HostPanelObservationState = "visible" | "pending" | "lost"
export type HostPanelObservation = { state: HostPanelObservationState; id?: string }

export interface HostPanelBounds { x: number; y: number; width: number; height: number }
export interface HostSidebarAnchor {
  /** Identity of this sidebar slot mount, not the request or root ID. */
  owner: unknown
  sessionID: string
  node: Renderable
}

export interface HostReviewPanelProps {
  context: Plugin.Context
  id: string
  view(): View<RequestIdentity>
  /** Current selection identity for fixture observations only. */
  select(): View<RequestIdentity> | undefined
  rootSession(): string | undefined
  sidebarOwner(): HostSidebarAnchor | undefined
  /** Bounds measured from the current anchor after a genuine renderer FRAME. */
  sidebarGeometry(): HostPanelBounds | undefined
  /** Stable app-slot parent can own the same measured absolute frame. */
  positionedByParent?: boolean
  config?: Pick<Config, "autoApprove" | "fastMode">
  /** Host CLI animation preference, if available. Does not alter mouse tracking. */
  animations?: () => boolean
  lifetimeText?: () => string | undefined
  historyProbe?: HistoryRenderProbe
  onApprove(id: string): void | Promise<void>
  onCancel(id: string): void
}

/** Structural nodes let source tests exercise the real proof without a terminal. */
export interface HostPanelNode extends ReviewRegion {
  num: number
  getChildren(): HostPanelNode[]
  wrapper?: HostPanelNode
}

export function hostPanelOwnsHit(node: HostPanelNode | undefined, hit: number): boolean {
  return !!node && node.visible && !node.isDestroyed && (node.num === hit
    || (!!node.wrapper && hostPanelOwnsHit(node.wrapper, hit))
    || node.getChildren().some(child => hostPanelOwnsHit(child, hit)))
}

export interface HostPanelProofInput extends ReviewLayout {
  id: string
  request: RequestIdentity
  root?: string
  route: { type: string; sessionID?: string }
  mode: string
  mouse: boolean
  anchor?: { owner: unknown; sessionID: string; node: HostPanelNode }
  bounds?: HostPanelBounds
  panel?: HostPanelNode
  heading?: HostPanelNode
  rating?: HostPanelNode
  footer?: HostPanelNode
  finalReady: boolean
  hitTest(x: number, y: number): number
}

const boundKeys = ["x", "y", "width", "height"] as const
function sameBounds(left: HostPanelBounds, right: HostPanelBounds) {
  return boundKeys.every(key => left[key] === right[key])
}
function validBounds(bounds: HostPanelBounds, width: number, height: number) {
  return boundKeys.every(key => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0
    && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height
}

/** Fixture-only physical observation: no inferred visibility, history ownership
 * override or timer-generated paint. Only FRAME can renew geometry proof. */
export class HostPanelPresentationProof {
  private geometry = new ReviewGeometryProof()
  private painted?: { root: string; id: string; anchor: HostPanelNode; owner: unknown; bounds: HostPanelBounds; finalReady: boolean }
  invalidate() { this.painted = undefined; this.geometry.invalidate() }
  state(input: HostPanelProofInput, frame = false): HostPanelObservation {
    const lost = (): HostPanelObservation => { this.invalidate(); return { state: "lost" } }
    const pending = (): HostPanelObservation => { this.invalidate(); return { state: "pending", id: input.id } }
    const { anchor, bounds, panel, root } = input
    if (!root || input.route.type !== "session" || input.route.sessionID !== root
      || input.mode !== "base" || !input.mouse || input.request.id !== input.id
      || !anchor || anchor.sessionID !== root || !anchor.node.visible || anchor.node.isDestroyed
      || !panel || !panel.visible || panel.isDestroyed) return lost()
    if (!validBounds(anchor.node, input.width, input.height)) return lost()
    if (!bounds || !validBounds(bounds, input.width, input.height)
      || !sameBounds(bounds, anchor.node) || !sameBounds(panel, anchor.node)) return pending()
    const layout = this.geometry.state({ ...input, owner: anchor.owner }, frame)
    if (layout === "lost") return lost()
    if (layout === "pending") return pending()
    const probes = [input.heading, input.fast ? input.rating : input.footer]
    const ownsProbes = probes.every(node => {
      if (!node || node.isDestroyed || !node.visible || node.width < 2 || node.height < 1) return false
      // Normal footer padding retains ownership across Checking -> Allowing
      // button replacement before the next layout. Fast probes its status row.
      const hit = input.hitTest(node.x + 1, node.y + (node === input.footer && node.height > 1 ? 1 : 0))
      // The transparent footer's interior padding is painted by its enclosing
      // panel. Preserve that real owner during initial/Checking branch handoffs.
      return hostPanelOwnsHit(panel, hit) && (node === input.footer || hostPanelOwnsHit(node, hit))
    })
    if (!ownsProbes) return lost()
    if (frame) this.painted = { root, id: input.id, anchor: anchor.node, owner: anchor.owner, bounds: { ...bounds }, finalReady: input.finalReady }
    const painted = this.painted
    if (!painted || painted.root !== root || painted.id !== input.id || painted.anchor !== anchor.node
      || painted.owner !== anchor.owner || !sameBounds(painted.bounds, bounds)) return pending()
    if (!input.fast && (!input.finalReady || !painted.finalReady)) return { state: "pending", id: input.id }
    return { state: "visible", id: input.id }
  }
}

function highlightingComplete(node: Renderable): boolean {
  return !(node instanceof CodeRenderable && node.isHighlighting) && node.getChildren().every(highlightingComplete)
}

function HostReviewLoading(props: { context: Plugin.Context; retrying: boolean; animations?: () => boolean }) {
  const [frame, setFrame] = createSignal(0)
  const animated = () => props.animations?.() ?? true
  const cells = createMemo(() => scannerFrame(frame()))
  createEffect(() => {
    if (!animated()) return
    const timer = setInterval(() => setFrame(value => (value + 1) % SCANNER_FRAME_COUNT), SCANNER_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })
  return <text fg={props.context.theme.text.muted} height={1}>
    <Show when={animated()} fallback={uiText.review.staticIndicator}>
      <Index each={cells()}>{cell => {
        const color = createMemo(() => {
          const base = props.context.theme.text.muted, { brightness, alpha } = cell()
          return RGBA.fromValues(Math.min(1, base.r * brightness), Math.min(1, base.g * brightness), Math.min(1, base.b * brightness), alpha)
        })
        return <span style={{ fg: color() }}>{cell().character}</span>
      }}</Index>
    </Show>{" "}{props.retrying ? uiText.review.retrying : uiText.review.evaluating}
  </text>
}

function HostReviewButton(props: { context: Plugin.Context; label: string; selected?: boolean; disabled?: boolean; onHover?: () => void; onClick(): void }) {
  const selected = () => !!props.selected && !props.disabled
  const foreground = () => {
    const theme = props.context.theme
    if (!selected()) return theme.text.muted
    const color = theme.text.action.primary.focused
    if (color.a !== 0) return color
    const { r, g, b } = theme.text.feedback.warning.base
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255)
  }
  return <box paddingLeft={1} paddingRight={1}
    backgroundColor={selected() ? props.context.theme.text.feedback.warning.base : props.context.theme.background.raised.high}
    onMouseOver={() => { if (!props.disabled) props.onHover?.() }}
    onMouseUp={event => {
      event.stopPropagation()
      if (event.button === 0 && !props.disabled) props.onClick()
    }}><text fg={foreground()}>{props.label}</text></box>
}

function HostReviewFooter(props: Pick<HostReviewPanelProps, "context" | "onApprove" | "onCancel"> & { view: View<RequestIdentity>; enabled: boolean; ref(value: BoxRenderable): void }) {
  const [selected, setSelected] = createSignal<"approve" | "cancel">("approve")
  const state = () => props.view.autoApproval
  const label = () => { const current = state(); return current?.status === "countdown" ? uiText.autoApproval.countdown(current.seconds) : uiText.autoApproval.checking }
  return <Show when={props.enabled && (props.view.assessment?.safe || !!state())}>
    <box ref={props.ref} marginTop={1} paddingTop={1} minHeight={3} flexShrink={0} border={["top"]} borderColor={props.context.theme.border.base}>
      <Switch fallback={<text fg={props.context.theme.text.muted}>{uiText.autoApproval.checking}</text>}>
        <Match when={state()?.status === "countdown" || state()?.status === "checking"}>
          <box flexDirection="row" gap={1}>
            <HostReviewButton context={props.context} label={label()} disabled={state()?.status === "checking"}
              selected={selected() === "approve"} onHover={() => setSelected("approve")}
              onClick={() => { void props.onApprove(props.view.request.id) }} />
            <HostReviewButton context={props.context} label={uiText.autoApproval.cancel} selected={selected() === "cancel"}
              onHover={() => setSelected("cancel")} onClick={() => props.onCancel(props.view.request.id)} />
          </box>
        </Match>
        <Match when={state()?.status === "allowing"}>
          <HostReviewButton context={props.context} label={uiText.autoApproval.allowing} disabled onClick={() => {}} />
        </Match>
        <Match when={state()?.status === "approved"}><text fg={props.context.theme.text.muted}>{uiText.autoApproval.finishing}</text></Match>
        <Match when={state()?.status === "waiting"}><text fg={props.context.theme.text.muted}>{uiText.autoApproval.waiting}</text>
          <HostReviewButton context={props.context} label={uiText.autoApproval.cancel} onClick={() => props.onCancel(props.view.request.id)} /></Match>
        <Match when={state()?.status === "cancelled"}><text fg={props.context.theme.text.muted}>{uiText.autoApproval.cancelled}</text></Match>
        <Match when={state()?.status === "failed"}><text fg={props.context.theme.text.feedback.warning.base}>{uiText.autoApproval.unavailable}</text></Match>
      </Switch>
    </box>
  </Show>
}

/** The app-slot parent stays stable, but the caller mounts this panel only on the
 * root route. Navigation may dispose Markdown and scrolling state. Controller
 * reports and automation can survive disposal. Presentation is UI evidence only. */
export function HostReviewPanel(props: HostReviewPanelProps) {
  const { context, id, view } = props
  let panel: BoxRenderable | undefined, heading: Renderable | undefined, ratingRegion: BoxRenderable | undefined
  let footer: BoxRenderable | undefined, description: MarkdownRenderable | undefined, scroll: ScrollBoxRenderable | undefined
  let attempt = 0
  let observePaint: (() => void) | undefined
  createEffect(() => {
    const progress = view().progress
    if (progress && progress.attempt !== attempt) { attempt = progress.attempt; scroll?.scrollTo(0) }
  })
  const rootRoute = () => {
    const root = props.rootSession(), route = context.ui.router.current()
    return !!root && route.type === "session" && route.sessionID === root
  }
  const visible = () => rootRoute() && props.sidebarOwner()?.sessionID === props.rootSession() && !!props.sidebarGeometry()
  const rating = () => view().assessment?.safe ?? (view().status === "analyzing" ? view().progress?.preview?.safe : undefined)
  const report = () => view().assessment?.desc ?? (view().status === "analyzing" ? view().progress?.preview?.desc : undefined) ?? ""
  const unavailable = () => view().status === "unavailable" || view().status === "unidentified"
  if (props.historyProbe) {
    const proof = new HostPanelPresentationProof()
    let paintedAssessment: View<RequestIdentity>["assessment"], readyAssessment: View<RequestIdentity>["assessment"]
    observePaint = () => {
      const assessment = view().assessment
      if (assessment && description && !description.isDestroyed && !description.streaming
        && description.content === displayText(assessment.desc) && description.getChildrenCount() && highlightingComplete(description)) paintedAssessment = assessment
    }
    const presentation = (frame = false): HostPanelObservation => {
      const assessment = view().assessment
      // Once the completed report was actually painted, scrolling newly exposed
      // code preserves that observation. New assessments need their own paint.
      if (paintedAssessment && paintedAssessment === assessment && readyAssessment !== assessment
        && description && !description.isDestroyed && description.getChildrenCount() && highlightingComplete(description)) readyAssessment = assessment
      const anchor = props.sidebarOwner()
      return proof.state({ width: context.renderer.width, height: context.renderer.height, fast: props.config?.fastMode === true,
        id, request: view().request, root: props.rootSession(), route: context.ui.router.current(),
        mode: context.keymap.mode.current(), mouse: context.renderer.useMouse,
        anchor: anchor && { ...anchor, node: anchor.node as HostPanelNode }, bounds: props.sidebarGeometry(),
        panel: panel as HostPanelNode | undefined, heading: heading as HostPanelNode | undefined,
        rating: ratingRegion as HostPanelNode | undefined, report: scroll, footer: footer as HostPanelNode | undefined,
        finalReady: !!assessment && readyAssessment === assessment && paintedAssessment === assessment,
        hitTest: (x, y) => context.renderer.hitTest(x, y) }, frame)
    }
    const resize = () => proof.invalidate()
    const frame = () => {
      const value = presentation(true)
      if (props.historyProbe && panel) {
        const regions = [panel, heading, ratingRegion, scroll, footer].map(node => node && ({ x: node.x, y: node.y,
          width: node.width, height: node.height, visible: node.visible, num: node.num }))
        const sample = { stage: "frame" as const, at: performance.now(), panel: panel.num, final: !!view().assessment,
          streaming: description?.streaming ?? true, contentMatches: description?.content === displayText(view().assessment?.desc ?? ""),
          children: description?.getChildrenCount() ?? 0, codeBlocks: 0, highlighting: !!description && !highlightingComplete(description),
          painted: !!view().assessment && paintedAssessment === view().assessment, covered: false, physical: value.state === "visible", eligible: false,
          presentation: value.state, auto: view().autoApproval?.status, regions, bounds: props.sidebarGeometry(),
          mouse: context.renderer.useMouse, mode: context.keymap.mode.current(),
          selected: props.select()?.request.id, root: props.rootSession(), finalReady: !!view().assessment && readyAssessment === view().assessment,
          anchor: props.sidebarOwner() && { x: props.sidebarOwner()!.node.x, y: props.sidebarOwner()!.node.y,
            width: props.sidebarOwner()!.node.width, height: props.sidebarOwner()!.node.height,
            visible: props.sidebarOwner()!.node.visible, session: props.sidebarOwner()!.sessionID },
          footerChildren: footer?.getChildren().map(node => ({ x: node.x, y: node.y, width: node.width, height: node.height, visible: node.visible })),
          hits: [heading, ratingRegion, footer].map(node => node && context.renderer.hitTest(node.x + 1, node.y + (node === footer ? 1 : 0))) }
        try { void Promise.resolve(props.historyProbe.observe(sample)).catch(() => {}) } catch {}
      }
    }
    context.renderer.on(CliRenderEvents.RESIZE, resize)
    context.renderer.on(CliRenderEvents.FRAME, frame)
    // Invalidate fixture evidence immediately on navigation/modal/anchor changes.
    // No observer publication wakes or gates automation.
    createEffect(() => {
      context.ui.router.current(); context.keymap.mode.current(); props.rootSession(); props.sidebarOwner(); props.sidebarGeometry()
      untrack(() => proof.invalidate())
    })
    onCleanup(() => {
      context.renderer.off(CliRenderEvents.FRAME, frame)
      context.renderer.off(CliRenderEvents.RESIZE, resize)
      proof.invalidate()
    })
  }
  return <box ref={(value: BoxRenderable) => { panel = value }} renderAfter={observePaint}
    position="absolute" left={props.positionedByParent ? 0 : props.sidebarGeometry()?.x ?? 0} top={props.positionedByParent ? 0 : props.sidebarGeometry()?.y ?? 0}
    width={props.sidebarGeometry()?.width ?? 0} height={props.sidebarGeometry()?.height ?? 0} visible={visible()} zIndex={1}
    paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={context.theme.background.raised.base}>
    <text ref={(value: Renderable) => { heading = value }} fg={context.theme.text.base} flexShrink={0}><b>{uiText.review.heading}</b></text>
    <box ref={(value: BoxRenderable) => { ratingRegion = value }} marginTop={1} flexShrink={0}>
      <Show when={rating() !== undefined}><text fg={rating() ? context.theme.text.feedback.success.base : context.theme.text.feedback.error.base}>
        <b>{rating() ? uiText.review.safe : uiText.review.unsafe}</b>
      </text></Show>
      <Show when={view().status === "analyzing" && rating() === undefined}>
        <HostReviewLoading context={context} retrying={view().progress?.phase === "retrying"} animations={props.animations} />
      </Show>
      <Show when={unavailable()}><text fg={context.theme.text.feedback.warning.base}><b>{uiText.review.unavailable}</b></text></Show>
    </box>
    <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} marginTop={1} flexGrow={1} minHeight={0}
      contentOptions={{ minHeight: 0 }} scrollbarOptions={{ trackOptions: {
        backgroundColor: context.theme.background.raised.base, foregroundColor: context.theme.scrollbar.base,
      } }}>
      <HostReviewDescription context={context} text={report()} streaming={view().status === "analyzing"} ref={value => { description = value }} />
      <Show when={unavailable()}><text fg={context.theme.text.base} width="100%" flexShrink={0}>
        {displayText(view().error ?? uiText.review.failed)}
      </text></Show>
      <Show when={view().assessment?.usage}>{usage => <>
        <HostReviewMetadata context={context} id="reviewer.review.metadata" marginTop={1} text={usageText(usage())} />
        <Show when={props.lifetimeText?.()}>{text => <HostReviewMetadata context={context} id="reviewer.review.lifetime" text={text()} />}</Show>
      </>}</Show>
    </scrollbox>
    <HostReviewFooter ref={value => { footer = value }} context={context} view={view()} onApprove={props.onApprove} onCancel={props.onCancel}
      enabled={props.config?.autoApprove === true} />
  </box>
}
