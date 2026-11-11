import { randomUUID } from "node:crypto"
import type { Config } from "./config.js"
import { DeadlineError, remainingTime, reviewStage, withDeadline } from "./deadline.js"
import type { HostReviewEvidence } from "./host-evidence.js"
import type { JSONObject, JSONValue } from "./host-types.js"
import { RETRIEVAL_CONTRACT, type PromptSet } from "./prompts.js"
import { abortable, cancelBody, responseText } from "./chat-transport.js"
import { AssessmentStreamError, httpFailure, networkFailure, transientFailure, TransportRetries } from "./transport-retry.js"
import { TransportOwnership, transportOwnership } from "./transport-ownership.js"
import { leadingLines, lineCount } from "./truncate.js"
import { sumUsage, usageAttempt, type PricingLookup, type Usage } from "./usage.js"
import type { ReviewAttemptEvent } from "./types.js"
import type { RetrievalToolName } from "./retrieval-tools.js"
import { askContext, askContextTool, clarificationEnabled, clarificationQuestions, invalidQuestions, type ContextAsker } from "./clarification.js"

/** One read-only operation executed by the scoped server companion. */
export interface RetrievalExecutor {
  execute(call: { tool: RetrievalToolName; arguments: JSONObject }, base: string, timeoutMs: number, signal: AbortSignal): Promise<JSONObject>
}

export type RetrievalEndReason = "finish" | "no-finish" | "retrieval-timeout" | "tools-rejected" | "provider-error"
  | "transport-error" | "malformed-response"
export type RetrievalSection = { status: "disabled" | "unavailable" } | {
  status: "completed"
  selection: "agent" | "all-in-order"
  endReason: RetrievalEndReason
  base: string
  notes?: string
  trace: JSONObject[]
  items: JSONObject[]
}
export interface RetrievalOutcome { section: RetrievalSection; limitations: string[]; posts: number; toolCalls: number; usage?: Usage }

export const maxCallsPerRound = 10
const OPENROUTER = "https://openrouter.ai/api/v1"
const toolNames = ["read", "list", "glob", "grep"] as const

const path = { type: "string", description: "Absolute, ~/..., or relative to the stated base directory." }
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } })
/** Fixed, byte-stable definitions in a fixed order so provider prompt caches stay valid. */
export const retrievalTools = [
  definition("read", "Read UTF-8 text lines from one file. Returns exact line numbers; when cut, truncated is true and nextOffset continues.",
    { path, offset: { type: "integer", minimum: 1, description: "First line, 1-based." }, limit: { type: "integer", minimum: 1, description: "Maximum lines." } }, ["path"]),
  definition("list", "List one directory (not recursive): names, types and file sizes.", { path }, ["path"]),
  definition("glob", "Find paths matching a glob relative to path (default: base). Supports **, *, ?, [set] and {a,b}. Symlinked directories are listed, not descended.",
    { pattern: { type: "string" }, path }, ["pattern"]),
  definition("grep", "Search UTF-8 files under path (default: base) with a JavaScript regular expression. include filters files by glob; without a slash it matches file names.",
    { pattern: { type: "string" }, path, include: { type: "string" }, ignoreCase: { type: "boolean" } }, ["pattern"]),
  definition("finish", "End retrieval. items lists result IDs to forward to the reviewer, most important first. notes is optional context for the reviewer.",
    { items: { type: "array", items: { type: "string" } }, notes: { type: "string" } }, ["items"]),
]
/** Root-conversation reviews add the single clarification call before finish. */
export const clarifyingRetrievalTools = [
  ...retrievalTools.slice(0, -1),
  definition(askContextTool, "Ask the conversation's own model about this pending operation. It answers from the session context, not from files. Allowed once per review, so put every question in this one call. The answer is an unverified explanation.",
    { questions: { type: "string", description: "Every question, in one text." } }, ["questions"]),
  retrievalTools.at(-1)!,
]

/** Retrieval ends early for a factual reason; gathered results are still forwarded. */
class RetrievalStop extends Error {
  constructor(readonly reason: RetrievalEndReason, message: string) { super(message) }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

interface ToolCall { id: string; name: string; arguments: string }
function parseTurn(envelope: unknown): { message: Record<string, unknown>; calls: ToolCall[] } {
  const choices = object(envelope) ? envelope.choices : undefined
  if (!object(envelope) || envelope.error != null || !Array.isArray(choices) || choices.length !== 1)
    throw new RetrievalStop("provider-error", "Retrieval API did not return one completion")
  const choice = choices[0], message = object(choice) ? choice.message : undefined
  if (!object(choice) || !object(message) || choice.error != null || (message.refusal != null && message.refusal !== "")
    || choice.finish_reason === "content_filter")
    throw new RetrievalStop("provider-error", "Retrieval API returned an error, refusal or filtered completion")
  if (choice.finish_reason === "length") throw new AssessmentStreamError("Retrieval output token limit reached")
  const raw = message.tool_calls
  if (raw != null && !Array.isArray(raw)) throw new RetrievalStop("malformed-response", "Retrieval tool calls are malformed")
  const calls = (raw ?? []).map((call: unknown) => {
    const fn = object(call) ? call.function : undefined
    if (!object(call) || typeof call.id !== "string" || !call.id || (call.type !== undefined && call.type !== "function")
      || !object(fn) || typeof fn.name !== "string" || typeof fn.arguments !== "string")
      throw new RetrievalStop("malformed-response", "Retrieval tool calls are malformed")
    return { id: call.id, name: fn.name, arguments: fn.arguments }
  })
  return { message, calls }
}

interface Dependencies {
  fetcher: typeof fetch
  key?: string
  pricing?: PricingLookup
  onUsage?: (usage: Usage) => void
  onRetry?: () => unknown
  observe: (event: ReviewAttemptEvent) => void
  review: string
  progress: (phase: "retrieving" | "retrieval-retrying" | "asking") => void
  executor: RetrievalExecutor
  /** Offered only when clarificationEnabled holds for this review. */
  asker?: ContextAsker
}

/** The retrieval stage: a tool-calling loop that chooses documents, then a
 * forced finish turn for selection. Never produces a verdict. */
export async function retrieveDocuments(evidence: HostReviewEvidence, config: Config, prompts: PromptSet,
  signal: AbortSignal, deps: Dependencies): Promise<RetrievalOutcome> {
  const base = evidence.kind === "shell" ? evidence.cwd : evidence.location.directory
  const cached = (text: string) => new URL(config.baseURL).href.replace(/\/+$/, "") === OPENROUTER
    ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : text
  const messages: Record<string, unknown>[] = [
    { role: "system", content: cached([prompts[evidence.kind].instructions, prompts.retrieval, RETRIEVAL_CONTRACT].join("\n\n")) },
    { role: "user", content: cached(JSON.stringify({ ...evidence, relativePathBase: base })) },
  ]
  const retries = new TransportRetries(), ownership = new TransportOwnership(transportOwnership(signal))
  const results = new Map<string, JSONObject>(), trace: JSONObject[] = []
  const asker = deps.asker && clarificationEnabled(config, evidence) ? deps.asker : undefined
  const tools = asker ? clarifyingRetrievalTools : retrievalTools
  let posts = 0, usage: Usage | undefined, rounds = 0, nextID = 1, toolCalls = 0, asked = false
  let selection: { items: string[]; notes?: string } | undefined, endReason: RetrievalEndReason = "no-finish", stopDetail = ""

  const post = async (toolChoice: unknown, stage: AbortSignal) => {
    const body = JSON.stringify({ model: config.model, messages, tools, ...(toolChoice ? { tool_choice: toolChoice } : {}),
      max_tokens: config.maxOutputTokens, stream: false })
    for (let attempt = 0; ; attempt++) {
      reviewStage(stage, "Retrieval response")
      if (attempt) deps.progress("retrieving")
      const accounting = usageAttempt(config.baseURL, config.model, deps.pricing, deps.onUsage), attemptID = randomUUID()
      const requestAbort = new AbortController()
      let failure: unknown, dispatched = false
      try {
        let response: Response
        try {
          dispatched = true
          let pending: Promise<Response>
          try {
            pending = deps.fetcher(`${config.baseURL}/chat/completions`, { method: "POST", redirect: "error",
              signal: AbortSignal.any([stage, requestAbort.signal]),
              headers: { "Content-Type": "application/json", ...(deps.key ? { Authorization: `Bearer ${deps.key}` } : {}) }, body })
          } finally {
            deps.observe({ type: "dispatched", review: deps.review, attempt: attemptID, retry: attempt ? "transport" : "initial" })
            if (attempt) { try { void Promise.resolve(deps.onRetry?.()).catch(() => {}) } catch {} }
          }
          response = await abortable(pending, stage, ownership, cancelBody)
        } catch (error) {
          stage.throwIfAborted()
          throw networkFailure(error, "Retrieval network request failed")
        }
        if (!response.ok) {
          ownership.track(cancelBody(response))
          const failed = httpFailure(response)
          if (!transientFailure(failed)) throw new RetrievalStop("tools-rejected", `Retrieval endpoint rejected the request (HTTP ${response.status})`)
          throw failed
        }
        let envelope: unknown
        try { envelope = JSON.parse(await responseText(response, stage, ownership)) }
        catch (error) {
          stage.throwIfAborted()
          if (error instanceof SyntaxError) throw new RetrievalStop("provider-error", "Retrieval API returned invalid JSON")
          throw error
        }
        accounting.observe(envelope)
        return parseTurn(envelope)
      } catch (error) {
        requestAbort.abort()
        failure = error
      } finally {
        const current = accounting.finalize()
        if (dispatched) {
          deps.observe({ type: "finalized", review: deps.review, attempt: attemptID,
            ...(current ? { usage: { ...current } } : {}), ...(accounting.model() ? { reportedModel: accounting.model() } : {}) })
          usage = posts++ ? sumUsage(usage, current) : current
        }
      }
      stage.throwIfAborted()
      if (failure instanceof RetrievalStop || !await retries.wait(failure, stage, () => deps.progress("retrieval-retrying"))) {
        if (failure instanceof RetrievalStop) throw failure
        throw new RetrievalStop("transport-error", failure instanceof Error ? failure.message : "Retrieval request failed")
      }
      await abortable(ownership.settled(), stage)
    }
  }

  const answer = (call: ToolCall, result: JSONObject) => {
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) })
  }
  const finishArgs = (call: ToolCall) => {
    try {
      const value = JSON.parse(call.arguments) as unknown
      if (object(value) && Array.isArray(value.items) && value.items.every(item => typeof item === "string")
        && (value.notes === undefined || typeof value.notes === "string") && Object.keys(value).every(key => key === "items" || key === "notes"))
        return { items: value.items as string[], ...(typeof value.notes === "string" && value.notes ? { notes: value.notes } : {}) }
    } catch {}
  }
  const record = (round: number, call: ToolCall, args: JSONValue, entry: Partial<JSONObject>) => {
    trace.push({ id: `c${nextID++}`, round, tool: call.name, arguments: args, ...entry } as JSONObject)
    return trace.at(-1)!.id as string
  }

  try {
    await withDeadline(signal, config.retrievalTimeoutMs, async stage => {
      const finishTurn = async () => {
        deps.progress("retrieving")
        try {
          const { calls } = await post({ type: "function", function: { name: "finish" } }, stage)
          const finish = calls.find(call => call.name === "finish")
          selection = finish && finishArgs(finish)
          if (selection) endReason = "finish"
          else stopDetail = "The forced finish turn returned no valid finish call."
        } catch (error) {
          if (!(error instanceof RetrievalStop)) throw error
          stopDetail = `The forced finish turn failed (${error.message}).`
        }
      }
      for (;;) {
        if (rounds >= config.maxRetrievalRounds) return finishTurn()
        deps.progress("retrieving")
        const { message, calls } = await post(undefined, stage)
        rounds++
        if (!calls.length) return finishTurn()
        messages.push({ role: "assistant", content: typeof message.content === "string" ? message.content : null,
          tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) })
        const finish = calls.find(call => call.name === "finish")
        const finished = finish && finishArgs(finish)
        if (finished) {
          for (const call of calls) if (call !== finish) record(rounds, call, call.arguments, { status: "not-executed", reason: "not executed: finish called" })
          selection = finished; endReason = "finish"
          return
        }
        for (const [index, call] of calls.entries()) {
          let args: JSONValue = call.arguments
          try { args = JSON.parse(call.arguments) as JSONValue } catch {}
          if (index >= maxCallsPerRound) {
            const id = record(rounds, call, args, { status: "not-executed", reason: "not executed: per-round call limit" })
            answer(call, { id, status: "error", reason: "not executed: per-round call limit" })
            continue
          }
          if (call === finish) {
            const id = record(rounds, call, args, { status: "error", reason: "invalid arguments: finish requires items (string array) and optional notes (string)" })
            answer(call, { id, status: "error", reason: "invalid arguments: finish requires items (string array) and optional notes (string)" })
            continue
          }
          if (asker && call.name === askContextTool) {
            const questions = clarificationQuestions(args)
            if (!questions || asked) {
              const [status, reason] = questions ? ["not-executed", `not executed: ${askContextTool} is allowed once per review`] : ["error", invalidQuestions]
              const id = record(rounds, call, args, { status, reason })
              answer(call, { id, tool: call.name, status: "error", reason })
              continue
            }
            asked = true
            stage.throwIfAborted()
            deps.observe({ type: "toolDispatched", review: deps.review, call: String(++toolCalls) })
            deps.progress("asking")
            const result = await ownership.track(askContext(asker, prompts.clarification, evidence, questions, config.maxEvidenceBytes, stage))
            stage.throwIfAborted()
            deps.progress("retrieving")
            const id = record(rounds, call, args, summary(result))
            if (result.status === "ok") results.set(id, result)
            answer(call, { id, ...result })
            continue
          }
          if (!toolNames.includes(call.name as RetrievalToolName) || typeof args !== "object" || args === null || Array.isArray(args)) {
            const reason = toolNames.includes(call.name as RetrievalToolName) ? "invalid arguments: arguments must be a JSON object" : "unknown tool"
            const id = record(rounds, call, args, { status: "error", reason })
            answer(call, { id, tool: call.name, status: "error", reason })
            continue
          }
          const timeout = Math.min(3600000, remainingTime(stage))
          if (timeout <= 0) throw new DeadlineError("Retrieval")
          stage.throwIfAborted()
          deps.observe({ type: "toolDispatched", review: deps.review, call: String(++toolCalls) })
          const result = await ownership.track(deps.executor.execute({ tool: call.name as RetrievalToolName, arguments: args as JSONObject }, base, timeout, stage))
          stage.throwIfAborted()
          const id = record(rounds, call, args, summary(result))
          if (result.status === "ok") results.set(id, result)
          answer(call, { id, ...result })
        }
      }
    }, "Retrieval")
  } catch (error) {
    // The review's own deadline or cancellation ends the whole review.
    if (signal.aborted || remainingTime(signal) <= 0) throw error
    if (error instanceof RetrievalStop) { endReason = error.reason; stopDetail = `${error.message}.` }
    else if (error instanceof DeadlineError) { endReason = "retrieval-timeout"; stopDetail = "The retrieval time budget (retrievalTimeoutMs) expired." }
    else throw error
  }
  // Never let an unsettled retrieval transaction overlap the verdict request.
  await abortable(ownership.settled(), signal)
  const forwarded = forward(trace, results, selection, config)
  const limitations = [...forwarded.limitations]
  if (!selection) limitations.unshift(`Retrieval ended without a valid finish selection (${endReason}). ${stopDetail} All successful results were forwarded in call order within the forwarding budget.`.replace("  ", " "))
  return { posts, toolCalls, usage, limitations, section: { status: "completed", selection: selection ? "agent" : "all-in-order", endReason, base,
    ...(forwarded.notes ? { notes: forwarded.notes } : {}), trace, items: forwarded.items } }
}

/** Trace metadata for one executed call, without content or echoed questions,
 * which the trace already holds as the call's arguments. */
function summary(result: JSONObject): Partial<JSONObject> {
  const { tool: _, content, entries, matches, questions: __, ...rest } = result
  const size: Record<string, number> = {}
  if (typeof content === "string") { size.bytes = Buffer.byteLength(content); size.lines = lineCount(content) }
  if (Array.isArray(entries)) size.entries = entries.length
  if (Array.isArray(matches)) size.matches = matches.length
  return { ...rest, ...(Object.keys(size).length ? { size } : {}) }
}

/** Forward selected (or all) successful results within maxFiles read items and
 * maxEvidenceBytes of content, truncating to exact leading lines or entries. */
function forward(trace: JSONObject[], results: Map<string, JSONObject>, selection: { items: string[]; notes?: string } | undefined,
  config: Pick<Config, "maxFiles" | "maxEvidenceBytes">) {
  const limitations: string[] = [], items: JSONObject[] = []
  let budget = config.maxEvidenceBytes, files = 0, notes = selection?.notes
  const mark = (id: string, forwarded: string, reason?: string) => {
    const entry = trace.find(item => item.id === id) as Record<string, JSONValue> | undefined
    if (entry) { entry.forwarded = forwarded; if (reason) entry.omittedReason = reason }
  }
  for (const entry of trace) if (entry.status === "ok") (entry as Record<string, JSONValue>).forwarded = "not-selected"
  if (notes !== undefined) {
    const size = Buffer.byteLength(notes)
    if (size > budget) { notes = undefined; limitations.push("Retriever notes were omitted because they exceed the forwarding byte budget.") }
    else budget -= size
  }
  const order = selection ? [...new Set(selection.items)] : [...results.keys()]
  const unknown = order.filter(id => !results.has(id))
  if (unknown.length) limitations.push(`The finish selection referenced unknown or failed result IDs: ${unknown.slice(0, 20).map(id => JSON.stringify(id)).join(", ")}.`)
  let omitted = false
  for (const id of order) {
    const result = results.get(id)
    if (!result) continue
    const { status: _, tool, content, entries, matches, ...rest } = result
    if (tool === "read" && files >= config.maxFiles) { mark(id, "omitted", "file-count limit"); omitted = true; continue }
    const item: Record<string, JSONValue> = { id, tool: tool ?? null, ...rest }
    if (typeof content === "string") {
      const size = Buffer.byteLength(content)
      if (size <= budget) { item.content = content; budget -= size; mark(id, "full") }
      else {
        const prefix = leadingLines(content, budget)
        if (!prefix.lines) { mark(id, "omitted", "forwarded byte budget exhausted"); omitted = true; continue }
        item.content = prefix.text
        if (typeof rest.startLine === "number") item.endLine = rest.startLine + prefix.lines - 1
        // A clarification answer may already have been cut to the result size limit.
        const earlier = object(rest.truncated) && typeof rest.truncated.omittedLines === "number" ? rest.truncated.omittedLines : 0
        item.truncated = { omittedLines: lineCount(content) - prefix.lines + earlier }
        delete item.totalLines; delete item.nextOffset
        budget -= prefix.bytes; omitted = true
        mark(id, "truncated")
      }
      if (tool === "read") files++
    } else {
      const key = Array.isArray(entries) ? "entries" : "matches", list = (Array.isArray(entries) ? entries : matches) as JSONValue[] ?? []
      const kept: JSONValue[] = []
      for (const value of list) {
        const size = Buffer.byteLength(JSON.stringify(value)) + 1
        if (size > budget) break
        kept.push(value); budget -= size
      }
      if (list.length && !kept.length) { mark(id, "omitted", "forwarded byte budget exhausted"); omitted = true; continue }
      item[key] = kept
      if (kept.length < list.length) { item.truncated = { omittedEntries: list.length - kept.length }; omitted = true; mark(id, "truncated") }
      else mark(id, "full")
    }
    items.push(item as JSONObject)
  }
  if (omitted) limitations.push("Some retrieved results were omitted or truncated to fit maxFiles read items and the maxEvidenceBytes forwarding budget; truncated items keep exact leading lines or entries.")
  return { items, notes, limitations }
}
