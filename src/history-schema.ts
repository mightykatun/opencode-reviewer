import { add, empty, validate } from "./lifetime.js"
import type { LifetimeTotals } from "./lifetime.js"
import { count, decodeEvent, entryID, HISTORY_RECORD_BYTES as bytes, HISTORY_TEXT_BYTES, HistoryInvalid, opaque, reviewID, rootID, sessionID, validatePayload, validateQuery, validateReview, validateScope } from "./history-records.js"
import { bootstrap, migrationSchema } from "./history-migration.js"
import { browsingSchema, HistoryBrowsing } from "./history-browsing.js"
import { historyDelta, permissionStatistic, permissionStatisticsSchema, replacePermissionStatistic, validatePermissionStatistic } from "./history-statistics.js"
import { cleanupHistory, privacySchema } from "./history-privacy.js"
import type { HistoryCleanup } from "./history-privacy.js"
import { deleteHistory } from "./history-deletion.js"
import { scrubLegacyFreelist } from "./history-legacy-scrub.js"
import { historySchema, rebuildLegacyPages } from "./history-legacy-rebuild.js"
import { initializeHistoryPragmas } from "./history-sqlite-init.js"
import { migrateHistoryReports } from "./history-report-migration.js"
import type { HistoryEvent, HistoryOutcome, HistoryPayload, HistoryQuery, HistoryReview, HistoryScope, HistoryOrder } from "./history-records.js"

type Row = Record<string, any>
export interface HistoryDatabase {
  exec(sql: string): unknown
  prepare(sql: string): { run(...args: any[]): unknown; get(...args: any[]): any; all(...args: any[]): any[] }
  close(): void
}
export interface HistorySelection {
  revision: number; total: number; rank: number; entry?: string; older?: string; newer?: string
  record?: { context: HistoryReview; payload: HistoryPayload; outcome: HistoryOutcome; approvingReview?: string }
  unreadable?: boolean
  order?: HistoryOrder
  deleted?: boolean
  session?: string
}
export interface ConversationTotals { totals: LifetimeTotals; partialHistory: boolean }
export interface HistoryTotals { revision: number; totals: LifetimeTotals; conversation?: ConversationTotals }
export interface HistoryConversationTotals extends HistoryTotals { partialHistory: boolean }
export interface HistorySessions { sessions: { scope: string; root: string; session: string }[]; after?: string }
export interface HistoryResolution { outcome?: HistoryOutcome; uncertain: boolean; conflict: boolean; deleted: boolean }
export interface HistorySession { context?: HistoryScope }
export type HistoryResult = HistorySelection | HistoryTotals | HistoryConversationTotals | HistorySessions | HistoryResolution | HistorySession
export interface HistoryPending { pending: string }
export interface HistoryDeleting { deleting: true }

const schema = `
CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, totals TEXT NOT NULL);
CREATE TABLE writers (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
CREATE TABLE contributions (id TEXT PRIMARY KEY);
CREATE TABLE tombstones (id TEXT PRIMARY KEY);
CREATE TABLE roots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, root TEXT NOT NULL, session TEXT NOT NULL);
CREATE INDEX sessions_scope ON sessions(scope,id);
CREATE TABLE reviews (id TEXT PRIMARY KEY, entry TEXT NOT NULL, root TEXT NOT NULL, session TEXT NOT NULL, context TEXT NOT NULL, accepted TEXT);
CREATE INDEX reviews_root ON reviews(root);
CREATE INDEX reviews_session ON reviews(session);
CREATE INDEX reviews_entry ON reviews(entry);
CREATE TABLE attempts (id TEXT PRIMARY KEY, review TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, dispatched TEXT, finalized TEXT);
CREATE TABLE approvals (id TEXT PRIMARY KEY, entry TEXT NOT NULL, root TEXT NOT NULL, session TEXT NOT NULL, review TEXT NOT NULL, state TEXT NOT NULL, automatic INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX approvals_entry ON approvals(entry);
CREATE TABLE history (id TEXT PRIMARY KEY, scope TEXT NOT NULL, root TEXT NOT NULL, session TEXT NOT NULL, permission TEXT NOT NULL,
  completed INTEGER NOT NULL, tie TEXT NOT NULL, review TEXT NOT NULL, outcome TEXT, resolution TEXT NOT NULL, approving TEXT, resolvedAt INTEGER NOT NULL,
  entry TEXT NOT NULL, UNIQUE(scope,permission,review));
CREATE INDEX history_order ON history(scope,root,completed,tie,id);
CREATE INDEX history_session ON history(session);
CREATE TABLE payloads (id TEXT PRIMARY KEY REFERENCES history(id) ON DELETE CASCADE, body TEXT NOT NULL);
`

/** Accounting and replay commit atomically; detail deletion stages are tombstoned and resumable. */
export class HistorySQL {
  private statements = new Map<string, ReturnType<HistoryDatabase["prepare"]>>()
  private browsing = new HistoryBrowsing()
  constructor(readonly db: HistoryDatabase) {
    initializeHistoryPragmas(db)
    if (db.prepare("PRAGMA secure_delete").get()?.secure_delete !== 1) throw new HistoryInvalid("Secure history deletion unavailable")
    db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON")
    try { this.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      if (!tables.length) {
        db.exec(schema)
        db.prepare("INSERT INTO meta VALUES (1,1,0,?)").run(JSON.stringify(empty()))
      }
      const meta = db.prepare(`SELECT version,revision,CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals FROM meta WHERE id=1`).get()
      if (meta?.version !== 1 || !count(meta.revision)) throw new HistoryInvalid("Unsupported history schema")
      this.parseTotals(meta.totals)
      migrateHistoryReports(db)
      // Additive v1 indexes, serialized with initialization on both adapters.
      // Cascading maintenance must not scan all unrelated sessions/attempts.
      historySchema(db, `CREATE INDEX IF NOT EXISTS sessions_root ON sessions(scope,root);
        CREATE INDEX IF NOT EXISTS attempts_review ON attempts(review);
        CREATE INDEX IF NOT EXISTS approvals_root ON approvals(root);
        CREATE INDEX IF NOT EXISTS approvals_session ON approvals(session);
        CREATE INDEX IF NOT EXISTS history_root ON history(root);`)
      historySchema(db, `CREATE TABLE IF NOT EXISTS conversation_totals (id TEXT PRIMARY KEY, totals TEXT NOT NULL, partial INTEGER NOT NULL CHECK(partial IN (0,1)));
        CREATE INDEX IF NOT EXISTS reviews_root_id ON reviews(root,id);
        CREATE INDEX IF NOT EXISTS attempts_review_id ON attempts(review,id);
        CREATE INDEX IF NOT EXISTS approvals_review_id ON approvals(review,id);
        CREATE INDEX IF NOT EXISTS history_visible_order ON history(scope,root,completed,tie,id) WHERE outcome IS NOT NULL;`)
      historySchema(db, `CREATE INDEX IF NOT EXISTS history_permission ON history(scope,root,session,permission,completed,tie,id) WHERE outcome IS NOT NULL;`)
      historySchema(db, permissionStatisticsSchema)
      db.exec(migrationSchema)
      historySchema(db, browsingSchema)
      privacySchema(db, tables.length > 0)
    }) } finally { db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON") }
  }
  private statement(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }
  private get(sql: string, ...args: any[]): Row | undefined { return this.statement(sql).get(...args) }
  private all(sql: string, ...args: any[]): Row[] { return this.statement(sql).all(...args) }
  private run(sql: string, ...args: any[]) { this.statement(sql).run(...args) }
  private transaction<T>(run: () => T, write = true): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN")
    try { const result = run(); this.db.exec("COMMIT"); return result }
    catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  private parseTotals(text: string): LifetimeTotals {
    if (typeof text !== "string" || Buffer.byteLength(text) > bytes.totals) throw new HistoryInvalid("Invalid history totals")
    return validate(JSON.parse(text))
  }
  private revision(root: string) {
    const previous = this.get("SELECT revision FROM roots WHERE id=?", root)?.revision ?? 0
    if (!count(previous) || !count(previous + 1)) throw new HistoryInvalid("History revision overflow")
    this.run("INSERT INTO roots VALUES (?,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1", root)
  }
  apply(writer: string, sequence: number, serialized: string, beforeCommit?: () => void): { replay: boolean } {
    for (;;) {
      const result = this.applyReady(writer, sequence, serialized, beforeCommit)
      if ("deleting" in result) continue
      if (!("pending" in result)) return result
      this.bootstrap(result.pending)
    }
  }
  /** Worker entrypoint: bootstrap is separate; deletion advances at most one bounded slice. */
  applyReady(writer: string, sequence: number, serialized: string, beforeCommit?: () => void): { replay: boolean } | HistoryPending | HistoryDeleting {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(writer) || !count(sequence) || !sequence) throw new HistoryInvalid("Invalid writer sequence")
    const event = decodeEvent(serialized)
    return this.transaction(() => {
      const previous = this.get("SELECT sequence FROM writers WHERE id=?", writer)?.sequence ?? 0
      if (sequence <= previous) return { replay: true }
      if (sequence !== previous + 1) throw new HistoryInvalid("History sequence gap")
      const root = rootID(event.context)
      if (!this.ready(root)) return { pending: root }
      if (event.type === "sessionDeleted") {
        if (!deleteHistory(this.db, event.context)) { beforeCommit?.(); return { deleting: true } }
        this.revision(root)
      } else this.event(event)
      this.run("INSERT INTO writers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence", writer, sequence)
      beforeCommit?.()
      return { replay: false }
    })
  }
  bootstrap(root: string, beforeCommit?: () => void) {
    return this.transaction(() => { const result = bootstrap(this.db, root); beforeCommit?.(); return result })
  }
  private ready(root: string) {
    if (this.get("SELECT id FROM conversation_totals WHERE id=?", root)) return true
    if (this.get("SELECT id FROM conversation_bootstrap WHERE id=?", root)) return false
    // Fresh roots take constant work, preserving the synchronous ordinary-event API.
    if (!this.get("SELECT id FROM reviews WHERE root=? LIMIT 1", root)
      && !this.get("SELECT id FROM permission_statistics WHERE root=? LIMIT 1", root)) {
      this.run("INSERT INTO conversation_totals VALUES (?,?,?)", root, JSON.stringify(empty()), Number(!!this.get("SELECT id FROM roots WHERE id=?", root)))
      return true
    }
    return false
  }
  private conversation(root: string): { totals: LifetimeTotals; partialHistory: boolean } {
    const saved = this.get(`SELECT CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals,partial FROM conversation_totals WHERE id=?`, root)
    if (saved) {
      if (saved.partial !== 0 && saved.partial !== 1) throw new HistoryInvalid("Invalid conversation coverage")
      return { totals: this.parseTotals(saved.totals), partialHistory: saved.partial === 1 }
    }
    if (!this.get("SELECT id FROM reviews WHERE root=? LIMIT 1", root)
      && !this.get("SELECT id FROM permission_statistics WHERE root=? LIMIT 1", root))
      return { totals: empty(), partialHistory: !!this.get("SELECT id FROM roots WHERE id=?", root) }
    throw new HistoryInvalid("Conversation bootstrap required")
  }
  private contribute(key: string, delta: LifetimeTotals, root: string) {
    if (this.get("SELECT id FROM contributions WHERE id=?", key)) return
    const meta = this.get(`SELECT CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals,revision FROM meta WHERE id=1`)!
    const totals = add(this.parseTotals(meta.totals), delta)
    const conversation = add(this.conversation(root).totals, delta)
    if (!count(meta.revision + 1)) throw new HistoryInvalid("History revision overflow")
    this.run("INSERT INTO contributions VALUES (?)", key)
    if (JSON.stringify(totals) !== meta.totals) this.run("UPDATE meta SET totals=?,revision=revision+1 WHERE id=1", JSON.stringify(totals))
    this.run("UPDATE conversation_totals SET totals=? WHERE id=?", JSON.stringify(conversation), root)
  }
  private countOutcome(entry: string, root: string, outcome: HistoryOutcome | undefined, at: number) {
    const previous = this.get("SELECT * FROM permission_statistics WHERE id=?", entry)
    if (previous) {
      validatePermissionStatistic(previous as any)
      if (previous.root !== root) throw new HistoryInvalid("Conflicting permission statistics ownership")
    }
    const next = permissionStatistic(outcome), prior = previous?.outcome ?? "other"
    if (prior === next) return
    const meta = this.get(`SELECT CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals,revision FROM meta WHERE id=1`)!
    const totals = replacePermissionStatistic(this.parseTotals(meta.totals), prior, next, at)
    const conversation = replacePermissionStatistic(this.conversation(root).totals, prior, next, at)
    if (!count(meta.revision + 1)) throw new HistoryInvalid("History revision overflow")
    this.run(`INSERT INTO permission_statistics VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome,at=excluded.at`,
      entry, root, next, at)
    this.run("UPDATE meta SET totals=?,revision=revision+1 WHERE id=1", JSON.stringify(totals))
    this.run("UPDATE conversation_totals SET totals=? WHERE id=?", JSON.stringify(conversation), root)
  }
  private event(e: Exclude<HistoryEvent, { type: "sessionDeleted" }>) {
    const c = e.context, root = rootID(c), session = sessionID(c)
    const context = e.context, review = reviewID(context), entry = entryID(context)
    const deleted = this.get("SELECT id FROM tombstones WHERE id IN (?,?) LIMIT 1", root, session)
    if (!deleted) {
      const existingSession = this.get("SELECT root FROM sessions WHERE id=?", session)
      if (existingSession && existingSession.root !== c.root) throw new HistoryInvalid("Conflicting session ownership")
      this.run("INSERT OR IGNORE INTO sessions VALUES (?,?,?,?)", session, c.scope, c.root, c.session)
      const existing = this.get("SELECT context FROM reviews WHERE id=?", review)
      if (existing) {
        const prior = JSON.parse(existing.context)
        if (Object.keys(context).some(key => prior[key] !== context[key as keyof HistoryReview])) throw new HistoryInvalid("Conflicting review identity")
      }
      const owner = this.get("SELECT root,session FROM history WHERE scope=? AND permission=? LIMIT 1", c.scope, c.permission)
      if (owner && (owner.root !== root || owner.session !== session)) throw new HistoryInvalid("Conflicting permission ownership")
      const pendingOwner = this.get("SELECT root,session FROM reviews WHERE entry=? LIMIT 1", entry)
      if (pendingOwner && (pendingOwner.root !== root || pendingOwner.session !== session)) throw new HistoryInvalid("Conflicting permission ownership")
      this.run("INSERT OR IGNORE INTO reviews VALUES (?,?,?,?,?,NULL)", review, entry, root, session, JSON.stringify(context))
    }
    const delta = historyDelta(e)
    if (e.type === "attemptDispatched" || e.type === "attemptFinalized") {
      const attempt = opaque(review, e.attempt)
      if (!deleted) {
        this.run("INSERT OR IGNORE INTO attempts VALUES (?,?,NULL,NULL)", attempt, review)
        if (e.type === "attemptDispatched") this.run("UPDATE attempts SET dispatched=COALESCE(dispatched,?) WHERE id=?", JSON.stringify({ at: e.at, retry: e.retry }), attempt)
        else this.run("UPDATE attempts SET finalized=COALESCE(finalized,?) WHERE id=?", JSON.stringify({ at: e.at, usage: e.usage, reportedModel: e.reportedModel }), attempt)
      }
      this.contribute(opaque(e.type, attempt), delta, root)
    } else if (e.type === "reviewAccepted") {
      if (!deleted) this.run("UPDATE reviews SET accepted=COALESCE(accepted,?) WHERE id=?", JSON.stringify(e.accepted), review)
      this.contribute(opaque(e.type, review), delta, root)
    } else if (e.type === "approvalConfirmed" || e.type === "approvalDispatched" || e.type === "approvalSettled") {
      const id = opaque(entry, e.approval)
      if (!deleted) {
        const old = this.get("SELECT * FROM approvals WHERE id=?", id)
        if (old && (old.review !== review || ("automatic" in e && old.automatic !== -1 && old.automatic !== Number(e.automatic))))
          throw new HistoryInvalid("Conflicting approval identity")
        const state = e.type === "approvalConfirmed" ? "confirmed" : e.type === "approvalSettled" ? e.result : "pending"
        // A late dispatch cannot undo a settlement/confirmation from another client.
        if (!old || (old.state !== "confirmed" && e.type !== "approvalDispatched")) {
          this.run("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,automatic=excluded.automatic,at=excluded.at",
            id, entry, root, session, review, state, "automatic" in e ? Number(e.automatic) : old?.automatic ?? -1, e.at)
        } else if (old.automatic === -1 && "automatic" in e)
          this.run("UPDATE approvals SET automatic=? WHERE id=?", Number(e.automatic), id)
        this.countOutcome(entry, root, this.outcome(c.scope, c.permission, entry), e.at); this.revision(root)
      }
      if (e.type === "approvalConfirmed") {
        this.contribute(opaque("approvalConfirmed", id), delta, root)
      }
    } else if ((e.type === "permissionResolved" || e.type === "permissionOutcome") && !deleted) {
      const old = this.get("SELECT * FROM history WHERE scope=? AND permission=? LIMIT 1", c.scope, c.permission)
      if (e.type === "permissionOutcome" && !old) return
      // A permission has one outcome but retains every distinct completed review.
      const prior = old?.resolution
      const resolution = !prior || prior === "cancelled" ? e.outcome : e.outcome === "cancelled" ? prior
        : prior === "conflict" || ((prior === "rejected") !== (e.outcome === "rejected")) ? "conflict"
        : prior === "auto" || e.outcome === "auto" ? "auto"
        : prior === "manual" || e.outcome === "manual" ? "manual" : e.outcome
      if (e.type === "permissionResolved") {
        // Legacy IDs stay stable on replay; new reports use their review identity.
        const saved = this.get("SELECT id FROM history WHERE scope=? AND permission=? AND review=?", c.scope, c.permission, review)
        const id = saved?.id ?? review
        const collision = this.get("SELECT scope,root,session,permission,review FROM history WHERE id=?", id)
        if (collision && (collision.scope !== c.scope || collision.root !== root || collision.session !== session
          || collision.permission !== c.permission || collision.review !== review)) throw new HistoryInvalid("Conflicting saved report identity")
        this.run(`INSERT INTO history VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET
          completed=excluded.completed,tie=excluded.tie,review=excluded.review,resolution=excluded.resolution,resolvedAt=excluded.resolvedAt`,
        id, c.scope, root, session, context.permission, e.payload.completedAt, context.review, review, resolution, e.at, entry)
        this.run("INSERT INTO payloads VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", id, JSON.stringify(e.payload))
      }
      this.run("UPDATE history SET resolution=? WHERE scope=? AND permission=?", resolution, c.scope, c.permission)
      this.countOutcome(entry, root, this.outcome(c.scope, c.permission, entry), e.at); this.revision(root)
    }
  }
  private outcome(scope: string, permission: string, entry: string): HistoryOutcome | undefined {
    const row = this.get("SELECT resolution FROM history WHERE scope=? AND permission=? LIMIT 1", scope, permission)
    const auto = this.get("SELECT review FROM approvals WHERE entry=? AND state='confirmed' AND automatic=1 ORDER BY id LIMIT 1", entry)
    const manual = this.get("SELECT review FROM approvals WHERE entry=? AND state='confirmed' AND automatic=0 ORDER BY id LIMIT 1", entry)
    if (!row) return auto ? "auto" : manual ? "manual" : undefined
    const uncertain = this.get("SELECT id FROM approvals WHERE entry=? AND state IN ('pending','uncertain') LIMIT 1", entry)
    const outcome = row.resolution === "conflict" || (row.resolution === "rejected" && (auto || manual)) ? null
      : row.resolution === "rejected" ? "rejected" : auto ? "auto" : manual ? "manual"
      : row.resolution === "cancelled" && uncertain ? null : row.resolution
    const resolution = row.resolution === "approved" ? auto ? "auto" : manual ? "manual" : row.resolution : row.resolution
    this.run("UPDATE history SET outcome=?,approving=?,resolution=? WHERE scope=? AND permission=?", outcome, auto?.review ?? manual?.review ?? null, resolution, scope, permission)
    return outcome ?? undefined
  }
  query(q: HistoryQuery): HistoryResult {
    for (;;) {
      const result = this.queryReady(q)
      if (!("pending" in result)) return result
      this.bootstrap(result.pending)
    }
  }
  queryReady(q: HistoryQuery): HistoryResult | HistoryPending {
    validateQuery(q)
    return this.transaction(() => {
      const conversation = q.type === "conversationTotals" ? q : q.type === "totals" ? q.conversation : undefined
      if (conversation) {
        const root = rootID(conversation)
        if (!this.get("SELECT id FROM conversation_totals WHERE id=?", root)
          && (this.get("SELECT id FROM conversation_bootstrap WHERE id=?", root)
            || this.get("SELECT id FROM reviews WHERE root=? LIMIT 1", root)
            || this.get("SELECT id FROM permission_statistics WHERE root=? LIMIT 1", root))) return { pending: root }
      }
      if (q.type === "totals") {
        const row = this.get(`SELECT revision,CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals FROM meta WHERE id=1`)!
        if (!count(row.revision)) throw new HistoryInvalid("Invalid aggregate revision")
        return { revision: row.revision, totals: this.parseTotals(row.totals),
          ...(q.conversation ? { conversation: this.conversation(rootID(q.conversation)) } : {}) }
      }
      if (q.type === "conversationTotals") {
        const revision = this.get("SELECT revision FROM meta WHERE id=1")!.revision
        if (!count(revision)) throw new HistoryInvalid("Invalid aggregate revision")
        return { revision, ...this.conversation(rootID(q)) }
      }
      if (q.type === "sessions") {
        // Physical maintenance inventory, not report visibility. Keep bounded raw
        // pages/cursors through pending deletion so reconciliation can finish it.
        const rows = this.all(`SELECT CASE WHEN length(id)=64 THEN id END AS id,scope,
          CASE WHEN length(CAST(root AS BLOB))<=${HISTORY_TEXT_BYTES} THEN root END AS root,
          CASE WHEN length(CAST(session AS BLOB))<=${HISTORY_TEXT_BYTES} THEN session END AS session
          FROM sessions WHERE scope=? AND id>? ORDER BY id LIMIT ?`, q.scope, q.after ?? "", q.limit ?? 100)
        return { sessions: rows.map(row => {
          validateScope(row as any)
          if (row.id !== sessionID(row as any) || row.scope !== q.scope) throw new HistoryInvalid("Invalid session index")
          return { scope: row.scope, root: row.root, session: row.session }
        }), after: rows.at(-1)?.id }
      }
      if (q.type === "session") {
        if (this.get("SELECT id FROM tombstones WHERE id=?", opaque(q.scope, q.session))) return {}
        const row = this.get(`SELECT CASE WHEN length(CAST(scope AS BLOB))<=${HISTORY_TEXT_BYTES} THEN scope END AS scope,
          CASE WHEN length(CAST(session AS BLOB))<=${HISTORY_TEXT_BYTES} THEN session END AS session,
          CASE WHEN length(CAST(root AS BLOB))<=${HISTORY_TEXT_BYTES} THEN root END AS root
          FROM sessions WHERE id=?`, opaque(q.scope, q.session))
        if (!row) return {}
        validateScope(row as HistoryScope)
        if (row.scope !== q.scope || row.session !== q.session) throw new HistoryInvalid("Invalid session ownership")
        if (this.get("SELECT id FROM tombstones WHERE id=?", rootID(row as HistoryScope))) return {}
        return { context: { scope: row.scope, root: row.root, session: row.session } }
      }
      if (q.type === "resolution") {
        const entry = opaque(q.scope, q.permission), root = rootID(q), session = sessionID(q)
        const deleted = !!this.get("SELECT id FROM tombstones WHERE id IN (?,?) LIMIT 1", root, session)
        if (deleted) return { outcome: undefined, uncertain: false, conflict: false, deleted: true }
        const invalid = this.get(`SELECT 1 AS invalid FROM approvals WHERE entry=? AND
          (root!=? OR session!=? OR state NOT IN ('pending','confirmed','uncertain','not-sent') OR automatic NOT IN (-1,0,1)
          OR (state='confirmed' AND automatic=-1)) LIMIT 1`, entry, root, session)
        const invalidReview = this.get("SELECT 1 AS invalid FROM reviews WHERE entry=? AND (root!=? OR session!=?) LIMIT 1", entry, root, session)
        const history = this.get(`SELECT CASE WHEN length(root)=64 THEN root END AS root,
          CASE WHEN length(session)=64 THEN session END AS session,
          CASE WHEN length(CAST(resolution AS BLOB))<=16 THEN resolution END AS resolution FROM history WHERE scope=? AND permission=? LIMIT 1`, q.scope, q.permission)
        if (invalid || invalidReview || (history && (history.root !== root || history.session !== session
          || !["auto", "manual", "approved", "rejected", "cancelled", "conflict"].includes(history.resolution)))) throw new HistoryInvalid("Invalid resolution ownership")
        const auto = !!this.get("SELECT id FROM approvals WHERE entry=? AND state='confirmed' AND automatic=1 LIMIT 1", entry)
        const manual = !!this.get("SELECT id FROM approvals WHERE entry=? AND state='confirmed' AND automatic=0 LIMIT 1", entry)
        const uncertain = !!this.get("SELECT id FROM approvals WHERE entry=? AND state IN ('pending','uncertain') LIMIT 1", entry)
        const conflict = history?.resolution === "conflict" || (history?.resolution === "rejected" && (auto || manual))
        const outcome = deleted || conflict ? undefined : auto ? "auto" : manual ? "manual"
          : ["auto", "manual", "approved", "rejected"].includes(history?.resolution) ? history!.resolution : undefined
        return { outcome, uncertain, conflict, deleted }
      }
      const root = rootID(q), revision = this.get("SELECT revision FROM roots WHERE id=?", root)?.revision ?? 0
      if (this.get("SELECT id FROM tombstones WHERE id=?", root)) return { revision, total: 0, rank: 0, deleted: true }
      const visible = "NOT EXISTS (SELECT 1 FROM tombstones WHERE id=history.session)"
      const base = `scope=? AND root=? AND outcome IS NOT NULL AND ${visible}`
      const generation = this.get("SELECT generation FROM history_generations WHERE id=?", root)?.generation ?? 0
      if (!count(generation) || !count(revision)) throw new HistoryInvalid("Invalid history index")
      let index = this.browsing.get(root, generation)
      if (!index) {
        // Validate once per structural generation, never caching selected text.
        const invalid = this.get(`SELECT id FROM history WHERE scope=? AND root=? AND ${visible} AND
          (typeof(completed)!='integer' OR completed<0 OR completed>8640000000000000 OR length(id)!=64 OR length(session)!=64 OR length(entry)!=64
          OR length(review)!=64 OR typeof(permission)!='text' OR length(CAST(permission AS BLOB))>${HISTORY_TEXT_BYTES}
          OR typeof(tie)!='text' OR length(tie)=0 OR length(CAST(tie AS BLOB))>${HISTORY_TEXT_BYTES}
          OR length(CAST(resolution AS BLOB))>16 OR length(approving)>64
          OR outcome NOT IN ('auto','manual','approved','rejected','cancelled')) LIMIT 1`, q.scope, root)
        const invalidOwner = this.get(`SELECT h.id FROM history h LEFT JOIN reviews r ON r.id=h.review
          LEFT JOIN sessions s ON s.id=h.session WHERE h.scope=? AND h.root=?
          AND NOT EXISTS (SELECT 1 FROM tombstones WHERE id=h.session) AND
          (r.id IS NULL OR r.entry!=h.entry OR r.root!=h.root OR r.session!=h.session OR s.id IS NULL OR s.scope!=h.scope OR s.root!=?) LIMIT 1`, q.scope, root, q.root)
        if (invalid || invalidOwner) throw new HistoryInvalid("Invalid history index")
        const total = this.get(`SELECT count(*) AS n FROM history WHERE ${base}`, q.scope, root)!.n
        if (!count(total)) throw new HistoryInvalid("History count overflow")
        index = this.browsing.save(root, generation, total)
      }
      const total = index.total
      const byID = (id: string | null) => id === null ? undefined : this.get(`SELECT * FROM history WHERE ${base} AND id=?`, q.scope, root, id)
      // Seek one candidate per live session. Filtering the root's chronological
      // index would walk arbitrarily many tombstoned rows to find a neighbor.
      // Cache only candidate IDs per generation, never context or report text.
      const seek = (row?: Row, newer = false) => {
        const order = newer ? "ASC" : "DESC"
        return this.get(`SELECT h.* FROM sessions s JOIN history h ON h.id=(
          SELECT id FROM history WHERE scope=? AND root=? AND session=s.id AND outcome IS NOT NULL
          ${row ? `AND (completed,tie,id) ${newer ? ">" : "<"} (?,?,?)` : ""}
          ORDER BY completed ${order},tie ${order},id ${order} LIMIT 1)
          WHERE s.scope=? AND s.root=? AND NOT EXISTS (SELECT 1 FROM tombstones WHERE id=s.id)
          ORDER BY h.completed ${order},h.tie ${order},h.id ${order} LIMIT 1`,
        q.scope, root, ...(row ? [row.completed, row.tie, row.id] : []), q.scope, q.root)
      }
      let selected: Row | undefined
      if (q.permission) selected = this.get(`SELECT * FROM history WHERE ${base} AND permission=? AND session=?
        ORDER BY completed DESC,tie DESC,id DESC LIMIT 1`, q.scope, root, q.permission.permission, sessionID({ ...q, session: q.permission.session }))
      else if (q.entry) selected = byID(q.entry)
      else if (index.latest !== undefined) selected = byID(index.latest)
      else { selected = seek(); index.latest = selected?.id ?? null }
      const adjacent = (row: Row, newer: boolean) => {
        const key = opaque(String(row.completed), row.tie, row.id, String(newer))
        if (index.neighbors.has(key)) return byID(index.neighbors.get(key)!)
        const candidate = seek(row, newer)
        this.browsing.neighbor(index, key, candidate?.id ?? null)
        return candidate
      }
      if (selected && q.direction) selected = adjacent(selected, q.direction === "newer") ?? selected
      if (!selected && q.order) selected = adjacent(q.order, true) ?? adjacent(q.order, false)
      if (!selected) return { revision, total, rank: 0 }
      const s = selected
      if ((s.id !== opaque(q.scope, s.permission) && s.id !== s.review) || s.review !== opaque(q.scope, s.tie)) throw new HistoryInvalid("Invalid history ownership")
      const rank = index.ranks.get(s.id) ?? this.get(`SELECT count(*) AS n FROM history WHERE ${base} AND (completed,tie,id)<=(?,?,?)`, q.scope, root, s.completed, s.tie, s.id)!.n
      if (!count(rank) || rank < 1 || rank > total) throw new HistoryInvalid("Invalid history rank")
      this.browsing.rank(index, s.id, rank)
      const result: HistorySelection = { revision, total, rank, entry: s.id, order: { completed: s.completed, tie: s.tie, id: s.id }, older: adjacent(s, false)?.id, newer: adjacent(s, true)?.id }
      const contextRow = this.get(`SELECT CASE WHEN length(CAST(context AS BLOB))<=${bytes.context} THEN context END AS context FROM reviews WHERE id=? AND root=? AND session=?`, s.review, root, s.session)
      if (typeof contextRow?.context !== "string") throw new HistoryInvalid("Invalid history ownership")
      const context: HistoryReview = JSON.parse(contextRow.context); validateReview(context)
      if (rootID(context) !== root || sessionID(context) !== s.session || context.permission !== s.permission
        || entryID(context) !== s.entry || (entryID(context) !== s.id && reviewID(context) !== s.id)
        || reviewID(context) !== s.review) throw new HistoryInvalid("Invalid history ownership")
      result.session = context.session
      try {
        const body = this.get(`SELECT CASE WHEN length(CAST(body AS BLOB))<=${bytes.payload} THEN body END AS body FROM payloads WHERE id=?`, s.id)?.body
        if (typeof body !== "string" || Buffer.byteLength(body) > bytes.payload) throw new Error()
        const payload = validatePayload(JSON.parse(body))
        if (payload.completedAt !== s.completed) throw new Error()
        result.record = { context, payload, outcome: s.outcome, approvingReview: s.approving ?? undefined }
      } catch { result.unreadable = true }
      return result
    }, false)
  }
  cleanup(beforeCommit?: () => void): HistoryCleanup {
    // Resume a committed partial deletion even if its original host/FIFO exited.
    // One slice per call; checkpoint is a separate owned turn after detail work.
    let work: "scrubbing" | "deleting" | undefined = this.transaction(() => {
      const row = this.get(`SELECT id,
        CASE WHEN length(CAST(scope AS BLOB))<=${HISTORY_TEXT_BYTES} THEN scope END AS scope,
        CASE WHEN length(CAST(root AS BLOB))<=${HISTORY_TEXT_BYTES} THEN root END AS root,
        CASE WHEN length(CAST(session AS BLOB))<=${HISTORY_TEXT_BYTES} THEN session END AS session
        FROM history_deletions ORDER BY id LIMIT 1`)
      if (!row) return undefined
      validateScope(row as HistoryScope)
      if (row.id !== sessionID(row as HistoryScope) || !this.get("SELECT id FROM tombstones WHERE id=?", row.id)
        || !this.get("SELECT id FROM conversation_totals WHERE id=?", rootID(row as HistoryScope))) throw new HistoryInvalid("Invalid history deletion")
      if (deleteHistory(this.db, row as HistoryScope)) this.revision(rootID(row as HistoryScope))
      beforeCommit?.()
      return "deleting" as const
    })
    if (!work) {
      // Only this single-flight connection disables FK enforcement, only around
      // physical maintenance. Legacy rename semantics preserve live references.
      this.db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON")
      try { work = this.transaction(() => {
        if (!scrubLegacyFreelist(this.db) && !rebuildLegacyPages(this.db)) return undefined
        beforeCommit?.()
        return "scrubbing" as const
      }) } finally { this.db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON") }
    }
    if (work) return { pending: true, legacy: !!this.get("SELECT legacy FROM history_privacy WHERE id=1")!.legacy, [work]: true as const }
    return cleanupHistory(this.db)
  }
  close() { this.db.close() }
}
