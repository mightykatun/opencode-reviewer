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

test("without tabs automation requires proven routed conversation ancestry", () => {
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

test("an open conversation tab qualifies independently of the active route and its native decision", () => {
  const sessions = new Map([
    ["root", { id: "root" }], ["child", { id: "child", parentID: "root" }],
    ["other", { id: "other" }], ["other-child", { id: "other-child", parentID: "other" }],
  ])
  const session = (id: string) => sessions.get(id)
  const request = { sessionID: "child" }
  const away = { type: "session", sessionID: "other" }
  const tabs = [{ sessionID: "root", active: false }, { sessionID: "other", active: true }]
  assert.equal(hostApprovalReady(request, "root", away, session, () => false), false)
  assert.equal(hostApprovalReady(request, "root", away, session, () => false, tabs), true)
  assert.equal(hostApprovalReady(request, "root", away, session, () => false,
    [{ sessionID: "child", active: false }, tabs[1]!]), true)
  assert.equal(hostApprovalReady(request, "root", away, session, () => { throw Error("Unrelated native decision must not be read") }, tabs), true)
  for (const absent of [[], [tabs[1]!], [{ sessionID: "missing", active: false }, tabs[1]!]])
    assert.equal(hostApprovalReady(request, "root", away, session, () => false, absent), false)
  for (const route of [{ type: "home" }, { type: "plugin" }, { type: "session", sessionID: "missing" },
    { type: "session", sessionID: "other-child" }])
    assert.equal(hostApprovalReady(request, "root", route, session, () => { throw Error("No routed decision owns this tab") }, tabs), true)
  assert.equal(hostApprovalReady(request, "root", away, session, () => false, [tabs[0]!]), true,
    "the active tab roster is not an approval requirement")
  assert.equal(hostApprovalReady(request, "root", away, session, () => false, [{ sessionID: "root", active: true }]), true,
    "focus transitions cannot revoke a proven open conversation")
  assert.equal(hostApprovalReady(request, "root", { type: "session", sessionID: "root" }, session, () => true, tabs), false,
    "a decision in this conversation still holds")
  sessions.set("child", { id: "child", parentID: "missing" })
  assert.equal(hostApprovalReady(request, "root", away, session, () => false, tabs), false)
})
