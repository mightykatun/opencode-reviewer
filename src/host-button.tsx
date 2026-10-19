import { createSignal } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"

/** Mouse-only themed action, shared with history without adding focus stops. */
export function HostButton(props: { context: Plugin.Context; label: string; disabled?: boolean; run(): void }) {
  const [hover, setHover] = createSignal(false)
  return <box paddingLeft={1} paddingRight={1} flexShrink={0}
    backgroundColor={hover() && !props.disabled ? props.context.theme.background.action.primary.focused : props.context.theme.background.raised.high}
    onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}
    onMouseUp={event => { event.stopPropagation(); if (event.button === 0 && !props.disabled) props.run() }}>
    <text fg={props.disabled ? props.context.theme.text.muted : hover() ? props.context.theme.text.action.primary.focused : props.context.theme.text.base}>{props.label}</text>
  </box>
}
