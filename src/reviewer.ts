import type { Config } from "./config.js"
import type { Assessment, ReviewProgress, ReviewResult, ReviewObservation, ReviewAttemptEvent } from "./types.js"
import { randomUUID } from "node:crypto"
import { BUILTIN_PROMPTS, CONTRACT, correctionPrompt, type PromptSet } from "./prompts.js"
import { usageAttempt, sumUsage, type PricingLookup, type Usage } from "./usage.js"
import { remainingTime, reviewStage, withDeadline } from "./deadline.js"
import { SSEParser } from "./sse.js"
import { AssessmentFormatError, StreamingAssessment } from "./streaming-assessment.js"
import { diagnosticAttempt, type DiagnosticObserver } from "./diagnostics.js"
import { AssessmentStreamError, httpFailure, networkFailure, TransportRetries } from "./transport-retry.js"
import { TransportOwnership, transportOwnership } from "./transport-ownership.js"
import type { HostReviewEvidence } from "./host-evidence.js"
export { withDeadline } from "./deadline.js"

export function parseAssessment(content: string): Assessment {
  const parser = new StreamingAssessment()
  parser.push(content)
  return parser.finish()
}

/** Each wait removes its listener on settlement; no growing Promise.race listener chain.
 * A fetcher may ignore abort. Own any late response without allowing it back into review.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, ownership?: TransportOwnership, late?: (value: T) => Promise<void>): Promise<T> {
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

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* Cleanup cannot change the outcome. */ }
}

async function readBody(response: Response, signal: AbortSignal, ownership: TransportOwnership, consume: (bytes: Uint8Array) => void): Promise<void> {
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
async function responseText(response: Response, signal: AbortSignal, ownership: TransportOwnership): Promise<string> {
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

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const textMetadata = (message: Record<string, unknown>) => (message.role === undefined || message.role === "assistant")
  && message.function_call == null
  && (message.tool_calls == null || (Array.isArray(message.tool_calls) && message.tool_calls.length === 0))
  && (message.refusal == null || message.refusal === "")
const nonTextFinish = (value: unknown) => value === "content_filter" || value === "tool_calls" || value === "function_call"
// A valid non-text completion is terminal for review, but not for accounting.
// Invalid metadata retains its immediate, non-retryable failure policy.
const validMetadata = (delta: Record<string, unknown>) => (delta.role === undefined || delta.role === "assistant")
  && (delta.function_call == null || object(delta.function_call))
  && (delta.tool_calls == null || (Array.isArray(delta.tool_calls) && delta.tool_calls.every(object)))
  && (delta.refusal == null || typeof delta.refusal === "string")
class TerminalAssessmentRejection extends Error {}

async function streamedAssessment(response: Response, signal: AbortSignal, ownership: TransportOwnership, accounting: ReturnType<typeof usageAttempt>,
  progress: (preview?: Partial<Assessment>) => void, firstContent?: () => void): Promise<StreamingAssessment> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
    ownership.track(cancelBody(response))
    throw new Error("Reviewer expected an SSE response")
  }
  const assessment = new StreamingAssessment()
  let stopped = false, done = false
  let finished: string | undefined
  let id: string | undefined, model: string | undefined
  let last: Partial<Assessment> | undefined
  let failure: AssessmentStreamError | TerminalAssessmentRejection | undefined
  function invalid(retryable = true): never {
    const message = "Reviewer API did not return a text assessment stream"
    throw retryable && !(failure instanceof TerminalAssessmentRejection) ? new AssessmentStreamError(message) : new Error(message)
  }
  function rejected(): void {
    if (failure instanceof TerminalAssessmentRejection) return
    failure = new TerminalAssessmentRejection("Reviewer API did not return a text assessment stream")
    progress()
  }
  const sse = new SSEParser(({ data, event }) => {
    try {
      reviewStage(signal, "Reviewer response body")
      if (data.trim() === "[DONE]") {
        if (failure instanceof AssessmentStreamError) return
        if (done || (!stopped && !failure) || event !== "message") invalid()
        done = true
        return
      }
      let body: unknown
      try { body = JSON.parse(data) } catch { throw new Error("Reviewer returned invalid SSE API JSON") }
      // Even an invalid/error/late frame can report real usage. Capture it before validation.
      // Usage-only frames may omit the response model. Keep the established identity
      // for generic catalog estimates rather than reverting to a requested alias.
      accounting.observe(object(body) && body.model === undefined && model !== undefined ? { ...body, model } : body)
      reviewStage(signal, "Reviewer response body")
      if (event === "error" || (object(body) && body.error != null)) invalid(false)
      // Once rejected, consume only usage until EOF under the original bounds.
      // No more provisional text can be published or merged into a later attempt.
      if (failure instanceof AssessmentStreamError) {
        const terminal = object(body) && Array.isArray(body.choices) && body.choices.some(choice => object(choice)
          && (choice.error != null || nonTextFinish(choice.finish_reason)
            || (object(choice.delta) && !textMetadata(choice.delta))
            || (object(choice.message) && !textMetadata(choice.message))))
        if (!terminal) return
        // This was already terminal under the invalid-metadata policy. Validate
        // the frame below before allowing any further accounting drain.
        rejected()
      }
      if (done || event !== "message" || !object(body)) invalid()
      if (body.object !== undefined && body.object !== "chat.completion.chunk") invalid()
      for (const key of ["id", "model"] as const) {
        const value = body[key]
        if (value === undefined) continue
        if (typeof value !== "string" || !value) invalid()
        const previous = key === "id" ? id : model
        if (previous !== undefined && previous !== value) invalid()
        if (key === "id") id = value
        else model = value
      }
      if (!Array.isArray(body.choices) || body.choices.length > 1) invalid()
      if (body.choices.length === 0) {
        if (!object(body.usage)) invalid()
        return
      }
      const choice: unknown = body.choices[0]
      if (!object(choice) || choice.index !== 0 || choice.message != null || choice.text != null) invalid()
      if (choice.error != null) invalid(false)
      const finish = choice.finish_reason
      const delta = choice.delta === undefined && (finish === "stop" || finish === "length" || nonTextFinish(finish)) ? {} : choice.delta
      if (!object(delta)) invalid(!nonTextFinish(finish))
      if (!validMetadata(delta)) invalid(false)
      const nonText = nonTextFinish(finish) || !textMetadata(delta)
      if (delta.content != null && typeof delta.content !== "string") invalid(!nonText)
      if (finish != null && finish !== "stop" && finish !== "length" && !nonTextFinish(finish)) invalid(!nonText)
      // A terminal rejection still has completion framing. Once any finish has
      // been accepted, only an identical empty finish or usage-only frames may
      // follow. Check before the rejection drain can discard further deltas.
      if (finished !== undefined && (finish !== finished || !textMetadata(delta)
        || [delta.content, delta.reasoning, delta.reasoning_content, delta.reasoning_details]
          .some(value => value != null && value !== "" && !(Array.isArray(value) && value.length === 0)))) invalid(!nonText)
      if (typeof finish === "string") finished = finish
      if (nonText) { rejected(); return }
      // Keep validating framing/identity/metadata, but never parse or publish more
      // assessment text after a terminal rejection, including plausible Safe JSON.
      if (failure instanceof TerminalAssessmentRejection) {
        return
      }
      if (finish === "length") throw new AssessmentStreamError("Reviewer output token limit reached; increase maxOutputTokens")
      if ((finish != null && finish !== "stop") || (stopped && finish !== "stop")) invalid()
      if (typeof delta.content === "string" && delta.content) {
        firstContent?.()
        assessment.push(delta.content)
        const preview = assessment.preview()
        if (preview?.safe !== last?.safe || preview?.desc !== last?.desc) {
          last = preview
          progress(preview)
        }
      }
      if (finish === "stop") stopped = true
    } catch (error) {
      if (!(error instanceof AssessmentStreamError)) throw error
      if (!failure) { failure = error; progress() }
    }
  })
  try { await readBody(response, signal, ownership, (bytes) => sse.push(bytes)) }
  catch (error) {
    signal.throwIfAborted()
    // Even a transient socket failure during accounting cannot retry a refusal.
    if (failure instanceof TerminalAssessmentRejection) throw new Error(error instanceof Error ? error.message : failure.message)
    throw error
  }
  sse.finish()
  if (failure) throw failure
  if (!done || !stopped) throw new AssessmentStreamError("Reviewer stream ended without stop and DONE")
  return assessment
}

export interface ReviewerDependencies {
  fetcher?: typeof fetch
  environment?: NodeJS.ProcessEnv
  prompts?: PromptSet
  pricing?: PricingLookup
  onUsage?: (usage: Usage) => void
  onProgress?: (progress: ReviewProgress) => void
  onDiagnostics?: DiagnosticObserver
  onRetry?: () => unknown
  observation?: ReviewObservation
}

export async function review(
  evidence: HostReviewEvidence,
  config: Config,
  signal: AbortSignal,
  { fetcher = fetch, environment = process.env, prompts = BUILTIN_PROMPTS,
    pricing, onUsage, onProgress, onDiagnostics, onRetry, observation = { review: randomUUID() } }: ReviewerDependencies = {},
): Promise<ReviewResult> {
  // Production already shares a deadline with evidence collection. Direct
  // callers get the same bound, including all internal backoff and POSTs.
  if (remainingTime(signal) === Infinity) {
    let worker: Promise<ReviewResult> | undefined
    try {
      return await withDeadline(signal, config.timeoutMs, (bounded) =>
        worker = review(evidence, config, bounded, { fetcher, environment, prompts, pricing, onUsage, onProgress, onDiagnostics, onRetry, observation }))
    } finally { await worker?.catch(() => {}) }
  }
  const key = config.apiKey ?? (config.apiKeyEnv ? environment[config.apiKeyEnv]?.trim() : undefined)
  if (config.apiKeyEnv && !key) throw new Error(`API key environment variable ${config.apiKeyEnv} is unset or empty`)
  const prompt = prompts[evidence.kind]
  const messages = [
    { role: "system", content: [prompt.instructions, ...(config.autoApprove && config.extraCareful ? [prompts.extraCareful] : []), CONTRACT].join("\n\n") },
    { role: "user", content: JSON.stringify(evidence) },
  ]
  let usage: Usage | undefined
  let corrections = 0
  const retries = new TransportRetries()
  let startedAttempt = -1
  let retry: "initial" | "transport" | "format" = "initial"
  const observe = (event: ReviewAttemptEvent) => {
    try { void Promise.resolve(observation.observe?.(event)).catch(() => {}) } catch {}
  }
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const progress = (phase: ReviewProgress["phase"], preview?: Partial<Assessment>, ordinal = attempt) => {
      if (signal.aborted) return
      try { void Promise.resolve(onProgress?.({ attempt: ordinal, phase, ...(preview ? { preview: { ...preview } } : {}) })).catch(() => {}) }
      catch { /* Observational callbacks cannot change review outcomes. */ }
    }
    if (startedAttempt !== attempt) { startedAttempt = attempt; progress(attempt ? "retrying" : "evaluating") }
    const accounting = usageAttempt(config.baseURL, config.model, pricing, onUsage)
    const attemptID = randomUUID()
    let dispatched = false
    const requestAbort = new AbortController()
    const ownership = new TransportOwnership(transportOwnership(signal))
    let contentStarted = false
    let failed = false
    let failure: unknown
    try {
      reviewStage(signal, "Reviewer response")
      let response: Response
      let diagnose: ReturnType<typeof diagnosticAttempt> | undefined
      try {
        const body = JSON.stringify({ model: config.model, messages, max_tokens: config.maxOutputTokens, stream: config.stream,
          ...(config.stream ? { stream_options: { include_usage: true } } : {}) })
        reviewStage(signal, "Reviewer response")
        diagnose = onDiagnostics ? diagnosticAttempt(onDiagnostics, attempt) : undefined
        signal.throwIfAborted()
        let pending: Promise<Response>
        try {
          dispatched = true
          pending = fetcher(`${config.baseURL}/chat/completions`, {
            method: "POST", redirect: "error", signal: AbortSignal.any([signal, requestAbort.signal]),
            headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body,
          })
        } finally {
          observe({ type: "dispatched", review: observation.review, attempt: attemptID, retry })
          // Count dispatched extra attempts, not proposed or canceled backoff.
          if (attempt > 0) { try { void Promise.resolve(onRetry?.()).catch(() => {}) } catch {} }
        }
        response = await abortable(pending, signal, ownership, cancelBody)
        diagnose?.("headers")
      } catch (error) {
        signal.throwIfAborted()
        throw networkFailure(error, "Reviewer network request failed")
      }
      if (!response.ok) {
        ownership.track(cancelBody(response))
        throw httpFailure(response)
      }
      let assessment: StreamingAssessment
      if (config.stream) assessment = await streamedAssessment(response, signal, ownership, accounting, (preview) => {
        if (typeof preview?.safe === "boolean") diagnose?.("first-rating")
        progress("streaming", preview)
      }, () => { contentStarted = true; diagnose?.("first-content") })
      else {
        let envelope: unknown
        try { envelope = JSON.parse(await responseText(response, signal, ownership)) }
        catch (error) {
          signal.throwIfAborted()
          if (error instanceof SyntaxError) throw new Error("Reviewer returned invalid API JSON")
          throw error
        }
        accounting.observe(envelope)
        reviewStage(signal, "Assessment validation")
        const choices = object(envelope) ? envelope.choices : undefined
        if (!Array.isArray(choices) || choices.length !== 1) throw new Error("Reviewer API must return one completion")
        const choice = choices[0], message = choice?.message
        // Minimal non-stream providers may omit metadata; explicit values must describe text completion.
        if (!object(choice) || !object(message) || typeof message.content !== "string" || !textMetadata(message)
          || (object(envelope) && envelope.error != null)
          || choice.error != null
          || (choice.index !== undefined && choice.index !== 0)
          || (choice.finish_reason !== undefined && choice.finish_reason !== "stop")) {
          throw new Error("Reviewer API did not return a text assessment")
        }
        if (message.content) { contentStarted = true; diagnose?.("first-content") }
        assessment = new StreamingAssessment()
        assessment.push(message.content)
        if (diagnose && typeof assessment.preview()?.safe === "boolean") diagnose("first-rating")
      }
      reviewStage(signal, "Assessment validation")
      const currentUsage = accounting.current()
      const reportUsage = attempt === 0 ? currentUsage : sumUsage(usage, currentUsage)
      try {
        let result: Assessment
        try { result = assessment.finish() } finally { diagnose?.("final-validation") }
        if (config.stream) progress("streaming", result)
        signal.throwIfAborted()
        return { ...result, ...(reportUsage ? { usage: reportUsage } : {}), metadata: {
          review: observation.review, kind: evidence.kind, configuredModel: config.model, provider: config.baseURL,
          ...(accounting.model() ? { reportedModel: accounting.model() } : {}),
        } }
      }
      catch (error) {
        if (!(error instanceof AssessmentFormatError)) throw error
        if (corrections++ === config.formatRetries) throw new Error("Reviewer response format invalid after configured attempts")
        messages.push(
          { role: "assistant", content: assessment.content },
          { role: "user", content: correctionPrompt(error.message) },
        )
      }
    } catch (error) {
      requestAbort.abort()
      if (contentStarted && !(error instanceof AssessmentStreamError)) throw error
      failed = true
      failure = error
    } finally {
      // Disposal must await aborted review workers before flushing their queued accounting writes.
      const currentUsage = accounting.finalize()
      if (dispatched) observe({ type: "finalized", review: observation.review, attempt: attemptID,
        ...(currentUsage ? { usage: { ...currentUsage } } : {}), ...(accounting.model() ? { reportedModel: accounting.model() } : {}) })
      usage = attempt === 0 ? currentUsage : sumUsage(usage, currentUsage)
    }
    if (failed && !await retries.wait(failure, signal, () => {
      startedAttempt = attempt + 1
      progress("retrying", undefined, startedAttempt)
    })) throw failure
    // No transport retry or format correction may amplify an unsettled read or
    // cancellation. This wait remains bounded by the original visible deadline.
    await abortable(ownership.settled(), signal)
    retry = failed ? "transport" : "format"
  }
}
