import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { withDeadline } from "./deadline.js"
import type { SessionAncestry, AncestryRead } from "./session-ancestry.js"

const MAX_MODE_READS = 2
interface ModeRead {
  wait?: Promise<void>
  settled: boolean
  finished: boolean
}

/** Cross-UID namespace protection, without changing existing permissions or paths.
 * A private user-owned ancestor protects writable descendants from other users.
 * Before that boundary, only trusted owners and sticky-directory protection suffice.
 * Same-UID code and root remain outside this boundary, as for history storage. */
async function privateModeDirectory(directory: string, create: boolean, signal?: AbortSignal): Promise<boolean> {
  const uid = process.geteuid?.()
  if (process.platform !== "linux" || uid === undefined) throw new Error("Session mode ownership unavailable")
  let current = "/", protectedAncestor = false
  for (const part of ["", ...directory.split("/").filter(Boolean)]) {
    signal?.throwIfAborted()
    if (part) current = path.join(current, part)
    let stat
    try { stat = await lstat(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (!create) return false // Every existing prefix has already been validated.
      signal?.throwIfAborted()
      try { await mkdir(current, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      stat = await lstat(current)
    }
    signal?.throwIfAborted()
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)
      || (!protectedAncestor && (stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error("Untrusted session mode ancestor")
    if (current === directory && (stat.uid !== uid || (stat.mode & 0o077))) throw new Error("Session mode directory must be private")
    protectedAncestor ||= stat.uid === uid && !(stat.mode & 0o077)
  }
  return true
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
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes("\0")) throw new Error("Session mode directory must be absolute and normalized")
  }
  private file(root: string) {
    const key = createHash("sha256").update(JSON.stringify([this.host, root])).digest("hex")
    return path.join(this.directory, `${key}.json`)
  }
  async read(root: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (!await privateModeDirectory(this.directory, false, signal)) { signal.throwIfAborted(); return true }
    const file = await open(this.file(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (!file) { signal.throwIfAborted(); return true }
    try {
      signal.throwIfAborted()
      const stat = await file.stat()
      signal.throwIfAborted()
      if (!stat.isFile() || stat.size > 1024 || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error("Invalid session mode record")
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
      await privateModeDirectory(this.directory, true)
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile(JSON.stringify({ version: 1, enabled })); await handle.sync() }
        finally { await handle.close() }
        await rename(temporary, file)
        const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
      } finally { await unlink(temporary).catch(() => {}) }
    })
    return this.pending
  }
  flush() { return this.pending }
}

/** Only metadata needed to establish ownership is read before this gate opens. */
export class SessionModes implements SessionModeGate {
  private values = new Map<string, boolean>()
  private changes = new Map<string, number>()
  private reads = new Map<string, ModeRead>()
  constructor(private store: ModeStore, private ancestry: SessionAncestry) {}
  root(sessionID: string, signal: AbortSignal): AncestryRead { return this.ancestry.root(sessionID, signal) }
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
  deleted(id: string) { this.ancestry.deleted(id) }
  flush() { return this.store.flush() }
}
