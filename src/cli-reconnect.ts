import type { Plugin } from "@opencode/plugin/tui"
import type { CliPluginState } from "./cli-plugin.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import { sameLocation } from "./companion-protocol.js"
import { withDeadline } from "./deadline.js"
import { TransportOwnership } from "./transport-ownership.js"
import timers from "node:timers/promises"
import { companionHandshake } from "./companion-handshake.js"

function marker(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 1024 && !id.includes("\0")
}

/** Replace whole scope-pinned compositions, never revive an old controller. The
 * public client stream detects loss; the native bridge independently identifies
 * which connection owns its caches. Both must agree before fresh admission. */
export function setupCliReconnect<T>(context: Plugin.Context, state: CliPluginState, life: PluginLifecycle,
  install: (context: Plugin.Context, state: CliPluginState, life: PluginLifecycle) => T,
  checkpoint: (runtime: T) => void = () => {}) {
  const reads = new TransportOwnership()
  const retired = new Set<Promise<void>>()
  let active: { life: PluginLifecycle; runtime: T; id?: string; client: Plugin.Context["client"]; companion?: CliPluginState["companion"] } | undefined
  let nativeID = state.connectionID, streamID: string | undefined
  let streamClient: Plugin.Context["client"] | undefined
  let source: { client: Plugin.Context["client"]; abort: AbortController } | undefined
  let admission: AbortController | undefined
  let draining = Promise.resolve(), worker: Promise<void> | undefined, dirty = false
  let continuityHealthy = true
  let probeAt = performance.now() + 2000
  let manualConnection = state.companion ? undefined : state.connectionID
  let stalled: { client: Plugin.Context["client"]; id?: string } | undefined
  const location = () => {
    const value = context.location ?? context.data.location.default()
    return { directory: value.directory, ...(value.workspaceID ? { workspaceID: value.workspaceID } : {}) }
  }
  const ownRetired = (child: PluginLifecycle) => {
    const settled = child.settled()
    retired.add(settled)
    void settled.finally(() => retired.delete(settled))
    draining = Promise.allSettled([draining, child.criticalSettled()]).then(() => {})
  }
  const retire = (cancelAdmission = true) => {
    if (cancelAdmission) admission?.abort()
    const previous = active
    if (!previous) return
    active = undefined
    try { checkpoint(previous.runtime) }
    catch { continuityHealthy = false }
    state.companion = undefined
    state.connectionID = undefined
    probeAt = 0
    // Abort all old work synchronously. Only mandatory native-cache, approval and
    // mode-write leases fence replacement; optional work remains owned separately.
    void previous.life.stop()
    ownRetired(previous.life)
  }
  const start = (client: Plugin.Context["client"], next: CliPluginState) => {
    const child = new PluginLifecycle()
    // Capture the public client once for this generation. Native caches remain
    // guarded by both independently observed connection markers.
    const scoped = new Proxy(context, { get: (target, key) => key === "client" ? client : Reflect.get(target, key) })
    try {
      const runtime = install(scoped, next, child)
      active = { life: child, runtime, id: next.connectionID, client, companion: next.companion }
      state.companion = next.companion
      state.connectionID = next.connectionID
    } catch (error) {
      void child.stop()
      ownRetired(child)
      throw error
    }
  }
  const current = (id: string, client: Plugin.Context["client"], at: ReturnType<typeof location>) =>
    !life.signal.aborted && streamID === id && nativeID === id && streamClient === client
      && context.client === client && sameLocation(location(), at)
  const recover = async () => {
    while (dirty && !life.signal.aborted) {
      dirty = false
      await draining
      const id = streamID, client = streamClient, at = location()
      if (!continuityHealthy || !id || !client || !current(id, client, at)
        || manualConnection === id || (active && performance.now() < probeAt)) continue
      probeAt = performance.now() + 2000
      const abort = new AbortController()
      admission = abort
      let companion: CliPluginState["companion"]
      let terminal = false
      let rebind = false
      try {
        companion = await withDeadline(AbortSignal.any([life.signal, abort.signal]), 10000, async signal => {
          const result = await companionHandshake(() => client, at, reads, signal, !!state.config)
          terminal = result?.terminal ?? false
          return result?.companion
        }, "Companion reconnection")
      } catch { /* Failed admission leaves this connection manual. */ }
      if (!abort.signal.aborted && (terminal || (!companion && !active))) manualConnection = id
      // A caller deadline is not physical settlement and never permits overlap.
      await reads.settled()
      if (!abort.signal.aborted && current(id, client, at)) {
        const previous = active
        if (previous?.companion && companion?.epoch === previous.companion.epoch) {
          // A read-only health check cannot re-review or reset a countdown.
        } else if (previous && (companion || terminal)) {
          retire(false)
          await draining
          if (!abort.signal.aborted && current(id, client, at)) {
            if (companion) { dirty = true; rebind = true } // Bind again after the old critical work settled.
            else start(client, { ...state, companion: undefined, connectionID: id })
          }
        } else if (!previous) start(client, { ...state, companion, connectionID: id })
      }
      probeAt = rebind ? 0 : performance.now() + 2000
      if (admission === abort) admission = undefined
    }
  }
  const wake = () => {
    if (life.signal.aborted) return
    dirty = true
    if (worker) return
    worker = recover().finally(() => { worker = undefined; if (dirty && !life.signal.aborted) wake() })
    // Own asynchronous recovery errors even if a public host accessor fails.
    void worker.catch(() => {})
  }
  const off = context.data.on("server.connected", event => {
    if (life.signal.aborted) return
    const id = marker(event.id) ? event.id : undefined
    if (id && id === nativeID && (!source || source.client === context.client)) return
    nativeID = id
    retire()
    // A replacement public client need not close the old client's still-healthy
    // stream. End only our subscriber so recovery observes the current client.
    if (source && source.client !== context.client) source.abort.abort()
    wake()
  })
  let monitor = Promise.resolve()
  const health = setInterval(wake, 2000)
  life.addCleanup(async () => {
    clearInterval(health); off(); retire()
    await Promise.allSettled([monitor, worker])
    await draining
    await reads.settled()
    while (retired.size) await Promise.allSettled([...retired])
  })
  start(context.client, { ...state })
  monitor = (async () => {
    while (!life.signal.aborted) {
      const client = context.client
      const abort = new AbortController()
      source = { client, abort }
      const signal = AbortSignal.any([life.signal, abort.signal])
      let idle: ReturnType<typeof setTimeout> | undefined
      const touch = () => {
        clearTimeout(idle)
        idle = setTimeout(() => {
          stalled = { client, id: streamID }
          retire()
          abort.abort()
        }, 45000)
      }
      touch()
      try {
        for await (const event of client.event.subscribe({ signal, onActivity: touch })) {
          signal.throwIfAborted()
          if (event.type !== "server.connected") continue
          const id = marker(event.id) ? event.id : undefined
          // Do not pin a source already rejected as stalled while the native
          // subscriber is still releasing it. A replay is not fresh activity.
          if (stalled?.client === client && stalled.id === id) { abort.abort(); break }
          stalled = undefined
          touch()
          if (id !== streamID || client !== streamClient) {
            streamID = id; streamClient = client
            if (active && (active.id !== id || active.client !== client)) retire()
            if (id !== nativeID) retire()
            wake()
          }
        }
      } catch { /* The client stream is live-only. Subscribe again after loss. */ }
      clearTimeout(idle)
      if (source.abort === abort) source = undefined
      streamID = undefined; streamClient = undefined
      retire()
      if (!life.signal.aborted) {
        try { await timers.setTimeout(250, undefined, { signal: life.signal }) } catch {}
      }
    }
  })()
  void monitor.catch(() => {})
  return { current: () => active?.runtime }
}
