import { createMemo, createSignal } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { displayText } from "./controller.js"
import { metadataText } from "./metadata-text.js"

/** Text nodes do not forward size callbacks. Measure their padding-free container. */
export function HostReviewMetadata(props: { context: Plugin.Context; id: string; text: string; marginTop?: number }) {
  const [width, setWidth] = createSignal(0)
  const text = createMemo(() => displayText(props.text))
  return <box ref={(node: BoxRenderable) => setWidth(node.width)}
    onSizeChange={function() { setWidth(this.width) }}
    marginTop={props.marginTop} width="100%" minWidth={0} flexShrink={0}>
    <text id={props.id} fg={props.context.theme.text.muted} width="100%" minWidth={0}
      height={text().split("\n").length} flexShrink={0} wrapMode="none">{metadataText(text(), width())}</text>
  </box>
}
