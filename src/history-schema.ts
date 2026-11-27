import { add, empty, validate } from "./lifetime.js"
import type { LifetimeTotals } from "./lifetime.js"
import { count, decodeEvent, entryID, HISTORY_DESCRIPTION_BYTES, HISTORY_RECORD_BYTES as bytes, HISTORY_TEXT_BYTES, HistoryInvalid, opaque, reviewID, rootID, sessionID, validatePayload, validateQuery, validateReview } from "./history-records.js"
import { browsingSchema, HistoryBrowsing } from "./history-browsing.js"
import { historyDelta, permissionStatistic, permissionStatisticsSchema, replacePermissionStatistic, validatePermissionStatistic } from "./history-statistics.js"
import { cleanupHistory, privacySchema } from "./history-privacy.js"
import type { HistoryCleanup } from "./history-privacy.js"
import { initializeHistoryPragmas } from "./history-sqlite-init.js"
import type { HistoryEvent, HistoryOutcome, HistoryPayload, HistoryQuery, HistoryReview, HistoryOrder } from "./history-records.js"

type Row = Record<string, any>
export interface HistoryDatabase {
  exec(sql: string): unknown
  prepare(sql: string): { run(...args: any[]): unknown; get(...args: any[]): any; all(...args: any[]): any[] }
  close(): void
}
export interface HistorySelection {
  revision: number; total: number; rank: number; entry?: string; older?: string; newer?: string
  record?: { context: HistoryReview; payload: HistoryPayload; outcome: HistoryOutcome; approvingReview?: string
    reason?: string
    /** Present only when this review's steering was sent by a confirmed automatic rejection. */
    steering?: string }
  unreadable?: boolean
  order?: HistoryOrder
  deleted?: boolean
  session?: string
}
export interface ConversationTotals { totals: LifetimeTotals; partialHistory: boolean }
export interface HistoryTotals { revision: number; totals: LifetimeTotals; conversation?: ConversationTotals }
export interface HistoryConversationTotals extends HistoryTotals { partialHistory: boolean }
export interface HistoryResolution { outcome?: HistoryOutcome; uncertain: boolean; conflict: boolean; deleted: boolean }
export type HistoryResult = HistorySelection | HistoryTotals | HistoryConversationTotals | HistoryResolution

/** Ledger key of the lifetime automatic-rejection count. Conversation keys are 64-hex root IDs. */
const AUTO_REJECTION_LIFETIME = "lifetime"

const schema = `
CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, totals TEXT NOT NULL);
CREATE TABLE writers (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
CREATE TABLE contributions (id TEXT PRIMARY KEY);
CREATE TABLE roots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, root TEXT NOT NULL);
CREATE TABLE reviews (id TEXT PRIMARY KEY, entry TEXT NOT NULL, root TEXT NOT NULL, session TEXT NOT NULL, context TEXT NOT NULL,
  accepted TEXT, reason TEXT, reviewer_version TEXT, opencode_version TEXT, superseded INTEGER NOT NULL DEFAULT 0 CHECK(superseded IN (0,1)));
CREATE INDEX reviews_root ON reviews(root);
CREATE INDEX reviews_session ON reviews(session);
CREATE INDEX reviews_entry ON reviews(entry);
CREATE TABLE attempts (id TEXT PRIMARY KEY, review TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, dispatched TEXT, finalized TEXT);
CREATE TABLE approvals (id TEXT PRIMARY KEY, entry TEXT NOT NULL, root TEXT NOT NULL, session TEXT NOT NULL, review TEXT NOT NULL, state TEXT NOT NULL, automatic INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX approvals_entry ON approvals(entry);
CREATE TABLE history (id TEXT PRIMARY KEY, root TEXT NOT NULL, session TEXT NOT NULL,
  completed INTEGER NOT NULL, tie TEXT NOT NULL, review TEXT NOT NULL, outcome TEXT, resolution TEXT NOT NULL, approving TEXT, resolvedAt INTEGER NOT NULL,
  entry TEXT NOT NULL UNIQUE);
CREATE INDEX history_visible_order ON history(root,completed,tie,id) WHERE outcome IS NOT NULL;
CREATE INDEX history_session ON history(session);
CREATE TABLE payloads (id TEXT PRIMARY KEY REFERENCES history(id) ON DELETE CASCADE, body TEXT NOT NULL);
CREATE TABLE conversation_totals (id TEXT PRIMARY KEY, totals TEXT NOT NULL);
CREATE TABLE retrieval_calls (id TEXT PRIMARY KEY, review TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, at INTEGER NOT NULL, tool TEXT);
CREATE INDEX retrieval_calls_review ON retrieval_calls(review,id);
CREATE INDEX attempts_review ON attempts(review);
CREATE TABLE auto_rejections (entry TEXT PRIMARY KEY, root TEXT NOT NULL, session TEXT NOT NULL, review TEXT NOT NULL, steering TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE auto_rejection_totals (id TEXT PRIMARY KEY, count INTEGER NOT NULL);
${permissionStatisticsSchema}
${browsingSchema}
${privacySchema}
`

/** Each event commits its details, replay cursor and accounting together. */
export class HistorySQL {
  private statements = new Map<string, ReturnType<HistoryDatabase["prepare"]>>()
  private browsing = new HistoryBrowsing()
  constructor(readonly db: HistoryDatabase) {
    initializeHistoryPragmas(db)
    if (db.prepare("PRAGMA secure_delete").get()?.secure_delete !== 1) throw new HistoryInvalid("Secure history deletion unavailable")
    this.transaction(() => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        db.exec(schema)
        db.prepare("INSERT INTO meta VALUES (1,2,0,?)").run(JSON.stringify(empty()))
      }
      if (db.prepare("SELECT version FROM meta WHERE id=1").get()?.version !== 2) throw new HistoryInvalid("Unsupported history schema")
      const meta = db.prepare(`SELECT revision,CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals FROM meta WHERE id=1`).get()
      if (!count(meta.revision)) throw new HistoryInvalid("Invalid aggregate revision")
      this.parseTotals(meta.totals)
    })
  }
  private statement(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }
  private get(sql: string, ...args: any[]): Row | undefined { return this.statement(sql).get(...args) }
  private run(sql: string, ...args: any[]) { this.statement(sql).run(...args) }
  private transaction<T>(run: () => T, write = true): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN")
    try { const result = run(); this.db.exec("COMMIT"); return result }
    catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  /** Optional display details. Malformed or oversized rows are omitted, never fatal. */
  private steeringDetails(review: string, entry: string): { reason?: string; steering?: string } {
    const bounded = (value: unknown) => typeof value === "string" && value.trim() && Buffer.byteLength(value) <= HISTORY_DESCRIPTION_BYTES ? value : undefined
    const reason = bounded(this.get(`SELECT CASE WHEN length(CAST(reason AS BLOB))<=${HISTORY_DESCRIPTION_BYTES} THEN reason END AS reason
      FROM reviews WHERE id=?`, review)?.reason)
    const steering = bounded(this.get(`SELECT CASE WHEN length(CAST(steering AS BLOB))<=${HISTORY_DESCRIPTION_BYTES} THEN steering END AS steering
      FROM auto_rejections WHERE entry=? AND review=?`, entry, review)?.steering)
    return { ...(reason ? { reason } : {}), ...(steering ? { steering } : {}) }
  }
  /** Automatic rejections come from their own ledger, outside the shared totals JSON.
   * A missing ledger row is zero and leaves the totals shape unchanged. */
  private withAutoRejected(totals: LifetimeTotals, id: string): LifetimeTotals {
    const count = this.get("SELECT count FROM auto_rejection_totals WHERE id=?", id)?.count ?? 0
    if (!Number.isSafeInteger(count) || count < 0) throw new HistoryInvalid("Invalid automatic rejection totals")
    return count ? { ...totals, activity: { ...totals.activity, autoRejected: count } } : totals
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
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(writer) || !count(sequence) || !sequence) throw new HistoryInvalid("Invalid writer sequence")
    const event = decodeEvent(serialized)
    return this.transaction(() => {
      const previous = this.get("SELECT sequence FROM writers WHERE id=?", writer)?.sequence ?? 0
      if (sequence <= previous) return { replay: true }
      if (sequence !== previous + 1) throw new HistoryInvalid("History sequence gap")
      if (event.type !== "sessionDeleted") this.event(event)
      this.run("INSERT INTO writers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence", writer, sequence)
      beforeCommit?.()
      return { replay: false }
    })
  }
  private conversation(root: string): ConversationTotals {
    const saved = this.get(`SELECT CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals FROM conversation_totals WHERE id=?`, root)
    if (!saved && this.get("SELECT id FROM reviews WHERE root=? LIMIT 1", root)) throw new HistoryInvalid("Missing conversation totals")
    return { totals: saved ? this.parseTotals(saved.totals) : empty(), partialHistory: false }
  }
  private updateTotals(root: string, update: (totals: LifetimeTotals) => LifetimeTotals, revise = false) {
    const meta = this.get(`SELECT CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals,revision FROM meta WHERE id=1`)!
    const totals = JSON.stringify(update(this.parseTotals(meta.totals)))
    const conversation = update(this.conversation(root).totals)
    if (!count(meta.revision + 1)) throw new HistoryInvalid("History revision overflow")
    if (revise || totals !== meta.totals) this.run("UPDATE meta SET totals=?,revision=revision+1 WHERE id=1", totals)
    this.run("UPDATE conversation_totals SET totals=? WHERE id=?", JSON.stringify(conversation), root)
  }
  private contribute(key: string, delta: LifetimeTotals, root: string) {
    if (this.get("SELECT id FROM contributions WHERE id=?", key)) return
    this.updateTotals(root, totals => add(totals, delta))
    this.run("INSERT INTO contributions VALUES (?)", key)
  }
  private countOutcome(entry: string, root: string, outcome: HistoryOutcome | undefined, at: number) {
    const previous = this.get("SELECT * FROM permission_statistics WHERE id=?", entry)
    if (previous) {
      validatePermissionStatistic(previous as any)
      if (previous.root !== root) throw new HistoryInvalid("Conflicting permission statistics ownership")
    }
    const next = permissionStatistic(outcome), prior = previous?.outcome ?? "other"
    if (prior === next) return
    this.updateTotals(root, totals => replacePermissionStatistic(totals, prior, next, at), true)
    this.run(`INSERT INTO permission_statistics VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome,at=excluded.at`,
      entry, root, next, at)
  }
  private event(e: Exclude<HistoryEvent, { type: "sessionDeleted" }>) {
    const c = e.context, root = rootID(c), session = sessionID(c)
    const context = e.context, review = reviewID(context), entry = entryID(context)
    if (!this.get("SELECT id FROM conversation_totals WHERE id=?", root)) {
      this.conversation(root)
      this.run("INSERT INTO conversation_totals VALUES (?,?)", root, JSON.stringify(empty()))
    }
    const existingSession = this.get("SELECT root FROM sessions WHERE id=?", session)
    if (existingSession && existingSession.root !== root) throw new HistoryInvalid("Conflicting session ownership")
    this.run("INSERT OR IGNORE INTO sessions VALUES (?,?)", session, root)
    const existing = this.get(`SELECT superseded,CASE WHEN length(CAST(context AS BLOB))<=${bytes.context} THEN context END AS context FROM reviews WHERE id=?`, review)
    if (existing) {
      if (typeof existing.context !== "string") throw new HistoryInvalid("Invalid review identity")
      const prior = JSON.parse(existing.context)
      if (Object.keys(context).some(key => prior[key] !== context[key as keyof HistoryReview])) throw new HistoryInvalid("Conflicting review identity")
    }
    const pendingOwner = this.get("SELECT root,session FROM reviews WHERE entry=? LIMIT 1", entry)
    if (pendingOwner && (pendingOwner.root !== root || pendingOwner.session !== session)) throw new HistoryInvalid("Conflicting permission ownership")
    this.run("INSERT OR IGNORE INTO reviews (id,entry,root,session,context,reviewer_version,opencode_version) VALUES (?,?,?,?,?,?,?)",
      review, entry, root, session, JSON.stringify(context), e.versions?.reviewer ?? null, e.versions?.opencode ?? null)
    const delta = historyDelta(e)
    if (e.type === "attemptDispatched" || e.type === "attemptFinalized") {
      const attempt = opaque(review, e.attempt)
      this.run("INSERT OR IGNORE INTO attempts VALUES (?,?,NULL,NULL)", attempt, review)
      if (e.type === "attemptDispatched") this.run("UPDATE attempts SET dispatched=COALESCE(dispatched,?) WHERE id=?", JSON.stringify({ at: e.at, retry: e.retry }), attempt)
      else this.run("UPDATE attempts SET finalized=COALESCE(finalized,?) WHERE id=?", JSON.stringify({ at: e.at, usage: e.usage, reportedModel: e.reportedModel }), attempt)
      this.contribute(opaque(e.type, attempt), delta, root)
    } else if (e.type === "toolDispatched") {
      const call = opaque(review, e.call)
      this.run("INSERT OR IGNORE INTO retrieval_calls VALUES (?,?,?,?)", call, review, e.at, e.tool ?? null)
      this.contribute(opaque(e.type, call), delta, root)
    } else if (e.type === "rejectionConfirmed") {
      this.run("INSERT OR IGNORE INTO auto_rejections VALUES (?,?,?,?,?,?)", entry, root, session, review, e.steering, e.at)
      this.countOutcome(entry, root, "rejected", e.at)
      this.revision(root)
      // Multiple writers may confirm the same native resolution.
      const key = opaque(e.type, entry)
      if (!this.get("SELECT id FROM contributions WHERE id=?", key)) {
        this.run("INSERT INTO contributions VALUES (?)", key)
        for (const id of [AUTO_REJECTION_LIFETIME, root])
          this.run("INSERT INTO auto_rejection_totals VALUES (?,1) ON CONFLICT(id) DO UPDATE SET count=count+1", id)
        this.run("UPDATE meta SET revision=revision+1 WHERE id=1")
      }
    } else if (e.type === "reviewAccepted") {
      this.run("UPDATE reviews SET accepted=COALESCE(accepted,?) WHERE id=?", JSON.stringify(e.accepted), review)
      this.contribute(opaque(e.type, review), delta, root)
    } else if (e.type === "approvalConfirmed" || e.type === "approvalDispatched" || e.type === "approvalSettled") {
      const id = opaque(entry, e.approval)
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
      this.countOutcome(entry, root, this.outcome(entry), e.at); this.revision(root)
      if (e.type === "approvalConfirmed" && e.automatic) {
        this.contribute(opaque("approvalConfirmed", entry), delta, root)
      }
    } else if (e.type === "permissionResolved" || e.type === "permissionOutcome") {
      const old = this.get("SELECT id,root,session,review,completed,resolution FROM history WHERE entry=?", entry)
      if (old && (old.root !== root || old.session !== session || old.review !== old.id)) throw new HistoryInvalid("Conflicting saved report identity")
      if (e.type === "permissionOutcome" && !old) return
      const prior = old?.resolution
      const resolution = !prior || prior === "cancelled" ? e.outcome : e.outcome === "cancelled" ? prior
        : prior === "conflict" || ((prior === "rejected") !== (e.outcome === "rejected")) ? "conflict"
        : prior === "auto" || e.outcome === "auto" ? "auto"
        : prior === "manual" || e.outcome === "manual" ? "manual" : e.outcome
      if (e.type === "permissionResolved" && !existing?.superseded && (!old || old.id === review || e.payload.completedAt >= old.completed)) {
        const id = review
        if (old && old.id !== id) {
          this.run("DELETE FROM history WHERE id=?", old.id)
          this.run("UPDATE reviews SET reason=NULL,superseded=1 WHERE id=?", old.review)
        }
        if (e.reason) this.run("UPDATE reviews SET reason=COALESCE(reason,?) WHERE id=?", e.reason, review)
        this.run(`INSERT INTO history VALUES (?,?,?,?,?,?,NULL,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET
          completed=excluded.completed,resolution=excluded.resolution,resolvedAt=excluded.resolvedAt
          WHERE completed IS NOT excluded.completed OR resolution IS NOT excluded.resolution OR resolvedAt IS NOT excluded.resolvedAt`,
          id, root, session, e.payload.completedAt, context.review, review, resolution, e.at, entry)
        // An identical body needs no privacy checkpoint for replaced text.
        this.run("INSERT INTO payloads VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE body IS NOT excluded.body", id, JSON.stringify(e.payload))
      }
      this.run("UPDATE history SET resolution=? WHERE entry=? AND resolution IS NOT ?", resolution, entry, resolution)
      this.countOutcome(entry, root, this.outcome(entry), e.at); this.revision(root)
    }
  }
  private outcome(entry: string): HistoryOutcome | undefined {
    const row = this.get("SELECT resolution FROM history WHERE entry=?", entry)
    const auto = this.get("SELECT review FROM approvals WHERE entry=? AND state='confirmed' AND automatic=1 ORDER BY id LIMIT 1", entry)
    const manual = this.get("SELECT review FROM approvals WHERE entry=? AND state='confirmed' AND automatic=0 ORDER BY id LIMIT 1", entry)
    if (!row) return auto ? "auto" : manual ? "manual" : undefined
    const uncertain = this.get("SELECT id FROM approvals WHERE entry=? AND state IN ('pending','uncertain') LIMIT 1", entry)
    const outcome = row.resolution === "conflict" || (row.resolution === "rejected" && (auto || manual)) ? null
      : row.resolution === "rejected" ? "rejected" : auto ? "auto" : manual ? "manual"
      : row.resolution === "cancelled" && uncertain ? null : row.resolution
    const resolution = row.resolution === "approved" ? auto ? "auto" : manual ? "manual" : row.resolution : row.resolution
    const approving = auto?.review ?? manual?.review ?? null
    this.run(`UPDATE history SET outcome=?,approving=?,resolution=? WHERE entry=?
      AND (outcome IS NOT ? OR approving IS NOT ? OR resolution IS NOT ?)`, outcome, approving, resolution, entry, outcome, approving, resolution)
    return outcome ?? undefined
  }
  query(q: HistoryQuery): HistoryResult {
    validateQuery(q)
    return this.transaction(() => {
      if (q.type === "totals") {
        const row = this.get(`SELECT revision,CASE WHEN length(CAST(totals AS BLOB))<=${bytes.totals} THEN totals END AS totals FROM meta WHERE id=1`)!
        if (!count(row.revision)) throw new HistoryInvalid("Invalid aggregate revision")
        const conversation = q.conversation && this.conversation(rootID(q.conversation))
        return { revision: row.revision, totals: this.withAutoRejected(this.parseTotals(row.totals), AUTO_REJECTION_LIFETIME),
          ...(conversation ? { conversation: { ...conversation, totals: this.withAutoRejected(conversation.totals, rootID(q.conversation!)) } } : {}) }
      }
      if (q.type === "conversationTotals") {
        const revision = this.get("SELECT revision FROM meta WHERE id=1")!.revision
        if (!count(revision)) throw new HistoryInvalid("Invalid aggregate revision")
        const conversation = this.conversation(rootID(q))
        return { revision, ...conversation, totals: this.withAutoRejected(conversation.totals, rootID(q)) }
      }
      if (q.type === "resolution") {
        const entry = opaque(q.permission), root = rootID(q), session = sessionID(q)
        const invalid = this.get(`SELECT 1 AS invalid FROM approvals WHERE entry=? AND
          (root!=? OR session!=? OR state NOT IN ('pending','confirmed','uncertain','not-sent') OR automatic NOT IN (-1,0,1)
          OR (state='confirmed' AND automatic=-1)) LIMIT 1`, entry, root, session)
        const invalidReview = this.get("SELECT 1 AS invalid FROM reviews WHERE entry=? AND (root!=? OR session!=?) LIMIT 1", entry, root, session)
        const rejection = this.get(`SELECT a.root,a.session,r.entry AS reviewEntry,r.root AS reviewRoot,r.session AS reviewSession
          FROM auto_rejections a LEFT JOIN reviews r ON r.id=a.review WHERE a.entry=?`, entry)
        const history = this.get(`SELECT CASE WHEN length(root)=64 THEN root END AS root,
          CASE WHEN length(session)=64 THEN session END AS session,
          CASE WHEN length(CAST(resolution AS BLOB))<=16 THEN resolution END AS resolution FROM history WHERE entry=?`, entry)
        if (invalid || invalidReview || (rejection && (rejection.root !== root || rejection.session !== session
          || rejection.reviewEntry !== entry || rejection.reviewRoot !== root || rejection.reviewSession !== session))
          || (history && (history.root !== root || history.session !== session
          || !["auto", "manual", "approved", "rejected", "cancelled", "conflict"].includes(history.resolution)))) throw new HistoryInvalid("Invalid resolution ownership")
        const auto = !!this.get("SELECT id FROM approvals WHERE entry=? AND state='confirmed' AND automatic=1 LIMIT 1", entry)
        const manual = !!this.get("SELECT id FROM approvals WHERE entry=? AND state='confirmed' AND automatic=0 LIMIT 1", entry)
        const uncertain = !!this.get("SELECT id FROM approvals WHERE entry=? AND state IN ('pending','uncertain') LIMIT 1", entry)
        const rejected = !!rejection || history?.resolution === "rejected"
        const conflict = history?.resolution === "conflict" || (rejected && (auto || manual
          || ["auto", "manual", "approved"].includes(history?.resolution)))
        const outcome = conflict ? undefined : rejected ? "rejected" : auto ? "auto" : manual ? "manual"
          : ["auto", "manual", "approved", "rejected"].includes(history?.resolution) ? history!.resolution : undefined
        return { outcome, uncertain, conflict, deleted: false }
      }
      const root = rootID(q), revision = this.get("SELECT revision FROM roots WHERE id=?", root)?.revision ?? 0
      const base = "root=? AND outcome IS NOT NULL"
      const generation = this.get("SELECT generation FROM history_generations WHERE id=?", root)?.generation ?? 0
      if (!count(generation) || !count(revision)) throw new HistoryInvalid("Invalid history index")
      let index = this.browsing.get(root, generation)
      if (!index) {
        // Validate once per structural generation, never caching selected text.
        const invalid = this.get(`SELECT id FROM history WHERE root=? AND
          (typeof(completed)!='integer' OR completed<0 OR completed>8640000000000000 OR length(id)!=64 OR length(session)!=64 OR length(entry)!=64
          OR length(review)!=64
          OR typeof(tie)!='text' OR length(tie)=0 OR length(CAST(tie AS BLOB))>${HISTORY_TEXT_BYTES}
          OR length(CAST(resolution AS BLOB))>16 OR length(approving)>64
          OR outcome NOT IN ('auto','manual','approved','rejected','cancelled')) LIMIT 1`, root)
        const invalidOwner = this.get(`SELECT h.id FROM history h LEFT JOIN reviews r ON r.id=h.review
          LEFT JOIN sessions s ON s.id=h.session WHERE h.root=? AND
          (r.id IS NULL OR r.entry!=h.entry OR r.root!=h.root OR r.session!=h.session OR s.id IS NULL OR s.root!=h.root) LIMIT 1`, root)
        if (invalid || invalidOwner) throw new HistoryInvalid("Invalid history index")
        const total = this.get(`SELECT count(*) AS n FROM history WHERE ${base}`, root)!.n
        if (!count(total)) throw new HistoryInvalid("History count overflow")
        index = this.browsing.save(root, generation, total)
      }
      const total = index.total
      const byID = (id: string | null) => id === null ? undefined : this.get(`SELECT * FROM history WHERE ${base} AND id=?`, root, id)
      const seek = (row?: Row, newer = false) => {
        const order = newer ? "ASC" : "DESC"
        return this.get(`SELECT * FROM history WHERE ${base}
          ${row ? `AND (completed,tie,id) ${newer ? ">" : "<"} (?,?,?)` : ""}
          ORDER BY completed ${order},tie ${order},id ${order} LIMIT 1`, root, ...(row ? [row.completed, row.tie, row.id] : []))
      }
      let selected: Row | undefined
      if (q.permission) selected = this.get(`SELECT * FROM history WHERE ${base} AND entry=? AND session=?
        ORDER BY completed DESC,tie DESC,id DESC LIMIT 1`, root, opaque(q.permission.permission), sessionID({ ...q, session: q.permission.session }))
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
      if (s.id !== s.review || s.review !== opaque(s.tie)) throw new HistoryInvalid("Invalid history ownership")
      const rank = index.ranks.get(s.id) ?? this.get(`SELECT count(*) AS n FROM history WHERE ${base} AND (completed,tie,id)<=(?,?,?)`, root, s.completed, s.tie, s.id)!.n
      if (!count(rank) || rank < 1 || rank > total) throw new HistoryInvalid("Invalid history rank")
      this.browsing.rank(index, s.id, rank)
      const result: HistorySelection = { revision, total, rank, entry: s.id, order: { completed: s.completed, tie: s.tie, id: s.id }, older: adjacent(s, false)?.id, newer: adjacent(s, true)?.id }
      const contextRow = this.get(`SELECT CASE WHEN length(CAST(context AS BLOB))<=${bytes.context} THEN context END AS context FROM reviews WHERE id=? AND root=? AND session=?`, s.review, root, s.session)
      if (typeof contextRow?.context !== "string") throw new HistoryInvalid("Invalid history ownership")
      const context: HistoryReview = JSON.parse(contextRow.context); validateReview(context)
      if (rootID(context) !== root || sessionID(context) !== s.session
        || entryID(context) !== s.entry
        || reviewID(context) !== s.review) throw new HistoryInvalid("Invalid history ownership")
      result.session = context.session
      try {
        const body = this.get(`SELECT CASE WHEN length(CAST(body AS BLOB))<=${bytes.payload} THEN body END AS body FROM payloads WHERE id=?`, s.id)?.body
        if (typeof body !== "string" || Buffer.byteLength(body) > bytes.payload) throw new Error()
        const payload = validatePayload(JSON.parse(body))
        if (payload.completedAt !== s.completed) throw new Error()
        result.record = { context, payload, outcome: s.outcome, approvingReview: s.approving ?? undefined, ...this.steeringDetails(s.review, s.entry) }
      } catch { result.unreadable = true }
      return result
    }, false)
  }
  cleanup(): HistoryCleanup { return cleanupHistory(this.db) }
  close() { this.db.close() }
}
