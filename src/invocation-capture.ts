import { boundedCopy } from "./tool-evidence.js"
import type { CompanionHandshake } from "./companion-protocol.js"
import { boundedHostJSON } from "./host-request.js"

export interface CapturedCall {
  sessionID: string
  assistantID: string
  callID: string
  tool: string
  input: Record<string, unknown>
  scope: Pick<CompanionHandshake, "epoch" | "location">
  project: CompanionHandshake["project"]
}

type HookCall = { sessionID: string; messageID: string; id: string; tool: string; input: unknown }
const maxBytes = 16 * 1024 * 1024
const maxCalls = 512
const identity = (session: string, assistant: string, call: string) => JSON.stringify([session, assistant, call])
const validID = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
const wireExact = (value: unknown): boolean => typeof value === "number" ? !Object.is(value, -0)
  : value !== null && typeof value === "object" ? Object.values(value).every(wireExact) : true

/** Live observation, never reconstruction from permission arrival or outer code.
 * Duplicate keys remain ambiguous. Capacity failure invalidates this epoch instead
 * of evicting a pending call. Native execution never depends on these observations.
 */
export class InvocationCapture {
  private readonly calls = new Map<string, { value?: CapturedCall; bytes: number; pending: number }>()
  private bytes = 0
  private available = true
  private readonly handshake: CompanionHandshake

  constructor(handshake: CompanionHandshake) {
    this.handshake = structuredClone(handshake)
  }

  before(event: HookCall): void {
    if (!this.available) return
    let key: string | undefined
    try {
      if (![event.sessionID, event.messageID, event.id, event.tool].every(validID)) return
      key = identity(event.sessionID, event.messageID, event.id)
      const existing = this.calls.get(key)
      if (existing) { existing.pending++; return this.ambiguous(key) }
      if (this.calls.size >= maxCalls) return this.clear()
      if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return this.ambiguous(key)
      const input = boundedHostJSON(event.input)
      if (!input || !wireExact(input)) return this.ambiguous(key)
      const { epoch, location, project } = this.handshake
      const copied = boundedCopy({ sessionID: event.sessionID, assistantID: event.messageID,
        callID: event.id, tool: event.tool, input: input as Record<string, unknown>, scope: { epoch, location }, project }, maxBytes - this.bytes)
      this.calls.set(key, { value: copied.value, bytes: copied.bytes, pending: 1 })
      this.bytes += copied.bytes
    } catch { if (key !== undefined) this.ambiguous(key) }
  }

  after(event: Pick<HookCall, "sessionID" | "messageID" | "id">): void {
    const key = identity(event.sessionID, event.messageID, event.id)
    const found = this.calls.get(key)
    // Code Mode's outer call and nested calls share an identity. Keep it
    // ambiguous until *all* observed executions settle, including failures.
    // Lifetime tombstones would fill the live-call bound in long sessions.
    if (!found || --found.pending > 0) return
    this.calls.delete(key)
    this.bytes -= found.bytes
  }

  read(sessionID: string, assistantID: string, callID: string): CapturedCall | undefined {
    const found = this.calls.get(identity(sessionID, assistantID, callID))
    return found?.value && structuredClone(found.value)
  }

  private ambiguous(key: string): void {
    const found = this.calls.get(key)
    this.bytes -= found?.bytes ?? 0
    this.calls.set(key, { bytes: 0, pending: found?.pending ?? 1 })
  }

  clear(): void {
    this.available = false
    this.calls.clear()
    this.bytes = 0
  }
}
