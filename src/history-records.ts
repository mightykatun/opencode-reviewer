import { createHash } from "node:crypto"
import path from "node:path"
import type { Usage } from "./usage.js"
import type { ReviewTiming } from "./types.js"

export const HISTORY_EVENT_BYTES = 512 * 1024
export const HISTORY_QUEUE_BYTES = 64 * 1024 * 1024
export const HISTORY_OPERATION_OVERHEAD = 512
export const HISTORY_RETRY_MS = 2000
export const HISTORY_TEXT_BYTES = 4096
export const HISTORY_DESCRIPTION_BYTES = 65536
// JSON can expand one UTF-8 byte into six ASCII bytes (e.g. U+0001).
// These are serialized ceilings, not replacements for decoded shape validation.
const stringBytes = (bytes: number) => 2 + 6 * bytes
const objectBytes = (fields: Record<string, number>) => 2 + Object.entries(fields)
  .reduce((sum, [key, bytes]) => sum + JSON.stringify(key).length + 1 + bytes + 1, 0)
const numberBytes = 24 // Covers every finite nonnegative JSON number, including exponents.
const textBytes = stringBytes(HISTORY_TEXT_BYTES)
const usageBytes = objectBytes({ input: numberBytes, output: numberBytes, cost: numberBytes })
const acceptedFields = { safe: 5, completedAt: numberBytes, reportedModel: textBytes,
  timing: objectBytes({ fullReportMs: numberBytes, ratingMs: numberBytes }) }
export const HISTORY_RECORD_BYTES = {
  context: objectBytes({ scope: textBytes, root: textBytes, session: textBytes, permission: textBytes,
    review: textBytes, category: JSON.stringify("external_directory").length, configuredModel: textBytes, provider: textBytes }),
  accepted: objectBytes(acceptedFields),
  dispatched: objectBytes({ at: numberBytes, retry: JSON.stringify("transport").length }),
  finalized: objectBytes({ at: numberBytes, usage: usageBytes, reportedModel: textBytes }),
  payload: objectBytes({ ...acceptedFields, desc: stringBytes(HISTORY_DESCRIPTION_BYTES), usage: usageBytes }),
  totals: objectBytes({ requests: numberBytes, tokenRequests: numberBytes, input: numberBytes, output: numberBytes,
    priced: numberBytes, cost: numberBytes, since: numberBytes, safe: numberBytes, unsafe: numberBytes, ratingsSince: numberBytes,
    activity: objectBytes({ reviews: numberBytes, usageRequests: numberBytes, retries: numberBytes, autoApproved: numberBytes,
      manuallyApproved: numberBytes, rejected: numberBytes,
      timedReviews: numberBytes, meanFullReportMs: numberBytes, meanRatingMs: numberBytes, since: numberBytes }) }),
} as const
export class HistoryInvalid extends Error {}
export interface HistoryScope { scope: string; root: string; session: string }
export interface HistoryReview extends HistoryScope {
  permission: string; review: string; category: "bash" | "edit" | "mcp" | "custom" | "external_directory" | "skill" | "registered-tool" | "tool"
  configuredModel: string; provider: string
}
/** Notification targets identify a permission; saved reports have distinct review IDs. */
export type HistoryTarget = Pick<HistoryReview, "session" | "permission">
export interface HistoryAccepted { safe: boolean; completedAt: number; reportedModel?: string; timing?: ReviewTiming }
export interface HistoryPayload extends HistoryAccepted { desc: string; usage?: Usage }
export type HistoryOutcome = "auto" | "manual" | "approved" | "rejected" | "cancelled"
export type HistoryEvent =
  | { type: "attemptDispatched"; context: HistoryReview; at: number; attempt: string; retry: "initial" | "transport" | "format" }
  | { type: "attemptFinalized"; context: HistoryReview; at: number; attempt: string; usage?: Usage; reportedModel?: string }
  | { type: "reviewAccepted"; context: HistoryReview; at: number; accepted: HistoryAccepted }
  | { type: "approvalDispatched"; context: HistoryReview; at: number; approval: string; automatic: boolean }
  | { type: "approvalSettled"; context: HistoryReview; at: number; approval: string; result: "not-sent" | "uncertain" }
  | { type: "approvalConfirmed"; context: HistoryReview; at: number; approval: string; automatic: boolean }
  | { type: "permissionResolved"; context: HistoryReview; at: number; outcome: HistoryOutcome; payload: HistoryPayload }
  | { type: "permissionOutcome"; context: HistoryReview; at: number; outcome: "approved" | "manual" | "rejected" }
  | { type: "sessionDeleted"; context: HistoryScope; at: number }
export interface HistoryOrder { completed: number; tie: string; id: string }
export type HistoryQuery =
  | { type: "totals"; conversation?: { scope: string; root: string } }
  | { type: "conversationTotals"; scope: string; root: string }
  | { type: "history"; scope: string; root: string; entry?: string; permission?: HistoryTarget; direction?: "older" | "newer"; order?: HistoryOrder }
  | { type: "sessions"; scope: string; after?: string; limit?: number }
  | { type: "resolution"; scope: string; root: string; session: string; permission: string }
  | { type: "session"; scope: string; session: string }

export const opaque = (...parts: string[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
export const entryID = (c: HistoryReview): string => opaque(c.scope, c.permission)
export const rootID = (c: Pick<HistoryScope, "scope" | "root">): string => opaque(c.scope, c.root)
export const sessionID = (c: HistoryScope): string => opaque(c.scope, c.session)
export const reviewID = (c: HistoryReview): string => opaque(c.scope, c.review)
export const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
function requireValue(ok: unknown): asserts ok { if (!ok) throw new HistoryInvalid("Invalid history record") }
function object(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  requireValue(v && typeof v === "object" && !Array.isArray(v))
  requireValue(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  requireValue(Reflect.ownKeys(v).every(k => {
    const descriptor = Object.getOwnPropertyDescriptor(v, k)!
    return typeof k === "string" && keys.includes(k) && descriptor.enumerable && "value" in descriptor
  }))
}
function text(v: unknown, max = HISTORY_TEXT_BYTES): asserts v is string {
  requireValue(typeof v === "string" && v.trim().length > 0 && Buffer.byteLength(v) <= max && !v.includes("\0"))
}
function timestamp(v: unknown) { requireValue(count(v) && v <= 8.64e15) }
export function validateScope(c: HistoryScope): void {
  text(c.scope); requireValue(path.isAbsolute(c.scope)); text(c.root); text(c.session)
}
export function validateReview(c: HistoryReview): void {
  object(c, ["scope", "root", "session", "permission", "review", "category", "configuredModel", "provider"])
  validateScope(c); text(c.permission); text(c.review); text(c.configuredModel); text(c.provider)
  requireValue(["bash", "edit", "mcp", "custom", "external_directory", "skill", "registered-tool", "tool"].includes(c.category))
  const url = new URL(c.provider)
  requireValue(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    && url.href.replace(/\/+$/, "") === c.provider)
}
function usage(v: Usage): void {
  object(v, ["input", "output", "cost"])
  requireValue((v.input === undefined && v.output === undefined) || (count(v.input) && count(v.output)))
  requireValue(v.cost === undefined || amount(v.cost))
  requireValue(v.input !== undefined || v.cost !== undefined)
}
function accepted(v: HistoryAccepted, payload = false): void {
  object(v, ["safe", "completedAt", "reportedModel", "timing", ...(payload ? ["desc", "usage"] : [])])
  requireValue(typeof v.safe === "boolean"); timestamp(v.completedAt)
  if (v.reportedModel !== undefined) text(v.reportedModel)
  if (v.timing !== undefined) {
    object(v.timing, ["fullReportMs", "ratingMs"])
    requireValue(amount(v.timing.fullReportMs) && amount(v.timing.ratingMs) && v.timing.ratingMs <= v.timing.fullReportMs)
  }
}
export function validatePayload(v: HistoryPayload): HistoryPayload {
  accepted(v, true)
  // Accepted assessment text may contain decoded controls. Preserve it verbatim;
  // displayText escapes those controls when either live or stored reports render.
  requireValue(typeof v.desc === "string" && v.desc.trim().length > 0 && Buffer.byteLength(v.desc) <= HISTORY_DESCRIPTION_BYTES)
  if (v.usage !== undefined) usage(v.usage)
  return v
}
/** Fixed shallow shapes bound decoding work and reject accidental evidence/credential fields. */
export function validateEvent(e: HistoryEvent): HistoryEvent {
  const extra: Record<HistoryEvent["type"], string[]> = {
    attemptDispatched: ["attempt", "retry"], attemptFinalized: ["attempt", "usage", "reportedModel"],
    reviewAccepted: ["accepted"], approvalDispatched: ["approval", "automatic"],
    approvalSettled: ["approval", "result"], approvalConfirmed: ["approval", "automatic"],
    permissionResolved: ["outcome", "payload"], permissionOutcome: ["outcome"], sessionDeleted: [],
  }
  requireValue(e && Object.hasOwn(extra, e.type)); object(e, ["type", "context", "at", ...extra[e.type]])
  timestamp(e.at)
  if (e.type === "sessionDeleted") { object(e.context, ["scope", "root", "session"]); validateScope(e.context); return e }
  validateReview(e.context)
  switch (e.type) {
    case "attemptDispatched": text(e.attempt); requireValue(["initial", "transport", "format"].includes(e.retry)); break
    case "attemptFinalized": text(e.attempt); if (e.usage !== undefined) usage(e.usage); if (e.reportedModel !== undefined) text(e.reportedModel); break
    case "reviewAccepted": accepted(e.accepted); break
    case "approvalDispatched": case "approvalConfirmed": text(e.approval); requireValue(typeof e.automatic === "boolean"); break
    case "approvalSettled": text(e.approval); requireValue(["not-sent", "uncertain"].includes(e.result)); break
    case "permissionResolved": requireValue(["auto", "manual", "approved", "rejected", "cancelled"].includes(e.outcome)); validatePayload(e.payload); break
    case "permissionOutcome": requireValue(["approved", "manual", "rejected"].includes(e.outcome)); break
  }
  return e
}
export function encodeEvent(e: HistoryEvent): string {
  try {
    validateEvent(e)
    const text = JSON.stringify(e)
    requireValue(Buffer.byteLength(text) <= HISTORY_EVENT_BYTES)
    // Getters/toJSON must not smuggle a different shape into the admitted FIFO.
    decodeEvent(text)
    return text
  } catch { throw new HistoryInvalid("Invalid history event") }
}
export function decodeEvent(text: string): HistoryEvent {
  requireValue(typeof text === "string" && Buffer.byteLength(text) <= HISTORY_EVENT_BYTES)
  try { return validateEvent(JSON.parse(text)) } catch { throw new HistoryInvalid("Invalid history event") }
}
export function validateQuery(q: HistoryQuery): void {
  requireValue(q && ["totals", "conversationTotals", "history", "sessions", "resolution", "session"].includes(q.type))
  if (q.type === "totals") {
    object(q, ["type", "conversation"])
    if (q.conversation !== undefined) {
      object(q.conversation, ["scope", "root"]); text(q.conversation.scope); text(q.conversation.root)
      requireValue(path.isAbsolute(q.conversation.scope))
    }
    return
  }
  text(q.scope); requireValue(path.isAbsolute(q.scope))
  if (q.type === "conversationTotals") { object(q, ["type", "scope", "root"]); text(q.root); return }
  if (q.type === "session") { object(q, ["type", "scope", "session"]); text(q.session); return }
  if (q.type === "resolution") {
    object(q, ["type", "scope", "root", "session", "permission"])
    validateScope(q); text(q.permission); return
  }
  if (q.type === "sessions") {
    object(q, ["type", "scope", "after", "limit"])
    if (q.after !== undefined) text(q.after)
    requireValue(q.limit === undefined || (count(q.limit) && q.limit > 0 && q.limit <= 100))
  } else {
    object(q, ["type", "scope", "root", "entry", "permission", "direction", "order"]); text(q.root)
    if (q.permission !== undefined) {
      object(q.permission, ["session", "permission"]); text(q.permission.session); text(q.permission.permission)
      requireValue(q.entry === undefined && q.direction === undefined && q.order === undefined)
    }
    if (q.order !== undefined) {
      object(q.order, ["completed", "tie", "id"]); timestamp(q.order.completed); text(q.order.tie)
      requireValue(q.entry && q.order.id === q.entry && /^[a-f0-9]{64}$/.test(q.order.id))
    }
    if (q.entry !== undefined) requireValue(/^[a-f0-9]{64}$/.test(q.entry))
    requireValue(q.direction === undefined || (q.entry && ["older", "newer"].includes(q.direction)))
  }
}
export function snapshotQuery(q: HistoryQuery): HistoryQuery {
  validateQuery(q)
  const copy: HistoryQuery = JSON.parse(JSON.stringify(q))
  validateQuery(copy)
  return copy
}
