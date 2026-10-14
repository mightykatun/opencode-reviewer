import { randomUUID } from "node:crypto"
import { remainingTime, reviewStage, withDeadline } from "./deadline.js"
import type { NativeApprovalTransport } from "./host-permissions.js"
import type { ApprovalFact, NativePermissionReply, RequestIdentity } from "./controller.js"

export type ApprovalTransactionState = "preparing" | "dispatched" | "acknowledged" | "confirmed" | "uncertain" | "not-sent"
interface SubmissionPolicy {
  /** Final synchronous policy check. No observers or publications here. */
  guard(): boolean
  /** Controller-only bookkeeping, immediately before the native invocation. */
  dispatch(): void
  /** Native UI publication is deferred until after the invocation. */
  dispatched?(): void
  confirming(): void
  confirmed(): void
}

/** Owns one approval's transport facts, independently of review/view lifetime.
 * The controller owns policy and physical verification reads. Native attribution
 * requires both our local acknowledgement and the first exact native once event. */
export class ApprovalTransaction<R extends RequestIdentity> {
  readonly approval = randomUUID()
  private current: ApprovalTransactionState = "preparing"
  private sent = false
  private writing = false
  private settled = false
  private acknowledgement = new AbortController()
  private reply?: string
  private resolveEvent!: (decision: string) => void
  private event = new Promise<string>(resolve => { this.resolveEvent = resolve })

  constructor(readonly request: R, readonly root: string | undefined, private review: string, private automatic: boolean,
    private permissionResolved: unknown, private observe: (fact: ApprovalFact<R>) => unknown) {}

  get state() { return this.current }
  get dispatched() { return this.sent }
  matches(event: NativePermissionReply) { return event.requestID === this.request.id && event.sessionID === this.request.sessionID }

  /** Events before dispatch and late events after uncertainty cannot attribute us. */
  resolved(event: NativePermissionReply): boolean {
    if (!this.matches(event) || !this.sent || this.reply !== undefined || this.terminal()) return false
    this.reply = event.decision
    this.resolveEvent(event.decision)
    return true
  }

  abort(reason?: unknown) { this.acknowledgement.abort(reason) }

  private terminal() { return this.current === "confirmed" || this.current === "uncertain" || this.current === "not-sent" }
  private fact(type: ApprovalFact<R>["type"]) {
    const fact: ApprovalFact<R> = { type, request: this.request, automatic: this.automatic, approval: this.approval, review: this.review,
      ...(type === "settled" && this.current !== "confirmed" ? { result: this.sent ? "uncertain" : "not-sent" } : {}) }
    try { void Promise.resolve(this.observe(fact)).catch(() => {}) } catch {}
  }

  /** Read-only deferrals may reuse preparation, but actual dispatch is once-only. */
  async submit(signal: AbortSignal, writer: NativeApprovalTransport<R>, policy: SubmissionPolicy): Promise<void> {
    if (this.sent || this.writing || this.terminal()) throw Error("Approval transaction already settled or submitting")
    this.writing = true
    const forwardAbort = () => {
      if (!this.sent || signal.reason !== this.permissionResolved) this.abort(signal.reason)
    }
    signal.addEventListener("abort", forwardAbort, { once: true })
    if (signal.aborted) forwardAbort()
    try {
      const remaining = remainingTime(signal)
      await withDeadline(this.acknowledgement.signal, remaining, async bounded => {
        // Allocate and connect confirmation ownership before the final guard.
        const abortEvent = () => {
          if (!this.terminal()) this.current = this.sent ? "uncertain" : "not-sent"
          this.resolveEvent("unavailable")
        }
        bounded.addEventListener("abort", abortEvent, { once: true })
        if (bounded.aborted) abortEvent()
        const publishDispatch = () => {
          this.fact("dispatched")
          policy.dispatched?.()
        }
        const dispatch = () => {
          if (this.sent || this.terminal()) return false
          reviewStage(signal, "Approval verification")
          reviewStage(bounded, "Approval acknowledgement")
          if (!policy.guard()) return false
          this.sent = true
          this.current = "dispatched"
          policy.dispatch()
          queueMicrotask(publishDispatch)
          return true
        }
        try {
          reviewStage(signal, "Approval verification")
          reviewStage(bounded, "Approval acknowledgement")
          if (!policy.guard()) return
          const result = await writer.once(this.request, bounded, dispatch)
          if (!this.sent) { this.current = "not-sent"; return }
          if (result.status !== "submitted" || this.terminal()) throw Error("Native approval acknowledgement uncertain")
          this.current = "acknowledged"
          if (await this.event !== "once") throw Error("Native approval reply did not match once")
          if (!bounded.aborted && this.current === "acknowledged") {
            this.current = "confirmed"
            policy.confirming()
            this.fact("confirmed")
            policy.confirmed()
          }
        } finally { bounded.removeEventListener("abort", abortEvent) }
      }, "Approval acknowledgement", signal)
    } catch (error) {
      if (!this.terminal()) this.current = this.sent ? "uncertain" : "not-sent"
      throw error
    } finally {
      this.writing = false
      signal.removeEventListener("abort", forwardAbort)
      if (this.sent) this.finish()
    }
  }

  /** Includes approvals stopped during verification, before submit was entered. */
  finish() {
    if (this.settled) return
    this.settled = true
    if (!this.terminal()) this.current = this.sent ? "uncertain" : "not-sent"
    this.fact("settled")
  }
}
