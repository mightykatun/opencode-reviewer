import type { Limits } from "./types.js"
import path from "node:path"
import { parseNotificationConfig, type NotificationConfig } from "./notification-config.js"

export interface Config extends Limits, NotificationConfig {
  baseURL: string
  model: string
  apiKey?: string
  apiKeyEnv?: string
  instructions?: string
  stream: boolean
  reviewBash: boolean
  reviewEdits: boolean
  reviewSkills: boolean
  reviewTools: boolean
  reviewExternalDirectories: boolean
  autoApprove: boolean
  fastMode: boolean
  extraCareful: boolean
  autoApproveDelaySeconds: number
  formatRetries: number
  timeoutMs: number
  maxOutputTokens: number
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
  const keys = new Set(["baseURL", "model", "apiKey", "apiKeyEnv", "instructions", "stream", "reviewBash", "reviewEdits", "reviewSkills", "reviewTools", "reviewExternalDirectories", "autoApprove", "fastMode", "extraCareful", "autoApproveDelaySeconds", "formatRetries", "timeoutMs", "maxOutputTokens", "maxFiles", "maxEvidenceBytes", "notify", "notifySound", "notificationSoundDirectory", "staleReminderSeconds", "notifications"])
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
  let url: URL
  try { url = new URL(text("baseURL")!) } catch { throw new Error("baseURL must be an HTTP(S) API base URL") }
  // search/hash are empty for bare delimiters, but href retains them.
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) {
    throw new Error("baseURL must use HTTP(S) without embedded credentials, query, or fragment")
  }
  const apiKeyEnv = text("apiKeyEnv", true)
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z_0-9]*$/.test(apiKeyEnv)) throw new Error("apiKeyEnv must be an environment-variable name")
  const instructions = text("instructions", true)
  if (instructions && (!path.isAbsolute(instructions) || instructions.includes("\u0000"))) {
    throw new Error("instructions must be an absolute prompt-directory path; inline instructions are no longer supported")
  }
  return {
    ...parseNotificationConfig(options),
    baseURL: url.href.replace(/\/+$/, ""),
    model: text("model")!, apiKeyEnv,
    apiKey: text("apiKey", true),
    instructions,
    stream: boolean("stream", false),
    reviewBash: boolean("reviewBash"), reviewEdits: boolean("reviewEdits"),
    reviewSkills: boolean("reviewSkills"),
    reviewTools: boolean("reviewTools"),
    reviewExternalDirectories: boolean("reviewExternalDirectories"),
    autoApprove: boolean("autoApprove", false),
    fastMode: boolean("fastMode", false),
    extraCareful: boolean("extraCareful"),
    autoApproveDelaySeconds: number("autoApproveDelaySeconds", 15, 0, 3600),
    formatRetries: number("formatRetries", 1, 0, 100),
    timeoutMs: number("timeoutMs", 30000, 1, 3600000),
    maxOutputTokens: number("maxOutputTokens", 4096, 1, Number.MAX_SAFE_INTEGER),
    maxFiles: number("maxFiles", 6, 1, 1000),
    maxEvidenceBytes: configuredEvidenceBytes(options),
  }
}
