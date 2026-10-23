import { reviewStage } from "./deadline.js"
import type { CodeModeCandidates, HostLocation, JSONObject } from "./host-types.js"
import { readRegisteredTool, type RegisteredTool, type ToolCatalogRead } from "./host-tool.js"
import { boundedCopy } from "./tool-evidence.js"
import { transportOwnership } from "./transport-ownership.js"
import { sameHostJSON } from "./host-request.js"

export interface CodeModeEvidence {
  linkage: "unverified"
  observedCalls: number
  omittedCalls: number
  candidates: { tool: string; input: JSONObject; definition?: RegisteredTool }[]
}

/** A bounded observation set, never a guessed mapping or parsed JavaScript plan. */
export async function collectCodeModeCandidates(captured: CodeModeCandidates, location: HostLocation,
  bytes: number, values: number, signal: AbortSignal, tools?: ToolCatalogRead): Promise<{ codeMode: CodeModeEvidence; limitations: string[] }> {
  const codeMode: CodeModeEvidence = { linkage: "unverified", observedCalls: captured.calls.length + captured.omitted,
    omittedCalls: captured.calls.length + captured.omitted, candidates: [] }
  const initial = boundedCopy({ codeMode }, bytes, values)
  let remainingBytes = bytes - initial.bytes, remainingValues = values - initial.values
  const limitations = [
    "The permission is linked exactly to the outer Code Mode invocation, but its individual inner tool call is unverified. No candidate has been selected as the operation being approved.",
    "Candidates are captured tool calls sharing the outer identity before evidence collection. They may include completed or unrelated sibling calls; later calls are not included. Their order does not establish permission ownership.",
  ]
  for (const candidate of captured.calls) {
    reviewStage(signal, "Evidence collection")
    try {
      const separator = codeMode.candidates.length ? 1 : 0
      const copy = boundedCopy({ tool: candidate.tool, input: candidate.input }, remainingBytes - separator, remainingValues)
      codeMode.candidates.push(copy.value)
      codeMode.omittedCalls--
      remainingBytes -= copy.bytes + separator
      remainingValues -= copy.values
    } catch { /* Omit the entire candidate; never truncate its arguments. */ }
  }
  if (codeMode.omittedCalls) limitations.push(`${codeMode.omittedCalls} captured candidate call(s) omitted whole because their complete arguments were unavailable or exceeded capture/evidence limits.`)
  let registry: unknown
  if (!tools) limitations.push("Candidate tool definitions unavailable: scoped registry reader unavailable.")
  else if (codeMode.candidates.length) try {
    const pending = tools(signal)
    registry = await (transportOwnership(signal)?.track(pending) ?? pending)
    reviewStage(signal, "Evidence collection")
  } catch {
    reviewStage(signal, "Evidence collection")
    limitations.push("Candidate tool definitions unavailable: scoped registry read failed.")
  }
  for (const [index, candidate] of codeMode.candidates.entries()) {
    reviewStage(signal, "Evidence collection")
    if (registry === undefined) continue
    const result = readRegisteredTool(registry, location, candidate.tool, remainingBytes, remainingValues)
    limitations.push(...result.limitations.map(reason => `Candidate ${index + 1}: ${reason}`))
    if (result.definition) {
      const used = boundedCopy({ definition: result.definition }, remainingBytes, remainingValues)
      candidate.definition = result.definition
      // Conservatively charge the envelope and original counter widths, avoiding
      // repeated traversal of earlier candidates and their full arguments.
      remainingBytes -= used.bytes
      remainingValues -= used.values
    }
  }
  return { codeMode, limitations }
}

/** Validate optional candidate observations independently of the exact outer input. */
export function validCodeModeEvidence(value: unknown, location: HostLocation): value is CodeModeEvidence {
  const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  if (!shape(value, ["linkage", "observedCalls", "omittedCalls", "candidates"]) || value.linkage !== "unverified"
    || typeof value.observedCalls !== "number" || !Number.isSafeInteger(value.observedCalls)
    || typeof value.omittedCalls !== "number" || !Number.isSafeInteger(value.omittedCalls) || value.omittedCalls < 0
    || !Array.isArray(value.candidates) || value.candidates.length > 64
    || value.observedCalls !== value.candidates.length + value.omittedCalls) return false
  return value.candidates.every((candidate: unknown) => {
    if (!shape(candidate, ["tool", "input"], ["definition"]) || typeof candidate.tool !== "string" || !candidate.tool
      || !candidate.input || typeof candidate.input !== "object" || Array.isArray(candidate.input)) return false
    if (candidate.definition === undefined) return true
    if (!shape(candidate.definition, ["id"], ["name", "description", "input"]) || candidate.definition.id !== candidate.tool) return false
    return sameHostJSON(readRegisteredTool({ location, data: [candidate.definition] }, location, candidate.tool).definition, candidate.definition)
  })
}
