import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { withDeadline } from "./deadline.js"

const MAX_BYTES = 16 * 1024 * 1024
const MAX_READS = 2
const MAX_WAITERS = 8
const MAX_WRITES = 8
// Base64 bounds the physical record independently of JSON string escaping.
const recordLimit = (bytes: number) => 4 * Math.ceil(bytes / 3) + 128

/** Same ownership boundary as session modes: root/same-UID code is trusted,
 * but symlinks and replaceable cross-UID namespaces are never followed. */
async function privateDirectory(directory: string, create: boolean, signal?: AbortSignal): Promise<boolean> {
  const uid = process.geteuid?.()
  if (process.platform !== "linux" || uid === undefined) throw new Error("Session instructions ownership unavailable")
  let current = "/", protectedAncestor = false
  for (const part of ["", ...directory.split("/").filter(Boolean)]) {
    signal?.throwIfAborted()
    if (part) current = path.join(current, part)
    let stat
    try { stat = await lstat(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (!create) return false
      signal?.throwIfAborted()
      try { await mkdir(current, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      stat = await lstat(current)
    }
    signal?.throwIfAborted()
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)
      || (!protectedAncestor && (stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error("Untrusted session instructions ancestor")
    if (current === directory && (stat.uid !== uid || (stat.mode & 0o077))) throw new Error("Session instructions directory must be private")
    protectedAncestor ||= stat.uid === uid && !(stat.mode & 0o077)
  }
  return true
}

function validRecord(stat: Stats, limit: number): boolean {
  return stat.isFile() && stat.uid === process.geteuid?.() && stat.nlink === 1
    && !(stat.mode & 0o077) && stat.size <= limit
}

/** Local optional guidance, not operation evidence. Independent atomic records
 * let terminals share committed values without clobbering other conversations.
 * Only the root ID enters the key, so moving a session does not reset its text. */
export class SessionInstructionsStore {
  private pending = Promise.resolve()
  private reads = new Map<string, Promise<void>>()
  private waiting = 0
  private writes = 0
  private transactions = new Set<Promise<void>>()

  constructor(private directory: string) {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes("\0")
      || directory.length > 4096 || directory.split("/").filter(Boolean).length > 256) {
      throw new Error("Session instructions directory must be absolute, normalized and bounded")
    }
  }

  private file(root: string) {
    const key = createHash("sha256").update(root).digest("hex")
    return path.join(this.directory, `${key}.json`)
  }

  async read(root: string, maxBytes: number, parent: AbortSignal): Promise<string> {
    parent.throwIfAborted()
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
      || this.waiting >= MAX_WAITERS) return ""
    this.waiting++
    let complete!: () => void
    const transaction = new Promise<void>(resolve => { complete = resolve })
    this.transactions.add(transaction)
    const releaseAdmission = () => { this.waiting--; this.transactions.delete(transaction); complete() }
    // Wait for bounded capacity, then read afresh. Sharing an earlier snapshot
    // could miss a save made between two reviews of the same conversation.
    let started = false
    try {
      const value = await withDeadline(parent, 5000, async (signal) => {
        started = true
        try {
          while (this.reads.has(root) || this.reads.size >= MAX_READS) {
            await Promise.race([...this.reads.values()])
            signal.throwIfAborted()
          }
          signal.throwIfAborted()
          let settled!: () => void
          const reservation = new Promise<void>(resolve => { settled = resolve })
          this.reads.set(root, reservation)
          try { return await this.readRecord(root, maxBytes, signal) }
          finally { this.reads.delete(root); settled() }
        } finally { releaseAdmission() }
      }, "Session instructions loading")
      parent.throwIfAborted()
      return value
    } catch {
      parent.throwIfAborted()
      return ""
    } finally {
      if (!started) releaseAdmission()
    }
  }

  private async readRecord(root: string, maxBytes: number, signal: AbortSignal): Promise<string> {
    if (!await privateDirectory(this.directory, false, signal)) { signal.throwIfAborted(); return "" }
    signal.throwIfAborted()
    const file = await open(this.file(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      signal.throwIfAborted()
      const limit = recordLimit(maxBytes)
      const stat = await file.stat()
      signal.throwIfAborted()
      if (!validRecord(stat, limit)) return ""
      const buffer = Buffer.alloc(Math.min(limit, stat.size) + 1)
      let size = 0
      while (size < buffer.length) {
        signal.throwIfAborted()
        const result = await file.read(buffer, size, buffer.length - size, size)
        signal.throwIfAborted()
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      if (size !== stat.size || !validRecord(await file.stat(), limit)) return ""
      signal.throwIfAborted()
      const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))
      const value = JSON.parse(source)
      if (!value || Array.isArray(value) || Object.keys(value).length !== 3 || value.version !== 1
        || !Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > maxBytes || typeof value.data !== "string"
        || value.data.length !== 4 * Math.ceil(value.bytes / 3)) return ""
      const bytes = Buffer.from(value.data, "base64")
      if (bytes.length !== value.bytes || bytes.toString("base64") !== value.data
        || JSON.stringify({ version: 1, bytes: value.bytes, data: value.data }) !== source) return ""
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()
      signal.throwIfAborted()
      return text
    } finally { await file.close() }
  }

  write(root: string, text: string): Promise<void> {
    if (this.writes >= MAX_WRITES) return Promise.reject(new Error("Session instructions save capacity unavailable"))
    const value = text.trim()
    // Check code units before allocating an encoded copy of oversized input.
    if (value.length > MAX_BYTES || Buffer.byteLength(value, "utf8") > MAX_BYTES) {
      return Promise.reject(new Error("Session instructions exceed maximum UTF-8 bytes"))
    }
    const file = this.file(root)
    this.writes++
    this.pending = this.pending.catch(() => {}).then(async () => {
      await privateDirectory(this.directory, true)
      try {
        if (!validRecord(await lstat(file), recordLimit(MAX_BYTES))) throw new Error("Invalid session instructions record")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          const bytes = Buffer.from(value, "utf8")
          await handle.writeFile(JSON.stringify({ version: 1, bytes: bytes.length, data: bytes.toString("base64") }))
          await handle.sync()
        } finally { await handle.close() }
        await rename(temporary, file)
        // Rename is the commit. A durability/cleanup failure afterward must not
        // tell the editor that the previous committed instructions remain active.
        try {
          const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { await directory.sync() } finally { await directory.close() }
        } catch { /* The committed value is already visible to other terminals. */ }
      } finally { await unlink(temporary).catch(() => {}) }
    }).finally(() => { this.writes-- })
    return this.pending
  }

  async flush(): Promise<void> {
    const writes = this.pending
    await Promise.allSettled([...this.transactions])
    await writes
  }
}
