import path from "node:path"
import { constants } from "node:fs"
import type { Evidence, FileEvidence, Limits } from "./types.js"
import { FileLimit, omittedFile } from "./files.js"
import { fileAccess, fileFailure, type FileScope } from "./file-access.js"
import { discoverWithCandidates, type Reference } from "./shell-discovery.js"
import { ExcerptLines, LineExcerpt, excerptScanBytes, type Excerpt } from "./excerpts.js"
import { remainingTime, reviewStage } from "./deadline.js"
import type { FileHandle } from "node:fs/promises"

export { discover, discoverWithCandidates } from "./shell-discovery.js"

const directSourceExtension = /\.(?:py|sh|bash|zsh|ksh|js|mjs|cjs|jsx|ts|mts|cts|tsx|rb|pl|php|lua)$/i
const directSourceShebang = /^#!(?:\/(?:usr\/)?bin\/(?:python(?:[23](?:\.\d+)*)?|(?:ba|da|k|z)?sh|node|bun|deno|ruby|perl|php|lua)(?:\s|$)|\/usr\/bin\/env\s+(?:(?:-S\s+)?(?:python(?:[23](?:\.\d+)*)?|(?:ba|da|k|z)?sh|node|bun|deno|ruby|perl|php|lua))(?:\s|$))/
const unrecognizedDirectSource = "direct executable is not identifiable as supported script source; contents not provided"

function identifiableSource(filename: string, firstLine: string) {
  return directSourceExtension.test(filename) || directSourceShebang.test(firstLine.split("\n", 1)[0] ?? "")
}

async function captureExcerpt(handle: FileHandle, budget: number, signal: AbortSignal): Promise<
  { status: string } | { firstLine: string; contents?: string; excerpt?: Excerpt }> {
  const lines = new ExcerptLines(new LineExcerpt(budget, "source"))
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const buffer = Buffer.alloc(Math.min(65536, excerptScanBytes))
  let position = 0, firstLine = "", firstComplete = false, complete = false
  while (position < excerptScanBytes && remainingTime(signal) > 100) {
    reviewStage(signal, "File capture")
    const read = await handle.read(buffer, 0, Math.min(buffer.length, excerptScanBytes - position), position)
    reviewStage(signal, "File capture")
    let text: string
    try { text = decoder.decode(buffer.subarray(0, read.bytesRead), { stream: !!read.bytesRead }) }
    catch { return { status: "not valid UTF-8 source; contents not provided" } }
    if (text.includes("\u0000")) return { status: "binary content; contents not provided" }
    if (!firstComplete) {
      const end = text.indexOf("\n")
      firstLine += text.slice(0, end < 0 ? Math.max(0, 4096 - firstLine.length) : Math.min(end, Math.max(0, 4096 - firstLine.length)))
      firstComplete = end >= 0 || firstLine.length >= 4096
    }
    lines.push(text)
    if (!read.bytesRead) { complete = true; break }
    position += read.bytesRead
  }
  const result = lines.finish(complete)
  return { firstLine, ...result }
}

export async function captureFile(reference: Reference, budget: number, signal: AbortSignal, scope: FileScope): Promise<FileEvidence> {
  const result: FileEvidence = { filename: reference.filename, status: "unavailable" }
  if (!reference.cwd && !path.isAbsolute(reference.filename)) return { ...result, status: "working directory unresolved; contents not provided" }
  // Do not normalize `..` before the filesystem traverses preceding symlinks.
  const filename = path.isAbsolute(reference.filename) ? reference.filename : `${reference.cwd}/${reference.filename}`
  result.path = filename
  signal.throwIfAborted()
  try {
    const canonical = await scope.canonical(filename)
    signal.throwIfAborted()
    if (!canonical.path) return { ...result, status: `cannot read file (${canonical.reason}); contents not provided` }
    return await scope.capture(async (signal, io) => {
      const handle = await io.open(canonical.path!, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      try {
        signal.throwIfAborted()
        const before = await handle.stat()
        signal.throwIfAborted()
        if (!before.isFile()) return { ...result, status: "not a regular file; contents not provided" }
        if (before.size > budget) {
          const omitted = { ...result, status: "file too large for remaining evidence budget; contents not provided; assess risk accordingly" }
          if (budget <= 80) return omitted
          const excerpt = await captureExcerpt(handle, budget, signal)
          const after = await handle.stat()
          signal.throwIfAborted()
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
            return { ...result, status: "file changed while being read; contents not provided" }
          if ("status" in excerpt) return { ...result, status: excerpt.status }
          if (reference.executable && !identifiableSource(filename, excerpt.firstLine ?? ""))
            return { ...result, status: unrecognizedDirectSource }
          return excerpt.contents === undefined ? omitted : { ...result, status: "excerpt", contents: excerpt.contents, excerpt: excerpt.excerpt }
        }
        // Keep an overflow-probe byte even for empty or exact-budget files. Stat
        // size is only an initial estimate: short reads and growth still need EOF.
        let buffer = Buffer.alloc(before.size + 1)
        let size = 0
        while (size <= budget) {
          signal.throwIfAborted()
          if (size === buffer.length) {
            const larger = Buffer.alloc(Math.min(budget + 1, buffer.length * 2))
            buffer.copy(larger, 0, 0, size)
            buffer = larger
          }
          const read = await handle.read(buffer, size, buffer.length - size, size)
          signal.throwIfAborted()
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        if (size > budget) return { ...result, status: "file grew beyond evidence budget; contents not provided" }
        const after = await handle.stat()
        signal.throwIfAborted()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          return { ...result, status: "file changed while being read; contents not provided" }
        }
        let contents: string
        // ignoreBOM disables BOM stripping, preserving both source bytes and shebang position.
        try { contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)) }
        catch { return { ...result, status: "not valid UTF-8 source; contents not provided" } }
        if (contents.includes("\u0000")) return { ...result, status: "binary content; contents not provided" }
        // Direct executable paths qualify only with a recognized script extension or byte-zero shebang.
        if (reference.executable && !identifiableSource(filename, contents)) {
          return { ...result, status: unrecognizedDirectSource }
        }
        return { ...result, status: "captured", contents }
      } finally { await handle.close() }
    })
  } catch (error) {
    signal.throwIfAborted()
    return { ...result, status: `cannot read file (${fileFailure(error)}); contents not provided` }
  }
}

export async function collectEvidence(
  input: Omit<Evidence, "kind" | "files" | "limitations"> & { kind?: "shell"; limitations?: string[] },
  limits: Limits,
  signal: AbortSignal,
  scope: FileScope = fileAccess.scope(signal),
): Promise<Evidence> {
  signal.throwIfAborted()
  if (input.command.length > limits.maxEvidenceBytes) throw new Error("Command exceeds configured evidence budget")
  const commandBytes = Buffer.byteLength(input.command)
  if (commandBytes > limits.maxEvidenceBytes) throw new Error("Command exceeds configured evidence budget")
  // Native evidence already owns the launch-path probe. Standalone collectors use the
  // same bounded scope; never replace the declared path with its canonical alias.
  const canonical = input.execution ? input.execution.canonicalCwd : input.cwd ? (await scope.canonical(input.cwd)).path : null
  const discovery = discoverWithCandidates(input.command, { declared: input.cwd, canonical }, signal)
  const evidence: Evidence = { ...input, kind: "shell", files: [], limitations: [
    ...(input.limitations ?? []),
    "Literal shell inputs and existing files directly named by command arguments are collected. Argument candidates have unknown input roles: they may be outputs or unrelated, so the reviewer must decide relevance. Files are review-time snapshots or explicitly numbered excerpts, not command output. Excerpts favor declarations, imports, entry points and nearby context; omitted code is not assessed. Generated names, task definitions, imports, dependencies and calls inside source files are not recursively inspected.",
    ...discovery.limitations,
  ] }
  if (!input.userPrompt) evidence.limitations.push("User prompt unavailable.")
  let remaining = limits.maxEvidenceBytes - commandBytes
  const limit = new FileLimit(limits.maxFiles, scope)
  const declared = new Map<string | symbol, Reference>()
  // Exact declared aliases can relax qualification before the first capture,
  // without performing any filesystem work on later candidates.
  for (const reference of discovery.references) {
    signal.throwIfAborted()
    const filename = path.isAbsolute(reference.filename) ? reference.filename : reference.cwd ? `${reference.cwd}/${reference.filename}` : null
    const key = filename ?? Symbol()
    const previous = declared.get(key)
    if (previous) previous.executable &&= reference.executable
    else declared.set(key, { ...reference })
  }
  const selected = new Map<string | symbol, { reference: Reference; filename: string | null; withinLimit: boolean; aliases: Set<string>; file: FileEvidence }>()
  for (const reference of declared.values()) {
    signal.throwIfAborted()
    const filename = path.isAbsolute(reference.filename) ? reference.filename : reference.cwd ? `${reference.cwd}/${reference.filename}` : null
    const { key, withinLimit } = await limit.consider(filename, signal)
    const previous = selected.get(key)
    if (previous) {
      const promote = previous.reference.executable && !reference.executable
      previous.reference.executable &&= reference.executable
      if (filename && filename !== previous.filename) previous.aliases.add(filename)
      // A different canonical alias used as an interpreter/reader operand can
      // qualify an earlier direct executable. Never retry failed/timed-out I/O.
      if (promote && previous.withinLimit && previous.file.status === unrecognizedDirectSource) {
        const file = await captureFile(previous.reference, remaining, signal, scope)
        Object.assign(previous.file, file)
        if (file.contents !== undefined) { delete previous.file.warning; remaining -= Buffer.byteLength(file.contents) }
      }
      continue
    }
    // Capture each newly admitted candidate before a later path probe can spend
    // the shared filesystem allowance or occupy its outstanding transaction slots.
    const file = withinLimit ? await captureFile(reference, remaining, signal, scope)
      : { filename: reference.filename, ...(filename ? { path: filename } : {}), status: "file-count limit reached" }
    if (file.contents === undefined) file.warning = omittedFile(file.path ?? file.filename)
    selected.set(key, { reference, filename, withinLimit, aliases: new Set(), file })
    evidence.files.push(file)
    remaining -= Buffer.byteLength(file.contents ?? "")
  }
  let unknownCwd = false, incompleteCandidates = false
  const attempted = new Set<string>()
  for (const reference of discovery.candidates) {
    signal.throwIfAborted()
    const filename = path.isAbsolute(reference.filename) ? reference.filename
      : reference.cwd ? `${reference.cwd}/${reference.filename}` : null
    if (!filename) { unknownCwd = true; continue }
    if (attempted.has(filename) || declared.has(filename)) continue
    attempted.add(filename)
    // An incidental argv string must not consume maxFiles. Only a real
    // filesystem path becomes a possible file; never enumerate directories.
    const canonical = await scope.canonical(filename)
    if (!canonical.path) {
      if (canonical.reason !== "ENOENT") incompleteCandidates = true
      continue
    }
    // Generic argv values have no proven file role. Check regular-file status
    // before allowing a directory or a vanished path to occupy maxFiles.
    let regularFile: boolean
    try {
      regularFile = await scope.capture(async (signal, io) => {
        const handle = await io.open(canonical.path!, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
        try { signal.throwIfAborted(); return (await handle.stat()).isFile() }
        finally { await handle.close() }
      })
    } catch (error) {
      signal.throwIfAborted()
      if (fileFailure(error) !== "ENOENT") incompleteCandidates = true
      continue
    }
    if (!regularFile) continue
    const { key, withinLimit } = await limit.consider(filename, signal)
    const previous = selected.get(key)
    if (previous) {
      if (filename !== previous.filename) previous.aliases.add(filename)
      // An exact argument can qualify a direct executable previously omitted
      // under its stricter script-source qualification.
      if (previous.reference.executable && previous.withinLimit && previous.file.status === unrecognizedDirectSource) {
        previous.reference.executable = false
        const file = await captureFile(reference, remaining, signal, scope)
        Object.assign(previous.file, file)
        previous.file.basis = "literal argument; input role unknown"
        if (file.contents !== undefined) { delete previous.file.warning; remaining -= Buffer.byteLength(file.contents) }
      }
      continue
    }
    const file: FileEvidence = withinLimit ? await captureFile(reference, remaining, signal, scope)
      : { filename: reference.filename, path: filename, status: "file-count limit reached" }
    file.basis = "literal argument; input role unknown"
    if (file.contents === undefined) file.warning = omittedFile(file.path ?? file.filename)
    selected.set(key, { reference, filename, withinLimit, aliases: new Set(), file })
    evidence.files.push(file)
    remaining -= Buffer.byteLength(file.contents ?? "")
  }
  if (unknownCwd) evidence.limitations.push("Some relative argument paths have an unresolved working directory; their contents were not provided.")
  if (incompleteCandidates) evidence.limitations.push("Some literal argument paths could not be checked; their contents were not provided.")
  for (const { file, aliases } of selected.values()) if (aliases.size) file.aliases = [...aliases]
  signal.throwIfAborted()
  evidence.limitations.push(...limit.limitations)
  return evidence
}
