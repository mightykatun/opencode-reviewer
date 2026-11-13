import type { Limits, ReviewKind } from "./types.js"
import path from "node:path"
import { parseNotificationConfig, type NotificationConfig } from "./notification-config.js"

export interface ModelConnection {
  baseURL: string
  model: string
  apiKey?: string
  apiKeyEnv?: string
}

export interface Config extends ModelConnection, Limits, NotificationConfig {
  retrievalBaseURL?: string
  retrievalModel?: string
  retrievalApiKey?: string
  retrievalApiKeyEnv?: string
  instructions?: string
  stream: boolean
  reviewBash: boolean
  reviewEdits: boolean
  reviewSkills: boolean
  reviewTools: boolean
  reviewExternalDirectories: boolean
  /** Master switch; retrievalKinds selects categories. */
  retrieval: boolean
  retrievalKinds: Record<RetrievalKind, boolean>
  /** Lets the retriever ask the root conversation's own model once per review. */
  retrievalClarification: boolean
  maxRetrievalRounds: number
  retrievalTimeoutMs: number
  autoApprove: boolean
  /** Unsafe reports with steering are rejected natively with that steering. Independent of autoApprove. */
  autoRejectSteering: boolean
  /** Consecutive steering rejections per session before Unsafe waits for the user again. */
  maxSteeringRejections: number
  fastMode: boolean
  extraCareful: boolean
  autoApproveDelaySeconds: number
  formatRetries: number
  timeoutMs: number
  maxOutputTokens: number
}

export const retrievalKinds = ["bash", "edit", "skill", "tool", "external_directory"] as const
export type RetrievalKind = typeof retrievalKinds[number]
const retrievalDefaults: Record<RetrievalKind, boolean> = { bash: true, edit: false, skill: true, tool: true, external_directory: true }

/** Config keys mirror saved history categories and native action names. */
export function retrievalKind(kind: ReviewKind): RetrievalKind {
  return kind === "shell" ? "bash" : kind === "external-directory" ? "external_directory" : kind
}

export function retrievalEnabled(config: Pick<Config, "retrieval" | "retrievalKinds">, kind: ReviewKind): boolean {
  return config.retrieval && config.retrievalKinds[retrievalKind(kind)]
}

/** Credentials are inherited as a pair, and only for the same normalized endpoint. */
export function retrievalConnection(config: Config): ModelConnection {
  const baseURL = config.retrievalBaseURL ?? config.baseURL
  const ownCredentials = config.retrievalApiKey !== undefined || config.retrievalApiKeyEnv !== undefined
  const inherit = !ownCredentials && baseURL === config.baseURL
  return { baseURL, model: config.retrievalModel ?? config.model,
    apiKey: inherit ? config.apiKey : config.retrievalApiKey,
    apiKeyEnv: inherit ? config.apiKeyEnv : config.retrievalApiKeyEnv }
}

export type ReviewOptions = Pick<Config, "reviewBash" | "reviewEdits"> & Partial<Pick<Config,
  "reviewSkills" | "reviewTools" | "reviewExternalDirectories">>

/** Local instruction editing remains available when unrelated configuration fails. */
export function configuredEvidenceBytes(options: Readonly<Record<string, unknown>>): number {
  const value = options.maxEvidenceBytes === undefined ? 131072 : options.maxEvidenceBytes
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024) {
    throw new Error("maxEvidenceBytes must be an integer between 1 and 16777216")
  }
  return value
}

export function parseConfig(options: Record<string, unknown> = {}): Config {
  const keys = new Set(["baseURL", "model", "apiKey", "apiKeyEnv", "retrievalBaseURL", "retrievalModel", "retrievalApiKey", "retrievalApiKeyEnv", "instructions", "stream", "reviewBash", "reviewEdits", "reviewSkills", "reviewTools", "reviewExternalDirectories", "retrieval", "retrievalKinds", "retrievalClarification", "maxRetrievalRounds", "retrievalTimeoutMs", "autoApprove", "autoRejectSteering", "maxSteeringRejections", "fastMode", "extraCareful", "autoApproveDelaySeconds", "formatRetries", "timeoutMs", "maxOutputTokens", "maxFiles", "maxEvidenceBytes", "notify", "notifySound", "notificationSoundDirectory", "staleReminderSeconds", "notifications"])
  for (const key of Object.keys(options)) if (!keys.has(key)) throw new Error(`Unknown opencode-reviewer setting: ${key}`)
  const text = (name: string, optional = false): string | undefined => {
    const value = options[name]
    if (value === undefined && optional) return undefined
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`)
    return value.trim()
  }
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = options[name] === undefined ? fallback : options[name]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`)
    }
    return value
  }
  const boolean = (name: string, fallback = true) => {
    const value = options[name] === undefined ? fallback : options[name]
    if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
    return value
  }
  const endpoint = (name: string, optional = false) => {
    if (optional && options[name] === undefined) return
    let url: URL
    try { url = new URL(text(name)!) } catch { throw new Error(`${name} must be an HTTP(S) API base URL`) }
    // search/hash are empty for bare delimiters, but href retains them.
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) {
      throw new Error(`${name} must use HTTP(S) without embedded credentials, query, or fragment`)
    }
    return url.href.replace(/\/+$/, "")
  }
  const baseURL = endpoint("baseURL")!
  const kinds = options.retrievalKinds === undefined ? {} : options.retrievalKinds
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds) || ![Object.prototype, null].includes(Object.getPrototypeOf(kinds))) {
    throw new Error("retrievalKinds must be an object")
  }
  for (const key of Object.keys(kinds)) {
    if (!retrievalKinds.some(kind => kind === key)) throw new Error(`Unknown retrievalKinds key: ${key}`)
  }
  const selected = Object.fromEntries(retrievalKinds.map(kind => {
    const value = Object.hasOwn(kinds, kind) ? (kinds as Record<string, unknown>)[kind] : retrievalDefaults[kind]
    if (typeof value !== "boolean") throw new Error(`retrievalKinds.${kind} must be a boolean`)
    return [kind, value]
  })) as Record<RetrievalKind, boolean>
  const keyEnvironment = (name: string) => {
    const value = text(name, true)
    if (value && !/^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) throw new Error(`${name} must be an environment-variable name`)
    return value
  }
  const apiKeyEnv = keyEnvironment("apiKeyEnv")
  const instructions = text("instructions", true)
  if (instructions && (!path.isAbsolute(instructions) || instructions.includes("\u0000"))) {
    throw new Error("instructions must be an absolute prompt-directory path; inline instructions are no longer supported")
  }
  return {
    ...parseNotificationConfig(options),
    baseURL,
    model: text("model")!, apiKeyEnv,
    apiKey: text("apiKey", true),
    retrievalBaseURL: endpoint("retrievalBaseURL", true), retrievalModel: text("retrievalModel", true),
    retrievalApiKey: text("retrievalApiKey", true), retrievalApiKeyEnv: keyEnvironment("retrievalApiKeyEnv"),
    instructions,
    stream: boolean("stream", false),
    reviewBash: boolean("reviewBash"),
    reviewEdits: boolean("reviewEdits"),
    reviewSkills: boolean("reviewSkills"),
    reviewTools: boolean("reviewTools"),
    reviewExternalDirectories: boolean("reviewExternalDirectories"),
    retrieval: boolean("retrieval"), retrievalKinds: selected,
    retrievalClarification: boolean("retrievalClarification"),
    maxRetrievalRounds: number("maxRetrievalRounds", 3, 1, 50),
    retrievalTimeoutMs: number("retrievalTimeoutMs", 60000, 1, 3600000),
    autoApprove: boolean("autoApprove", false),
    autoRejectSteering: boolean("autoRejectSteering", false),
    maxSteeringRejections: number("maxSteeringRejections", 1, 1, 100),
    fastMode: boolean("fastMode", false),
    extraCareful: boolean("extraCareful"),
    autoApproveDelaySeconds: number("autoApproveDelaySeconds", 15, 0, 3600),
    formatRetries: number("formatRetries", 1, 0, 100),
    timeoutMs: number("timeoutMs", 120000, 1, 3600000),
    maxOutputTokens: number("maxOutputTokens", 4096, 1, Number.MAX_SAFE_INTEGER),
    maxFiles: number("maxFiles", 6, 1, 1000),
    maxEvidenceBytes: configuredEvidenceBytes(options),
  }
}
