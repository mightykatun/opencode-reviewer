import { withDeadline } from "./deadline.js"
import { transportOwnership } from "./transport-ownership.js"

/** Optional local guidance fails open, but abort and physical I/O ownership do not. */
export async function sessionInstructionsSnapshot(load: ((signal: AbortSignal) => Promise<string>) | undefined,
  signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (!load) return ""
  try {
    return await withDeadline(signal, 5000, bounded => {
      const work = Promise.resolve().then(() => { bounded.throwIfAborted(); return load(bounded) })
      transportOwnership(signal)?.track(work)
      return work
    }, "Session instructions lookup")
  } catch {
    signal.throwIfAborted()
    return ""
  }
}
