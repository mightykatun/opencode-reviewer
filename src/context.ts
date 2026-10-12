import path from "node:path"
import type { AssistantMessage, Message, OpencodeClient, Part, PermissionRequest, Project, Session } from "@opencode-ai/sdk/v2"
import type { DelegationContext, EditContext, Evidence, ProjectLocation, SessionLocation, SkillDefinition, ToolDefinition } from "./types.js"
import { fileAccess, type FileScope } from "./file-access.js"
import { DeadlineError, remainingTime, withDeadline } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"

export interface ContextReader {
  session(id: string, signal: AbortSignal): Promise<Session | undefined>
  messages(id: string, signal: AbortSignal): Promise<readonly { info: Message; parts: Part[] }[]>
  message(sessionID: string, messageID: string, signal: AbortSignal): Promise<{ info: Message; parts: Part[] } | undefined>
  projects(signal: AbortSignal): Promise<readonly Project[]>
  toolIDs?(signal: AbortSignal): Promise<readonly string[]>
  definition?(info: AssistantMessage, tool: string, signal: AbortSignal): Promise<ToolDefinition | undefined>
  mcpServers?(): readonly { name: string; status: string }[]
  skills?(signal: AbortSignal): Promise<readonly SkillDefinition[]>
}

export async function loadInvocation(request: PermissionRequest, reader: ContextReader, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!request.tool) throw new Error("Pending tool linkage unavailable")
  const message = await reader.message(request.sessionID, request.tool.messageID, signal)
  signal.throwIfAborted()
  if (!message || message.info.role !== "assistant" || message.info.sessionID !== request.sessionID || message.info.id !== request.tool.messageID) {
    throw new Error("Pending tool message unavailable or mismatched")
  }
  const parts = message.parts.filter((part) => part.type === "tool" && part.callID === request.tool!.callID)
  const part = parts[0]
  if (parts.length !== 1 || !part || part.type !== "tool" || part.sessionID !== request.sessionID
    || part.messageID !== request.tool.messageID || part.state.status !== "running"
    || !part.state.input || typeof part.state.input !== "object" || Array.isArray(part.state.input)) {
    throw new Error("Pending tool arguments unavailable or mismatched")
  }
  const invocation = message.info.path
  return { message, info: message.info, tool: part.tool, input: part.state.input,
    linkage: { sessionID: request.sessionID, messageID: request.tool.messageID, callID: request.tool.callID },
    location: {
      instanceDirectory: typeof invocation?.cwd === "string" && path.isAbsolute(invocation.cwd) ? invocation.cwd : null,
      instanceWorktree: typeof invocation?.root === "string" && path.isAbsolute(invocation.root) ? invocation.root : null,
    },
  }
}
export type Invocation = Awaited<ReturnType<typeof loadInvocation>>

type CommandContext = Omit<Evidence, "files">

class HistoryIncompleteError extends Error {}

export async function loadRootMessages(client: OpencodeClient, sessionID: string, directory: string, signal: AbortSignal) {
  // Each page is chronological; the opaque response cursor traverses older pages.
  let before: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < 20; page++) {
    signal.throwIfAborted()
    const result = await client.session.messages({ sessionID, directory, limit: 100, before }, { signal })
    signal.throwIfAborted()
    if (!result.data) throw new Error("Root messages unavailable")
    if (findUserPrompt(result.data, sessionID)) return result.data
    const next = result.response.headers.get("x-next-cursor")
    if (!next) return result.data
    if (seen.has(next)) throw new HistoryIncompleteError("Root-user history traversal incomplete: repeated pagination cursor.")
    seen.add(next)
    before = next
  }
  throw new HistoryIncompleteError("Root-user history traversal incomplete: 20-page limit reached.")
}

/** Filter synthetic and attributed text using the public part metadata. */
function findUserPrompt(messages: readonly { info: Message; parts: Part[] }[], sessionID?: string): { text: string | null } | undefined {
  const ordered = messages.filter((m) => m.info.role === "user" && (sessionID === undefined || m.info.sessionID === sessionID)).toSorted((a, b) => b.info.time.created - a.info.time.created || (a.info.id < b.info.id ? 1 : a.info.id > b.info.id ? -1 : 0))
  for (const message of ordered) {
    const owned = message.parts.filter((p) => p.sessionID === message.info.sessionID && p.messageID === message.info.id)
    const parts = owned.filter((p) => p.type === "text" && !p.synthetic && !p.ignored && !p.metadata?.source)
    if (parts.length) return { text: parts.map((p) => p.type === "text" ? p.text : "").join("\n").trim() || null }
    // A newer attachment-only user message must not be replaced by an older ask.
    if (owned.some((p) => p.type === "file")) return { text: null }
  }
}

export function latestUserPrompt(messages: readonly { info: Message; parts: Part[] }[], sessionID?: string): string | null {
  return findUserPrompt(messages, sessionID)?.text ?? null
}

async function nativeInvocation(request: PermissionRequest, reader: ContextReader, signal: AbortSignal, kind: "shell" | "edit") {
  try { return await loadInvocation(request, reader, signal) }
  catch (error) {
    signal.throwIfAborted()
    throw new Error(`Pending native ${kind} message unavailable or arguments mismatched`, { cause: error })
  }
}

function invocationFor(request: PermissionRequest, verified: Invocation): Invocation {
  if (verified.linkage.sessionID !== request.sessionID || verified.linkage.messageID !== request.tool?.messageID
    || verified.linkage.callID !== request.tool?.callID) throw new Error("Verified invocation linkage mismatched")
  return verified
}

export async function loadContext(request: PermissionRequest, reader: ContextReader, signal: AbortSignal, scope: FileScope = fileAccess.scope(signal), verified?: Invocation): Promise<CommandContext | null> {
  signal.throwIfAborted()
  if (request.permission !== "bash") return null
  if (!request.tool) throw new Error("Native shell tool context unavailable")
  const invocation = verified ? invocationFor(request, verified) : await nativeInvocation(request, reader, signal, "shell")
  if (invocation.tool !== "bash") throw new Error("Pending native shell arguments unavailable")
  const { command, workdir } = invocation.input
  if (typeof command === "string" && command.length > 16 * 1024 * 1024) throw new Error("Shell command exceeds the 16 MiB preprocessing limit")
  if (typeof command !== "string" || !command.trim()) throw new Error("Shell command unavailable")
  const limitations: string[] = []
  const { instanceDirectory, instanceWorktree } = invocation.location
  const invalidWorkdir = workdir !== undefined && typeof workdir !== "string"
  const requestedWorkdir = typeof workdir === "string" && workdir ? workdir : null
  // ShellTool lexically resolves supplied workdirs, including absolute ones.
  // Only relative workdirs need the invocation base, never the session origin.
  // Source operands retain filesystem traversal semantics in captureFile.
  const cwd = invalidWorkdir ? null : requestedWorkdir && path.isAbsolute(requestedWorkdir) ? path.resolve(requestedWorkdir)
    : instanceDirectory ? path.resolve(instanceDirectory, requestedWorkdir ?? ".") : null
  if (!instanceDirectory) limitations.push("Execution instance directory unavailable; the session's starting directory is not substituted for it.")
  if (!instanceWorktree) limitations.push("Execution instance worktree unavailable.")
  if (invalidWorkdir) limitations.push("Supplied tool.workdir is not a string; execution directory is unknown.")
  const execution: NonNullable<Evidence["execution"]> = {
    tool: "bash", requestedWorkdir, instanceDirectory, instanceWorktree,
    cwdSource: invalidWorkdir ? "unavailable" : requestedWorkdir && path.isAbsolute(requestedWorkdir) ? "absolute tool.workdir"
      : instanceDirectory ? requestedWorkdir ? "tool.workdir relative to assistant.path.cwd" : "assistant.path.cwd" : "unavailable",
    canonicalCwd: null,
  }
  // Finish optional host lookups before the first filesystem probe starts its
  // shared budget. Slow conversation reads must not starve healthy source I/O.
  const conversation = await loadConversationContext(request, reader, signal, invocation)
  if (cwd) {
    const canonical = await scope.canonical(cwd)
    execution.canonicalCwd = canonical.path
    if (!canonical.path) limitations.push(`Execution directory could not be canonicalized (${canonical.reason}); cwd is the declared launch path, not a verified physical path.`)
    else if (canonical.path !== cwd) limitations.push("Declared launch directory differs from its canonical path. Inherited shell PWD is unavailable; neither path alone establishes the logical working directory after cd.")
  }
  return {
    ...conversation, kind: "shell", command, cwd, execution,
    limitations: [...limitations, ...conversation.limitations],
    permission: permissionContext(request),
  }
}

export function permissionContext(request: PermissionRequest, clone = true): NonNullable<Evidence["permission"]> {
  return {
    id: request.id, type: request.permission, patterns: clone ? [...request.patterns] : request.patterns, always: clone ? [...request.always] : request.always,
    metadata: clone ? structuredClone(request.metadata) : request.metadata, tool: request.tool ? { ...request.tool } : null,
  }
}

export async function loadEditContext(request: PermissionRequest, reader: ContextReader, signal: AbortSignal, verified?: Invocation): Promise<EditContext> {
  signal.throwIfAborted()
  if (request.permission !== "edit" || !request.tool) throw new Error("Native edit tool context unavailable")
  const invocation = verified ? invocationFor(request, verified) : await nativeInvocation(request, reader, signal, "edit")
  if (invocation.tool !== "edit" && invocation.tool !== "write" && invocation.tool !== "apply_patch") {
    throw new Error("Pending native edit arguments unavailable or unsupported tool")
  }
  const location = invocation.location
  const conversation = await loadConversationContext(request, reader, signal, invocation)
  if (!location.instanceDirectory) conversation.limitations.push("Edit invocation directory unavailable; session origin is not substituted.")
  if (!location.instanceWorktree) conversation.limitations.push("Edit invocation worktree unavailable.")
  // Borrow host metadata until the collector projects its known fields. Never
  // clone/traverse unrelated metadata before bounded normalization.
  return { ...conversation, kind: "edit", tool: invocation.tool, location, permission: permissionContext(request, false) }
}

export async function loadConversationContext(request: PermissionRequest, reader: ContextReader, signal: AbortSignal, invocation?: Invocation) {
  signal.throwIfAborted()
  const limitations: string[] = []
  let current: Session | undefined
  let root: Session | undefined
  let prompt: string | null = null
  let delegation: DelegationContext | undefined
  const contextEnd = performance.now() + Math.min(5000, remainingTime(signal) / 3)
  const contextMs = () => Math.max(0, contextEnd - performance.now())
  const ancestry = async (contextSignal: AbortSignal) => {
    const loaded = await reader.session(request.sessionID, contextSignal)
    contextSignal.throwIfAborted()
    if (loaded?.id !== request.sessionID) throw new Error("Session mismatch")
    current = loaded
    const delegated = async () => {
      if (!loaded.parentID) return
      const messageID = invocation?.info.parentID
      delegation = { sessionID: loaded.id, parentSessionID: loaded.parentID, messageID: messageID ?? null, prompt: null }
      try {
        if (!messageID || !invocation || invocation.info.sessionID !== loaded.id) throw new Error("Delegation linkage unavailable")
        invocationFor(request, invocation)
        // Bind to this assistant invocation's user message, not a later queued
        // resume prompt or a parent task for another sibling. No older fallback.
        const message = await reader.message(loaded.id, messageID, contextSignal)
        contextSignal.throwIfAborted()
        if (!message || message.info.role !== "user" || message.info.id !== messageID || message.info.sessionID !== loaded.id
          || !Array.isArray(message.parts) || message.parts.length > 4096) throw new Error("Delegation message unavailable")
        let bytes = 0, parts = 0
        for (const part of message.parts) if (part.type === "text" && part.sessionID === loaded.id && part.messageID === messageID
          && !part.synthetic && !part.ignored && !part.metadata?.source) {
          if (part.text.length > 65536 || (bytes += Buffer.byteLength(part.text) + (parts++ ? 1 : 0)) > 65536) throw new Error("Delegation exceeds context budget")
        }
        const text = latestUserPrompt([message], loaded.id)
        if (!text) throw new Error("Delegation text unavailable")
        delegation.prompt = text
      } catch {
        contextSignal.throwIfAborted()
        limitations.push("Latest immediate subagent prompt unavailable or exceeds the 64 KiB context limit; no older delegation was substituted.")
      }
    }
    const rootPrompt = async () => {
      let ancestor = loaded
      const seen = new Set<string>()
      while (ancestor.parentID) {
        contextSignal.throwIfAborted()
        if (seen.has(ancestor.id) || seen.size >= 16) throw new Error("Parent chain incomplete")
        seen.add(ancestor.id)
        const expected: string = ancestor.parentID
        const parent = await reader.session(expected, contextSignal)
        contextSignal.throwIfAborted()
        if (parent?.id !== expected) throw new Error("Parent session unavailable")
        ancestor = parent
      }
      root = ancestor
      const messages = await reader.messages(root.id, contextSignal)
      contextSignal.throwIfAborted()
      prompt = latestUserPrompt(messages, root.id)
    }
    const branches = [rootPrompt(), delegated()]
    // Promise.all may reject while its sibling still owns a host read. Keep both
    // physical branches in the inherited lease without delaying visible failure.
    for (const branch of branches) transportOwnership(contextSignal)?.track(branch)
    await Promise.all(branches)
  }
  try { await withDeadline(signal, contextMs(), ancestry, "Conversation context lookup") }
  catch (error) {
    signal.throwIfAborted()
    limitations.push(error instanceof HistoryIncompleteError || error instanceof DeadlineError ? error.message : "Some session ancestry or root-user-prompt context is unavailable.")
  }
  let projects: readonly Project[] = []
  if (current || root) {
    try { projects = await withDeadline(signal, contextMs(), (contextSignal) => reader.projects(contextSignal), "Project context lookup") }
    catch (error) { signal.throwIfAborted(); limitations.push(error instanceof DeadlineError ? error.message : "OpenCode project metadata unavailable.") }
  }
  const sessionLocation = (s: Session | undefined): SessionLocation | null => s ? {
    id: s.id, parentID: s.parentID ?? null, directory: s.directory, projectID: s.projectID, workspaceID: s.workspaceID ?? null,
  } : null
  const projectLocation = (s: Session | undefined): ProjectLocation | null => {
    if (!s) return null
    const p = projects.find((p) => p.id === s.projectID)
    if (!p) { limitations.push(`Project metadata unavailable for session ${s.id}.`); return null }
    return { id: p.id, name: p.name ?? null, worktree: p.worktree, vcs: p.vcs ?? null }
  }
  signal.throwIfAborted()
  return {
    ...(delegation ? { delegation } : {}),
    userPrompt: prompt, limitations,
    session: { current: sessionLocation(current), root: sessionLocation(root), currentProject: projectLocation(current), rootProject: projectLocation(root) },
  }
}
