import { randomUUID } from "node:crypto"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { encodeEvent, HISTORY_OPERATION_OVERHEAD, HISTORY_QUEUE_BYTES, HISTORY_RETRY_MS, HistoryInvalid, rootID, snapshotQuery } from "./history-records.js"
import type { HistoryEvent, HistoryQuery } from "./history-records.js"
import type { HistoryResult } from "./history-schema.js"

declare const __HISTORY_WORKER__: string
// The fixed build banner is shared with the opaque terminal payload. Direct
// source tests have no embedded worker and must supply their own transport/source.
export const historyWorkerSource = typeof __HISTORY_WORKER__ === "string" ? __HISTORY_WORKER__ : ""
export interface HistoryTransport {
  /** Resolves/rejects only on actual message settlement or confirmed worker exit. */
  call(message: Record<string, unknown>): Promise<any>
  terminate(): Promise<void>
}
export class HistoryWorker implements HistoryTransport {
  private worker: Worker
  private id = 0
  private pending?: { id: number; resolve: (value: any) => void; reject: (error: Error) => void }
  private exited: Promise<void>
  private dead = false
  constructor(source = historyWorkerSource) {
    if (!source) throw new Error("History worker requires a built bundle")
    this.worker = new Worker(source, { eval: true, env: {} })
    // Errors are consumed, but ownership is released only by the exit event.
    this.worker.on("error", () => {})
    this.exited = new Promise(resolve => this.worker.once("exit", () => {
      this.dead = true; this.pending?.reject(new Error("History worker exited")); this.pending = undefined; resolve()
    }))
    this.worker.on("message", message => {
      if (message.id !== this.pending?.id) return
      const pending = this.pending!; this.pending = undefined
      if (message.error) pending.reject(message.error === "invalid" ? new HistoryInvalid("Invalid history operation")
        : new Error(message.error === "initialization" ? "History initialization unavailable" : "History storage unavailable"))
      else pending.resolve(message.value)
    })
  }
  call(message: Record<string, unknown>): Promise<any> {
    if (this.dead) return Promise.reject(new Error("History worker exited"))
    if (this.pending) return Promise.reject(new Error("History worker unavailable"))
    return new Promise((resolve, reject) => {
      const id = ++this.id; this.pending = { id, resolve, reject }
      try { this.worker.postMessage({ ...message, id }) } catch (error) { this.pending = undefined; reject(error) }
    })
  }
  async terminate(): Promise<void> { if (!this.dead) void this.worker.terminate().catch(() => {}); await this.exited }
}

interface Queued { sequence: number; event: string; bytes: number; root: string }
interface Read { query: HistoryQuery; resolve: (result: HistoryResult) => void; reject: (error: Error) => void; settled: () => void; started: boolean; finished: boolean; bootstrap?: string }
export type HistoryRead = Promise<HistoryResult> & { settled?: Promise<void> }
export interface HistoryStoreOptions {
  adapter?: "node" | "bun"; source?: string; transport?: () => HistoryTransport
  now?: () => number; schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}
/** Single-flight worker scheduler. Timed out callers do not release actual ownership. */
export class HistoryStore {
  private queue: Queued[] = []
  private reads: Read[] = []
  private bytes = 0
  private sequence = 0
  private writer = randomUUID()
  private worker?: HistoryTransport
  private opened = false
  private active = false
  private retryAt = 0
  private timer?: ReturnType<typeof setTimeout>
  private closing = false
  private stopped = false
  private blocked = false
  private writeFailed = false
  private preferRead = false
  private bootstraps = new Set<string>()
  private preferBootstrap = true
  private cleanupEnabled = false
  private cleanupDue = 0
  private cleanupNeeded = false
  private legacyCleanup?: boolean
  private failures = new Set<() => unknown>()
  private commits = new Set<() => unknown>()
  private disposal?: Promise<void>
  private dirty = false
  private dirtyRevision = 0
  private scanRevision = 0
  private maintenanceListeners = new Set<() => unknown>()
  private readonly now: () => number
  private readonly schedule: NonNullable<HistoryStoreOptions["schedule"]>
  private readonly cancel: NonNullable<HistoryStoreOptions["cancel"]>
  constructor(readonly stateDirectory: string, private options: HistoryStoreOptions = {}) {
    if (!path.isAbsolute(stateDirectory)) throw new HistoryInvalid("History state directory must be absolute")
    this.now = options.now ?? Date.now; this.schedule = options.schedule ?? setTimeout; this.cancel = options.cancel ?? clearTimeout
  }
  get retainedBytes() { return this.bytes }
  get pendingOperations() { return this.queue.length }
  /** Local observation only; another client may have committed newer cleanup work. */
  get cleanupPending() { return this.cleanupNeeded }
  get legacyCleanupRequired() { return this.legacyCleanup }
  /** Saturated deletion admission leaves one bounded reconciliation signal, never an ID side queue. */
  get maintenanceDirty() { return this.dirty }
  get maintenanceRevision() { return this.dirtyRevision }
  get maintenanceScanRevision() { return this.scanRevision }
  get maintenancePending() { return this.queue.length > 0 || this.blocked }
  markMaintenanceDirty(origin?: "cleanup") {
    if (this.stopped) return this.dirtyRevision
    this.dirty = true
    const revision = ++this.dirtyRevision
    if (origin !== "cleanup") this.scanRevision++
    this.notify(this.maintenanceListeners)
    return revision
  }
  maintenanceReconciled(revision = this.dirtyRevision) {
    if (revision !== this.dirtyRevision || this.queue.length || this.blocked) return false
    if (!this.dirty) return true
    this.dirty = false; this.notify(this.maintenanceListeners); return true
  }
  onMaintenance(listener: () => unknown) { this.maintenanceListeners.add(listener); return () => { this.maintenanceListeners.delete(listener) } }
  onCommit(listener: () => unknown) { this.commits.add(listener); return () => { this.commits.delete(listener) } }
  onWriteFailure(listener: () => unknown) { this.failures.add(listener); return () => { this.failures.delete(listener) } }
  private notify(listeners: Set<() => unknown>) {
    if (this.closing || this.stopped) return
    for (const listener of listeners) { try { void Promise.resolve(listener()).catch(() => {}) } catch {} }
  }
  admit(event: HistoryEvent): boolean {
    if (this.closing || this.stopped || this.blocked) {
      if (event.type === "sessionDeleted" && !this.stopped) this.markMaintenanceDirty()
      return false
    }
    const serialized = encodeEvent(event), bytes = Buffer.byteLength(serialized) + HISTORY_OPERATION_OVERHEAD
    if (this.bytes + bytes > HISTORY_QUEUE_BYTES || !Number.isSafeInteger(this.sequence + 1)) {
      if (event.type === "sessionDeleted") this.markMaintenanceDirty()
      return false
    }
    this.queue.push({ sequence: ++this.sequence, event: serialized, bytes, root: rootID(event.context) }); this.bytes += bytes
    this.pump(); return true
  }
  query(query: HistoryQuery, signal?: AbortSignal): HistoryRead {
    query = snapshotQuery(query)
    if (this.closing || this.stopped || this.reads.length >= 8) return Promise.reject(new Error("History read unavailable"))
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const promise: HistoryRead = new Promise((resolve, reject) => {
      let done = false
      const finish = (result?: HistoryResult, error?: Error) => {
        if (done) return; done = true; read.finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort)
        const index = this.reads.indexOf(read); if (index >= 0) this.reads.splice(index, 1)
        if (!read.started) settle()
        error ? reject(error) : resolve(result!)
      }
      const read: Read = { query, resolve: result => finish(result), reject: error => finish(undefined, error), settled: settle, started: false, finished: false }
      const abort = () => finish(undefined, new Error("History read aborted"))
      const timer = setTimeout(() => finish(undefined, new Error("History read timeout")), 3000)
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener("abort", abort, { once: true })
      this.reads.push(read); this.pump()
    })
    promise.settled = settled
    return promise
  }
  private pump() {
    if (this.active || this.stopped) return
    if (this.timer) { this.cancel(this.timer); this.timer = undefined }
    // One owned cleanup slot. Checkpoints retry after two seconds; interrupted
    // detail deletion and legacy page scrub yield ten milliseconds between
    // bounded slices. Poll even while idle to recover work left by an exited client.
    const cleanup = this.cleanupEnabled && this.now() >= this.cleanupDue && (!this.closing || this.cleanupNeeded)
    if (cleanup) { this.active = true; void this.run(undefined, undefined, true); return }
    const write = !this.blocked && this.queue.length > 0 && this.now() >= this.retryAt
    const bootstrap = !this.blocked && this.now() >= this.retryAt && (this.preferBootstrap || (!write && !this.reads.length))
      ? this.bootstraps.values().next().value : undefined
    const read = !bootstrap && this.reads.length && (!write || this.preferRead) ? this.reads.shift() : undefined
    if (!read && !write && !bootstrap) {
      const next = Math.min((this.queue.length || this.bootstraps.size) && !this.blocked ? this.retryAt : Infinity,
        this.cleanupEnabled && (!this.closing || this.cleanupNeeded) ? this.cleanupDue : Infinity)
      if (Number.isFinite(next)) {
        this.timer = this.schedule(() => { this.timer = undefined; this.pump() }, Math.max(0, next - this.now()))
        this.timer.unref?.()
      }
      return
    }
    this.active = true
    if (read) read.started = true
    void this.run(read, bootstrap)
  }
  private rememberBootstrap(root: string) {
    // Eight admitted readers plus the FIFO head. Expired readers cannot grow a
    // permanent side queue; their durable cursor resumes on a subsequent poll.
    if (!this.bootstraps.has(root) && this.bootstraps.size >= 9) this.bootstraps.delete(this.bootstraps.values().next().value!)
    this.bootstraps.add(root); this.preferBootstrap = true
  }
  private async run(read?: Read, bootstrap?: string, cleanup = false) {
    // Termination is a deadline action; never create a replacement until exit is observed.
    const bootstrapReaders = bootstrap ? this.reads.filter(reader => reader.bootstrap === bootstrap) : []
    for (const reader of bootstrapReaders) reader.started = true
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let terminating: Promise<void> | undefined
    let cleanupDelay = HISTORY_RETRY_MS
    try {
      this.worker ??= this.options.transport?.() ?? new HistoryWorker(this.options.source)
      const worker = this.worker
      watchdog = setTimeout(() => { terminating = worker.terminate(); void terminating.catch(() => {}) }, 3000)
      if (!this.opened) {
        const opened = await worker.call({ type: "open", file: path.join(this.stateDirectory, "opencode-reviewer/history-v1.sqlite"), adapter: this.options.adapter ?? "bun" })
        if (terminating) throw new Error("History worker terminating")
        this.opened = true
        this.cleanupEnabled = opened?.cleanup === true
        this.cleanupNeeded = this.cleanupEnabled
        this.cleanupDue = 0
      }
      if (this.stopped) return
      if (cleanup) {
        const result = await worker.call({ type: "cleanup" })
        this.cleanupNeeded = result.pending; this.legacyCleanup = result.legacy
        if (result.deleting || result.scrubbing) cleanupDelay = 10 // Yield between bounded durable cleanup slices.
      } else if (bootstrap) {
        const result = await worker.call({ type: "bootstrap", root: bootstrap })
        this.bootstraps.delete(bootstrap)
        if (!result.done) this.bootstraps.add(bootstrap)
        this.preferBootstrap = false; this.retryAt = 0
      } else if (read) {
        if ((read.query.type === "totals" || read.query.type === "conversationTotals") && this.writeFailed) throw new Error("History accounting unavailable")
        const revision = this.dirtyRevision
        if (read.query.type === "history" && this.dirty) throw new Error("History reconciliation pending")
        const result = await worker.call({ type: "query", query: read.query })
        if (result?.pending) {
          read.bootstrap = result.pending; this.rememberBootstrap(result.pending)
          if (!read.finished) this.reads.push(read)
          return
        }
        if (read.query.type === "history" && (this.dirty || revision !== this.dirtyRevision)) throw new Error("History reconciliation pending")
        read.resolve(result); this.preferRead = false
      }
      else {
        const item = this.queue[0]!
        const result = await worker.call({ type: "apply", writer: this.writer, sequence: item.sequence, event: item.event })
        if (result?.pending) { this.rememberBootstrap(result.pending); this.preferRead = true; return }
        if (result?.deleting) { this.cleanupNeeded = this.cleanupEnabled; this.preferRead = true; this.retryAt = 0; return }
        if (this.stopped) return
        if (this.cleanupEnabled) this.cleanupNeeded = true
        this.queue.shift(); this.bytes -= item.bytes; this.retryAt = 0; this.writeFailed = false; this.preferRead = true; this.notify(this.commits)
      }
    } catch (error) {
      if (cleanup) this.cleanupNeeded = true // Cleanup failure cannot poison event replay/accounting.
      else if (read) read.reject(error as Error)
      else if (bootstrap && this.queue[0]?.root !== bootstrap) {
        this.bootstraps.delete(bootstrap)
        for (const reader of [...this.reads]) if (reader.bootstrap === bootstrap) reader.reject(error as Error)
      }
      else {
        this.writeFailed = true
        // Invalid transactions retain their admitted FIFO. They cannot be skipped without
        // changing replay semantics; reject further admissions and expose the failure.
        // Opening has not attempted an admitted transaction, even if path/schema
        // validation reports HistoryInvalid through an embedding transport.
        if (this.opened && error instanceof HistoryInvalid) this.blocked = true
        this.retryAt = this.now() + HISTORY_RETRY_MS; this.notify(this.failures)
      }
      // SQL errors settle normally: readable committed data remains available on the same worker.
      if ((error as Error).message === "History worker exited") { this.worker = undefined; this.opened = false }
    } finally {
      clearTimeout(watchdog)
      if (terminating) {
        // A reply racing termination settles the message, not the dying worker.
        await terminating
        this.worker = undefined; this.opened = false
      }
      if (cleanup) this.cleanupDue = this.now() + cleanupDelay
      if (read) { read.started = false; if (read.finished) read.settled() }
      for (const reader of bootstrapReaders) {
        reader.started = false
        if (reader.finished) reader.settled()
      }
      this.active = false; this.pump()
    }
  }
  /** Call after review finalizers; deadline is relative to lifecycle abort, not this call. */
  dispose(abortAt = performance.now()): Promise<void> {
    return this.disposal ??= this.drain(abortAt)
  }
  private async drain(abortAt: number) {
    this.closing = true; this.commits.clear(); this.failures.clear(); this.maintenanceListeners.clear()
    for (const read of this.reads.splice(0)) read.reject(new Error("History disposed"))
    const end = abortAt + 3500
    while ((this.queue.length || this.active || this.cleanupNeeded) && performance.now() < end - 300 && !this.blocked) {
      this.pump(); await new Promise(resolve => setTimeout(resolve, 10))
    }
    this.stopped = true
    if (this.timer) this.cancel(this.timer)
    const termination = this.worker?.terminate().catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([termination, new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, end - performance.now())) })])
    clearTimeout(timer)
    this.queue = []; this.bytes = 0
  }
}
