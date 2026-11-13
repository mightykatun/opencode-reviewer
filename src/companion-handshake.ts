import type { Plugin } from "@opencode/plugin/tui"
import timers from "node:timers/promises"
import { companionRpc, readCompanionConfiguration, readHandshake, type CompanionHandshake } from "./companion-protocol.js"
import { DeadlineError, remainingTime, withDeadline } from "./deadline.js"
import type { TransportOwnership } from "./transport-ownership.js"
import { connectionFailureIsTransient } from "./transport-retry.js"

interface CompanionAdmission {
  companion?: CompanionHandshake
  options?: Record<string, unknown>
  connection: AbortSignal
  terminal: boolean
}

/** The caller owns the enclosing budget and marker admission. A changed startup
 * connection cancels only its attempt; recovery instead cancels the whole budget. */
export async function companionHandshake(client: () => Plugin.Context["client"], location: CompanionHandshake["location"],
  reads: TransportOwnership, signal: AbortSignal, retry: boolean,
  { connection = () => signal, configuration = false }: { connection?: () => AbortSignal; configuration?: boolean } = {}): Promise<CompanionAdmission | undefined> {
  while (!signal.aborted) {
    const connected = connection()
    let pending: Promise<unknown> | undefined
    try {
      const value = await withDeadline(signal, 1500, attempt => {
        const request = AbortSignal.any([attempt, connected])
        request.throwIfAborted()
        const rpc = client().rpc(companionRpc)
        return pending = reads.track(configuration
          ? rpc.configuration(location, { location, signal: request })
          : rpc.handshake(location, { location, signal: request }))
      }, "Companion handshake")
      signal.throwIfAborted()
      if (connected === connection()) {
        const result = configuration ? readCompanionConfiguration(value, location) : { companion: readHandshake(value, location) }
        return { ...result, connection: connected, terminal: !result?.companion }
      }
    } catch (error) {
      signal.throwIfAborted()
      if (connected === connection() && !(error instanceof DeadlineError) && !connectionFailureIsTransient(error))
        return { companion: undefined, connection: connected, terminal: true }
      if (!retry) return
    }
    // Logical cancellation never permits overlapping physical transactions.
    await pending?.then(() => {}, () => {})
    signal.throwIfAborted()
    if (remainingTime(signal) <= 250) return
    await timers.setTimeout(250, undefined, { signal })
  }
}
