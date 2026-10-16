import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs"
import path from "node:path"
import { HistoryInvalid } from "./history-records.js"

/**
 * Pathname SQLite (including its sidecars) needs a nonreplaceable namespace, not
 * just O_NOFOLLOW on the database. Trust root and our effective UID only. A
 * different UID must not own or be able to rename any component. A root-owned
 * sticky /tmp is allowed: each child is also owned by a trusted UID, so sticky
 * unlink/rename protection applies. POSIX ACL write grants appear in the group
 * mode mask and are rejected as well.
 *
 * This is a cross-UID boundary on the supported local Linux filesystem. Root,
 * same-UID code, mount-namespace administrators and filesystems that do not enforce
 * these Unix permissions are outside it. Public SQLite adapters cannot anchor all
 * later sidecar opens against a malicious same-UID rename. Rechecking after their
 * constructor would not repair that boundary. Never chmod an existing object.
 * Inspect existing files with lstat in this trusted namespace: opening/closing
 * them can release SQLite's process-wide POSIX locks, even from another worker.
 */
export function privateDatabase(file: string, create = true): boolean {
  const uid = process.geteuid?.()
  if (process.platform !== "linux" || uid === undefined || !path.isAbsolute(file)
    || path.normalize(file) !== file || path.basename(file) !== "history-v1.sqlite") throw new HistoryInvalid("Invalid history path")
  const directory = path.dirname(file)
  let current = "/"
  for (const part of ["", ...directory.split("/").filter(Boolean)]) {
    if (part) current = path.join(current, part)
    let stat
    try { stat = lstatSync(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // Selection probes validate only existing components and never initialize
      // a database, directory or sidecar in a candidate namespace.
      if (!create) return false
      // The parent was already proven trusted. Do not recursively follow an
      // unchecked existing prefix. Concurrent creation by another host is fine.
      try { mkdirSync(current, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      stat = lstatSync(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)
      || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new HistoryInvalid("Untrusted history ancestor")
    if (current === directory && (stat.uid !== uid || (stat.mode & 0o077))) throw new HistoryInvalid("History directory must be private")
  }
  let exists = false
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const name = file + suffix
    let stat
    try { stat = lstatSync(name) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (suffix) continue
      if (!create) continue
      try { closeSync(openSync(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      stat = lstatSync(name)
    }
    // A sidecar removed by a concurrent SQLite commit is already handled by
    // ENOENT above. Never inspect an opened, now-unlinked journal inode instead.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077)) throw new HistoryInvalid("History file must be private")
    if (!suffix) exists = true
  }
  return exists
}
