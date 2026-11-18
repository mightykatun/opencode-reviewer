import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { reviewStage, withDeadline } from "./deadline.js"
import type { SessionAncestry, AncestryRead } from "./session-ancestry.js"
import { privateRecordDirectory, readPrivateRecord, syncPrivateDirectory, validPrivateRecord, writePrivateRecord } from "./private-record.js"

const MAX_MODE_READS = 2
const MODE_READ_MS = 5000
interface ModeRead {
  wait?: Promise<void>
  physical?: Promise<unknown>
  obsolete?: boolean
  settled: boolean
  finished: boolean
}

export interface SessionModeGate {
  root(sessionID: string, signal: AbortSignal): AncestryRead
  load(root: string, signal: AbortSignal): Promise<void>
  enabled(root: string): boolean
  forget?(root: string): void
}
export interface ModeStore {
  read(root: string, signal: AbortSignal): Promise<boolean>
  write(root: string, enabled: boolean): Promise<void>
  flush(): Promise<void>
}

/** Independent root records avoid overwriting another conversation's updates. */
export class SessionModeStore implements ModeStore {
  private pending = Promise.resolve()
  constructor(private directory: string, private host: string) {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes("\0")) throw new Error("Session mode directory must be absolute and normalized")
  }
  private file(root: string) {
    const key = createHash("sha256").update(JSON.stringify([this.host, root])).digest("hex")
    return path.join(this.directory, `${key}.json`)
  }
  async read(root: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (!await privateRecordDirectory(this.directory, false, "mode", signal)) { signal.throwIfAborted(); return true }
    const file = await open(this.file(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (!file) { signal.throwIfAborted(); return true }
    try {
      signal.throwIfAborted()
      const stat = await file.stat()
      signal.throwIfAborted()
      if (!validPrivateRecord(stat, 1024)) throw new Error("Invalid session mode record")
      const buffer = await readPrivateRecord(file, 1025, signal)
      signal.throwIfAborted()
      if (buffer.length > 1024) throw new Error("Invalid session mode record")
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer))
      if (!value || Array.isArray(value) || Object.keys(value).length !== 2 || value.version !== 1 || typeof value.enabled !== "boolean") {
        throw new Error("Invalid session mode record")
      }
      return value.enabled
    } finally { await file.close() }
  }
  write(root: string, enabled: boolean): Promise<void> {
    const file = this.file(root)
    this.pending = this.pending.catch(() => {}).then(async () => {
      await privateRecordDirectory(this.directory, true, "mode")
      await writePrivateRecord(file, JSON.stringify({ version: 1, enabled }))
      await syncPrivateDirectory(this.directory)
    })
    return this.pending
  }
  flush() { return this.pending }
}

/** Only metadata needed to establish ownership is read before this gate opens. */
export class SessionModes implements SessionModeGate {
  private values = new Map<string, { enabled: boolean }>()
  private writes = new Map<string, Promise<void>>()
  private reads = new Map<string, ModeRead>()
  private queue = new Map<string, { admit(): void; cancel(): void }>()
  private refreshes = new Map<string, { before: { enabled: boolean }; end: number; wait: Promise<void> }>()
  constructor(private store: ModeStore, private ancestry: Pick<SessionAncestry, "root" | "deleted">) {}
  root(sessionID: string, signal: AbortSignal): AncestryRead { return this.ancestry.root(sessionID, signal) }
  async load(root: string, parent: AbortSignal) {
    parent.throwIfAborted()
    if (this.values.has(root)) return
    const pending = this.reads.get(root)
    if (pending?.obsolete) throw new Error("Previous mode read still draining")
    if (pending) return withDeadline(parent, MODE_READ_MS, () => pending.wait!, "Session mode loading")
    if (this.reads.size >= MAX_MODE_READS) throw new Error("Session mode read capacity unavailable")
    return this.readMode(root, parent)
  }
  private readMode(root: string, parent: AbortSignal, changed?: (root: string) => void) {
    const read: ModeRead = { settled: true, finished: false }
    const before = this.values.get(root)
    let wake!: () => void
    const permit = new Promise<void>(resolve => { wake = resolve })
    const admit = () => {
      this.reads.set(root, read)
      wake()
    }
    const slot = { admit, cancel: () => { read.obsolete = true; wake() } }
    if (changed) this.queue.set(root, slot)
    else admit()
    const publish = (enabled: boolean) => {
      if (parent.aborted || read.obsolete || this.values.get(root) !== before) return
      this.values.set(root, { enabled })
      if (before && before.enabled !== enabled) changed?.(root)
    }
    read.wait = withDeadline(parent, MODE_READ_MS, async signal => {
      if (changed) await permit
      signal.throwIfAborted()
      if (read.obsolete || this.values.get(root) !== before) return false
      read.settled = false
      const worker = Promise.resolve().then(async () => {
        const saving = this.writes.get(root)
        if (saving) await saving.catch(() => {})
        reviewStage(signal, changed ? "Session mode refresh" : "Session mode loading")
        return this.store.read(root, signal)
      })
      read.physical = worker
      const settled = () => { read.settled = true; this.releaseRead(root, read) }
      void worker.then(settled, settled)
      return worker
    }, changed ? "Session mode refresh" : "Session mode loading").then(publish, error => {
      if (!changed) throw error
      publish(false)
    }).finally(() => {
      if (this.queue.get(root) === slot) this.queue.delete(root)
      wake()
      read.finished = true
      this.releaseRead(root, read)
    })
    if (changed) this.fillSlots()
    return read.wait
  }
  private releaseRead(root: string, read: ModeRead) {
    if (read.finished && read.settled && this.reads.get(root) === read) {
      this.reads.delete(root)
      this.fillSlots()
    }
  }
  private fillSlots() {
    for (const [root, slot] of this.queue) {
      if (this.reads.size >= MAX_MODE_READS) break
      if (this.reads.has(root)) continue
      this.queue.delete(root)
      const value = this.values.get(root)
      if (value) {
        this.values.delete(root)
        this.values.set(root, value)
      }
      slot.admit()
    }
  }
  enabled(root: string) {
    const value = this.values.get(root), refresh = this.refreshes.get(root)
    return value?.enabled === true && !(refresh?.before === value && performance.now() >= refresh.end)
  }
  forget(root: string) {
    this.values.delete(root)
    const read = this.reads.get(root)
    if (read) read.obsolete = true
    this.queue.get(root)?.cancel()
    this.queue.delete(root)
  }
  /** Each active root has one logical refresh budget including its wait for a
   * physical slot. Serviced roots move behind skipped roots on the next tick. */
  refresh(parent: AbortSignal, active: ReadonlySet<string>, changed: (root: string) => void) {
    for (const root of this.values.keys()) if (!active.has(root)) this.forget(root)
    if (parent.aborted) return
    for (const [root, before] of [...this.values]) {
      if (!active.has(root) || this.refreshes.has(root)) continue
      const end = performance.now() + MODE_READ_MS
      const wait = this.readMode(root, parent, changed).finally(() => this.refreshes.delete(root))
      this.refreshes.set(root, { before, end, wait })
    }
  }
  set(root: string, enabled: boolean): Promise<void> {
    this.values.set(root, { enabled })
    const saving = this.store.write(root, enabled)
    this.writes.set(root, saving)
    return saving.finally(() => { if (this.writes.get(root) === saving) this.writes.delete(root) })
  }
  deleted(id: string) { this.ancestry.deleted(id) }
  flush() { return this.store.flush() }
  /** Optional cross-terminal refresh work, outside critical mode-write drains. */
  async refreshSettled() {
    await Promise.allSettled([...this.refreshes.values()].map(refresh => refresh.wait))
    await Promise.allSettled([...this.reads.values()].map(read => read.physical))
  }
}
