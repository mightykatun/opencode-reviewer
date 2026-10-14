import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show, untrack } from "solid-js"
import path from "node:path"
import { createHash } from "node:crypto"
import type { CliPluginState } from "./cli-plugin.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import type { HostRequest } from "./host-types.js"
import type { HostPanelBounds, HostSidebarAnchor } from "./host-review-panel.js"
import { HistoryStore, type HistoryStoreOptions } from "./history-store.js"
import { HistoryCoordinator, drainHistory } from "./history-coordinator.js"
import { HistoryController, type HistoryViewState } from "./history-controller.js"
import { StatisticsController, type StatisticsState } from "./statistics-controller.js"
import { SessionAncestry, type AncestryReader } from "./session-ancestry.js"
import { TransportOwnership } from "./transport-ownership.js"
import { HostHistoryView, type HostHistoryInput } from "./host-history-view.js"
import { setupHostStatistics } from "./host-statistics-view.js"
import { uiText } from "./ui-text.js"
import { setupHostSidebar } from "./host-sidebar.js"
import { conversationRoot, RouteSessions } from "./route-approval.js"
import { sameLocation } from "./companion-protocol.js"
import { historyStateRoot } from "./local-state.js"
import { initialConnectionEcho } from "./connection-marker.js"

export interface HostHistoryRuntimeOptions {
  rootRoute(): string | undefined
  sidebarOwner(): HostSidebarAnchor | undefined
  sidebarGeometry(): HostPanelBounds | undefined
  /** Explicit source-test/embedding transport seam, never plugin configuration. */
  storeOptions?: HistoryStoreOptions
  /** Scope-pinned metadata only, shared with review but never saved-mode admission. */
  ancestry?: SessionAncestry
}

/** Stable V2 indexing only. Neither this key nor the pathname proves server
 * ownership, authorizes deletion, relabels existing rows or reconstructs lifetime totals. */
export function hostHistoryScope(directory: string): string {
  if (!path.isAbsolute(directory) || directory.includes("\0")) throw Error("History location must be absolute")
  return path.join(path.parse(directory).root, "opencode-reviewer-v2", createHash("sha256").update(path.normalize(directory)).digest("hex"))
}

/** History and aggregate reads do not depend on valid review configuration,
 * companion availability or saved review modes. Call before live-panel listeners
 * are installed. The caller owns controller shutdown and must call dispose(). */
export function setupHostHistory(context: Plugin.Context, pluginState: CliPluginState,
  lifecycle: PluginLifecycle, options: HostHistoryRuntimeOptions) {
  const client = context.client
  const current = context.location ?? context.data.location.default()
  const location = { directory: current.directory, ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}) }
  const scope = hostHistoryScope(location.directory)
  const store = new HistoryStore(historyStateRoot(pluginState.stateRoot), options.storeOptions)
  const generation = new AbortController()
  const [connected, setConnected] = createSignal(true)
  const reads = new TransportOwnership()
  const owned = <T,>(work: Promise<T>): Promise<T> => reads.track(work)
  // Reuse the bounded ancestry traversal and its physical-settlement ownership,
  // never its mode load gate. No session-mode files are read or written here.
  const ancestry = options.ancestry ?? new SessionAncestry(async (id, signal) => {
      signal.throwIfAborted()
      // Native session.get is session-addressed, with no location input. Validate
      // its public location afterward rather than inventing a request option.
      const session = await owned(client.session.get({ sessionID: id }, { signal }))
      signal.throwIfAborted()
      if (session.id !== id || session.location.directory !== location.directory) throw Error("History session scope unavailable")
      return session
    })
  const root: AncestryReader = (id, parent) => {
    const signal = AbortSignal.any([parent, lifecycle.signal, generation.signal])
    const read = ancestry.root(id, signal)
    if (read.settled) owned(read.settled)
    return read
  }
  const history = new HistoryCoordinator<HostRequest>(scope, store, root, Date.now, request => request.source?.assistantID)
  const [state, setState] = createSignal<HistoryViewState>({ open: false, status: "loading", reset: 0 })
  const browser = new HistoryController(scope, store, (id, signal) => history.root(id, signal), setState)
  // Opt-in fixture observation of the actual mounted view's input ownership.
  // The view replaces these disabled methods only after installing real browsing.
  const historyInput: HostHistoryInput | undefined = pluginState.dependencies.historyProbe
    ? { interactive: () => false, scroll: () => {} } : undefined
  const [statisticsState, setStatisticsState] = createSignal<StatisticsState>({
    open: false, view: "lifetime", unavailable: false, ancestry: "none",
  })
  const statistics = new StatisticsController(scope, store, (id, signal) => history.root(id, signal), setStatisticsState)
  const statisticsUI = setupHostStatistics(context, statistics, statisticsState, connected)
  let uiStopped = false
  const stopUI = () => {
    if (uiStopped) return
    uiStopped = true
    setConnected(false)
    statisticsUI.close()
    browser.close()
  }
  // Only UI ownership is registered here. Lifecycle cleanups run concurrently,
  // so closing storage here could race controller transport/accounting finalizers.
  lifecycle.addCleanup(stopUI)
  const selected = () => connected() ? options.rootRoute() : undefined
  context.keymap.layer(() => ({ mode: "global", commands: [{
    id: "reviewer.history", title: uiText.commands.history, group: uiText.commands.category,
    palette: true, slash: { name: "reviewer-history" }, enabled: () => !!selected(),
    run: () => { const session = selected(); if (session) browser.open(session) },
  }] }))
  context.keymap.layer(() => ({ priority: 100, mode: "base", enabled: () => !!selected(), commands: [{
    id: "reviewer.history.toggle", title: uiText.commands.toggleHistory, group: uiText.commands.category,
    bind: "alt+h",
    run: () => {
      const session = selected()
      if (!session || context.keymap.mode.current() !== "base") return
      if (browser.isCurrent(session)) browser.close()
      else browser.open(session)
    },
  }] }))
  const render = () => {
    createEffect(() => {
      const session = selected()
      untrack(() => browser.route(session))
    })
    return <Show when={state().open && selected()} keyed>{session =>
      <HostHistoryView context={context} controller={browser} state={state} session={session}
        rootSession={selected} sidebarOwner={options.sidebarOwner} sidebarGeometry={options.sidebarGeometry}
        input={historyInput} />
    }</Show>
  }
  /** Only invalidate volatile facts. A location index or an unproven stored row
   * cannot authorize persistent deletion or root-family cascading. */
  const invalidateSession = (id: string) => {
    ancestry.deleted(id)
    history.invalidateSession(id)
    browser.close()
    statisticsUI.close()
  }
  /** The captured client may belong to the old server after server.connected.
   * Revocation is permanent for this composition; main creates any replacement. */
  const revoke = () => {
    generation.abort()
    stopUI()
    history.dispose()
    statistics.dispose()
  }
  /** Actual ancestry completion, even when dispose's shared budget expires. */
  const settled = () => reads.settled()
  let disposal: Promise<void> | undefined
  const dispose = (finalizers: Promise<unknown> = Promise.resolve(), abortAt = performance.now()) => {
    if (disposal) return disposal
    revoke()
    browser.dispose()
    return disposal = drainHistory(store, Promise.allSettled([finalizers, settled()]), abortAt)
  }
  return { history, store, browser, state, statistics, statisticsState, lifetimeText: statisticsUI.text,
    render, scope, location, historyInput, invalidateSession, revoke, dispose, settled }
}

/** Read-only composition for unavailable review configuration or companion. The
 * native ancestry cache determines root-only presentation, not saved review mode.
 * No controller lease, permission listener, model transport or maintenance owner. */
export function setupHostHistoryOnly(ctx: Plugin.Context, state: CliPluginState, life: PluginLifecycle,
  storeOptions?: HistoryStoreOptions) {
  let disconnected = false
  const current = ctx.location ?? ctx.data.location.default()
  const location = { directory: current.directory, ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}) }
  const routes = new RouteSessions(id => {
    const session = ctx.data.session.get(id)
    return session && sameLocation(session.location, location) ? session : undefined
  })
  const rootRoute = () => {
    if (disconnected || life.signal.aborted) return
    const route = ctx.ui.router.current()
    if (route.type !== "session" || conversationRoot(route.sessionID, id => routes.get(id)) !== route.sessionID) return
    return route.sessionID
  }
  const { sidebar, geometry } = setupHostSidebar(ctx, life, rootRoute)
  const records = setupHostHistory(ctx, state, life, { rootRoute, sidebarOwner: sidebar,
    sidebarGeometry: geometry, storeOptions })
  life.addCleanup(ctx.ui.slot({ append: "app", render: () =>
    <box position="absolute" left={geometry()?.x ?? 0} top={geometry()?.y ?? 0}
      width={geometry()?.width ?? 0} height={geometry()?.height ?? 0} zIndex={1}
      visible={!!rootRoute() && records.state().open}>{records.render()}</box>,
  }))
  life.addCleanup(ctx.data.listen(({ details: event }) => {
    if (event.type === "server.connected") {
      if (initialConnectionEcho(state.connectionID, event.id)) return
      disconnected = true
      records.revoke()
      return
    }
    if (disconnected || event.type !== "session.deleted") return
    if (event.location && !sameLocation(event.location, records.location)) return
    const known = routes.get(event.data.sessionID)
    if (!known) return
    routes.deleted(known.id)
    records.invalidateSession(known.id)
  }))
  // Keep actual ancestry settlement owned even if the bounded storage drain ends
  // first. There are no review/accounting finalizers in this composition.
  life.addCleanup(() => records.settled())
  life.addCleanup(() => records.dispose())
  return { records, routes, rootRoute, sidebar, geometry, active: () => !disconnected && !life.signal.aborted }
}
