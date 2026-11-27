import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { privateDatabase } from "./history-private-path.js"
import { initializeHistoryPragmas } from "./history-sqlite-init.js"
import type { HistoryDatabase } from "./history-schema.js"
import type { JSONObject, JSONValue } from "./host-types.js"

export const DECISION_LEDGER_FILE = "decisions-v1.sqlite"
/** Rows kept before the oldest resolved rows are pruned. Capacity failure blocks dispatch. */
export const DECISION_LEDGER_CAPACITY = 4096
export type DecisionState = "observed" | "cancelled" | "reserved" | "sent" | "resolved"
/** `owner` is the runtime instance that observed the request's birth. Only that
 * owner may ever dispatch it. `fingerprint` is empty until evidence validated. */
export interface DecisionRow { key: string; owner: string; fingerprint: string; state: DecisionState; at: number }
export class DecisionLedgerUnavailable extends Error {}

/** Deterministic encoding: sorted object keys, arrays in order, no undefined. */
export function canonicalJSON(value: JSONValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJSON(item)).join(",")}]`
  const object = value as JSONObject
  const keys = Object.keys(object).filter(key => object[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJSON(object[key]!)}`).join(",")}}`
}

/** The ledger key of one scoped permission. */
export function decisionKey(location: { directory: string; workspaceID?: string }, sessionID: string, requestID: string): string {
  return createHash("sha256").update(canonicalJSON({ v: 1, directory: location.directory, workspaceID: location.workspaceID ?? null, sessionID, requestID })).digest("hex")
}

export interface DecisionIdentity {
  location: { directory: string; workspaceID?: string }
  request: { id: string; sessionID: string; action: string; resources: readonly string[]; save?: readonly string[]; metadata?: JSONValue
    source?: { assistantID: string; id: string }; message?: string }
  invocation: { assistantID: string; callID: string; tool: string; input: JSONValue }
  /** Identities of possible inner Code Mode calls, never their inputs. */
  candidates?: readonly string[]
}

/** Versioned, raw-input-free identity of the exact request and bound invocation.
 * Inputs enter only as a digest, never as text. */
export function decisionFingerprint(identity: DecisionIdentity): string {
  const digest = (value: JSONValue) => createHash("sha256").update(canonicalJSON(value)).digest("hex")
  const encoded = canonicalJSON({
    v: 1,
    directory: identity.location.directory, workspaceID: identity.location.workspaceID ?? null,
    sessionID: identity.request.sessionID, requestID: identity.request.id, action: identity.request.action,
    resources: [...identity.request.resources], save: identity.request.save ? [...identity.request.save] : null,
    metadata: identity.request.metadata === undefined ? null : digest(identity.request.metadata),
    source: identity.request.source ? [identity.request.source.assistantID, identity.request.source.id] : null,
    message: identity.request.message ?? null,
    invocation: [identity.invocation.assistantID, identity.invocation.callID, identity.invocation.tool, digest(identity.invocation.input)],
    candidates: identity.candidates ? [...identity.candidates].sort() : null,
  })
  return createHash("sha256").update(encoded).digest("hex")
}

function openDatabase(file: string): HistoryDatabase {
  const require = createRequire(import.meta.url)
  return process.versions.bun ? new (require("bun:sqlite").Database)(file) : new (require("node:sqlite").DatabaseSync)(file)
}

const STATES = ["observed", "cancelled", "reserved", "sent", "resolved"] as const

/** Bounded private record of decisions that must survive an engine restart.
 * Every write is synchronous and committed before the caller proceeds. The
 * ledger is a decision gate, never accounting or history. Automatic dispatch
 * needs a positive record: the request's birth observed by this same owner and
 * the fingerprint recorded when its evidence validated. An absent row is never
 * evidence of safety. Every transition is conditional inside one transaction. */
export class DecisionLedger {
  private statements = new Map<string, ReturnType<HistoryDatabase["prepare"]>>()
  private closed = false
  constructor(private db: HistoryDatabase) {
    initializeHistoryPragmas(db)
    db.exec(`CREATE TABLE IF NOT EXISTS decisions (key TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL
      CHECK(state IN ('observed','cancelled','reserved','sent','resolved')), at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS decisions_state_at ON decisions(state,at)`)
  }

  /** Open the ledger in the reviewer state root. Ancestors and sidecars must be private. */
  static open(stateRoot: string, construct: (file: string) => HistoryDatabase = openDatabase): DecisionLedger {
    const file = path.join(stateRoot, "opencode-reviewer", DECISION_LEDGER_FILE)
    try { privateDatabase(file, true, [DECISION_LEDGER_FILE]) }
    catch (error) { throw new DecisionLedgerUnavailable(error instanceof Error ? error.message : "Decision ledger path unavailable") }
    const db = construct(file)
    try { return new DecisionLedger(db) } catch (error) { db.close(); throw error }
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }

  private row(key: string): DecisionRow | undefined {
    const row = this.statement("SELECT key,owner,fingerprint,state,at FROM decisions WHERE key=?").get(key)
    if (!row) return
    if (typeof row.owner !== "string" || typeof row.fingerprint !== "string" || !STATES.includes(row.state)
      || !Number.isSafeInteger(row.at)) throw new DecisionLedgerUnavailable("Invalid decision record")
    return { key, owner: row.owner, fingerprint: row.fingerprint, state: row.state, at: row.at }
  }

  read(key: string): DecisionRow | undefined { return this.row(key) }

  /** Whether this owner may still dispatch the request automatically: its birth
   * was observed by this owner and the recorded fingerprint equals the current one. */
  dispatchable(key: string, owner: string, fingerprint: string): boolean {
    const row = this.row(key)
    return !!row && row.state === "observed" && row.owner === owner && fingerprint.length > 0 && row.fingerprint === fingerprint
  }

  /** One conditional transition. `allowed` decides from the current row (undefined when absent)
   * whether the write may happen. Returns false when it may not. */
  private transition(key: string, allowed: (row: DecisionRow | undefined) => boolean, next: (row: DecisionRow | undefined) => Omit<DecisionRow, "key">): boolean {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const current = this.row(key)
      if (!allowed(current)) { this.db.exec("ROLLBACK"); return false }
      const total = this.statement("SELECT count(*) AS n FROM decisions").get().n
      if (!Number.isSafeInteger(total)) throw new DecisionLedgerUnavailable("Invalid decision ledger")
      if (!current && total >= DECISION_LEDGER_CAPACITY) {
        this.statement(`DELETE FROM decisions WHERE key IN (SELECT key FROM decisions WHERE state='resolved' ORDER BY at LIMIT ?)`)
          .run(total - DECISION_LEDGER_CAPACITY + 1)
        const remaining = this.statement("SELECT count(*) AS n FROM decisions").get().n
        if (remaining >= DECISION_LEDGER_CAPACITY) throw new DecisionLedgerUnavailable("Decision ledger capacity exhausted")
      }
      const value = next(current)
      this.statement(`INSERT INTO decisions VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,fingerprint=excluded.fingerprint,state=excluded.state,at=excluded.at`)
        .run(key, value.owner, value.fingerprint, value.state, value.at)
      this.db.exec("COMMIT")
      return true
    } catch (error) {
      try { this.db.exec("ROLLBACK") } catch { /* Already rolled back. */ }
      throw error instanceof DecisionLedgerUnavailable ? error : new DecisionLedgerUnavailable("Decision ledger write failed")
    }
  }

  /** The request's birth was observed by `owner`. A row of any other state is kept:
   * an earlier cancel, reservation or write for this key stays authoritative. */
  observe(key: string, owner: string, at = Date.now()): boolean {
    return this.transition(key, row => !row || row.state === "resolved", () => ({ owner, fingerprint: "", state: "observed", at }))
  }

  /** The evidence of an observed request validated. Recorded once per owner. */
  fingerprint(key: string, owner: string, fingerprint: string, at = Date.now()): boolean {
    if (!fingerprint) return false
    return this.transition(key, row => !!row && row.state === "observed" && row.owner === owner && (row.fingerprint === "" || row.fingerprint === fingerprint),
      () => ({ owner, fingerprint, state: "observed", at }))
  }

  /** Durable before acknowledgement. A cancelled request is never dispatched later. */
  cancel(key: string, owner: string, fingerprint: string, at = Date.now()) {
    this.transition(key, row => !row || row.state === "observed" || row.state === "cancelled",
      row => ({ owner, fingerprint: fingerprint || row?.fingerprint || "", state: "cancelled", at }))
  }

  /** Immediately before the native call. Fails unless this owner observed the request
   * and the fingerprint still matches. */
  reserve(key: string, owner: string, fingerprint: string, at = Date.now()) {
    const ok = this.transition(key, row => !!row && row.state === "observed" && row.owner === owner && fingerprint.length > 0 && row.fingerprint === fingerprint,
      () => ({ owner, fingerprint, state: "reserved", at }))
    if (!ok) throw new DecisionLedgerUnavailable("Decision not dispatchable")
  }

  /** The native call was invoked. Uncertain outcomes keep this state forever. */
  sent(key: string, at = Date.now()) {
    const ok = this.transition(key, row => !!row && row.state === "reserved", row => ({ ...row!, state: "sent", at }))
    if (!ok) throw new DecisionLedgerUnavailable("Decision was not reserved")
  }

  /** Native resolution observed: the permission no longer exists. Only this state frees the key. */
  resolve(key: string, at = Date.now()) {
    this.transition(key, row => !!row, row => ({ ...row!, state: "resolved", at }))
  }

  close() { if (this.closed) return; this.closed = true; this.db.close() }
}
