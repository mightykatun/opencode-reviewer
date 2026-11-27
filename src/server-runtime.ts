import { randomUUID } from "node:crypto"
import path from "node:path"
import { open } from "node:fs/promises"
import { constants } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import type { OpenCodeClient } from "@opencode/client"
import { Controller, type ApprovalFact, type ControllerCheckpoint, type ReviewLifecycleFact, type View } from "./controller.js"
import { hostPermissionTransport, type PermissionClient } from "./host-permissions.js"
import { evaluateHostReview } from "./host-evaluate.js"
import { preparePendingInvocation } from "./host-reader.js"
import { serverRequestJSON } from "./host-request.js"
import { SteeringFollowUps, followUpCategory } from "./steering-follow-up.js"
import { PendingRefresh } from "./pending-refresh.js"
import { SessionModes, SessionModeStore } from "./session-mode.js"
import { SessionInstructionsStore } from "./session-instructions.js"
import { SessionAncestry } from "./session-ancestry.js"
import { RouteSessions } from "./route-approval.js"
import { TransportOwnership } from "./transport-ownership.js"
import { localStateRoot, historyStateRoot } from "./local-state.js"
import { createCompanionServer, type CompanionServer } from "./companion-reads.js"
import { directCompanionAccess } from "./companion-access.js"
import { HostingBinder, type HostingDependencies, type HostingState } from "./hosting.js"
import { loadPolicy, policyFile, PolicyWatcher, type PolicyGeneration } from "./policy.js"
import { reviewerRpc, type AutomationProjection, type ConfirmedDecisionProjection, type HostingProjection, type ReviewProjection, type ReviewerSnapshot,
  type ReviewerViewProjection } from "./reviewer-protocol.js"
import { DecisionLedger, canonicalJSON, decisionFingerprint, decisionKey } from "./decision-ledger.js"
import { hostPricingLookup } from "./host-pricing.js"
import { HistoryStore, type HistoryStoreOptions } from "./history-store.js"
import { HistoryCoordinator, drainHistory } from "./history-coordinator.js"
import type { HistoryQuery, HistoryTarget } from "./history-records.js"
import type { PricingLookup } from "./usage.js"
import type { HostInvocation, HostPendingRequest, HostPendingSnapshot, HostRequestSnapshot, HostScope } from "./host-types.js"
import type { HostReviewEvidence } from "./host-evidence.js"
import type { ReviewKind, ReviewObservation } from "./types.js"
import type { Config } from "./config.js"
import type { FileIO } from "./file-access.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import type { AncestryRead } from "./session-ancestry.js"
import { uiText } from "./ui-text.js"
import { notificationKinds } from "./notification-types.js"

/** Outcome and usage recording. Wired to the history coordinator by the caller.
 * Accounting never changes review, approval or recovery. */
export interface ServerAccounting {
  observation?(request: HostPendingRequest, kind: ReviewKind, config: Config, execution: { review: string; root?: string }): ReviewObservation | undefined
  lifecycle?(fact: ReviewLifecycleFact<HostPendingRequest>): unknown
  approval?(fact: ApprovalFact<HostPendingRequest>): unknown
  reply?(event: { sessionID: string; requestID: string; reply: string }): unknown
  invalidateSession?(sessionID: string): unknown
}

export interface ServerRuntimeDependencies {
  fileIO?: FileIO
  /** Fixture seam for hosting discovery and client construction. */
  hosting?: Partial<Pick<HostingDependencies, "discover" | "makeClient" | "pid">>
  /** Fixture seams. Production discovers both from the process environment. */
  policyFile?: string
  registrationFile?: string
  /** `null` disables the ledger explicitly: review runs, automatic replies stay off. */
  ledger?: DecisionLedger | null
  /** Overrides the history coordinator. `null` disables history and statistics. */
  accounting?: ServerAccounting | null
  history?: HistoryStoreOptions
  stateRoot?: string
}

export interface ServerRuntime {
  readonly companion: CompanionServer
  readonly nonce: string
  readonly policy: () => PolicyGeneration | undefined
  readonly hosting: () => HostingState
  readonly snapshot: () => ReviewerSnapshot
  readonly engine: () => ServerEngine | undefined
  readonly modes: SessionModes
  readonly instructions: SessionInstructionsStore
  readonly stateRoot: string
}

/** One policy generation's review engine at one location. */
export interface ServerEngine {
  readonly generation: number
  /** The verified self-client this engine reads conversations through. */
  readonly client: OpenCodeClient
  readonly controller: Controller<HostPendingRequest>
  readonly refresh: PendingRefresh<readonly HostPendingSnapshot[]>
  readonly heads: ReadonlyMap<string, string>
  readonly snapshots: ReadonlyMap<string, HostRequestSnapshot>
  /** Location-filtered native events of this generation. */
  event(event: { type: string; data: Record<string, unknown> }): void
  dispose(): Promise<void>
}

type NativeEvent = { type: string; data: Record<string, unknown>; location?: { directory: string; workspaceID?: string } }

const soundKinds = notificationKinds
const MAX_SOUND_BYTES = 4 * 1024 * 1024
/** Concurrent custom sound reads served to viewers. */
const MAX_SOUND_READS = 2
/** Native events buffered while a policy edit replaces the engine. */
const MAX_BUFFERED_EVENTS = 256
/** Confirmed automatic decisions kept for viewers that fetch the next snapshot late. */
const MAX_RECENT_DECISIONS = 64
/** Permission IDs whose views left the engine, so controls can answer `resolved`. */
const MAX_RESOLVED_IDS = 1024
const MAX_TRACKED_IDS = 16384

export async function setupServerRuntime(ctx: Plugin.Context, lifecycle: PluginLifecycle, dependencies: ServerRuntimeDependencies = {}): Promise<ServerRuntime> {
  // The companion runs in process only. No evidence, invocation or filesystem RPC is public.
  const companion = await createCompanionServer(ctx, lifecycle, dependencies.fileIO)
  const location = companion.handshake.location
  const scope: HostScope = { location, epoch: companion.handshake.epoch }
  /** Identity of this runtime instance: the RPC nonce and the ledger owner. */
  const nonce = randomUUID()
  const stateRoot = dependencies.stateRoot ?? localStateRoot()
  const reads = new TransportOwnership()
  lifecycle.addCleanup(() => reads.settled(), false)
  const owned = <T>(work: Promise<T>) => reads.track(work)
  const sameLocation = (value: { directory: string; workspaceID?: string } | undefined) =>
    !!value && value.directory === location.directory && (value.workspaceID ?? undefined) === (location.workspaceID ?? undefined)
  // Sessions are addressed by ID and a parent may live at another location.
  const routes = new RouteSessions(() => undefined)
  const ancestry = new SessionAncestry(async (id, signal) => {
    const session = await owned(ctx.session.get({ sessionID: id }, { signal }))
    signal.throwIfAborted()
    if (session.id !== id) return
    routes.remember(session)
    return session
  })
  // Mode records belong to the root's own location, so a descendant reviewed at another
  // location (for example a worktree) inherits the root's Disable. Unknown stays unknown.
  const modeHost = (root: string) => {
    const home = ancestry.location(root)
    return home?.directory ? JSON.stringify({ directory: home.directory, ...(home.workspaceID ? { workspaceID: home.workspaceID } : {}) }) : undefined
  }
  const modes = new SessionModes(new SessionModeStore(path.join(stateRoot, "session-mode-v2"), modeHost), ancestry)
  lifecycle.addCleanup(() => modes.flush())
  lifecycle.addCleanup(() => modes.refreshSettled(), false)
  const instructions = new SessionInstructionsStore(path.join(stateRoot, "session-instructions-v1"))
  lifecycle.addCleanup(() => instructions.flush(), false)
  let ledger: DecisionLedger | undefined
  if (dependencies.ledger !== null) {
    try { ledger = dependencies.ledger ?? DecisionLedger.open(historyStateRoot(stateRoot)) } catch { ledger = undefined }
    if (ledger) lifecycle.addCleanup(() => ledger!.close(), false)
  }
  const ledgerKey = (sessionID: string, requestID: string) => decisionKey(location, sessionID, requestID)
  /** The configuration an engine runs. Without a ledger no automatic reply can be recorded,
   * so the engine is advisory: no countdown, no fast reply, no steering request. */
  const effectiveConfig = (configured: Config): Config => ledger ? configured
    : { ...configured, autoApprove: false, autoRejectSteering: false, fastMode: false }
  const automationProjection = (configured: Config): AutomationProjection => {
    const config = effectiveConfig(configured)
    return { autoApprove: config.autoApprove, autoRejectSteering: config.autoRejectSteering, fastMode: config.fastMode,
      ...(!ledger && (configured.autoApprove || configured.autoRejectSteering) ? { unavailable: "ledger" as const } : {}) }
  }
  // The server records outcomes and usage once in the shared v2 store. Storage
  // failures show unavailable and never gate review, approval or recovery.
  let store: HistoryStore | undefined, coordinator: HistoryCoordinator<HostPendingRequest> | undefined
  const historyRoot = (id: string, parent: AbortSignal): AncestryRead => {
    const read = ancestry.root(id, AbortSignal.any([parent, lifecycle.signal]))
    if (read.settled) owned(read.settled)
    return read
  }
  if (dependencies.accounting !== null && !dependencies.accounting) {
    try {
      store = new HistoryStore(historyStateRoot(stateRoot), dependencies.history)
      coordinator = new HistoryCoordinator<HostPendingRequest>(store, historyRoot, undefined, undefined, ctx.app.version)
    } catch { store = undefined; coordinator = undefined }
  }
  let engineWork: Promise<void> = Promise.resolve()
  const accounting: ServerAccounting = dependencies.accounting ?? (coordinator ? {
    observation: (request, kind, config, execution) => coordinator!.observation(request, kind, config, execution),
    lifecycle: coordinator.lifecycle, approval: coordinator.approval,
    reply: event => coordinator!.reply({ requestID: event.requestID, sessionID: event.sessionID, reply: event.reply as "once" | "always" | "reject" }),
    invalidateSession: id => coordinator!.invalidateSession(id),
  } : {})
  if (store) {
    const owning = store
    lifecycle.addCleanup(() => { const at = performance.now(); coordinator?.dispose(); return drainHistory(owning, engineWork, at) }, false)
  }

  // Revision and change publication for viewers. Small invalidations only.
  let revision = 0
  let publishTimer: ReturnType<typeof setTimeout> | undefined
  let emit: ((revision: number) => void) | undefined
  const changed = () => {
    revision++
    if (publishTimer || lifecycle.signal.aborted) return
    publishTimer = setTimeout(() => { publishTimer = undefined; try { emit?.(revision) } catch {} }, 50)
  }
  lifecycle.addCleanup(() => { if (publishTimer) clearTimeout(publishTimer) })
  /** Confirmed automatic decisions and recently resolved permissions, for viewers and controls. */
  const recent: ConfirmedDecisionProjection[] = []
  const resolvedIDs = new Set<string>()
  const rememberResolved = (id: string) => {
    resolvedIDs.add(id)
    if (resolvedIDs.size > MAX_RESOLVED_IDS) for (const old of resolvedIDs) { resolvedIDs.delete(old); if (resolvedIDs.size <= MAX_RESOLVED_IDS) break }
  }

  // Optional pricing from the location's own catalog. Never changes a review.
  let pricingCatalog: { models: unknown[]; providers: unknown[] } | undefined
  const refreshPricing = async () => {
    try {
      const [models, providers] = await Promise.all([ctx.model.list(), ctx.provider.list()])
      pricingCatalog = { models: models.data as unknown[], providers: providers.data as unknown[] }
    } catch { /* Missing optional pricing cannot change the review. */ }
  }
  void refreshPricing()
  const pricingTimer = setInterval(() => { void refreshPricing() }, 60000)
  lifecycle.addCleanup(() => clearInterval(pricingTimer))

  const hostingBinder = new HostingBinder(location, ctx.app.channel, { ...dependencies.hosting, registrationFile: dependencies.registrationFile, identity: { nonce } }, lifecycle.signal)
  lifecycle.addCleanup(() => hostingBinder.dispose())
  // Counts server-section changes only. A tui-only edit never touches the engine.
  let serverGeneration = 0
  // A nonsecret counter that changes with the configured sound source, so viewers can
  // drop prepared audio. Never the directory itself.
  let soundGeneration = 0, soundDirectory: string | undefined
  const watcher = new PolicyWatcher(dependencies.policyFile ?? policyFile(), change => {
    if (change.changed.server) serverGeneration++
    const directory = watcher.current?.tui?.notificationSoundDirectory
    if (directory !== soundDirectory) { soundDirectory = directory; soundGeneration++ }
    void reconsider(change.changed.server)
  }, lifecycle.signal, { load: loadPolicy })
  lifecycle.addCleanup(() => watcher.dispose())

  let engine: ServerEngine | undefined
  /** Native events arriving while a replacement engine is being created. */
  let replacing = false
  const buffered: NativeEvent[] = []
  /** The native event stream is the only confirmation channel. Without it, automatic
   * writes are fenced until a fresh subscription and an accepted inventory. */
  let eventsHealthy = false
  const client = (): OpenCodeClient | undefined => { const state = hostingBinder.current; return state.status === "verified" ? state.client : undefined }

  /** Explicit controls, native resolutions and steering caps carried across engine generations. */
  let continuity: ControllerCheckpoint<HostPendingRequest> | undefined

  const createEngine = (generation: PolicyGeneration, verified: OpenCodeClient): ServerEngine => {
    const config = effectiveConfig(generation.server!.config), prompts = generation.server!.prompts
    const access = directCompanionAccess(companion)
    // Direct-domain reads may carry own undefined fields that the wire form omits. Normalize
    // them like the companion does, so identity comparison sees one representation.
    const normalized = <T extends (...args: never[]) => Promise<unknown>>(read: T) => (async (...args: Parameters<T>) => {
      const value = await read(...args)
      return Array.isArray(value) ? value.map(item => serverRequestJSON(item) ?? item) : serverRequestJSON(value) ?? value
    }) as unknown as T
    const permissions: PermissionClient = {
      permission: { get: normalized(ctx.permission.get as never), list: normalized(ctx.permission.list as never), reply: ctx.permission.reply, request: { list: verified.permission.request.list } },
      session: { get: ctx.session.get },
    }
    // Evaluation rechecks permission identity through the in-process, location-pinned
    // reads too. Only conversation reads (messages, sessions, projects) use the self-client.
    const evaluationClient = { ...verified, permission: { ...verified.permission, get: permissions.permission.get, list: permissions.permission.list } } as unknown as OpenCodeClient
    const snapshots = new Map<string, HostRequestSnapshot>()
    const heads = new Map<string, string>()
    const eventOwners = new Map<string, string>()
    const followUps = new SteeringFollowUps()
    const permissionReads = new TransportOwnership()
    const identity = (request: HostPendingRequest) => ledgerKey(request.sessionID, request.id)
    // Fingerprints of the exact request and its bound running invocation, recorded when
    // the review validated its evidence. A request without one never dispatches.
    const fingerprints = new Map<string, { value: string; candidates?: string[] }>()
    const fingerprintOf = (snapshot: HostRequestSnapshot, invocation: HostInvocation, candidates?: string[]) => decisionFingerprint({
      location, request: snapshot.request,
      invocation: { assistantID: invocation.assistantID, callID: invocation.callID, tool: invocation.tool, input: invocation.input },
      ...(candidates ? { candidates } : {}),
    })
    const fingerprint = (request: HostPendingRequest) => {
      const value = fingerprints.get(request.id)?.value
      if (!value) throw new Error("Decision fingerprint unavailable")
      return value
    }
    const recordFingerprint = (request: HostPendingRequest, evidence: HostReviewEvidence, invocation: HostInvocation) => {
      const snapshot = snapshots.get(request.id)
      if (!snapshot || "unavailable" in request || !snapshot.request.source) return
      // Code Mode candidates enter as canonical tool and input encodings of the pre-image only.
      const candidates = evidence.kind === "tool" && evidence.codeMode ? evidence.codeMode.candidates.map(call => canonicalJSON({ tool: call.tool, input: call.input as never })) : undefined
      const value = fingerprintOf(snapshot, invocation, candidates)
      fingerprints.set(request.id, { value, ...(candidates ? { candidates } : {}) })
      if (fingerprints.size > MAX_TRACKED_IDS) for (const id of fingerprints.keys()) { if (snapshots.has(id)) continue; fingerprints.delete(id); if (fingerprints.size <= MAX_TRACKED_IDS) break }
      try { ledger?.fingerprint(identity(request), nonce, value) } catch { /* Dispatch rechecks the ledger. */ }
    }
    /** Immediately before admission: rebind the running invocation and compare its fingerprint
     * with the one the validated evidence recorded. Any difference keeps the request manual. */
    const verify = async (snapshot: HostRequestSnapshot, signal: AbortSignal) => {
      const recorded = fingerprints.get(snapshot.request.id)
      if (!recorded) return false
      const read = await preparePendingInvocation(evaluationClient, snapshot, signal, access)
      signal.throwIfAborted()
      return !!read && fingerprintOf(read.snapshot, read.invocation, recorded.candidates) === recorded.value
    }
    const transport = hostPermissionTransport(permissions, scope, access, { verify })
    /** One consistent publication of a pending inventory: snapshots, event ownership,
     * per-session heads and steering pairing together. */
    const publish = (values: readonly HostPendingSnapshot[]) => {
      snapshots.clear()
      heads.clear()
      for (const value of values) {
        if (!("unavailable" in value.request)) snapshots.set(value.request.id, value as HostRequestSnapshot)
        eventOwners.set(value.request.id, value.request.sessionID)
        if (!heads.has(value.request.sessionID)) heads.set(value.request.sessionID, value.request.id)
      }
      if (eventOwners.size > MAX_TRACKED_IDS) {
        const live = new Set(controller.views.map(value => value.request.id))
        for (const id of eventOwners.keys()) if (!snapshots.has(id) && !live.has(id)) eventOwners.delete(id)
      }
      // Steering pairing follows native arrival order, before review admission.
      if (config.autoRejectSteering) for (const { request } of values) if (!("unavailable" in request)) followUps.asked(request)
    }
    const pending = (signal: AbortSignal) => owned(transport.pendingScope(signal))
    const generationID = serverGeneration
    const current = () => serverGeneration === generationID && hostingBinder.current.status === "verified"
    const controller = new Controller<HostPendingRequest>((request, signal, identified, onProgress, observation) => {
      const snapshot = snapshots.get(request.id)
      if (!snapshot) return Promise.reject(new Error(uiText.review.evidenceUnavailable))
      let pricing: PricingLookup | undefined, retrievalPricing: PricingLookup | undefined
      try {
        if (pricingCatalog) {
          pricing = hostPricingLookup(config.baseURL, pricingCatalog.models as never, pricingCatalog.providers as never)
          retrievalPricing = config.retrievalBaseURL && config.retrievalBaseURL !== config.baseURL
            ? hostPricingLookup(config.retrievalBaseURL, pricingCatalog.models as never, pricingCatalog.providers as never) : pricing
        }
      } catch { /* Optional. */ }
      return evaluateHostReview(evaluationClient, snapshot, config, prompts, signal, identified, {
        onProgress, observation, pricing, retrievalPricing, access,
        loadSessionInstructions: signal => observation?.root ? instructions.read(observation.root, config.maxEvidenceBytes, signal) : Promise.resolve(""),
        ...(config.autoRejectSteering ? { steeringRecord: followUps.paired(request.id) } : {}),
        observeEvidence: (evidence, invocation) => {
          try { recordFingerprint(request, evidence, invocation) } catch {}
          if (observation && config.autoRejectSteering) try { followUps.observe(observation.review, evidence) } catch {}
          return observation ? accounting.observation?.(request, evidence.kind, config, observation) : undefined
        },
      })
    }, () => changed(), {
      reviewOptions: config, modes, session: id => routes.get(id), checkpoint: continuity,
      unavailable: request => "unavailable" in request ? uiText.review.evidenceUnavailable : undefined,
      // Policy generation, hosting, the event stream and the ledger gate every automatic reply.
      // The ledger needs this owner's observed birth and the recorded fingerprint.
      approvalReady: (request, root) => {
        if (!root || !current() || !eventsHealthy || !ledger) return false
        const value = fingerprints.get(request.id)?.value
        try { return !!value && ledger.dispatchable(identity(request), nonce, value) } catch { return false }
      },
      sessionHead: sessionID => heads.get(sessionID),
      reserve: request => { if (!ledger || !current() || !eventsHealthy) return false; ledger.reserve(identity(request), nonce, fingerprint(request)); return true },
      cancelled: request => { if (!ledger) return false; ledger.cancel(identity(request), nonce, fingerprints.get(request.id)?.value ?? ""); return true },
      onLifecycle: fact => {
        if (fact.type === "removed" && fact.reason !== "disposed") {
          rememberResolved(fact.request.id)
          // Only a request gone from the latest inventory is resolved. A re-created view
          // of a still pending request keeps its cancel or reservation row.
          if (!snapshots.has(fact.request.id)) try { ledger?.resolve(identity(fact.request)) } catch {}
          fingerprints.delete(fact.request.id)
        }
        try { accounting.lifecycle?.(fact) } catch {}
      },
      onApproval: fact => {
        if (fact.type === "confirmed" && fact.decision === "reject" && fact.message && fact.review && !("unavailable" in fact.request))
          try { followUps.steered(fact.request, fact.review, fact.message) } catch {}
        if (fact.type === "dispatched") { try { ledger?.sent(identity(fact.request)) } catch {} }
        // Only the engine's own automatic decisions are recent automatic confirmations. An
        // expedited dispatch is a manual decision in accounting and stays out.
        if (fact.type === "confirmed" && fact.review && fact.automatic) {
          recent.push({ sessionID: fact.request.sessionID, permissionID: fact.request.id, attempt: fact.review, decision: fact.decision === "reject" ? "reject" : "once", revision: revision + 1 })
          if (recent.length > MAX_RECENT_DECISIONS) recent.splice(0, recent.length - MAX_RECENT_DECISIONS)
          changed()
        }
        try { accounting.approval?.(fact) } catch {}
      },
      steeringCategory: request => "unavailable" in request ? undefined : followUpCategory(request.action),
      candidate: request => !("unavailable" in request) && !!request.source && ((request.action === "shell" && config.reviewBash)
        || (request.action === "edit" && config.reviewEdits) || (request.action === "external_directory" && config.reviewExternalDirectories)
        || (request.action === "skill" && config.reviewSkills) || config.reviewTools),
      nativeApproval: {
        list: async signal => { const values = await pending(signal); publish(values); return values.map(value => value.request) },
        once: (request, signal, dispatch) => {
          const snapshot = snapshots.get(request.id)
          return snapshot ? owned(transport.once(snapshot, signal, dispatch)) : Promise.resolve({ status: "unavailable" as const })
        },
        reject: (request, signal, dispatch, message) => {
          const snapshot = snapshots.get(request.id)
          return snapshot ? owned(transport.reject(snapshot, signal, dispatch, message)) : Promise.resolve({ status: "unavailable" as const })
        },
      },
    })
    for (const [id, session] of controller.carriedOwners()) eventOwners.set(id, session)
    let events = 0
    const refresh = new PendingRefresh<readonly HostPendingSnapshot[]>({ get revision() { return controller.revision + events },
      reconcile(requests) {
        publish(requests)
        controller.reconcile(requests.map(value => value.request), controller.revision)
        controller.refreshApprovalEligibility()
        if (eventsPendingReconcile) { eventsPendingReconcile = false; eventsHealthy = true }
        changed()
      },
    }, signal => permissionReads.track(pending(signal)), lifecycle.signal)
    const timer = setInterval(() => {
      // A failed mode or ancestry read (for example at read capacity) is retried only from
      // an accepted fresh snapshot, so give the periodic refresh a new revision to reconcile.
      if (controller.suspendedUnavailable()) events++
      void refresh.refresh()
      modes.refresh(lifecycle.signal, controller.modeRoots(), root => { controller.modeChanged(root); void refresh.refresh() })
      controller.refreshApprovalEligibility()
    }, 2000)
    const eligibility = (config.autoApprove || config.autoRejectSteering) ? setInterval(() => controller.refreshApprovalEligibility(), 250) : undefined
    const engineInstance: ServerEngine = {
      generation: generationID, client: verified, controller, refresh, heads, snapshots,
      event(event) {
        if (event.type === "permission.asked") { events++; void refresh.refresh() }
        else if (event.type === "permission.replied") {
          events++
          const data = event.data as { sessionID: string; requestID: string; reply: string }
          if (eventOwners.get(data.requestID) === data.sessionID) {
            transport.resolved({ sessionID: data.sessionID, requestID: data.requestID, decision: data.reply })
            try { accounting.reply?.(data) } catch {}
            followUps.replied(data.sessionID, data.requestID, data.reply)
            controller.permissionReplied({ sessionID: data.sessionID, requestID: data.requestID, decision: data.reply })
          }
          eventOwners.delete(data.requestID)
          void refresh.refresh()
        } else if (event.type === "session.deleted") {
          events++
          const id = (event.data as { sessionID: string }).sessionID
          routes.deleted(id); followUps.deleted(id); ancestry.deleted(id)
          try { accounting.invalidateSession?.(id) } catch {}
          controller.deleted(id)
          void refresh.refresh()
        } else { events++; void refresh.refresh() }
      },
      async dispose() {
        clearInterval(timer)
        if (eligibility) clearInterval(eligibility)
        refresh.dispose()
        const checkpoint = controller.checkpoint()
        continuity = { manual: checkpoint.manual, pending: new Map(), steered: checkpoint.steered }
        await controller.dispose()
        await permissionReads.settled()
        followUps.clear()
      },
    }
    void refresh.refresh()
    return engineInstance
  }

  /** A policy or hosting change replaces the engine as a unit. Manual tombstones and
   * steering caps carry over. Countdowns start fresh. In-flight physical work drains
   * first, and native events of the gap reach the replacement. */
  const reconsider = (serverChanged: boolean) => {
    engineWork = engineWork.then(async () => {
      if (lifecycle.signal.aborted) return
      const generation = watcher.current, verified = client()
      const wanted = !!generation?.server && !!verified
      // A re-verified hosting binding supplies a fresh client. The engine bound to the old one goes.
      if (engine && (!wanted || serverChanged || engine.generation !== serverGeneration || engine.client !== verified)) {
        const old = engine
        replacing = wanted
        engine = undefined
        changed()
        await old.dispose()
      }
      if (lifecycle.signal.aborted || engine || !wanted) { replacing = false; buffered.length = 0; changed(); return }
      engine = createEngine(generation!, verified!)
      replacing = false
      for (const event of buffered.splice(0)) engine.event(event as never)
      changed()
    }).catch(() => { replacing = false; buffered.length = 0 })
    return engineWork
  }
  hostingBinder.onChange(() => { void reconsider(false) })
  lifecycle.addCleanup(async () => { await engineWork; if (engine) { const old = engine; engine = undefined; await old.dispose() } })

  // One location-filtered event loop for every engine generation. Births are observed
  // here, independent of the engine, because only an observed birth may ever dispatch.
  // Losing the stream fences automatic writes until a fresh subscription reconciled.
  let eventsPendingReconcile = false
  let soundReads = 0
  const subscriptions = new AbortController()
  lifecycle.addCleanup(() => subscriptions.abort())
  void (async () => {
    let attempt = 0
    while (!lifecycle.signal.aborted && !subscriptions.signal.aborted) {
      try {
        const stream = ctx.event.subscribe({ types: ["permission.asked", "permission.replied", "session.deleted", "session.moved", "session.step.failed"], signal: subscriptions.signal })
        eventsPendingReconcile = true
        attempt = 0
        if (engine) { engine.event({ type: "stream.resumed", data: {} }) }
        for await (const raw of stream) {
          const event = raw as NativeEvent
          if (lifecycle.signal.aborted) return
          if (event.type === "session.moved") { ancestry.deleted((event.data as { sessionID: string }).sessionID); continue }
          if (event.location && !sameLocation(event.location)) continue
          if (event.type === "session.step.failed" && (event.data as { error?: { type?: string } }).error?.type !== "aborted") continue
          if (event.type === "permission.asked") {
            const data = event.data as { sessionID?: string; id?: string }
            if (typeof data.sessionID === "string" && typeof data.id === "string") try { ledger?.observe(ledgerKey(data.sessionID, data.id), nonce) } catch {}
          } else if (event.type === "permission.replied") {
            const data = event.data as { sessionID?: string; requestID?: string }
            if (typeof data.sessionID === "string" && typeof data.requestID === "string") {
              try {
                const row = ledger?.read(ledgerKey(data.sessionID, data.requestID))
                if (row && (row.state === "reserved" || row.state === "sent")) ledger!.resolve(row.key)
              } catch {}
            }
          }
          if (engine) engine.event(event as never)
          else if (replacing && buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event)
        }
      } catch { /* Subscription ended. */ }
      if (lifecycle.signal.aborted || subscriptions.signal.aborted) return
      // The stream ended without the plugin ending. Fence writes and resubscribe.
      eventsHealthy = false
      eventsPendingReconcile = false
      changed()
      await sleep(Math.min(5000, 250 * 2 ** Math.min(attempt++, 4)))
    }
  })()

  const hostingProjection = (): HostingProjection => {
    const state = hostingBinder.current
    return state.status === "verified" ? { status: "verified" } : { status: "unavailable", reason: state.reason }
  }
  const reviewProjection = (): ReviewProjection => {
    const generation = watcher.current
    if (!generation?.server) return { enabled: false, reason: generation?.serverError ? "invalid-policy" : "no-policy" }
    if (hostingBinder.current.status !== "verified") return { enabled: false, reason: "hosting" }
    return { enabled: true }
  }
  /** Validation text may name keys. Anything that looks like a path stays on the server. */
  const publicError = (text: string | undefined) => text && !/[\\/]/.test(text) ? text : text ? "Reviewer policy invalid" : undefined
  const snapshot = (): ReviewerSnapshot => {
    const generation = watcher.current
    const tui = generation?.tui ? { ...generation.tui, notificationSoundDirectory: undefined, customSounds: generation.tui.notificationSoundDirectory ? true : false, soundGeneration } : undefined
    const config = generation?.server?.config
    const automation: AutomationProjection | undefined = config ? automationProjection(config) : undefined
    const views: ReviewerViewProjection[] = engine ? engine.controller.views.map((view: View<HostPendingRequest>) => {
      const root = engine!.controller.root(view.request.id)
      const { id, sessionID, action } = view.request as { id: string; sessionID: string; action?: string }
      const source = "unavailable" in view.request ? undefined : view.request.source
      // Identity only. Resources, save patterns, metadata and messages never cross to viewers.
      const request = { id, sessionID, ...(action ? { action } : {}), ...(source ? { source } : {}) }
      return { attempt: view.review ?? "", ...(root ? { root } : {}), head: engine!.heads.get(sessionID) === id, view: { ...view, request } }
    }) : []
    const reviewError = publicError(generation?.serverError), tuiError = publicError(generation?.tuiError)
    return { revision, location, hosting: hostingProjection(), review: reviewProjection(),
      ...(reviewError ? { reviewError } : {}), ...(automation ? { automation } : {}), tui, ...(tuiError ? { tuiError } : {}), views, recent }
  }
  const rootOf = (sessionID: string, signal: AbortSignal): Promise<string> => historyRoot(sessionID, signal)
  // Results cross the RPC as JSON: undefined fields are omitted, never encoded.
  const json = (value: unknown): never => JSON.parse(JSON.stringify(value)) as never
  const registration = await ctx.rpc.register(reviewerRpc, {
    identity: async () => ({ nonce, pid: process.pid }),
    snapshot: async () => json(snapshot()),
    history: async (input, call) => {
      const { sessionID, entry, direction, order, permission } = input as { sessionID: string; entry?: string; direction?: "older" | "newer"; order?: HistoryQuery extends { order?: infer O } ? O : never; permission?: HistoryTarget }
      if (!store) return call.error("unavailable", "History storage unavailable", {})
      try {
        const root = await rootOf(sessionID, call.signal)
        const query: HistoryQuery = { type: "history", root, ...(entry ? { entry } : {}), ...(direction ? { direction } : {}),
          ...(order ? { order: order as never } : {}), ...(permission ? { permission } : {}) }
        return json(await store.query(query, call.signal))
      } catch { return call.error("unavailable", "History unavailable", {}) }
    },
    statistics: async (input, call) => {
      const { sessionID } = input as { sessionID?: string }
      if (!store) return call.error("unavailable", "Statistics storage unavailable", {})
      try {
        const root = sessionID ? await rootOf(sessionID, call.signal) : undefined
        return json(await store.query({ type: "totals", ...(root ? { conversation: { root } } : {}) }, call.signal))
      } catch { return call.error("unavailable", "Statistics unavailable", {}) }
    },
    mode: async (input, call) => {
      const { sessionID, set } = input as { sessionID: string; set?: boolean }
      try {
        const root = await rootOf(sessionID, call.signal)
        if (set === undefined) { await modes.load(root, call.signal); return { root, enabled: modes.enabled(root) } }
        await modes.load(root, call.signal).catch(() => {})
        const changedMode = !set || !modes.enabled(root)
        await modes.set(root, set)
        if (changedMode) { engine?.controller.modeChanged(root); void engine?.refresh.refresh() }
        changed()
        return { root, enabled: set }
      } catch { return call.error("unavailable", "Conversation mode unavailable", {}) }
    },
    instructions: async (input, call) => {
      const { sessionID, set } = input as { sessionID: string; set?: string }
      const limit = watcher.current?.server?.config.maxEvidenceBytes ?? 131072
      if (set !== undefined && Buffer.byteLength(set, "utf8") > limit) return call.error("invalid", "Reviewer instructions exceed the limit", {})
      try {
        const root = await rootOf(sessionID, call.signal)
        if (set !== undefined) { await instructions.write(root, set); changed() }
        return { root, text: await instructions.read(root, limit, call.signal, true), limit }
      } catch { return call.error("unavailable", "Reviewer instructions unavailable", {}) }
    },
    control: async (input) => {
      const { sessionID, permissionID, attempt, action } = input as { sessionID: string; permissionID: string; attempt: string; action: "cancel" | "expedite" }
      const view = engine?.controller.views.find(value => value.request.id === permissionID && value.request.sessionID === sessionID)
      if (!engine || !view) return { result: resolvedIDs.has(permissionID) ? "resolved" as const : "unavailable" as const }
      if (view.resolved) return { result: "resolved" as const }
      if (view.review !== attempt) return { result: "late" as const }
      if (action === "cancel") return { result: engine.controller.cancelAutoApproval(permissionID) ? "accepted" as const : "unavailable" as const }
      if (!engine.controller.expeditable(permissionID)) return { result: "unavailable" as const }
      void engine.controller.approveNow(permissionID)
      return { result: "accepted" as const }
    },
    sound: async (input, call) => {
      const { kind, format } = input as { kind: typeof soundKinds[number]; format?: "wav" | "mp3" }
      const directory = watcher.current?.tui?.notificationSoundDirectory
      if (!directory || !soundKinds.includes(kind)) return null
      if (format !== undefined && format !== "wav" && format !== "mp3") return null
      if (soundReads >= MAX_SOUND_READS) return call.error("unavailable", "Sound reads busy", {})
      soundReads++
      try {
        // The requested format, else WAV first, then MP3, like the documented order. Nonblocking
        // open so a special file cannot stall, a regular-file check on the descriptor, a bounded read.
        for (const candidate of format ? [format] : (["wav", "mp3"] as const)) {
          try {
            const handle = await open(path.join(directory, `${kind}.${candidate}`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
            try {
              const stat = await handle.stat()
              if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SOUND_BYTES) continue
              const buffer = Buffer.alloc(stat.size)
              let size = 0
              while (size < buffer.length) {
                call.signal.throwIfAborted()
                const result = await handle.read(buffer, size, buffer.length - size, size)
                if (!result.bytesRead) break
                size += result.bytesRead
              }
              if (size !== stat.size) continue
              return { format: candidate, data: buffer.toString("base64") }
            } finally { await handle.close() }
          } catch (error) {
            if (call.signal.aborted) throw error
            /* Missing or unreadable custom sound of this format: try the next, then the bundled default. */
          }
        }
        return null
      } finally { soundReads-- }
    },
  })
  emit = revision => { void registration.events.emit("changed", { revision }).catch(() => {}) }
  lifecycle.addCleanup(() => registration.dispose())
  lifecycle.signal.throwIfAborted()
  await watcher.start()
  soundDirectory = watcher.current?.tui?.notificationSoundDirectory
  serverGeneration++
  await reconsider(true)
  return { companion, nonce, policy: () => watcher.current, hosting: () => hostingBinder.current, snapshot, engine: () => engine,
    modes, instructions, stateRoot }
}
