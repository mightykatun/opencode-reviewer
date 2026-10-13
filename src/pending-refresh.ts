import type { HostRequest } from "./host-types.js"
import { withDeadline } from "./deadline.js"

interface PendingState<R = HostRequest> {
  readonly revision: number
  reconcile(requests: readonly R[], revision: number): void
}

/** Read-only recovery. Deadline callbacks produce data, never controller effects. */
export class PendingRefresh<R = HostRequest> {
  private syncing = false
  private stopped = false
  private again = false
  private generation = 0
  private abort = new AbortController()
  private signal: AbortSignal
  constructor(private pending: PendingState<R>, private read: (signal: AbortSignal) => Promise<readonly R[]>, parent: AbortSignal,
    private health?: (healthy: boolean) => void) {
    this.signal = AbortSignal.any([parent, this.abort.signal])
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.signal.aborted) return
    if (this.syncing) { this.again = true; return }
    this.syncing = true
    const generation = ++this.generation
    const revision = this.pending.revision
    let worker: Promise<readonly R[]> | undefined
    const report = (healthy: boolean) => { if (!this.stopped && !this.signal.aborted) { try { this.health?.(healthy) } catch {} } }
    try {
      const requests = await withDeadline(this.signal, 5000, signal => worker = Promise.resolve().then(() => {
        signal.throwIfAborted(); return this.read(signal)
      }), "Pending permission refresh")
      if (this.stopped || this.signal.aborted || this.generation !== generation || this.pending.revision !== revision) { report(false); return }
      this.pending.reconcile(requests, revision)
      report(true)
    } catch { report(false) }
    finally {
      const release = () => {
        if (this.generation === generation) {
          this.syncing = false
          const again = this.again
          this.again = false
          if (again) void this.refresh()
        }
      }
      // Caller completion is bounded; physical settlement owns admission.
      if (worker) void worker.then(release, release)
      else release()
    }
  }

  dispose() {
    this.stopped = true
    this.again = false
    this.generation++
    this.abort.abort()
  }
}
