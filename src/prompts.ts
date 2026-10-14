import { constants, readFileSync } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import path from "node:path"
import inventory from "./prompt-files.json" with { type: "json" }
import type { ReviewKind } from "./types.js"

type PromptName = keyof typeof inventory

export type PromptSet = Readonly<Record<ReviewKind, Readonly<{ instructions: string }>>> & Readonly<{ extraCareful: string }>
const kinds = ["shell", "edit", "external-directory", "skill", "tool"] as const

// The build embeds these files; direct source tests read the same Markdown.
declare const __REVIEW_PROMPTS__: Record<PromptName, string> | undefined

function prompt(name: PromptName): string {
  if (typeof __REVIEW_PROMPTS__ !== "undefined") return __REVIEW_PROMPTS__[name]
  return readFileSync(new URL(`../${inventory[name]}`, import.meta.url), "utf8").trim()
}

export const BUILTIN_PROMPTS: PromptSet = Object.freeze({
  extraCareful: prompt("extraCareful"),
  shell: Object.freeze({ instructions: prompt("shell") }),
  edit: Object.freeze({ instructions: prompt("edit") }),
  "external-directory": Object.freeze({ instructions: prompt("external-directory") }),
  skill: Object.freeze({ instructions: prompt("skill") }),
  tool: Object.freeze({ instructions: prompt("tool") }),
})
export const CONTRACT = prompt("contract")
export const CORRECTION = prompt("correction")

export function correctionPrompt(validationError: string): string {
  return CORRECTION.replaceAll("{{validationError}}", () => validationError)
}

/** One startup snapshot; absent named files inherit built-ins, invalid ones fail. */
export async function loadPrompts(directory: string | undefined, signal: AbortSignal): Promise<PromptSet> {
  signal.throwIfAborted()
  if (directory === undefined) return BUILTIN_PROMPTS
  if (!path.isAbsolute(directory) || directory.includes("\u0000")) throw new Error("instructions must be an absolute prompt-directory path")
  let entries: string[]
  try { entries = await readdir(directory) }
  catch { signal.throwIfAborted(); throw new Error("Prompt directory is unavailable or is not a directory") }
  signal.throwIfAborted()
  if (entries.some((name) => name.endsWith("-CONTRACT.md"))) throw new Error("Contract prompt overrides are not allowed; contracts are fixed in the plugin")
  const legacy = entries.filter((name) => name.endsWith("-REVIEW-CORRECTION.md"))
  if (legacy.length) throw new Error(`Correction contracts are fixed; remove legacy override files: ${legacy.map((name) => JSON.stringify(name)).join(", ")}`)
  const result = { ...BUILTIN_PROMPTS }
  for (const kind of kinds) {
    const instructions = await override(directory, path.basename(inventory[kind]), signal) ?? BUILTIN_PROMPTS[kind].instructions
    result[kind] = Object.freeze({ instructions })
  }
  result.extraCareful = await override(directory, path.basename(inventory.extraCareful), signal) ?? result.extraCareful
  signal.throwIfAborted()
  return Object.freeze(result)
}

async function override(directory: string, name: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted()
  const filename = path.join(directory, name)
  // lstat distinguishes an absent override from a supplied dangling symlink.
  try { await lstat(filename) }
  catch (error) {
    signal.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(`Cannot inspect prompt file ${name}`)
  }
  signal.throwIfAborted()
  try {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      signal.throwIfAborted()
      const before = await handle.stat()
      signal.throwIfAborted()
      if (!before.isFile() || before.size > 65536) throw new Error("invalid prompt file")
      const bytes = Buffer.alloc(65537)
      let size = 0
      while (size < bytes.length) {
        signal.throwIfAborted()
        const read = await handle.read(bytes, size, bytes.length - size, size)
        signal.throwIfAborted()
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size > 65536) throw new Error("prompt too large")
      const after = await handle.stat()
      signal.throwIfAborted()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("prompt changed during read")
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)).trim()
      if (!text || text.includes("\u0000")) throw new Error("empty or binary prompt")
      return text
    } finally { await handle.close() }
  } catch {
    signal.throwIfAborted()
    throw new Error(`Invalid prompt file ${name}: require readable, stable, nonempty regular UTF-8 text up to 64 KiB`)
  }
}
