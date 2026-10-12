import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { ReviewProgress, ReviewResult, ReviewTiming } from "./types.js"
import type { Config } from "./config.js"
import type { ApprovalTransport as LegacyApprovalTransport } from "./approval.js"
import { isDeepStrictEqual } from "node:util"
import { randomUUID } from "node:crypto"
import { withDeadline } from "./reviewer.js"
import { candidateEnabled, type ReviewOptions } from "./classification.js"
import type { SessionModeGate } from "./session-mode.js"
import { SCANNER_INTERVAL_MS } from "./appearance.js"
import { remainingTime, reviewStage } from "./deadline.js"
import { uiText } from "./ui-text.js"
import type { HistoryTarget } from "./history-records.js"
import type { PresentationCheck } from "./review-presentation.js"
import { conversationRoot, type ApprovalPresentation, type ApprovalPresentationState } from "./route-approval.js"
import { ReviewAdmission, type ReviewEvaluation } from "./review-admission.js"

export type AutoApproval = { status: "countdown"; seconds: number } | { status: "checking" | "allowing" | "cancelled" | "failed" | "approved" }

export interface RequestIdentity { readonly id: string; readonly sessionID: string }

export interface View<R extends RequestIdentity = PermissionRequest> {
  request: R
  status: "identifying" | "unidentified" | "analyzing" | "complete" | "unavailable" | "unrelated" | "suspended"
  assessment?: ReviewResult
  progress?: ReviewProgress
  error?: string
  autoApproval?: AutoApproval
  approvalPendingConfirmed?: boolean
  /** Fast-mode dispatched review retained independently of native permission lifetime. */
  retained?: boolean
  resolved?: boolean
}

export type Evaluate<R extends RequestIdentity = PermissionRequest> = (request: R, signal: AbortSignal, onIdentified: () => void, onProgress: (progress: ReviewProgress) => void,
  execution?: { review: string; root?: string }) => ReviewEvaluation<ReviewResult | null>
interface Entry<R extends RequestIdentity = PermissionRequest> {
  view: View<R>; abort: AbortController; root?: string; gateRevision: number
  suspension?: "mode" | "unavailable"
  cancelTimer?: () => void; deadline?: number; approvalAbort?: AbortController
  attempt: number; progressGeneration: number; pendingProgress?: ReviewProgress; cancelProgress?: () => void
  startedAt?: number; ratingAt?: number
  review: string
  approvalDispatched?: boolean
  approvalRefresh?: boolean
  /** Once started, real cancellation remains durable even between Safe ratings. */
  approvalArmed?: boolean
  /** The revoked reservation still owns its physical verification read. */
  approvalPaused?: boolean
  approvalPaintPending?: boolean
  fastApproval?: "pending" | "confirmed"
}

export interface ApprovalClock {
  now(): number
  after(ms: number, callback: () => void): () => void
}
const clock: ApprovalClock = {
  now: () => performance.now(),
  after: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) },
}
const permissionResolved = Object.freeze({ reason: "permission resolved" })
const requestChanged = Object.freeze({ reason: "pending request changed" })
type Options = ReviewOptions & Partial<Pick<Config, "autoApprove" | "fastMode" | "autoApproveDelaySeconds" | "stream">>
/** Legacy confirmation contract. Native HTTP responses need their own dispatch
 * and confirmation seam before they can be connected to automatic approval. */
export interface ApprovalTransport<R extends RequestIdentity = PermissionRequest> {
  list: (signal: AbortSignal) => Promise<R[]>
  once: (request: R, signal: AbortSignal) => Promise<void>
}
export interface Approval<R extends RequestIdentity = PermissionRequest> extends ApprovalTransport<R> {
  /** Recompute actual presentation/order, rather than trusting a stale UI effect. */
  visibleID(): string | undefined
  /** Distinguish revoked paint from established physical/native-priority loss. */
  presentation?(check?: PresentationCheck): ApprovalPresentation
}

export type ApprovalFact<R extends RequestIdentity = PermissionRequest> = { type: "dispatched" | "confirmed" | "settled"; request: R; automatic: boolean;
  approval?: string; review?: string; result?: "not-sent" | "uncertain" }
export type ApprovalObserver<R extends RequestIdentity = PermissionRequest> = (fact: ApprovalFact<R>) => unknown
export type ReviewLifecycleFact<R extends RequestIdentity = PermissionRequest> =
  | { type: "accepted"; request: R; result: ReviewResult; timing: ReviewTiming; root?: string; review: string; completedAt: number }
  | { type: "cancelled"; request: R; reason: "explicit" | "visibility" | "mode" }
  | { type: "removed"; request: R; reason: "resolved" | "reconciled" | "deleted" | "disposed" }
export type ReviewLifecycleObserver<R extends RequestIdentity = PermissionRequest> = (fact: ReviewLifecycleFact<R>) => unknown

export type NativeFront<R extends RequestIdentity = PermissionRequest> = (root: string, pending: readonly R[]) => string | undefined

/** Only the legacy candidate policy reads SDK fields. Native requests without
 * this discriminator stay unrelated unless their host supplies a predicate. */
function legacyCandidate(request: RequestIdentity, options: ReviewOptions): boolean {
  const legacy = (value: RequestIdentity): value is PermissionRequest => "permission" in value && typeof value.permission === "string"
  return legacy(request) && candidateEnabled(request, options)
}

export interface ControllerOptions<R extends RequestIdentity = PermissionRequest> {
  reviewOptions?: Options
  approval?: Approval<R>
  clock?: ApprovalClock
  modes?: SessionModeGate
  /** Public host metadata distinguishes native root/direct-child priority from deeper descendants. */
  session?: (id: string) => { id: string; parentID?: string } | undefined
  candidate?: (request: R, options: ReviewOptions) => boolean
  /** Actual public native queue ownership, independent of review eligibility.
   * A callback may read an external queue including requests absent from entries. */
  nativeFront?: NativeFront<R>
  /** Historical V1 F34 route exception. Native V2 callers must set false. */
  allowHiddenRoute?: boolean
  onApproval?: ApprovalObserver<R>
  onRating?: (safe: boolean, timing: ReviewTiming) => unknown
  onLifecycle?: ReviewLifecycleObserver<R>
}

/** Reviews remain advisory unless explicitly configured with a once-only writer. */
class ControllerCore<R extends RequestIdentity = PermissionRequest> {
  private entries = new Map<string, Entry<R>>()
  private stopped = false
  private version = 0
  private selectedID: string | undefined
  private modeChanges = new Map<string, number>()
  private manual = new Map<string, "cancelled" | "failed">()
  private workers = new Set<Promise<unknown>>()
  private admission = new ReviewAdmission(root => this.nativeFront(root))
  private acknowledgements = new Map<AbortController, { request: R; root?: string }>()
  private approvalWorkers = new Set<Promise<unknown>>()
  private approvalRead?: Promise<R[]>
  private reconciliation = 0
  private reconciliationPublished = false
  private options: Options
  private approval?: Approval<R>
  private time: ApprovalClock
  private modes?: SessionModeGate
  private session?: ControllerOptions<R>["session"]
  private candidate: NonNullable<ControllerOptions<R>["candidate"]>
  private priority?: NativeFront<R>
  private allowHiddenRoute: boolean
  private approvalObserver?: ApprovalObserver<R>
  private ratingObserver?: ControllerOptions<R>["onRating"]
  private lifecycleObserver?: ReviewLifecycleObserver<R>
  constructor(private evaluate: Evaluate<R>, private changed: (views: View<R>[]) => void,
    { reviewOptions = { reviewBash: true, reviewEdits: true }, approval, clock: time = clock, modes,
      onApproval, onRating, onLifecycle, session, candidate = legacyCandidate, nativeFront, allowHiddenRoute = true }: ControllerOptions<R> = {}) {
    this.options = reviewOptions
    this.approval = approval
    this.time = time
    this.modes = modes
    this.session = session
    this.candidate = candidate
    this.priority = nativeFront
    this.allowHiddenRoute = allowHiddenRoute
    this.approvalObserver = onApproval
    this.ratingObserver = onRating
    this.lifecycleObserver = onLifecycle
  }
  get revision() { return this.version }
  /** Notifications consume only the final pending snapshot. UI publications keep
   * their synchronous W1 visibility/cancellation behavior during reconciliation. */
  get reconciling() { return this.reconciliation > 0 }
  get views() { return [...this.entries.values()].map((entry) => entry.view) }
  get pendingViews() { return this.views.filter(view => !view.resolved) }
  retained(root: string, target: HistoryTarget) {
    const entry = this.entries.get(target.permission)
    return entry?.fastApproval === "confirmed" && entry.view.status === "analyzing"
      && entry.view.request.sessionID === target.session && entry.root === root ? entry.view : undefined
  }
  private publish() {
    if (this.reconciling) this.reconciliationPublished = true
    if (!this.stopped) this.changed(this.views)
  }
  private approvalFact(fact: ApprovalFact<R>) {
    if (this.stopped) return
    try { void Promise.resolve(this.approvalObserver?.(fact)).catch(() => {}) } catch {}
  }
  private lifecycleFact(fact: ReviewLifecycleFact<R>) {
    try { void Promise.resolve(this.lifecycleObserver?.(fact)).catch(() => {}) } catch {}
  }

  private nativeFront(root: string) {
    if (this.priority) return this.priority(root, this.pendingViews.map(view => view.request))
    let first: R | undefined
    for (const entry of this.entries.values()) {
      const request = entry.view.request
      if (entry.view.resolved || (request.sessionID !== root && (this.session
        ? this.session(request.sessionID)?.parentID !== root : entry.root !== root))) continue
      if (!first || request.sessionID < first.sessionID || (request.sessionID === first.sessionID && request.id < first.id)) first = request
    }
    return first?.id
  }

  /** Local state is already switched; invalidate snapshots before any publication. */
  modeChanged(root: string) {
    if (this.stopped) return
    this.modeChanges.set(root, ++this.version)
    for (const entry of this.entries.values()) if (entry.root === root) this.suspend(entry)
    this.publish()
  }

  private suspend(entry: Entry<R>, reason: "mode" | "unavailable" = "mode") {
    // A dispatched fast approval cannot be unsent. Finish its acknowledgement and
    // assessment even if review is disabled while the POST is settling.
    if (entry.fastApproval) return
    const id = entry.view.request.id
    const state = entry.view.autoApproval?.status
    if (entry.approvalArmed && !this.manual.has(id) && !entry.approvalDispatched)
      this.lifecycleFact({ type: "cancelled", request: entry.view.request, reason: "mode" })
    const uncertain = state === "failed" || (state === "allowing" && entry.approvalDispatched)
    if (state || entry.approvalArmed) this.manual.set(id, uncertain ? "failed" : "cancelled")
    entry.cancelTimer?.()
    this.clearProgress(entry)
    entry.approvalAbort?.abort()
    entry.abort.abort()
    entry.suspension = reason
    entry.view = { request: entry.view.request, status: "suspended",
      // Suspension hides the report, but cannot turn an uncertain/dispatched
      // approval into a confirmed manual wait. Read-only reconciliation still
      // owns that confirmation, and the existing tombstone still forbids retry.
      ...(uncertain ? { autoApproval: { status: "failed" as const },
        ...(state === "failed" && entry.view.approvalPendingConfirmed ? { approvalPendingConfirmed: true } : {}) } : {}),
    }
  }

  /** Physical presentation and intentional same-root suppression are distinct proofs. */
  presented(value?: string | ApprovalPresentation) {
    if (this.stopped) return
    const proof = typeof value === "string" ? { state: "visible" as const, id: value } : value ?? { state: "lost" as const }
    const id = proof.state === "lost" ? undefined : proof.id
    if (id !== this.selectedID) {
      const old = this.selectedID
      this.selectedID = id
      if (old) this.cancelAutoApproval(old, "visibility")
    }
    const entry = id ? this.entries.get(id) : undefined
    if (entry?.approvalArmed && this.presentationState(entry) === "lost") this.cancelAutoApproval(entry.view.request.id, "visibility")
    if (entry && (proof.state === "visible" || proof.state === "route-hidden")) {
      this.startApproval(entry)
      if (entry.view.autoApproval?.status === "countdown" && !entry.cancelTimer && !entry.approvalAbort) this.schedule(entry)
    }
  }

  /** Rating/settlement callbacks are not painted-frame observations. They may
   * start eligible work, but cannot prove a hide from an unpainted publication. */
  private startApproval(entry: Entry<R>) {
    if (entry.view.autoApproval || entry.approvalAbort || entry.approvalRefresh || !this.eligible(entry)) return
    entry.approvalArmed = true
    if (this.options.fastMode) {
      entry.view = { ...entry.view, autoApproval: { status: "checking" } }
      this.publish()
      void this.approveNow(entry.view.request.id, true)
      return
    }
    const seconds = this.options.autoApproveDelaySeconds ?? 15
    // A short initial grace makes the starting value observable without adding
    // a full second. Zero remains an immediate attempt.
    entry.deadline = this.time.now() + seconds * 1000 + (seconds > 0 ? 200 : 0)
    entry.view = { ...entry.view, autoApproval: { status: "countdown", seconds } }
    this.publish()
    // Even zero delay goes through the same cancellable single-flight path.
    this.schedule(entry)
  }

  cancelAutoApproval(id: string, reason: "explicit" | "visibility" = "explicit") {
    const entry = this.entries.get(id)
    if (!entry || !entry.approvalArmed || entry.approvalDispatched || this.manual.has(id)) return
    this.lifecycleFact({ type: "cancelled", request: entry.view.request, reason })
    entry.cancelTimer?.()
    entry.cancelTimer = undefined
    entry.approvalAbort?.abort()
    this.manual.set(id, "cancelled")
    entry.view = { ...entry.view, autoApproval: { status: "cancelled" } }
    this.publish()
  }

  private active(entry: Entry<R>) {
    return !this.stopped && !entry.abort.signal.aborted && this.entries.get(entry.view.request.id) === entry
  }

  private reviewing(entry: Entry<R>) {
    return this.active(entry) && entry.view.status === "analyzing"
      && (!!entry.fastApproval || !this.modes || (entry.root !== undefined && this.modes.enabled(entry.root)
        && (this.modeChanges.get(entry.root) ?? 0) <= entry.gateRevision))
  }

  private clearProgress(entry: Entry<R>) {
    entry.progressGeneration++
    entry.cancelProgress?.()
    entry.cancelProgress = undefined
    entry.pendingProgress = undefined
  }

  private progress(entry: Entry<R>, value: ReviewProgress) {
    if (!this.reviewing(entry) || !Number.isSafeInteger(value.attempt) || value.attempt < 0 || value.attempt < entry.attempt) return
    if (value.attempt > entry.attempt) {
      // Only an explicit attempt start can advance the generation. Delayed chunks
      // from an old attempt cannot restart it or clear a newer report.
      if (value.attempt !== entry.attempt + 1 || value.phase !== (value.attempt ? "retrying" : "evaluating")) return
      this.clearProgress(entry)
      entry.attempt = value.attempt
      entry.ratingAt = undefined
      entry.view = { ...entry.view, progress: { attempt: value.attempt, phase: value.phase } }
      this.pauseRating(entry)
      this.publish()
      return
    }
    if (value.phase !== "streaming" || this.options.stream !== true) return
    if (!value.preview) {
      this.clearProgress(entry)
      entry.view = { ...entry.view, progress: { attempt: value.attempt, phase: value.phase } }
      this.pauseRating(entry)
      this.publish()
      return
    }
    const preview = { ...(typeof value.preview.safe === "boolean" ? { safe: value.preview.safe } : {}),
      ...(typeof value.preview.desc === "string" ? { desc: value.preview.desc } : {}) }
    if (typeof preview.safe === "boolean" && entry.ratingAt === undefined) entry.ratingAt = this.time.now()
    entry.pendingProgress = { attempt: value.attempt, phase: "streaming", preview }
    if (preview.safe !== entry.view.progress?.preview?.safe) {
      const desc = entry.view.progress?.preview?.desc
      entry.view = { ...entry.view, progress: { attempt: value.attempt, phase: "streaming",
        preview: { ...(preview.safe === undefined ? {} : { safe: preview.safe }), ...(desc === undefined ? {} : { desc }) } } }
      if (preview.safe !== true) this.pauseRating(entry)
      this.publish() // Rating is immediate; text remains on the coalesced cadence.
      if (this.options.fastMode && preview.safe === true) this.startApproval(entry)
    }
    if (!this.reviewing(entry) || entry.cancelProgress || !entry.pendingProgress) return
    const generation = entry.progressGeneration
    const attempt = entry.attempt
    entry.cancelProgress = this.time.after(SCANNER_INTERVAL_MS, () => {
      if (!this.reviewing(entry) || entry.progressGeneration !== generation || entry.attempt !== attempt) return
      entry.cancelProgress = undefined
      const progress = entry.pendingProgress
      entry.pendingProgress = undefined
      if (progress) { entry.view = { ...entry.view, progress }; this.publish() }
    })
  }

  private safe(entry: Entry<R>) {
    return entry.view.status === "complete" ? entry.view.assessment?.safe === true
      : this.options.fastMode === true && entry.view.status === "analyzing" && entry.view.progress?.preview?.safe === true
  }

  private presentationState(entry: Entry<R>, check: PresentationCheck = "eligibility"): ApprovalPresentationState {
    if (!this.active(entry) || entry.view.resolved || entry.fastApproval || this.options.autoApprove !== true
      || (this.modes && (entry.root === undefined || !this.modes.enabled(entry.root)))
      || this.selectedID !== entry.view.request.id) return "lost"
    if (this.priority) {
      const root = entry.root ?? (this.session ? conversationRoot(entry.view.request.sessionID, this.session) : entry.view.request.sessionID)
      if (!root || this.nativeFront(root) !== entry.view.request.id) return "lost"
    }
    const proof = this.approval?.presentation?.(check)
    if (proof?.state === "route-hidden") return this.allowHiddenRoute && entry.root === proof.root && proof.id === entry.view.request.id
      && this.nativeFront(proof.root) === proof.id ? "route-hidden" : "lost"
    if (proof) return proof.state !== "lost" && proof.id === entry.view.request.id ? proof.state : "lost"
    return this.approval?.visibleID() === entry.view.request.id ? "visible" : "lost"
  }

  private eligible(entry: Entry<R>) {
    if (this.manual.has(entry.view.request.id) || entry.approvalPaused || !this.safe(entry)) return false
    const state = this.presentationState(entry)
    return state === "visible" || state === "route-hidden"
  }

  /** Rating rejection revokes the reservation, even if Safe returns before its GET.
   * Keep the armed lifetime so real presentation loss/Cancel remains durable. */
  private pauseRating(entry: Entry<R>) {
    if (!entry.approvalArmed || entry.approvalDispatched || this.manual.has(entry.view.request.id)) return
    if (entry.view.status !== "analyzing") {
      // A terminal non-Safe result needs manual attention now, independently of
      // a timed-out GET. Retain the read/token and armed lifetime through actual
      // settlement, but stop displaying or reconciling an automation wait.
      entry.approvalRefresh = false
      entry.approvalPaused = !!entry.approvalAbort
      entry.approvalAbort?.abort()
      entry.view = { ...entry.view, autoApproval: undefined }
      return
    }
    // Clearing a preview can remove footer/report hit owners before the next
    // paint. Repeated parser clears and retry starts must only revoke the rating,
    // not reinterpret that self-induced layout change as a physical hide.
    if (entry.approvalPaused || !entry.view.autoApproval) return
    entry.approvalPaused = !!entry.approvalAbort
    entry.approvalAbort?.abort()
    entry.view = { ...entry.view, autoApproval: entry.approvalRefresh ? { status: "checking" } : undefined }
  }

  private approvalEligible(entry: Entry<R>, check: "timer" | "verification" = "verification") {
    const state = this.presentationState(entry, check)
    if (state === "lost") this.cancelAutoApproval(entry.view.request.id, "visibility")
    else if (state === "pending") entry.approvalPaintPending = true
    else if (!this.safe(entry)) this.pauseRating(entry)
    return this.eligible(entry)
  }

  /** Do not await noncooperative I/O in the caller, or release its reservation on
   * timeout. The callback runs only after the physical slot has actually settled. */
  private afterApprovalRead(entry: Entry<R>, abort: AbortController, run: () => void | Promise<void>): Promise<void> {
    const settled = async () => {
      if (entry.approvalAbort !== abort || !this.active(entry) || this.manual.has(entry.view.request.id)) return
      await run()
    }
    if (this.approvalRead) {
      void this.approvalRead.then(settled, settled).catch(() => {})
      return Promise.resolve()
    }
    return settled()
  }

  private async recoverApproval(entry: Entry<R>, abort: AbortController) {
    await this.afterApprovalRead(entry, abort, async () => {
      // Invalidate polls started before actual settlement. One bounded read-only
      // recovery follows; errors then wait for ordinary fresh reconciliation.
      const revision = ++this.version
      try {
        // A later rating clear may already have revoked this recovery, too.
        abort.signal.throwIfAborted()
        if (this.presentationState(entry) === "lost") { this.cancelAutoApproval(entry.view.request.id, "visibility"); return }
        const pending = await withDeadline(AbortSignal.any([entry.abort.signal, abort.signal]), 5000,
          signal => this.approvalList(signal))
        if (!this.active(entry) || this.manual.has(entry.view.request.id)) return
        entry.approvalAbort = undefined
        entry.approvalPaused = false
        this.reconcile(pending, revision)
      } catch {
        await this.afterApprovalRead(entry, abort, () => {
          ++this.version
          entry.approvalAbort = undefined
          entry.approvalPaused = false
        })
      }
    })
  }

  private schedule(entry: Entry<R>) {
    if (!this.active(entry) || entry.view.autoApproval?.status !== "countdown" || entry.cancelTimer) return
    const remaining = Math.max(0, entry.deadline! - this.time.now())
    // Wake at the next displayed-second boundary, including the initial grace,
    // rather than letting a fixed one-second polling cadence lag behind it.
    const next = remaining > 0 ? remaining - (Math.ceil(remaining / 1000) - 1) * 1000 : 0
    entry.cancelTimer = this.time.after(next, () => {
      entry.cancelTimer = undefined
      if (!this.active(entry) || entry.view.autoApproval?.status !== "countdown") return
      const visible = this.approvalEligible(entry, "timer")
      if (this.manual.has(entry.view.request.id)) return
      const seconds = Math.min(this.options.autoApproveDelaySeconds ?? 15,
        Math.max(0, Math.ceil((entry.deadline! - this.time.now()) / 1000)))
      if (entry.view.autoApproval.seconds !== seconds) {
        entry.view = { ...entry.view, autoApproval: { status: "countdown", seconds } }
        this.publish()
      }
      if (seconds === 0) {
        // No polling loop or grace restart while waiting for renewed paint.
        if (visible) void this.approveNow(entry.view.request.id, true)
        return
      }
      this.schedule(entry)
    })
  }

  /** A deadline can stop waiting, but only actual list settlement frees the slot. */
  private async approvalList(signal: AbortSignal) {
    while (this.approvalRead) {
      await this.approvalRead.catch(() => {})
      reviewStage(signal, "Approval verification")
    }
    reviewStage(signal, "Approval verification")
    const read = this.approval!.list(signal)
    this.approvalRead = read
    try { return await read }
    finally { if (this.approvalRead === read) this.approvalRead = undefined }
  }

  async approveNow(id: string, automatic = false) {
    const entry = this.entries.get(id)
    if (!entry || !this.approval || entry.approvalRefresh || !(entry.view.autoApproval?.status === "countdown"
      || (this.options.fastMode && automatic && entry.view.autoApproval?.status === "checking" && !entry.approvalAbort))) return
    if (!this.approvalEligible(entry)) return
    entry.cancelTimer?.()
    entry.cancelTimer = undefined
    const abort = entry.approvalAbort = new AbortController()
    entry.approvalPaintPending = false
    entry.view = { ...entry.view, autoApproval: { status: "checking" } }
    this.publish()
    let dispatched = false
    let confirmed = false
    const approvalID = randomUUID()
    const fact = (type: ApprovalFact<R>["type"]) => this.approvalFact({ type, request: entry.view.request, automatic,
      approval: approvalID, review: entry.review,
      ...(type === "settled" && !confirmed ? { result: dispatched ? "uncertain" as const : "not-sent" as const } : {}) })
    try {
      await withDeadline(AbortSignal.any([entry.abort.signal, abort.signal]), 5000, async (signal) => {
        // Three sequential reads bound churn without accepting a stale snapshot
        // or replenishing the original five-second read/write budget.
        for (let reads = 0; reads < 3; reads++) {
          reviewStage(signal, "Approval verification")
          if (!this.approvalEligible(entry)) return
          const revision = this.version
          const pending = await this.approvalList(signal)
          reviewStage(signal, "Approval verification")
          if (!this.approvalEligible(entry)) return
          if (revision !== this.version) continue
          const current = pending.find((request) => request.id === id)
          if (!current) { this.replied(id, true, "reconciled"); return }
          if (!isDeepStrictEqual(current, entry.view.request)) throw requestChanged
          const verified = structuredClone(current)
          this.reconcile(pending, revision)
          const verifiedRevision = this.version
          if (!this.approvalEligible(entry)) return
          // This is only a cancellable reservation. Publication may schedule
          // microtasks that change eligibility before the deferred write callback.
          entry.view = { ...entry.view, autoApproval: { status: "allowing" } }
          this.publish()
          const remaining = remainingTime(signal)
          const acknowledgement = new AbortController()
          const abort = () => { if (!dispatched || signal.reason !== permissionResolved) acknowledgement.abort(signal.reason) }
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
          const write = withDeadline(acknowledgement.signal, remaining, async (bounded) => {
            reviewStage(signal, "Approval verification")
            reviewStage(bounded, "Approval acknowledgement")
            if (!this.approvalEligible(entry)) return
            if (verifiedRevision !== this.version) return
            if (!isDeepStrictEqual(verified, entry.view.request)) throw requestChanged
            reviewStage(signal, "Approval verification")
            reviewStage(bounded, "Approval acknowledgement")
            // No observer, publication or await may separate this guard and once.
            // Mark actual invocation first so synchronous native resolution inside
            // the transport keeps the same bounded acknowledgement/fast response.
            this.manual.set(id, "failed")
            dispatched = true
            entry.approvalDispatched = true
            if (this.options.fastMode && automatic) {
              entry.fastApproval = "pending"
              entry.view = { ...entry.view, retained: true }
            }
            this.acknowledgements.set(acknowledgement, { request: entry.view.request, root: entry.root })
            try {
              let response: Promise<void>
              try { response = this.approval!.once(entry.view.request, bounded) }
              finally { fact("dispatched") } // Even a synchronous throw is an invoked, uncertain write.
              await response
              if (!bounded.aborted) {
                confirmed = true
                if (entry.fastApproval && this.active(entry)) {
                  entry.fastApproval = "confirmed"
                  entry.view = { ...entry.view, resolved: true, autoApproval: { status: "approved" } }
                }
                fact("confirmed")
                if (entry.fastApproval && this.active(entry)) { this.publish(); this.finishFast(entry) }
              }
            } finally { fact("settled") }
          }).finally(() => {
            this.acknowledgements.delete(acknowledgement)
            signal.removeEventListener("abort", abort)
          })
          this.approvalWorkers.add(write)
          void write.then(() => this.approvalWorkers.delete(write), () => this.approvalWorkers.delete(write))
          await write
          signal.throwIfAborted()
          if (dispatched) { this.replied(id); return }
          if (!this.approvalEligible(entry)) return
          entry.view = { ...entry.view, autoApproval: { status: "checking" } }
          this.publish()
        }
        // Exhausted stale snapshots are neither cancellation nor uncertain writes.
        // Stay silent until ordinary fresh reconciliation releases this reservation;
        // repeated frames/clicks cannot create an unbounded verification loop.
        if (this.active(entry)) {
          entry.approvalRefresh = true
          entry.view = { ...entry.view, autoApproval: { status: "checking" } }
          this.publish()
        }
      })
    } catch (error) {
      // A native reply may abort our in-flight HTTP response after accepting it.
      if (!this.active(entry) || entry.view.autoApproval?.status === "cancelled") return
      if (!dispatched && error !== requestChanged && !this.manual.has(id)) {
        if (entry.approvalPaused) return
        entry.approvalRefresh = true
        entry.view = { ...entry.view, autoApproval: { status: "checking" } }
        this.publish()
        await this.recoverApproval(entry, abort)
        return
      }
      if (entry.fastApproval) {
        entry.fastApproval = undefined
        if (entry.view.resolved) { this.replied(id); return }
        entry.view = { ...entry.view, retained: undefined }
      }
      this.manual.set(id, "failed")
      entry.view = { ...entry.view, autoApproval: { status: "failed" } }
      if (entry.root !== undefined && this.modes && !this.modes.enabled(entry.root)) this.suspend(entry)
      this.publish()
      // Reconcile an uncertain outcome, without ever retrying the write.
      if (this.approvalRead) return // Timeout is not physical list settlement.
      const revision = this.version
      try {
        const pending = await withDeadline(entry.abort.signal, 5000, (signal) => this.approvalList(signal))
        this.reconcile(pending, revision)
      } catch { /* Periodic read-only reconciliation remains active. */ }
    } finally {
      if (!dispatched) {
        fact("settled")
        if (entry.approvalPaused) await this.afterApprovalRead(entry, abort, () => {
          entry.approvalAbort = undefined
          entry.approvalPaused = false
          if (this.options.fastMode && !entry.approvalRefresh) this.startApproval(entry)
        })
        else if (!entry.approvalRefresh && entry.approvalAbort === abort) entry.approvalAbort = undefined
        // Exhausted churn has already settled its reads, but still needs a poll.
        else if (entry.approvalRefresh && entry.approvalAbort === abort && !this.approvalRead) entry.approvalAbort = undefined
        if (entry.approvalPaintPending && !entry.approvalAbort && !entry.approvalRefresh && this.active(entry)
          && !this.manual.has(id) && this.safe(entry)) {
          entry.approvalPaintPending = false
          entry.view = { ...entry.view, autoApproval: this.options.fastMode ? undefined : { status: "countdown",
            seconds: Math.min(this.options.autoApproveDelaySeconds ?? 15, Math.max(0, Math.ceil((entry.deadline! - this.time.now()) / 1000))) } }
          this.publish()
          // Only a fresh synchronous proof can resume. Preserve the original end.
          if (this.eligible(entry)) {
            if (this.options.fastMode) this.startApproval(entry)
            else this.schedule(entry)
          }
        }
      }
    }
  }

  asked(request: R) {
    if (this.stopped || this.entries.has(request.id)) return
    this.version++
    const enabled = this.candidate(request, this.options)
    const entry: Entry<R> = {
      abort: new AbortController(),
      review: randomUUID(),
      attempt: -1, progressGeneration: 0,
      gateRevision: this.version,
      view: {
        request,
        status: enabled ? "identifying" : "unrelated",
        ...(this.manual.has(request.id) ? { autoApproval: { status: this.manual.get(request.id)! } } : {}),
      },
    }
    this.entries.set(request.id, entry)
    this.publish()
    if (entry.view.status === "unrelated") return
    const active = () => !this.stopped && !entry.abort.signal.aborted && this.entries.get(request.id) === entry
    const worker = Promise.resolve().then(async () => {
      entry.abort.signal.throwIfAborted()
      if (this.modes) {
        try {
          const root = await this.modes.root(request.sessionID, entry.abort.signal)
          if (!active()) return null
          entry.root = root
          await this.modes.load(root, entry.abort.signal)
          if (!active()) return null
          if (!this.modes.enabled(root) || (this.modeChanges.get(root) ?? 0) > entry.gateRevision) {
            this.suspend(entry); this.publish(); return null
          }
        } catch {
          if (active()) { this.suspend(entry, "unavailable"); this.publish() }
          return null
        }
      }
      return this.admission.run(request, entry.root ?? request.sessionID, entry.abort.signal, () => {
        if (!active()) return Promise.resolve(null)
        if (this.modes && (!this.modes.enabled(entry.root!) || (this.modeChanges.get(entry.root!) ?? 0) > entry.gateRevision)) {
          this.suspend(entry); this.publish(); return Promise.resolve(null)
        }
        entry.startedAt = this.time.now()
        return this.evaluate(request, entry.abort.signal, () => {
          // A timed-out evaluator may still call back after its review has settled.
          if (active() && (entry.view.status === "identifying" || entry.view.status === "analyzing")) {
            entry.view = { ...entry.view, status: "analyzing" }; this.publish()
          }
        }, (progress) => this.progress(entry, progress), { review: entry.review, root: entry.root })
      })
    }).then((assessment) => {
      this.clearProgress(entry)
      if (active()) {
        entry.view = assessment ? { ...entry.view, status: "complete", assessment, progress: undefined }
          : { ...entry.view, status: "unrelated", progress: undefined }
        if (!this.safe(entry)) this.pauseRating(entry)
        // Count final accepted reviews, not previews, transport attempts or UI
        // publications. Accounting failures cannot affect review or approval.
        if (assessment) {
          try {
            const fullReportMs = Math.max(0, this.time.now() - entry.startedAt!)
            const ratingMs = entry.ratingAt === undefined ? fullReportMs : Math.max(0, entry.ratingAt - entry.startedAt!)
            this.lifecycleFact({ type: "accepted", request, result: assessment, timing: { fullReportMs, ratingMs },
              root: entry.root, review: entry.review, completedAt: Date.now() })
            void Promise.resolve(this.ratingObserver?.(assessment.safe, { fullReportMs, ratingMs })).catch(() => {})
          } catch {}
        }
        this.publish()
        this.finishFast(entry)
      }
    }, (error: unknown) => {
      this.clearProgress(entry)
      if (active()) {
        entry.view = { ...entry.view, status: entry.view.status === "identifying" ? "unidentified" : "unavailable", progress: undefined, error: error instanceof Error ? error.message : uiText.review.failed }
        this.pauseRating(entry)
        this.publish()
        this.finishFast(entry)
      }
    })
    this.workers.add(worker)
    void worker.finally(() => this.workers.delete(worker))
  }

  replied(id: string, resolved = true, reason: "resolved" | "reconciled" = "resolved") {
    if (this.stopped) return
    // Increment even for an unknown ID: an in-flight snapshot may still contain it.
    this.version++
    this.entries.get(id)?.cancelTimer?.()
    const entry = this.entries.get(id)
    if (entry?.fastApproval && resolved) {
      entry.view = { ...entry.view, resolved: true }
      this.publish()
      this.finishFast(entry)
      return
    }
    if (entry) this.lifecycleFact({ type: "removed", request: entry.view.request, reason: resolved ? reason : "deleted" })
    if (entry) this.clearProgress(entry)
    this.entries.get(id)?.abort.abort(resolved ? permissionResolved : undefined)
    this.manual.delete(id)
    if (this.entries.delete(id)) this.publish()
  }

  private finishFast(entry: Entry<R>) {
    if (!this.active(entry) || entry.fastApproval !== "confirmed" || entry.view.status === "analyzing") return
    entry.fastApproval = undefined
    this.replied(entry.view.request.id)
  }

  deleted(sessionID: string) {
    if (this.stopped) return
    // A startup snapshot may contain requests for a session not yet tracked here.
    this.version++
    for (const [abort, value] of this.acknowledgements)
      if (value.request.sessionID === sessionID || value.root === sessionID) abort.abort()
    for (const entry of this.entries.values()) if (entry.view.request.sessionID === sessionID || entry.root === sessionID) this.replied(entry.view.request.id, false)
  }

  /** Reject stale HTTP snapshots if permission events arrived during the request. */
  reconcile(requests: readonly R[], revision: number) {
    if (this.stopped || this.version !== revision) return
    this.reconciliation++
    try {
      const ids = new Set(requests.map((request) => request.id))
      for (const [id, entry] of this.entries) if (!ids.has(id) && !entry.view.resolved) this.replied(id, true, "reconciled")
      for (const request of requests) {
        const entry = this.entries.get(request.id)
        if (entry && this.options.autoApprove && !entry.approvalDispatched && !this.manual.has(request.id)
          && !isDeepStrictEqual(request, entry.view.request)) {
          this.manual.set(request.id, "failed")
          entry.cancelTimer?.()
          entry.approvalAbort?.abort(requestChanged)
          entry.view = { ...entry.view, autoApproval: { status: "failed" } }
          this.publish()
        }
        if (entry?.approvalRefresh && !entry.approvalAbort && !this.approvalRead && !this.manual.has(request.id)
          && entry.view.autoApproval?.status === "checking") {
          entry.approvalRefresh = false
          entry.approvalAbort = undefined
          entry.view = { ...entry.view, autoApproval: undefined }
          this.publish()
        }
        if (entry?.view.autoApproval?.status === "failed" && !entry.view.approvalPendingConfirmed) {
          entry.view = { ...entry.view, approvalPendingConfirmed: true }
          this.publish()
        }
        if (entry && !entry.root) entry.gateRevision = this.version
        if (entry?.view.status === "suspended" && (entry.suspension === "unavailable" || !entry.root || this.modes?.enabled(entry.root))) {
          // A failed saved-mode read is unknown, not a cached disabled choice.
          // Only an accepted fresh snapshot may retry the gate, never enrichment directly.
          this.entries.delete(request.id)
        }
        this.asked(request)
      }
    } finally {
      this.reconciliation--
      if (!this.reconciling && this.reconciliationPublished) {
        this.reconciliationPublished = false
        this.publish()
      }
    }
  }

  async dispose() {
    this.stopped = true
    for (const abort of this.acknowledgements.keys()) abort.abort()
    for (const entry of this.entries.values()) {
      this.lifecycleFact({ type: "removed", request: entry.view.request, reason: "disposed" })
      entry.cancelTimer?.(); this.clearProgress(entry); entry.abort.abort()
    }
    this.entries.clear()
    await Promise.allSettled([...this.workers])
    await this.admission.settled()
    await Promise.allSettled([...this.approvalWorkers])
    this.manual.clear()
  }
}

export type Controller<R extends RequestIdentity = PermissionRequest> = ControllerCore<R>
interface LegacyApproval extends LegacyApprovalTransport {
  visibleID(): string | undefined
  presentation?(check?: PresentationCheck): ApprovalPresentation
}
type LegacyControllerOptions = Omit<ControllerOptions, "approval"> & { approval?: LegacyApproval }
type ConstructorOptions<R extends RequestIdentity> = R extends PermissionRequest
  ? PermissionRequest extends R ? LegacyControllerOptions : ControllerOptions<R> : ControllerOptions<R>
/** Keep historical constructor-type extraction V1-shaped as well as ordinary
 * default construction, while explicit native instantiation stays fully typed. */
export const Controller: {
  new <R extends RequestIdentity = PermissionRequest>(evaluate: Evaluate<NoInfer<R>>, changed: (views: View<NoInfer<R>>[]) => void,
    options?: ConstructorOptions<NoInfer<R>>): Controller<R>
  new (evaluate: Evaluate, changed: (views: View[]) => void, options?: LegacyControllerOptions): Controller
} = ControllerCore

/** Select the conversation queue independently of its physical presentation.
 * Host priority can cover the full family; without it, preserve V1's native
 * root/direct-child order on any known descendant route. */
export function visibleReview<R extends RequestIdentity = PermissionRequest>(
  views: readonly View<R>[],
  sessionID: string | undefined,
  getSession: (id: string) => { id: string; parentID?: string } | undefined,
  priority?: NativeFront<R>,
): View<R> | undefined {
  sessionID = conversationRoot(sessionID, getSession)
  if (!sessionID) return
  let first: View<R> | undefined
  let retained: View<R> | undefined
  if (priority) {
    const pending = views.filter(view => !view.resolved)
    const id = priority(sessionID, pending.map(view => view.request))
    retained = views.find(view => view.retained && conversationRoot(view.request.sessionID, getSession) === sessionID)
    first = pending.find(view => view.request.id === id)
    return retained ?? (first && first.status !== "unrelated" && first.status !== "identifying" && first.status !== "unidentified" && first.status !== "suspended" ? first : undefined)
  }
  for (const view of views) {
    const request = view.request
    if (request.sessionID !== sessionID && getSession(request.sessionID)?.parentID !== sessionID) continue
    if (view.retained) { retained ??= view; continue }
    if (view.resolved) continue
    // Match native code-unit ordering; hidden requests still participate in selection.
    if (!first || request.sessionID < first.request.sessionID ||
      (request.sessionID === first.request.sessionID && request.id < first.request.id)) first = view
  }
  return retained ?? (first && first.status !== "unrelated" && first.status !== "identifying" && first.status !== "unidentified" && first.status !== "suspended" ? first : undefined)
}

export function displayText(text: string): string {
  // Escape controls rather than letting source/model text issue terminal commands
  // or reorder the displayed rating through bidi controls.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}
