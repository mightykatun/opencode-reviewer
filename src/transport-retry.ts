import timers from "node:timers/promises"
import { remainingTime, reviewStage } from "./deadline.js"

const statuses = new Set([408, 429, 500, 502, 503, 504])
const networkCodes = new Set([
  "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
])

/** Internal retry eligibility, never provider response bodies or raw exception text. */
class TransientTransportError extends Error {
  constructor(message: string, readonly notBefore = 0) { super(message) }
}

/** A rejected stream may be regenerated from scratch, never resumed or accepted. */
export class AssessmentStreamError extends TransientTransportError {}

export function networkFailure(error: unknown, message: string): Error {
  // Node fetch wraps socket errors in cause; Bun exposes code directly. Unknown
  // failures, TLS/certificate errors, redirects and invalid URLs stay terminal.
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    const value = error as { code?: unknown; cause?: unknown }
    if (typeof value.code === "string") {
      return networkCodes.has(value.code) ? new TransientTransportError(message) : new Error(message)
    }
    error = value.cause
  }
  return new Error(message)
}

/** Retry-After is a minimum, not a delay to clamp down to our remaining budget. */
export function retryAfter(value: string | null, now = Date.now()): number {
  if (value === null) return 0
  value = value.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  // Avoid Date.parse interpreting malformed numeric delays as calendar dates.
  if (!/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(value)) return 0
  const date = Date.parse(value.endsWith("GMT") ? value : `${value} GMT`)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

export function httpFailure(response: Response): Error {
  const message = `Reviewer HTTP ${response.status}`
  return statuses.has(response.status)
    ? new TransientTransportError(message, performance.now() + retryAfter(response.headers.get("retry-after")))
    : new Error(message)
}

/** Two extra POSTs total per review, independently of assessment-format retries. */
export class TransportRetries {
  private used = 0
  async wait(error: unknown, signal: AbortSignal, beforeWait?: () => unknown): Promise<boolean> {
    reviewStage(signal, "Reviewer response")
    if (!(error instanceof TransientTransportError) || this.used >= 2) return false
    const base = 250 * 2 ** this.used
    const delay = Math.max(base + Math.random() * base, error.notBefore - performance.now())
    // Leave a small useful request window. A long provider cooldown ends this
    // review rather than extending its deadline or retrying before permission.
    if (delay + 250 >= remainingTime(signal)) return false
    this.used++
    try { void Promise.resolve(beforeWait?.()).catch(() => {}) } catch {}
    // Resolve sleep at the call site so timer mocks control the production wait.
    try { await timers.setTimeout(Math.ceil(delay), undefined, { signal }) }
    catch { signal.throwIfAborted(); throw error }
    reviewStage(signal, "Reviewer response")
    return remainingTime(signal) > 250
  }
}
