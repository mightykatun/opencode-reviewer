import type { Plugin } from "@opencode/plugin/tui"
import type { CliPluginState } from "./cli-plugin.js"
import type { CompanionHandshake } from "./companion-protocol.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import { withDeadline } from "./deadline.js"
import { TransportOwnership } from "./transport-ownership.js"
import timers from "node:timers/promises"
import { companionHandshake } from "./companion-handshake.js"
import { hostLocation, locationKey, type ReviewLocation } from "./host-locations.js"
import { readCliConfiguration, type CliConfiguration } from "./cli-configuration.js"
import { BUILTIN_PROMPTS } from "./prompts.js"

type Client = Plugin.Context["client"]

/** A connection marker observed on one public client. */
interface Connection { id: string; client: Client }

export interface ReconnectOptions<T> {
  /** Ordered, deduplicated and bounded locations that should hold a composition.
   * The first is the current host location. Read again on every wake. */
  locations(): readonly ReviewLocation[]
  /** Build one scope-pinned composition for exactly this location. */
  install(context: Plugin.Context, state: CliPluginState, life: PluginLifecycle, location: ReviewLocation): T
  /** Capture continuity before a composition is disposed. A failure stops admission for that location. */
  checkpoint?(runtime: T, location: ReviewLocation): void
}

/** The connection facts every location admission shares. */
interface AdmissionHost<T> {
  readonly context: Plugin.Context
  readonly state: CliPluginState
  readonly signal: AbortSignal
  readonly options: ReconnectOptions<T>
  /** The connection both the public client stream and the native bridge agree on. */
  connection(): Connection | undefined
  /** Report a change in a location's admitted composition. */
  changed(): void
}

function marker(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 1024 && !id.includes("\0")
}

/** Replace whole scope-pinned compositions for one location, never revive an
 * old controller. Every location admits independently on the shared connection
 * and drains only its own retired generations before admitting another. */
class LocationAdmission<T> {
  /** Whether the current location set still includes this location. */
  private wanted = false
  private active?: { life: PluginLifecycle; runtime: T; id?: string; client: Client; companion?: CompanionHandshake; state: CliPluginState }
  /** A connection whose admission failed. Health checks cannot promote its fallback. */
  private manualConnection?: string
  private continuityHealthy = true
  private probeAt = performance.now() + 2000
  private admission?: AbortController
  private draining = Promise.resolve()
  private worker?: Promise<void>
  private dirty = false
  private readonly reads = new TransportOwnership()
  private readonly retired = new Set<Promise<void>>()

  constructor(readonly location: ReviewLocation, private readonly host: AdmissionHost<T>) {}

  get runtime(): T | undefined { return this.active?.runtime }
  get companion(): CompanionHandshake | undefined { return this.active?.companion }
  get connectionID(): string | undefined { return this.active?.id }

  want() {
    this.wanted = true
  }

  /** Leave the location set. Continuity is checkpointed for a later return. */
  release() {
    this.wanted = false
    this.retire()
  }

  /** Install the generation that startup already admitted for this location. */
  admitStartup(state: CliPluginState) {
    this.manualConnection = state.companion ? undefined : state.connectionID
    this.start(this.host.context.client, state)
  }

  /** Abort all old work synchronously. Only mandatory native-cache, approval and
   * mode-write leases fence replacement. Optional work remains owned separately. */
  retire(cancelAdmission = true) {
    if (cancelAdmission) this.admission?.abort()
    const previous = this.active
    if (!previous) return
    this.active = undefined
    try { this.host.options.checkpoint?.(previous.runtime, this.location) }
    catch { this.continuityHealthy = false }
    this.probeAt = 0
    void previous.life.stop()
    this.ownRetired(previous.life)
    this.host.changed()
  }

  /** Retire a generation admitted on any other client stream marker. */
  retireUnless(id: string | undefined, client: Client) {
    if (this.active && (this.active.id !== id || this.active.client !== client)) this.retire()
  }

  wake() {
    if (this.host.signal.aborted) return
    this.dirty = true
    if (this.worker) return
    this.worker = this.recover().finally(() => {
      this.worker = undefined
      if (this.dirty && !this.host.signal.aborted) this.wake()
    })
    // Own asynchronous recovery errors even if a public host accessor fails.
    void this.worker.catch(() => {})
  }

  /** Physical settlement of admission reads and every retired generation. */
  async settled() {
    await this.worker?.catch(() => {})
    await this.draining
    await this.reads.settled()
    while (this.retired.size) await Promise.allSettled([...this.retired])
  }

  private current(connection: Connection) {
    const now = this.host.connection()
    return this.wanted && !!now && now.id === connection.id && now.client === connection.client
  }

  private start(client: Client, next: CliPluginState) {
    const child = new PluginLifecycle()
    // Capture the public client once for this generation. Native caches remain
    // guarded by both independently observed connection markers.
    const scoped = new Proxy(this.host.context, { get: (target, key) => key === "client" ? client : Reflect.get(target, key) })
    try {
      const runtime = this.host.options.install(scoped, next, child, this.location)
      this.active = { life: child, runtime, id: next.connectionID, client, companion: next.companion, state: next }
    } catch (error) {
      void child.stop()
      this.ownRetired(child)
      throw error
    }
    this.host.changed()
  }

  private ownRetired(child: PluginLifecycle) {
    const settled = child.settled()
    this.retired.add(settled)
    void settled.finally(() => this.retired.delete(settled))
    this.draining = Promise.allSettled([this.draining, child.criticalSettled()]).then(() => {})
  }

  private async recover() {
    while (this.dirty && !this.host.signal.aborted) {
      this.dirty = false
      await this.draining
      const connection = this.host.connection()
      if (!this.continuityHealthy || !connection || !this.current(connection)
        || this.manualConnection === connection.id || (this.active && performance.now() < this.probeAt)) continue
      this.probeAt = performance.now() + 2000
      const abort = new AbortController()
      this.admission = abort
      let companion: CompanionHandshake | undefined
      let configuration: CliConfiguration | undefined
      let terminal = false
      let rebind = false
      try {
        companion = await withDeadline(AbortSignal.any([this.host.signal, abort.signal]), 10000, async signal => {
          const inherit = this.host.state.inheritOptions && !this.active
          const result = await companionHandshake(() => connection.client, this.location, this.reads, signal,
            !!(this.active?.state ?? this.host.state).config || !!inherit, { configuration: inherit })
          terminal = result?.terminal ?? false
          if (result?.options) configuration = await readCliConfiguration(result.options, signal, this.reads)
          return result?.companion
        }, "Companion reconnection")
      } catch { /* Failed admission leaves this connection manual. */ }
      if (!abort.signal.aborted && (terminal || (!companion && !this.active))) this.manualConnection = connection.id
      // A caller deadline is not physical settlement and never permits overlap.
      await this.reads.settled()
      if (!abort.signal.aborted && this.current(connection)) {
        const previous = this.active
        if (previous?.companion && companion?.epoch === previous.companion.epoch) {
          // A read-only health check cannot re-review or reset a countdown.
        } else if (previous && (companion || terminal)) {
          this.retire(false)
          await this.draining
          if (!abort.signal.aborted && this.current(connection)) {
            if (companion) { this.dirty = true; rebind = true } // Bind again after the old critical work settled.
            else this.start(connection.client, { ...previous.state, companion: undefined, connectionID: connection.id })
          }
        } else if (!previous) this.start(connection.client, { ...this.host.state,
          ...(this.host.state.inheritOptions ? { config: undefined, configError: undefined, notificationConfig: undefined, reviewerOptions: undefined,
            prompts: BUILTIN_PROMPTS, ...configuration } : {}), companion, connectionID: connection.id })
      }
      this.probeAt = rebind ? 0 : performance.now() + 2000
      if (this.admission === abort) this.admission = undefined
    }
  }
}

/** One public connection observer shared by independent location admissions.
 * The public client stream detects loss. The native bridge independently
 * identifies which connection owns its caches. Both must agree before any
 * location admits a fresh composition. Every open tab's location keeps its own
 * composition, so a background conversation is reviewed wherever it lives.
 *
 * Embedding inspection: `state.companion`, `state.connectionID` and `current()`
 * describe the current host location's composition. */
export function setupCliReconnect<T>(context: Plugin.Context, state: CliPluginState, life: PluginLifecycle,
  options: ReconnectOptions<T>) {
  // One entry per location this terminal has reviewed. A released location keeps
  // its manual and continuity facts, so a reopened tab never forgets them.
  const admissions = new Map<string, LocationAdmission<T>>()
  let primary = locationKey(state.companion?.location ?? hostLocation(context))
  let nativeID = state.connectionID, streamID: string | undefined
  let streamClient: Client | undefined
  let source: { client: Client; abort: AbortController } | undefined
  let stalled: { client: Client; id?: string } | undefined
  const publish = () => {
    const admission = admissions.get(primary)
    state.companion = admission?.companion
    state.connectionID = admission?.connectionID
  }
  const host: AdmissionHost<T> = {
    context, state, signal: life.signal, options, changed: publish,
    connection: () => !life.signal.aborted && streamID && streamClient && nativeID === streamID && context.client === streamClient
      ? { id: streamID, client: streamClient } : undefined,
  }
  const admission = (location: ReviewLocation) => {
    const key = locationKey(location)
    let value = admissions.get(key)
    if (!value) admissions.set(key, value = new LocationAdmission(location, host))
    return value
  }
  /** Follow the current location set. A host accessor failure keeps the previous set. */
  const reconcile = () => {
    let locations: readonly ReviewLocation[]
    try { locations = options.locations() } catch { return }
    if (!locations.length) return
    const wanted = new Set(locations.map(locationKey))
    for (const [key, value] of admissions) if (!wanted.has(key)) value.release()
    for (const location of locations) admission(location).want()
    primary = locationKey(locations[0]!)
    publish()
  }
  const retireAll = () => { for (const value of admissions.values()) value.retire() }
  const wake = () => {
    if (life.signal.aborted) return
    reconcile()
    for (const value of admissions.values()) value.wake()
  }
  const off = context.data.on("server.connected", event => {
    if (life.signal.aborted) return
    const id = marker(event.id) ? event.id : undefined
    if (id && id === nativeID && (!source || source.client === context.client)) return
    nativeID = id
    retireAll()
    // A replacement public client need not close the old client's still-healthy
    // stream. End only our subscriber so recovery observes the current client.
    if (source && source.client !== context.client) source.abort.abort()
    wake()
  })
  let monitor = Promise.resolve()
  const health = setInterval(wake, 2000)
  life.addCleanup(async () => {
    clearInterval(health); off(); retireAll()
    await monitor
    await Promise.allSettled([...admissions.values()].map(value => value.settled()))
  })
  const startup = admission(state.companion?.location ?? hostLocation(context))
  startup.want()
  startup.admitStartup({ ...state })
  reconcile()
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
          retireAll()
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
            for (const value of admissions.values()) value.retireUnless(id, client)
            if (id !== nativeID) retireAll()
            wake()
          }
        }
      } catch { /* The client stream is live-only. Subscribe again after loss. */ }
      clearTimeout(idle)
      if (source.abort === abort) source = undefined
      streamID = undefined; streamClient = undefined
      retireAll()
      if (!life.signal.aborted) {
        try { await timers.setTimeout(250, undefined, { signal: life.signal }) } catch {}
      }
    }
  })()
  void monitor.catch(() => {})
  return {
    /** The composition for the current host location. */
    current: () => admissions.get(primary)?.runtime,
    /** The composition admitted for one exact location. */
    runtime: (location: ReviewLocation) => admissions.get(locationKey(location))?.runtime,
  }
}
