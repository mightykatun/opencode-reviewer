import type { HistoryDatabase } from "./history-schema.js"

/** Fixed attribution for records made before version capture. Never advance on release. */
export const legacyReviewerVersion = "2.7.0"

/** The caller owns BEGIN IMMEDIATE. Keep old table/JSON shapes so already-running
 * older workers can still read and write during an upgrade. The insert trigger
 * also labels their later records. Only first admission may replace that default
 * with versions captured by the generating runtime.
 */
export function initializeHistoryVersions(db: HistoryDatabase) {
  const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='review_versions'").get()
  db.exec(`CREATE TABLE IF NOT EXISTS review_versions (
    review TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE ON UPDATE CASCADE,
    reviewer_version TEXT NOT NULL DEFAULT '${legacyReviewerVersion}', opencode_version TEXT);
    CREATE TRIGGER IF NOT EXISTS review_versions_insert AFTER INSERT ON reviews BEGIN
      INSERT OR IGNORE INTO review_versions(review) VALUES (new.id);
    END;`)
  // Atomic, one-time metadata-only backfill. Bodies, identities and totals stay in place.
  if (!existing) db.exec("INSERT OR IGNORE INTO review_versions(review) SELECT id FROM reviews")
}
