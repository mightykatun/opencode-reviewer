import assert from "node:assert/strict"
import { test } from "node:test"
import { HostHistoryPresentationProof, setupHostHistoryBrowsing, type HostHistoryProofInput } from "../src/host-history-view.js"
import type { HostPanelNode } from "../src/host-review-panel.js"
import { hostStatisticsMessage, setupHostStatistics } from "../src/host-statistics-view.js"
import { empty, lifetimeReport } from "../src/lifetime.js"
import type { StatisticsController, StatisticsState } from "../src/statistics-controller.js"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { EventEmitter } from "node:events"
import { CliRenderEvents } from "@opentui/core"

function node(num: number, y: number, height: number, children: HostPanelNode[] = []): HostPanelNode {
  return { num, x: 122, y, width: 38, height, visible: true, isDestroyed: false, getChildren: () => children }
}
function input(): HostHistoryProofInput {
  const heading = node(2, 5, 1), footer = node(3, 30, 3)
  const bounds = { x: 120, y: 4, width: 42, height: 30 }
  const panel = { ...node(1, 4, 30, [heading, footer]), ...bounds }
  return { session: "root", root: "root", current: true, route: { type: "session", sessionID: "root" },
    mode: "base", mouse: true, width: 162, height: 40, bounds, panel, heading, footer,
    anchor: { owner: Symbol(), sessionID: "root", node: { ...node(7, 4, 30), ...bounds } },
    hitTest: (_x, y) => y === heading.y ? heading.num : y === footer.y + 1 ? footer.num : -1 }
}

test("native history input needs its own painted heading/footer and measured sidebar frame", () => {
  const value = input(), proof = new HostHistoryPresentationProof()
  assert.equal(proof.visible(value), false)
  assert.equal(proof.keyboard(value), false, "logical open cannot own input")
  assert.equal(proof.visible(value, true), true)
  assert.equal(proof.keyboard(value, true), true)
  value.current = false
  assert.equal(proof.keyboard(value), false, "closed history immediately loses keyboard ownership")
  value.current = true
  assert.equal(proof.keyboard(value), false, "reopened history needs its own new frame")
  assert.equal(proof.keyboard(value, true), true)
})

test("native FRAME renews registered history ownership without granting paint during invalidation", () => {
  const value = input(), host = browsing(value)
  const observations: boolean[] = []
  host.renderer.on(CliRenderEvents.FRAME, () => observations.push(host.owner.interactive()))
  host.owner.invalidate()
  assert.equal(host.owner.interactive(), false)
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.deepEqual(observations, [true])
  value.mode = "modal"
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.deepEqual(observations, [true, false], "Current native modal cannot inherit earlier proof")
  value.mode = "base"
  host.owner.invalidate()
  assert.equal(host.owner.interactive(), false, "Restored logical gates need a genuine new FRAME")
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.deepEqual(observations, [true, false, true])
  host.dispose()
})

test("route, mouse, mode and root/controller identity loss revoke history proof", () => {
  const mutations: ((value: HostHistoryProofInput) => void)[] = [
    value => { value.route.sessionID = "child" }, value => { value.route.type = "home" },
    value => { value.root = "unrelated" }, value => { value.current = false },
    value => { value.mouse = false }, value => { value.mode = "modal" },
    value => { value.anchor!.sessionID = "child" }, value => { value.anchor!.node.visible = false },
    value => { value.panel!.isDestroyed = true }, value => { value.panel!.visible = false },
    value => { value.heading!.isDestroyed = true }, value => { value.footer!.visible = false },
    value => { value.hitTest = () => value.panel!.num },
    value => { value.hitTest = (_x, y) => y === value.heading!.y ? value.heading!.num : 999 },
  ]
  for (const mutate of mutations) {
    const value = input(), proof = new HostHistoryPresentationProof()
    assert.equal(proof.visible(value, true), true)
    mutate(value)
    assert.equal(proof.visible(value), false)
    assert.equal(proof.visible(value, true), false)
  }
})

test("matching rectangles cannot inherit paint after anchor, node or viewport replacement", () => {
  const mutations: ((value: HostHistoryProofInput) => void)[] = [
    value => { value.anchor!.owner = Symbol() }, value => { value.anchor!.node = { ...value.anchor!.node } },
    value => { value.panel = { ...value.panel! } }, value => { value.heading = { ...value.heading! } },
    value => { value.width++ },
  ]
  for (const mutate of mutations) {
    const value = input(), proof = new HostHistoryPresentationProof()
    assert.equal(proof.visible(value, true), true)
    mutate(value)
    assert.equal(proof.visible(value), false)
    assert.equal(proof.visible(value, true), true)
    proof.invalidate()
    assert.equal(proof.visible(value), false)
  }
})

test("clipped controls, invalid bounds and unrelated panel placement fail even on FRAME", () => {
  const mutations: ((value: HostHistoryProofInput) => void)[] = [
    value => { value.panel!.y = 0 }, value => { value.bounds!.height-- },
    value => { value.anchor!.node.x = -1 }, value => { value.panel!.width = NaN },
    value => { value.heading!.height = 0 }, value => { value.heading!.width = 1 },
    value => { value.footer!.y = value.height }, value => { value.footer!.width = 100 },
    value => { value.heading!.y = value.footer!.y },
    value => { value.footer!.getChildren = () => [{ ...node(10, 31, 1), x: 200 }] },
  ]
  for (const mutate of mutations) {
    const value = input(), proof = new HostHistoryPresentationProof()
    assert.equal(proof.visible(value, true), true)
    mutate(value)
    assert.equal(proof.visible(value, true), false)
  }
})

test("footer arrows and their one-cell text can own hits without relying on the panel background", () => {
  const value = input(), arrow = { ...node(10, 32, 1), x: 155, width: 1 }
  value.footer!.getChildren = () => [arrow]
  value.hitTest = (_x, y) => y === value.heading!.y ? value.heading!.num : arrow.num
  assert.equal(new HostHistoryPresentationProof().visible(value, true), true)
})

test("restored gates still need new physical paint, not remembered history visibility", () => {
  const value = input(), proof = new HostHistoryPresentationProof()
  assert.equal(proof.visible(value, true), true)
  value.mode = "modal"
  assert.equal(proof.visible(value), false)
  value.mode = "base"
  assert.equal(proof.visible(value), false)
  assert.equal(proof.visible(value, true), true)
  value.mouse = false
  assert.equal(proof.visible(value), false)
  value.mouse = true
  assert.equal(proof.visible(value), false)
  assert.equal(proof.visible(value, true), true)
})

function browsing(value: HostHistoryProofInput) {
  const renderer = new EventEmitter(), layers: (() => KeymapLayer)[] = []
  const navigations: string[] = [], scrolls: [number, boolean][] = []
  const context = { renderer, keymap: { layer(factory: () => KeymapLayer) { layers.push(factory) } } } as unknown as Plugin.Context
  const owner = setupHostHistoryBrowsing(context, () => value, {
    navigate: direction => navigations.push(direction), scroll: (amount, page) => scrolls.push([amount, page]),
  })
  const layer = layers[0]!()
  const enabled = () => typeof layer.enabled === "function" ? layer.enabled() : layer.enabled !== false
  const press = (bind: string) => layer.commands!.find(command => command.bind === bind)!.run()
  return { renderer, owner, layer: { ...layer, enabled }, press, navigations, scrolls, dispose() { owner.dispose() } }
}

test("mouse-disabled history registered keys navigate and scroll only after a native FRAME", () => {
  const value = input()
  value.mouse = false
  value.hitTest = () => { throw new Error("mouse-disabled browsing must not manufacture or consult hit ownership") }
  const host = browsing(value)
  assert.equal(host.layer.mode, "base")
  assert.equal(host.layer.enabled!(), false, "mounted nodes alone do not own keyboard input")
  for (const bind of ["left", "right", "up", "down", "pageup", "pagedown"]) host.press(bind)
  assert.deepEqual(host.navigations, [])
  assert.deepEqual(host.scrolls, [])
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(host.layer.enabled!(), true)
  for (const bind of ["left", "right", "up", "down", "pageup", "pagedown"]) host.press(bind)
  assert.deepEqual(host.navigations, ["older", "newer"])
  assert.deepEqual(host.scrolls, [[-1, false], [1, false], [-1, true], [1, true]])
  assert.equal(value.mouse, false)
  host.dispose()
  assert.equal(host.layer.enabled!(), false)
  host.press("left"); host.press("down")
  assert.equal(host.navigations.length, 2)
  assert.equal(host.scrolls.length, 4)
  assert.equal(host.renderer.listenerCount(CliRenderEvents.FRAME), 0)
  assert.equal(host.renderer.listenerCount(CliRenderEvents.RESIZE), 0)
})

test("mouse-disabled registered history keys lose ownership on modal, route, native-sidebar and geometry changes", () => {
  const mutations: ((value: HostHistoryProofInput) => void)[] = [
    value => { value.mode = "modal" }, value => { value.route.sessionID = "child" },
    value => { value.route.type = "home" }, value => { value.root = "other" },
    value => { value.current = false }, value => { value.anchor!.sessionID = "child" },
    value => { value.anchor!.node.visible = false }, value => { value.anchor!.owner = Symbol() },
    value => { value.anchor!.node = { ...value.anchor!.node } }, value => { value.bounds = undefined },
    value => { value.bounds!.height-- }, value => { value.panel!.width-- },
    value => { value.heading!.y++ }, value => { value.footer!.height-- },
    value => { value.panel!.isDestroyed = true }, value => { value.width++ },
    value => { value.footer!.getChildren = () => [{ ...node(10, 31, 1), x: 200 }] },
  ]
  for (const mutate of mutations) {
    const value = input(); value.mouse = false
    const host = browsing(value)
    host.renderer.emit(CliRenderEvents.FRAME)
    assert.equal(host.layer.enabled!(), true)
    mutate(value)
    assert.equal(host.layer.enabled!(), false, "fresh ownership gates revoke input before another frame")
    host.press("left"); host.press("pagedown")
    assert.deepEqual(host.navigations, [])
    assert.deepEqual(host.scrolls, [])
    host.dispose()
  }
})

test("mouse-disabled keyboard ownership needs fresh FRAME after modal restoration, invalidation or resize", () => {
  const value = input(); value.mouse = false
  const host = browsing(value)
  host.renderer.emit(CliRenderEvents.FRAME)
  value.mode = "modal"
  assert.equal(host.layer.enabled!(), false)
  host.press("right"); host.press("up")
  value.mode = "base"
  assert.equal(host.layer.enabled!(), false)
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(host.layer.enabled!(), true)
  host.owner.invalidate()
  assert.equal(host.layer.enabled!(), false)
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(host.layer.enabled!(), true)
  host.renderer.emit(CliRenderEvents.RESIZE)
  host.press("right"); host.press("up")
  assert.equal(host.layer.enabled!(), false)
  assert.deepEqual(host.navigations, [])
  assert.deepEqual(host.scrolls, [])
  host.renderer.emit(CliRenderEvents.FRAME)
  host.press("right"); host.press("up")
  assert.deepEqual(host.navigations, ["newer"])
  assert.deepEqual(host.scrolls, [[-1, false]])
  host.dispose()
})

test("native frames under modal, descendant route or clipped geometry cannot enable history keys", () => {
  const mutations: ((value: HostHistoryProofInput) => void)[] = [
    value => { value.mode = "modal" }, value => { value.route.sessionID = "child" },
    value => { value.anchor!.node.visible = false }, value => { value.bounds = undefined },
    value => { value.panel!.x-- }, value => { value.footer!.y = value.height },
  ]
  for (const mutate of mutations) {
    const value = input(); value.mouse = false
    const host = browsing(value)
    host.renderer.emit(CliRenderEvents.FRAME)
    mutate(value)
    host.renderer.emit(CliRenderEvents.FRAME)
    assert.equal(host.layer.enabled!(), false)
    host.press("left"); host.press("down")
    assert.deepEqual(host.navigations, [])
    assert.deepEqual(host.scrolls, [])
    host.dispose()
  }
})

test("mouse-enabled history browsing requires strict heading/footer hits, not just keyboard geometry", () => {
  const value = input(), hits = value.hitTest
  value.hitTest = () => value.panel!.num
  const host = browsing(value)
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(host.layer.enabled!(), false, "mouse-enabled browsing still rejects known native covers")
  value.hitTest = hits
  assert.equal(host.layer.enabled!(), false, "restored hit ownership still needs real paint")
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(host.layer.enabled!(), true)
  value.mouse = false
  value.hitTest = () => { throw new Error("disabled hit grid must not become cover evidence") }
  host.renderer.emit(CliRenderEvents.FRAME)
  assert.equal(host.layer.enabled!(), true)
  host.dispose()
})

test("native statistics keeps loading and unavailable independent from aggregate totals", () => {
  const state: StatisticsState = { open: true, view: "lifetime", unavailable: false, ancestry: "none" }
  assert.equal(hostStatisticsMessage(state), "Loading recorded usage…")
  state.totals = empty()
  assert.equal(hostStatisticsMessage(state), lifetimeReport(state.totals))
  state.unavailable = true
  assert.equal(hostStatisticsMessage(state), "Lifetime usage unavailable. Recorded totals have not been reset.")
  state.view = "conversation"
  assert.equal(hostStatisticsMessage(state), "Select a conversation to see its statistics.")
  state.ancestry = "unavailable"
  assert.equal(hostStatisticsMessage(state), "Conversation statistics unavailable. Recorded totals have not been reset.")
  state.unavailable = false; state.ancestry = "loading"
  assert.equal(hostStatisticsMessage(state), "Loading recorded usage…")
  state.conversation = { totals: empty(), partialHistory: false }
  assert.equal(hostStatisticsMessage(state), "Loading recorded usage…", "cached totals do not prove ancestry")
  state.ancestry = "ready"
  assert.equal(hostStatisticsMessage(state), lifetimeReport(state.conversation.totals))
})

test("statistics palette opens the actual selected session and stale dialog closure cannot close a replacement", () => {
  let generation = 0, opened: string | undefined, enabled = true, closed = 0
  let route: { type: "session"; sessionID: string } | { type: "home" } = { type: "session", sessionID: "child" }
  const state: StatisticsState = { open: false, view: "lifetime", unavailable: false, ancestry: "none" }
  const controller = {
    open(session?: string) { opened = session; state.open = true; return ++generation },
    current(token: number) { return state.open && token === generation },
    close(token: number) { if (this.current(token)) { state.open = false; closed++ } },
  } as StatisticsController
  let factory: (() => KeymapLayer) | undefined
  const callbacks: (() => void)[] = []
  const context = { keymap: { layer(value: () => KeymapLayer) { factory = value } },
    ui: { router: { current: () => route }, dialog: { show(_render: unknown, close: () => void) { callbacks.push(close) } } },
  } as unknown as Plugin.Context
  const tracker = setupHostStatistics(context, controller, () => state, () => enabled)
  const command = factory!().commands![0]!
  assert.equal(command.id, "reviewer.lifetime")
  assert.equal(command.palette, true)
  command.run()
  assert.equal(opened, "child", "conversation ancestry belongs to the controller, not cached root guessing")
  assert.equal(callbacks.length, 1)
  tracker.open("root")
  callbacks[0]!()
  assert.equal(state.open, true)
  assert.equal(closed, 0)
  callbacks[1]!()
  assert.equal(state.open, false)
  assert.equal(closed, 1)
  route = { type: "home" }
  command.run()
  assert.equal(opened, undefined)
  enabled = false
  command.run()
  assert.equal(callbacks.length, 3)
  assert.equal(tracker.text(), undefined)
  state.unavailable = true
  assert.equal(tracker.text(), "lifetime: usage unavailable")
})
