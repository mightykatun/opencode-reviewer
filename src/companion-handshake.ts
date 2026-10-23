import type { Plugin } from "@opencode/plugin/tui"
import timers from "node:timers/promises"
import { companionRpc, readHandshake, type CompanionHandshake } from "./companion-protocol.js"
import { DeadlineError, remainingTime, withDeadline } from "./deadline.js"
import type { TransportOwnership } from "./transport-ownership.js"
import { connectionFailureIsTransient } from "./transport-retry.js"

/** The caller owns the enclosing budget and marker admission. A changed startup
 * connection cancels only its attempt; recovery instead cancels the whole budget. */
export async function companionHandshake(client: () => Plugin.Context["client"], location: CompanionHandshake["location"],
  reads: TransportOwnership, signal: AbortSignal, retry: boolean, connection = () => signal) {
  while (!signal.aborted) {
    const connected = connection()
    let pending: Promise<unknown> | undefined
    try {
      const value = await withDeadline(signal, 1500, attempt => {
        const request = AbortSignal.any([attempt, connected])
        request.throwIfAborted()
        return pending = reads.track(client().rpc(companionRpc).handshake(location, { location, signal: request }))
      }, "Companion handshake")
      signal.throwIfAborted()
      if (connected === connection()) {
        const companion = readHandshake(value, location)
        return { companion, connection: connected, terminal: !companion }
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
