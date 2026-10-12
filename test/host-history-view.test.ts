import assert from "node:assert/strict"
import { test } from "node:test"
import { HostHistoryPresentationProof, setupHostHistoryCover, type HostHistoryProofInput } from "../src/host-history-view.js"
import type { HostPanelNode } from "../src/host-review-panel.js"
import { HistoryCover } from "../src/history-cover.js"
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

test("native history cover needs its own painted heading/footer and measured sidebar frame", () => {
  const value = input(), proof = new HostHistoryPresentationProof(), cover = new HistoryCover()
  const release = cover.mount("root", hit => proof.visible(value) && [value.heading!.num, value.footer!.num].includes(hit))
  assert.equal(proof.visible(value), false)
  assert.equal(cover.covers("root", [2, 3]), false, "logical open cannot cover")
  assert.equal(proof.visible(value, true), true)
  assert.equal(cover.covers("root", [2, 3]), true)
  assert.equal(cover.covers("child", [2, 3]), false)
  assert.equal(cover.covers("root", [2, 999]), false)
  release(); cover.frame()
  assert.equal(cover.covers("root", [2, 3]), false, "old owner cannot survive a new frame")
})

test("history close retains only exact same-frame hits; the persistent reset expires them without an overlay", () => {
  const renderer = new EventEmitter(), cover = new HistoryCover()
  const stop = setupHostHistoryCover({ renderer } as unknown as Plugin.Context, cover)
  const release = cover.mount("root", hit => hit === 2 || hit === 3)
  assert.equal(cover.covers("root", [2, 3]), true)
  release()
  assert.equal(cover.covers("root", [2, 3]), true)
  assert.equal(cover.covers("root", [2, 4]), false)
  renderer.emit(CliRenderEvents.FRAME)
  assert.equal(cover.covers("root", [2, 3]), false)
  stop()
  assert.equal(renderer.listenerCount(CliRenderEvents.FRAME), 0)
})

test("persistent native FRAME refreshes history proof before live listeners without granting paint during invalidation", () => {
  const renderer = new EventEmitter(), value = input(), proof = new HostHistoryPresentationProof(), cover = new HistoryCover()
  const stop = setupHostHistoryCover({ renderer } as unknown as Plugin.Context, cover)
  let frames = 0
  const release = cover.mount("root", hit => proof.visible(value) && [2, 3].includes(hit), () => { frames++; proof.visible(value, true) })
  const observations: boolean[] = []
  renderer.on(CliRenderEvents.FRAME, () => observations.push(cover.covers("root", [2, 3])))
  cover.frame()
  assert.equal(frames, 0)
  assert.equal(cover.covers("root", [2, 3]), false)
  renderer.emit(CliRenderEvents.FRAME)
  assert.deepEqual(observations, [true])
  value.mode = "modal"
  renderer.emit(CliRenderEvents.FRAME)
  assert.deepEqual(observations, [true, false], "Current native modal cannot inherit earlier proof")
  value.mode = "base"
  proof.invalidate(); cover.frame()
  assert.equal(cover.covers("root", [2, 3]), false, "Restored logical gates need a genuine new FRAME")
  renderer.emit(CliRenderEvents.FRAME)
  assert.deepEqual(observations, [true, false, true])
  release(); stop()
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
