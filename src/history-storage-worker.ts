import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { HistorySQL } from "./history-schema.js"
import type { HistoryDatabase } from "./history-schema.js"
import { HistoryInvalid } from "./history-records.js"

/** Reject unsafe existing objects rather than chmod/follow another owner's files. */
export function privateDatabase(file: string): void {
  if (!path.isAbsolute(file) || path.basename(file) !== "history-v1.sqlite") throw new HistoryInvalid("Invalid history path")
  const directory = path.dirname(file)
  // Check the existing prefix before recursive mkdir can follow it and mutate a target.
  let prefix = directory
  for (;;) {
    try {
      if (realpathSync(prefix) !== prefix || !lstatSync(prefix).isDirectory()) throw new HistoryInvalid("Invalid history directory path")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      prefix = path.dirname(prefix)
    }
  }
  mkdirSync(directory, { mode: 0o700, recursive: true })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory
    || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new HistoryInvalid("History directory must be private")
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const name = file + suffix
    let fd: number
    try { fd = openSync(name, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (suffix) continue
      try { fd = openSync(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        fd = openSync(name, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      }
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new HistoryInvalid("History file must be private")
      fchmodSync(fd, 0o600)
    } finally { closeSync(fd) }
  }
}

export function openHistoryDatabase(file: string, adapter: "node" | "bun"): HistorySQL {
  privateDatabase(file)
  // esbuild retains these public runtime imports in the deterministic CJS worker.
  const db: HistoryDatabase = adapter === "bun"
    ? new (require("bun:sqlite").Database)(file)
    : new (require("node:sqlite").DatabaseSync)(file)
  try { return new HistorySQL(db) } catch (error) { db.close(); throw error }
}

if (parentPort) {
  let sql: HistorySQL | undefined
  parentPort.on("message", (message) => {
    try {
      let value: unknown
      if (message.type === "open") {
        if (sql) throw new HistoryInvalid("History worker already open")
        sql = openHistoryDatabase(message.file, message.adapter)
        value = { environmentKeys: Object.keys(process.env).length }
      } else if (message.type === "close") { sql?.close(); sql = undefined }
      else {
        if (!sql) throw new Error("History worker not open")
        if (message.type === "apply") value = sql.applyReady(message.writer, message.sequence, message.event)
        else if (message.type === "query") value = sql.queryReady(message.query)
        else if (message.type === "bootstrap") value = sql.bootstrap(message.root)
        else throw new HistoryInvalid("Invalid history worker operation")
      }
      parentPort!.postMessage({ id: message.id, value })
    } catch (error) {
      // Fixed diagnostics only. Never reflect database contents/report text.
      parentPort!.postMessage({ id: message.id, error: error instanceof HistoryInvalid ? "invalid" : "storage" })
    }
  })
}
