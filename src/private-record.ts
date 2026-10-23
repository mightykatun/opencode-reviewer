import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

/** Cross-UID protection for mode/instruction records, not SQLite paths. A private
 * user-owned ancestor protects writable descendants. Before that boundary only
 * trusted owners and sticky directories suffice. Same-UID code/root is trusted. */
export async function privateRecordDirectory(directory: string, create: boolean, kind: "mode" | "instructions", signal?: AbortSignal): Promise<boolean> {
  const uid = process.geteuid?.()
  if (process.platform !== "linux" || uid === undefined) throw new Error(`Session ${kind} ownership unavailable`)
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
      || (!protectedAncestor && (stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error(`Untrusted session ${kind} ancestor`)
    if (current === directory && (stat.uid !== uid || (stat.mode & 0o077))) throw new Error(`Session ${kind} directory must be private`)
    protectedAncestor ||= stat.uid === uid && !(stat.mode & 0o077)
  }
  return true
}

export function validPrivateRecord(stat: Stats, limit: number): boolean {
  return stat.isFile() && stat.uid === process.geteuid?.() && stat.nlink === 1
    && !(stat.mode & 0o077) && stat.size <= limit
}

/** The caller owns metadata validation and descriptor cleanup through settlement. */
export async function readPrivateRecord(file: FileHandle, capacity: number, signal: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.alloc(capacity)
  let size = 0
  while (size < buffer.length) {
    signal.throwIfAborted()
    const result = await file.read(buffer, size, buffer.length - size, size)
    signal.throwIfAborted()
    if (!result.bytesRead) break
    size += result.bytesRead
  }
  return buffer.subarray(0, size)
}

/** Rename commits a complete record. Callers decide how to report a subsequent
 * directory sync failure, independently of this precommit write transaction. */
export async function writePrivateRecord(file: string, source: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(source); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => {}) }
}

export async function syncPrivateDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
