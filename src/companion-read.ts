import timers from "node:timers/promises"
import { companionBusy } from "./companion-protocol.js"
import { DeadlineError, remainingTime, reviewStage } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"

/** Only an explicitly declared capacity rejection permits another read. No
 * queue or detached attempt: each physical RPC settles before a bounded pause,
 * and each dispatch rechecks the original transaction's cancellation/deadline.
 * The callback regenerates collection timeoutMs from that same deadline. */
export async function readCompanion<T>(signal: AbortSignal, dispatch: () => Promise<T>): Promise<T> {
  const end = performance.now() + Math.min(5000, remainingTime(signal))
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
      if (!error || typeof error !== "object" || !("type" in error) || error.type !== companionBusy
        || !("data" in error) || !error.data || typeof error.data !== "object"
        || Array.isArray(error.data) || Object.keys(error.data).length !== 0) throw error
    }
    await timers.setTimeout(Math.ceil(Math.min(50, end - performance.now())), undefined, { signal })
  }
}
