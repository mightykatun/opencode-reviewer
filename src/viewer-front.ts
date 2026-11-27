import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { refreshNativeFamily } from "./host-native-observations.js"
import { hostPermissionIdentities, hostQueueFront, hostQueueSnapshot, type HostQueueIdentity } from "./host-queue.js"
import { PendingRefresh } from "./pending-refresh.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { TransportOwnership } from "./transport-ownership.js"
import { conversationRoot } from "./route-approval.js"

export function viewerFront(ctx: Plugin.Context, rootRoute: () => string | undefined, life: PluginLifecycle) {
  const session = ctx.data.session
  const reader = { session: (id: string) => session.get(id), family: (id: string) => session.family(id),
    permissions: (id: string) => session.permission.list(id) }
  const work = new TransportOwnership()
  const [verified, setVerified] = createSignal<{ root: string
    front?: HostQueueIdentity }>()
  let revision = 0
  const head = async (id: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    await work.track(session.permission.sync(id))
    signal.throwIfAborted()
    const pending = hostPermissionIdentities(id, await work.track(ctx.client.permission.list({ sessionID: id }, { signal })))
    if (!pending) throw Error("Native permissions unavailable")
    const native = hostPermissionIdentities(id, session.permission.list(id))
    if (pending[0]?.id !== native?.[0]?.id) {
      session.permission.invalidate(id)
      await work.track(session.permission.sync(id))
    }
    return pending[0] ? { id: pending[0].id, sessionID: id } : undefined
  }
  const refresh = new PendingRefresh({
    get revision() { return revision },
    reconcile: setVerified,
  }, async signal => {
    const root = rootRoute()
    if (!root) return
    const first = await head(root, signal)
    if (first) return { root, front: first }
    const members = await refreshNativeFamily([root], { ...reader, resolveRoot: async () => root,
      sync: id => session.sync(id), owned: p => work.track(p) }, signal)
    for (const id of members) {
      if (id === root) continue
      const front = await head(id, signal)
      if (front) return { root, front }
    }
    return { root }
  }, life.signal, (healthy, stale) => { if (!healthy && !stale) setVerified(undefined) })
  const invalidate = () => {
    revision++
    void refresh.refresh()
  }
  life.addCleanup(ctx.data.listen(({ details }) => {
    if (details.type === "session.moved" || details.type === "session.deleted") invalidate()
    if (details.type === "permission.asked" || details.type === "permission.replied") {
      const root = conversationRoot(details.data.sessionID, reader.session)
      if (!root || root === rootRoute()) invalidate()
    }
  }))
  const tick = setInterval(() => { void refresh.refresh() }, 2000)
  life.addCleanup(() => {
    clearInterval(tick)
    refresh.dispose()
    return work.settled()
  })
  void refresh.refresh()
  return { invalidate, current(root: string) {
    const value = verified()
    if (!value || value.root !== root) return
    if (!value.front) return hostQueueSnapshot(root, reader).state === "empty" ? value : undefined
    const native = hostQueueFront(root, reader)
    if (native?.id !== value.front?.id || native?.sessionID !== value.front?.sessionID) return
    return value
  } }
}
