import type { HostRequest } from "./host-types.js"
import type { ApprovalFact, RequestIdentity, ReviewLifecycleFact } from "./controller.js"
import type { Config } from "./config.js"
import type { ReviewKind, ReviewObservation } from "./types.js"
import type { HistoryEvent, HistoryOutcome, HistoryPayload, HistoryReview, HistoryScope } from "./history-records.js"
import type { HistoryStore } from "./history-store.js"
import type { HistoryResolution, HistorySession } from "./history-schema.js"
import type { AncestryReader } from "./session-ancestry.js"

type Store = Pick<HistoryStore, "admit" | "query" | "onCommit"> & Partial<Pick<HistoryStore, "markMaintenanceDirty">>
interface Candidate {
  context: HistoryReview
  payload: HistoryPayload
  message?: string
  cancelled: boolean
  interrupted: boolean
  removed: boolean
  reply?: "once" | "always" | "reject"
  dispatched: boolean
  confirmed?: "auto" | "manual"
  expires?: number
}
interface Dispatch { context: HistoryReview; approval: string; automatic: boolean }
interface EarlyReview { context: HistoryReview; confirmed?: "auto" | "manual"; reply?: Candidate["reply"] }
const category = (kind: ReviewKind): HistoryReview["category"] => kind === "shell" ? "bash"
  : kind === "external-directory" ? "external_directory" : kind
type AssistantSource<R extends RequestIdentity> = (request: R) => string | undefined

/** Data-only observers. Report bodies live here until a qualifying resolution.
 * A bounded resolution window can observe a remote acknowledgement. Its expiry is
 * omission, never evidence that no other client submitted an automatic write.
 */
export class HistoryCoordinator<R extends HostRequest = HostRequest> {
  private candidates = new Map<string, Candidate>()
  private dispatches = new Map<string, Dispatch>()
  private early = new Map<string, EarlyReview>()
  private resolved = new Map<string, HistoryReview>()
  private stopped = false
  private polling = false
  private timer?: ReturnType<typeof setTimeout>
  private abort = new AbortController()
  private unsubscribe: () => void
  private assistant: AssistantSource<R>
  constructor(readonly scope: string, private store: Store,
    private ancestry: AncestryReader,
    private now: () => number = Date.now,
    assistant: AssistantSource<R> = request => request.source?.assistantID) {
    this.assistant = assistant
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
      const early = this.early.get(id)
      const confirmed = early?.context.review === fact.review ? early.confirmed : undefined
      const candidate: Candidate = { context, payload: { ...accepted, desc: fact.result.desc,
        ...(fact.result.usage ? { usage: { ...fact.result.usage } } : {}) }, message: this.assistant(fact.request),
        cancelled: old?.cancelled ?? false, interrupted: old?.interrupted ?? false, removed: !!confirmed,
        dispatched: old?.dispatched ?? false, confirmed: confirmed ?? old?.confirmed,
        ...(early?.context.review === fact.review && early.reply ? { reply: early.reply } : {}) }
      this.candidates.set(id, candidate)
      if (confirmed) this.finishKnown(candidate)
      return
    }
    if (fact.type === "removed") this.early.delete(id)
    const c = this.candidates.get(id)
    if (!c || c.context.session !== fact.request.sessionID) return
    if (fact.type === "cancelled") { c.cancelled = true; return }
    if (fact.reason === "deleted" || fact.reason === "disposed") { this.candidates.delete(id); return }
    if (c.removed && c.expires !== undefined) return
    c.removed = true
    if (this.finishKnown(c)) return
    // At most 128 removed reports await attribution, for at most 6.5 seconds.
    if ([...this.candidates.values()].filter(value => value.expires !== undefined).length >= 128) {
      this.candidates.delete(id); return
    }
    c.expires = this.now() + 6500
    this.schedule()
    void this.poll()
  }
  reply(properties: { requestID: string; sessionID: string; reply: "once" | "always" | "reject" }) {
    if (this.stopped) return
    const early = this.early.get(properties.requestID)
    if (early?.context.session === properties.sessionID) early.reply = properties.reply
    const c = this.candidates.get(properties.requestID)
    if (!c) {
      const context = this.resolved.get(properties.requestID)
      if (context?.session === properties.sessionID && properties.reply !== "once")
        this.admit({ type: "permissionOutcome", context, at: this.now(), outcome: properties.reply === "always" ? "manual" : "rejected" })
      return
    }
    if (c.context.session !== properties.sessionID) return
    c.reply = properties.reply
    if (c.removed) this.finishKnown(c)
  }
  /** Exact native assistant-message link plus later permission removal, never root idle. */
  interrupted(identity: { sessionID: string; assistantID: string }) {
    if (this.stopped) return
    for (const c of this.candidates.values()) if (c.context.session === identity.sessionID && c.message === identity.assistantID) {
      c.interrupted = true
      if (c.removed) this.finishKnown(c)
    }
  }
  approval = (fact: ApprovalFact<R>) => {
    if (this.stopped || !fact.approval || !fact.review) return
    const c = this.candidates.get(fact.request.id)
    const early = this.early.get(fact.request.id)
    if (fact.type === "dispatched") {
      const context = early?.context.review === fact.review ? early.context : c?.context
      if (!context || context.review !== fact.review || context.session !== fact.request.sessionID) return
      if (c) c.dispatched = true
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
      if (c) {
        c.confirmed = d.automatic ? "auto" : "manual"
        // Confirmation itself proves resolution, even before the native event.
        c.removed = true
        this.finishKnown(c)
      }
    } else {
      this.dispatches.delete(fact.approval)
      if (fact.result) this.admit({ type: "approvalSettled", context: d.context, approval: d.approval, result: fact.result, at: this.now() })
      if (c && fact.result === "not-sent") { c.dispatched = false; this.finishKnown(c) }
    }
  }
  private finishKnown(c: Candidate): boolean {
    if (!c.removed) return false
    if (c.reply === "reject") return this.finish(c, "rejected")
    if (c.confirmed) return this.finish(c, c.confirmed)
    if (c.reply === "always") return this.finish(c, "manual")
    // Cancellation also checks shared observed dispatches in poll(). This is not
    // proof of absence of a remote write and can never attribute a once reply.
    return false
  }
  private finish(c: Candidate, outcome: HistoryOutcome): true {
    this.admit({ type: "permissionResolved", context: c.context, payload: c.payload, outcome, at: this.now() })
    this.candidates.delete(c.context.permission) // Admission failure cannot create a second outage queue.
    if (this.resolved.size >= 4096) this.resolved.delete(this.resolved.keys().next().value!)
    this.resolved.set(c.context.permission, c.context)
    return true
  }
  private schedule() {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const [id, c] of this.candidates) if (c.expires !== undefined && c.expires <= this.now()) this.candidates.delete(id)
      void this.poll()
      if ([...this.candidates.values()].some(c => c.expires !== undefined)) this.schedule()
    }, 500)
  }
  private nextPoll = 0
  private async poll() {
    if (this.stopped || this.polling || this.now() < this.nextPoll || ![...this.candidates.values()].some(c => c.expires !== undefined)) return
    this.polling = true
    this.nextPoll = this.now() + 2000
    try {
      for (const c of this.candidates.values()) {
        if (this.stopped || c.expires === undefined) continue
        const { scope, root, session, permission } = c.context
        const read = this.store.query({ type: "resolution", scope, root, session, permission }, this.abort.signal)
        try {
          const result = await read as HistoryResolution
          if (this.stopped || this.candidates.get(permission) !== c || c.expires <= this.now()) continue
          if (result.deleted || result.conflict) this.candidates.delete(permission)
          else if (result.outcome) this.finish(c, result.outcome)
          else if (!result.uncertain && !c.dispatched && !c.reply && (c.cancelled || c.interrupted)) this.finish(c, "cancelled")
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
    for (const [id, c] of this.resolved) if (c.session === session || c.root === session) this.resolved.delete(id)
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
      ?? [...this.resolved.values()].find(c => c.session === info.id)
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
    for (const [id, c] of this.resolved) if (matches(c)) this.resolved.delete(id)
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
