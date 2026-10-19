import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { CliRenderEvents, type TextareaRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { HostButton } from "./host-button.js"
import { TransportOwnership } from "./transport-ownership.js"
import { uiText } from "./ui-text.js"
import { withDeadline } from "./deadline.js"

export interface HostSessionInstructionsOptions {
  root(): string | undefined
  maxBytes: number
  read(root: string, signal: AbortSignal): Promise<string>
  write(root: string, text: string): Promise<void>
}

/** Undefined means oversized; the empty string is a valid saved value. */
export function sessionInstructionsText(text: string, limit: number): string | undefined {
  const trimmed = text.trim()
  return new TextEncoder().encode(trimmed).byteLength <= limit ? trimmed : undefined
}

interface Draft {
  root: string
  abort: AbortController
  ready(): boolean
  setReady(value: boolean): void
  saving(): boolean
  setSaving(value: boolean): void
  initial: string
}

function SessionInstructionsView(props: {
  context: Plugin.Context
  draft: Draft
  current(): boolean
  close(): void
  apply(text: string): void
  dismissed(): void
}) {
  const { context, draft } = props
  let input: TextareaRenderable | undefined
  const busy = () => !draft.ready() || draft.saving() || !props.current()
  const focus = () => { if (props.current() && input && !input.isDestroyed) input.focus() }
  const clear = () => { if (!busy()) { input?.setText(""); focus() } }
  const apply = () => { if (!busy() && input && !input.isDestroyed) props.apply(input.plainText) }
  const insert = (text: string) => { if (!busy()) { input?.insertText(text); focus() } }
  const extent = () => Math.max(1, Math.min(20, context.renderer.height - 8))
  const [height, setHeight] = createSignal(extent())
  const resize = () => setHeight(extent())
  context.renderer.on(CliRenderEvents.RESIZE, resize)
  onCleanup(() => { context.renderer.off(CliRenderEvents.RESIZE, resize); props.dismissed() })
  createEffect(() => {
    if (!draft.ready()) return
    // This read initializes exactly one draft, never a live metadata subscription.
    untrack(() => { if (props.current()) { input?.setText(draft.initial); focus() } })
  })
  context.keymap.layer(() => ({ priority: 110, mode: "modal", enabled: props.current, commands: [
    { bind: "escape", run: props.close },
    { bind: "ctrl+s", run: apply },
    { bind: "return", run: () => insert("\n") },
    { bind: "tab", run: () => insert("\t") },
  ] }))
  return <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={context.theme.text.base}><b>{uiText.sessionInstructions.title}</b></text>
      <HostButton context={context} label={uiText.sessionInstructions.close} run={props.close} />
    </box>
    <textarea id="reviewer.instructions.input" ref={(value: TextareaRenderable) => { input = value }} height={height()} minHeight={1}
      focused showCursor={!busy()} placeholder={uiText.sessionInstructions.placeholder}
      backgroundColor={context.theme.background.raised.base} focusedBackgroundColor={context.theme.background.raised.base}
      textColor={context.theme.text.base} focusedTextColor={context.theme.text.base} placeholderColor={context.theme.text.muted}
      cursorColor={context.theme.text.base} wrapMode="word"
      onKeyDown={event => { if (busy()) { event.preventDefault(); event.stopPropagation() } }}
      onPaste={event => { if (busy()) { event.preventDefault(); event.stopPropagation() } }} />
    <box flexDirection="row" justifyContent="flex-end" gap={1} flexShrink={0}>
      <HostButton context={context} label={uiText.sessionInstructions.clear} disabled={busy()} run={clear} />
      <HostButton context={context} label={uiText.sessionInstructions.apply} disabled={busy()} run={apply} />
    </box>
  </box>
}

/** Local draft UI only. Optional reads/writes retain physical settlement ownership
 * without becoming approval-critical lifecycle work. */
export function setupHostSessionInstructions(context: Plugin.Context,
  lifecycle: Pick<PluginLifecycle, "signal" | "addCleanup">, options: HostSessionInstructionsOptions) {
  const work = new TransportOwnership()
  let reads = 0
  const [active, setActive] = createSignal<Draft>()
  let stopped = false
  const selected = () => {
    if (stopped || lifecycle.signal.aborted) return
    const root = options.root(), route = context.ui.router.current()
    return root && route.type === "session" && route.sessionID === root ? root : undefined
  }
  const current = (draft: Draft) => active() === draft && selected() === draft.root
  const dismissed = (draft: Draft) => {
    draft.abort.abort()
    if (active() === draft) setActive(undefined)
  }
  const close = () => {
    const draft = active()
    if (!draft) return
    dismissed(draft)
    context.ui.dialog.clear()
  }
  const apply = (draft: Draft, text: string) => {
    if (!current(draft) || !draft.ready() || draft.saving()) return
    const normalized = sessionInstructionsText(text, options.maxBytes)
    if (normalized === undefined) {
      context.ui.toast.show({ message: uiText.sessionInstructions.tooLarge(options.maxBytes), variant: "error" })
      return
    }
    draft.setSaving(true)
    // Capture root/text before dispatch. Dismissal cannot redirect or repeat a save.
    void work.track(Promise.resolve().then(() => options.write(draft.root, normalized)).then(() => {
      if (current(draft)) close()
    }, () => {
      if (!current(draft)) return
      draft.setSaving(false)
      context.ui.toast.show({ message: uiText.sessionInstructions.saveFailed, variant: "error" })
    }))
  }
  const open = () => {
    const root = selected()
    if (!root || active()) return
    const [ready, setReady] = createSignal(false), [saving, setSaving] = createSignal(false)
    const draft: Draft = { root, abort: new AbortController(), ready, setReady, saving, setSaving, initial: "" }
    setActive(draft)
    context.ui.dialog.show(() => {
      context.ui.dialog.set({ size: "large", centered: true })
      return <SessionInstructionsView context={context} draft={draft} current={() => current(draft)} close={close}
        apply={text => apply(draft, text)} dismissed={() => dismissed(draft)} />
    }, () => dismissed(draft))
    const signal = AbortSignal.any([lifecycle.signal, draft.abort.signal])
    void work.track(withDeadline(signal, 5000, bounded => {
      if (reads >= 2) return Promise.resolve("")
      reads++
      const read = Promise.resolve().then(() => { bounded.throwIfAborted(); return options.read(root, bounded) })
      const release = () => { reads-- }
      void read.then(release, release)
      return work.track(read)
    }, "Session instructions lookup").catch(() => "").then(text => {
      if (!current(draft) || signal.aborted) return
      draft.initial = text
      draft.setReady(true)
    }))
  }
  // One public command owns discovery and its configurable default binding.
  // Base-mode ownership excludes Alt+i from native dialogs and other input modes.
  context.keymap.layer(() => ({ priority: 100, mode: "base", enabled: () => !!selected(), commands: [{
    id: "reviewer.instructions", title: uiText.commands.instructions, group: uiText.commands.category,
    palette: true, slash: { name: "reviewer-instructions" }, bind: "alt+i", run: open,
  }] }))
  createEffect(() => {
    const draft = active(), root = selected()
    if (draft && root !== draft.root) untrack(close)
  })
  const stop = () => { if (!stopped) { stopped = true; close() } }
  lifecycle.signal.addEventListener("abort", stop, { once: true })
  lifecycle.addCleanup(() => {
    lifecycle.signal.removeEventListener("abort", stop)
    stop()
    return work.settled()
  }, false)
  return { open, close, apply: (text: string) => { const draft = active(); if (draft) apply(draft, text) } }
}
