import timers from "node:timers/promises"
import { CompanionBusyError, type CompanionCollection, type CompanionServer } from "./companion-reads.js"
import { DeadlineError, remainingTime, reviewStage, withDeadline } from "./deadline.js"
import type { HostScope } from "./host-types.js"
import type { RetrievalCall } from "./retrieval-tools.js"
import { transportOwnership } from "./transport-ownership.js"

/** Capacity waits retain the original budget and settle every dispatched read
 * before retrying. Only a pre-admission refusal permits another attempt. */
export async function waitForCompanionCapacity<T>(signal: AbortSignal, dispatch: () => Promise<T>, limitMs = 5000): Promise<T> {
  const end = performance.now() + Math.min(limitMs, remainingTime(signal))
  const guard = () => {
    reviewStage(signal, "Companion evidence lookup")
    if (performance.now() >= end) throw new DeadlineError("Companion evidence lookup")
  }
  for (;;) {
    guard()
    try {
      const work = dispatch()
      const result = await (transportOwnership(signal)?.track(work) ?? work)
      guard()
      return result
    } catch (error) {
      guard()
      if (!(error instanceof CompanionBusyError)) throw error
    }
    await timers.setTimeout(Math.ceil(Math.min(50, end - performance.now())), undefined, { signal })
  }
}

/** How a review reaches the location's exact in-process evidence source.
 * Callers keep their own identity, deadline and ownership checks. */
export interface CompanionAccess {
  readonly scope: HostScope
  /** The current epoch of the scope, or undefined when it was replaced. */
  epoch(signal: AbortSignal): Promise<string | undefined>
  invocation(sessionID: string, requestID: string, signal: AbortSignal): Promise<unknown>
  evidence(sessionID: string, requestID: string, options: unknown, timeoutMs: number, signal: AbortSignal): Promise<unknown>
  /** Resolves only after the server-side physical work drained. Explicit capacity
   * refusals reject with `CompanionBusyError` and prove that nothing started. */
  retrieve(sessionID: string, requestID: string, base: string, call: RetrievalCall, timeoutMs: number, maxBytes: number, signal: AbortSignal): Promise<unknown>
}

/** In-process access for the server engine at the companion's own location. */
export function directCompanionAccess(server: CompanionServer): CompanionAccess {
  const scope: HostScope = { location: server.handshake.location, epoch: server.handshake.epoch }
  const read = (sessionID: string, requestID: string, parent: AbortSignal, collection?: CompanionCollection) =>
    withDeadline(parent, Math.min(collection?.timeoutMs ?? 5000, 5000), signal => waitForCompanionCapacity(signal, () =>
      server.read({ sessionID, requestID }, signal, collection && { ...collection, timeoutMs: remainingTime(signal) })),
    "Companion evidence lookup")
  return {
    scope,
    epoch: async signal => { signal.throwIfAborted(); return server.handshake.epoch },
    invocation: (sessionID, requestID, signal) => read(sessionID, requestID, signal),
    evidence: (sessionID, requestID, options, timeoutMs, signal) => read(sessionID, requestID, signal, { options, timeoutMs }),
    retrieve: (sessionID, requestID, base, call, timeoutMs, maxBytes, signal) =>
      server.retrieve({ sessionID, requestID, base, call, timeoutMs, maxBytes }, signal),
  }
}
