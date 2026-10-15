import type { HistoryDatabase } from "./history-schema.js"

/** Preserve legacy entry IDs, payload foreign keys, indexes and maintenance triggers.
 * Only the small chronological index is copied; report bodies and accounting stay
 * in place. The caller owns an immediate transaction with foreign keys disabled.
 */
export function migrateHistoryReports(db: HistoryDatabase) {
  const rebuilding = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='history_legacy_rebuild'").get()
    && db.prepare("SELECT 1 FROM history_legacy_rebuild WHERE position=9 AND phase=1").get()
  let migrated = false
  for (const table of ["history", ...(rebuilding ? ["history_legacy_copy"] : [])]) {
    const source = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql
    if (typeof source !== "string" || !/UNIQUE\s*\(scope,\s*permission\)/i.test(source)) continue
    const schema = source.replace(/UNIQUE\s*\(scope,\s*permission\)/i, "entry TEXT NOT NULL, UNIQUE(scope,permission,review)")
      .replace(/^CREATE TABLE (?:"\w+"|\w+)/i, "CREATE TABLE history_report_migration")
    const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table)
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => `"${row.name}"`)
    db.exec(schema)
    db.exec(`INSERT INTO history_report_migration(rowid,${columns.join(",")},entry) SELECT rowid,*,id FROM ${table};
      DROP TABLE ${table}; ALTER TABLE history_report_migration RENAME TO ${table};`)
    for (const object of objects) db.exec(object.sql)
    migrated = true
  }
  if (rebuilding && migrated) {
    const columns = db.prepare("PRAGMA table_info(history)").all().map(row => `"${row.name}"`)
    const insert = `INSERT INTO history_legacy_copy(rowid,${columns.join(",")}) VALUES (new.rowid,${columns.map(column => `new.${column}`).join(",")});`
    db.exec(`DROP TRIGGER history_legacy_insert; DROP TRIGGER history_legacy_update; DROP TRIGGER history_legacy_delete;
      CREATE TRIGGER history_legacy_insert AFTER INSERT ON history BEGIN ${insert} END;
      CREATE TRIGGER history_legacy_update AFTER UPDATE ON history BEGIN DELETE FROM history_legacy_copy WHERE rowid=old.rowid; ${insert} END;
      CREATE TRIGGER history_legacy_delete AFTER DELETE ON history BEGIN DELETE FROM history_legacy_copy WHERE rowid=old.rowid; END;`)
  }
}
