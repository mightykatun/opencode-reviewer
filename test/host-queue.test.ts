import assert from "node:assert/strict"
import { test } from "node:test"
import { hostQueueFront, type HostQueueReader } from "../src/host-queue.js"
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
