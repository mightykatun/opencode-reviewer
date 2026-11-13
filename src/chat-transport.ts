import { reviewStage } from "./deadline.js"
import { networkFailure } from "./transport-retry.js"
import type { TransportOwnership } from "./transport-ownership.js"
import type { ModelConnection } from "./config.js"

export function modelApiKey(config: ModelConnection, environment: NodeJS.ProcessEnv): string | undefined {
  const key = config.apiKey ?? (config.apiKeyEnv ? environment[config.apiKeyEnv]?.trim() : undefined)
  if (config.apiKeyEnv && !key) throw new Error(`API key environment variable ${config.apiKeyEnv} is unset or empty`)
  return key
}

/** Each wait removes its listener on settlement; no growing Promise.race listener chain.
 * A fetcher may ignore abort. Own any late response without allowing it back into review.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, ownership?: TransportOwnership, late?: (value: T) => Promise<void>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    const physical = promise.then((value) => {
      if (settled) return late?.(value)
      settled = true
      signal.removeEventListener("abort", abort)
      resolve(value)
    }, (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      reject(error)
    })
    // Track the continuation too: late response cancellation is part of the
    // fetch transaction, with no capacity gap between headers and disposal.
    ownership?.track(physical)
    if (signal.aborted) abort()
  })
}

export async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* Cleanup cannot change the outcome. */ }
}

export async function readBody(response: Response, signal: AbortSignal, ownership: TransportOwnership, consume: (bytes: Uint8Array) => void): Promise<void> {
  if (!response.body) throw new Error("Reviewer returned an empty HTTP response")
  const reader = response.body.getReader()
  try {
    while (true) {
      reviewStage(signal, "Reviewer response body")
      let part: ReadableStreamReadResult<Uint8Array>
      try { part = await abortable(reader.read(), signal, ownership) }
      catch (error) {
        signal.throwIfAborted()
        throw networkFailure(error, "Reviewer response read failed")
      }
      signal.throwIfAborted()
      if (part.done) break
      consume(part.value)
    }
  } finally {
    // Cancellation can close reads before its underlying cleanup settles. Keep
    // physical ownership without making the caller wait beyond its deadline.
    try { ownership.track(reader.cancel()) } catch { /* Cleanup cannot change the outcome. */ }
    finally { reader.releaseLock() }
  }
}

const MAX_RESPONSE_BYTES = 65536
export async function responseText(response: Response, signal: AbortSignal, ownership: TransportOwnership): Promise<string> {
  let bytes = 0
  const chunks: Uint8Array[] = []
  await readBody(response, signal, ownership, (value) => {
    bytes += value.length
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("Reviewer HTTP response exceeds 64 KiB")
    chunks.push(value)
  })
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { throw new Error("Reviewer HTTP response contains invalid UTF-8") }
}
