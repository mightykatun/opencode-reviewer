import { types } from "node:util"
import { sameLocation } from "./companion-protocol.js"
import { sameHostJSON } from "./host-request.js"
import type { HostInvocation, HostRequestSnapshot } from "./host-types.js"
import { codeModeToolAction } from "./host-tool-kind.js"

function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
}

/** Join a direct durable tool item or the outer Code Mode invocation to its capture.
 * messageSessionID is the actual session used by the scoped public message.get.
 * No nested JavaScript parsing, name-prefix inference or event ordering is used.
 */
export function bindHostInvocation(snapshot: HostRequestSnapshot, messageSessionID: string,
  message: unknown, captured: HostInvocation | undefined): HostInvocation | undefined {
  const { request, scope } = snapshot, source = request.source
  if (!source || !captured || request.sessionID !== messageSessionID
    || captured.sessionID !== request.sessionID || captured.assistantID !== source.assistantID || captured.callID !== source.id
    || captured.epoch !== scope.epoch || !sameLocation(captured.location, scope.location)
    || field(message, "id") !== source.assistantID || field(message, "type") !== "assistant") return
  const content = field(message, "content")
  if (!Array.isArray(content) || types.isProxy(content) || content.length > 16384) return
  let found: unknown
  for (let index = 0; index < content.length; index++) {
    const entry = field(content, String(index))
    if (field(entry, "type") !== "tool" || field(entry, "id") !== source.id) continue
    if (found) return
    found = entry
  }
  const state = field(found, "state")
  if (!found || field(found, "name") !== captured.tool
    || (captured.tool === "execute" && (!codeModeToolAction(request.action) || typeof captured.input.code !== "string"))
    || field(state, "status") !== "running" || !sameHostJSON(field(state, "input"), captured.input)) return
  return captured
}
