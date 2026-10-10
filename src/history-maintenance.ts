import type { HistoryScope } from "./history-records.js"
import type { HistorySessions } from "./history-schema.js"
import type { HistoryStore } from "./history-store.js"

type Store = Pick<HistoryStore, "query" | "admit" | "maintenanceDirty" | "maintenanceRevision" | "maintenanceScanRevision" | "maintenancePending" | "maintenanceReconciled" | "markMaintenanceDirty">
export type SessionRead = (session: string, signal: AbortSignal) => Promise<unknown>

/** session.get in the pinned public SDK uses the legacy NotFoundError envelope,
 * not the separate v2.session API's SessionNotFoundError. A bare 404 is not proof.
 */
export function sessionPresence(result: unknown, session: string): "present" | "missing" | "unknown" {
  const r = result as any
  if (!r || typeof r !== "object") return "unknown"
  if (r.response?.status === 200 && !r.error && r.data?.id === session) return "present"
  const e = r.error
  if (r.response?.status === 404 && r.data === undefined && e && typeof e === "object"
    && Object.keys(e).length === 2 && e.name === "NotFoundError" && e.data && typeof e.data === "object"
    && Object.keys(e.data).length === 1 && e.data.message === `Session not found: ${session}`) return "missing"
  return "unknown"
}

/** One ownership page (<=100), one actual host/read transaction. Idle scanning
 * checks one row per two-second turn. Dirty recovery yields after 100 rows or
 * 50 ms, then resumes after 10 ms; an already-started row retains ownership through
 * actual settlement. Scope is fixed by the caller's invocation client, never a stored
 * target directory. No missed-ID queue. A failed pass resumes then retries from
 * the beginning; only a complete healthy pass can release the recovery gate.
 */
export class HistoryMaintenance {
  private stopped = false
  private active = false
  private abort = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private page: HistoryScope[] = []
  private after?: string
  private revision = -1
  private scanRevision = -1
  private healthy = true
  private cleaned = false
  private ending = false
  private turn?: AbortController
  constructor(private scope: string, private store: Store, private get: SessionRead,
    private invalidate: (session: string) => void = () => {}, private now: () => number = () => performance.now()) {}
  start() { if (!this.stopped && !this.timer && !this.active) this.schedule() }
  private schedule() {
    if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.step().finally(() => this.schedule()) }, this.store.maintenanceDirty ? 10 : 2000)
  }
  /** Also exposed for deterministic fixtures. Concurrent calls cannot duplicate work. */
  async step() {
    if (this.stopped || this.active) return
    this.active = true
    const turn = this.turn = new AbortController()
    const deadline = setTimeout(() => turn.abort(), 5000)
    const until = this.now() + 50, rows = this.store.maintenanceDirty ? 100 : 1
    try {
      if (this.scanRevision !== this.store.maintenanceScanRevision) {
        this.scanRevision = this.store.maintenanceScanRevision
        this.revision = this.store.maintenanceRevision
        this.after = undefined; this.page = []; this.healthy = true; this.cleaned = false; this.ending = false
      }
      if (this.ending) { this.finishPass(); return }
      for (let n = 0; n < rows; n++) {
        if (this.stopped || turn.signal.aborted) { this.healthy = false; return }
        if (this.scanRevision !== this.store.maintenanceScanRevision) return
        if (!this.page.length) {
          const read = this.store.query({ type: "sessions", scope: this.scope, after: this.after, limit: 100 }, turn.signal)
          let result: HistorySessions
          try { result = await read as HistorySessions } finally { await read.settled?.catch(() => {}) }
          if (this.stopped || turn.signal.aborted) { this.healthy = false; return }
          if (this.scanRevision !== this.store.maintenanceScanRevision) return
          if (!result.sessions.length) {
            this.ending = true
            this.finishPass()
            return
          }
          this.page = result.sessions; this.after = result.after
        }
        if (this.now() >= until) return
        const context = this.page.shift()!
        if (context.scope !== this.scope) { this.healthy = false; return }
        // Root first, even when it has no own report row. Native root deletion
        // cascades, so deleting only the first absent child would leave root detail.
        const root = await this.presence(context.root)
        if (this.stopped || this.scanRevision !== this.store.maintenanceScanRevision) return
        if (root === "missing") this.remove({ ...context, session: context.root })
        else if (root === "unknown") this.healthy = false
        else if (context.session !== context.root) {
          const child = await this.presence(context.session)
          if (this.stopped || this.scanRevision !== this.store.maintenanceScanRevision) return
          if (child === "missing") this.remove(context)
          else if (child === "unknown") this.healthy = false
        }
        if (this.now() >= until) return
      }
    } catch { this.healthy = false }
    finally { clearTimeout(deadline); this.turn = undefined; this.active = false }
  }
  private remove(context: HistoryScope) {
    // Every deletion still invalidates in-flight history reads. Only an external
    // invalidation restarts this pass; our own cleanup needs one final healthy pass.
    this.revision = this.store.markMaintenanceDirty("cleanup")
    this.cleaned = true
    this.invalidate(context.session)
    if (!this.store.admit({ type: "sessionDeleted", context, at: Date.now() })) this.healthy = false
    else this.page = this.page.filter(row => context.session === context.root ? row.root !== context.root : row.session !== context.session)
  }
  private finishPass() {
    if (this.scanRevision !== this.store.maintenanceScanRevision || this.store.maintenancePending) return
    if (this.healthy && !this.cleaned && !this.store.maintenanceReconciled(this.revision)) return
    this.after = undefined; this.healthy = true; this.cleaned = false; this.ending = false
  }
  private async presence(session: string) {
    const abort = new AbortController()
    const stop = () => abort.abort()
    this.abort.signal.addEventListener("abort", stop, { once: true })
    const turn = this.turn!.signal
    turn.addEventListener("abort", stop, { once: true })
    if (turn.aborted || this.abort.signal.aborted) abort.abort()
    const timer = setTimeout(stop, 1500)
    // Retain the single-flight slot until actual settlement, including when the
    // underlying public transport ignores abort. Late success cannot prove absence.
    try {
      const result = await this.get(session, abort.signal)
      return abort.signal.aborted || this.stopped ? "unknown" : sessionPresence(result, session)
    } catch { return "unknown" }
    finally { clearTimeout(timer); this.abort.signal.removeEventListener("abort", stop); turn.removeEventListener("abort", stop) }
  }
  dispose() { this.stopped = true; clearTimeout(this.timer); this.abort.abort(); this.turn?.abort(); this.page = [] }
}
