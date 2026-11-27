import os from "node:os"
import path from "node:path"
import timers from "node:timers/promises"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { readIdentity, reviewerRpc } from "./reviewer-protocol.js"
import { withDeadline } from "./deadline.js"

/** Fixed reasons shown instead of a report while a location cannot verify its server. */
export const hostingReasons = {
  unregistered: "The hosting OpenCode server is not the managed background service. Review needs the shared service.",
  foreign: "The registered OpenCode service is not the server hosting this reviewer.",
  unreachable: "The registered OpenCode service did not answer.",
} as const
export type HostingReason = keyof typeof hostingReasons

export type HostingState =
  | { status: "verified"; client: OpenCodeClient; url: string }
  | { status: "unavailable"; reason: HostingReason }

export interface HostingLocation { directory: string; workspaceID?: string }
export interface HostingDependencies {
  /** The registration file of this process's own channel. */
  registrationFile?: string
  discover?: typeof Service.discover
  makeClient?: (endpoint: { url: string; auth?: { type: "basic"; username: string; password: string } }) => OpenCodeClient
  pid?: number
  reverifyMs?: number
  /** Our registered identity, compared with the endpoint's answer. */
  identity: { nonce: string }
}

const sharedChannels = new Set(["latest", "dev", "beta", "next"])

/** The managed service registers under the process state directory, named by channel. */
export function registrationFile(channel: string, environment: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const state = environment.XDG_STATE_HOME
  const base = state && path.isAbsolute(state) && !state.includes("\0") ? state : path.join(home, ".local", "state")
  const name = sharedChannels.has(channel) ? "service.json" : `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
  return path.join(base, "opencode", name)
}

/** One verification attempt. Only pid equality plus a fresh nonce round trip through
 * our own RPC at this location proves the endpoint serves this instance. */
export async function verifyHostingService(location: HostingLocation, channel: string, dependencies: HostingDependencies,
  signal: AbortSignal): Promise<HostingState> {
  const file = dependencies.registrationFile ?? registrationFile(channel)
  const discover = dependencies.discover ?? Service.discover
  const pid = dependencies.pid ?? process.pid
  let endpoint
  try { endpoint = await withDeadline(signal, 5000, () => discover({ file }), "Hosting discovery") }
  catch { signal.throwIfAborted(); return { status: "unavailable", reason: "unreachable" } }
  signal.throwIfAborted()
  if (!endpoint) return { status: "unavailable", reason: "unregistered" }
  const client = dependencies.makeClient ? dependencies.makeClient(endpoint)
    : OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  try {
    return await withDeadline(signal, 5000, async signal => {
      const info = await client.server.info({ signal })
      signal.throwIfAborted()
      if (info.pid !== pid) return { status: "unavailable", reason: "foreign" } as const
      const identity = readIdentity(await client.rpc(reviewerRpc).identity({}, { location: { directory: location.directory }, signal }))
      signal.throwIfAborted()
      if (!identity || identity.nonce !== dependencies.identity.nonce || identity.pid !== pid) return { status: "unavailable", reason: "foreign" } as const
      return { status: "verified", client, url: endpoint.url } as const
    }, "Hosting verification")
  } catch { signal.throwIfAborted(); return { status: "unavailable", reason: "unreachable" } }
}

/** Recheck verified bindings periodically and use backoff while unavailable. */
export class HostingBinder {
  private state: HostingState = { status: "unavailable", reason: "unreachable" }
  private readonly controller = new AbortController()
  private listeners = new Set<(state: HostingState) => void>()
  readonly settled: Promise<void>

  constructor(location: HostingLocation, channel: string, dependencies: HostingDependencies, parent: AbortSignal,
    private delays: readonly number[] = [500, 1000, 2000, 5000, 10000, 30000]) {
    parent.addEventListener("abort", () => this.controller.abort(), { once: true })
    if (parent.aborted) this.controller.abort()
    this.settled = new Promise<void>(resolve => {
      void this.run(location, channel, dependencies, resolve).finally(resolve)
    })
  }

  get current() { return this.state }

  onChange(listener: (state: HostingState) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async run(location: HostingLocation, channel: string, dependencies: HostingDependencies, verified: () => void) {
    const signal = this.controller.signal
    let attempt = 0
    let endpointKey: string | undefined
    let client: OpenCodeClient | undefined
    const makeClient: NonNullable<HostingDependencies["makeClient"]> = endpoint => {
      const key = JSON.stringify([endpoint.url, endpoint.auth?.username, endpoint.auth?.password])
      if (!client || key !== endpointKey) {
        client = dependencies.makeClient?.(endpoint) ?? OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        endpointKey = key
      }
      return client
    }
    while (!signal.aborted) {
      let next: HostingState
      try { next = await verifyHostingService(location, channel, { ...dependencies, makeClient }, signal) }
      catch { next = { status: "unavailable", reason: "unreachable" } }
      if (signal.aborted) break
      if (next.status !== this.state.status
        || (next.status === "unavailable" && this.state.status === "unavailable" && next.reason !== this.state.reason)
        || (next.status === "verified" && this.state.status === "verified" && next.client !== this.state.client)) {
        this.state = next
        for (const listener of this.listeners) { try { listener(next) } catch {} }
      }
      let delay
      if (next.status === "verified") {
        verified()
        attempt = 0
        delay = dependencies.reverifyMs ?? 30000
      } else {
        client = undefined
        delay = this.delays[Math.min(attempt++, this.delays.length - 1)]
      }
      try { await timers.setTimeout(delay, undefined, { signal }) } catch { break }
    }
  }

  dispose() { this.controller.abort() }
}
