import { HistoryInvalid } from "./history-records.js"
import type { HistoryDatabase } from "./history-schema.js"

export const HISTORY_SCRUB_STEPS = 8
export const HISTORY_SCRUB_BYTES = 64 * 1024
export const HISTORY_SCRUB_MS = 40

export const legacyScrubSchema = `
  CREATE TABLE IF NOT EXISTS history_legacy_scrub (id INTEGER PRIMARY KEY CHECK(id=1), phase INTEGER NOT NULL CHECK(phase IN (0,1,2)));
  CREATE TABLE IF NOT EXISTS history_legacy_padding (id INTEGER PRIMARY KEY, value BLOB NOT NULL);
  INSERT OR IGNORE INTO history_legacy_scrub SELECT 1,0 FROM history_privacy WHERE id=1 AND legacy=1;`

/**
 * In an owned write transaction with secure_delete=ON, consume the freelist using
 * zero-filled SQLite records. Keep ALL reservations until freelist_count reaches
 * zero; allocating/deleting each blob immediately would repeatedly scrub the same
 * clean pages. Then securely delete reservations in bounded slices. SQLite owns
 * page allocation, WAL, locks and recovery; never write database bytes ourselves.
 * Committed phase/rows survive process death, and multiple current writers share
 * the same progress. A checkpoint is still required after releasing reservations.
 *
 * This is only FREELIST sanitization. history-legacy-rebuild follows it to erase
 * old freeblocks in still-live pages and indexes before clearing the legacy flag.
 */
export function scrubLegacyFreelist(db: HistoryDatabase): boolean {
  const state = db.prepare("SELECT phase FROM history_legacy_scrub WHERE id=1").get()
  if (!state || state.phase === 2) return false
  if (state.phase !== 0 && state.phase !== 1) throw new HistoryInvalid("Invalid history scrub phase")
  const free = db.prepare("PRAGMA freelist_count")
  const reserve = db.prepare("INSERT INTO history_legacy_padding(value) VALUES (zeroblob(?))")
  const first = db.prepare("SELECT id FROM history_legacy_padding ORDER BY id LIMIT 1")
  const release = db.prepare("DELETE FROM history_legacy_padding WHERE id=?")
  const phase = db.prepare("UPDATE history_legacy_scrub SET phase=? WHERE id=1")
  const end = performance.now() + HISTORY_SCRUB_MS
  for (let step = 0; step < HISTORY_SCRUB_STEPS; step++) {
    if (state.phase === 0) {
      const before = free.get().freelist_count
      if (!Number.isSafeInteger(before) || before < 0) throw new HistoryInvalid("Invalid history freelist")
      if (before === 0) { phase.run(1); break }
      reserve.run(HISTORY_SCRUB_BYTES)
      if (free.get().freelist_count >= before) throw new HistoryInvalid("History scrub made no progress")
    } else {
      const row = first.get()
      if (!row) { phase.run(2); break }
      release.run(row.id)
    }
    if (performance.now() >= end) break
  }
  db.exec("UPDATE history_privacy SET generation=generation+1 WHERE id=1")
  return true
}
