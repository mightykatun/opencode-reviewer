type State = { end: number; stage: string }
const states = new WeakMap<AbortSignal, State>()

export class DeadlineError extends Error {
  constructor(stage: string) { super(`${stage} timed out`); this.name = "DeadlineError" }
}

export function remainingTime(signal: AbortSignal): number {
  signal.throwIfAborted()
  const state = states.get(signal)
  return state ? Math.max(0, state.end - performance.now()) : Infinity
}

export function reviewStage(signal: AbortSignal, stage: string) {
  signal.throwIfAborted()
  const state = states.get(signal)
  if (state) {
    if (state.end <= performance.now()) throw new DeadlineError(state.stage)
    state.stage = stage
  }
}

/** A nested wait can shorten, but never extend, the enclosing deadline. */
export async function withDeadline<T>(parent: AbortSignal, ms: number, run: (signal: AbortSignal) => Promise<T>, stage = "Review"): Promise<T> {
  parent.throwIfAborted()
  const controller = new AbortController()
  const signal = AbortSignal.any([parent, controller.signal])
  const now = performance.now()
  // Inherit the absolute end directly. Reconstructing it from a remaining
  // duration and a later clock reading can extend it across a scheduling pause.
  const end = Math.min(now + ms, states.get(parent)?.end ?? Infinity)
  const duration = Math.max(0, end - now)
  if (duration <= 0) throw new DeadlineError(stage)
  const state = { end, stage }
  states.set(signal, state)
  const timer = setTimeout(() => controller.abort(new DeadlineError(state.stage)), Math.ceil(duration))
  let abort = () => {}
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        signal.throwIfAborted()
        if (state.end <= performance.now()) throw new DeadlineError(state.stage)
        const value = await run(signal)
        signal.throwIfAborted()
        if (state.end <= performance.now()) throw new DeadlineError(state.stage)
        return value
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    controller.abort()
  }
}
