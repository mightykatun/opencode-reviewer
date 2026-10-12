import { constants } from "node:fs"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { reviewStage, withDeadline } from "./deadline.js"

type Session = { id: string; parentID?: string }
const MAX_MODE_READS = 2
const MAX_ANCESTRY_READS = 2
/** Caller completion is deadline bounded. settled owns the actual metadata
 * traversal through cleanup; forwarding functions must preserve this handle. */
export type AncestryRead = Promise<string> & { settled?: Promise<void> }
export type AncestryReader = (session: string, signal: AbortSignal) => AncestryRead
interface Ancestry { root: string; visited: Set<string>; edges: number }
interface ModeRead {
  wait?: Promise<void>
  settled: boolean
  finished: boolean
}
export interface SessionModeGate {
  root(sessionID: string, signal: AbortSignal): AncestryRead
  load(root: string, signal: AbortSignal): Promise<void>
  enabled(root: string): boolean
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
    if (!path.isAbsolute(directory)) throw new Error("Session mode directory must be absolute")
  }
  private file(root: string) {
    const key = createHash("sha256").update(JSON.stringify([this.host, root])).digest("hex")
    return path.join(this.directory, `${key}.json`)
  }
  async read(root: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const file = await open(this.file(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (!file) { signal.throwIfAborted(); return true }
    try {
      signal.throwIfAborted()
      const stat = await file.stat()
      signal.throwIfAborted()
      if (!stat.isFile() || stat.size > 1024) throw new Error("Invalid session mode record")
      const buffer = Buffer.alloc(1025)
      let size = 0
      while (size < buffer.length) {
        signal.throwIfAborted()
        const result = await file.read(buffer, size, buffer.length - size, size)
        signal.throwIfAborted()
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      signal.throwIfAborted()
      if (size > 1024) throw new Error("Invalid session mode record")
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)))
      if (!value || Array.isArray(value) || Object.keys(value).length !== 2 || value.version !== 1 || typeof value.enabled !== "boolean") {
        throw new Error("Invalid session mode record")
      }
      return value.enabled
    } finally { await file.close() }
  }
  write(root: string, enabled: boolean): Promise<void> {
    const file = this.file(root)
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile(JSON.stringify({ version: 1, enabled })); await handle.sync() }
        finally { await handle.close() }
        await rename(temporary, file)
        const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY)
        try { await directory.sync() } finally { await directory.close() }
      } finally { await unlink(temporary).catch(() => {}) }
    })
    return this.pending
  }
  flush() { return this.pending }
}

/** Only metadata needed to establish ownership is read before this gate opens. */
export class SessionModes implements SessionModeGate {
  private roots = new Map<string, { root: string; edges: number }>()
  private values = new Map<string, boolean>()
  private changes = new Map<string, number>()
  private reads = new Map<string, ModeRead>()
  private ancestry = new Map<string, AncestryRead>()
  private ancestryRevision = 0
  constructor(private store: ModeStore, private session: (id: string, signal: AbortSignal) => Promise<Session | undefined>) {}
  private remember(visited: ReadonlySet<string>, root: string, edges: number) {
    if (this.roots.size + visited.size > 4096) this.roots.clear()
    for (const child of visited) this.roots.set(child, { root, edges: edges-- })
    return root
  }
  root(sessionID: string, parent: AbortSignal): AncestryRead {
    if (parent.aborted) return Promise.reject(parent.reason)
    const cached = this.roots.get(sessionID)
    if (cached) return withDeadline(parent, 5000, async () => {
      if (this.roots.get(sessionID) !== cached) throw new Error("Session ancestry changed")
      return cached.root
    }, "Session mode ancestry")
    const pending = this.ancestry.get(sessionID)
    if (pending) {
      // A joiner's cancellation only ends its own wait, never the owner's read.
      return Object.assign(withDeadline(parent, 5000, () => pending, "Session mode ancestry"), { settled: pending.settled })
    }
    if (this.ancestry.size >= MAX_ANCESTRY_READS) return Promise.reject(new Error("Session ancestry read capacity unavailable"))
    const revision = this.ancestryRevision
    let worker: Promise<Ancestry> | undefined
    let finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    const release = () => {
      if (this.ancestry.get(sessionID) === read) this.ancestry.delete(sessionID)
      finish()
    }
    const read: AncestryRead = withDeadline(parent, 5000, signal => {
      worker = this.resolveRoot(sessionID, signal, revision)
      void worker.then(release, release)
      return worker
    }, "Session mode ancestry").then(value => {
      reviewStage(parent, "Session mode ancestry")
      if (revision !== this.ancestryRevision) throw new Error("Session ancestry changed")
      return this.remember(value.visited, value.root, value.edges)
    })
    this.ancestry.set(sessionID, read)
    read.settled = settled
    const undispatched = () => { if (!worker) release() }
    void read.then(undispatched, undispatched)
    return read
  }
  private async resolveRoot(sessionID: string, signal: AbortSignal, revision: number): Promise<Ancestry> {
    const current = () => {
      reviewStage(signal, "Session mode ancestry")
      if (revision !== this.ancestryRevision) throw new Error("Session ancestry changed")
    }
    const visited = new Set<string>()
    let id = sessionID
    for (let depth = 0; depth <= 16; depth++) {
      current()
      if (!id || visited.has(id)) throw new Error("Session ancestry unavailable")
      const cached = this.roots.get(id)
      if (cached) {
        // A cached suffix saves metadata reads, not parent edges in the limit.
        if (depth + cached.edges > 16) throw new Error("Session ancestry limit reached")
        return { visited, root: cached.root, edges: depth + cached.edges }
      }
      visited.add(id)
      const value = await this.session(id, signal)
      current()
      if (value?.id !== id || (value.parentID !== undefined && (typeof value.parentID !== "string" || !value.parentID))) {
        throw new Error("Session ancestry unavailable")
      }
      if (!value.parentID) return { visited, root: id, edges: depth }
      id = value.parentID
    }
    throw new Error("Session ancestry limit reached")
  }
  async load(root: string, parent: AbortSignal) {
    parent.throwIfAborted()
    if (this.values.has(root)) return
    const pending = this.reads.get(root)
    if (pending) return withDeadline(parent, 5000, () => pending.wait!, "Session mode loading")
    if (this.reads.size >= MAX_MODE_READS) throw new Error("Session mode read capacity unavailable")
    const read: ModeRead = { settled: true, finished: false }
    this.reads.set(root, read)
    // Reserve before dispatch. Concurrent callers share this bounded wait, while
    // expired reads continue owning the root and instance slot through cleanup.
    return read.wait = this.loadMode(root, parent, read)
  }
  private async loadMode(root: string, parent: AbortSignal, read: ModeRead) {
    const revision = this.changes.get(root)
    try {
      const value = await withDeadline(parent, 5000, (signal) => {
        read.settled = false
        const worker = Promise.resolve().then(() => { signal.throwIfAborted(); return this.store.read(root, signal) })
        const settled = () => { read.settled = true; this.releaseRead(root, read) }
        void worker.then(settled, settled)
        return worker
      }, "Session mode loading")
      parent.throwIfAborted()
      // Only a successfully bounded read can populate mode state. Actual late
      // settlement releases capacity but never publishes values or overrides a switch.
      if (this.changes.get(root) === revision) this.values.set(root, value)
    } finally {
      read.finished = true
      this.releaseRead(root, read)
    }
  }
  private releaseRead(root: string, read: ModeRead) {
    if (read.finished && read.settled && this.reads.get(root) === read) this.reads.delete(root)
  }
  enabled(root: string) { return this.values.get(root) === true }
  set(root: string, enabled: boolean): Promise<void> {
    this.changes.set(root, (this.changes.get(root) ?? 0) + 1)
    this.values.set(root, enabled)
    return this.store.write(root, enabled)
  }
  deleted(_id: string) {
    this.ancestryRevision++
    // Cached distances do not retain every intermediate edge. An intermediate
    // deletion therefore invalidates all bounded suffixes, not just root matches.
    this.roots.clear()
  }
  flush() { return this.store.flush() }
}
