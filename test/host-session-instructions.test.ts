import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { sessionInstructionsText, setupHostSessionInstructions } from "../src/host-session-instructions.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import { uiText } from "../src/ui-text.js"
import { setImmediate as settle } from "node:timers/promises"
import type { KeyEvent } from "@opentui/core"

test("session instructions trim before measuring UTF-8 and preserve empty saves", () => {
  assert.equal(sessionInstructionsText(" \n\t ", 0), "")
  assert.equal(sessionInstructionsText("  é\t🙂\n ", 7), "é\t🙂")
  assert.equal(sessionInstructionsText("é\t🙂", 6), undefined)
  assert.equal(sessionInstructionsText("a\nb\tc", 5), "a\nb\tc")
  assert.equal(uiText.sessionInstructions.saveFailed, "Session instructions could not be saved.")
  assert.equal(uiText.sessionInstructions.tooLarge(64), "Session instructions exceed maxEvidenceBytes (64 bytes).")
})

function fixture(read: (root: string, signal: AbortSignal) => Promise<string>,
  write: (root: string, text: string) => Promise<void> = async () => { throw Error("unexpected write") }) {
  const life = new PluginLifecycle()
  let route: { type: "session"; sessionID: string } | { type: "home" } = { type: "session", sessionID: "root" }
  let root: string | undefined = "root", layer!: () => KeymapLayer, clears = 0, mode = "base"
  const closes: (() => void)[] = [], reads: string[] = [], signals: AbortSignal[] = [], toasts: string[] = []
  const context = {
    keymap: { mode: { current: () => mode }, layer(factory: () => KeymapLayer) { layer = factory } },
    ui: { toast: { show: (value: { message: string }) => toasts.push(value.message) }, router: { current: () => route }, dialog: {
      show(_render: unknown, close: () => void) { closes.push(close) },
      clear() { clears++; closes.at(-1)?.() },
    } },
  } as unknown as Plugin.Context
  const ui = setupHostSessionInstructions(context, life, { root: () => root, maxBytes: 1024,
    read(id, signal) { reads.push(id); signals.push(signal); return read(id, signal) },
    write,
  })
  return { life, ui, closes, reads, signals, toasts, layer: () => layer(), clears: () => clears,
    route(value: typeof route) { route = value }, root(value: string | undefined) { root = value }, mode(value: string) { mode = value } }
}

test("global discovery remains visible in the modal palette while the configurable shortcut is base-only", async () => {
  const host = fixture(async () => "saved")
  const layer = host.layer(), command = layer.commands![0]!
  assert.equal(layer.mode, "global")
  assert.equal(command.id, "reviewer.instructions")
  assert.equal(command.bind, "alt+i")
  assert.equal(command.title, "Reviewer: Session instructions")
  assert.equal(command.palette, true)
  assert.deepEqual(command.slash, { name: "reviewer-instructions" })
  host.mode("modal")
  assert.equal(command.run(undefined, {} as KeyEvent), false)
  assert.equal(host.closes.length, 0)
  host.mode("base")
  host.route({ type: "session", sessionID: "child" })
  assert.equal((layer.enabled as () => boolean)(), false)
  command.run()
  assert.equal(host.closes.length, 0)
  host.route({ type: "home" })
  command.run()
  assert.equal(host.closes.length, 0)
  host.route({ type: "session", sessionID: "root" })
  host.root(undefined)
  command.run()
  assert.equal(host.closes.length, 0)
  host.root("root")
  command.run()
  command.run()
  await settle()
  assert.deepEqual(host.reads, ["root"])
  assert.equal(host.closes.length, 1, "an existing draft is not replaced or reread")
  await host.life.stop()
  assert.equal(host.signals[0]!.aborted, true)
  assert.equal(host.clears(), 1)
})

test("dismissed reads stay physically owned but never delay critical approval cleanup", async () => {
  const completions: ((text: string) => void)[] = []
  const host = fixture(() => new Promise(resolve => { completions.push(resolve) }))
  host.ui.open()
  await settle()
  host.ui.close()
  assert.equal(host.signals[0]!.aborted, true)
  host.ui.open()
  // A stale native dialog's disposal cannot discard the replacement draft.
  host.closes[0]!()
  await settle()
  assert.equal(host.closes.length, 2)
  const stopping = host.life.stop()
  await host.life.criticalSettled()
  let settled = false
  void host.life.settled().then(() => { settled = true })
  await settle()
  assert.equal(settled, false)
  completions.forEach(complete => complete("late"))
  await stopping
  await host.life.settled()
  assert.equal(settled, true)
  assert.equal(host.clears(), 2)
})

test("late read failures after disposal settle silently and release optional ownership", async () => {
  let reject!: (error: Error) => void
  const host = fixture(() => new Promise((_resolve, fail) => { reject = fail }))
  host.ui.open()
  await settle()
  const stopping = host.life.stop()
  await host.life.criticalSettled()
  reject(Error("unreadable"))
  await stopping
  await host.life.settled()
  assert.equal(host.signals[0]!.aborted, true)
  assert.equal(host.clears(), 1)
})

test("dismissal does not free unresolved read capacity", async () => {
  const completions: ((text: string) => void)[] = []
  const host = fixture(() => new Promise(resolve => completions.push(resolve)))
  for (let i = 0; i < 3; i++) { host.ui.open(); await settle(); host.ui.close() }
  assert.equal(completions.length, 2)
  completions.forEach(resolve => resolve("late"))
  await settle()
  host.ui.open()
  await settle()
  assert.equal(completions.length, 3)
  completions[2]!("")
  await host.life.stop()
})

test("Apply failures retain the current draft, reject oversize text, and allow a later successful save", async () => {
  const writes: string[] = []
  let fail = true
  const host = fixture(async () => "saved", async (root, text) => {
    assert.equal(root, "root"); writes.push(text); if (fail) throw Error("private error")
  })
  host.ui.open(); await settle()
  host.ui.apply("x".repeat(1025)); await settle()
  assert.deepEqual(host.toasts, ["Session instructions exceed maxEvidenceBytes (1024 bytes)."])
  assert.equal(writes.length, 0); assert.equal(host.clears(), 0)
  host.ui.apply("  replacement\n"); await settle()
  assert.deepEqual(writes, ["replacement"])
  assert.equal(host.clears(), 0)
  assert.equal(host.toasts.at(-1), "Session instructions could not be saved.")
  fail = false
  host.ui.apply("  \n\t"); await settle()
  assert.deepEqual(writes, ["replacement", ""])
  assert.equal(host.clears(), 1)
  await host.life.stop()
})

for (const fail of [false, true]) test(`dismissed ${fail ? "failed" : "successful"} Apply cannot affect a replacement editor`, async () => {
  let finish!: () => void
  let writes = 0
  const host = fixture(async () => "saved", () => {
    writes++
    return new Promise<void>((resolve, reject) => { finish = () => fail ? reject(Error("late failure")) : resolve() })
  })
  host.ui.open(); await settle()
  host.ui.apply("submitted")
  host.ui.apply("duplicate")
  await settle()
  assert.equal(writes, 1, "pending Apply is single-flight")
  host.ui.close(); host.ui.open(); await settle()
  const clears = host.clears()
  finish(); await settle()
  assert.equal(host.clears(), clears, "late completion does not dismiss the replacement")
  assert.deepEqual(host.toasts, [], "late completion has no UI effects")
  host.ui.close(); await host.life.stop()
})
