import assert from "node:assert/strict"
import { test } from "node:test"
import { RGBA } from "@opentui/core"
import { hostApprovalReady, nativeDecisionPending, type NativeDecisionNode } from "../src/host-approval-ready.js"

const selected = RGBA.fromInts(10, 20, 30), base = RGBA.fromInts(40, 50, 60)
const node = (id: string, children: NativeDecisionNode[] = [], backgroundColor?: RGBA): NativeDecisionNode =>
  ({ id, visible: true, isDestroyed: false, getChildren: () => children, backgroundColor })
const choices = (choice = "once") => node("session.permission.actions", ["once", "always", "reject"].map(value =>
  node(`session.permission.action.${value}`, [], value === choice ? selected : base)))

test("native default once does not block, selected Always/reject and rejection editing hold without relying on mouse or modal mode", () => {
  assert.equal(nativeDecisionPending(node("root", [choices()]), selected), false)
  for (const choice of ["always", "reject"]) assert.equal(nativeDecisionPending(node("root", [choices(choice)]), selected), true)
  assert.equal(nativeDecisionPending(node("root", [node("session.permission.reject")]), selected), true)
  assert.equal(nativeDecisionPending(node("root", [node("palette"), node("history"), node("fullscreen", [choices()])]), selected), false)
  assert.equal(nativeDecisionPending(node("root"), selected), false, "no native prompt presentation is required")
})

test("native decision observation waits closed on ambiguous styling, partial choices, unreadable trees and traversal overflow", () => {
  assert.equal(nativeDecisionPending(node("root", [node("session.permission.actions")]), selected), true)
  assert.equal(nativeDecisionPending(node("session.permission.actions", [node("session.permission.action.once", [], selected)]), selected), true)
  assert.equal(nativeDecisionPending(node("session.permission.actions", [node("session.permission.action.once", [], selected),
    node("session.permission.action.future", [], base)]), selected), true)
  assert.equal(nativeDecisionPending(node("session.permission.actions", Array.from({ length: 10000 }, () => node("choice"))), selected), true)
  const indistinguishable = node("session.permission.actions", ["once", "always"].map(choice =>
    node(`session.permission.action.${choice}`, [], selected)))
  assert.equal(nativeDecisionPending(indistinguishable, selected), true)
  const broken = node("root"); broken.getChildren = () => { throw Error("Unavailable") }
  assert.equal(nativeDecisionPending(broken, selected), true)
  const cycle = node("cycle"); cycle.getChildren = () => [cycle]
  assert.equal(nativeDecisionPending(cycle, selected), true)
  const hidden = node("hidden", [choices("always")]); hidden.visible = false
  assert.equal(nativeDecisionPending(node("root", [hidden]), selected), false)
})

test("automation follows proven root/descendant ancestry, but never dashboard/home/unrelated or conflicting ancestry", () => {
  const sessions = new Map([
    ["root", { id: "root" }], ["child", { id: "child", parentID: "root" }],
    ["deep", { id: "deep", parentID: "child" }], ["other", { id: "other" }],
  ])
  const session = (id: string) => sessions.get(id)
  const request = { id: "request", sessionID: "deep", action: "shell", resources: ["pwd"] }
  for (const id of ["root", "child", "deep"]) {
    assert.equal(hostApprovalReady(request, "root", { type: "session", sessionID: id }, session, () => false), true)
    assert.equal(hostApprovalReady(request, "root", { type: "session", sessionID: id }, session, () => true), false)
  }
  for (const route of [{ type: "home" }, { type: "plugin", sessionID: "root" }, { type: "session", sessionID: "other" },
    { type: "session", sessionID: "missing" }]) assert.equal(hostApprovalReady(request, "root", route, session, () => false), false)
  assert.equal(hostApprovalReady(request, undefined, { type: "session", sessionID: "root" }, session, () => false), false)
  sessions.set("deep", { id: "deep", parentID: "missing" })
  assert.equal(hostApprovalReady(request, "root", { type: "session", sessionID: "root" }, session, () => false), false)
})
