import path from "node:path"
import type { Config } from "./config.js"
import { reviewStage } from "./deadline.js"
import { collectEvidence } from "./evidence.js"
import type { FileAccess } from "./file-access.js"
import { DiffBudget, diffDelta, omittedFile } from "./files.js"
import { sameLocation } from "./companion-protocol.js"
import { boundedHostJSON, hostOperationJSONBytes, sameHostJSON } from "./host-request.js"
import type { HostInvocationRead } from "./host-reader.js"
import type { HostConversationContext } from "./host-context.js"
import type { HostInvocation, HostRequest, JSONObject } from "./host-types.js"
import { boundedCopy } from "./tool-evidence.js"
import type { FileEvidence, Limits, PatchOperation } from "./types.js"
import { readRegisteredSkill, requestedSkill, type RegisteredSkill, type SkillCatalogRead } from "./host-skill.js"
import { transportOwnership } from "./transport-ownership.js"
import { readRegisteredTool, type RegisteredTool, type ToolCatalogRead } from "./host-tool.js"

export type HostEvidenceOptions = Pick<Config, "reviewBash" | "reviewEdits" | "reviewExternalDirectories"
  | "reviewSkills" | "reviewTools"> & Limits

type Permission = Omit<HostRequest, "metadata"> & { metadata?: JSONObject; metadataStatus: string }
type Operation = { input: JSONObject; inputStatus: string; patchOperations?: PatchOperation[] }
interface OperationBase {
  permission: Permission
  location: HostInvocation["location"]
  project: HostInvocation["project"]
  limitations: string[]
}
interface Conversation {
  conversation: Omit<HostConversationContext, "limitations" | "userPrompt" | "delegation">
  userPrompt: string | null
  delegation?: HostConversationContext["delegation"]
}
interface Base extends OperationBase, Conversation {}
export interface HostShellEvidence extends Base {
  kind: "shell"
  tool: "shell"
  operation: Operation
  command: string
  cwd: string
  execution: { tool: "shell"; requestedWorkdir: string | null; canonicalCwd: string | null;
    cwdSource: "absolute tool.workdir" | "tool.workdir relative to invocation.location.directory" | "invocation.location.directory" }
  files: FileEvidence[]
}
export interface HostEditChange {
  file: string
  /** Present only when supplied by native preview metadata. */
  hostStatus?: "added" | "deleted" | "modified"
  status: "included" | "omitted"
  patch?: string
  reason?: string
  warning?: string
  delta?: string
}
export interface HostEditEvidence extends Base {
  kind: "edit"
  tool: "write" | "edit" | "patch"
  operation: Operation
  changes: HostEditChange[]
  partial: boolean
}
export interface HostDirectoryEvidence extends Base {
  kind: "external-directory"
  tool: string
  operation: Operation
  partial: boolean
}
export interface HostSkillEvidence extends Base {
  kind: "skill"
  tool: "skill"
  operation: Operation
  skill: RegisteredSkill
}
/** Evidence retains exact native permission and captured invocation scope. */
export interface HostToolEvidence extends Base {
  kind: "tool"
  tool: string
  operation: Operation
  definition?: RegisteredTool
}
export type HostReviewEvidence = HostShellEvidence | HostEditEvidence | HostDirectoryEvidence | HostSkillEvidence | HostToolEvidence
export type HostOperationEvidence = Omit<HostShellEvidence, keyof Conversation>
  | Omit<HostEditEvidence, keyof Conversation> | Omit<HostDirectoryEvidence, keyof Conversation> | Omit<HostSkillEvidence, keyof Conversation> | Omit<HostToolEvidence, keyof Conversation>
export type HostOperationResult = { status: "ready"; evidence: HostOperationEvidence }
  | { status: "disabled" | "unsupported"; reason: string }
export type HostEvidenceResult = { status: "ready"; evidence: HostReviewEvidence }
  | { status: "disabled" | "unsupported"; reason: string }

const normalizationBytes = 16 * 1024 * 1024
const editTools = new Set(["write", "edit", "patch"])
const directoryTools = new Set(["shell", "write", "edit", "patch", "read", "glob", "grep"])
const nativeTools = new Set([...directoryTools, "skill", "execute", "search", "question", "subagent", "lsp", "webfetch", "websearch", "todowrite", "todoread"])
type OperationRead = Pick<HostInvocationRead, "snapshot" | "invocation">

function assertOperationScope({ snapshot: { request, scope }, invocation }: OperationRead): void {
  if (!request.source || request.sessionID !== invocation.sessionID || request.source.assistantID !== invocation.assistantID
    || request.source.id !== invocation.callID || scope.epoch !== invocation.epoch || !sameLocation(scope.location, invocation.location)) {
    throw new Error("Evidence request or invocation scope mismatch")
  }
}

function assertConversationScope(owned: HostInvocationRead): void {
  assertOperationScope(owned)
  const { conversation, invocation } = owned
  if (conversation.current.id !== invocation.sessionID || conversation.current.location.directory !== invocation.location.directory
    || conversation.current.projectID !== (owned.registeredProject ?? invocation.project).id) throw new Error("Evidence conversation scope mismatch")
}

function operationKind({ snapshot: { request }, invocation }: OperationRead) {
  return request.action === "shell" && invocation.tool === "shell" ? "shell"
    : request.action === "edit" && editTools.has(invocation.tool) ? "edit"
    : request.action === "external_directory" && directoryTools.has(invocation.tool) ? "external-directory"
    : request.action === "skill" && invocation.tool === "skill" ? "skill"
    : !nativeTools.has(invocation.tool) ? "tool" : undefined
}

function shellLocation(invocation: HostInvocation) {
  const workdir = invocation.input.workdir as string | undefined
  if (workdir?.includes("\0") || workdir === "~" || workdir?.startsWith("~/")) {
    throw new Error("Native shell workdir expansion unavailable from captured location")
  }
  // Pinned Linux 2.0.26 ShellTool.prepare uses FileAccess.resolvePath, which
  // lexically resolves before filesystem traversal, including symlink/.. paths.
  const cwd = path.resolve(invocation.location.directory, workdir ?? ".")
  const cwdSource = workdir === undefined ? "invocation.location.directory" as const
    : path.isAbsolute(workdir) ? "absolute tool.workdir" as const : "tool.workdir relative to invocation.location.directory" as const
  return { cwd, requestedWorkdir: workdir ?? null, cwdSource }
}

function matchingOperationScope(owned: OperationRead, evidence: HostOperationEvidence): boolean {
  const { metadata: _, ...expected } = owned.snapshot.request
  const { metadata: __, metadataStatus: ___, ...actual } = evidence.permission
  return sameHostJSON(actual, expected) && sameLocation(evidence.location, owned.invocation.location)
    && sameHostJSON(evidence.project, owned.invocation.project) && evidence.tool === owned.invocation.tool
    && evidence.kind === operationKind(owned)
}

/** Attach only independently owned CLI conversation context after the RPC boundary. */
export function attachHostConversation(owned: HostInvocationRead, evidence: HostOperationEvidence): HostReviewEvidence {
  assertConversationScope(owned)
  if (!matchingOperationScope(owned, evidence)) throw new Error("Evidence operation or conversation scope mismatch")
  const { userPrompt, delegation, limitations, ...conversation } = owned.conversation
  return { ...evidence, ...(owned.registeredProject ? { project: owned.registeredProject } : {}),
    conversation, userPrompt, ...(delegation ? { delegation } : {}),
    limitations: [...limitations, ...evidence.limitations,
      ...(owned.registeredProject ? ["Project metadata comes from the connected server's current registered project and checkout inventory; captured invocation identity and location are unchanged."] : []),
      ...(!userPrompt ? ["User prompt unavailable."] : [])] }
}

function requiredText(input: JSONObject, key: string): string {
  const value = input[key]
  if (typeof value !== "string") throw new Error(`Native operation requires exact ${key}`)
  return value
}

/** Header-only summary of an already host-accepted native patch.
 * No hunk application, path resolution or file access occurs here. */
function nativePatchOperations(input: JSONObject, signal: AbortSignal): PatchOperation[] {
  const text = requiredText(input, "patchText")
  if (text.length > normalizationBytes || Buffer.byteLength(text) > normalizationBytes) throw new Error("Patch exceeds the 16 MiB scan limit")
  const trimmed = text.trim()
  const body = trimmed.match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? trimmed
  const lines: string[] = []
  for (let start = 0; start <= body.length;) {
    reviewStage(signal, "Evidence collection")
    if (lines.length >= 65536) throw new Error("Patch exceeds the 65,536-line scan limit")
    const end = body.indexOf("\n", start)
    lines.push(body.slice(start, end < 0 ? body.length : end).replace(/\r$/, ""))
    if (end < 0) break
    start = end + 1
  }
  if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") throw new Error("Native patch envelope unavailable")
  const boundary = (line: string) => line === "*** End Patch" || /^\*\*\* (?:Add|Delete|Update) File: /.test(line)
  const result: PatchOperation[] = []
  let index = 1
  if (lines[index]?.trim().startsWith("*** Environment ID:")) index++
  while (index < lines.length - 1) {
    reviewStage(signal, "Evidence collection")
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[index++]!.trim())
    if (!match || !match[2]!.trim()) throw new Error("Native patch operation scope unavailable")
    const operation: PatchOperation = { operation: match[1] === "Add" ? "add" : match[1] === "Delete" ? "delete" : "update", path: match[2]!.trim() }
    if (operation.operation === "update") {
      while (lines[index]?.trimEnd() === "*** End of File") index++
      const move = lines[index]?.trimEnd()
      if (move === "*** Move to:" || move?.startsWith("*** Move to: ")) {
        const movePath = move.slice("*** Move to: ".length).trim()
        if (!movePath) throw new Error("Native patch move destination unavailable")
        operation.operation = "move"; operation.movePath = movePath; index++
      }
    }
    if (result.length >= 16384) throw new Error("Native patch operation count exceeds normalization limit")
    result.push(operation)
    if (operation.operation === "delete") continue
    // Native add uses trim(), update uses trimEnd(): an indented update header
    // inside a context line is data, not another target.
    while (index < lines.length - 1 && !boundary(operation.operation === "add" ? lines[index]!.trim() : lines[index]!.trimEnd())) {
      reviewStage(signal, "Evidence collection")
      index++
    }
  }
  if (!result.length) throw new Error("Native patch operation scope unavailable")
  return result
}

function operation(invocation: HostInvocation, signal: AbortSignal): Operation {
  const { tool, input } = invocation
  const knownFields = tool === "patch" ? ["patchText"] : tool === "write" ? ["path", "content"]
    : tool === "edit" ? ["path", "oldString", "newString", "replaceAll"] : undefined
  // Only these pinned schemas allow body omission. Unknown fields must not be
  // silently dropped as though they could not change the operation's meaning.
  if (knownFields && Object.keys(input).some(key => !knownFields.includes(key))) throw new Error("Native edit input has unsupported fields")
  if (tool === "patch") return { input: {}, patchOperations: nativePatchOperations(input, signal),
    inputStatus: "Patch bodies omitted; complete declared patch operations retained. Pending host diffs, when available, describe proposed changes." }
  if (tool === "write" || tool === "edit") {
    const target = requiredText(input, "path")
    if (!target || target.includes("\0")) throw new Error("Native edit target unavailable")
    if (tool === "write") requiredText(input, "content")
    else {
      requiredText(input, "oldString"); requiredText(input, "newString")
      if (input.replaceAll !== undefined && typeof input.replaceAll !== "boolean") throw new Error("Native edit replaceAll unavailable")
    }
    return { input: { path: target, ...(input.replaceAll === undefined ? {} : { replaceAll: input.replaceAll }) },
      inputStatus: "Edit bodies omitted; exact target and replacement scope retained. Pending host diffs, when available, describe proposed changes." }
  }
  if (tool === "shell") {
    requiredText(input, "command")
    if (input.workdir !== undefined && typeof input.workdir !== "string") throw new Error("Native shell workdir unavailable")
  }
  if (tool === "read") requiredText(input, "path")
  if (tool === "glob" || tool === "grep") requiredText(input, "pattern")
  return { input, inputStatus: nativeTools.has(tool) ? "Complete captured native invocation arguments" : "Complete captured tool invocation arguments" }
}

function permissionMetadata(scope: Omit<HostRequest, "metadata">, metadata: JSONObject | undefined,
  bytes: number, values: number, limitations: string[]): Permission {
  if (metadata === undefined) return { ...scope, metadataStatus: "No optional native permission metadata supplied" }
  try {
    const copy = boundedCopy(metadata, bytes, values)
    return { ...scope, metadata: copy.value, metadataStatus: "Optional native permission metadata included" }
  } catch {
    const metadataStatus = "Optional native permission metadata omitted whole because it exceeds the remaining evidence budget; exact permission scope retained."
    limitations.push(metadataStatus)
    return { ...scope, metadataStatus }
  }
}

function editChanges(request: HostRequest, proposed: Operation, limits: Limits, signal: AbortSignal, limitations: string[]): HostEditChange[] {
  const supplied = request.metadata?.files
  const raw = Array.isArray(supplied) ? supplied : []
  if (!raw.length) {
    limitations.push("Pending host per-file diffs unavailable; no target files were read and no replacement diffs were constructed.")
  }
  if (raw.length > 16384) throw new Error("Native edit scope exceeds normalization limit")
  let remaining = limits.maxEvidenceBytes, measurement = normalizationBytes
  const countsBudget = new DiffBudget(), selected = new Map<string, boolean>()
  const resources = new Set(request.resources)
  const targets = new Set(resources)
  if (typeof proposed.input.path === "string") targets.add(proposed.input.path)
  for (const declared of proposed.patchOperations ?? []) {
    targets.add(declared.path)
    if (declared.movePath !== undefined) targets.add(declared.movePath)
  }
  // Preserve verbatim declarations, not guessed filesystem aliases or statuses.
  // This also bounds identities absent from the optional preview array.
  boundedCopy([...targets], normalizationBytes)
  for (const target of targets) {
    reviewStage(signal, "Evidence collection")
    selected.set(target, selected.size < limits.maxFiles)
  }
  const previewed = new Set<string>()
  const changes: HostEditChange[] = []
  // Mandatory per-file identities have a separate normalization ceiling.
  // Only whole optional bodies use the diff allowance.
  boundedCopy(raw.map(file => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Native edit file scope unavailable")
    return { file: file.file, status: file.status }
  }), normalizationBytes)
  for (const entry of raw) {
    reviewStage(signal, "Evidence collection")
    const file = entry as JSONObject
    if (typeof file.file !== "string" || !file.file || file.file.includes("\0")
      || !["added", "deleted", "modified"].includes(String(file.status))) throw new Error("Native edit file scope unavailable")
    if (!resources.has(file.file)) throw new Error("Pending edit preview falls outside the exact permission scope")
    previewed.add(file.file)
    const change: HostEditChange = { file: file.file, hostStatus: file.status as HostEditChange["hostStatus"], status: "omitted" }
    const diff = file.patch
    if (!selected.get(file.file)) change.reason = "file-count limit reached"
    else if (typeof diff !== "string" || !diff.length) change.reason = "pending host diff unavailable"
    else if (diff.length > remaining) change.reason = "complete diff exceeds remaining evidence byte budget"
    else if (diff.length > measurement) change.reason = "shared diff UTF-8 measurement work limit reached"
    else {
      measurement -= diff.length
      const size = Buffer.byteLength(diff)
      if (size > remaining) change.reason = "complete diff exceeds remaining evidence byte budget"
      else if (!diff.trim()) change.reason = "pending host diff unavailable"
      else { change.status = "included"; change.patch = diff; remaining -= size }
    }
    if (change.status === "omitted") {
      change.warning = omittedFile(change.file)
      const counts = Number.isSafeInteger(file.additions) && Number(file.additions) >= 0
        && Number.isSafeInteger(file.deletions) && Number(file.deletions) >= 0
        ? { added: Number(file.additions), removed: Number(file.deletions) }
        : diffDelta(diff, signal, countsBudget)
      if (counts) change.delta = `[Δ] ${JSON.stringify(change.file)}: +${counts.added} −${counts.removed} lines`
    }
    changes.push(change)
  }
  let missing = false
  for (const target of targets) {
    reviewStage(signal, "Evidence collection")
    if (!target || target.includes("\0")) throw new Error("Native edit target unavailable")
    if (previewed.has(target)) continue
    missing = true
    changes.push({ file: target, status: "omitted", reason: "pending host preview unavailable for this exact declared target",
      warning: omittedFile(target) })
  }
  if (missing) {
    limitations.push("Some exact declared edit targets have no pending host preview; their changes and line counts are unavailable.")
  }
  if (countsBudget.exhausted) limitations.push("Some omitted-diff counts exceeded the bounded counting allowance; valid host counts were used when available.")
  return changes
}

/** Server-only collector. The caller supplies owned, validated readPendingInvocation
 * snapshots and FileAccess for that server filesystem, never terminal-local I/O.
 * Native names rely on the accepted installation assumption: no native executor
 * replacement/aliasing or post-capture rewrites. This is not a host provenance
 * guarantee. Only the scoped server supplies a read-only skill catalog callback;
 * no context, model, catalog mutation or permission-write calls occur here.
 */
export async function collectHostOperation(owned: OperationRead, options: HostEvidenceOptions,
  signal: AbortSignal, files: FileAccess, catalog?: SkillCatalogRead, tools?: ToolCatalogRead): Promise<HostOperationResult> {
  reviewStage(signal, "Evidence collection")
  assertOperationScope(owned)
  const { snapshot: { request }, invocation } = owned
  const kind = operationKind(owned)
  if (!kind) return { status: "unsupported", reason: "Exact supported native tool/action mapping unavailable; MCP/custom origin is not inferred." }
  const enabled = kind === "shell" ? options.reviewBash : kind === "edit" ? options.reviewEdits
    : kind === "skill" ? options.reviewSkills : kind === "tool" ? options.reviewTools : options.reviewExternalDirectories
  if (!enabled) return { status: "disabled", reason: `${kind} review disabled` }
  if (kind === "tool") {
    const { metadata, ...permissionScope } = request
    const proposed = operation(invocation, signal)
    const mandatory = boundedCopy({ permission: permissionScope, operation: proposed }, options.maxEvidenceBytes)
    const limitations = ["Any supplied current scoped registered definition is assumed unchanged while permission is pending and to describe tool behavior accurately.",
      "MCP server or plugin origin and invocation-time definition snapshot are unavailable. Executors and remote implementations were not inspected."]
    let definition: RegisteredTool | undefined
    if (!tools) limitations.push("Tool definition unavailable: scoped registry reader unavailable.")
    else try {
      const pending = tools(signal)
      const raw = await (transportOwnership(signal)?.track(pending) ?? pending)
      reviewStage(signal, "Evidence collection")
      const result = readRegisteredTool(raw, invocation.location, invocation.tool, options.maxEvidenceBytes - mandatory.bytes, 16384 - mandatory.values)
      definition = result.definition
      limitations.push(...result.limitations)
    } catch {
      reviewStage(signal, "Evidence collection")
      limitations.push("Tool definition unavailable: scoped registry read failed.")
    }
    reviewStage(signal, "Evidence collection")
    const optional = definition ? boundedCopy({ definition }, options.maxEvidenceBytes - mandatory.bytes, 16384 - mandatory.values) : undefined
    const permission = permissionMetadata(mandatory.value.permission, metadata, options.maxEvidenceBytes - mandatory.bytes - (optional?.bytes ?? 0),
      16384 - mandatory.values - (optional?.values ?? 0), limitations)
    return { status: "ready", evidence: { kind, tool: invocation.tool, location: invocation.location, project: invocation.project,
      permission, operation: mandatory.value.operation, ...(definition ? { definition } : {}), limitations } }
  }
  if (kind === "skill") {
    const id = requestedSkill(request, invocation)
    if (!catalog) return { status: "unsupported", reason: "Registered main skill instructions unavailable; skill request remains manual." }
    const pending = catalog(signal)
    const raw = await (transportOwnership(signal)?.track(pending) ?? pending)
    reviewStage(signal, "Evidence collection")
    const skill = readRegisteredSkill(raw, invocation.location, id)
    if (!skill) return { status: "unsupported", reason: "Unique scoped registered main skill instructions unavailable; skill request remains manual." }
    const { metadata, ...permissionScope } = request
    const proposed = operation(invocation, signal)
    // Complete main instructions are mandatory and never truncated or omitted.
    const mandatory = boundedCopy({ permission: permissionScope, operation: proposed, skill }, options.maxEvidenceBytes)
    const limitations = ["Main skill instructions come from the current scoped host registry, not an invocation-time snapshot.",
      "Supporting files and scripts were not inspected. Loading skill instructions does not grant subsequent tool permissions."]
    const permission = permissionMetadata(mandatory.value.permission, metadata, options.maxEvidenceBytes - mandatory.bytes,
      16384 - mandatory.values, limitations)
    return { status: "ready", evidence: { kind, tool: "skill", location: invocation.location, project: invocation.project,
      permission, operation: mandatory.value.operation, skill: mandatory.value.skill, limitations } }
  }

  const { metadata, ...permissionScope } = request
  const proposed = operation(invocation, signal)
  const mandatory = boundedCopy({ permission: permissionScope, operation: proposed }, kind === "edit" ? normalizationBytes : options.maxEvidenceBytes)
  const base: Omit<OperationBase, "permission"> = { location: invocation.location, project: invocation.project,
    limitations: ["Optional effective native tool definition is not included; exact captured arguments and pending permission scope are retained."] }
  if (kind === "edit") {
    base.limitations.push("Proposed diffs come from pending V2 metadata.files. Full target files and post-approval formatter changes are not inspected; host previews may normalize whitespace or omit BOMs.",
      "Targets are host-declared; filesystem aliases are not resolved and distinct declared file names count separately.")
    const changes = editChanges(request, proposed, options, signal, base.limitations)
    const partial = !changes.length || changes.some(change => change.status === "omitted")
    if (partial) base.limitations.push("Edit evidence is incomplete; omitted changes are not assessed by the supplied diffs.")
    reviewStage(signal, "Evidence collection")
    return { status: "ready", evidence: { ...base, kind, tool: invocation.tool as HostEditEvidence["tool"], operation: mandatory.value.operation,
      permission: { ...mandatory.value.permission, metadataStatus: "Pending metadata.files normalized into changes; duplicate raw metadata and edit bodies omitted." }, changes, partial } }
  }
  const permission = permissionMetadata(mandatory.value.permission, metadata, options.maxEvidenceBytes - mandatory.bytes, 16384 - mandatory.values, base.limitations)
  if (kind === "external-directory") {
    base.limitations.push("Directory scopes and operation targets are host-declared; target directories, canonical paths and file contents were not inspected. This is a directory-access review, not a complete edit assessment.")
    reviewStage(signal, "Evidence collection")
    return { status: "ready", evidence: { ...base, kind, tool: invocation.tool, operation: mandatory.value.operation, permission,
      partial: editTools.has(invocation.tool) || (metadata !== undefined && permission.metadata === undefined) } }
  }
  const command = requiredText(invocation.input, "command")
  const { cwd, ...execution } = shellLocation(invocation)
  const fileScope = files.scope(signal)
  // Charge the mandatory V2 envelope once; collectEvidence separately charges
  // command bytes, so restore precisely that amount to its file allowance.
  const metadataBytes = permission.metadata === undefined ? 0 : boundedCopy(permission.metadata, options.maxEvidenceBytes).bytes
  const collected = await collectEvidence({ command, cwd, userPrompt: null, limitations: base.limitations },
    { ...options, maxEvidenceBytes: options.maxEvidenceBytes - mandatory.bytes - metadataBytes + Buffer.byteLength(command) }, signal, fileScope)
  const canonical = await fileScope.canonical(cwd)
  if (!canonical.path) collected.limitations.push(`Canonical invocation working directory unavailable (${canonical.reason}); the declared working directory is retained.`)
  else if (canonical.path !== cwd) collected.limitations.push("Declared invocation directory differs from its canonical path. Inherited shell PWD is unavailable; neither path alone establishes the logical directory after cd.")
  reviewStage(signal, "Evidence collection")
  return { status: "ready", evidence: { ...base, kind, tool: "shell", permission, operation: mandatory.value.operation,
    command, cwd, files: collected.files, limitations: collected.limitations.filter(value => value !== "User prompt unavailable."),
    execution: { tool: "shell", ...execution, canonicalCwd: canonical.path } } }
}

/** Collector for callers already holding both server and CLI reads. */
export async function collectHostEvidence(owned: HostInvocationRead, options: HostEvidenceOptions,
  signal: AbortSignal, files: FileAccess, catalog?: SkillCatalogRead, tools?: ToolCatalogRead): Promise<HostEvidenceResult> {
  reviewStage(signal, "Evidence collection")
  assertConversationScope(owned)
  const result = await collectHostOperation(owned, options, signal, files, catalog, tools)
  return result.status === "ready" ? { status: "ready", evidence: attachHostConversation(owned, result.evidence) } : result
}

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && path.isAbsolute(value)
}

const omittedSourceStatuses = new Set([
  "working directory unresolved; contents not provided",
  "not a regular file; contents not provided",
  "file too large for remaining evidence budget; contents not provided; assess risk accordingly",
  "file grew beyond evidence budget; contents not provided",
  "file changed while being read; contents not provided",
  "not valid UTF-8 source; contents not provided",
  "binary content; contents not provided",
  "direct executable is not identifiable as Python/shell source; contents not provided",
  "file-count limit reached",
])

function shellFiles(value: unknown, options: HostEvidenceOptions, budget: number, signal: AbortSignal): boolean {
  if (!Array.isArray(value)) return false
  let included = 0
  for (const file of value) {
    reviewStage(signal, "Evidence validation")
    if (!shape(file, ["filename", "status"], ["path", "aliases", "contents", "warning"])
      || typeof file.filename !== "string" || !file.filename || file.filename.includes("\0")
      || typeof file.status !== "string"
      || (Object.hasOwn(file, "path") && !absolute(file.path))
      || (Object.hasOwn(file, "aliases") && (!strings(file.aliases) || !file.aliases.every(absolute)))
      || (Object.hasOwn(file, "warning") && typeof file.warning !== "string")) return false
    if (file.status === "captured") {
      if (!absolute(file.path) || typeof file.contents !== "string" || file.contents.includes("\0")
        || Object.hasOwn(file, "warning") || ++included > options.maxFiles) return false
      budget -= Buffer.byteLength(file.contents)
      if (budget < 0) return false
    } else {
      if (Object.hasOwn(file, "contents") || typeof file.warning !== "string"
        || (!omittedSourceStatuses.has(file.status)
          && !/^cannot read file \([^()\r\n]+\); contents not provided$/.test(file.status))) return false
    }
  }
  // The collector retains whole omitted candidates beyond maxFiles; only
  // included snapshots consume the file allowance. The JSON bound limits rows.
  return true
}

/** Independently copy and validate a server operation response before CLI context
 * attachment. The caller still owns fresh request/epoch checks around this read. */
export function readHostOperationEvidence(value: unknown, owned: OperationRead, options: HostEvidenceOptions,
  signal: AbortSignal): HostOperationEvidence | undefined {
  reviewStage(signal, "Evidence validation")
  try {
    assertOperationScope(owned)
    const copy = boundedHostJSON(value, hostOperationJSONBytes), kind = operationKind(owned)
    if (!kind || !(kind === "shell" ? options.reviewBash
      : kind === "edit" ? options.reviewEdits : kind === "skill" ? options.reviewSkills
        : kind === "tool" ? options.reviewTools : options.reviewExternalDirectories)) return
    const common = ["kind", "tool", "permission", "location", "project", "operation", "limitations"]
    const fields = kind === "shell" ? ["command", "cwd", "execution", "files"] : kind === "edit" ? ["changes", "partial"]
      : kind === "skill" ? ["skill"] : kind === "tool" ? [] : ["partial"]
    if (!shape(copy, [...common, ...fields], kind === "tool" ? ["definition"] : []) || !strings(copy.limitations)
      || !sameHostJSON(copy.location, owned.invocation.location) || !sameHostJSON(copy.project, owned.invocation.project)
      || copy.kind !== kind || copy.tool !== owned.invocation.tool
      || !shape(copy.permission, ["id", "sessionID", "action", "resources", "source", "metadataStatus"], ["save", "message", "metadata"])
      || typeof copy.permission.metadataStatus !== "string") return
    const { metadata: _, ...permissionScope } = owned.snapshot.request
    const { metadata, metadataStatus: __, ...receivedScope } = copy.permission
    if (!sameHostJSON(receivedScope, permissionScope)
      || (Object.hasOwn(copy.permission, "metadata") && !sameHostJSON(metadata, owned.snapshot.request.metadata))) return
    const proposed = operation(owned.invocation, signal)
    if (!sameHostJSON(copy.operation, proposed)) return
    if (kind === "tool") {
      if (copy.definition !== undefined) {
        if (!shape(copy.definition, ["id"], ["name", "description", "input"]) || copy.definition.id !== owned.invocation.tool) return
        const result = readRegisteredTool({ location: copy.location, data: [copy.definition] }, owned.invocation.location, owned.invocation.tool)
        if (!sameHostJSON(result.definition, copy.definition)) return
      }
      boundedCopy({ permission: permissionScope, operation: proposed,
        ...(copy.definition ? { definition: copy.definition } : {}), ...(metadata !== undefined ? { metadata } : {}) }, options.maxEvidenceBytes)
      reviewStage(signal, "Evidence validation")
      return copy as unknown as HostOperationEvidence
    }
    if (kind === "skill") {
      const id = requestedSkill(owned.snapshot.request, owned.invocation)
      if (!shape(copy.skill, ["id", "name", "path", "content"]) || copy.skill.id !== id) return
      const skill = readRegisteredSkill({ location: copy.location, data: [copy.skill] }, owned.invocation.location, id)
      if (!skill) return
      const mandatory = boundedCopy({ permission: permissionScope, operation: proposed, skill }, options.maxEvidenceBytes)
      if (metadata !== undefined && boundedCopy(metadata, options.maxEvidenceBytes).bytes > options.maxEvidenceBytes - mandatory.bytes) return
      reviewStage(signal, "Evidence validation")
      return copy as unknown as HostOperationEvidence
    }
    const mandatory = boundedCopy({ permission: permissionScope, operation: proposed }, kind === "edit" ? normalizationBytes : options.maxEvidenceBytes)
    if (kind === "edit") {
      // Normalize the independently retained pending preview again, without any
      // file access or a second patch parser. This also checks count/byte limits,
      // exact resource membership and complete (never truncated) diff bodies.
      const changes = editChanges(owned.snapshot.request, proposed, options, signal, [])
      if (Object.hasOwn(copy.permission, "metadata") || !sameHostJSON(copy.changes, changes)
        || copy.partial !== (!changes.length || changes.some(change => change.status === "omitted"))) return
    } else {
      const metadataBytes = metadata === undefined ? 0 : boundedCopy(metadata, options.maxEvidenceBytes).bytes
      const budget = options.maxEvidenceBytes - mandatory.bytes - metadataBytes
      if (budget < 0) return
      if (kind === "external-directory") {
        if (copy.partial !== (editTools.has(owned.invocation.tool) || (owned.snapshot.request.metadata !== undefined && metadata === undefined))) return
      } else {
        const { cwd, ...expected } = shellLocation(owned.invocation)
        if (copy.command !== owned.invocation.input.command || copy.cwd !== cwd
          || !shape(copy.execution, ["tool", "requestedWorkdir", "canonicalCwd", "cwdSource"])) return
        const { canonicalCwd, ...execution } = copy.execution
        if ((canonicalCwd !== null && !absolute(canonicalCwd)) || !sameHostJSON(execution, { tool: "shell", ...expected })
          || !shellFiles(copy.files, options, budget, signal)) return
      }
    }
    reviewStage(signal, "Evidence validation")
    return copy as unknown as HostOperationEvidence
  } catch {
    reviewStage(signal, "Evidence validation")
    return
  }
}
