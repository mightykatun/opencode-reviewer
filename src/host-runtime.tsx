import type { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents } from "@opentui/core"
import { createEffect, createMemo, createSignal, Show, untrack } from "solid-js"
import path from "node:path"
import { Controller, visibleReview, type View } from "./controller.js"
import { hostPermissionTransport } from "./host-permissions.js"
import { hostQueueFront, hostQueueSnapshot, type HostQueueReader } from "./host-queue.js"
import { refreshNativeFamily } from "./host-native-observations.js"
import { evaluateHostReview } from "./host-evaluate.js"
import { PendingRefresh } from "./pending-refresh.js"
import { SessionModes, SessionModeStore } from "./session-mode.js"
import { conversationRoot, RouteSessions } from "./route-approval.js"
import type { HostRequest, HostRequestSnapshot } from "./host-types.js"
import type { CliPluginState } from "./cli-plugin.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { sameLocation } from "./companion-protocol.js"
import { HostReviewPanel } from "./host-review-panel.js"
import { setupHostHistory, setupHostHistoryOnly } from "./host-history-runtime.js"
import { setupHostNotifications } from "./host-notifications.js"
import { notificationWorkEvent } from "./host-background-work.js"
import { setupHostSidebar } from "./host-sidebar.js"
import { hostPricingLookup } from "./host-pricing.js"
import type { PricingLookup } from "./usage.js"
import { setupHostNotificationOnly } from "./host-notification-runtime.js"
import { hostApprovalReady, nativeDecisionPending } from "./host-approval-ready.js"
import { setupHostModeCommands } from "./host-mode-commands.js"
import { SessionAncestry } from "./session-ancestry.js"
import { TransportOwnership } from "./transport-ownership.js"

/** One scope-pinned controller. A replaced companion never adopts old evidence. */
export function setupHostRuntime(ctx: Plugin.Context, state: CliPluginState, life: PluginLifecycle) {
  const config = state.config, companion = state.companion
  if (!config || !companion) {
    const standalone = setupHostHistoryOnly(ctx, state, life)
    const attention = setupHostNotificationOnly(ctx, state, life, standalone.records)
    // Conversation preferences are local controls, not companion admission.
    // Keep their native commands available without constructing or reviving a
    // reviewer. History's scoped metadata reader owns ancestry settlement.
    const modes = new SessionModes(new SessionModeStore(path.join(state.stateRoot, "session-mode-v2"),
      JSON.stringify(standalone.records.location)), {
      root: (id, signal) => standalone.records.history.root(id, signal),
      deleted: id => standalone.records.invalidateSession(id),
    })
    setupHostModeCommands(ctx, modes, life.signal, {
      active: standalone.active, onChanged: () => {}, onRefresh: () => attention?.refresh.refresh(),
    })
    life.addCleanup(() => modes.flush())
    return
  }
  const scope = { epoch: companion.epoch, location: companion.location }
  const transport = hostPermissionTransport(ctx.client, scope)
  const snapshots = new Map<string, HostRequestSnapshot>()
  const eventOwners = new Map<string, string>()
  const reads = new TransportOwnership()
  const owned = <T,>(work: Promise<T>) => reads.track(work)
  life.addCleanup(() => reads.settled())
  const routes = new RouteSessions(id => ctx.data.session.get(id))
  const store = new SessionModeStore(path.join(state.stateRoot, "session-mode-v2"), JSON.stringify(scope.location))
  const ancestry = new SessionAncestry(async (id, signal) => {
    const options = { location: scope.location, signal }
    const session = await owned(ctx.client.session.get({ sessionID: id }, options))
    signal.throwIfAborted()
    if (session.id !== id || session.location.directory !== scope.location.directory) return
    routes.remember(session)
    return session
  })
  const modes = new SessionModes(store, ancestry)
  const [views, setViews] = createSignal<View<HostRequest>[]>([])
  const queueReader: HostQueueReader = {
    session: id => routes.get(id), family: id => ctx.data.session.family(id),
    // Shared queue observations read only public identities from reactive native
    // caches. Mandatory operation data comes from the scoped server snapshot.
    permissions: id => ctx.data.session.permission.list(id),
  }
  const front = (root: string) => hostQueueFront(root, queueReader)?.id
  const rootRoute = () => {
    const route = ctx.ui.router.current()
    if (route.type !== "session" || conversationRoot(route.sessionID, id => routes.get(id)) !== route.sessionID) return
    return route.sessionID
  }
  const select = () => visibleReview(views(), rootRoute(), id => routes.get(id), root => front(root))
  const { sidebar, geometry } = setupHostSidebar(ctx, life, rootRoute)
  const records = setupHostHistory(ctx, state, life, { rootRoute, sidebarOwner: sidebar, sidebarGeometry: geometry, ancestry })
  let cancelReveal = () => {}
  life.addCleanup(() => cancelReveal())
  const notifications = setupHostNotifications(ctx, state, { signal: life.signal,
    resolveRoot: (id, signal) => records.history.root(id, signal), nativeQueue: root => hostQueueSnapshot(root, queueReader),
    openHistory: (root, target, lease) => {
      cancelReveal()
      records.browser.close()
      if (!lease.current()) return
      const revealSidebar = (live = false) => {
        if (!lease.current()) return
        cancelReveal()
        const stop = () => {
          clearTimeout(timeout)
          ctx.renderer.off(CliRenderEvents.FRAME, reveal)
          lease.signal.removeEventListener("abort", stop)
          if (cancelReveal === stop) cancelReveal = () => {}
        }
        const reveal = () => {
          if (!lease.current() || (live && !controller.retained(root, target))) { stop(); return }
          if (rootRoute() !== root) return
          // A real root FRAME distinguishes a mounted sidebar from an absent one.
          // Only this explicit approval-notification action may reveal it.
          if (!sidebar() && ctx.keymap.commands().some(command => command.id === "session.sidebar.toggle"))
            ctx.keymap.dispatch("session.sidebar.toggle")
          stop()
        }
        const timeout = setTimeout(stop, 5000)
        cancelReveal = stop
        lease.signal.addEventListener("abort", stop, { once: true })
        ctx.renderer.on(CliRenderEvents.FRAME, reveal)
        ctx.renderer.requestRender()
      }
      if (controller.retained(root, target)) { revealSidebar(true); return }
      const invalidate = () => {
        const view = records.state(), selected = view.selection?.record?.context
        if (!view.open || (selected?.permission === target.permission && selected.session === target.session)) records.browser.close()
      }
      lease.signal.addEventListener("abort", invalidate, { once: true })
      records.browser.openPermission(root, target, () => {
        if (!lease.current()) { records.browser.close(); return }
        revealSidebar()
      })
    },
  })
  const controller = new Controller<HostRequest>((request, signal, identified, onProgress, observation) => {
    const snapshot = snapshots.get(request.id)
    if (!snapshot) return Promise.resolve(null)
    let pricing: PricingLookup | undefined
    try { pricing = hostPricingLookup(config.baseURL, ctx.data.location.model.list(scope.location), ctx.data.location.provider.list(scope.location)) }
    catch { /* Missing/failed optional pricing cannot change the review. */ }
    return evaluateHostReview(ctx.client, snapshot, config, state.prompts, signal, identified,
      { onProgress, observation, pricing, onDiagnostics: state.dependencies.observer,
        observeEvidence: evidence => observation ? records.history.observation(request, evidence.kind, config, observation) : undefined })
  }, values => { setViews(values); notifications?.snapshot(controller.pendingViews) }, {
    reviewOptions: config, modes, session: id => routes.get(id),
    approvalReady: (request, root) => hostApprovalReady(request, root, ctx.ui.router.current(), id => routes.get(id),
      () => nativeDecisionPending(ctx.renderer.root, ctx.theme.background.action.primary.focused)),
    nativeFront: root => front(root),
    onLifecycle: records.history.lifecycle,
    onApproval: fact => { records.history.approval(fact); notifications?.approval(fact) },
    candidate: request => !!request.source && ((request.action === "shell" && config.reviewBash)
      || (request.action === "edit" && config.reviewEdits) || (request.action === "external_directory" && config.reviewExternalDirectories)
      || (request.action === "skill" && config.reviewSkills) || config.reviewMcp || config.reviewCustomTools),
    nativeApproval: {
      list: async signal => (await owned(transport.listScope(signal))).map(value => value.request),
      once: (request, signal, dispatch) => {
        const snapshot = snapshots.get(request.id)
        return snapshot ? owned(transport.once(snapshot, signal, dispatch)) : Promise.resolve({ status: "unavailable" as const })
      },
    },
  })
  let events = 0
  let disconnected = false
  const revision = () => controller.revision + events
  let permissionHealthy = false, formHealthy = false
  const notificationSessions = new Set<string>()
  const familyReader = {
    resolveRoot: (id: string, signal: AbortSignal) => records.history.root(id, signal),
    session: (id: string) => routes.get(id),
    family: (root: string) => ctx.data.session.family(root),
    sync: (id: string) => ctx.data.session.sync(id), owned,
  }
  const notificationSnapshot = () => notifications?.snapshot(controller.pendingViews, permissionHealthy && formHealthy)
  // Forms are optional observer evidence. Their failures must never hold up
  // permission admission or an otherwise eligible automatic reply.
  const formRefresh = notifications ? new PendingRefresh<never>({ get revision() { return revision() },
    reconcile: notificationSnapshot,
  }, signal => owned((async () => {
    signal.throwIfAborted()
    const route = ctx.ui.router.current()
    const sessions = new Set([...notificationSessions, ...controller.pendingViews.map(view => view.request.sessionID),
      ...(route.type === "session" ? [route.sessionID] : [])])
    const ids = await refreshNativeFamily(sessions, familyReader, signal)
    for (const id of ids) {
      signal.throwIfAborted()
      await ctx.data.session.form.sync(id)
    }
    signal.throwIfAborted()
    await ctx.data.session.form.sync("global", scope.location)
    signal.throwIfAborted()
    return []
  })()), life.signal, healthy => { formHealthy = healthy; notificationSnapshot() }) : undefined
  life.addCleanup(() => formRefresh?.dispose())
  const refresh = new PendingRefresh<HostRequestSnapshot>({ get revision() { return revision() },
    reconcile(requests, revision) {
      if (controller.revision + events !== revision) return
      snapshots.clear()
      for (const snapshot of requests) {
        snapshots.set(snapshot.request.id, snapshot)
        eventOwners.set(snapshot.request.id, snapshot.request.sessionID)
      }
      if (eventOwners.size > 16384) {
        const live = new Set(controller.views.map(value => value.request.id))
        for (const id of eventOwners.keys()) if (!snapshots.has(id) && !live.has(id)) eventOwners.delete(id)
      }
      controller.reconcile(requests.map(value => value.request), controller.revision)
      notificationSnapshot()
    },
  }, signal => owned((async () => {
    signal.throwIfAborted()
    const all = await owned(transport.listScope(signal))
    // Public native caches must be refreshed as well as the server snapshot.
    const ids = await refreshNativeFamily(new Set([...all.map(value => value.request.sessionID),
      ...controller.pendingViews.map(value => value.request.sessionID)]), familyReader, signal)
    for (const id of ids) {
      signal.throwIfAborted()
      ctx.data.session.permission.invalidate(id)
      await owned(ctx.data.session.permission.sync(id))
      signal.throwIfAborted()
    }
    return all
  })()), life.signal, healthy => {
    permissionHealthy = healthy
    notificationSnapshot()
    if (healthy) void formRefresh?.refresh()
  })
  const off = ctx.data.listen(({ details: event }) => {
    if (event.type === "server.connected") {
      // Startup has already admitted this exact public marker. The native data
      // bridge can deliver its initial echo after the controller is installed.
      if (state.connectionID !== undefined && event.id === state.connectionID) return
      // Native caches can follow a new connection while the captured client still
      // targets its original server. Never combine those generations for a write.
      disconnected = true
      events++
      refresh.dispose()
      formRefresh?.dispose()
      setViews([])
      records.revoke()
      void notifications?.dispose()
      void controller.dispose()
      return
    }
    if (disconnected) return
    if (event.location && !sameLocation(event.location, scope.location)) return
    const interrupted = event.type === "session.step.failed" && event.data.error.type === "aborted"
    if (interrupted || event.type === "permission.asked" || event.type === "permission.replied"
      || event.type === "session.deleted" || notificationWorkEvent(event) || event.type.startsWith("form.")) {
      // Withdraw deferred deliveries before publishing events against stale
      // native caches. Observer health remains separate from approval admission.
      permissionHealthy = false; formHealthy = false
      notificationSnapshot()
    }
    const notificationSession = event.type === "form.created" ? event.data.form.sessionID
      : "sessionID" in event.data ? event.data.sessionID : undefined
    if (event.type === "session.deleted") notificationSessions.delete(event.data.sessionID)
    else if (notifications && typeof notificationSession === "string" && notificationSession !== "global"
      && (notificationSessions.has(notificationSession) || notificationSessions.size < 1024)) notificationSessions.add(notificationSession)
    notifications?.event(event)
    if (event.type === "permission.asked") {
      events++
      // Admission uses the fresh scoped HTTP snapshot, not event origin guesses.
      void refresh.refresh()
    } else if (event.type === "permission.replied") {
      events++
      if (eventOwners.get(event.data.requestID) === event.data.sessionID) {
        transport.resolved({ sessionID: event.data.sessionID, requestID: event.data.requestID, decision: event.data.reply })
        try { records.history.reply(event.data) } catch {}
        controller.permissionReplied({ sessionID: event.data.sessionID, requestID: event.data.requestID, decision: event.data.reply })
      }
      eventOwners.delete(event.data.requestID)
      void refresh.refresh()
    } else if (event.type === "session.deleted") {
      events++
      if (!routes.get(event.data.sessionID)) return
      routes.deleted(event.data.sessionID)
      records.invalidateSession(event.data.sessionID)
      controller.deleted(event.data.sessionID)
      void refresh.refresh()
    } else if (event.type === "session.step.failed" && event.data.error.type === "aborted") {
      try { records.history.interrupted({ sessionID: event.data.sessionID, assistantID: event.data.assistantMessageID }) } catch {}
      events++; void refresh.refresh(); void formRefresh?.refresh()
    } else if (notificationWorkEvent(event) || event.type.startsWith("form.")) {
      events++; void refresh.refresh(); void formRefresh?.refresh()
    }
  })
  life.addCleanup(off)
  life.addCleanup(() => { const at = performance.now(); refresh.dispose(); return records.dispose(controller.dispose(), at) })
  life.addCleanup(() => modes.flush())
  life.addCleanup(() => notifications?.dispose())
  const timer = setInterval(() => { void refresh.refresh() }, 2000)
  life.addCleanup(() => clearInterval(timer))
  life.addCleanup(ctx.ui.slot({ append: "app", render: () => {
    const selected = createMemo(select)
    createEffect(() => {
      const route = ctx.ui.router.current()
      const session = route.type === "session" ? route.sessionID : undefined
      untrack(() => { notifications?.routeChanged(); notifications?.visit(session); void formRefresh?.refresh() })
    })
    createEffect(() => { ctx.ui.router.current(); untrack(() => controller.refreshApprovalEligibility()) })
    return <box position="absolute" left={geometry()?.x ?? 0} top={geometry()?.y ?? 0}
      width={geometry()?.width ?? 0} height={geometry()?.height ?? 0} zIndex={1} visible={!!rootRoute() && (!!selected() || records.state().open)}>
      <Show when={rootRoute() && selected()?.request.id} keyed>{id => {
      const initial = selected()!
      return <HostReviewPanel positionedByParent
      context={ctx} id={id} view={() => views().find(value => value.request.id === id) ?? initial} select={select} rootSession={rootRoute}
      sidebarOwner={sidebar} sidebarGeometry={geometry} config={config}
      historyProbe={state.dependencies.historyProbe}
       lifetimeText={records.lifetimeText}
      onApprove={id => controller.approveNow(id)} onCancel={id => controller.cancelAutoApproval(id)}
       />}}</Show>
      {records.render()}</box>
  } }))
  if (config.autoApprove) {
    // Native choice selection is public renderable styling, not a reactive API.
    // Wake waits without requesting/synthesizing paint or revealing the sidebar.
    const eligibility = setInterval(() => controller.refreshApprovalEligibility(), 100)
    life.addCleanup(() => clearInterval(eligibility))
  }
  setupHostModeCommands(ctx, modes, life.signal, {
    active: () => !disconnected,
    onChanged: root => controller.modeChanged(root),
    onRefresh: () => refresh.refresh(),
  })
  void refresh.refresh()
  return { controller, views, front, routes, modes, refresh, scope, records, notifications }
}
