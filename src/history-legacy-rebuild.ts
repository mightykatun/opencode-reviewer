import { HistoryInvalid } from "./history-records.js"
import { HISTORY_SCRUB_MS, HISTORY_SCRUB_STEPS } from "./history-legacy-scrub.js"
import type { HistoryDatabase } from "./history-schema.js"

// Durable positions: never reorder. Only plugin-owned v1 tables; scratch tables
// were created with secure_delete=ON.
const tables = ["meta", "writers", "contributions", "tombstones", "roots", "sessions", "reviews", "attempts",
  "approvals", "history", "payloads", "conversation_totals", "conversation_bootstrap", "history_generations",
  "history_privacy", "history_deletions"] as const
const shadow = "history_legacy_copy", retired = "history_legacy_retired", prefix = "history_rebuilt_"
const mirrors = ["history_legacy_insert", "history_legacy_update", "history_legacy_delete"]
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

export const legacyRebuildSchema = `CREATE TABLE IF NOT EXISTS history_legacy_rebuild (
  id INTEGER PRIMARY KEY CHECK(id=1), position INTEGER NOT NULL, phase INTEGER NOT NULL,
  cursor INTEGER, ceiling INTEGER);
  INSERT OR IGNORE INTO history_legacy_rebuild SELECT 1,0,0,NULL,NULL FROM history_privacy WHERE id=1 AND legacy=1;`

/** Indexes on the replacement are built one row at a time, under durable alternate
 * names. Reopening must not rebuild a duplicate full-sized index under its old name.
 * Accept only the alternate on the intended live table, not a retired/copy index.
 */
export function historySchema(db: HistoryDatabase, sql: string) {
  db.exec(sql.replace(/CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)\([^;]+;/g, (statement, name, table) =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=? AND tbl_name=?").get(prefix + name, table) ? "" : statement))
}

/** Owned BEGIN IMMEDIATE, foreign_keys=OFF, legacy_alter_table=ON. No user event
 * runs in this transaction. Mirroring triggers installed before copying preserve
 * every committed mutation, including inserts behind the cursor and deletions.
 * The finite rowid ceiling prevents new appends from extending the copy forever.
 * Swapping two table names and their fixed schema is atomic for other connections;
 * legacy rename semantics keep foreign keys and other tables' triggers pointing at
 * the live name. The old table has NO triggers/references to it after cutover.
 * Drain its rows/index entries individually, then DROP only the empty b-trees.
 * That last step securely zeros root pages as well as old freeblocks. No raw page
 * writes, schema-table edits, full-table DELETE, REINDEX or VACUUM are involved.
 *
 * Work is <=8 rows or 40ms between rows per call; one row/index path and schema
 * transition are indivisible. The unchanged worker watchdog owns slow I/O. Disk
 * space can grow by the largest table plus indexes, and a pinned reader can retain
 * WAL for the whole rebuild. Total work is database-sized, not deadline-sized;
 * progress survives every commit and shutdown need not finish it. As with ordinary
 * secure deletion, all writers must use this policy; backups, filesystem snapshots
 * and unallocated filesystem blocks are outside the active-file guarantee.
 */
export function rebuildLegacyPages(db: HistoryDatabase): boolean {
  const get = (sql: string, ...args: any[]) => db.prepare(sql).get(...args)
  const state = get("SELECT position,phase,cursor,ceiling FROM history_legacy_rebuild WHERE id=1")
  if (!state || state.position === tables.length) return false
  if (!Number.isInteger(state.position) || state.position < 0 || state.position >= tables.length || ![0, 1, 2].includes(state.phase))
    throw new HistoryInvalid("Invalid history rebuild phase")
  const table = tables[state.position]!, name = quote(table)
  if (state.phase === 0) {
    const definition = get("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", table)?.sql
    if (typeof definition !== "string" || !/^CREATE TABLE (?:"\w+"|\w+)\s*\(/i.test(definition)) throw new HistoryInvalid("Invalid history rebuild table")
    db.exec(definition.replace(/^CREATE TABLE (?:"\w+"|\w+)/i, `CREATE TABLE ${shadow}`))
    // Explicit indexes are created while empty. PRIMARY KEY / UNIQUE indexes come
    // from the exact table definition and receive SQLite-owned names automatically.
    for (const index of db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table)) {
      if (!/^CREATE (?:UNIQUE )?INDEX \w+ ON (?:"\w+"|\w+)/i.test(index.sql)) throw new HistoryInvalid("Invalid history rebuild index")
      db.exec(index.sql.replace(/^(CREATE (?:UNIQUE )?INDEX) \w+ ON (?:"\w+"|\w+)/i, `$1 ${quote(prefix + index.name)} ON ${shadow}`))
    }
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => quote(row.name))
    const insert = `INSERT INTO ${shadow}(rowid,${columns.join(",")}) VALUES (new.rowid,${columns.map(column => `new.${column}`).join(",")});`
    db.exec(`CREATE TRIGGER ${mirrors[0]} AFTER INSERT ON ${name} BEGIN ${insert} END;
      CREATE TRIGGER ${mirrors[1]} AFTER UPDATE ON ${name} BEGIN DELETE FROM ${shadow} WHERE rowid=old.rowid; ${insert} END;
      CREATE TRIGGER ${mirrors[2]} AFTER DELETE ON ${name} BEGIN DELETE FROM ${shadow} WHERE rowid=old.rowid; END;`)
    const ceiling = get(`SELECT rowid AS n FROM ${name} ORDER BY rowid DESC LIMIT 1`)?.n ?? null
    db.prepare("UPDATE history_legacy_rebuild SET phase=1,ceiling=? WHERE id=1").run(ceiling)
  } else if (state.phase === 1) {
    const end = performance.now() + HISTORY_SCRUB_MS
    const next = db.prepare(`SELECT rowid AS n FROM ${name} WHERE rowid<=? ${state.cursor === null ? "" : "AND rowid>?"} ORDER BY rowid LIMIT 1`)
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => quote(row.name))
    const copy = db.prepare(`INSERT INTO ${shadow}(rowid,${columns.join(",")}) SELECT rowid,* FROM ${name} WHERE rowid=? ON CONFLICT(rowid) DO NOTHING`)
    let cursor = state.cursor
    for (let step = 0; step < HISTORY_SCRUB_STEPS; step++) {
      // Reprepare the initial-null predicate after the first row so each seek is
      // indexed rather than an OR predicate that scans the already copied prefix.
      const row = cursor === state.cursor ? next.get(state.ceiling, ...(cursor === null ? [] : [cursor]))
        : get(`SELECT rowid AS n FROM ${name} WHERE rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`, state.ceiling, cursor)
      if (!row) {
        for (const trigger of mirrors) db.exec(`DROP TRIGGER ${trigger}`)
        const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table)
        for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`)
        db.exec(`ALTER TABLE ${name} RENAME TO ${retired}; ALTER TABLE ${shadow} RENAME TO ${name};`)
        for (const trigger of triggers) db.exec(trigger.sql)
        db.exec("UPDATE history_legacy_rebuild SET phase=2 WHERE id=1")
        break
      }
      // Integer-primary-key tables alias rowid; explicitly list destinations to
      // include both the alias and its named column, as in the mirroring trigger.
      copy.run(row.n); cursor = row.n
      db.prepare("UPDATE history_legacy_rebuild SET cursor=? WHERE id=1").run(cursor)
      if (performance.now() >= end) break
    }
  } else {
    const end = performance.now() + HISTORY_SCRUB_MS
    for (let step = 0; step < HISTORY_SCRUB_STEPS; step++) {
      const row = get(`SELECT rowid AS n FROM ${retired} ORDER BY rowid LIMIT 1`)
      if (!row) {
        db.exec(`DROP TABLE ${retired}`)
        db.exec("UPDATE history_legacy_rebuild SET position=position+1,phase=0,cursor=NULL,ceiling=NULL WHERE id=1")
        if (state.position + 1 === tables.length) db.exec("UPDATE history_privacy SET legacy=0 WHERE id=1")
        break
      }
      db.prepare(`DELETE FROM ${retired} WHERE rowid=?`).run(row.n)
      if (performance.now() >= end) break
    }
  }
  db.exec("UPDATE history_privacy SET generation=generation+1 WHERE id=1")
  return true
}
