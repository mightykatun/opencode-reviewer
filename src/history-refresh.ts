import type { HistoryStore } from "./history-store.js"
import type { HistoryQuery } from "./history-records.js"
import { snapshotQuery } from "./history-records.js"
import type { HistoryResult } from "./history-schema.js"

/** One actual store read and one coalesced follow-up. Only hard invalidations
 * discard snapshots; ordinary commits request fresher data without starving reads.
 */
export class HistoryRefresh {
  private revision = 0
  private active = false
  private again = false
  private stopped = false
  private abort = new AbortController()
  private timer: ReturnType<typeof setInterval>
  private offCommit: () => void
  private offFailure: () => void
  constructor(private store: Pick<HistoryStore, "query" | "onCommit" | "onWriteFailure">,
    private query: HistoryQuery, private publish: (result: HistoryResult | undefined) => void) {
    this.query = snapshotQuery(query)
    this.offCommit = store.onCommit(() => this.request())
    // A write outage does not hide readable history. Analytics retains its unavailable policy.
    this.offFailure = store.onWriteFailure(() => {
      if ((this.query.type !== "totals" && this.query.type !== "conversationTotals") || this.stopped) return
      this.revision++; this.again = false; this.publish(undefined)
    })
    // A healthy read taking over two seconds must still be publishable.
    this.timer = setInterval(() => this.request(), 2000)
    this.request()
  }
  select(query: HistoryQuery) { this.query = snapshotQuery(query); this.refresh() }
  /** Update the next polling cursor after a successful snapshot, without another read. */
  retain(query: HistoryQuery) { this.query = snapshotQuery(query) }
  /** Navigation, deletion and maintenance invalidate even a successful old read. */
  refresh() {
    if (this.stopped) return
    this.revision++
    this.request()
  }
  private request() {
    if (this.stopped) return
    if (this.active) { this.again = true; return }
    this.start()
  }
  private start() {
    this.active = true; this.again = false
    const revision = this.revision
    const read = this.store.query(this.query, this.abort.signal)
    void read.then(value => {
      if (!this.stopped && revision === this.revision) this.publish(value)
    }, () => { if (!this.stopped && revision === this.revision) this.publish(undefined) }).finally(async () => {
      await read.settled?.catch(() => {})
      this.active = false
      if (this.again && !this.stopped) this.start()
    }).catch(() => {})
  }
  dispose() {
    this.stopped = true; this.revision++; this.again = false; this.abort.abort()
    clearInterval(this.timer); this.offCommit(); this.offFailure()
  }
}
