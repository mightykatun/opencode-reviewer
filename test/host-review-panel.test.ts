import assert from "node:assert/strict"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { transform } from "esbuild"
import * as core from "@opentui/core"
import * as solid from "solid-js"
import { scannerFrame, SCANNER_FRAME_COUNT, SCANNER_INTERVAL_MS } from "../src/appearance.js"
import { displayText } from "../src/controller.js"
import { ReviewGeometryProof } from "../src/review-geometry.js"
import { uiText } from "../src/ui-text.js"
import { usageText } from "../src/usage.js"
import type { HostReviewPanelProps } from "../src/host-review-panel.js"
import { HostPanelPresentationProof, hostPanelOwnsHit, type HostPanelNode, type HostPanelProofInput } from "../src/host-review-panel.js"

function node(num: number, y: number, height: number, children: HostPanelNode[] = []): HostPanelNode {
  return { num, x: 120, y, width: 38, height, visible: true, isDestroyed: false, getChildren: () => children }
}
function input(): HostPanelProofInput {
  const heading = node(2, 5, 1), rating = node(3, 7, 1), footer = node(4, 29, 3, [node(5, 31, 1)])
  const report = node(6, 9, 19)
  const bounds = { x: 118, y: 4, width: 42, height: 30 }
  return { id: "request", request: { id: "request", sessionID: "nested" },
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
  assert.deepEqual(proof.state(value), { state: "visible", id: "request" }, "fresh physical observation")
  value.panel!.y = 0
  assert.equal(proof.state(value).state, "pending", "full viewport top-zero overlay cannot inherit anchor proof")
  value.panel!.y = 4
  assert.equal(proof.state(value).state, "pending", "restored layout still needs another frame")
  assert.equal(proof.state(value, true).state, "visible")
})

test("neither normal nor fast physical observations can accept history-owned hits", () => {
  const value: HostPanelProofInput = { ...input(), hitTest: () => 999 }, proof = new HostPanelPresentationProof()
  assert.equal(proof.state(value, true).state, "lost")
  assert.equal(proof.state({ ...value, fast: true }, true).state, "lost")
  value.hitTest = input().hitTest
  assert.equal(proof.state({ ...value, finalReady: false }, true).state, "pending")
  assert.equal(proof.state({ ...value, request: { id: "other", sessionID: "nested" } }, true).state, "lost")
  assert.equal(proof.state({ ...value, route: { type: "session", sessionID: "child" } }, true).state, "lost")
  assert.equal(proof.state({ ...value, mode: "modal" }, true).state, "lost")
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

test("fixture identity and anchor ownership are independent of panel mounting", () => {
  const mutations: ((value: HostPanelProofInput) => void)[] = [
    value => { value.heading!.visible = false },
    value => { value.heading!.isDestroyed = true },
    value => { value.rating!.isDestroyed = true },
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

test("final Markdown readiness distinguishes completed report paint from fast preview paint", () => {
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

const require = createRequire(import.meta.url)
const { transformAsync } = require("@babel/core")
const universal = await transformAsync(await readFile(new URL("../src/host-review-panel.tsx", import.meta.url), "utf8"), {
  filename: "src/host-review-panel.tsx", babelrc: false, configFile: false,
  presets: [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ["@babel/preset-typescript", { allExtensions: true, isTSX: true }]],
})
const compiled = await transform(universal.code, { loader: "js", format: "cjs" })

function panelObserverFixture(probe: boolean) {
  const cleanup: (() => void)[] = [], samples: unknown[] = []
  const elements: (HostPanelNode & { renderAfter?: () => void })[] = []
  const color = core.RGBA.fromInts(255, 255, 255)
  const renderer = Object.assign(new EventEmitter(), { width: 160, height: 40, useMouse: true,
    hitTest: () => -1 })
  const dependencies: Record<string, unknown> = {
    "solid-js": { ...solid, createEffect() {}, onCleanup(fn: () => void) { cleanup.push(fn) } },
    "@opentui/core": core,
    "@opentui/solid": {
      createElement() { const element = node(elements.length + 1, 4, 30); elements.push(element); return element },
      use(ref: (value: unknown) => void, value: unknown) { ref(value) },
      setProp(element: Record<string, unknown>, key: string, value: unknown) { element[key] = value; return value },
      effect(fn: (previous: object) => unknown) { fn({}) },
      // These tests cover observer registration, not rendering nested components.
      createComponent() {}, insert() {}, insertNode() {}, createTextNode() {}, memo: solid.createMemo,
    },
    "./controller.js": { displayText },
    "./appearance.js": { scannerFrame, SCANNER_FRAME_COUNT, SCANNER_INTERVAL_MS },
    "./review-description.js": { HostReviewDescription() {} },
    "./review-geometry.js": { ReviewGeometryProof },
    "./ui-text.js": { uiText }, "./usage.js": { usageText },
  }
  const module = { exports: {} as { HostReviewPanel(props: HostReviewPanelProps): unknown } }
  new Function("require", "module", "exports", compiled.code)((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`)
    return dependencies[name]
  }, module, module.exports)
  const value = input(), view = { request: value.request, status: "ready", assessment: { safe: true, desc: "Report" } }
  const props = { id: "request", view: () => view, select: () => view, rootSession: () => "root",
    sidebarOwner: () => value.anchor, sidebarGeometry: () => value.bounds,
    config: { autoApprove: false, fastMode: false }, onApprove() {}, onCancel() {},
    context: { renderer, ui: { router: { current: () => value.route } }, keymap: { mode: { current: () => "base" } },
      theme: { text: { base: color, muted: color, feedback: { success: { base: color }, error: { base: color }, warning: { base: color } } },
        background: { raised: { base: color } }, border: { base: color }, scrollbar: { base: color } } },
    historyProbe: probe ? { observe(sample: unknown) { samples.push(sample); return Promise.reject(new Error("optional probe failed")) } } : undefined,
  } as unknown as HostReviewPanelProps
  module.exports.HostReviewPanel(props)
  return { renderer, elements, samples, dispose() { for (const fn of cleanup) fn() } }
}

test("production panel without a probe installs no paint callback or physical observer", () => {
  const host = panelObserverFixture(false)
  assert.equal(host.renderer.listenerCount(core.CliRenderEvents.FRAME), 0)
  assert.equal(host.renderer.listenerCount(core.CliRenderEvents.RESIZE), 0)
  assert.ok(host.elements.every(element => element.renderAfter === undefined))
  host.renderer.emit(core.CliRenderEvents.FRAME)
  assert.deepEqual(host.samples, [])
  host.dispose()
})

test("advisory panel observes real FRAME with a probe independently of autoApprove and isolates probe failures", async () => {
  const host = panelObserverFixture(true)
  assert.equal(host.renderer.listenerCount(core.CliRenderEvents.FRAME), 1)
  assert.equal(host.renderer.listenerCount(core.CliRenderEvents.RESIZE), 1)
  assert.ok(host.elements.some(element => typeof element.renderAfter === "function"))
  host.renderer.emit(core.CliRenderEvents.FRAME)
  assert.equal(host.samples.length, 1)
  assert.equal((host.samples[0] as { stage: string }).stage, "frame")
  assert.equal((host.samples[0] as { eligible: boolean }).eligible, false, "physical observations grant no approval eligibility")
  await Promise.resolve()
  host.dispose()
  assert.equal(host.renderer.listenerCount(core.CliRenderEvents.FRAME), 0)
  assert.equal(host.renderer.listenerCount(core.CliRenderEvents.RESIZE), 0)
})
