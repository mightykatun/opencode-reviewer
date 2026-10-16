import type { Plugin } from "@opencode/plugin/tui"
import type { CliPluginState } from "./cli-plugin.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import { companionRpc, readHandshake, sameLocation } from "./companion-protocol.js"
import { DeadlineError, remainingTime, withDeadline } from "./deadline.js"
import { TransportOwnership } from "./transport-ownership.js"
import timers from "node:timers/promises"

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
  let active: { life: PluginLifecycle; runtime: T; id?: string; client: Plugin.Context["client"] } | undefined
  let nativeID = state.connectionID, streamID: string | undefined
  let streamClient: Plugin.Context["client"] | undefined
  let source: { client: Plugin.Context["client"]; abort: AbortController } | undefined
  let admission: AbortController | undefined
  let draining = Promise.resolve(), worker: Promise<void> | undefined, dirty = false
  let continuityHealthy = true
  let attempted = state.connectionID
  let manualConnection = state.companion ? undefined : state.connectionID
  const location = () => {
    const value = context.location ?? context.data.location.default()
    return { directory: value.directory, ...(value.workspaceID ? { workspaceID: value.workspaceID } : {}) }
  }
  const retire = () => {
    admission?.abort()
    const previous = active
    if (!previous) return
    active = undefined
    try { checkpoint(previous.runtime) }
    catch { continuityHealthy = false }
    state.companion = undefined
    state.connectionID = undefined
    // stop() aborts and invokes every cleanup synchronously. Physical settlement,
    // including old SQLite workers and uncertain writes, precedes replacement.
    void previous.life.stop()
    draining = Promise.allSettled([draining, previous.life.settled()]).then(() => {})
  }
  const start = (client: Plugin.Context["client"], next: CliPluginState) => {
    const child = new PluginLifecycle()
    // Capture the public client once for this generation. Native caches remain
    // guarded by both independently observed connection markers.
    const scoped = new Proxy(context, { get: (target, key) => key === "client" ? client : Reflect.get(target, key) })
    try {
      const runtime = install(scoped, next, child)
      active = { life: child, runtime, id: next.connectionID, client }
      state.companion = next.companion
      state.connectionID = next.connectionID
    } catch (error) {
      void child.stop()
      draining = Promise.allSettled([draining, child.settled()]).then(() => {})
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
        || attempted === id || manualConnection === id || active) continue
      attempted = id
      const abort = new AbortController()
      admission = abort
      let companion: CliPluginState["companion"]
      try {
        companion = await withDeadline(AbortSignal.any([life.signal, abort.signal]), 10000, async signal => {
          while (!signal.aborted) {
            let pending: Promise<unknown> | undefined
            try {
              const value = await withDeadline(signal, 1500, attempt =>
                pending = reads.track(client.rpc(companionRpc).handshake(at, { location: at, signal: attempt })), "Companion handshake")
              signal.throwIfAborted()
              return readHandshake(value, at)
            } catch (error) {
              signal.throwIfAborted()
              if (!state.config || (!(error instanceof DeadlineError)
                && (!error || typeof error !== "object" || !("type" in error) || error.type !== "rpc.unavailable"))) return
            }
            await pending?.then(() => {}, () => {})
            signal.throwIfAborted()
            if (remainingTime(signal) <= 250) return
            await timers.setTimeout(250, undefined, { signal })
          }
        }, "Companion reconnection")
      } catch { /* Failed admission leaves this connection manual. */ }
      if (!companion && !abort.signal.aborted) manualConnection = id
      // A caller deadline is not physical settlement and never permits overlap.
      await reads.settled()
      if (!abort.signal.aborted && current(id, client, at))
        start(client, { ...state, companion, connectionID: id })
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
  life.addCleanup(async () => {
    off(); retire()
    await Promise.allSettled([monitor, worker])
    await draining
    await reads.settled()
  })
  start(context.client, { ...state })
  monitor = (async () => {
    while (!life.signal.aborted) {
      const client = context.client
      const abort = new AbortController()
      source = { client, abort }
      const signal = AbortSignal.any([life.signal, abort.signal])
      try {
        for await (const event of client.event.subscribe({ signal })) {
          signal.throwIfAborted()
          if (event.type !== "server.connected") continue
          const id = marker(event.id) ? event.id : undefined
          if (id !== streamID || client !== streamClient) {
            streamID = id; streamClient = client
            if (active && (active.id !== id || active.client !== client)) retire()
            if (id !== nativeID) retire()
            wake()
          }
        }
      } catch { /* The client stream is live-only. Subscribe again after loss. */ }
      if (source.abort === abort) source = undefined
      streamID = undefined; streamClient = undefined
      retire()
      // A source failure permits fresh admission of a previously healthy marker,
      // but cannot promote a connection whose handshake already failed.
      attempted = undefined
      if (!life.signal.aborted) {
        try { await timers.setTimeout(250, undefined, { signal: life.signal }) } catch {}
      }
    }
  })()
  void monitor.catch(() => {})
  return { current: () => active?.runtime }
}
