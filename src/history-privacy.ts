import type { HistoryDatabase } from "./history-schema.js"
import { legacyScrubSchema } from "./history-legacy-scrub.js"
import { legacyRebuildSchema } from "./history-legacy-rebuild.js"

/** legacy=true until both legacy freelist and live b-tree cleanup have committed. */
export interface HistoryCleanup { pending: boolean; legacy: boolean; deleting?: true; scrubbing?: true }

/** Called inside schema initialization's transaction, after secure_delete=ON. */
export function privacySchema(db: HistoryDatabase, existing: boolean) {
  db.exec(`CREATE TABLE IF NOT EXISTS history_privacy (
    id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, cleaned INTEGER NOT NULL,
    legacy INTEGER NOT NULL CHECK(legacy IN (0,1)));
    CREATE TABLE IF NOT EXISTS history_deletions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, root TEXT NOT NULL, session TEXT NOT NULL);
    INSERT OR IGNORE INTO history_privacy VALUES (1,1,0,${Number(existing)});
    CREATE TRIGGER IF NOT EXISTS history_privacy_delete AFTER DELETE ON payloads BEGIN
      UPDATE history_privacy SET generation=generation+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS history_privacy_replace AFTER UPDATE OF body ON payloads BEGIN
      UPDATE history_privacy SET generation=generation+1 WHERE id=1; END;`)
  db.exec(legacyScrubSchema)
  db.exec(legacyRebuildSchema)
}

/**
 * One non-waiting checkpoint attempt, outside any transaction. The store owns
 * retries and worker termination. A busy reader is not success: deleted text may
 * remain in its WAL snapshot until it releases the read transaction. Never unlink
 * WAL/SHM manually. A crash before acknowledgement leaves durable retry work.
 */
export function cleanupHistory(db: HistoryDatabase): HistoryCleanup {
  const before = db.prepare("SELECT generation,cleaned,legacy FROM history_privacy WHERE id=1").get()
  if (before.generation === before.cleaned) return { pending: false, legacy: !!before.legacy }
  db.exec("PRAGMA busy_timeout=0")
  try {
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
    if (checkpoint.busy !== 0) return { pending: true, legacy: !!before.legacy }
    // A concurrent deletion between checkpoint and this write must remain dirty.
    db.prepare("UPDATE history_privacy SET cleaned=? WHERE id=1 AND generation=?").run(before.generation, before.generation)
    const after = db.prepare("SELECT generation,cleaned,legacy FROM history_privacy WHERE id=1").get()
    return { pending: after.generation !== after.cleaned, legacy: !!after.legacy }
  } finally { db.exec("PRAGMA busy_timeout=250") }
}
