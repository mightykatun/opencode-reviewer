import type { HistoryDatabase } from "./history-schema.js"

export interface HistoryCleanup { pending: boolean }

export const privacySchema = `
  CREATE TABLE history_privacy (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, cleaned INTEGER NOT NULL);
  INSERT INTO history_privacy VALUES (1,1,0);
  CREATE TRIGGER history_privacy_delete AFTER DELETE ON payloads BEGIN
    UPDATE history_privacy SET generation=generation+1 WHERE id=1; END;
  CREATE TRIGGER history_privacy_replace AFTER UPDATE OF body ON payloads BEGIN
    UPDATE history_privacy SET generation=generation+1 WHERE id=1; END;`

/**
 * One non-waiting checkpoint attempt, outside any transaction. The store owns
 * retries and worker termination. A busy reader is not success: deleted text may
 * remain in its WAL snapshot until it releases the read transaction. Never unlink
 * WAL/SHM manually. A crash before acknowledgement leaves durable retry work.
 */
export function cleanupHistory(db: HistoryDatabase): HistoryCleanup {
  const before = db.prepare("SELECT generation,cleaned FROM history_privacy WHERE id=1").get()
  if (before.generation === before.cleaned) return { pending: false }
  db.exec("PRAGMA busy_timeout=0")
  try {
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
    if (checkpoint.busy !== 0) return { pending: true }
    // A concurrent deletion between checkpoint and this write must remain dirty.
    db.prepare("UPDATE history_privacy SET cleaned=? WHERE id=1 AND generation=?").run(before.generation, before.generation)
    const after = db.prepare("SELECT generation,cleaned FROM history_privacy WHERE id=1").get()
    return { pending: after.generation !== after.cleaned }
  } finally { db.exec("PRAGMA busy_timeout=250") }
}
