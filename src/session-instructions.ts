import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { withDeadline } from "./deadline.js"
import { privateRecordDirectory, readPrivateRecord, syncPrivateDirectory, validPrivateRecord, writePrivateRecord } from "./private-record.js"

const MAX_BYTES = 16 * 1024 * 1024
const MAX_READS = 2
const MAX_WAITERS = 8
const MAX_WRITES = 8
// Base64 bounds the physical record independently of JSON string escaping.
const recordLimit = (bytes: number) => 4 * Math.ceil(bytes / 3) + 128

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

  /** Reviews treat any failure as absent optional guidance. The editor passes
   * strict, so only a missing record reads as empty and failures stay visible. */
  async read(root: string, maxBytes: number, parent: AbortSignal, strict = false): Promise<string> {
    parent.throwIfAborted()
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
      || this.waiting >= MAX_WAITERS) {
      if (strict) throw new Error("Session instructions unavailable")
      return ""
    }
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
    } catch (error) {
      parent.throwIfAborted()
      if (strict) throw error
      return ""
    } finally {
      if (!started) releaseAdmission()
    }
  }

  private async readRecord(root: string, maxBytes: number, signal: AbortSignal): Promise<string> {
    if (!await privateRecordDirectory(this.directory, false, "instructions", signal)) { signal.throwIfAborted(); return "" }
    signal.throwIfAborted()
    const file = await open(this.file(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (!file) { signal.throwIfAborted(); return "" }
    const invalid = () => { throw new Error("Invalid session instructions record") }
    try {
      signal.throwIfAborted()
      const limit = recordLimit(maxBytes)
      const stat = await file.stat()
      signal.throwIfAborted()
      if (!validPrivateRecord(stat, limit)) invalid()
      const buffer = await readPrivateRecord(file, Math.min(limit, stat.size) + 1, signal)
      if (buffer.length !== stat.size || !validPrivateRecord(await file.stat(), limit)) invalid()
      signal.throwIfAborted()
      const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
      const value = JSON.parse(source)
      if (!value || Array.isArray(value) || Object.keys(value).length !== 3 || value.version !== 1
        || !Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > maxBytes || typeof value.data !== "string"
        || value.data.length !== 4 * Math.ceil(value.bytes / 3)) invalid()
      const bytes = Buffer.from(value.data, "base64")
      if (bytes.length !== value.bytes || bytes.toString("base64") !== value.data
        || JSON.stringify({ version: 1, bytes: value.bytes, data: value.data }) !== source) invalid()
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
      await privateRecordDirectory(this.directory, true, "instructions")
      try {
        if (!validPrivateRecord(await lstat(file), recordLimit(MAX_BYTES))) throw new Error("Invalid session instructions record")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const bytes = Buffer.from(value, "utf8")
      await writePrivateRecord(file, JSON.stringify({ version: 1, bytes: bytes.length, data: bytes.toString("base64") }))
      // Rename is the commit. A durability/cleanup failure afterward must not
      // tell the editor that the previous committed instructions remain active.
      try { await syncPrivateDirectory(this.directory) }
      catch { /* The committed value is already visible to other terminals. */ }
    }).finally(() => { this.writes-- })
    return this.pending
  }

  async flush(): Promise<void> {
    const writes = this.pending
    await Promise.allSettled([...this.transactions])
    await writes
  }
}
