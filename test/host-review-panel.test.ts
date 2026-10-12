import assert from "node:assert/strict"
import { test } from "node:test"
import { HostPanelPresentationProof, hostPanelOwnsHit, type HostPanelNode, type HostPanelProofInput } from "../src/host-review-panel.js"

function node(num: number, y: number, height: number, children: HostPanelNode[] = []): HostPanelNode {
  return { num, x: 120, y, width: 38, height, visible: true, isDestroyed: false, getChildren: () => children }
}
function input(): HostPanelProofInput {
  const heading = node(2, 5, 1), rating = node(3, 7, 1), footer = node(4, 29, 3, [node(5, 31, 1)])
  const report = node(6, 9, 19)
  const bounds = { x: 118, y: 4, width: 42, height: 30 }
  return { id: "request", request: { id: "request", sessionID: "nested" }, selected: { id: "request", sessionID: "nested" },
    root: "root", route: { type: "session", sessionID: "root" }, mode: "base", mouse: true,
    width: 160, height: 40, fast: false, finalReady: true,
    anchor: { owner: Symbol(), sessionID: "root", node: { ...node(7, 4, 30), ...bounds } }, bounds,
    panel: { ...node(1, 4, 30, [heading, rating, report, footer]), ...bounds }, heading, rating, report, footer,
    hitTest: (_x, y) => y === heading.y ? heading.num : y === rating.y ? rating.num : y === footer.y + 1 ? footer.num : -1 }
}

test("V2 panel needs measured anchor bounds and a fresh real frame, not a timer or mounted root", () => {
  const value = input(), proof = new HostPanelPresentationProof()
  assert.deepEqual(proof.state(value), { state: "pending", id: "request" })
  assert.deepEqual(proof.state(value, true), { state: "visible", id: "request" })
  assert.deepEqual(proof.state(value), { state: "visible", id: "request" }, "synchronous write-boundary recheck")
  value.panel!.y = 0
  assert.equal(proof.state(value).state, "pending", "full viewport top-zero overlay cannot inherit anchor proof")
  value.panel!.y = 4
  assert.equal(proof.state(value).state, "pending", "restored layout still needs another frame")
  assert.equal(proof.state(value, true).state, "visible")
})

test("descendant and unrelated routes revoke normal and fast proof without a hidden-route exception", () => {
  for (const fast of [false, true]) for (const route of ["child", "nested", "sibling", "unrelated"]) {
    const value = { ...input(), fast }, proof = new HostPanelPresentationProof()
    assert.equal(proof.state(value, true).state, "visible")
    value.route = { type: "session", sessionID: route }
    assert.equal(proof.state(value).state, "lost")
    assert.equal(proof.state(value, true).state, "lost")
    value.route = { type: "session", sessionID: "root" }
    assert.equal(proof.state(value).state, "pending")
    assert.equal(proof.state(value, true).state, "visible")
  }
})

test("modal input mode and disabled mouse block even apparently good hits", () => {
  for (const fast of [false, true]) for (const gate of ["mouse", "modal"] as const) {
    const value = { ...input(), fast }, proof = new HostPanelPresentationProof()
    assert.equal(proof.state(value, true).state, "visible")
    if (gate === "mouse") value.mouse = false
    else value.mode = "dialog"
    assert.equal(proof.state(value).state, "lost")
    assert.equal(proof.state(value, true).state, "lost")
    value.mouse = true; value.mode = "base"
    assert.equal(proof.state(value).state, "pending", "no remembered pre-cover paint")
  }
})

test("fresh native identity, priority and anchor ownership are independent of panel mounting", () => {
  const mutations: ((value: HostPanelProofInput) => void)[] = [
    value => { value.selected = undefined },
    value => { value.selected = { id: "other", sessionID: "nested" } },
    value => { value.selected = { id: "request", sessionID: "other" } },
    value => { value.request = { id: "other", sessionID: "nested" } },
    value => { value.anchor = undefined },
    value => { value.anchor!.sessionID = "child" },
    value => { value.anchor!.node.visible = false },
    value => { value.anchor!.node.isDestroyed = true },
    value => { value.panel!.visible = false },
    value => { value.hitTest = () => 999 },
  ]
  for (const mutate of mutations) {
    const value = input(), proof = new HostPanelPresentationProof()
    assert.equal(proof.state(value, true).state, "visible")
    mutate(value)
    assert.equal(proof.state(value).state, "lost")
    assert.equal(proof.state(value, true).state, "lost")
  }
  const value = input(), proof = new HostPanelPresentationProof()
  assert.equal(proof.state(value, true).state, "visible")
  value.anchor!.owner = Symbol()
  assert.equal(proof.state(value).state, "pending")
  assert.equal(proof.state(value, true).state, "visible")
  value.anchor!.node = { ...value.anchor!.node }
  assert.equal(proof.state(value).state, "pending", "same rectangle is not the same physical anchor")
})

test("final Markdown readiness gates normal approval but not fast preview", () => {
  const value = { ...input(), finalReady: false }, proof = new HostPanelPresentationProof()
  assert.equal(proof.state(value, true).state, "pending")
  value.finalReady = true
  assert.equal(proof.state(value).state, "pending", "final Markdown readiness cannot inherit an earlier preview frame")
  assert.equal(proof.state(value, true).state, "visible", "completed paint needs a matching real frame")
  proof.invalidate()
  assert.equal(proof.state(value).state, "pending")
  const fast = { ...input(), fast: true, finalReady: false, report: undefined, footer: undefined }
  assert.equal(new HostPanelPresentationProof().state(fast, true).state, "visible")
})

test("clipped anchors and controls fail; anchor changes require matching overlay layout and another frame", () => {
  const value = input(), proof = new HostPanelPresentationProof()
  assert.equal(proof.state(value, true).state, "visible")
  value.anchor!.node.height = 29
  assert.equal(proof.state(value).state, "pending")
  value.bounds!.height = value.panel!.height = 29
  assert.equal(proof.state(value).state, "pending")
  assert.equal(proof.state(value, true).state, "visible")
  value.footer!.getChildren = () => [node(10, 33, 2)]
  assert.equal(proof.state(value, true).state, "lost", "real footer descendants must fit")
  value.anchor!.node.y = 20
  assert.equal(proof.state(value, true).state, "lost", "anchor must fit viewport")
  const invalid = input()
  invalid.bounds!.x = Number.NaN
  assert.equal(new HostPanelPresentationProof().state(invalid, true).state, "pending")
})

test("footer branch handoff can use only unchanged painted geometry until the next frame", () => {
  const value = input(), proof = new HostPanelPresentationProof()
  assert.equal(proof.state(value, true).state, "visible")
  value.footer!.getChildren = () => [{ ...node(10, 0, 0), width: 0 }]
  assert.equal(proof.state(value).state, "visible", "footer padding hit remains real")
  assert.equal(proof.state(value, true).state, "lost", "new frame must prove actual layout")
})

test("hit ownership traverses scroll wrappers but never hidden or destroyed nodes", () => {
  const wrapper = node(2, 1, 1), root = { ...node(1, 1, 1), wrapper }
  assert.equal(hostPanelOwnsHit(root, 2), true)
  wrapper.visible = false
  assert.equal(hostPanelOwnsHit(root, 2), false)
  wrapper.visible = true; wrapper.isDestroyed = true
  assert.equal(hostPanelOwnsHit(root, 2), false)
  assert.equal(hostPanelOwnsHit(undefined, 2), false)
})
