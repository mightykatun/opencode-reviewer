import path from "node:path"
import { constants } from "node:fs"
import type { EditChange, EditContext, EditEvidence, Evidence, FileEvidence, Limits } from "./types.js"
import { FileLimit, DiffBudget, diffDelta, omittedFile } from "./files.js"
import { fileAccess, fileFailure, type FileScope } from "./file-access.js"
import { discover, type Reference } from "./shell-discovery.js"
import { reviewStage } from "./deadline.js"

export { discover } from "./shell-discovery.js"

export function withinDirectory(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename)
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)
}

export async function captureFile(reference: Reference, budget: number, signal: AbortSignal, scope: FileScope, directory?: string, excludedPath?: string): Promise<FileEvidence> {
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
    if (directory && !withinDirectory(directory, canonical.path)) return { ...result, status: "outside the skill directory; contents not provided" }
    if (canonical.path === excludedPath) return { ...result, status: "main skill instructions already supplied by host; contents not provided" }
    return await scope.capture(async (signal, io) => {
      const handle = await io.open(canonical.path!, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      try {
        signal.throwIfAborted()
        if (directory) {
          // The final component's O_NOFOLLOW does not protect ancestor directories.
          // Verify the opened descriptor before reading if a parent was swapped.
          const opened = await io.realpath(`/proc/self/fd/${handle.fd}`)
          signal.throwIfAborted()
          if (!withinDirectory(directory, opened)) return { ...result, status: "opened file is outside the skill directory; contents not provided" }
          if (opened === excludedPath) return { ...result, status: "opened file is the main skill; host instructions retained without rereading contents" }
        }
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
  // Context already owns the launch-path probe. Standalone collectors use the
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

/** Use host-computed diffs, never apply edits or duplicate unbounded tool input. */
export async function collectEditEvidence(input: EditContext, limits: Limits, signal: AbortSignal, scope: FileScope = fileAccess.scope(signal)): Promise<EditEvidence> {
  reviewStage(signal, "Evidence collection")
  const metadata = input.permission.metadata
  const limitations = [...input.limitations,
    "Proposed diffs come from the pending host permission, not from applying edits. Full files, dependencies and post-approval formatter changes are not inspected; host diffs may normalize whitespace or omit BOMs.",
  ]
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const field = (value: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return undefined
    if (!Object.hasOwn(descriptor, "value")) throw new Error("Native edit metadata contains an accessor")
    return descriptor.value
  }
  // Scope/header work is independently bounded, not charged to the configured
  // allowance for diff bodies. Never silently truncate mandatory target scope.
  let headerBytes = 16 * 1024 * 1024
  const text = (value: unknown): string | undefined => {
    if (typeof value !== "string") return
    reviewStage(signal, "Evidence collection")
    if (value.length > headerBytes) throw new Error("Native edit scope exceeds the 16 MiB normalization limit")
    headerBytes -= Buffer.byteLength(value)
    if (headerBytes < 0) throw new Error("Native edit scope exceeds the 16 MiB normalization limit")
    return value
  }
  const patterns = (values: string[]) => {
    if (values.length > 16384) throw new Error("Native edit scope exceeds the 16,384-entry normalization limit")
    const result: string[] = []
    for (let index = 0; index < values.length; index++) {
      const value = text(field(values, String(index)))
      if (value === undefined) throw new Error("Native edit scope contains an invalid pattern")
      result.push(value)
    }
    return result
  }
  const scopeText = (value: string) => {
    const result = text(value)
    if (result === undefined) throw new Error("Native edit scope contains invalid identity text")
    return result
  }
  const permissionScope = { id: scopeText(input.permission.id), type: scopeText(input.permission.type),
    patterns: patterns(input.permission.patterns), always: patterns(input.permission.always),
    tool: input.permission.tool ? { messageID: scopeText(input.permission.tool.messageID), callID: scopeText(input.permission.tool.callID) } : null }
  const patch = input.tool === "apply_patch"
  const hostFiles = patch ? field(record(metadata), "files") : undefined
  const files = patch ? Array.isArray(hostFiles) ? hostFiles : [] : [metadata]
  if (files.length > 16384) throw new Error("Native edit changes exceed the 16,384-entry normalization limit")
  if (!files.length) limitations.push("Per-file patch metadata unavailable; affected changes could not be enumerated.")
  let remaining = limits.maxEvidenceBytes
  let measurementUnits = 16 * 1024 * 1024
  const changes: EditChange[] = []
  const limit = new FileLimit(limits.maxFiles, scope)
  const countsBudget = new DiffBudget()
  for (let index = 0; index < files.length; index++) {
    reviewStage(signal, "Evidence collection")
    const file = record(patch ? field(files, String(index)) : metadata)
    const type = patch ? field(file, "type") : input.tool
    const operation = typeof type === "string" && ["add", "update", "delete", "move", "edit", "write"].includes(type) ? type as EditChange["operation"] : "unknown"
    const filePath = text(field(file, patch ? "filePath" : "filepath"))
    const movePath = patch ? text(field(file, "movePath")) : undefined
    const diff = field(file, patch ? "patch" : "diff")
    const change: EditChange = {
      path: filePath?.trim() ? filePath : null,
      operation, status: "omitted",
      ...(movePath !== undefined ? { movePath } : {}),
    }
    const { withinLimit } = await limit.consider(change.path && path.isAbsolute(change.path) ? change.path : null, signal)
    if (!withinLimit) change.reason = "file-count limit reached"
    else if (!change.path || !path.isAbsolute(change.path)) change.reason = "absolute target path unavailable"
    else if (operation === "unknown" || (patch && (operation === "edit" || operation === "write"))) change.reason = "file operation unavailable or unsupported"
    else if (operation === "move" && (!change.movePath || !path.isAbsolute(change.movePath))) change.reason = "absolute move destination unavailable"
    else if (typeof diff !== "string" || !diff.length) change.reason = "proposed diff unavailable"
    else if (diff.length > remaining) change.reason = "complete diff exceeds remaining evidence byte budget"
    else if (diff.length > measurementUnits) change.reason = "shared diff UTF-8 measurement work limit reached"
    else {
      // Repeated rejected multibyte bodies must not each rescan the full byte
      // allowance. Included bodies already have a separate aggregate byte cap.
      measurementUnits -= diff.length
      const bytes = Buffer.byteLength(diff)
      if (bytes > remaining) change.reason = "complete diff exceeds remaining evidence byte budget"
      else if (!diff.trim()) change.reason = "proposed diff unavailable"
      else { change.status = "included"; change.diff = diff; remaining -= bytes }
    }
    if (change.status === "omitted") {
      change.warning = omittedFile(change.path)
      let counts = diffDelta(diff, signal, countsBudget)
      if (!counts) {
        const added = field(file, "additions"), removed = field(file, "deletions")
        if (Number.isSafeInteger(added) && Number(added) >= 0 && Number.isSafeInteger(removed) && Number(removed) >= 0) {
          counts = { added: Number(added), removed: Number(removed) }
        }
      }
      if (counts) change.delta = `[Δ] ${JSON.stringify(change.path)}: +${counts.added} −${counts.removed} lines`
    }
    changes.push(change)
  }
  const partial = !changes.length || changes.some((change) => change.status === "omitted")
  if (partial) limitations.push("Edit evidence is incomplete. Omitted changes are not assessed by the supplied diffs; do not assume the whole proposal is safe.")
  if (!input.userPrompt) limitations.push("User prompt unavailable.")
  limitations.push(...limit.limitations)
  if (countsBudget.exhausted) limitations.push("Some omitted-diff line counts exceeded the shared 16 MiB/65,536-line/250 ms counting allowance; valid host counts were used when available.")
  reviewStage(signal, "Evidence collection")
  return {
    kind: "edit", tool: input.tool, ...(input.delegation ? { delegation: input.delegation } : {}), userPrompt: input.userPrompt, session: input.session,
    location: input.location, changes, partial, limitations,
    permission: { ...permissionScope, metadataStatus: "Host change metadata normalized into changes; raw metadata and tool input are omitted to avoid duplicate or unbounded change text." },
  }
}
