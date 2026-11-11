import { constants, type Dirent } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileFailure, physicalPath, type FileIO } from "./file-access.js"
import type { JSONObject, JSONValue } from "./host-types.js"

/** Server-side retrieval operations. Paths come from the reviewer model; every
 * result echoes what was tried so the model can correct itself. No skip list,
 * no directory descent through symlinks, no shell or subprocess. */
import { retrievalToolNames } from "./companion-protocol.js"
export { retrievalToolNames }
export type RetrievalToolName = typeof retrievalToolNames[number]
export interface RetrievalCall { tool: RetrievalToolName; arguments: JSONObject }
export interface RetrievalContext {
  /** Absolute base for relative paths. */
  base: string
  home: string
  maxBytes: number
  io: FileIO
  signal: AbortSignal
  /** Monotonic time after which list/glob/grep return partial results. */
  softEnd: number
}

export const maxEntries = 500
const maxPatternLength = 1024
const maxGrepFileBytes = 16 * 1024 * 1024
const maxMatchText = 1000
const readChunk = 65536

type Result = { [key: string]: JSONValue }
const error = (tool: string, reason: string, paths: JSONObject = {}): Result => ({ tool, status: "error", ...paths, reason })

/** Strict argument validation shared by every caller of the executor. */
export function retrievalArguments(tool: string, value: unknown): { ok: true; args: JSONObject } | { ok: false; reason: string } {
  if (!retrievalToolNames.includes(tool as RetrievalToolName)) return { ok: false, reason: "unknown tool" }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid arguments: expected an object" }
  const args = value as JSONObject
  const allowed: Record<RetrievalToolName, Record<string, "string" | "integer" | "boolean">> = {
    read: { path: "string", offset: "integer", limit: "integer" },
    list: { path: "string", limit: "integer" },
    glob: { pattern: "string", path: "string", limit: "integer" },
    grep: { pattern: "string", path: "string", include: "string", ignoreCase: "boolean", limit: "integer" },
  }
  const schema = allowed[tool as RetrievalToolName]
  for (const [key, item] of Object.entries(args)) {
    const type = schema[key]
    if (!type) return { ok: false, reason: `invalid arguments: unknown field ${JSON.stringify(key)}` }
    if (type === "integer" ? !Number.isSafeInteger(item) || (item as number) < 1 : typeof item !== type)
      return { ok: false, reason: `invalid arguments: ${key} must be ${type === "integer" ? "a positive integer" : `a ${type}`}` }
    if (key === "limit" && tool !== "read" && (item as number) > maxEntries)
      return { ok: false, reason: `invalid arguments: limit must be at most ${maxEntries}` }
    if (type === "string" && (!(item as string) || (item as string).includes("\0") || (item as string).length > 16384))
      return { ok: false, reason: `invalid arguments: ${key} must be a nonempty string without NUL` }
  }
  const required = tool === "read" || tool === "list" ? "path" : "pattern"
  if (typeof args[required] !== "string") return { ok: false, reason: `invalid arguments: ${required} is required` }
  return { ok: true, args }
}

/** Absolute paths stay as given, ~ uses the server HOME, relative paths join the base
 * without lexical normalization (the physical lookup resolves .. after symlinks). */
export function absoluteRetrievalPath(requested: string, base: string, home: string): string {
  if (requested === "~") return home
  if (requested.startsWith("~/")) return `${home}/${requested.slice(2)}`
  return path.isAbsolute(requested) ? requested : `${base.replace(/\/+$/, "")}/${requested}`
}

function escapeRegExp(text: string) { return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&") }

/** Minimal glob: **, *, ?, [set], [!set], {a,b}. Matches whole relative paths. */
export function globSource(glob: string): string {
  let source = ""
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") { i++; source += "(?:[^/]*/)*" } else source += ".*"
      } else source += "[^/]*"
    } else if (char === "?") source += "[^/]"
    else if (char === "[") {
      const end = glob.indexOf("]", i + 2)
      if (end < 0) { source += "\\["; continue }
      let body = glob.slice(i + 1, end)
      if (body.startsWith("!")) body = `^${body.slice(1)}`
      source += `[${body.replace(/\\/g, "\\\\")}]`
      i = end
    } else if (char === "{") {
      let depth = 0, end = -1
      for (let j = i; j < glob.length; j++) {
        if (glob[j] === "{") depth++
        else if (glob[j] === "}" && --depth === 0) { end = j; break }
      }
      if (end < 0) { source += "\\{"; continue }
      const parts: string[] = []
      let level = 0, start = i + 1
      for (let j = i + 1; j < end; j++) {
        if (glob[j] === "{") level++
        else if (glob[j] === "}") level--
        else if (glob[j] === "," && !level) { parts.push(glob.slice(start, j)); start = j + 1 }
      }
      parts.push(glob.slice(start, end))
      source += `(?:${parts.map(globSource).join("|")})`
      i = end
    } else source += escapeRegExp(char)
  }
  return source
}

function globMatcher(glob: string, basenameOnly: boolean): (relative: string) => boolean {
  const pattern = new RegExp(`^${globSource(glob)}$`)
  return basenameOnly ? relative => pattern.test(relative.slice(relative.lastIndexOf("/") + 1)) : relative => pattern.test(relative)
}

/** Breadth-first walk. Symlinked directories are reported, never descended. */
async function walk(root: string, context: RetrievalContext,
  visit: (relative: string, entry: Dirent) => Promise<boolean> | boolean): Promise<{ timedOut: boolean; unreadable: number }> {
  const queue = [""], list = context.io.readdir ?? ((directory: string) => readdir(directory, { withFileTypes: true }))
  let unreadable = 0
  while (queue.length) {
    context.signal.throwIfAborted()
    if (performance.now() >= context.softEnd) return { timedOut: true, unreadable }
    const directory = queue.shift()!
    let entries: Dirent[]
    try { entries = await list(directory ? `${root}/${directory}` : root) }
    catch { context.signal.throwIfAborted(); unreadable++; continue }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name
      if (!await visit(relative, entry)) return { timedOut: false, unreadable }
      if (entry.isDirectory()) queue.push(relative)
    }
  }
  return { timedOut: false, unreadable }
}

const entryType = (entry: Dirent) => entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other"

/** Drop trailing array items until the serialized result fits. */
function fit(result: Result, key: string, maxBytes: number): Result {
  const items = result[key] as JSONValue[]
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && items.length) {
    items.splice(Math.min(items.length - 1, Math.floor(items.length * 0.9)))
    result.truncated = true
  }
  return result
}

async function resolved(tool: string, requested: string, context: RetrievalContext) {
  const absolute = absoluteRetrievalPath(requested, context.base, context.home)
  try {
    const canonical = await physicalPath(absolute, context.io, context.signal)
    context.signal.throwIfAborted()
    return { paths: { path: requested, absolutePath: absolute, canonicalPath: canonical }, canonical }
  } catch (failure) {
    context.signal.throwIfAborted()
    return { failure: error(tool, fileFailure(failure), { path: requested, absolutePath: absolute }) }
  }
}

async function readTool(args: JSONObject, context: RetrievalContext): Promise<Result> {
  const target = await resolved("read", args.path as string, context)
  if ("failure" in target) return target.failure!
  const { paths, canonical } = target
  const offset = (args.offset as number | undefined) ?? 1, limit = args.limit as number | undefined
  // Leave room for the JSON envelope; content is charged at its JSON-escaped size.
  const budget = context.maxBytes - Buffer.byteLength(JSON.stringify({ tool: "read", status: "ok", ...paths,
    startLine: offset, endLine: Number.MAX_SAFE_INTEGER, totalLines: Number.MAX_SAFE_INTEGER, truncated: true,
    nextOffset: Number.MAX_SAFE_INTEGER, content: "" }))
  if (budget <= 0) return error("read", "result size limit leaves no room for content", paths)
  let handle
  try { handle = await context.io.open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW) }
  catch (failure) { context.signal.throwIfAborted(); return error("read", fileFailure(failure), paths) }
  try {
    const before = await handle.stat()
    context.signal.throwIfAborted()
    if (!before.isFile()) return error("read", "not a regular file", paths)
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    const buffer = Buffer.alloc(readChunk)
    let position = 0, line = 0, pending = "", skipping = false, content = "", cost = 0
    let endLine = offset - 1, stopped = false, eof = false
    while (!stopped && !eof) {
      context.signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      context.signal.throwIfAborted()
      position += bytesRead
      eof = bytesRead === 0
      let text: string
      try { text = decoder.decode(buffer.subarray(0, bytesRead), { stream: !eof }) }
      catch { return error("read", "invalid UTF-8", paths) }
      if (text.includes("\0")) return error("read", "binary content", paths)
      pending += text
      let start = 0
      for (;;) {
        const newline = pending.indexOf("\n", start)
        if (newline < 0 && !(eof && start < pending.length)) break
        const stop = newline < 0 ? pending.length : newline + 1
        const value = pending.slice(start, stop)
        start = stop
        if (skipping) { skipping = false; line++; continue }
        line++
        if (line < offset) continue
        if (limit !== undefined && line >= offset + limit) { stopped = true; break }
        const size = Buffer.byteLength(JSON.stringify(value)) - 2
        if (cost + size > budget) {
          if (line === offset) return error("read", "line exceeds result size limit", paths)
          stopped = true; break
        }
        content += value; cost += size; endLine = line
      }
      pending = pending.slice(start)
      // Even an unfinished next line proves the requested window is truncated.
      // Do not skip an oversized tail and later mistake its EOF for a full read.
      if (!stopped && pending && limit !== undefined && line + 1 >= offset + limit) stopped = true
      // An unterminated line beyond the budget is either an error (in range) or skipped.
      if (!stopped && Buffer.byteLength(pending) > budget) {
        if (line + 1 >= offset && (limit === undefined || line + 1 < offset + limit)) {
          if (line + 1 === offset) return error("read", "line exceeds result size limit", paths)
          stopped = true
        } else { pending = ""; skipping = true }
      }
    }
    if (skipping) line++
    const after = await handle.stat()
    context.signal.throwIfAborted()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      return error("read", "file changed while reading", paths)
    if (!stopped && offset > 1 && line < offset) return error("read", `offset beyond end of file (${line} lines)`, paths)
    return { tool: "read", status: "ok", ...paths, startLine: offset, endLine, ...(stopped ? {} : { totalLines: line }),
      truncated: stopped, ...(stopped ? { nextOffset: endLine + 1 } : {}), content }
  } finally { await handle.close() }
}

async function listTool(args: JSONObject, context: RetrievalContext): Promise<Result> {
  const target = await resolved("list", args.path as string, context)
  if ("failure" in target) return target.failure!
  const { paths, canonical } = target
  let entries: Dirent[]
  try { entries = await (context.io.readdir ?? ((directory: string) => readdir(directory, { withFileTypes: true })))(canonical) }
  catch (failure) { context.signal.throwIfAborted(); return error("list", fileFailure(failure), paths) }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const stat = context.io.lstat ?? lstat
  const limit = (args.limit as number | undefined) ?? maxEntries
  const listed: JSONObject[] = []
  let timedOut = false
  for (const entry of entries.slice(0, limit)) {
    context.signal.throwIfAborted()
    if (performance.now() >= context.softEnd) { timedOut = true; break }
    const item: { [key: string]: JSONValue } = { name: entry.name, type: entryType(entry) }
    if (entry.isFile()) try { item.size = (await stat(`${canonical}/${entry.name}`)).size } catch { context.signal.throwIfAborted() }
    listed.push(item)
  }
  return fit({ tool: "list", status: "ok", ...paths, entries: listed, truncated: entries.length > listed.length,
    ...(timedOut ? { timedOut } : {}) }, "entries", context.maxBytes)
}

async function globTool(args: JSONObject, context: RetrievalContext): Promise<Result> {
  const pattern = args.pattern as string
  if (pattern.length > maxPatternLength || path.isAbsolute(pattern))
    return error("glob", "invalid arguments: pattern must be relative to path and at most 1024 characters")
  const target = await resolved("glob", (args.path as string | undefined) ?? context.base, context)
  if ("failure" in target) return target.failure!
  const { paths, canonical } = target
  const matches = globMatcher(pattern, false), found: string[] = []
  const limit = (args.limit as number | undefined) ?? maxEntries
  let truncated = false
  const walked = await walk(canonical, context, (relative) => {
    if (!matches(relative)) return true
    if (found.length >= limit) { truncated = true; return false }
    found.push(`${canonical}/${relative}`)
    return true
  })
  return fit({ tool: "glob", status: "ok", ...paths, pattern, matches: found, truncated,
    ...(walked.timedOut ? { timedOut: true, truncated: true } : {}),
    ...(walked.unreadable ? { unreadableDirectories: walked.unreadable } : {}) }, "matches", context.maxBytes)
}

/** Matching runs in a disposable worker so a pathological expression cannot
 * block the server's event loop; the worker is terminated at the soft deadline. */
const matcherSource = `
const { parentPort, workerData } = require("node:worker_threads")
const expression = new RegExp(workerData.pattern, workerData.flags)
parentPort.on("message", ({ text, limit, width }) => {
  const matches = []
  let line = 0
  for (let start = 0; start < text.length && matches.length < limit;) {
    const end = text.indexOf("\\n", start), stop = end < 0 ? text.length : end
    line++
    const value = text.slice(start, stop)
    expression.lastIndex = 0
    if (expression.test(value)) matches.push([line, value.length > width ? value.slice(0, width) : value])
    if (end < 0) break
    start = end + 1
  }
  parentPort.postMessage(matches)
})`

async function grepTool(args: JSONObject, context: RetrievalContext): Promise<Result> {
  const pattern = args.pattern as string, flags = args.ignoreCase ? "i" : ""
  if (pattern.length > maxPatternLength) return error("grep", "invalid arguments: pattern exceeds 1024 characters")
  try { new RegExp(pattern, flags) } catch { return error("grep", "invalid arguments: invalid regular expression") }
  const include = args.include as string | undefined
  if (include !== undefined && include.length > maxPatternLength) return error("grep", "invalid arguments: include exceeds 1024 characters")
  const included = include === undefined ? () => true : globMatcher(include, !include.includes("/"))
  const target = await resolved("grep", (args.path as string | undefined) ?? context.base, context)
  if ("failure" in target) return target.failure!
  const { paths, canonical } = target
  const matches: JSONObject[] = [], skipped = { binary: 0, invalidUtf8: 0, unreadable: 0, large: 0 }
  const limit = (args.limit as number | undefined) ?? maxEntries
  let truncated = false, timedOut = false
  const worker = new Worker(matcherSource, { eval: true, env: {}, workerData: { pattern, flags } })
  const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()))
  const search = async (file: string): Promise<boolean> => {
    let handle
    try { handle = await context.io.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW) }
    catch { context.signal.throwIfAborted(); skipped.unreadable++; return true }
    let text: string
    try {
      const info = await handle.stat()
      if (!info.isFile()) return true
      if (info.size > maxGrepFileBytes) { skipped.large++; return true }
      const bytes = Buffer.alloc(info.size + 1)
      let size = 0
      for (;;) {
        context.signal.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size)
        if (!bytesRead || (size += bytesRead) >= bytes.length) break
      }
      if (size > info.size) { skipped.large++; return true }
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)) }
      catch { skipped.invalidUtf8++; return true }
    } catch { context.signal.throwIfAborted(); skipped.unreadable++; return true }
    finally { await handle.close() }
    if (text.includes("\0")) { skipped.binary++; return true }
    const wait = context.softEnd - performance.now()
    if (wait <= 0) { timedOut = true; return false }
    const found = await new Promise<[number, string][] | undefined>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(undefined) }, wait)
      const message = (value: [number, string][]) => { cleanup(); resolve(value) }
      const failed = (failure: unknown) => { cleanup(); reject(failure) }
      const cleanup = () => { clearTimeout(timer); worker.off("message", message); worker.off("error", failed) }
      worker.on("message", message); worker.on("error", failed)
      worker.postMessage({ text, limit: limit - matches.length + 1, width: maxMatchText })
    })
    if (!found) { timedOut = true; return false }
    for (const [line, value] of found) {
      if (matches.length >= limit) { truncated = true; return false }
      matches.push({ path: file, line, text: value })
    }
    return true
  }
  try {
    const info = await (context.io.lstat ?? lstat)(canonical)
    let walked = { timedOut: false, unreadable: 0 }
    if (info.isFile()) await search(canonical)
    else walked = await walk(canonical, context, (relative, entry) =>
      !entry.isFile() || !included(relative) ? true : search(`${canonical}/${relative}`))
    return fit({ tool: "grep", status: "ok", ...paths, pattern, ...(include === undefined ? {} : { include }),
      matches, truncated: truncated || timedOut || walked.timedOut, ...(timedOut || walked.timedOut ? { timedOut: true } : {}),
      skipped: { ...skipped, ...(walked.unreadable ? { unreadableDirectories: walked.unreadable } : {}) } }, "matches", context.maxBytes)
  } catch (failure) {
    context.signal.throwIfAborted()
    return error("grep", fileFailure(failure), paths)
  } finally {
    await worker.terminate()
    await exited
  }
}

/** Execute one validated retrieval call. Never throws for ordinary filesystem
 * failures; aborts and deadlines propagate to the owner. */
export async function runRetrievalTool(call: RetrievalCall, context: RetrievalContext): Promise<Result> {
  context.signal.throwIfAborted()
  const parsed = retrievalArguments(call.tool, call.arguments)
  if (!parsed.ok) return error(call.tool, parsed.reason)
  const run = call.tool === "read" ? readTool : call.tool === "list" ? listTool : call.tool === "glob" ? globTool : grepTool
  return run(parsed.args, context)
}
