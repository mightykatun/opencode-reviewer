import { open, realpath } from "node:fs/promises"
import { constants, type Dirent, type Stats } from "node:fs"
import path from "node:path"
import { DeadlineError, remainingTime, withDeadline } from "./deadline.js"

export interface FileIO {
  open: typeof open
  realpath: (filename: string) => Promise<string>
  /** Optional embedding seams for retrieval traversal; default to node:fs. */
  readdir?: (directory: string) => Promise<Dirent[]>
  lstat?: (filename: string) => Promise<Stats>
}
export interface FileTiming { totalMs: number; pathMs: number; captureMs: number; concurrency: number }
const defaults: FileTiming = { totalMs: 5000, pathMs: 500, captureMs: 1500, concurrency: 2 }

export class FileAccessError extends Error {}
export function fileFailure(error: unknown): string {
  if (error instanceof DeadlineError || error instanceof FileAccessError) return error.message
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "filesystem error"
}

/** Slots belong to underlying transactions, including their eventual cleanup. */
export class FileAccess {
  private active = 0
  constructor(readonly io: FileIO = { open, realpath: (name) => realpath(name) }, readonly timing: FileTiming = defaults) {}
  get outstanding() { return this.active }
  scope(signal: AbortSignal) { return new FileScope(this, signal) }

  async run<T>(parent: AbortSignal, ms: number, stage: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    parent.throwIfAborted()
    if (ms <= 0) throw new FileAccessError("File evidence time budget exhausted")
    if (this.active >= this.timing.concurrency) throw new FileAccessError("File evidence probes busy; outstanding I/O has not settled")
    this.active++
    let started = false
    try {
      return await withDeadline(parent, ms, (signal) => {
        started = true
        return Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) })
          .finally(() => { this.active-- })
      }, stage)
    } finally {
      if (!started) this.active--
    }
  }
}

export interface CanonicalPath { path: string | null; reason?: string }

/** The pinned Bun host normalizes `..` before realpath, unlike Node. Resolve each
 * preceding directory physically before taking its parent, within one owned
 * probe. Directory descriptors also reject file/.. instead of selecting a decoy.
 * This inspects paths only, never directory entries or file contents. */
export async function physicalPath(filename: string, io: FileIO, signal: AbortSignal): Promise<string> {
  let pending = filename
  for (let parents = 0;; parents++) {
    signal.throwIfAborted()
    const parent = /(^|\/)\.\.(?=\/|$)/.exec(pending)
    if (!parent) return io.realpath(pending)
    if (parents >= 256) throw new FileAccessError("File path parent traversal exceeds the 256-component limit")
    const prefix = pending.slice(0, parent.index) || (pending.startsWith("/") ? "/" : ".")
    const resolved = await io.realpath(prefix)
    signal.throwIfAborted()
    const handle = await io.open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_DIRECTORY)
    try {
      signal.throwIfAborted()
      const opened = await io.realpath(`/proc/self/fd/${handle.fd}`)
      signal.throwIfAborted()
      pending = `${path.dirname(opened)}/${pending.slice(parent.index + parent[0].length).replace(/^\//, "")}`
    } finally { await handle.close() }
  }
}

/** One shared optional-filesystem budget and path snapshot per permission. */
export class FileScope {
  private end: number | undefined
  private paths = new Map<string, Promise<CanonicalPath>>()
  constructor(readonly access: FileAccess, readonly signal: AbortSignal) {}
  private remaining() {
    const remaining = remainingTime(this.signal)
    this.end ??= performance.now() + Math.min(this.access.timing.totalMs, remaining / 3)
    return Math.max(0, Math.min(this.end - performance.now(), remaining))
  }
  private async probe<T>(ms: number, stage: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const remaining = this.remaining()
    try { return await this.access.run(this.signal, Math.min(remaining, ms), stage, operation) }
    catch (error) {
      // Timer delivery can differ slightly from the monotonic clock. Once the
      // stage's final allowance expired, never start another fractional probe.
      if (remaining <= ms && error instanceof DeadlineError) this.end = 0
      throw error
    }
  }
  canonical(filename: string): Promise<CanonicalPath> {
    this.signal.throwIfAborted()
    let value = this.paths.get(filename)
    if (!value) {
      value = this.probe(this.access.timing.pathMs, "File path lookup", async (signal) => {
        const resolved = await physicalPath(filename, this.access.io, signal)
        signal.throwIfAborted()
        return { path: resolved }
      }).catch((error): CanonicalPath => {
        this.signal.throwIfAborted()
        return { path: null, reason: fileFailure(error) }
      })
      this.paths.set(filename, value)
    }
    return value
  }
  capture<T>(operation: (signal: AbortSignal, io: FileIO) => Promise<T>): Promise<T> {
    return this.probe(this.access.timing.captureMs, "File capture",
      (signal) => operation(signal, this.access.io))
  }
}

export const fileAccess = new FileAccess()
