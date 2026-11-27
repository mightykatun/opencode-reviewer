import { EventEmitter } from "node:events"
import { setImmediate as tick } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { empty } from "../src/lifetime.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import type { ViewerFeed, ViewerSnapshot } from "../src/viewer-feed.js"
import { setupHostRuntime } from "../src/host-runtime.js"
import type { PluginDependencies } from "../src/plugin-dependencies.js"
import type { HostRequest } from "../src/host-types.js"
import type { HistorySelection } from "../src/history-schema.js"

export function viewerFixture(dependencies: PluginDependencies = {}) {
  const location = { directory: "/server/project" }
  const life = new PluginLifecycle()
  const sessions = new Map([
    ["root", { id: "root", location }],
    ["child", { id: "child", parentID: "root", location }],
    ["other", { id: "other", location: { directory: "/other" } }],
  ])
  let route: ReturnType<Plugin.Context["ui"]["router"]["current"]> = { type: "session", sessionID: "root" }
  let mode = "base"
  let available = true
  const calls: { method: string
    input: unknown
    location: unknown }[] = []
  const sample: HistorySelection = { revision: 1, total: 1, rank: 1, entry: "a".repeat(64),
    record: { context: { root: "root", session: "child", permission: "saved", review: "review", category: "bash",
      configuredModel: "model", provider: "provider" }, payload: { safe: true, desc: "Saved", completedAt: 1 }, outcome: "manual" } }
  const handlers = {
    history: async (_input: unknown): Promise<HistorySelection | null> => sample,
    statistics: async () => ({ revision: 1, totals: empty() }),
    mode: async () => ({}),
    instructions: async () => ({ root: "root", text: "" }),
    control: async () => ({ result: "accepted" }),
  }
  const snapshot: ViewerSnapshot = { location, revision: 1, recent: [], views: [], hosting: { status: "verified" }, review: { enabled: true } }
  const rpc = Object.fromEntries(Object.keys(handlers).map(key => [key, (input: unknown, options: { location: unknown }) => {
    calls.push({ method: key, input, location: options.location })
    return handlers[key as keyof typeof handlers](input)
  }]))
  const home = { feed: { location, signal: life.signal, rpc, refresh: async () => {} } as unknown as ViewerFeed,
    snapshot: () => available ? snapshot : undefined }
  const renderer = Object.assign(new EventEmitter(), { width: 140, height: 40, useMouse: false, requestRender() {} })
  const pending = new Map<string, HostRequest[]>()
  const native = new Map<string, HostRequest[]>()
  const layers: KeymapLayer[] = []
  const slots = new Set<{ prepend?: string
    append?: string
    render(): unknown }>()
  const dispatched: string[] = []
  const listeners = new Set<(e: unknown) => void>()
  const ctx = {
    location,
    get options() { throw Error("Terminal options read") },
    client: { permission: { list: async ({ sessionID }: { sessionID: string }) => pending.get(sessionID) ?? [] } },
    data: { session: { get: (id: string) => sessions.get(id), family: () => ["child"], sync: async () => {},
      permission: { invalidate() {}, sync: async () => {}, list: (id: string) => native.get(id) ?? [] } },
      listen: (fn: (e: unknown) => void) => { listeners.add(fn)
        return () => { listeners.delete(fn) } } },
    renderer, keymap: { layer: (fn: () => KeymapLayer) => layers.push(fn()), mode: { current: () => mode },
      commands: () => [{ id: "session.sidebar.toggle" }], dispatch: (id: string) => dispatched.push(id) },
    ui: { router: { current: () => route },
      dialog: { clear() {}, show() {} }, toast: { show() {} },
      slot: (value: Parameters<typeof slots.add>[0]) => { slots.add(value)
        return () => { slots.delete(value) } } },
  } as unknown as Plugin.Context
  const runtime = setupHostRuntime(ctx, life, dependencies, home, () => home)
  const command = (id: string) => layers.flatMap(layer => layer.commands ?? []).find(command => command.id === id)!
  const refresh = async () => {
    for (const listener of listeners) listener({ details: { type: "permission.asked", data: { sessionID: "root" } } })
    runtime.changed(home)
    await tick()
  }
  return { life, ctx, sessions, snapshot, home, calls, handlers, runtime, renderer, native, pending, layers, slots, dispatched,
    command, sample, refresh, route(value: typeof route) { route = value }, mode(value: string) { mode = value },
    available(value: boolean) { available = value } }
}
