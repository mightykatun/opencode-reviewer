/** Fixed labels plus monotonic milliseconds and local ordinals only. No host/model data. */
export type DiagnosticPhase = "dispatch" | "headers" | "first-content" | "first-rating" | "final-validation"
export interface DiagnosticEvent {
  phase: DiagnosticPhase
  at: number
  duration: number
  review?: number
  attempt?: number
  call?: number
}
export type DiagnosticObserver = (event: Readonly<DiagnosticEvent>) => void | Promise<void>

/** Observers are never awaited. Exceptions/rejections cannot alter the measured operation. */
export function emitDiagnostic(observer: DiagnosticObserver, event: DiagnosticEvent) {
  try {
    const result = observer(Object.freeze({ phase: event.phase, at: event.at, duration: event.duration,
      ...(event.review === undefined ? {} : { review: event.review }),
      ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
      ...(event.call === undefined ? {} : { call: event.call }),
    }))
    if (result) void Promise.resolve(result).catch(() => {})
  } catch { /* Diagnostics never become review or approval errors. */ }
}

/** Transport durations are relative to dispatch. Content means decoded assessment text,
 * not HTTP bytes/keepalives; non-streaming content becomes available after envelope decoding.
 * Final validation records completion of finish(), including a rejected assessment format.
 */
export function diagnosticAttempt(observer: DiagnosticObserver, attempt: number) {
  const start = performance.now()
  const seen = new Set<DiagnosticPhase>()
  emitDiagnostic(observer, { phase: "dispatch", attempt, at: start, duration: 0 })
  return (phase: "headers" | "first-content" | "first-rating" | "final-validation") => {
    if (seen.has(phase)) return
    seen.add(phase)
    const at = performance.now()
    emitDiagnostic(observer, { phase, attempt, at, duration: Math.max(0, at - start) })
  }
}
