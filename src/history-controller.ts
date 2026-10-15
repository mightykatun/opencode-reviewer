import { HistoryRefresh } from "./history-refresh.js"
import type { HistoryStore } from "./history-store.js"
import type { HistorySelection } from "./history-schema.js"
import type { HistoryQuery, HistoryTarget } from "./history-records.js"
import type { AncestryRead, AncestryReader } from "./session-ancestry.js"

export interface HistoryViewState {
  open: boolean; status: "loading" | "ready" | "error"; selection?: HistorySelection; reset: number
}

/** Owns only one indexed selection. No review-mode load or permission writer. */
export class HistoryController {
  state: HistoryViewState = { open: false, status: "loading", reset: 0 }
  scroll = 0
  private generation = 0
  private session?: string
  private root?: string
  private refresh?: HistoryRefresh
  private abort?: AbortController
  private retry?: ReturnType<typeof setTimeout>
  private stopped = false
  private lookup = false
  private lookupAgain = false
  private target?: HistoryTarget & { until: number; ready: () => void }
  private targetTimeout?: ReturnType<typeof setTimeout>
  private deletedEntries = new Set<string>()
  private unsubscribeMaintenance?: () => void
  constructor(private scope: string, private store: Pick<HistoryStore, "query" | "onCommit" | "onWriteFailure"> & Partial<Pick<HistoryStore, "onMaintenance" | "maintenanceDirty">>,
    private ancestry: AncestryReader, private publish: (state: HistoryViewState) => void) {
    this.unsubscribeMaintenance = store.onMaintenance?.(() => {
      if ((!this.state.open && !this.target) || this.stopped) return
      if (store.maintenanceDirty) this.update({ status: "loading" })
      this.refresh?.refresh()
    })
  }
  private update(value: Partial<HistoryViewState>) { this.state = { ...this.state, ...value }; this.publish(this.state) }
  recordScroll(offset: number) { if (this.state.status === "ready") this.scroll = offset }
  isCurrent(session: string) { return !this.stopped && this.state.open && this.session === session }
  open(session: string) { this.start(session) }
  openPermission(session: string, target: HistoryTarget, ready: () => void) {
    this.start(session, { ...target, until: performance.now() + 5000, ready })
  }
  cancelPendingPermission() { if (this.target) this.close() }
  private start(session: string, target?: HistoryController["target"]) {
    if (this.stopped) return
    this.close()
    this.session = session
    this.target = target
    this.scroll = 0
    // Notification clicks wait silently for a qualifying saved report. A missing
    // entry must never fall back to the newest report or open an empty panel.
    this.update({ open: !target, status: "loading", selection: undefined, reset: this.state.reset + 1 })
    const generation = this.generation
    if (target) this.targetTimeout = setTimeout(() => { if (generation === this.generation) this.close() }, 5000)
    this.abort = new AbortController()
    void this.resolve(this.generation, session, this.abort.signal)
  }
  private async resolve(generation: number, session: string, signal: AbortSignal) {
    if (this.stopped || signal.aborted || generation !== this.generation) return
    if (this.lookup) { this.lookupAgain = true; return }
    this.lookup = true; this.lookupAgain = false
    let read: AncestryRead | undefined
    try {
      read = this.ancestry(session, signal)
      const root = await read
      if (generation !== this.generation || signal.aborted) return
      this.root = root
      this.refresh = new HistoryRefresh(this.store, this.query(), result => {
        if (generation !== this.generation || (!this.state.open && !this.target)) return
        if (this.store.maintenanceDirty) { this.update({ status: "loading" }); return }
        if (!result || !("rank" in result)) { if (!this.target) this.update({ status: "error" }); return }
        if (result.deleted) { this.close(); return }
        const target = this.target
        if (target) {
          if (performance.now() >= target.until) { this.close(); return }
          const context = result.record?.context
          if (!result.entry || !context || context.scope !== this.scope || context.root !== root
            || context.session !== target.session || context.permission !== target.permission) return
          clearTimeout(this.targetTimeout); this.target = undefined
        }
        if (result.entry && this.deletedEntries.has(result.entry)) return
        this.deletedEntries.clear()
        const previous = this.state.selection
        const replaced = previous?.entry !== result.entry || previous?.order?.tie !== result.order?.tie
          || JSON.stringify(previous?.record?.payload) !== JSON.stringify(result.record?.payload)
        if (replaced) this.scroll = 0
        // Loading/error messages replace Markdown and collapse its scroll extent.
        // Recovery of the same payload must restore layout without losing its offset.
        const restore = replaced || this.state.status !== "ready"
        this.update({ open: true, status: "ready", selection: result, reset: this.state.reset + Number(restore) })
        // Poll by stable identity, never repeat a direction or jump to a new arrival.
        this.refresh?.retain(this.query())
        if (target && generation === this.generation) { try { target.ready() } catch {} }
      })
    } catch {
      if (generation !== this.generation || signal.aborted) return
      if (!this.target) this.update({ status: "error" })
      this.retry = setTimeout(() => void this.resolve(generation, session, signal), 2000)
    } finally {
      await read?.settled?.catch(() => {})
      this.lookup = false
      if (!this.stopped && this.lookupAgain && this.session && this.abort && !this.abort.signal.aborted) {
        clearTimeout(this.retry)
        void this.resolve(this.generation, this.session, this.abort.signal)
      }
    }
  }
  private query(): HistoryQuery {
    const selected = this.state.selection
    return { type: "history", scope: this.scope, root: this.root!, ...(this.target
      ? { permission: { session: this.target.session, permission: this.target.permission } }
      : { entry: selected?.entry, order: selected?.order }) }
  }
  navigate(direction: "older" | "newer") {
    if (!this.state.open || this.state.status !== "ready" || !this.state.selection?.[direction]) return
    this.refresh?.select({ ...this.query(), direction } as HistoryQuery)
  }
  route(session?: string) { if ((this.state.open || this.target) && session !== this.session) this.close() }
  deleted(id: string) {
    if (id === this.root || id === this.session || id === this.target?.session) { this.close(); return }
    const selected = this.state.selection
    if (selected?.entry && (selected.session ?? selected.record?.context.session) === id) {
      this.deletedEntries.add(selected.entry)
      // Keep the cursor for adjacent-entry recovery, never known-deleted plaintext.
      this.update({ status: "loading", selection: { revision: selected.revision, total: selected.total, rank: selected.rank,
        entry: selected.entry, order: selected.order, session: id } })
    }
    this.refresh?.refresh()
  }
  close() {
    this.lookupAgain = false
    this.generation++; this.abort?.abort(); this.refresh?.dispose(); this.refresh = undefined
    clearTimeout(this.retry); this.root = undefined; this.session = undefined
    clearTimeout(this.targetTimeout); this.target = undefined
    this.deletedEntries.clear()
    this.scroll = 0
    this.update({ open: false, status: "loading", selection: undefined })
  }
  dispose() { this.stopped = true; this.unsubscribeMaintenance?.(); this.close() }
}
