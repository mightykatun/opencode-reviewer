import { bindTransportOwnership, transportOwnership } from "./transport-ownership.js"

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

/** A nested wait can shorten, but never extend, the enclosing deadline.
 * A distinct deadline source carries its absolute end without sharing abort:
 * native acknowledgement may outlive a resolution abort, never its time budget. */
export async function withDeadline<T>(parent: AbortSignal, ms: number, run: (signal: AbortSignal) => Promise<T>,
  stage = "Review", deadlineSource = parent): Promise<T> {
  parent.throwIfAborted()
  const controller = new AbortController()
  const signal = AbortSignal.any([parent, controller.signal])
  const now = performance.now()
  // Inherit the absolute end directly. Reconstructing it from a remaining
  // duration and a later clock reading can extend it across a scheduling pause.
  const end = Math.min(now + ms, states.get(parent)?.end ?? Infinity, states.get(deadlineSource)?.end ?? Infinity)
  const duration = Math.max(0, end - now)
  if (duration <= 0) throw new DeadlineError(stage)
  const state = { end, stage }
  states.set(signal, state)
  const ownership = transportOwnership(parent)
  if (ownership) bindTransportOwnership(signal, ownership)
  const timer = setTimeout(() => controller.abort(new DeadlineError(state.stage)), Math.ceil(duration))
  let abort = () => {}
  try {
    const worker = Promise.resolve().then(async () => {
      signal.throwIfAborted()
      if (state.end <= performance.now()) throw new DeadlineError(state.stage)
      const value = await run(signal)
      signal.throwIfAborted()
      if (state.end <= performance.now()) throw new DeadlineError(state.stage)
      return value
    })
    // Nested stage expiry only settles the visible race. The inherited review
    // lease still owns its callback and any transport bound to the child signal.
    ownership?.track(worker)
    return await Promise.race([
      worker,
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
