import path from "node:path"
import { types } from "node:util"
import { boundedCopy } from "./tool-evidence.js"
import type { HostInvocation, HostLocation, HostRequest, HostRequestSnapshot, HostScope, JSONObject, JSONValue } from "./host-types.js"

/** Preprocessing ceiling only; collectors still enforce maxEvidenceBytes. */
export const hostJSONBytes = 16 * 1024 * 1024
const hostJSONValues = 16384
const identities = new WeakMap<HostRequestSnapshot, string>()

/** Reject properties JSON copying would silently discard, without running getters. */
function inspectJSON(value: unknown, depth = 0, count = { values: 0 }): void {
  if (++count.values > hostJSONValues || depth > 32) throw new Error("Host JSON structure limit exceeded")
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return
  if (!value || typeof value !== "object" || types.isProxy(value)) throw new Error("Unsupported host JSON value")
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
    throw new Error("Unsupported host JSON prototype")
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length > hostJSONValues + (array ? 1 : 0)) throw new Error("Host JSON structure limit exceeded")
  const length = array ? Object.getOwnPropertyDescriptor(value, "length")!.value as number : 0
  if (array && (length > hostJSONValues || keys.length !== length + 1)) throw new Error("Unsupported host JSON array")
  for (const key of keys) {
    if (array && key === "length") continue
    if (typeof key !== "string" || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) {
      throw new Error("Unsupported host JSON property")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Unsupported host JSON descriptor")
    inspectJSON(descriptor.value, depth + 1, count)
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

/** An immutable bounded copy, or undefined for any unsupported/lossy input. */
export function boundedHostJSON(value: unknown): JSONValue | undefined {
  try {
    inspectJSON(value)
    return freeze(boundedCopy(value, hostJSONBytes, hostJSONValues).value as JSONValue)
  } catch { return undefined }
}

function object(value: JSONValue | undefined): value is JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function shape(value: JSONValue | undefined, required: readonly string[], optional: readonly string[] = []): value is JSONObject {
  return object(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

function text(value: JSONValue | undefined): value is string {
  return typeof value === "string" && value.length > 0
}

function strings(value: JSONValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

function location(value: JSONValue | undefined): value is JSONObject & HostLocation {
  return shape(value, ["directory"], ["workspaceID"]) && text(value.directory)
    && !value.directory.includes("\0") && path.isAbsolute(value.directory)
    && (!Object.hasOwn(value, "workspaceID") || text(value.workspaceID))
}

function scope(value: JSONValue | undefined): value is JSONObject & HostScope {
  return shape(value, ["location", "epoch"]) && location(value.location) && text(value.epoch)
}

export function readHostScope(value: unknown): HostScope | undefined {
  const copy = boundedHostJSON(value)
  return scope(copy) ? copy : undefined
}

/** Accept the pinned 2.0.26 permission payload, not an event or a V1 request.
 * Missing source remains a valid native queue item; it provides no invocation link.
 * A tool source identifies a call, not native origin or unambiguous nested execution.
 */
export function readHostRequest(value: unknown): HostRequest | undefined {
  const copy = boundedHostJSON(value)
  if (!shape(copy, ["id", "sessionID", "action", "resources"], ["save", "metadata", "source", "message"])
    || !text(copy.id) || !text(copy.sessionID) || !text(copy.action) || !strings(copy.resources)
    || (Object.hasOwn(copy, "save") && !strings(copy.save))
    || (Object.hasOwn(copy, "metadata") && !object(copy.metadata))
    || (Object.hasOwn(copy, "message") && typeof copy.message !== "string")) return
  const source = copy.source
  if (Object.hasOwn(copy, "source") && (!shape(source, ["type", "messageID", "id"])
    || source.type !== "tool" || !text(source.messageID) || !text(source.id))) return
  return freeze({
    id: copy.id, sessionID: copy.sessionID, action: copy.action, resources: copy.resources,
    ...(Object.hasOwn(copy, "save") ? { save: copy.save as readonly string[] } : {}),
    ...(Object.hasOwn(copy, "metadata") ? { metadata: copy.metadata as JSONObject } : {}),
    ...(source ? { source: { assistantID: (source as JSONObject).messageID as string, id: (source as JSONObject).id as string } } : {}),
    ...(Object.hasOwn(copy, "message") ? { message: copy.message as string } : {}),
  })
}

/** Normalize the public direct-server domain's optional-field representation. */
export function serverRequestJSON(value: unknown): JSONObject | undefined {
  // Pinned server-domain requests contain optional undefined properties. Match
  // their HTTP encoding only for these four outer fields, never nested values.
  if (!value || typeof value !== "object" || types.isProxy(value)) return
  const optional = ["save", "metadata", "source", "message"]
  const keys = Reflect.ownKeys(value)
  if (keys.length > 8) return
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (typeof key !== "string" || !["id", "sessionID", "action", "resources", ...optional].includes(key)) return
    const property = Object.getOwnPropertyDescriptor(value, key)!
    if (!property.enumerable || !Object.hasOwn(property, "value")) return
    if (property.value === undefined && optional.includes(key)) continue
    Object.defineProperty(result, key, { value: property.value, enumerable: true })
  }
  const copy = boundedHostJSON(result)
  return object(copy) ? copy : undefined
}

/** Validate a companion-captured projection, retaining invocation and project paths separately. */
export function readHostInvocation(value: unknown): HostInvocation | undefined {
  const copy = boundedHostJSON(value)
  if (!shape(copy, ["sessionID", "assistantID", "callID", "tool", "input", "location", "project", "epoch"])
    || ![copy.sessionID, copy.assistantID, copy.callID, copy.tool, copy.epoch].every(text)
    || !object(copy.input) || !location(copy.location)
    || !shape(copy.project, ["id", "directory", "canonical"]) || !text(copy.project.id)
    || ![copy.project.directory, copy.project.canonical].every(item => text(item) && !item.includes("\0") && path.isAbsolute(item))) return
  return copy as unknown as HostInvocation
}

/** Canonicalize only validated owned data: object order is irrelevant, array order is exact. */
function canonical(value: JSONValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`
  return Object.is(value, -0) ? "-0" : JSON.stringify(value)
}

/** Exact JSON equality for mandatory arguments, after independent bounded copies. */
export function sameHostJSON(left: unknown, right: unknown): boolean {
  const a = boundedHostJSON(left), b = boundedHostJSON(right)
  return a !== undefined && b !== undefined && canonical(a) === canonical(b)
}

/** Capture raw pending data and the caller's proven connected scope together. */
export function snapshotRequest(value: unknown, at: unknown): HostRequestSnapshot | undefined {
  const request = readHostRequest(value), scope = readHostScope(at)
  if (!request || !scope) return
  const snapshot = Object.freeze({ request, scope })
  identities.set(snapshot, canonical(snapshot as unknown as JSONObject))
  return snapshot
}

/** Both sides must be fresh/retained snapshots created at this boundary. */
export function sameRequest(left: HostRequestSnapshot, right: HostRequestSnapshot): boolean {
  const identity = identities.get(left)
  return identity !== undefined && identity === identities.get(right)
}

/** Reverse only the documented native source projection of an owned snapshot.
 * This retains native action/resources/save and optional-field absence. */
export function hostRequestWire(snapshot: HostRequestSnapshot): JSONObject | undefined {
  if (!identities.has(snapshot)) return
  const { source, ...rest } = snapshot.request
  const copy = boundedHostJSON({ ...rest, ...(source ? { source: { type: "tool", messageID: source.assistantID, id: source.id } } : {}) })
  return object(copy) ? copy : undefined
}
