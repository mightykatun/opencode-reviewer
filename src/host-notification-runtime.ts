import type { PermissionRequest } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, untrack } from "solid-js"
import type { View, RequestIdentity } from "./controller.js"
import type { HostRequest } from "./host-types.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { atLocation, type ReviewLocation } from "./host-locations.js"
import { hostQueueSnapshot, hostPermissionIdentities } from "./host-queue.js"
import { refreshNativeFamilies } from "./host-native-observations.js"
import { setupHostNotifications, type HostNotificationOptions, type ViewerNotifications } from "./host-notifications.js"
import { PendingRefresh } from "./pending-refresh.js"
import { conversationRoot } from "./route-approval.js"
import { TransportOwnership } from "./transport-ownership.js"
import { SessionAncestry, type AncestryReader } from "./session-ancestry.js"
import { notificationEvent, notificationSession, notificationWorkEvent } from "./host-background-work.js"

/** Native cache data supplies notification identity, not review provenance. */
function request(value: PermissionRequest): HostRequest {
  return { id: value.id, sessionID: value.sessionID, action: value.action, resources: [...value.resources],
    ...(value.source ? { source: { assistantID: value.source.messageID, id: value.source.id } } : {}) }
}

/** Merge scoped reviewer views with this viewer's native queues and event births. */
export function setupHostNotificationOnly(ctx: Plugin.Context, state: ViewerNotifications, life: PluginLifecycle,
  records: { location: ReviewLocation
    root?: AncestryReader
    project(request: HostRequest): View<HostRequest>
    openHistory?: HostNotificationOptions["openHistory"]
    checkpoint?: HostNotificationOptions["checkpoint"]
  }) {
  const location = records.location
  const abort = new AbortController()
  const signal = AbortSignal.any([life.signal, abort.signal])
  const reads = new TransportOwnership()
  const deleted = new Set<string>()
  let visited: string | undefined
  let revision = 0, stopped = false
  let views: View<HostRequest>[] = []
  let native: HostRequest[] = []
  let healthyRoots: ReadonlySet<string> = new Set()
  let healthAt = 0
  const owned = <T>(work: Promise<T>) => reads.track(work)
  const settled = () => reads.settled()
  // A family can span locations, for example a subagent moved into a worktree.
  // Its sessions are read wherever they live. The root's location owns them.
  const session = (id: string) => {
    if (deleted.has(id)) return
    const value = ctx.data.session.get(id)
    return value?.id === id ? value : undefined
  }
  /** A known root decides by its own location. Otherwise the observed location does. */
  const here = (id: string, observed: unknown) => {
    const root = conversationRoot(id, session), value = root ? session(root) : undefined
    return atLocation(value ? value.location : observed, location)
  }
  const permissions = (id: string) => {
    return hostPermissionIdentities(id, ctx.data.session.permission.list(id))
  }
  const ancestry = new SessionAncestry((id, signal) => owned(ctx.client.session.get({ sessionID: id }, { signal })))
  const resolveRoot: AncestryReader = records.root ?? ((id, parent) => ancestry.root(id, parent))
  const front = (root: string) => hostQueueSnapshot(root, {
    session, family: id => ctx.data.session.family(id), permissions,
  })
  const notifications = setupHostNotifications(ctx, state, {
    signal, nativeQueue: front, resolveRoot, openHistory: records.openHistory, checkpoint: records.checkpoint,
  })
  // Failed/disabled desktop setup is isolated from the read-only history owner.
  if (!notifications) return

  const publish = (healthy: boolean | ReadonlySet<string>) => {
    if (performance.now() - healthAt >= 5000) healthy = false
    if (healthy === false) healthyRoots = new Set()
    else if (healthy !== true) healthyRoots = healthy
    notifications.snapshot(views, healthy, healthAt + 5000)
  }
  const invalidate = (root?: string) => publish(root ? new Set([...healthyRoots].filter(id => id !== root)) : false)
  const remember = (set: Set<string>, id: string) => {
    if (!id || set.has(id) || set.size >= 16384) return false
    set.add(id); return true
  }
  const root: AncestryReader = (id, parent) => {
    const cached = conversationRoot(id, session)
    if (cached) return Promise.resolve(cached)
    const read = resolveRoot(id, parent)
    if (read.settled) owned(read.settled)
    return owned(read)
  }
  const refresh = new PendingRefresh<{ values: HostRequest[]; roots: ReadonlySet<string> }>({
    get revision() { return revision },
    reconcile({ values, roots }, at) {
      if (stopped || at !== revision) return
      native = values
      views = values.map(records.project)
      healthAt = performance.now()
      publish(roots)
    },
  }, parent => owned((async () => {
    parent.throwIfAborted()
    await owned(ctx.data.session.form.sync("global", location))
    parent.throwIfAborted()
    if (!ctx.data.session.form.list("global", location)) throw Error("Native global forms unavailable")
    const values: HostRequest[] = [], identities = new Set<string>()
    let duplicate = false
    // The bridge already bounds visited roots and live births. Refresh each
    // complete native family without a second lifetime inventory of old visits.
    const roots = await refreshNativeFamilies(notifications.trackedSessions(), {
      resolveRoot: root, session, family: id => ctx.data.session.family(id),
      sync: id => ctx.data.session.sync(id), owned,
    }, parent, async id => {
      parent.throwIfAborted()
      ctx.data.session.permission.invalidate(id)
      await owned(ctx.data.session.permission.sync(id))
      parent.throwIfAborted()
      await owned(ctx.data.session.form.sync(id))
      parent.throwIfAborted()
      const pending = permissions(id)
      const forms = ctx.data.session.form.list(id)
      if (!pending || !forms || forms.some(value => value.sessionID !== id)) throw Error("Native queues unavailable")
      for (const value of pending) {
        if (identities.has(value.id) || identities.size >= 16384) {
          duplicate = true
          throw Error("Native permission identities unavailable")
        }
        identities.add(value.id); values.push(request(value))
      }
    })
    parent.throwIfAborted()
    if (duplicate) throw Error("Native permission identities unavailable")
    return { values, roots }
  })()), signal, (healthy, stale) => { if (!healthy) publish(stale ? healthyRoots : false) })

  /** Also usable by the caller's existing app composition, without another slot. */
  const visit = (id?: string) => {
    if (stopped || signal.aborted) return
    try {
      notifications.routeChanged()
      if (!id) { visited = undefined; return }
      if (deleted.has(id)) return
      const cached = session(id)
      if (cached && !here(id, cached.location)) return
      notifications.visit(id)
      if (visited !== id) { visited = id; revision++; publish(false); void refresh.refresh() }
    } catch { publish(false) }
  }
  const observeRoute = () => {
    const route = ctx.ui.router.current()
    untrack(() => visit(route.type === "session" ? route.sessionID : undefined))
  }
  // Establish the visit boundary synchronously before accepting event births.
  // The owned Solid root observes native route changes without an app surface.
  try { observeRoute() } catch { publish(false) }
  let removeEffect = () => {}
  createRoot(dispose => {
    removeEffect = dispose
    createEffect(() => { try { observeRoute() } catch { publish(false) } })
  })
  let off = () => {}, timer: ReturnType<typeof setInterval> | undefined
  let disposal: Promise<void> | undefined
  const dispose = () => {
    if (disposal) return disposal
    stopped = true; abort.abort(); refresh.dispose()
    clearInterval(timer); off(); removeEffect()
    life.signal.removeEventListener("abort", onAbort)
    views = []; visited = undefined; deleted.clear()
    return disposal = Promise.allSettled([notifications.dispose(), settled()]).then(() => {})
  }
  const onAbort = () => { void dispose() }
  life.addCleanup(dispose, false)
  life.signal.addEventListener("abort", onAbort, { once: true })
  if (life.signal.aborted) { void dispose(); return { notifications, refresh, front, visit, views: () => views, dispose, settled } }
  off = ctx.data.listen(({ details: event }) => {
    // Connection revocation belongs to the supervisor, after its checkpoint.
    if (stopped || signal.aborted || event.type === "server.connected") return
    if (event.type === "session.deleted" || event.type === "session.moved") ancestry.deleted(event.data.sessionID)
    if (!notificationEvent(event)) return
    try {
      const id = notificationSession(event)
      if (!id && (!notificationWorkEvent(event) || !event.location)) return
      if (id && id !== "global") {
        if (deleted.has(id)) return
        // A session event belongs to the home of its conversation, wherever it occurred.
        if (!here(id, session(id)?.location ?? event.location)) return
      } else if (event.location && !atLocation(event.location, location)) return
      observeRoute()
      // Revoke stale native ownership before publishing births or terminal facts.
      revision++; invalidate(notifications.activityRoot(event))
      notifications.event(event)
      if (event.type === "session.deleted") { remember(deleted, event.data.sessionID); if (visited === event.data.sessionID) visited = undefined }
      void refresh.refresh()
    } catch { publish(false) }
  })
  timer = setInterval(() => { if (!stopped) { try { observeRoute() } catch { publish(false) }; void refresh.refresh() } }, 2000)
  void refresh.refresh()
  const changed = (confirmed: readonly View<RequestIdentity>[]) => {
    for (const view of confirmed) notifications.confirmed(view)
    views = native.map(records.project)
    publish(healthyRoots)
  }
  return { notifications, refresh, front, visit, views: () => views, dispose, settled, changed }
}
