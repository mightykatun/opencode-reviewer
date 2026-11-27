import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal, untrack } from "solid-js"
import { setupHostRuntime, type ViewerLocation } from "./host-runtime.js"
import { hostLocation, locationKey, MAX_REVIEW_LOCATIONS, reviewHomes, routeAtLocation, type ReviewLocation } from "./host-locations.js"
import type { HostNotificationCheckpoint } from "./host-notifications.js"
import { PluginLifecycle } from "./plugin-lifecycle.js"
import type { PluginDependencies } from "./plugin-dependencies.js"
import { viewerFeed, type ViewerSnapshot } from "./viewer-feed.js"

type Layer = Parameters<Plugin.Context["keymap"]["layer"]>[0]

function install(ctx: Plugin.Context, life: PluginLifecycle, dependencies: PluginDependencies, home: ViewerLocation,
  lookup: (location: ReviewLocation) => ViewerLocation | undefined, checkpoint?: HostNotificationCheckpoint) {
  const location = home.feed.location
  const client = ctx.client
  const layers: Layer[] = []
  let collecting = true
  const keymap = new Proxy(ctx.keymap, { get: (target, key) => key !== "layer" ? Reflect.get(target, key) : (factory: Layer) => {
    const scoped = () => {
      const layer = factory()
      return { ...layer, enabled: () => !life.signal.aborted && routeAtLocation(ctx, location)
        && (typeof layer.enabled === "function" ? layer.enabled() : layer.enabled ?? true) }
    }
    if (collecting) layers.push(scoped)
    else target.layer(scoped)
  } })
  const scoped = new Proxy(ctx, { get: (target, key) =>
    key === "keymap" ? keymap : key === "location" ? location : key === "client" ? client : Reflect.get(target, key) })
  const runtime = setupHostRuntime(scoped, life, dependencies, home, lookup, checkpoint)
  collecting = false
  life.addCleanup(ctx.ui.slot({ append: "app", render() {
    for (const layer of layers) ctx.keymap.layer(layer)
    return null
  } }))
  return runtime
}

export function setupCli(ctx: Plugin.Context, life: PluginLifecycle, dependencies: PluginDependencies) {
  type Scope = ViewerLocation & { life: PluginLifecycle
    runtime?: ReturnType<typeof install> }
  const scopes = new Map<string, Scope>()
  const notifications = new Map<string, HostNotificationCheckpoint>()
  const retiring = new Set<Promise<void>>()
  const [membership, setMembership] = createSignal(0)
  const lookup = (location: ReviewLocation) => {
    membership()
    return scopes.get(locationKey(location))
  }
  let client = ctx.client
  const retire = (key: string, scope: Scope) => {
    scopes.delete(key)
    void scope.life.stop()
    const work = scope.life.settled()
    retiring.add(work)
    void work.finally(() => retiring.delete(work))
  }
  const sync = (homes = reviewHomes(ctx), reconnect = false) => {
    if (life.signal.aborted) return
    const locations = new Map(homes.flatMap(home => [home.location, ...home.members]).map(at => [locationKey(at), at]))
    const replaced = reconnect || ctx.client !== client
    client = ctx.client
    let changed = false
    for (const [key, scope] of scopes) {
      if (!replaced && locations.has(key)) continue
      const checkpoint = scope.runtime?.checkpoint()
      if (checkpoint && checkpoint.client === client) {
        notifications.delete(key)
        if (notifications.size >= MAX_REVIEW_LOCATIONS) notifications.delete(notifications.keys().next().value!)
        notifications.set(key, checkpoint)
      }
      retire(key, scope)
      changed = true
    }
    for (const [key, location] of locations) {
      if (scopes.has(key)) continue
      const child = new PluginLifecycle()
      const [snapshot, setSnapshot] = createSignal<ViewerSnapshot>()
      const feed = viewerFeed(client, location, child, data => {
        const scope = scopes.get(key)
        if (!scope || scope.life !== child) return
        setSnapshot(data)
        for (const value of scopes.values()) value.runtime?.changed(scope)
      }, dependencies.observer)
      const scope: Scope = { feed, snapshot, life: child }
      scopes.set(key, scope)
      scope.runtime = install(ctx, child, dependencies, scope, lookup, notifications.get(key))
      notifications.delete(key)
      changed = true
    }
    if (changed) setMembership(n => n + 1)
  }
  life.addCleanup(async () => {
    for (const [key, scope] of scopes) retire(key, scope)
    notifications.clear()
    await Promise.allSettled(retiring)
  })
  sync()
  createRoot(dispose => {
    life.addCleanup(dispose)
    createEffect(() => {
      const homes = reviewHomes(ctx)
      untrack(() => sync(homes))
    })
  })
  life.addCleanup(ctx.data.on("server.connected", () => sync(reviewHomes(ctx), true)))
  const poll = setInterval(() => {
    sync()
    for (const scope of scopes.values()) void scope.feed.refresh()
  }, 2000)
  life.addCleanup(() => clearInterval(poll))
  return { get runtime() { return lookup(hostLocation(ctx))?.runtime } }
}
export type CliPluginState = ReturnType<typeof setupCli>
