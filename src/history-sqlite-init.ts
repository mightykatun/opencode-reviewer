import type { HistoryDatabase } from "./history-schema.js"

const pause = new Int32Array(new SharedArrayBuffer(4))

/** WAL negotiation can return BUSY without invoking SQLite's busy handler.
 * Retry only those connection-local, idempotent settings, sharing the original
 * 250 ms wait budget rather than resetting it for each competing initializer.
 * Runs in the history worker, never on the terminal's rendering thread. */
export function initializeHistoryPragmas(db: HistoryDatabase): void {
  const end = performance.now() + 250
  let busy: unknown = new Error("History initialization timed out")
  try {
    for (;;) {
      const remaining = Math.max(0, Math.floor(end - performance.now()))
      if (!remaining) throw busy
      try {
        db.exec(`PRAGMA busy_timeout=${remaining}; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256`)
        return
      } catch (error) {
        const value = error as { code?: unknown; errcode?: unknown } | null
        if (!value || (value.code !== "SQLITE_BUSY" && !(value.code === "ERR_SQLITE_ERROR"
          && typeof value.errcode === "number" && Number.isInteger(value.errcode) && value.errcode >= 0 && (value.errcode & 255) === 5))) throw error
        busy = error
        const left = end - performance.now()
        if (left <= 0) throw error
        Atomics.wait(pause, 0, 0, Math.min(5, left))
      }
    }
  } finally {
    // Subsequent transactions keep their existing SQLite wait policy.
    db.exec("PRAGMA busy_timeout=250")
  }
}
