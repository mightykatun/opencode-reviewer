import path from "node:path"
import { constants } from "node:fs"
import type { Evidence, FileEvidence, Limits } from "./types.js"
import { FileLimit, omittedFile } from "./files.js"
import { fileAccess, fileFailure, type FileScope } from "./file-access.js"
import { discover, type Reference } from "./shell-discovery.js"

export { discover } from "./shell-discovery.js"

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
        if (before.size > budget) return { ...result, status: "file too large for remaining evidence budget; contents not provided; assess risk accordingly" }
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
        // Direct executable paths qualify only if extension or shebang identifies Python/shell.
        if (reference.executable && !/\.(py|sh|bash|zsh|ksh)$/.test(filename) && !/^#![^\n]*(?:\bpython[\d.]*|\b(?:ba|da|k|z)?sh)\b/.test(contents)) {
          return { ...result, status: "direct executable is not identifiable as Python/shell source; contents not provided" }
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
  const discovery = discover(input.command, { declared: input.cwd, canonical }, 0, signal)
  const evidence: Evidence = { ...input, kind: "shell", files: [], limitations: [
    ...(input.limitations ?? []),
    "Only literal Python/shell source and supported cat/head file operands are collected. Files are full review-time snapshots, not command output. Imports, dependencies, other runtimes and calls inside source files are not recursively inspected.",
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
      if (promote && previous.withinLimit && previous.file.status === "direct executable is not identifiable as Python/shell source; contents not provided") {
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
  for (const { file, aliases } of selected.values()) if (aliases.size) file.aliases = [...aliases]
  signal.throwIfAborted()
  evidence.limitations.push(...limit.limitations)
  return evidence
}
