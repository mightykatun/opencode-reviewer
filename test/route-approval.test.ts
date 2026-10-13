import assert from "node:assert/strict"
import { test } from "node:test"
import { conversationRoot, RouteSessions, type SessionLocation } from "../src/route-approval.js"

const sessions = new Map<string, SessionLocation>([["root", { id: "root" }], ["child", { id: "child", parentID: "root" }],
  ["nested", { id: "nested", parentID: "child" }]])
const get = (id: string) => sessions.get(id)
test("root ancestry is exact, bounded, cycle-safe and requires every public parent", () => {
  assert.equal(conversationRoot("nested", get), "root")
  assert.equal(conversationRoot(undefined, get), undefined)
  assert.equal(conversationRoot("child", id => id === "child" ? get(id) : undefined), undefined)
  assert.equal(conversationRoot("child", () => ({ id: "wrong" })), undefined)
  assert.equal(conversationRoot("child", id => ({ id, parentID: id })), undefined)
  assert.equal(conversationRoot("child", id => ({ id, parentID: "" })), undefined)
  assert.equal(conversationRoot("0", id => ({ id, ...(Number(id) < 16 ? { parentID: String(Number(id) + 1) } : {}) })), "16")
  assert.equal(conversationRoot("0", id => ({ id, ...(Number(id) < 17 ? { parentID: String(Number(id) + 1) } : {}) })), undefined)
})
test("public session events bridge missing route metadata but never conflicts or deletion", () => {
  const current = new Map<string, SessionLocation>([["root", { id: "root" }]])
  const metadata = new RouteSessions(id => current.get(id))
  assert.equal(metadata.remember({ id: "child", parentID: "root" }), true)
  assert.equal(metadata.remember({ id: "child", parentID: "root" }), false)
  metadata.remember({ id: "nested", parentID: "child" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), "root")
  current.set("child", { id: "child", parentID: "other" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), undefined)
  current.set("child", { id: "child", parentID: "root" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), "root")
  metadata.deleted("child"); metadata.remember({ id: "child", parentID: "root" })
  assert.equal(conversationRoot("nested", id => metadata.get(id)), undefined)
})
test("route event cache is bounded and rejects mismatched current identities", () => {
  const metadata = new RouteSessions(id => id === "wrong" ? { id: "different" } : undefined)
  metadata.remember({ id: "wrong" }); assert.equal(metadata.get("wrong"), undefined)
  for (let i = 0; i < 4097; i++) metadata.remember({ id: String(i) })
  assert.equal(metadata.get("0"), undefined); assert.deepEqual(metadata.get("4096"), { id: "4096" })
})
