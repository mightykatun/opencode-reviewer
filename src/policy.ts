import { constants, watch, type FSWatcher } from "node:fs"
import { open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseConfig, type Config } from "./config.js"
import { parseNotificationConfig, type NotificationConfig } from "./notification-config.js"
import { loadPrompts, type PromptSet } from "./prompts.js"
import { withDeadline } from "./deadline.js"
import { readPrivateRecord } from "./private-record.js"

/** Keys that belong to the viewer section. The server section rejects them. */
export const tuiPolicyKeys = ["notify", "notifySound", "notificationSoundDirectory", "staleReminderSeconds", "notifications"] as const
const MAX_POLICY_BYTES = 1024 * 1024
const PROMPT_LOAD_MS = 5000

export interface ServerPolicy { config: Config; prompts: PromptSet }
/** One validated reading of the reviewer file. Sections fail independently. */
export interface PolicySnapshot {
  file: string
  server?: ServerPolicy
  serverError?: string
  tui?: NotificationConfig
  tuiError?: string
}
export interface PolicyGeneration extends PolicySnapshot { id: number }
export interface PolicyChange { generation: PolicyGeneration; changed: { server: boolean; tui: boolean } }

/** The server user's reviewer file, never a terminal or project option. */
export function policyFile(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = environment.XDG_CONFIG_HOME
  const base = configured && path.isAbsolute(configured) && !configured.includes("\0") ? configured : path.join(home, ".config")
  if (!path.isAbsolute(base) || base.includes("\0")) throw new Error("Reviewer policy directory unavailable")
  return path.join(base, "opencode", "opencode-reviewer.json")
}

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** Top-level shape only: exactly the two optional sections. */
function parsePolicyObject(text: string) {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error("Reviewer policy is not valid JSON") }
  if (!plainObject(value)) throw new Error("Reviewer policy must be a JSON object with server and tui sections")
  for (const key of Object.keys(value)) if (key !== "server" && key !== "tui" && key !== "$schema") throw new Error(`Unknown reviewer policy section: ${key}`)
  return value
}

function sectionObject(value: unknown, name: "server" | "tui") {
  if (!plainObject(value)) throw new Error(`Reviewer policy ${name} must be an object`)
  return value
}

export function parsePolicySections(text: string): {
  server?: Record<string, unknown>
  tui?: Record<string, unknown>
} {
  const { server, tui } = parsePolicyObject(text)
  return {
    server: server === undefined ? undefined : sectionObject(server, "server"),
    tui: tui === undefined ? undefined : sectionObject(tui, "tui"),
  }
}

/** Validate the server section with today's review rules, without viewer keys. */
export function parseServerConfig(section: Record<string, unknown>): Config {
  for (const key of tuiPolicyKeys) if (key in section) throw new Error(`${key} belongs to the tui section of the reviewer policy`)
  return parseConfig(section)
}

/** Validate the viewer section alone. Unknown keys are rejected. */
export function parseTuiConfig(section: Record<string, unknown>): NotificationConfig {
  for (const key of Object.keys(section)) if (!tuiPolicyKeys.includes(key as typeof tuiPolicyKeys[number])) throw new Error(`Unknown tui setting: ${key}`)
  return parseNotificationConfig(section)
}

/** Credentials live in this file. Only a regular file owned by this user and
 * not writable by others is trusted. Validate and read the same descriptor. */
async function readTrustedPolicy(file: string, signal: AbortSignal): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return
    if (code === "ELOOP") throw new Error("Reviewer policy must not be a symlink")
    throw error
  }
  try {
    const target = await handle.stat()
    if (!target.isFile()) throw new Error("Reviewer policy must be a regular file")
    if (target.size > MAX_POLICY_BYTES) throw new Error("Reviewer policy exceeds 1 MiB")
    if (target.uid !== process.geteuid?.() || (target.mode & 0o022)) throw new Error("Reviewer policy must be owned by the current user and not writable by others")
    const bytes = await readPrivateRecord(handle, target.size + 1, signal)
    if (bytes.length !== target.size || (await handle.stat()).size !== target.size) throw new Error("Reviewer policy size changed during read")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally { await handle.close() }
}

/** One complete reading. A missing file is no policy. Invalid JSON or an
 * untrusted file invalidates both sections. Each section validates alone. */
export async function loadPolicy(file: string, signal: AbortSignal, promptLoader = loadPrompts): Promise<PolicySnapshot> {
  signal.throwIfAborted()
  let text: string | undefined
  try { text = await readTrustedPolicy(file, signal) }
  catch (error) {
    signal.throwIfAborted()
    const reason = message(error, "Reviewer policy unreadable")
    return { file, serverError: reason, tuiError: reason }
  }
  signal.throwIfAborted()
  if (text === undefined) return { file }
  let sections
  try { sections = parsePolicyObject(text) }
  catch (error) { const reason = message(error, "Reviewer policy invalid"); return { file, serverError: reason, tuiError: reason } }
  const snapshot: PolicySnapshot = { file }
  if (sections.server !== undefined) {
    try {
      const config = parseServerConfig(sectionObject(sections.server, "server"))
      const prompts = await withDeadline(signal, PROMPT_LOAD_MS, signal => promptLoader(config.instructions, signal), "Prompt configuration lookup")
      snapshot.server = { config, prompts }
    } catch (error) { signal.throwIfAborted(); snapshot.serverError = message(error, "Reviewer server policy invalid") }
  }
  if (sections.tui !== undefined) {
    try { snapshot.tui = parseTuiConfig(sectionObject(sections.tui, "tui")) }
    catch (error) { snapshot.tuiError = message(error, "Reviewer tui policy invalid") }
  }
  return snapshot
}

/** Effective values decide change, never timestamps. Secrets stay in memory. */
function sectionKey(value: unknown, error: string | undefined): string {
  return JSON.stringify([value ?? null, error ?? null])
}

export interface PolicyWatcherOptions {
  debounceMs?: number
  /** Retry interval while the directory or watcher is unavailable. */
  retryMs?: number
  load?: (file: string, signal: AbortSignal) => Promise<PolicySnapshot>
}

/** Publishes complete validated generations. Watching the directory covers
 * atomic replacement, creation and deletion. A failed watch falls back to a
 * bounded retry so a later file still takes effect without a restart. */
export class PolicyWatcher {
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private retry?: ReturnType<typeof setTimeout>
  private loading?: Promise<void>
  private dirty = false
  private generation = 0
  private latest?: PolicyGeneration
  private keys = { server: "", tui: "" }
  private readonly debounceMs: number
  private readonly retryMs: number
  private readonly load: NonNullable<PolicyWatcherOptions["load"]>
  private readonly controller = new AbortController()

  constructor(readonly file: string, private onChange: (change: PolicyChange) => void, parent: AbortSignal, options: PolicyWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? 250
    this.retryMs = options.retryMs ?? 5000
    this.load = options.load ?? loadPolicy
    parent.addEventListener("abort", () => this.dispose(), { once: true })
    if (parent.aborted) this.dispose()
  }

  get current() { return this.latest }

  /** Watch before reading so edits during startup also invalidate the reading. */
  async start(): Promise<PolicyGeneration> {
    this.controller.signal.throwIfAborted()
    this.observe()
    await this.reload()
    this.controller.signal.throwIfAborted()
    return this.latest!
  }

  private observe() {
    if (this.controller.signal.aborted || this.watcher) return
    const directory = path.dirname(this.file), name = path.basename(this.file)
    try {
      this.watcher = watch(directory, { persistent: false }, (_event, changed) => {
        if (changed === null || changed === undefined || changed.toString() === name) this.schedule()
      })
      this.watcher.on("error", () => { this.closeWatcher(); this.scheduleRetry() })
    } catch { this.scheduleRetry() }
  }

  private scheduleRetry() {
    if (this.controller.signal.aborted || this.retry) return
    this.retry = setTimeout(() => { this.retry = undefined; this.schedule(); this.observe() }, this.retryMs)
    this.retry.unref?.()
  }

  private closeWatcher() { try { this.watcher?.close() } catch {} this.watcher = undefined }

  private schedule() {
    if (this.controller.signal.aborted) return
    if (this.loading) {
      this.dirty = true
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.reload() }, this.debounceMs)
  }

  /** Readings are serialized. An edit during a read triggers one more read. */
  private reload(): Promise<void> {
    if (this.loading) { this.dirty = true; return this.loading }
    this.loading = (async () => {
      try {
        do {
          this.dirty = false
          let snapshot: PolicySnapshot
          try { snapshot = await this.load(this.file, this.controller.signal) }
          catch (error) {
            if (this.controller.signal.aborted) return
            const reason = message(error, "Reviewer policy unreadable")
            snapshot = { file: this.file, serverError: reason, tuiError: reason }
          }
          if (this.controller.signal.aborted) return
          if (!this.dirty) this.publish(snapshot)
        } while (this.dirty)
      } finally { this.loading = undefined }
    })()
    return this.loading
  }

  private publish(snapshot: PolicySnapshot) {
    const keys = { server: sectionKey(snapshot.server, snapshot.serverError), tui: sectionKey(snapshot.tui, snapshot.tuiError) }
    const changed = { server: keys.server !== this.keys.server, tui: keys.tui !== this.keys.tui }
    if (this.latest && !changed.server && !changed.tui) return
    this.keys = keys
    this.latest = Object.freeze({ id: ++this.generation, ...snapshot })
    try { this.onChange({ generation: this.latest, changed }) } catch {}
  }

  dispose() {
    this.controller.abort()
    if (this.timer) clearTimeout(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.timer = undefined; this.retry = undefined
    this.closeWatcher()
  }
}
