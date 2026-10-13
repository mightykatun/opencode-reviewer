import assert from "node:assert/strict"
import { test } from "node:test"
import { hostFamilyIDs, hostPermissionIdentities, hostQueueFront, hostQueueSnapshot, type HostQueueReader } from "../src/host-queue.js"
import type { HostRequest } from "../src/host-types.js"

const request = (sessionID: string, id: string, action = "shell"): HostRequest => ({ id, sessionID, action, resources: ["scope"] })
function fixture() {
  const sessions = new Map([["root", { id: "root" }], ["child", { id: "child", parentID: "root" }],
    ["deep", { id: "deep", parentID: "child" }]])
  const pending = new Map<string, HostRequest[]>([["root", []], ["child", []], ["deep", []]])
  const reader: HostQueueReader = { session: id => sessions.get(id), family: () => ["deep", "child", "root"], permissions: id => pending.get(id) }
  return { sessions, pending, reader }
}
test("native root queue is root-first then family/cache order, not ID or event arrival", () => {
  const f = fixture()
  f.pending.set("root", [request("root", "z-root", "unknown")])
  f.pending.set("child", [request("child", "a-child")])
  f.pending.set("deep", [request("deep", "z-deep"), request("deep", "a-deep")])
  assert.equal(hostQueueFront("root", f.reader)?.id, "z-root")
  f.pending.set("root", [])
  assert.equal(hostQueueFront("root", f.reader)?.id, "z-deep")
  f.pending.set("deep", [])
  assert.equal(hostQueueFront("root", f.reader)?.id, "a-child")
})
test("unknown ancestry, unreadable preceding caches, cycles and mismatched ownership fail closed", () => {
  for (const change of ["ancestry", "cache", "cycle", "owner", "duplicate"] as const) {
    const f = fixture()
    f.pending.set("child", [request("child", "permission")])
    if (change === "ancestry") f.sessions.delete("deep")
    if (change === "cache") f.pending.delete("deep")
    if (change === "cycle") f.sessions.set("root", { id: "root", parentID: "child" })
    if (change === "owner") f.pending.set("deep", [request("other", "wrong")])
    if (change === "duplicate") f.reader.family = () => ["deep", "deep"]
    assert.equal(hostQueueFront("root", f.reader), undefined, change)
  }
})

test("an unknown later queue or ancestry cannot change a known earlier native priority", () => {
  for (const change of ["ancestry", "cache", "owner", "throw"] as const) {
    const f = fixture()
    f.pending.set("root", [request("root", "front")])
    if (change === "ancestry") f.sessions.delete("deep")
    if (change === "cache") f.pending.delete("deep")
    if (change === "owner") f.pending.set("deep", [request("other", "wrong")])
    if (change === "throw") f.reader.permissions = id => {
      if (id === "deep") throw Error("Later cache unavailable")
      return f.pending.get(id)
    }
    assert.deepEqual(hostQueueFront("root", f.reader), { id: "front", sessionID: "root" }, change)
    assert.deepEqual(hostQueueSnapshot("root", f.reader), { state: "unknown" }, change)
  }
})

test("full native observations distinguish empty, unknown and exact public front", () => {
  const f = fixture()
  assert.deepEqual(hostQueueSnapshot("root", f.reader), { state: "empty", family: ["root", "deep", "child"] })
  f.pending.set("deep", [request("deep", "z-first"), request("deep", "a-next")])
  f.pending.set("child", [request("child", "earlier-event")])
  assert.deepEqual(hostQueueSnapshot("root", f.reader), {
    state: "front", family: ["root", "deep", "child"], request: { id: "z-first", sessionID: "deep" },
  })
  f.pending.set("child", [request("child", "z-first")])
  assert.deepEqual(hostQueueSnapshot("root", f.reader), { state: "unknown" }, "duplicate IDs across owners are unavailable")
})

test("early priority preserves complete current-queue identity validation", () => {
  for (const values of [
    [request("root", "front"), request("root", "front")],
    [request("root", "front"), request("other", "later")],
    [request("root", "front"), request("root", "x".repeat(16385))],
    [request("root", "front"), undefined],
  ]) {
    const f = fixture()
    f.pending.set("root", values as HostRequest[])
    assert.equal(hostQueueFront("root", f.reader), undefined)
    assert.deepEqual(hostQueueSnapshot("root", f.reader), { state: "unknown" })
  }
})

test("full queue health validates later identities, owners, ancestry and observer exceptions", () => {
  for (const change of ["duplicate", "empty-id", "owner", "cycle", "identity", "family", "permissions", "metadata"] as const) {
    const f = fixture()
    f.pending.set("root", [request("root", "front")])
    if (change === "duplicate") f.pending.set("deep", [request("deep", "later"), request("deep", "later")])
    if (change === "empty-id") f.pending.set("deep", [request("deep", "")])
    if (change === "owner") f.pending.set("deep", [request("other", "later")])
    if (change === "cycle") f.sessions.set("deep", { id: "deep", parentID: "deep" })
    if (change === "identity") f.sessions.set("deep", { id: "child", parentID: "root" })
    if (change === "family") f.reader.family = () => { throw Error("Family unavailable") }
    if (change === "permissions") f.reader.permissions = () => { throw Error("Queue unavailable") }
    if (change === "metadata") f.reader.session = () => { throw Error("Metadata unavailable") }
    assert.deepEqual(hostQueueSnapshot("root", f.reader), { state: "unknown" }, change)
  }
})

test("family ID validation is bounded, root-first, exact-order and duplicate closed", () => {
  assert.deepEqual(hostFamilyIDs("root", ["deep", "root", "child"]), ["root", "deep", "child"])
  assert.deepEqual(hostFamilyIDs("root", []), ["root"])
  for (const values of [undefined, ["root", "root"], ["deep", "deep"], [""], [undefined], Array(16385).fill("child")]) {
    assert.equal(hostFamilyIDs("root", values as string[] | undefined), undefined)
  }
  const ids = Array.from({ length: 16383 }, (_, index) => `child-${index}`)
  assert.equal(hostFamilyIDs("root", ids)?.length, 16384)
  assert.equal(hostFamilyIDs("root", [...ids, "extra"]), undefined)
})

test("queue identities are bounded globally and do not inspect native request payloads", () => {
  const identities = new Set<string>()
  const value = new Proxy(request("root", "permission"), {
    get(target, key) {
      if (key === "id" || key === "sessionID") return Reflect.get(target, key)
      throw Error("Native request payload must not be inspected")
    },
    ownKeys() { throw Error("Native request must not be snapshotted") },
    getOwnPropertyDescriptor() { throw Error("Native request descriptors must not be inspected") },
  })
  const values = hostPermissionIdentities("root", [value], identities)
  assert.equal(values?.length, 1)
  assert.equal(values?.[0], value, "validation retains typed native entries without inspecting their payload")
  assert.equal(hostPermissionIdentities("child", [request("child", "permission")], identities), undefined)
  assert.equal(hostPermissionIdentities("root", Array(16385).fill(value)), undefined)
  const many = Array.from({ length: 16384 }, (_, index) => request("root", `permission-${index}`))
  const seen = new Set<string>()
  assert.equal(hostPermissionIdentities("root", many, seen)?.length, 16384)
  assert.equal(hostPermissionIdentities("child", [request("child", "extra")], seen), undefined)
  const f = fixture()
  f.pending.set("root", [value])
  assert.deepEqual(hostQueueSnapshot("root", f.reader), {
    state: "front", family: ["root", "deep", "child"], request: { id: "permission", sessionID: "root" },
  })
})
