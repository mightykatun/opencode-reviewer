import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { companionBusy, companionProtocol, companionRpc, sameLocation, type CompanionHandshake } from "./companion-protocol.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { InvocationCapture } from "./invocation-capture.js"
import { readHostInvocation, sameRequest, serverRequestJSON, snapshotRequest } from "./host-request.js"
import { bindTransportOwnership, TransportOwnership } from "./transport-ownership.js"
import { withDeadline } from "./deadline.js"
import { FileAccess, fileFailure, type FileIO } from "./file-access.js"
import { collectHostOperation } from "./host-evidence.js"
import { readHostEvidenceOptions } from "./host-evidence-options.js"
import { codeModeToolAction } from "./host-tool-kind.js"
import { runRetrievalTool, type RetrievalCall } from "./retrieval-tools.js"

type Query = { location: CompanionHandshake["location"]; epoch: string; sessionID: string; requestID: string }
type RetrieveQuery = Query & { base: string; call: RetrievalCall; timeoutMs: number; maxBytes: number }
type Call = { signal: AbortSignal; error(type: typeof companionBusy, message: string, data: Record<string, never>): unknown }

export async function setupCompanion(context: Plugin.Context, lifecycle: PluginLifecycle, fileIO?: FileIO): Promise<CompanionHandshake> {
  const location = { directory: context.location.directory,
    ...(context.location.workspaceID ? { workspaceID: context.location.workspaceID } : {}) }
  const handshake: CompanionHandshake = {
    protocol: companionProtocol, hostVersion: context.app.version, epoch: randomUUID(), location,
    project: { ...context.location.project },
  }
  const captures = new InvocationCapture(handshake)
  const files = new FileAccess(fileIO)
  const reads = new TransportOwnership()
  let activeReads = 0, activeRetrievals = 0
  lifecycle.addCleanup(() => reads.settled())
  lifecycle.signal.addEventListener("abort", () => captures.clear(), { once: true })
  const before = await context.tool.hook("execute.before", event => { captures.before(event) })
  lifecycle.addCleanup(() => before.dispose())
  lifecycle.signal.throwIfAborted()
  const after = await context.tool.hook("execute.after", event => { captures.after(event) })
  lifecycle.addCleanup(() => after.dispose())
  lifecycle.signal.throwIfAborted()
  const read = async (query: Query, call: Call, collection?: { options: unknown; timeoutMs: number }) => {
    if (lifecycle.signal.aborted || call.signal.aborted) return null
    const collectOptions = collection && readHostEvidenceOptions(collection.options)
    if (collection && (!collectOptions || !Number.isFinite(collection.timeoutMs) || collection.timeoutMs <= 0 || collection.timeoutMs > 5000)) return null
    if (activeReads >= 2) return call.error(companionBusy, "Reviewer companion read capacity occupied", {})
    activeReads++
    const ownership = new TransportOwnership(reads)
    const signal = AbortSignal.any([lifecycle.signal, call.signal])
    bindTransportOwnership(signal, ownership)
    try {
      return await withDeadline(signal, collection?.timeoutMs ?? 5000, async signal => {
        const options = { signal }, ids = { sessionID: query.sessionID, requestID: query.requestID }
        const scope = { location, epoch: handshake.epoch }
        const first = serverRequestJSON(await ownership.track(context.permission.get(ids, options)))
        signal.throwIfAborted()
        const snapshot = snapshotRequest(first, scope)
        const source = snapshot?.request.source
        if (!snapshot || !source || snapshot.request.id !== ids.requestID || snapshot.request.sessionID !== ids.sessionID) return null
        const nested = codeModeToolAction(snapshot.request.action) ? captures.readCodeMode(ids.sessionID, source.assistantID, source.id) : undefined
        const captured = nested?.outer ?? captures.read(ids.sessionID, source.assistantID, source.id)
        if (!captured) return null
        const { scope: capturedScope, ...value } = captured
        const invocation = readHostInvocation({ ...value, ...capturedScope })
        if (!invocation) return null
        const session = await ownership.track(context.session.get({ sessionID: ids.sessionID }, options))
        signal.throwIfAborted()
        if (session.id !== ids.sessionID || session.location.directory !== location.directory) return null
        const result = collectOptions ? await collectHostOperation({ snapshot, invocation }, collectOptions, signal, files,
          signal => ownership.track(context.skill.list({ location }, { signal })),
          async signal => {
            signal.throwIfAborted()
            const data = await ownership.track(context.tool.list())
            signal.throwIfAborted()
            return { location, data }
          }, nested?.candidates) : undefined
        const final = snapshotRequest(serverRequestJSON(await ownership.track(context.permission.get(ids, options))), scope)
        signal.throwIfAborted()
        if (!final || !sameRequest(snapshot, final) || !(nested
          ? captures.readCodeMode(ids.sessionID, source.assistantID, source.id)
          : captures.read(ids.sessionID, source.assistantID, source.id))) return null
        if (collection) {
          const current = await ownership.track(context.session.get({ sessionID: ids.sessionID }, options))
          signal.throwIfAborted()
          if (current.id !== ids.sessionID || current.location.directory !== location.directory) return null
        }
        // The CLI binds the exact durable direct/outer item and inputs. Code Mode
        // candidates remain observations, never a selected inner-call identity.
        return { request: first, invocation, ...(result ? { result } : {}) }
      }, "Invocation evidence lookup")
    } catch { return null }
    finally {
      // An RPC timeout cannot free capacity while its public reads still run.
      void ownership.settled().then(() => { activeReads-- })
    }
  }
  /** Model-chosen read-only operations. Scope is the handshake epoch/location; the
   * pending permission is not re-read per call. Physical work is owned until it settles. */
  const retrieve = async (query: RetrieveQuery, call: Call) => {
    if (lifecycle.signal.aborted || call.signal.aborted) return null
    if (!path.isAbsolute(query.base) || query.base.includes("\0")) return null
    if (activeRetrievals >= 2) return call.error(companionBusy, "Reviewer companion retrieval capacity occupied", {})
    activeRetrievals++
    const ownership = new TransportOwnership(reads)
    const signal = AbortSignal.any([lifecycle.signal, call.signal])
    // Partial traversal results return slightly before the hard deadline.
    const softEnd = performance.now() + query.timeoutMs - Math.min(1000, query.timeoutMs / 10)
    try {
      return await withDeadline(signal, query.timeoutMs, deadline => ownership.track(runRetrievalTool(query.call,
        { base: query.base, home: homedir(), maxBytes: query.maxBytes, io: files.io, signal: deadline, softEnd })), "Retrieval")
    } catch (error) {
      if (signal.aborted) return null
      return { tool: query.call.tool, status: "error", reason: fileFailure(error) }
    } finally {
      // A response acknowledges this call's physical completion, not only its
      // deadline-visible result. Other calls retain their independent slots.
      await ownership.settled()
      activeRetrievals--
    }
  }
  const registration = await context.rpc.register(companionRpc, {
    handshake: async (input, call) => {
      lifecycle.signal.throwIfAborted()
      call.signal.throwIfAborted()
      if (!sameLocation(input, location)) return call.error("scope", "Reviewer companion scope mismatch", {})
      return structuredClone(handshake)
    },
    invocation: async (input, call) => {
      const query = input as Query
      if (query.epoch !== handshake.epoch || !sameLocation(query.location, location))
        return call.error("scope", "Reviewer companion scope mismatch", {})
      return read(query, call)
    },
    evidence: async (input, call) => {
      const query = input as Query & { options: unknown; timeoutMs: number }
      if (query.epoch !== handshake.epoch || !sameLocation(query.location, location))
        return call.error("scope", "Reviewer companion scope mismatch", {})
      return read(query, call, query)
    },
    retrieve: async (input, call) => {
      const query = input as RetrieveQuery
      if (query.epoch !== handshake.epoch || !sameLocation(query.location, location))
        return call.error("scope", "Reviewer companion scope mismatch", {})
      return retrieve(query, call)
    },
  })
  lifecycle.addCleanup(() => registration.dispose())
  lifecycle.signal.throwIfAborted()
  return handshake
}
