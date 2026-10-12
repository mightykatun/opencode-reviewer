import type { PermissionRequest } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, untrack } from "solid-js"
import type { CliPluginState } from "./cli-plugin.js"
import type { View } from "./controller.js"
import type { setupHostHistory } from "./host-history-runtime.js"
import type { HostRequest } from "./host-types.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { sameLocation } from "./companion-protocol.js"
import { hostQueueFront } from "./host-queue.js"
import { setupHostNotifications } from "./host-notifications.js"
import { PendingRefresh } from "./pending-refresh.js"
import { conversationRoot } from "./route-approval.js"

/** Native cache data supplies notification identity, not review provenance. */
function request(value: PermissionRequest): HostRequest {
  return { id: value.id, sessionID: value.sessionID, action: value.action, resources: [...value.resources],
    ...(value.source ? { source: { assistantID: value.source.messageID, id: value.source.id } } : {}) }
}

/** Read-only attention when review configuration or its companion is unavailable.
 * The caller retains the single app surface and all history/storage disposal.
 * No controller, mode files, evaluator, model transport or permission replies. */
export function setupHostNotificationOnly(ctx: Plugin.Context, state: CliPluginState, life: PluginLifecycle,
  records: ReturnType<typeof setupHostHistory>) {
  const location = records.location
  const abort = new AbortController()
  const signal = AbortSignal.any([life.signal, abort.signal])
  const reads = new Set<Promise<unknown>>()
  const sessions = new Set<string>(), visited = new Set<string>(), deleted = new Set<string>()
  let revision = 0, stopped = false
  let views: View<HostRequest>[] = []
  const owned = <T>(work: Promise<T>) => {
    reads.add(work)
    void work.then(() => reads.delete(work), () => reads.delete(work))
    return work
  }
  const settled = async () => { while (reads.size) await Promise.allSettled([...reads]) }
  const session = (id: string) => {
    if (deleted.has(id)) return
    const value = ctx.data.session.get(id)
    return value?.id === id && sameLocation(value.location, location) ? value : undefined
  }
  const permissions = (id: string) => {
    const values = ctx.data.session.permission.list(id)
    if (!values || values.length > 16384 || values.some(value => !value.id || value.sessionID !== id)
      || new Set(values.map(value => value.id)).size !== values.length) return
    return values
  }
  const front = (root: string) => hostQueueFront(root, {
    session, family: id => ctx.data.session.family(id), permissions,
  })
  const notifications = setupHostNotifications(ctx, state, {
    signal, nativeFront: front, resolveRoot: (id, parent) => records.history.root(id, parent),
  })
  // Failed/disabled desktop setup is isolated from the read-only history owner.
  if (!notifications) return

  const publish = (healthy: boolean) => notifications.snapshot(views, healthy)
  const remember = (set: Set<string>, id: string) => {
    if (!id || set.has(id) || set.size >= 16384) return false
    set.add(id); return true
  }
  const root = async (id: string, parent: AbortSignal) => {
    const cached = conversationRoot(id, session)
    if (cached) return cached
    const read = records.history.root(id, parent)
    if (read.settled) owned(read.settled)
    return owned(read)
  }
  const refresh = new PendingRefresh<HostRequest>({
    get revision() { return revision },
    reconcile(values, at) {
      if (stopped || at !== revision) return
      views = values.map(request => ({ request, status: state.config ? "suspended" : "unavailable" }))
    },
  }, parent => owned((async () => {
    parent.throwIfAborted()
    // Read known pending caches to discover families, without syncing every
    // unrelated session in the server's public session catalog.
    const catalog = ctx.data.session.list()
    if (catalog.length > 16384) throw Error("Native session catalog unavailable")
    for (const value of catalog) {
      if (!session(value.id)) continue
      if (ctx.data.session.permission.list(value.id)?.length || ctx.data.session.form.list(value.id)?.length)
        remember(sessions, value.id)
    }
    const roots = new Set<string>()
    for (const id of new Set([...visited, ...sessions])) {
      if (deleted.has(id)) continue
      const resolved = await root(id, parent)
      parent.throwIfAborted()
      if (!resolved || deleted.has(resolved)) throw Error("Native ancestry unavailable")
      roots.add(resolved)
    }
    const members = new Set<string>()
    for (const id of roots) {
      parent.throwIfAborted()
      await owned(ctx.data.session.sync(id))
      parent.throwIfAborted()
      if (conversationRoot(id, session) !== id) throw Error("Native root scope unavailable")
      const family = [id, ...ctx.data.session.family(id).filter(value => value !== id)]
      if (family.length > 16384 || new Set(family).size !== family.length) throw Error("Native family unavailable")
      for (const member of family) members.add(member)
      if (members.size > 16384) throw Error("Native family unavailable")
    }
    // Public family order need not be ancestry order. Refresh all metadata before
    // validating a deep member whose immediate parent may appear later.
    for (const id of members) {
      parent.throwIfAborted()
      if (!roots.has(id)) await owned(ctx.data.session.sync(id))
      parent.throwIfAborted()
    }
    const values: HostRequest[] = [], identities = new Set<string>()
    for (const id of members) {
      parent.throwIfAborted()
      if (!roots.has(conversationRoot(id, session) ?? "")) throw Error("Native family scope unavailable")
      ctx.data.session.permission.invalidate(id)
      await owned(ctx.data.session.permission.sync(id))
      parent.throwIfAborted()
      await owned(ctx.data.session.form.sync(id))
      parent.throwIfAborted()
      const pending = permissions(id)
      const forms = ctx.data.session.form.list(id)
      if (!pending || !forms || forms.some(value => value.sessionID !== id)) throw Error("Native queues unavailable")
      for (const value of pending) {
        if (identities.has(value.id) || identities.size >= 16384) throw Error("Native permission identities unavailable")
        identities.add(value.id); values.push(request(value))
      }
    }
    parent.throwIfAborted()
    await owned(ctx.data.session.form.sync("global", location))
    parent.throwIfAborted()
    if (!ctx.data.session.form.list("global", location)) throw Error("Native global forms unavailable")
    return values
  })()), signal, publish)

  /** Also usable by the caller's existing app composition, without another slot. */
  const visit = (id?: string) => {
    if (stopped || signal.aborted) return
    try {
      notifications.routeChanged()
      if (!id || deleted.has(id)) return
      const cached = ctx.data.session.get(id)
      if (cached && !sameLocation(cached.location, location)) return
      notifications.visit(id)
      if (remember(visited, id)) { revision++; publish(false); void refresh.refresh() }
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
    views = []; sessions.clear(); visited.clear(); deleted.clear()
    return disposal = Promise.allSettled([notifications.dispose(), settled()]).then(() => {})
  }
  const onAbort = () => { void dispose() }
  life.addCleanup(dispose)
  life.signal.addEventListener("abort", onAbort, { once: true })
  if (life.signal.aborted) { void dispose(); return { notifications, refresh, front, visit, views: () => views, dispose, settled } }
  off = ctx.data.listen(({ details: event }) => {
    if (event.type === "server.connected") { void dispose(); return }
    if (stopped || signal.aborted) return
    if (event.location && !sameLocation(event.location, location)) return
    if (event.type !== "permission.asked" && event.type !== "permission.replied" && event.type !== "session.deleted"
      && !event.type.startsWith("form.") && !event.type.startsWith("session.execution.")) return
    try {
      observeRoute()
      let id: string | undefined
      if (event.type === "form.created") id = event.data.form.sessionID
      else if ("sessionID" in event.data && typeof event.data.sessionID === "string") id = event.data.sessionID
      else return
      if (id !== "global") {
        const cached = ctx.data.session.get(id)
        if (cached && !session(id)) return
        if (!event.location && !session(id)) return
        if (deleted.has(id)) return
        if (event.type === "permission.asked" || event.type === "form.created") remember(sessions, id)
      }
      // Revoke stale native ownership before publishing births or terminal facts.
      revision++; publish(false)
      notifications.event(event)
      if (event.type === "session.deleted") { remember(deleted, id); sessions.delete(id); visited.delete(id) }
      void refresh.refresh()
    } catch { publish(false) }
  })
  timer = setInterval(() => { if (!stopped) { try { observeRoute() } catch { publish(false) }; void refresh.refresh() } }, 2000)
  void refresh.refresh()
  return { notifications, refresh, front, visit, views: () => views, dispose, settled }
}
