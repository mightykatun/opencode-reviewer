import { constants } from "node:fs"
import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NotificationKind } from "./notification-types.js"
import type { NotificationProcesses } from "./notification-process.js"
import { withDeadline } from "./deadline.js"
import { MAX_SOUND_BYTES, normalizedSound } from "./notification-codec.js"
import { actionable, NotificationQueue, notificationWait } from "./notification-queue.js"

export interface BundledSound { format: "mp3" | "wav"; data: string }
declare const __REVIEW_SOUNDS__: Partial<Record<NotificationKind, BundledSound>>
const bundled = typeof __REVIEW_SOUNDS__ === "undefined" ? {} : __REVIEW_SOUNDS__

/** Bounded capture, bundled decoding, normalization and playback outside review budgets. */
export class NotificationAudio {
  private stopped = false
  private active = 0
  private playingRoots = new Set<string>()
  private preparing = 0
  private temporary?: Promise<string>
  private prepared = new Map<NotificationKind, Promise<string | undefined>>()
  private transactions = new Set<Promise<unknown>>()
  private abort = new AbortController()
  private preparations: (() => void)[] = []
  private plays = new NotificationQueue<{ root: string; attention: boolean; kind: NotificationKind; run(): void; cancel(): void }>(64, 64)
  private lastApproval = -Infinity
  private approvalStarting?: symbol
  private wake?: ReturnType<typeof setTimeout>
  constructor(private processes: NotificationProcesses, private directory?: string,
    private sounds: Partial<Record<NotificationKind, BundledSound>> = bundled,
    private io = { open, mkdtemp, writeFile, rm }) {}
  private async capture(file: string, signal: AbortSignal) {
    const handle = await this.io.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      signal.throwIfAborted()
      const stat = await handle.stat()
      if (!stat.isFile() || !stat.size || stat.size > MAX_SOUND_BYTES) throw new Error("Invalid notification sound file")
      const bytes = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < bytes.length) {
        signal.throwIfAborted()
        const read = await handle.read(bytes, size, Math.min(65536, bytes.length - size), size)
        signal.throwIfAborted()
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size > stat.size) throw new Error("Notification sound changed during capture")
      return bytes.subarray(0, size)
    } finally { await handle.close() }
  }
  private async prepare(kind: NotificationKind, signal: AbortSignal) {
    let pcm: Buffer | undefined
    if (this.directory) for (const format of ["wav", "mp3"] as const) {
      signal.throwIfAborted()
      try { pcm = await normalizedSound(await this.capture(path.join(this.directory, `${kind}.${format}`), signal), format, signal); break }
      catch { signal.throwIfAborted() }
    }
    if (!pcm) {
      const sound = this.sounds[kind]
      if (!sound) return
      pcm = await normalizedSound(Buffer.from(sound.data, "base64"), sound.format, signal)
    }
    signal.throwIfAborted()
    this.temporary ??= this.io.mkdtemp(path.join(tmpdir(), "opencode-reviewer-sounds-"))
    const directory = await this.temporary
    signal.throwIfAborted()
    const file = path.join(directory, `${kind}.wav`)
    await this.io.writeFile(file, pcm, { flag: "w", mode: 0o600 })
    signal.throwIfAborted()
    return file
  }
  private async file(kind: NotificationKind, signal: AbortSignal) {
    // Bound the caller's entire wait, including time queued behind two physically
    // unsettled preparations. The shared preparation keeps its own I/O lease.
    const wait = (pending: Promise<string | undefined>) => withDeadline(signal, 2000,
      bounded => notificationWait(pending, bounded))
    const existing = this.prepared.get(kind)
    if (existing) return wait(existing)
    let yes!: (file: string | undefined) => void, no!: (error: unknown) => void
    const preparation = new Promise<string | undefined>((resolve, reject) => { yes = resolve; no = reject })
    this.prepared.set(kind, preparation)
    void preparation.catch(() => {})
    this.preparations.push(() => {
      this.preparing++ // Reserve synchronously, before withDeadline's callback.
      let worker: Promise<string | undefined> | undefined
      const wait = withDeadline(this.abort.signal, 2000, bounded => worker = this.prepare(kind, bounded))
      const transaction = (async () => {
        let failed = false
        try { yes(await wait) } catch (error) { failed = true; no(error) }
        finally {
          await worker?.catch(() => {})
          if (failed && this.prepared.get(kind) === preparation) this.prepared.delete(kind)
          this.preparing--; this.prepareNext()
        }
      })()
      this.transactions.add(transaction)
      void transaction.then(() => this.transactions.delete(transaction), () => this.transactions.delete(transaction))
    })
    this.prepareNext()
    // A resolved/canceled banner stops its playback wait, not a shared bounded
    // preparation that a following notification of the same kind still needs.
    return wait(preparation)
  }
  private prepareNext() { while (this.preparing < 2 && this.preparations.length) this.preparations.shift()!() }
  /** Decode/cache before desktop delivery, so a visible banner does not wait on WASM or file I/O. */
  async ready(kind: NotificationKind, parent: AbortSignal): Promise<boolean> {
    if (this.stopped || parent.aborted) return false
    try { return !!await this.file(kind, AbortSignal.any([parent, this.abort.signal])) }
    catch { return false }
  }
  play(kind: NotificationKind, parent: AbortSignal, root = kind as string, dispatched: () => void = () => {}): Promise<void> {
    if (this.stopped || parent.aborted) return Promise.resolve()
    const signal = AbortSignal.any([parent, this.abort.signal])
    return new Promise(resolve => {
      const finish = () => { signal.removeEventListener("abort", cancel); resolve() }
      const cancel = () => { if (this.plays.items.includes(job)) { this.plays.remove(job); finish() } }
      const job = { root, kind, attention: actionable(kind), cancel, run: () => {
        this.active++
        this.playingRoots.add(root)
        const reservation = kind === "approved" ? this.approvalStarting = Symbol() : undefined
        const worker = this.playNow(kind, signal, root, () => {
          if (reservation && this.approvalStarting === reservation) {
            this.lastApproval = performance.now(); this.approvalStarting = undefined; this.playNext()
          }
          dispatched()
        }).finally(() => {
          if (reservation && this.approvalStarting === reservation) this.approvalStarting = undefined
          this.active--; this.playingRoots.delete(root); finish(); this.playNext()
        })
        this.transactions.add(worker)
        void worker.then(() => this.transactions.delete(worker), () => this.transactions.delete(worker))
      } }
      signal.addEventListener("abort", cancel, { once: true })
      if (this.plays.items.length >= 64 || !this.plays.add(job)) { finish(); return }
      this.playNext()
    })
  }
  private playNext() {
    if (this.stopped) return
    while (this.active < 2) {
      const job = this.plays.take(value => !this.playingRoots.has(value.root)
        && (value.kind !== "approved" || (!this.approvalStarting && performance.now() - this.lastApproval >= 2000)))
      if (!job) {
        // Root ownership is released by actual player settlement, not a timer.
        if (this.plays.items.some(value => !this.playingRoots.has(value.root)) && !this.approvalStarting && !this.wake) this.wake = setTimeout(() => { this.wake = undefined; this.playNext() },
          Math.max(1, 2000 - (performance.now() - this.lastApproval)))
        return
      }
      job.run()
    }
  }
  private async playNow(kind: NotificationKind, signal: AbortSignal, root: string, dispatched: () => void) {
    try {
      const file = await this.file(kind, signal)
      signal.throwIfAborted()
      if (!file) return
      for (const player of ["paplay", "pw-play"]) {
        signal.throwIfAborted()
        const process = this.processes.start(player, [player === "paplay" ? "--latency-msec=50" : "--latency=50ms", file], 12000, signal,
          undefined, { lane: "audio", root, attention: actionable(kind) })
        if (process) { if (!process.started || await process.started) dispatched() }
        if (!process || (await process.result).code === 0) return
      }
    } catch { /* Audio failures do not affect banners, review or approval. */ }
  }
  async dispose() {
    this.stopped = true; this.abort.abort()
    clearTimeout(this.wake)
    const cleanup = async () => {
      await Promise.allSettled([...this.prepared.values(), ...this.transactions])
      const directory = await this.temporary?.catch(() => undefined)
      if (directory) await this.io.rm(directory, { recursive: true, force: true }).catch(() => {})
    }
    // Retain eventual cleanup if a filesystem transaction outlives disposal.
    const worker = cleanup().catch(() => {})
    await withDeadline(new AbortController().signal, 2500, () => worker).catch(() => {})
  }
}
