import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { OpenCodeClient } from "@opencode/client"
import { Controller, visibleReview } from "../src/controller.js"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { readPendingInventory, snapshotRequest } from "../src/host-request.js"
import { hostPermissionTransport } from "../src/host-permissions.js"
import { InvocationCapture } from "../src/invocation-capture.js"
import { parseConfig } from "../src/config.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"

const location = { directory: "/fixture/project" }
const scope = { location, epoch: "10000000-1000-4000-8000-100000000000" }
const handshake = { protocol: 1 as const, hostVersion: "development", ...scope,
  project: { id: "project", directory: location.directory, canonical: location.directory } }
const request = (id: string) => ({ id, sessionID: id, action: "shell", resources: ["pwd"],
  source: { type: "tool", messageID: "assistant", id: "call-" + id } })

test("missing mandatory evidence remains visible and manual while its native permission is pending", async t => {
  const snapshot = snapshotRequest(request("root"), scope)!
  let reads = 0, posts = 0
  const client = { rpc: () => ({ invocation: async () => { reads++; return null } }) } as unknown as OpenCodeClient
  const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", notify: false })
  const controller = new Controller((request, signal, identified) =>
    evaluateHostReview(client, snapshot, config, BUILTIN_PROMPTS, signal, identified, {
      fetcher: async () => { posts++; throw Error("No model call without evidence") },
    }), () => {}, { candidate: () => true, nativeFront: () => snapshot.request.id })
  t.after(() => controller.dispose())
  controller.asked(snapshot.request); await settle()
  for (let turn = 0; turn < 5; turn++) { controller.reconcile([snapshot.request], controller.revision); await settle() }
  assert.equal(reads, 1, "Unknown linkage must not cause speculative evidence retries")
  assert.equal(posts, 0)
  assert.equal(visibleReview(controller.views, "root", id => ({ id }), () => "root")?.status, "unidentified")
  assert.equal(controller.views[0]?.assessment, undefined)
})

test("a metadata-heavy pending request does not block an independent valid permission", async () => {
  const large = { ...request("large"), metadata: { items: Array(17000).fill("x") } }
  const healthy = request("healthy")
  const client = { rpc: () => ({ handshake: async () => handshake }), permission: {
    request: { list: async () => ({ location, data: [large, healthy] }) },
  } } as unknown as OpenCodeClient
  const values = await hostPermissionTransport(client, scope).pendingScope(new AbortController().signal)
  assert.deepEqual(values.map(value => value.request.id), ["large", "healthy"], "Retain the unreadable native blocker identity")
  assert.deepEqual(values[1], snapshotRequest(healthy, scope))
  assert.equal("resources" in values[0]!.request, false, "Never fabricate missing mandatory arguments")
})

test("capture overflow releases rejected identities only after all matching executions settle", () => {
  const captures = new InvocationCapture(handshake)
  const call = (id: number) => ({ sessionID: "root", messageID: "assistant", id: "call-" + id,
    tool: "shell", input: { command: "pwd" } })
  for (let index = 0; index < 513; index++) captures.before(call(index))
  captures.before(call(512))
  for (let index = 0; index < 512; index++) captures.after(call(index))
  captures.after(call(512))
  captures.before(call(512))
  assert.equal(captures.read("root", "assistant", "call-512"), undefined, "A later sibling cannot claim an overflowing identity")
  captures.before(call(1000))
  assert.equal(captures.read("root", "assistant", "call-1000")?.tool, "shell", "Independent live calls recover when capacity returns")
  captures.after(call(512)); captures.after(call(512))
  captures.before(call(512))
  assert.equal(captures.read("root", "assistant", "call-512")?.tool, "shell")
})

test("inventory isolation never invokes accessors, proxies or guesses missing and duplicate identities", () => {
  let traps = 0
  const accessor = { ...request("accessor"), get metadata() { traps++; throw Error("Do not invoke") } }
  const isolated = readPendingInventory({ location, data: [accessor, request("healthy")] }, scope)!
  assert.equal(traps, 0)
  assert.deepEqual(isolated[0]!.request, { id: "accessor", sessionID: "accessor", unavailable: true })
  assert.equal(isolated[1]!.request.id, "healthy")
  for (const data of [[{ sessionID: "root" }, request("healthy")], [request("same"), request("same")],
    [new Proxy(request("proxy"), { get() { traps++; throw Error("Do not invoke") } }), request("healthy")]])
    assert.equal(readPendingInventory({ location, data }, scope), undefined)
  assert.equal(traps, 0)
  assert.equal(readPendingInventory({ location: { ...location, workspaceID: "foreign" }, data: [] }, scope), undefined)
})

test("identity-only manual blockers respect the saved conversation-mode gate and never evaluate", async t => {
  const blocker = { id: "large", sessionID: "root", unavailable: true as const }
  let evaluations = 0
  const controller = new Controller<typeof blocker>(async () => { evaluations++; return null }, () => {}, {
    unavailable: () => "Mandatory data unavailable",
    modes: { root: async () => "root", load: async () => {}, enabled: () => false },
  })
  t.after(() => controller.dispose())
  controller.asked(blocker); await settle()
  assert.equal(evaluations, 0)
  assert.equal(controller.views[0]?.status, "suspended")
})
