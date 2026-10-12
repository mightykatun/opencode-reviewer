import { createEffect, createMemo, createSignal, Index, Match, onCleanup, Show, Switch } from "solid-js"
import { CliRenderEvents, CodeRenderable, RGBA, ScrollBoxRenderable, type BoxRenderable, type MarkdownRenderable, type Renderable } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Config } from "./config.js"
import { displayText, type View } from "./controller.js"
import { scannerFrame, SCANNER_FRAME_COUNT, SCANNER_INTERVAL_MS } from "./appearance.js"
import { usageText } from "./usage.js"
import type { DiagnosticTrace } from "./diagnostics.js"
import type { HistoryViewState } from "./history-controller.js"
import type { HistoryCover } from "./history-cover.js"
import { ReviewDescription } from "./review-description.js"
import { ReviewGeometryProof } from "./review-geometry.js"
import { uiText } from "./ui-text.js"
import type { PresentationCheck, PresentationState, ReviewPresentation } from "./review-presentation.js"

/** Opt-in observations of real renderables, never a readiness override. */
export interface HistoryRenderProbeEvent {
  stage: "render-after" | "frame" | "presentation"
  check?: PresentationCheck
  at: number
  panel: number
  markdown?: number
  final: boolean
  streaming: boolean
  contentMatches: boolean
  children: number
  codeBlocks: number
  highlighting: boolean
  painted: boolean
  covered: boolean
  physical: boolean
  eligible: boolean
  presentation: PresentationState
  auto?: string
  seconds?: number
  history?: "loading" | "ready" | "error"
}
export interface HistoryRenderProbe {
  cover?: () => Renderable | undefined
  observe: (event: Readonly<HistoryRenderProbeEvent>) => void | Promise<void>
}

interface ReviewActions {
  onApprove(id: string): void | Promise<void>
  onCancel(id: string): void
}
interface LiveReviewPanelProps extends ReviewActions {
  api: TuiPluginApi
  id: string
  view(): View
  /** Fresh native selection, also called synchronously at the write boundary. */
  select(): View | undefined
  sidebarSession(): string | undefined
  sidebarState(): PresentationState
  sidebarOwner(): unknown
  historyState(): HistoryViewState
  historyCover: HistoryCover
  historyProbe?: HistoryRenderProbe
  config?: Pick<Config, "autoApprove" | "fastMode">
  traceFor?: (view: View) => DiagnosticTrace | undefined
  lifetimeText(): string | undefined
  onPresented(proof?: ReviewPresentation): void
  /** Install the synchronous getter and return its identity-guarded release. */
  registerPresentation(visible: (check?: PresentationCheck) => ReviewPresentation): () => void
}

function ReviewLoading(props: { api: TuiPluginApi; retrying: boolean }) {
  const [frame, setFrame] = createSignal(0)
  const animated = createMemo(() => props.api.kv.get("animations_enabled", true))
  const cells = createMemo(() => scannerFrame(frame()))
  createEffect(() => {
    if (!animated()) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % SCANNER_FRAME_COUNT), SCANNER_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <text fg={props.api.theme.current.textMuted} height={1}>
      <Show when={animated()} fallback={uiText.review.staticIndicator}>
        <Index each={cells()}>{(cell) => {
          const color = createMemo(() => {
            const base = props.api.theme.current.textMuted
            const { brightness, alpha } = cell()
            return RGBA.fromValues(Math.min(1, base.r * brightness), Math.min(1, base.g * brightness), Math.min(1, base.b * brightness), alpha)
          })
          return <span style={{ fg: color() }}>{cell().character}</span>
        }}</Index>
      </Show>
      {" "}{props.retrying ? uiText.review.retrying : uiText.review.evaluating}
    </text>
  )
}

function highlightingComplete(node: Renderable): boolean {
  return !(node instanceof CodeRenderable && node.isHighlighting) && node.getChildren().every(highlightingComplete)
}

function ownsHit(node: Renderable, hit: number): boolean {
  return node.num === hit || (node instanceof ScrollBoxRenderable && ownsHit(node.wrapper, hit))
    || node.getChildren().some((child) => ownsHit(child, hit))
}

function ReviewButton(props: { api: TuiPluginApi; label: string; selected?: boolean; disabled?: boolean; onHover?: () => void; onClick: () => void }) {
  const selected = () => props.selected && !props.disabled
  const foreground = () => {
    const theme = props.api.theme.current
    if (!selected()) return theme.textMuted
    if (theme.selectedListItemText.a !== 0) return theme.selectedListItemText
    // Transparent themes need contrast against the permission selection color.
    const { r, g, b } = theme.warning
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255)
  }
  return <box paddingLeft={1} paddingRight={1}
    backgroundColor={selected() ? props.api.theme.current.warning : props.api.theme.current.backgroundMenu}
    onMouseOver={() => { if (!props.disabled) props.onHover?.() }}
    onMouseUp={(event) => {
      event.stopPropagation()
      if (event.button === 0 && !props.disabled) props.onClick()
    }}>
    <text fg={foreground()}>{props.label}</text>
  </box>
}

function ReviewFooter(props: ReviewActions & { api: TuiPluginApi; view: View; enabled: boolean; ref?: (value: BoxRenderable) => void }) {
  const [selected, setSelected] = createSignal<"approve" | "cancel">("approve")
  const state = () => props.view.autoApproval
  const label = () => { const current = state(); return current?.status === "countdown" ? uiText.autoApproval.countdown(current.seconds) : uiText.autoApproval.checking }
  return <Show when={props.enabled && (props.view.assessment?.safe || !!state())}>
    <box ref={props.ref} marginTop={1} paddingTop={1} minHeight={3} flexShrink={0} border={["top"]} borderColor={props.api.theme.current.borderSubtle}>
      <Switch>
        <Match when={state()?.status === "countdown" || state()?.status === "checking"}>
          <box flexDirection="row" gap={1}>
            <ReviewButton api={props.api} label={label()} disabled={state()?.status === "checking"}
              selected={selected() === "approve"} onHover={() => setSelected("approve")}
              onClick={() => { void props.onApprove(props.view.request.id) }} />
            <ReviewButton api={props.api} label={uiText.autoApproval.cancel} selected={selected() === "cancel"} onHover={() => setSelected("cancel")}
              onClick={() => props.onCancel(props.view.request.id)} />
          </box>
        </Match>
        <Match when={state()?.status === "allowing"}>
          <ReviewButton api={props.api} label={uiText.autoApproval.allowing} disabled onClick={() => {}} />
        </Match>
        <Match when={state()?.status === "approved"}>
          <text fg={props.api.theme.current.textMuted}>{uiText.autoApproval.finishing}</text>
        </Match>
        <Match when={state()?.status === "cancelled"}>
          <text fg={props.api.theme.current.textMuted}>{uiText.autoApproval.cancelled}</text>
        </Match>
        <Match when={state()?.status === "failed"}>
          <text fg={props.api.theme.current.warning}>{uiText.autoApproval.unavailable}</text>
        </Match>
      </Switch>
    </box>
  </Show>
}

/** One request-ID-keyed owner. Countdown publications update accessors, not this mount. */
export function LiveReviewPanel(props: LiveReviewPanelProps) {
  const { api, id, view, select, historyCover, historyProbe, config, historyState } = props
  let panel: BoxRenderable | undefined
  let heading: Renderable | undefined
  let ratingRegion: BoxRenderable | undefined
  let footer: BoxRenderable | undefined
  let description: MarkdownRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let attempt = 0
  createEffect(() => {
    const progress = view().progress
    if (progress && progress.attempt !== attempt) {
      attempt = progress.attempt
      scroll?.scrollTo(0)
    }
  })
  const rating = () => view().assessment?.safe ?? (view().status === "analyzing" ? view().progress?.preview?.safe : undefined)
  const report = () => view().assessment?.desc ?? (view().status === "analyzing" ? view().progress?.preview?.desc : undefined) ?? ""
  let paintedAssessment: View["assessment"]
  let readyAssessment: View["assessment"]
  const geometry = new ReviewGeometryProof()
  const ownsPanelProbes = (owner: Renderable | undefined) => !!panel && !!owner && !owner.isDestroyed && owner.visible
    && ownsHit(owner, api.renderer.hitTest(panel.x + 2, panel.y + 1))
    && ownsHit(owner, api.renderer.hitTest(panel.x + 2, panel.y + panel.height - 3))
  const coveredByProbe = () => {
    if (!panel) return false
    const session = props.sidebarSession()
    if (session && historyCover.covers(session, [api.renderer.hitTest(panel.x + 2, panel.y + 1),
      api.renderer.hitTest(panel.x + 2, panel.y + panel.height - 3)])) return true
    try { return !!historyProbe?.cover && ownsPanelProbes(historyProbe.cover()) } catch { return false }
  }
  const observeRender = (stage: HistoryRenderProbeEvent["stage"], eligible: boolean, proof?: PresentationState, check?: PresentationCheck) => {
    if (!historyProbe || !panel) return
    const countCode = (node: Renderable): number => Number(node instanceof CodeRenderable)
      + node.getChildren().reduce((total, child) => total + countCode(child), 0)
    const assessment = view().assessment
    const auto = view().autoApproval
    try {
      const pending = historyProbe.observe(Object.freeze({ stage, check, at: performance.now(), panel: panel.num,
        markdown: description?.num, final: !!assessment, streaming: description?.streaming ?? true,
        contentMatches: !!assessment && description?.content === displayText(assessment.desc),
        children: description?.getChildrenCount() ?? 0, codeBlocks: description ? countCode(description) : 0,
        highlighting: !!description && !highlightingComplete(description),
        painted: !!assessment && paintedAssessment === assessment, covered: coveredByProbe(),
        physical: ownsPanelProbes(panel), eligible, presentation: proof ?? presentation().state, auto: auto?.status,
        seconds: auto?.status === "countdown" ? auto.seconds : undefined,
        history: historyState().open ? historyState().status : undefined }))
      if (pending) void Promise.resolve(pending).catch(() => {})
    } catch { /* Fixture observations cannot change approval behavior. */ }
  }
  const presentation = (frame = false): ReviewPresentation => {
    const lost = { state: "lost" } as const
    const pending = { state: "pending", id } as const
    if (!props.sidebarSession() || select()?.request.id !== id) return lost
    const sidebar = props.sidebarState()
    if (sidebar === "lost") return lost
    const layout = geometry.state({ width: api.renderer.width, height: api.renderer.height, fast: config?.fastMode === true,
      owner: props.sidebarOwner(), panel, heading, rating: ratingRegion, report: scroll, footer }, frame)
    if (layout === "lost") return lost
    if (sidebar === "pending" || layout === "pending") return pending
    // Fast mode needs the current native blocker physically visible,
    // but never waits for final Markdown or a completed assessment.
    if (config?.fastMode) return ownsPanelProbes(panel) ? { state: "visible", id } : lost
    if (!paintedAssessment || paintedAssessment !== view().assessment) return pending
    // Final Markdown can have measured height while its text
    // is still hidden pending highlighting. Wait for it once;
    // scrolling newly exposed code must not interrupt the countdown.
    if (readyAssessment !== paintedAssessment) {
      if (!description || description.isDestroyed || !description.getChildrenCount() || !highlightingComplete(description)) return pending
      readyAssessment = paintedAssessment
    }
    // Public hit testing detects native fullscreen portals that cover
    // the panel without unmounting its sidebar or opening a dialog.
    // Probe the heading and the footer's interior padding, not the
    // outermost rows left uncovered by native fullscreen. The footer
    // padding also retains its hit target when buttons are replaced
    // by Allowing… before the next frame updates the hit grid.
    if (!ownsPanelProbes(panel) && !coveredByProbe()) return lost
    return { state: "visible", id }
  }
  const releasePresentation = config?.autoApprove ? props.registerPresentation((check = "eligibility") => {
    const proof = presentation()
    observeRender("presentation", proof.state === "visible", proof.state, check)
    return proof
  }) : undefined
  if (config?.autoApprove || props.traceFor) {
    const resize = () => geometry.invalidate()
    api.renderer.on(CliRenderEvents.RESIZE, resize)
    const frame = () => {
      // Expire the previous hit-grid handoff before proving this
      // frame. Keep the new proof for transitions before next paint.
      historyCover.frame()
      const proof = presentation(true)
      const presented = proof.state === "visible"
      const trace = props.traceFor?.(view())
      if (trace) {
        // Preview visibility probes the status row, not an as-yet absent
        // approval footer. Code-only previews wait for highlighting.
        if (select()?.request.id === id && panel
          && ownsHit(panel, api.renderer.hitTest(panel.x + 2, panel.y + 1))
          && ownsHit(panel, api.renderer.hitTest(panel.x + 2, panel.y + 3))
          && (rating() !== undefined || (report() && description && !description.isDestroyed
            && description.getChildrenCount() && highlightingComplete(description)))) trace.once("first-display")
        // Keep this physical-display diagnostic truthful under the
        // history-only cover exception; readiness observations are separate.
        if (presented && paintedAssessment && paintedAssessment === view().assessment && ownsPanelProbes(panel)) trace.once("final-render")
      }
      if (config?.autoApprove) {
        props.onPresented(proof)
        if (presented && view().autoApproval?.status === "countdown") trace?.once("approval-countdown")
      }
      observeRender("frame", !!presented)
    }
    api.renderer.on(CliRenderEvents.FRAME, frame)
    onCleanup(() => {
      api.renderer.off(CliRenderEvents.FRAME, frame)
      api.renderer.off(CliRenderEvents.RESIZE, resize)
      if (config?.autoApprove) {
        releasePresentation!()
        props.onPresented()
      }
    })
  }
  return (
    // The verified host's sidebar is 42 columns, including its padding.
    // The app slot lets this cover its title, sections, and footer while
    // the original sidebar remains mounted beneath it on root routes. Descendant
    // routes hide the enclosing slot; automation has its own route-only proof.
    <box ref={(value: BoxRenderable) => { panel = value }} renderAfter={() => {
      const assessment = view().assessment
      if (assessment && paintedAssessment !== assessment && description && !description.isDestroyed
        && !description.streaming && description.content === displayText(assessment.desc)
        && description.getChildrenCount() && highlightingComplete(description)) paintedAssessment = assessment
      observeRender("render-after", false)
    }}
      position="absolute" top={0} right={0} bottom={0} width={42} zIndex={1}
      paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}
      backgroundColor={api.theme.current.backgroundPanel}>
      <text ref={(value: Renderable) => { heading = value }} fg={api.theme.current.text} flexShrink={0}><b>{uiText.review.heading}</b></text>
      <box ref={(value: BoxRenderable) => { ratingRegion = value }} marginTop={1} flexShrink={0}>
        <Show when={rating() !== undefined}>
          <text fg={rating() ? api.theme.current.success : api.theme.current.error}>
            <b>{rating() ? uiText.review.safe : uiText.review.unsafe}</b>
          </text>
        </Show>
        <Show when={view().status === "analyzing" && rating() === undefined}>
          <ReviewLoading api={api} retrying={view().progress?.phase === "retrying"} />
        </Show>
        <Show when={view().status === "unavailable"}>
          <text fg={api.theme.current.warning}><b>{uiText.review.unavailable}</b></text>
        </Show>
      </box>
      <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} marginTop={1} flexGrow={1} minHeight={0} contentOptions={{ minHeight: 0 }}
        scrollbarOptions={{ trackOptions: {
          backgroundColor: api.theme.current.backgroundPanel,
          foregroundColor: api.theme.current.textMuted,
        } }}>
        <ReviewDescription api={api} text={report()} streaming={view().status === "analyzing"} ref={(value) => { description = value }} />
        <Show when={view().status === "unavailable"}>
          <text fg={api.theme.current.text} width="100%" flexShrink={0}>
            {displayText(view().error ?? uiText.review.failed)}
          </text>
        </Show>
        <Show when={view().assessment?.usage}>{(usage) => <>
          <text marginTop={1} fg={api.theme.current.textMuted} width="100%" flexShrink={0}>{usageText(usage())}</text>
          <Show when={props.lifetimeText()}>{(text) =>
            <text fg={api.theme.current.textMuted} width="100%" flexShrink={0}>{text()}</text>
          }</Show>
        </>}</Show>
      </scrollbox>
      <ReviewFooter ref={(value) => { footer = value }} api={api} view={view()} onApprove={props.onApprove} onCancel={props.onCancel} enabled={config?.autoApprove === true} />
    </box>
  )
}
