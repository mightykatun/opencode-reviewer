import type { HostRequest } from "./host-types.js"
import type { ReviewProgress, ReviewResult, ReviewTiming } from "./types.js"
import type { Config, ReviewOptions } from "./config.js"
import { isDeepStrictEqual } from "node:util"
import { randomUUID } from "node:crypto"
import { withDeadline } from "./deadline.js"
import type { SessionModeGate } from "./session-mode.js"
import { SCANNER_INTERVAL_MS } from "./appearance.js"
import { reviewStage } from "./deadline.js"
import { uiText } from "./ui-text.js"
import type { HistoryTarget } from "./history-records.js"
import { conversationRoot } from "./route-approval.js"
import { ReviewAdmission, type ReviewEvaluation } from "./review-admission.js"
import type { NativeApprovalTransport } from "./host-permissions.js"
import { ApprovalTransaction } from "./approval-transaction.js"

export type AutoApproval = { status: "countdown"; seconds: number } | { status: "waiting" | "checking" | "allowing" | "cancelled" | "failed" | "approved" }

export interface RequestIdentity { readonly id: string; readonly sessionID: string }

export interface View<R extends RequestIdentity = HostRequest> {
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

export type Evaluate<R extends RequestIdentity = HostRequest> = (request: R, signal: AbortSignal, onIdentified: () => void, onProgress: (progress: ReviewProgress) => void,
  execution?: { review: string; root?: string }) => ReviewEvaluation<ReviewResult | null>
interface Entry<R extends RequestIdentity = HostRequest> {
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
  eligibilityPending?: boolean
  fastApproval?: "pending" | "confirmed"
  /** Retained UI disappearance is not native resolution authority. Exact native
   * resolution supersedes reconciliation and alone releases manual tombstones. */
  retainedResolution?: "resolved" | "reconciled"
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
/** Host closures own admitted snapshots/location/epoch. The controller sees only
 * reviewer requests, never snapshot envelopes or projected requests. */
export interface NativeApproval<R extends RequestIdentity = HostRequest> extends NativeApprovalTransport<R> {
  list(signal: AbortSignal): Promise<R[]>
}
export interface NativePermissionReply { sessionID: string; requestID: string; decision: string }

export type ApprovalFact<R extends RequestIdentity = HostRequest> = { type: "dispatched" | "confirmed" | "settled"; request: R; automatic: boolean;
  approval?: string; review?: string; result?: "not-sent" | "uncertain" }
export type ApprovalObserver<R extends RequestIdentity = HostRequest> = (fact: ApprovalFact<R>) => unknown
export type ReviewLifecycleFact<R extends RequestIdentity = HostRequest> =
  | { type: "accepted"; request: R; result: ReviewResult; timing: ReviewTiming; root?: string; review: string; completedAt: number }
  | { type: "cancelled"; request: R; reason: "explicit" | "mode" }
  | { type: "removed"; request: R; reason: "resolved" | "reconciled" | "deleted" | "disposed" }
export type ReviewLifecycleObserver<R extends RequestIdentity = HostRequest> = (fact: ReviewLifecycleFact<R>) => unknown

export type NativeFront<R extends RequestIdentity = HostRequest> = (root: string, pending: readonly R[]) => string | undefined

export interface ControllerOptions<R extends RequestIdentity = HostRequest> {
  reviewOptions?: Options
  nativeApproval?: NativeApproval<R>
  clock?: ApprovalClock
  modes?: SessionModeGate
  /** Public host metadata resolves conversation ancestry, never queue order. */
  session?: (id: string) => { id: string; parentID?: string } | undefined
  /** Classification is host-owned. Missing predicates admit no review work. */
  candidate?: (request: R, options: ReviewOptions) => boolean
  /** Actual public native queue ownership, independent of review eligibility.
   * A callback may read an external queue including requests absent from entries.
   * Missing, throwing or unavailable observations never grant approval. */
  nativeFront?: NativeFront<R>
  /** V2 automation policy, separate from physical panel presentation. False is a
   * recoverable wait, never cancellation. Rechecked at the native write boundary. */
  approvalReady?: (request: R, root: string | undefined) => boolean
  onApproval?: ApprovalObserver<R>
  onRating?: (safe: boolean, timing: ReviewTiming) => unknown
  onLifecycle?: ReviewLifecycleObserver<R>
}

/** Reviews remain advisory unless explicitly configured with a once-only writer. */
export class Controller<R extends RequestIdentity = HostRequest> {
  private entries = new Map<string, Entry<R>>()
  private stopped = false
  private version = 0
  private modeChanges = new Map<string, number>()
  private manual = new Map<string, "cancelled" | "failed">()
  private workers = new Set<Promise<unknown>>()
  private admission = new ReviewAdmission(root => this.nativeFront(root))
  private approvalTransactions = new Set<ApprovalTransaction<R>>()
  private approvalWorkers = new Set<Promise<unknown>>()
  private approvalRead?: Promise<R[]>
  private reconciliation = 0
  private reconciliationPublished = false
  private options: Options
  private nativeApproval?: NativeApproval<R>
  private time: ApprovalClock
  private modes?: SessionModeGate
  private session?: ControllerOptions<R>["session"]
  private candidate: NonNullable<ControllerOptions<R>["candidate"]>
  private priority?: NativeFront<R>
  private approvalReady?: ControllerOptions<R>["approvalReady"]
  private approvalObserver?: ApprovalObserver<R>
  private ratingObserver?: ControllerOptions<R>["onRating"]
  private lifecycleObserver?: ReviewLifecycleObserver<R>
  constructor(private evaluate: Evaluate<R>, private changed: (views: View<R>[]) => void,
    { reviewOptions = { reviewBash: true, reviewEdits: true }, nativeApproval, clock: time = clock, modes,
      onApproval, onRating, onLifecycle, session, candidate = () => false, nativeFront, approvalReady }: ControllerOptions<R> = {}) {
    this.options = reviewOptions
    this.nativeApproval = nativeApproval
    this.time = time
    this.modes = modes
    this.session = session
    this.candidate = candidate
    this.priority = nativeFront
    this.approvalReady = approvalReady
    this.approvalObserver = onApproval
    this.ratingObserver = onRating
    this.lifecycleObserver = onLifecycle
  }
  get revision() { return this.version }
  /** Notifications consume only the final pending snapshot. Controller facts
   * continue publishing synchronously during reconciliation. */
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
    try { return this.priority?.(root, this.pendingViews.map(view => view.request)) }
    catch { return undefined }
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

  /** Public UI/cache observations wake waiting V2 automation without granting or
   * remembering paint. The policy getter still runs synchronously before writes. */
  refreshApprovalEligibility() {
    if (this.stopped || !this.approvalReady) return
    // One queue snapshot per root is only a wake-up filter. Final eligibility
    // still rechecks actual priority, so publication/reentrancy cannot admit a
    // stale owner. Avoid rebuilding the full pending family for every Safe row.
    const pending = this.pendingViews.map(view => view.request), fronts = new Map<string, string | undefined>()
    for (const entry of this.entries.values()) {
      if (!this.safe(entry) || this.manual.has(entry.view.request.id)) continue
      if (this.priority) {
        const root = entry.root ?? (this.session ? conversationRoot(entry.view.request.sessionID, this.session) : entry.view.request.sessionID)
        if (!root) continue
        if (!fronts.has(root)) {
          try { fronts.set(root, this.priority(root, pending)) } catch { fronts.set(root, undefined) }
        }
        if (fronts.get(root) !== entry.view.request.id) continue
      }
      this.startApproval(entry)
      if (entry.view.autoApproval?.status === "waiting" && !entry.approvalAbort && !entry.approvalRefresh && this.eligible(entry)) {
        entry.view = { ...entry.view, autoApproval: { status: "countdown", seconds: Math.min(this.options.autoApproveDelaySeconds ?? 15,
          Math.max(0, Math.ceil((entry.deadline! - this.time.now()) / 1000))) } }
        this.publish()
      }
      if (entry.view.autoApproval?.status === "countdown" && !entry.cancelTimer && !entry.approvalAbort
        && !entry.approvalRefresh && this.eligible(entry)) this.schedule(entry)
    }
  }

  /** Rating and settlement may start work only under fresh native policy. */
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
    if (entry.deadline === undefined)
      entry.deadline = this.time.now() + seconds * 1000 + (seconds > 0 ? 200 : 0)
    entry.view = { ...entry.view, autoApproval: { status: "countdown",
      seconds: Math.min(seconds, Math.max(0, Math.ceil((entry.deadline - this.time.now()) / 1000))) } }
    this.publish()
    // Even zero delay goes through the same cancellable single-flight path.
    this.schedule(entry)
  }

  cancelAutoApproval(id: string) {
    const entry = this.entries.get(id)
    if (!entry || !entry.approvalArmed || entry.approvalDispatched || this.manual.has(id)) return
    this.lifecycleFact({ type: "cancelled", request: entry.view.request, reason: "explicit" })
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

  private approvalState(entry: Entry<R>): "pending" | "ready" {
    if (!this.nativeApproval || !this.priority || !this.approvalReady || !this.active(entry) || entry.view.resolved
      || entry.fastApproval || this.options.autoApprove !== true
      || (this.modes && (entry.root === undefined || !this.modes.enabled(entry.root)))) return "pending"
    try {
      const root = entry.root ?? (this.session ? conversationRoot(entry.view.request.sessionID, this.session) : entry.view.request.sessionID)
      if (!root || this.nativeFront(root) !== entry.view.request.id) return "pending"
      return this.approvalReady(entry.view.request, root) ? "ready" : "pending"
    } catch { return "pending" }
  }

  private eligible(entry: Entry<R>) {
    if (this.manual.has(entry.view.request.id) || entry.approvalPaused || !this.safe(entry)) return false
    const state = this.approvalState(entry)
    return state === "ready"
  }

  /** Rating rejection revokes the reservation, even if Safe returns before its GET.
   * Keep the armed lifetime so explicit Cancel remains durable. */
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
    // Repeated parser clears and retry starts revoke only the current rating.
    if (entry.approvalPaused || !entry.view.autoApproval) return
    entry.approvalPaused = !!entry.approvalAbort
    entry.approvalAbort?.abort()
    entry.view = { ...entry.view, autoApproval: entry.approvalRefresh ? { status: "checking" } : undefined }
  }

  private approvalEligible(entry: Entry<R>) {
    const state = this.approvalState(entry)
    if (state === "pending") entry.eligibilityPending = true
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
      const eligible = this.approvalEligible(entry)
      if (this.manual.has(entry.view.request.id)) return
      const seconds = Math.min(this.options.autoApproveDelaySeconds ?? 15,
        Math.max(0, Math.ceil((entry.deadline! - this.time.now()) / 1000)))
      if (entry.view.autoApproval.seconds !== seconds) {
        entry.view = { ...entry.view, autoApproval: { status: "countdown", seconds } }
        this.publish()
      }
      if (seconds === 0) {
        // No polling loop or grace restart while waiting for native eligibility.
        if (eligible) void this.approveNow(entry.view.request.id, true)
        else {
          entry.view = { ...entry.view, autoApproval: { status: "waiting" } }
          this.publish()
        }
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
    const read = this.nativeApproval!.list(signal)
    this.approvalRead = read
    try { return await read }
    finally { if (this.approvalRead === read) this.approvalRead = undefined }
  }

  async approveNow(id: string, automatic = false) {
    const entry = this.entries.get(id)
    if (!entry || !this.nativeApproval || entry.approvalRefresh || !(entry.view.autoApproval?.status === "countdown"
      || (this.options.fastMode && automatic && entry.view.autoApproval?.status === "checking" && !entry.approvalAbort))) return
    if (!this.approvalEligible(entry)) return
    entry.cancelTimer?.()
    entry.cancelTimer = undefined
    const abort = entry.approvalAbort = new AbortController()
    entry.eligibilityPending = false
    entry.view = { ...entry.view, autoApproval: { status: "checking" } }
    this.publish()
    const transaction = new ApprovalTransaction(entry.view.request, entry.root, entry.review, automatic, permissionResolved,
      fact => this.approvalFact(fact))
    this.approvalTransactions.add(transaction)
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
          const write = transaction.submit(signal, this.nativeApproval!, {
            guard: () => {
              if (!this.approvalEligible(entry) || verifiedRevision !== this.version) return false
              if (!isDeepStrictEqual(verified, entry.view.request)) throw requestChanged
              return true
            },
            dispatch: () => {
              this.manual.set(id, "failed")
              entry.approvalDispatched = true
              if (this.options.fastMode && automatic) {
                entry.fastApproval = "pending"
                entry.view = { ...entry.view, retained: true }
              }
            },
            dispatched: () => {
              if (this.active(entry) && entry.view.autoApproval?.status === "checking") {
                entry.view = { ...entry.view, autoApproval: { status: "allowing" } }
                this.publish()
              }
            },
            confirming: () => {
              if (entry.fastApproval && this.active(entry)) {
                entry.fastApproval = "confirmed"
                entry.retainedResolution = "resolved"
                entry.view = { ...entry.view, resolved: true, autoApproval: { status: "approved" } }
              }
            },
            confirmed: () => {
              if (entry.fastApproval && this.active(entry)) { this.publish(); this.finishFast(entry) }
            },
          }).finally(() => { if (transaction.dispatched) this.approvalTransactions.delete(transaction) })
          this.approvalWorkers.add(write)
          void write.then(() => this.approvalWorkers.delete(write), () => this.approvalWorkers.delete(write))
          await write
          signal.throwIfAborted()
          if (transaction.dispatched) return
          if (transaction.state === "not-sent" && this.active(entry) && !this.manual.has(id)) {
            entry.approvalRefresh = true
            entry.view = { ...entry.view, autoApproval: { status: "checking" } }
            this.publish()
          }
          if (entry.approvalRefresh) return
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
      if (!transaction.dispatched && error !== requestChanged && !this.manual.has(id)) {
        if (entry.approvalPaused) return
        entry.approvalRefresh = true
        entry.view = { ...entry.view, autoApproval: { status: "checking" } }
        this.publish()
        await this.recoverApproval(entry, abort)
        return
      }
      if (entry.fastApproval) {
        entry.fastApproval = undefined
        if (entry.retainedResolution) { this.replied(id, true, entry.retainedResolution); return }
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
      if (!transaction.dispatched) {
        transaction.finish()
        this.approvalTransactions.delete(transaction)
        if (entry.approvalPaused) await this.afterApprovalRead(entry, abort, () => {
          entry.approvalAbort = undefined
          entry.approvalPaused = false
          if (this.options.fastMode && !entry.approvalRefresh) this.startApproval(entry)
        })
        else if (!entry.approvalRefresh && entry.approvalAbort === abort) entry.approvalAbort = undefined
        // Exhausted churn has already settled its reads, but still needs a poll.
        else if (entry.approvalRefresh && entry.approvalAbort === abort && !this.approvalRead) entry.approvalAbort = undefined
        if (entry.eligibilityPending && !entry.approvalAbort && !entry.approvalRefresh && this.active(entry)
          && !this.manual.has(id) && this.safe(entry)) {
          entry.eligibilityPending = false
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
        this.startApproval(entry)
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
      if (entry.retainedResolution !== "resolved") entry.retainedResolution = reason
      entry.view = { ...entry.view, resolved: true }
      this.publish()
      this.finishFast(entry)
      return
    }
    if (entry) this.lifecycleFact({ type: "removed", request: entry.view.request, reason: resolved ? reason : "deleted" })
    if (entry) this.clearProgress(entry)
    this.entries.get(id)?.abort.abort(resolved ? permissionResolved : undefined)
    if (!resolved || reason !== "reconciled") this.manual.delete(id)
    if (this.entries.delete(id)) this.publish()
  }

  /** Feed only events admitted by the connected host's location/epoch boundary.
   * Session and request ownership must both match; events carry no client ID. */
  permissionReplied(event: NativePermissionReply) {
    if (this.stopped || !this.nativeApproval) return
    const confirmation = [...this.approvalTransactions].find(transaction => transaction.dispatched && transaction.request.id === event.requestID)
    const entry = this.entries.get(event.requestID)
    if ((confirmation && confirmation.request.sessionID !== event.sessionID)
      || (entry && entry.view.request.sessionID !== event.sessionID)) return
    if (!entry && !confirmation) {
      // Unknown events still invalidate pending reads, but cannot clear a
      // tombstone whose exact session ownership is no longer available here.
      this.version++
      return
    }
    confirmation?.resolved(event)
    this.replied(event.requestID)
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
    for (const transaction of this.approvalTransactions)
      if (transaction.request.sessionID === sessionID || transaction.root === sessionID) transaction.abort()
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
    for (const transaction of this.approvalTransactions) transaction.abort()
    for (const entry of this.entries.values()) {
      this.lifecycleFact({ type: "removed", request: entry.view.request, reason: "disposed" })
      entry.cancelTimer?.(); this.clearProgress(entry); entry.abort.abort()
    }
    this.entries.clear()
    await Promise.allSettled([...this.workers])
    await this.admission.settled()
    await Promise.allSettled([...this.approvalWorkers])
    this.approvalTransactions.clear()
    this.manual.clear()
  }
}

/** Select the conversation queue using actual native family ownership. */
export function visibleReview<R extends RequestIdentity = HostRequest>(
  views: readonly View<R>[],
  sessionID: string | undefined,
  getSession: (id: string) => { id: string; parentID?: string } | undefined,
  priority?: NativeFront<R>,
): View<R> | undefined {
  sessionID = conversationRoot(sessionID, getSession)
  if (!sessionID) return
  if (priority) {
    const pending = views.filter(view => !view.resolved)
    let id: string | undefined
    try { id = priority(sessionID, pending.map(view => view.request)) } catch { return }
    const retained = views.find(view => view.retained && conversationRoot(view.request.sessionID, getSession) === sessionID)
    const first = pending.find(view => view.request.id === id)
    return retained ?? (first && first.status !== "unrelated" && first.status !== "identifying" && first.status !== "unidentified" && first.status !== "suspended" ? first : undefined)
  }
}

export function displayText(text: string): string {
  // Escape controls rather than letting source/model text issue terminal commands
  // or reorder the displayed rating through bidi controls.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}
