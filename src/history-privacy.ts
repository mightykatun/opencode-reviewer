import type { HistoryDatabase } from "./history-schema.js"
import { legacyScrubSchema } from "./history-legacy-scrub.js"

/** legacy=true means complete legacy erasure is still unproven, even after freelist cleanup. */
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

/**
 * Explicit offline/embedding maintenance only, NEVER ordinary store/watchdog work.
 * Automatic cleanup scrubs the freelist, but old freeblocks inside live b-tree
 * pages can still contain plaintext. VACUUM rewrites those pages as well, with
 * database-size-dependent time/space and no claimed
 * three-second bound. Stop other clients first. An interrupted/failed run retains
 * the legacy flag; a later checkpoint must still remove old WAL frames. Backups,
 * filesystem snapshots and unallocated disk blocks are outside this policy.
 */
export function compactLegacyHistory(db: HistoryDatabase): void {
  db.exec("VACUUM")
  db.exec("UPDATE history_privacy SET legacy=0,generation=generation+1 WHERE id=1")
  // Explicit compaction can run between automatic reservation slices. Release any
  // zero-filled scratch records afterward rather than leaving them permanently.
  db.exec("UPDATE history_legacy_scrub SET phase=1 WHERE id=1 AND phase=0")
}
