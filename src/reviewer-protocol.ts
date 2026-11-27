import { Rpc } from "@opencode/plugin/rpc"

/** Proof that an HTTP endpoint dispatches to this exact plugin instance. */
export const identitySchema = {
  type: "object",
  properties: { nonce: { type: "string", format: "uuid" }, pid: { type: "integer", minimum: 1 } },
  required: ["nonce", "pid"], additionalProperties: false,
} as const
const empty = { type: "object", properties: {}, additionalProperties: false } as const
const text = { type: "string", minLength: 1, maxLength: 16384 } as const
const loose = { type: "object" } as const
const nullable = { anyOf: [{ type: "null" }, loose] } as const
const errors = { scope: empty, unavailable: empty } as const

/** Viewer controls name the exact permission and the attempt they saw. */
const controlInput = {
  type: "object",
  properties: { sessionID: text, permissionID: text, attempt: text, action: { enum: ["cancel", "expedite"] } },
  required: ["sessionID", "permissionID", "attempt", "action"], additionalProperties: false,
} as const
const controlOutput = {
  type: "object", properties: { result: { enum: ["accepted", "late", "unavailable", "resolved"] } },
  required: ["result"], additionalProperties: false,
} as const

/** The server reviewer's public RPC. The viewer and the server's own self-binding
 * share this contract. Outputs are nonsecret projections: no evidence bodies,
 * prompts, credentials or filesystem paths cross this boundary. Viewers never
 * nominate roots or paths; the server resolves the root of a named session. */
export const reviewerRpc = Rpc.define({
  id: "opencode-reviewer",
  methods: {
    identity: { input: empty, output: identitySchema },
    /** Current revision, hosting status, review availability, viewer settings and pending views. */
    snapshot: { input: empty, output: loose, errors },
    /** One indexed saved report of the named session's conversation. */
    history: {
      input: { type: "object", properties: { sessionID: text, entry: text, direction: { enum: ["older", "newer"] },
        order: loose, permission: { type: "object", properties: { session: text, permission: text }, required: ["session", "permission"], additionalProperties: false } },
        required: ["sessionID"], additionalProperties: false },
      output: nullable, errors,
    },
    /** Lifetime totals, with the named session's conversation totals when given. */
    statistics: { input: { type: "object", properties: { sessionID: text }, additionalProperties: false }, output: nullable, errors },
    /** Read or set the review mode of the named session's root conversation. */
    mode: {
      input: { type: "object", properties: { sessionID: text, set: { type: "boolean" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { root: text, enabled: { type: "boolean" } }, required: ["root", "enabled"], additionalProperties: false }, errors,
    },
    /** Read or replace the reviewer instructions of the named session's root conversation.
     * `limit` is the effective byte limit. A larger `set` is rejected with `invalid` before any write. */
    instructions: {
      input: { type: "object", properties: { sessionID: text, set: { type: "string", maxLength: 16 * 1024 * 1024 } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { root: text, text: { type: "string" }, limit: { type: "integer", minimum: 0 } }, required: ["root", "text", "limit"], additionalProperties: false },
      errors: { ...errors, invalid: empty },
    },
    control: { input: controlInput, output: controlOutput, errors },
    /** Bundled or configured sound bytes selected by kind, never by path. */
    sound: {
      input: { type: "object", properties: { kind: { enum: ["attention", "unsafe", "question", "approved", "error", "ended", "steered"] }, format: { enum: ["wav", "mp3"] } },
        required: ["kind"], additionalProperties: false },
      output: { anyOf: [{ type: "null" }, { type: "object", properties: { format: { enum: ["mp3", "wav"] }, data: { type: "string" } }, required: ["format", "data"], additionalProperties: false }] },
      errors,
    },
  },
  events: {
    /** Small invalidation. Subscribers fetch a fresh snapshot by revision. */
    changed: { schema: { type: "object", properties: { revision: { type: "integer", minimum: 0 } }, required: ["revision"], additionalProperties: false } },
  },
})

export interface ReviewerIdentity { nonce: string; pid: number }

export function readIdentity(value: unknown): ReviewerIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const { nonce, pid } = value as Record<string, unknown>
  if (typeof nonce !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(nonce)) return
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return
  return { nonce, pid }
}

export type HostingProjection = { status: "verified" } | { status: "unavailable"; reason: "unregistered" | "foreign" | "unreachable" }
export type ReviewProjection = { enabled: true } | { enabled: false; reason: "no-policy" | "invalid-policy" | "hosting" }

/** Nonsecret automation facts of the active server policy, so a viewer can tell an
 * advisory Safe report from one still waiting for its automatic decision. */
export interface AutomationProjection { autoApprove: boolean; autoRejectSteering: boolean; fastMode: boolean }

/** A confirmed automatic decision, kept briefly so a viewer that fetches the next
 * snapshot after the request vanished can still attribute it. */
export interface ConfirmedDecisionProjection { sessionID: string; permissionID: string; attempt: string; decision: "once" | "reject"; revision: number }

/** The server's snapshot of one location for viewers. `views` are controller
 * views in JSON form plus the attempt token that controls must name. The request
 * inside each view carries identity only: id, sessionID, action and source. */
export interface ReviewerSnapshot {
  revision: number
  location: { directory: string; workspaceID?: string }
  hosting: HostingProjection
  review: ReviewProjection
  /** Fixed validation text without filesystem paths. */
  reviewError?: string
  automation?: AutomationProjection
  tui?: unknown
  tuiError?: string
  views: readonly ReviewerViewProjection[]
  recent: readonly ConfirmedDecisionProjection[]
}

export interface ReviewerViewProjection {
  attempt: string
  root?: string
  /** Whether this request is the native head of its own session's queue. */
  head: boolean
  view: unknown
}
