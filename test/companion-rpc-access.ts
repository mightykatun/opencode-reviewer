import { waitForCompanionCapacity, type CompanionAccess } from "../src/companion-access.js"
import { CompanionBusyError } from "../src/companion-reads.js"
import { sameLocation } from "../src/companion-protocol.js"
import { withDeadline } from "../src/deadline.js"
import type { HostScope } from "../src/host-types.js"
import { transportOwnership } from "../src/transport-ownership.js"

export type RPCTestClient = { rpc: () => Record<string, Function> }

/** Adapt existing offline RPC-shaped fixtures to the in-process access boundary. */
export function rpcTestAccess(client: RPCTestClient, scope: HostScope): CompanionAccess {
  const invoke = async (method: string, query: unknown, signal: AbortSignal): Promise<any> => {
    signal.throwIfAborted()
    const work = Promise.resolve().then(() => client.rpc()[method]!(query, { signal }))
    try {
      return await (transportOwnership(signal)?.track(work) ?? work)
    } catch (error) {
      if (error && typeof error === "object" && "type" in error) {
        if (error.type === "capacity_busy") throw new CompanionBusyError()
        if (error.type === "scope") return undefined
      }
      throw error
    }
  }
  const read = (method: string, query: unknown, parent: AbortSignal, timeoutMs = 5000) =>
    withDeadline(parent, Math.min(timeoutMs, 5000), signal =>
      waitForCompanionCapacity(signal, () => invoke(method, query, signal)), "Companion evidence lookup")
  return {
    scope,
    epoch: async signal => {
      try {
        const value = await invoke("handshake", scope.location, signal)
        return sameLocation(value?.location, scope.location) ? value.epoch : undefined
      } catch {
        signal.throwIfAborted()
        return undefined
      }
    },
    invocation: (sessionID, requestID, signal) =>
      read("invocation", { ...scope, sessionID, requestID }, signal),
    evidence: (sessionID, requestID, options, timeoutMs, signal) =>
      read("evidence", { ...scope, sessionID, requestID, options, timeoutMs }, signal, timeoutMs),
    retrieve: (sessionID, requestID, base, call, timeoutMs, maxBytes, signal) =>
      invoke("retrieve", { ...scope, sessionID, requestID, base, call, timeoutMs, maxBytes }, signal),
  }
}
