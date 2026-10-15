import type { HostRequest } from "./host-types.js"
import type { ApprovalFact, ReviewLifecycleFact } from "./controller.js"
import type { Config } from "./config.js"
import type { ReviewKind, ReviewObservation } from "./types.js"
import type { HistoryEvent, HistoryOutcome, HistoryPayload, HistoryReview, HistoryScope } from "./history-records.js"
import type { HistoryStore } from "./history-store.js"
import type { HistoryResolution, HistorySession } from "./history-schema.js"
import type { AncestryReader } from "./session-ancestry.js"

type Store = Pick<HistoryStore, "admit" | "query" | "onCommit"> & Partial<Pick<HistoryStore, "markMaintenanceDirty">>
interface Candidate {
  context: HistoryReview
  reports: Map<string, { context: HistoryReview; payload: HistoryPayload }>
  removed: boolean
  reply?: "once" | "always" | "reject"
  confirmed?: "auto" | "manual"
  expires?: number
}
interface Dispatch { context: HistoryReview; approval: string; automatic: boolean }
interface EarlyReview { context: HistoryReview; confirmed?: "auto" | "manual"; reply?: Candidate["reply"] }
const category = (kind: ReviewKind): HistoryReview["category"] => kind === "shell" ? "bash"
  : kind === "external-directory" ? "external_directory" : kind
interface Resolved { context: HistoryReview; outcome: HistoryOutcome }

/** Completed reports remain memory-only until an exact permission resolution.
 * Native once proves approval, not the submitting client's identity. Attribution
 * may improve later without gating storage or inventing automatic success.
 */
export class HistoryCoordinator<R extends HostRequest = HostRequest> {
  private candidates = new Map<string, Candidate>()
  private dispatches = new Map<string, Dispatch>()
  private early = new Map<string, EarlyReview>()
  private resolved = new Map<string, Resolved>()
  private stopped = false
  private polling = false
  private timer?: ReturnType<typeof setTimeout>
  private abort = new AbortController()
  private unsubscribe: () => void
  constructor(readonly scope: string, private store: Store,
    private ancestry: AncestryReader,
    private now: () => number = Date.now,
    private monotonicNow: () => number = () => performance.now()) {
    this.unsubscribe = store.onCommit(() => this.poll())
  }
  /** History browsing uses ancestry only, even with invalid/disabled review mode. */
  root(session: string, signal: AbortSignal) { return this.ancestry(session, signal) }
  private admit(event: HistoryEvent) {
    try { return this.store.admit(event) } catch { return false }
  }
  observation(request: R, kind: ReviewKind, config: Config, execution: { review: string; root?: string }): ReviewObservation {
    const context: HistoryReview | undefined = execution.root ? { scope: this.scope, root: execution.root,
      session: request.sessionID, permission: request.id, review: execution.review, category: category(kind),
      configuredModel: config.model, provider: config.baseURL } : undefined
    // Early approval needs identity/accounting before an accepted report exists.
    // No provisional rating or explanation enters persistent history.
    if (!this.stopped && context && config.autoApprove && config.fastMode) this.early.set(request.id, { context })
    return { review: execution.review, observe: event => {
      // Real transport finalizers may still enqueue received usage during shutdown.
      if (!context || event.review !== context.review) return
      if (event.type === "dispatched") {
        if (!this.stopped) this.admit({ type: "attemptDispatched", context, at: this.now(), attempt: event.attempt, retry: event.retry })
      } else this.admit({ type: "attemptFinalized", context, at: this.now(), attempt: event.attempt,
        ...(event.usage ? { usage: event.usage } : {}), ...(event.reportedModel ? { reportedModel: event.reportedModel } : {}) })
    } }
  }
  lifecycle = (fact: ReviewLifecycleFact<R>) => {
    if (this.stopped) return
    const id = fact.request.id
    if (fact.type === "accepted") {
      const m = fact.result.metadata
      if (!m || !fact.root || m.review !== fact.review) return
      const context: HistoryReview = { scope: this.scope, root: fact.root, session: fact.request.sessionID,
        permission: id, review: m.review, category: category(m.kind), configuredModel: m.configuredModel, provider: m.provider }
      const accepted = { safe: fact.result.safe, completedAt: fact.completedAt, timing: { ...fact.timing },
        ...(m.reportedModel ? { reportedModel: m.reportedModel } : {}) }
      this.admit({ type: "reviewAccepted", context, at: fact.completedAt, accepted })
      const old = this.candidates.get(id)
      if (old && (old.context.session !== context.session || old.context.root !== context.root)) return
      const early = this.early.get(id)
      const confirmed = early?.context.review === fact.review ? early.confirmed : undefined
      const candidate: Candidate = old ?? { context, reports: new Map(), removed: false,
        confirmed,
        ...(early?.context.review === fact.review && early.reply ? { reply: early.reply } : {}) }
      candidate.reports.set(fact.review, { context, payload: { ...accepted, desc: fact.result.desc,
        ...(fact.result.usage ? { usage: { ...fact.result.usage } } : {}) } })
      this.candidates.set(id, candidate)
      const resolved = this.resolved.get(id)
      if (resolved?.context.session === context.session && resolved.context.root === context.root) this.finish(candidate, resolved.outcome)
      else this.finishKnown(candidate)
      return
    }
    if (fact.type === "removed") this.early.delete(id)
    const c = this.candidates.get(id)
    if (!c || c.context.session !== fact.request.sessionID) return
    if (this.expired(c)) return
    if (fact.type === "cancelled") return
    if (fact.reason === "deleted" || fact.reason === "disposed") { this.candidates.delete(id); return }
    if (c.removed && c.expires !== undefined) return
    c.removed = true
    if (this.finishKnown(c)) return
    // At most 128 removed permissions await shared resolution, for at most 6.5 seconds.
    if ([...this.candidates.values()].filter(value => value.expires !== undefined).length >= 128) {
      this.candidates.delete(id); return
    }
    c.expires = this.monotonicNow() + 6500
    this.schedule()
    void this.poll()
  }
  reply(properties: { requestID: string; sessionID: string; reply: "once" | "always" | "reject" }) {
    if (this.stopped) return
    const early = this.early.get(properties.requestID)
    if (early?.context.session === properties.sessionID) early.reply = properties.reply
    const c = this.candidates.get(properties.requestID)
    if (!c) {
      const resolved = this.resolved.get(properties.requestID)
      if (resolved?.context.session === properties.sessionID) {
        const outcome = properties.reply === "always" ? "manual" : properties.reply === "reject" ? "rejected" : "approved"
        this.admit({ type: "permissionOutcome", context: resolved.context, at: this.now(), outcome })
        if (resolved.outcome === "approved") resolved.outcome = outcome
      }
      return
    }
    if (c.context.session !== properties.sessionID) return
    c.reply = properties.reply
    this.finishKnown(c)
  }
  approval = (fact: ApprovalFact<R>) => {
    if (this.stopped || !fact.approval || !fact.review) return
    const c = this.candidates.get(fact.request.id)
    const early = this.early.get(fact.request.id)
    if (fact.type === "dispatched") {
      const context = early?.context.review === fact.review ? early.context : c?.reports.get(fact.review)?.context
      if (!context || context.review !== fact.review || context.session !== fact.request.sessionID) return
      const d = { context, approval: fact.approval, automatic: fact.automatic }
      this.dispatches.set(fact.approval, d)
      this.admit({ type: "approvalDispatched", ...d, at: this.now() })
      return
    }
    const d = this.dispatches.get(fact.approval)
    if (!d || d.context.review !== fact.review || d.context.permission !== fact.request.id || d.context.session !== fact.request.sessionID) return
    if (fact.type === "confirmed") {
      this.admit({ type: "approvalConfirmed", ...d, at: this.now() })
      if (early?.context.review === fact.review) early.confirmed = d.automatic ? "auto" : "manual"
      const resolved = this.resolved.get(fact.request.id)
      if (resolved?.context.session === fact.request.sessionID) resolved.outcome = d.automatic ? "auto" : "manual"
      if (c) {
        c.confirmed = d.automatic ? "auto" : "manual"
        // Confirmation itself proves resolution, even before the native event.
        c.removed = true
        this.finishKnown(c)
      }
    } else {
      this.dispatches.delete(fact.approval)
      if (fact.result) this.admit({ type: "approvalSettled", context: d.context, approval: d.approval, result: fact.result, at: this.now() })
      if (c && fact.result === "not-sent") this.finishKnown(c)
    }
  }
  private finishKnown(c: Candidate): boolean {
    if (this.expired(c)) return true
    if (c.reply === "reject") return this.finish(c, "rejected")
    if (c.confirmed) return this.finish(c, c.confirmed)
    if (c.reply === "always") return this.finish(c, "manual")
    if (c.reply === "once") return this.finish(c, "approved")
    return false
  }
  private finish(c: Candidate, outcome: HistoryOutcome): true {
    if (this.expired(c)) return true
    for (const report of c.reports.values())
      this.admit({ type: "permissionResolved", ...report, outcome, at: this.now() })
    this.candidates.delete(c.context.permission) // Admission failure cannot create a second outage queue.
    if (this.resolved.size >= 4096) this.resolved.delete(this.resolved.keys().next().value!)
    this.resolved.set(c.context.permission, { context: c.context, outcome })
    return true
  }
  /** Timer delivery is not expiry authority: late events and reads must omit the
   * body too. Wall-clock event timestamps never change this reconciliation window. */
  private expired(c: Candidate): boolean {
    if (c.expires === undefined || c.expires > this.monotonicNow()) return false
    if (this.candidates.get(c.context.permission) === c) this.candidates.delete(c.context.permission)
    return true
  }
  private schedule() {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const c of this.candidates.values()) this.expired(c)
      void this.poll()
      if ([...this.candidates.values()].some(c => c.expires !== undefined)) this.schedule()
    }, 500)
  }
  private nextPoll = 0
  private async poll() {
    if (this.stopped || this.polling || this.monotonicNow() < this.nextPoll || ![...this.candidates.values()].some(c => c.expires !== undefined)) return
    this.polling = true
    this.nextPoll = this.monotonicNow() + 2000
    try {
      for (const c of this.candidates.values()) {
        if (this.stopped || c.expires === undefined || this.expired(c)) continue
        const { scope, root, session, permission } = c.context
        const read = this.store.query({ type: "resolution", scope, root, session, permission }, this.abort.signal)
        try {
          const result = await read as HistoryResolution
          if (this.stopped || this.candidates.get(permission) !== c || this.expired(c)) continue
          if (result.deleted || result.conflict) this.candidates.delete(permission)
          else if (result.outcome) this.finish(c, result.outcome)
        } catch { /* Bounded conservative omission on unavailable shared facts. */ }
        finally { await read.settled?.catch(() => {}) }
      }
    } catch { /* Query construction and injected transports are observational too. */ }
    finally { this.polling = false }
  }
  invalidateSession(session: string) {
    for (const [id, e] of this.early) if (e.context.session === session || e.context.root === session) this.early.delete(id)
    for (const [id, c] of this.candidates) if (c.context.session === session || c.context.root === session) this.candidates.delete(id)
    for (const [id, d] of this.dispatches) if (d.context.session === session || d.context.root === session) this.dispatches.delete(id)
    for (const [id, c] of this.resolved) if (c.context.session === session || c.context.root === session) this.resolved.delete(id)
  }
  private deletionReads = 0
  /** Only a definitive public deletion event calls this. Stored ownership is a
   * fallback when the now-deleted child's metadata is no longer readable.
   */
  async sessionDeleted(info: { id: string; parentID?: string }) {
    if (this.stopped) return
    // Invalidate before any bounded ownership lookup. A scope-wide bit also
    // covers unknown child ownership and saturated admissions without an ID queue.
    this.store.markMaintenanceDirty?.()
    const known = [...this.candidates.values()].find(c => c.context.session === info.id)?.context
      ?? [...this.resolved.values()].find(c => c.context.session === info.id)?.context
      ?? [...this.early.values()].find(e => e.context.session === info.id)?.context
    this.invalidateSession(info.id)
    if (!info.parentID || known) {
      this.deleted({ scope: this.scope, root: known?.root ?? info.id, session: info.id }); return
    }
    if (this.deletionReads >= 2) { this.store.markMaintenanceDirty?.(); return }
    this.deletionReads++
    try {
      const read = this.store.query({ type: "session", scope: this.scope, session: info.id }, this.abort.signal)
      try {
        const result = await read as HistorySession
        if (!this.stopped && result.context) this.deleted(result.context)
      } finally { await read.settled?.catch(() => {}) }
    } catch { this.store.markMaintenanceDirty?.() }
    finally { this.deletionReads-- }
  }
  deleted(context: HistoryScope) {
    if (this.stopped || context.scope !== this.scope) return
    const matches = (c: HistoryScope) => c.session === context.session || (context.session === context.root && c.root === context.root)
    for (const [id, e] of this.early) if (matches(e.context)) this.early.delete(id)
    for (const [id, c] of this.candidates) if (matches(c.context)) this.candidates.delete(id)
    for (const [id, d] of this.dispatches) if (matches(d.context)) this.dispatches.delete(id)
    for (const [id, c] of this.resolved) if (matches(c.context)) this.resolved.delete(id)
    this.admit({ type: "sessionDeleted", context, at: this.now() })
  }
  dispose() {
    if (this.stopped) return
    this.stopped = true; this.unsubscribe(); clearTimeout(this.timer); this.abort.abort()
    this.candidates.clear(); this.dispatches.clear(); this.resolved.clear(); this.early.clear()
  }
}

/** Finalizers have first use of the shared budget; worker cleanup still reserves
 * 350 ms. A hung writer/notification cannot delay storage termination.
 */
export async function drainHistory(store: Pick<HistoryStore, "dispose">, finalizers: Promise<unknown>, abortAt: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([finalizers.catch(() => {}), new Promise<void>(resolve => {
    timer = setTimeout(resolve, Math.max(0, abortAt + 3150 - performance.now()))
  })])
  clearTimeout(timer)
  await store.dispose(abortAt)
}
