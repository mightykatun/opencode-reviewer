import type { DirectoryContext, DirectoryEvidence, Limits, ToolContext, ToolEvidence } from "./types.js"
import { patchOperations } from "./patch-summary.js"

/** Bound traversal before copying/serializing hostile nested JSON. Preserve values exactly. */
export function boundedCopy<T>(value: T, budget: number, valueBudget = 16384,
  measurements?: WeakMap<object, number>): { value: T; bytes: number; values: number } {
  let bytes = 0, nodes = 0
  const ancestors = new Set<object>()
  const add = (size: number) => { bytes += size; if (bytes > budget) throw new Error("Operation evidence exceeds configured byte budget") }
  const text = (value: string) => {
    add(2)
    // Count JSON escaping without allocating an oversized escaped intermediate.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2)
      else if (code < 32) add(6)
      else if (code < 128) add(1)
      else if (code < 2048) add(2)
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { add(4); i++ }
      else add(code >= 0xd800 && code <= 0xdfff ? 6 : 3)
    }
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > valueBudget || depth > 32) throw new Error("Operation evidence exceeds bounded JSON structure limits")
    if (value === null) { add(4); return null }
    if (typeof value === "string") { text(value); return value }
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) { add(String(value).length); return value }
    if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || ancestors.has(value)) throw new Error("Operation evidence is not a plain JSON record")
    ancestors.add(value)
    const start = bytes
    add(2)
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {}
    let count = 0
    if (Array.isArray(value)) {
      if (value.length > valueBudget - nodes) throw new Error("Operation evidence exceeds bounded JSON structure limits")
      const entries = result as unknown[]
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Operation evidence contains an array hole or accessor")
        if (count++) add(1)
        entries.push(visit(descriptor.value, depth + 1))
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!Object.hasOwn(descriptor, "value")) throw new Error("Operation evidence contains an accessor")
        if (count++) add(1)
        text(key); add(1)
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
      }
    }
    ancestors.delete(value)
    // Sizes describe only newly constructed copies. Consumers can issue frozen
    // components without scanning their large string values a second time.
    measurements?.set(result, bytes - start)
    return result
  }
  return { value: visit(value, 0) as T, bytes, values: nodes }
}

export function collectToolEvidence(context: ToolContext, limits: Limits, signal: AbortSignal): ToolEvidence {
  signal.throwIfAborted()
  const { definition, ...base } = context
  const mandatory = boundedCopy({ tool: base.tool, input: base.input, origin: base.origin, permission: base.permission }, limits.maxEvidenceBytes)
  let captured: ToolEvidence["definition"] = { status: "unavailable", reason: "Tool description/schema unavailable through the public host catalog" }
  if (definition) {
    try {
      const copy = boundedCopy({ description: definition.description, parameters: definition.parameters }, limits.maxEvidenceBytes - mandatory.bytes, 16384 - mandatory.values)
      captured = { status: "included", source: "public host tool catalog", ...copy.value }
    } catch { captured = { status: "omitted", reason: "Tool definition is not valid bounded JSON within the remaining byte budget" } }
  }
  const limitations = [...base.limitations]
  if (captured.status !== "included") limitations.push(captured.reason)
  if (!base.userPrompt) limitations.push("User prompt unavailable.")
  signal.throwIfAborted()
  return { ...base, ...mandatory.value, definition: captured, partial: captured.status !== "included", limitations }
}

export function collectDirectoryEvidence(context: DirectoryContext, limits: Limits, signal: AbortSignal): DirectoryEvidence {
  signal.throwIfAborted()
  const { input, permission, native, ...base } = context
  let operation: DirectoryEvidence["operation"] = { input, inputStatus: "Complete host-recorded invocation arguments" }
  const edit = native && ["edit", "write", "apply_patch"].includes(context.tool)
  if (edit) {
    const fields: Record<string, unknown> = {}
    if (context.tool !== "apply_patch") for (const key of ["filePath", "replaceAll"]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor) continue
      if (!Object.hasOwn(descriptor, "value")) throw new Error("Operation evidence contains an accessor")
      fields[key] = descriptor.value
    }
    operation = { input: fields,
      ...(context.tool === "apply_patch" ? { patchOperations: patchOperations(input, signal) } : {}),
      inputStatus: "Edit contents and patch bodies omitted for directory-access review; declared patch operations are retained when applicable. This is not a complete edit assessment." }
  }
  const { metadata, ...scope } = permission
  const mandatory = boundedCopy({ tool: base.tool, operation, permission: scope }, limits.maxEvidenceBytes)
  const limitations = [...base.limitations, "Directory paths are host-declared; canonical targets and directory contents were not inspected for this access review."]
  let captured: DirectoryEvidence["permission"] = { ...mandatory.value.permission, metadataStatus: "Host directory metadata included" }
  let partial = edit
  try {
    // Non-native permission metadata can itself define the action. It is mandatory.
    const copy = boundedCopy(metadata, limits.maxEvidenceBytes - mandatory.bytes, 16384 - mandatory.values)
    captured.metadata = copy.value
  } catch (error) {
    if (!native) throw error
    partial = true
    captured.metadataStatus = "Directory metadata omitted: invalid bounded JSON or remaining byte budget exceeded; requested patterns retained exactly"
    limitations.push(captured.metadataStatus)
  }
  if (!base.userPrompt) limitations.push("User prompt unavailable.")
  signal.throwIfAborted()
  return { ...base, ...mandatory.value, permission: captured, partial, limitations }
}
