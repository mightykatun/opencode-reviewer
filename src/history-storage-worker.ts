import { parentPort } from "node:worker_threads"
import { HistorySQL } from "./history-schema.js"
import type { HistoryDatabase } from "./history-schema.js"
import { HistoryInvalid } from "./history-records.js"
import { privateDatabase } from "./history-private-path.js"
export { privateDatabase } from "./history-private-path.js"

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
        if (message.type === "apply") value = sql.applyReady(message.writer, message.sequence, message.event)
        else if (message.type === "query") value = sql.queryReady(message.query)
        else if (message.type === "bootstrap") value = sql.bootstrap(message.root)
        else if (message.type === "cleanup") value = sql.cleanup()
        else throw new HistoryInvalid("Invalid history worker operation")
      }
      parentPort!.postMessage({ id: message.id, value })
    } catch (error) {
      // Fixed diagnostics only. Never reflect database contents/report text.
      parentPort!.postMessage({ id: message.id, error: error instanceof HistoryInvalid ? "invalid" : "storage" })
    }
  })
}
