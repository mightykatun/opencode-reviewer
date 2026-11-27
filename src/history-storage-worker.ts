import { parentPort } from "node:worker_threads"
import { HistorySQL } from "./history-schema.js"
import type { HistoryDatabase } from "./history-schema.js"
import { HISTORY_DATABASE_FILE, HistoryInvalid } from "./history-records.js"
import { privateDatabase as validateDatabase } from "./history-private-path.js"
import { sqliteBusy } from "./history-sqlite-init.js"
export const privateDatabase = (file: string, create = true) => validateDatabase(file, create, [HISTORY_DATABASE_FILE])

export function openHistoryDatabase(file: string, adapter: "node" | "bun", construct?: (file: string) => HistoryDatabase): HistorySQL {
  privateDatabase(file)
  // esbuild retains these public runtime imports in the deterministic CJS worker.
  const db: HistoryDatabase = construct ? construct(file) : adapter === "bun"
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
        value = { environmentKeys: Object.keys(process.env).length, cleanup: true }
      } else if (message.type === "close") { sql?.close(); sql = undefined }
      else {
        if (!sql) throw new Error("History worker not open")
        if (message.type === "apply") value = sql.apply(message.writer, message.sequence, message.event)
        else if (message.type === "query") value = sql.query(message.query)
        else if (message.type === "cleanup") value = sql.cleanup()
        else throw new HistoryInvalid("Invalid history worker operation")
      }
      parentPort!.postMessage({ id: message.id, value })
    } catch (error) {
      // Fixed diagnostics only. Never reflect database contents/report text.
      parentPort!.postMessage({ id: message.id, error: message.type === "open" ? sqliteBusy(error) ? "busy" : "initialization"
        : error instanceof HistoryInvalid ? "invalid" : "storage" })
    }
  })
}
