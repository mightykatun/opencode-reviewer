import type { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type BoxRenderable, type Renderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import path from "node:path"
import { Controller, visibleReview, type View } from "./controller.js"
import { hostPermissionTransport } from "./host-permissions.js"
import { hostQueueFront } from "./host-queue.js"
import { evaluateHostReview } from "./host-evaluate.js"
import { PendingRefresh } from "./pending-refresh.js"
import { SessionModes, SessionModeStore } from "./session-mode.js"
import { conversationRoot, RouteSessions } from "./route-approval.js"
import type { HostRequest, HostRequestSnapshot } from "./host-types.js"
import type { CliPluginState } from "./cli-plugin.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import type { ReviewPresentation } from "./review-presentation.js"
import { uiText } from "./ui-text.js"
import { sameLocation } from "./companion-protocol.js"
import { HostReviewPanel, type HostPanelBounds, type HostSidebarAnchor } from "./host-review-panel.js"

/** One scope-pinned controller. A replaced companion never adopts old evidence. */
export function setupHostRuntime(ctx: Plugin.Context, state: CliPluginState, life: PluginLifecycle) {
  const config = state.config, companion = state.companion
  if (!config || !companion) return
  const scope = { epoch: companion.epoch, location: companion.location }
  const transport = hostPermissionTransport(ctx.client, scope)
  const snapshots = new Map<string, HostRequestSnapshot>()
  const eventOwners = new Map<string, string>()
  const reads = new Set<Promise<unknown>>()
  const owned = <T,>(work: Promise<T>) => {
    reads.add(work)
    void work.then(() => reads.delete(work), () => reads.delete(work))
    return work
  }
  life.addCleanup(() => Promise.allSettled([...reads]).then(() => {}))
  const routes = new RouteSessions(id => ctx.data.session.get(id))
  const store = new SessionModeStore(path.join(state.stateRoot, "session-mode-v2"), JSON.stringify(scope.location))
  const modes = new SessionModes(store, async (id, signal) => {
    const options = { location: scope.location, signal }
    const session = await owned(ctx.client.session.get({ sessionID: id }, options))
    if (session.id !== id || session.location.directory !== scope.location.directory) return
    routes.remember(session)
    return session
  })
  const [views, setViews] = createSignal<View<HostRequest>[]>([])
  const front = (root: string) => hostQueueFront(root, {
    session: id => routes.get(id), family: id => ctx.data.session.family(id),
    permissions: id => {
      const raw = ctx.data.session.permission.list(id)
      if (!raw || raw.length > 16384) return
      // Native Solid caches are reactive objects, not wire evidence. Queue
      // ownership needs only their public identities and array order. Mandatory
      // operation data is independently verified from the scoped server snapshot.
      const values = raw.map(value => ({ id: value.id, sessionID: value.sessionID }))
      return values.every(value => typeof value.id === "string" && !!value.id && value.id.length <= 16384
        && value.sessionID === id) && new Set(values.map(value => value.id)).size === values.length ? values : undefined
    },
  })?.id
  let proof: () => ReviewPresentation = () => ({ state: "lost" })
  const rootRoute = () => {
    const route = ctx.ui.router.current()
    if (route.type !== "session" || conversationRoot(route.sessionID, id => routes.get(id)) !== route.sessionID) return
    return route.sessionID
  }
  const select = () => visibleReview(views(), rootRoute(), id => routes.get(id), root => front(root))
  const registerPresentation = (getter: () => ReviewPresentation) => {
    proof = getter
    return () => { if (proof === getter) proof = () => ({ state: "lost" }) }
  }
  const controller = new Controller<HostRequest>((request, signal, identified, onProgress, observation) => {
    const snapshot = snapshots.get(request.id)
    if (!snapshot) return Promise.resolve(null)
    return evaluateHostReview(ctx.client, snapshot, config, state.prompts, signal, identified,
      { onProgress, observation, onDiagnostics: state.dependencies.observer })
  }, setViews, {
    reviewOptions: config, modes, session: id => routes.get(id), allowHiddenRoute: false,
    nativeFront: root => front(root),
    candidate: request => !!request.source && ((request.action === "shell" && config.reviewBash)
      || (request.action === "edit" && config.reviewEdits) || (request.action === "external_directory" && config.reviewExternalDirectories)
      || (request.action === "skill" && config.reviewSkills) || config.reviewMcp || config.reviewCustomTools),
    nativeApproval: {
      visibleID: () => { const value = proof(); return value.state === "visible" ? value.id : undefined },
      presentation: () => proof(),
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
    },
  }, async signal => {
    const all = await owned(transport.listScope(signal))
    // Public native caches must be refreshed as well as the server snapshot.
    const ids = new Set([...all.map(value => value.request.sessionID), ...controller.pendingViews.map(value => value.request.sessionID)])
    for (const id of [...ids]) {
      const root = await modes.root(id, signal)
      ids.add(root)
      for (const member of ctx.data.session.family(root)) ids.add(member)
      if (ids.size > 16384) throw Error("Native permission family unavailable")
    }
    for (const id of ids) {
      await owned(ctx.data.session.sync(id))
      ctx.data.session.permission.invalidate(id)
      await owned(ctx.data.session.permission.sync(id))
      signal.throwIfAborted()
    }
    return all
  }, life.signal)
  const off = ctx.data.listen(({ details: event }) => {
    if (event.type === "server.connected") {
      // Native caches can follow a new connection while the captured client still
      // targets its original server. Never combine those generations for a write.
      disconnected = true
      events++
      refresh.dispose()
      setViews([])
      void controller.dispose()
      return
    }
    if (disconnected) return
    if (event.location && !sameLocation(event.location, scope.location)) return
    if (event.type === "permission.asked") {
      events++
      // Admission uses the fresh scoped HTTP snapshot, not event origin guesses.
      void refresh.refresh()
    } else if (event.type === "permission.replied") {
      events++
      if (eventOwners.get(event.data.requestID) === event.data.sessionID) controller.permissionReplied({
        sessionID: event.data.sessionID, requestID: event.data.requestID, decision: event.data.reply,
      })
      eventOwners.delete(event.data.requestID)
      void refresh.refresh()
    } else if (event.type === "session.deleted") {
      events++
      if (!routes.get(event.data.sessionID)) return
      routes.deleted(event.data.sessionID)
      controller.deleted(event.data.sessionID)
      void refresh.refresh()
    } else if (event.type.startsWith("session.execution.")) { events++; void refresh.refresh() }
  })
  life.addCleanup(off)
  life.addCleanup(() => { refresh.dispose(); return controller.dispose() })
  life.addCleanup(() => modes.flush())
  const timer = setInterval(() => { void refresh.refresh() }, 2000)
  life.addCleanup(() => clearInterval(timer))
  const [sidebar, setSidebar] = createSignal<HostSidebarAnchor>()
  const [geometry, setGeometry] = createSignal<HostPanelBounds | undefined>(undefined, { equals: (a, b) => a?.x === b?.x && a?.y === b?.y
    && a?.width === b?.width && a?.height === b?.height })
  life.addCleanup(ctx.ui.slot({ prepend: "sidebar.content", render: input => {
    let node: BoxRenderable | undefined
    const owner = Symbol("reviewer.sidebar")
    createEffect(() => { input.sessionID; if (node) setSidebar({ owner, sessionID: input.sessionID, node }) })
    onCleanup(() => { if (sidebar()?.owner === owner) { setSidebar(undefined); setGeometry(undefined); controller.presented({ state: "lost" }) } })
    return <box ref={(value: BoxRenderable) => { node = value; setSidebar({ owner, sessionID: input.sessionID, node }) }} width="100%" height={1} flexShrink={0} />
  } }))
  life.addCleanup(ctx.ui.slot({ append: "app", render: () => {
    const selected = createMemo(select)
    createEffect(() => { rootRoute(); sidebar(); ctx.keymap.mode.current(); untrack(() => controller.presented(proof())) })
    return <box position="absolute" left={geometry()?.x ?? 0} top={geometry()?.y ?? 0}
      width={geometry()?.width ?? 0} height={geometry()?.height ?? 0} zIndex={1} visible={!!rootRoute() && !!selected()}>
      <Show when={rootRoute() && selected()?.request.id} keyed>{id => {
      const initial = selected()!
      return <HostReviewPanel positionedByParent
      context={ctx} id={id} view={() => views().find(value => value.request.id === id) ?? initial} select={select} rootSession={rootRoute}
      sidebarOwner={sidebar} sidebarGeometry={geometry} config={config}
      historyProbe={state.dependencies.historyProbe}
      onApprove={id => controller.approveNow(id)} onCancel={id => controller.cancelAutoApproval(id)}
      registerPresentation={registerPresentation} onPresented={value => controller.presented(value)} />}}</Show></box>
  } }))
  const frame = () => {
    const current = sidebar()
    let node: Renderable | undefined = current?.node
    let region: Renderable | undefined
    // Public renderable ancestry provides the actual sidebar frame, including tabs.
    // Stop before leaving the right-hand native sidebar, never infer visibility.
    for (let depth = 0; node && depth < 16; depth++, node = node.parent ?? undefined) {
      if (node.width >= 34 && node.width <= 42 && node.x >= ctx.renderer.width / 2
        && node.y >= 0 && node.y + node.height <= ctx.renderer.height && !node.isDestroyed && node.visible) region = node
    }
    if (current && region && current.node !== region) setSidebar({ ...current, node: region })
    const value = rootRoute() && region ? { x: region.x, y: region.y, width: region.width, height: region.height } : undefined
    setGeometry(value)
  }
  ctx.renderer.on(CliRenderEvents.FRAME, frame)
  life.addCleanup(() => { ctx.renderer.off(CliRenderEvents.FRAME, frame) })
  if (config.autoApprove) {
    const paint = setInterval(() => { if (select()) ctx.renderer.requestRender() }, 100)
    life.addCleanup(() => clearInterval(paint))
  }
  let modeCommand = 0
  const switchMode = async (enabled: boolean) => {
    if (disconnected) return
    const route = ctx.ui.router.current(), generation = ++modeCommand
    if (route.type !== "session") return
    try {
      const root = await modes.root(route.sessionID, life.signal)
      if (generation !== modeCommand || life.signal.aborted) return
      const changed = modes.enabled(root) !== enabled
      const saving = modes.set(root, enabled)
      if (changed) controller.modeChanged(root)
      void refresh.refresh()
      try {
        await saving
        ctx.ui.toast.show({ message: uiText.sessionMode.saved(enabled), variant: "success" })
      } catch { ctx.ui.toast.show({ message: uiText.sessionMode.saveFailed(enabled), variant: "error" }) }
    } catch { if (!life.signal.aborted) ctx.ui.toast.show({ message: uiText.sessionMode.unavailable, variant: "error" }) }
  }
  ctx.keymap.layer(() => ({ mode: "global", commands: [
    { id: "reviewer.enable", title: uiText.commands.enable, group: uiText.commands.category, palette: true,
      slash: { name: "reviewer-enable" }, run: () => switchMode(true) },
    { id: "reviewer.disable", title: uiText.commands.disable, group: uiText.commands.category, palette: true,
      slash: { name: "reviewer-disable" }, run: () => switchMode(false) },
  ] }))
  void refresh.refresh()
  return { controller, views, front, routes, modes, refresh, scope,
    registerPresentation, presentation: () => proof(),
  }
}
