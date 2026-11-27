import type { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents } from "@opentui/core"
import { createEffect, createMemo, createSignal, Show, untrack } from "solid-js"
import { viewerFront } from "./viewer-front.js"
import { viewerHistory } from "./viewer-history.js"
import type { ViewerFeed, ViewerRow, ViewerSnapshot } from "./viewer-feed.js"
import type { RequestIdentity, View } from "./controller.js"
import { HostReviewPanel } from "./host-review-panel.js"
import { setupHostSessionInstructions } from "./host-session-instructions.js"
import { setupHostModeCommands } from "./host-mode-commands.js"
import { setupHostHistory } from "./host-history-runtime.js"
import { setupHostSidebar } from "./host-sidebar.js"
import { setupHostNotificationOnly } from "./host-notification-runtime.js"
import type { HostNotificationCheckpoint, HostNotificationOptions } from "./host-notifications.js"
import { parseNotificationConfig } from "./notification-config.js"
import type { BundledSound } from "./notification-audio.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import type { PluginDependencies } from "./plugin-dependencies.js"
import { conversationRoot } from "./route-approval.js"
import { reviewLocation, sessionAtLocation, type ReviewLocation } from "./host-locations.js"
import { uiText } from "./ui-text.js"

export interface ViewerLocation {
  feed: ViewerFeed
  snapshot(): ViewerSnapshot | undefined
}
export function setupHostRuntime(ctx: Plugin.Context, life: PluginLifecycle, dependencies: PluginDependencies,
  home: ViewerLocation, lookup: (location: ReviewLocation) => ViewerLocation | undefined,
  previousNotifications?: HostNotificationCheckpoint) {
  const { location, rpc } = home.feed
  const options = { location, signal: life.signal }
  const session = (id: string) => ctx.data.session.get(id)
  const rootRoute = () => {
    const route = ctx.ui.router.current()
    if (route.type === "session" && sessionAtLocation(ctx, route.sessionID, location)
      && conversationRoot(route.sessionID, session) === route.sessionID) return route.sessionID
  }
  const available = () => !life.signal.aborted && !!home.snapshot()
  const { sidebar, geometry } = setupHostSidebar(ctx, life, rootRoute, id => sessionAtLocation(ctx, id, location))
  const history = viewerHistory(home.feed, available)
  const records = setupHostHistory(ctx, life, { rootRoute, available, reader: history.reader, historyProbe: dependencies.historyProbe,
    sidebarOwner: sidebar, sidebarGeometry: geometry })
  const front = viewerFront(ctx, rootRoute, life)
  const owner = (sessionID: string) => {
    const location = reviewLocation(session(sessionID)?.location)
    return location && lookup(location)
  }
  const find = (sessionID: string, id: string) => owner(sessionID)?.snapshot()?.views.find(row =>
    row.view.request.sessionID === sessionID && row.view.request.id === id)
  /** Why the front permission of the routed root gets no report, if so. */
  const unavailableReason = (): string | undefined => {
    if (!available()) return uiText.review.viewerUnavailable
    const root = rootRoute()
    const pending = root && front.current(root)?.front
    if (!pending) return
    const snapshot = owner(pending.sessionID)?.snapshot()
    if (!snapshot) return uiText.review.viewerUnavailable
    if (snapshot.review.enabled === false) return uiText.review.serverReviewDisabled[snapshot.review.reason] ?? uiText.review.viewerUnavailable
    return
  }
  const unavailable = () => unavailableReason() !== undefined
  const [previous, setPrevious] = createSignal<{ root: string
    row: ViewerRow }>()
  const selected = () => {
    const root = rootRoute()
    if (!root || !available()) return
    const queue = front.current(root)
    if (!queue) return
    if (queue.front) {
      const row = find(queue.front.sessionID, queue.front.id)
      if (row?.root === root && row.head && !row.view.resolved && !["identifying", "suspended", "unrelated"].includes(row.view.status)) return row
      return
    }
    const last = previous()
    if (last?.root !== root) return
    const { sessionID, id } = last.row.view.request
    const row = find(sessionID, id)
    if (row?.root === root && row.attempt === last.row.attempt && row.view.retained) return row
  }
  const control = (id: string, attempt: string, action: "cancel" | "expedite") => {
    const row = selected()
    if (!row || !attempt || row.attempt !== attempt || row.view.request.id !== id) return
    const sessionID = row.view.request.sessionID
    const feed = owner(sessionID)?.feed
    if (!feed || feed.signal.aborted) return
    const failed = () => {
      if (!feed.signal.aborted && selected()?.attempt === attempt)
        ctx.ui.toast.show({ message: uiText.review.controlUnavailable, variant: "error" })
    }
    void feed.rpc.control({ permissionID: id, sessionID, attempt, action }, { location: feed.location, signal: feed.signal })
      .then(value => { if ((value as { result: string }).result === "unavailable") failed() }, failed)
      .finally(() => { void feed.refresh() })
  }
  setupHostModeCommands(ctx, available, (sessionID, set) => rpc.mode({ sessionID, set }, options))
  let instructionLimit = 131072
  setupHostSessionInstructions(ctx, life, { root: () => available() ? rootRoute() : undefined, maxBytes: () => instructionLimit,
    read: async (sessionID, signal) => {
      const result = await rpc.instructions({ sessionID }, { location, signal }) as { root: string
        text: string; limit?: number }
      if (result.root !== sessionID || typeof result.text !== "string") throw Error("Instructions unavailable")
      if (Number.isSafeInteger(result.limit) && result.limit! > 0) instructionLimit = result.limit!
      return result.text
    },
    write: async (sessionID, set) => { await rpc.instructions({ sessionID, set }, options) } })

  let cancelReveal = () => {}
  life.addCleanup(() => cancelReveal())
  const openHistory: NonNullable<HostNotificationOptions["openHistory"]> = (root, target, lease) => {
    cancelReveal()
    records.browser.close()
    if (!lease.current()) return
    const retained = () => {
      const row = find(target.session, target.permission)
      return row?.root === root && row.view.retained ? row : undefined
    }
    const reveal = (live: boolean) => {
      const stop = () => {
        clearTimeout(timeout)
        ctx.renderer.off(CliRenderEvents.FRAME, frame)
        lease.signal.removeEventListener("abort", stop)
        if (cancelReveal === stop) cancelReveal = () => {}
      }
      const frame = () => {
        if (!lease.current() || (live && !retained())) {
          stop()
          return
        }
        if (rootRoute() !== root) return
        if (!sidebar() && ctx.keymap.commands().some(command => command.id === "session.sidebar.toggle"))
          ctx.keymap.dispatch("session.sidebar.toggle")
        stop()
      }
      const timeout = setTimeout(stop, 5000)
      cancelReveal = stop
      lease.signal.addEventListener("abort", stop, { once: true })
      ctx.renderer.on(CliRenderEvents.FRAME, frame)
      ctx.renderer.requestRender()
    }
    const row = retained()
    if (row && !front.current(root)?.front) {
      setPrevious({ root, row })
      reveal(true)
      return
    }
    lease.signal.addEventListener("abort", () => records.browser.cancelPendingPermission(), { once: true })
    records.browser.openPermission(root, target, () => {
      if (lease.current()) reveal(false)
      else records.browser.close()
    })
  }
  let settings: string | undefined
  let delivery: ReturnType<typeof setupHostNotificationOnly>
  /** Confirmed decisions already handed to notifications, keyed by session, permission and attempt. */
  const deliveredDecisions = new Set<string>()
  let desktop: PluginLifecycle | undefined
  const retiring = new Set<Promise<void>>()
  const stopDesktop = () => {
    if (!desktop) return
    void desktop.stop()
    const work = desktop.settled()
    retiring.add(work)
    void work.finally(() => retiring.delete(work))
    desktop = undefined
    delivery = undefined
  }
  life.addCleanup(async () => {
    stopDesktop()
    await Promise.allSettled(retiring)
  })
  /** Sources whose latest publication was a snapshot. The first snapshot after a gap is a silent baseline. */
  const live = new Set<ViewerLocation>()
  /** Hand each confirmed decision to notifications once, keyed by session, permission and attempt. */
  const handed = (sessionID: string, permissionID: string, attempt: string) => {
    const key = `${sessionID}\u0000${permissionID}\u0000${attempt}`
    if (deliveredDecisions.has(key)) return false
    deliveredDecisions.add(key)
    if (deliveredDecisions.size > 256) for (const old of deliveredDecisions) { deliveredDecisions.delete(old); if (deliveredDecisions.size <= 256) break }
    return true
  }
  const changed = (source: ViewerLocation) => {
    const snapshot = home.snapshot()
    if (source === home) history.changed()
    // Only a received snapshot decides delivery settings. A reviewer RPC outage keeps the last
    // validated settings and the native observer, so manual attention continues from native events.
    const next = snapshot ? JSON.stringify(snapshot.tui) : settings
    if (settings !== next) {
      const checkpoint = delivery?.notifications.checkpoint() ?? previousNotifications
      previousNotifications = undefined
      stopDesktop()
      settings = next
      if (snapshot?.tui && typeof snapshot.tui === "object") {
        const { customSounds, notify, notifySound, notifications, staleReminderSeconds } = snapshot.tui as Record<string, unknown>
        try {
          if (typeof notify !== "boolean" || typeof notifySound !== "boolean" || typeof customSounds !== "boolean"
            || typeof staleReminderSeconds !== "number" || !notifications || typeof notifications !== "object") return
          const notificationConfig = parseNotificationConfig({ notify, notifySound, notifications, staleReminderSeconds })
          desktop = new PluginLifecycle()
          delivery = setupHostNotificationOnly(ctx, { dependencies, notificationConfig,
            automatic: () => (home.snapshot()?.automation as { autoApprove?: boolean } | undefined)?.autoApprove,
            sound: customSounds === true ? async (kind, signal, format) =>
              await rpc.sound({ kind, format }, { location, signal }) as BundledSound | null : undefined }, desktop, {
            location, checkpoint, openHistory,
            project: request => {
              const row = find(request.sessionID, request.id)
              if (row) return row.head ? { ...row.view, request } : { request, status: "identifying" }
              return { request, status: owner(request.sessionID)?.snapshot()?.review.enabled ? "identifying" : "unavailable" }
            },
          })
        } catch { stopDesktop() }
      }
    }
    const current = source.snapshot()
    // Snapshot reconciliation is silent. The first snapshot of a source after a gap, or ever,
    // only records the decisions it carries. Later revisions deliver new decisions once each.
    const baseline = !live.has(source)
    if (current) live.add(source)
    else live.delete(source)
    const decisions: View<RequestIdentity>[] = []
    for (const row of current?.views ?? []) {
      if (!row.view.resolved || owner(row.view.request.sessionID) !== source) continue
      if (handed(row.view.request.sessionID, row.view.request.id, row.attempt) && !baseline) decisions.push(row.view)
    }
    // A confirmed decision can leave the pending views before this viewer fetched the
    // snapshot. The server keeps recent confirmations, each delivered here once.
    for (const entry of current?.recent ?? []) {
      if (owner(entry.sessionID) !== source || !handed(entry.sessionID, entry.permissionID, entry.attempt) || baseline) continue
      decisions.push({ request: { id: entry.permissionID, sessionID: entry.sessionID }, review: entry.attempt, status: "complete",
        resolved: true, autoApproval: { status: "approved" }, autoDecision: entry.decision })
    }
    delivery?.changed?.(decisions)
  }
  life.addCleanup(ctx.ui.slot({ append: "app", render: () => {
    const routedRoot = createMemo(rootRoute)
    createEffect(() => {
      routedRoot()
      untrack(() => {
        setPrevious(undefined)
        front.invalidate()
      })
    })
    const row = createMemo(selected)
    createEffect(() => {
      const value = row()
      if (value?.root && !value.view.retained) setPrevious({ row: value, root: value.root })
    })
    return <box position="absolute" left={geometry()?.x ?? 0} top={geometry()?.y ?? 0}
      width={geometry()?.width ?? 0} height={geometry()?.height ?? 0} zIndex={1}
      visible={!!rootRoute() && (!!row() || records.state().open || unavailable())}>
      <Show when={!!rootRoute() && !!geometry() && unavailable()}>
        <text position="absolute" bottom={0} fg={ctx.theme.text.muted}>{unavailableReason()}</text>
      </Show>
      <Show when={row()?.view.request.id} keyed>{id => {
        const initial = row()!.view
        return <HostReviewPanel positionedByParent context={ctx} id={id} view={() => row()?.view ?? initial}
          select={() => row()?.view} rootSession={rootRoute} sidebarOwner={sidebar} sidebarGeometry={geometry}
          historyProbe={dependencies.historyProbe} lifetimeText={records.lifetimeText}
          onApprove={(id, attempt) => control(id, attempt, "expedite")} onCancel={(id, attempt) => control(id, attempt, "cancel")} />
      }}</Show>
      {records.render()}</box>
  } }))
  return { changed, records, rootRoute, sidebar, geometry, selected, openHistory, control,
    checkpoint: () => delivery?.notifications.checkpoint() ?? previousNotifications }
}
