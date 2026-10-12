import { createMemo, onCleanup } from "solid-js"
import { CodeRenderable, SyntaxStyle, type MarkdownRenderable, type Renderable } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin } from "@opencode/plugin/tui"
import { generateSyntax } from "@opencode/theme/tui"
import type { RGBA } from "@opentui/core"
import { displayText } from "./controller.js"
import { reviewSyntaxStyles } from "./appearance.js"
import { retireDefaultMarkdownStyle } from "./syntax-retirement.js"

function latestHighlights(node: Renderable | undefined): Promise<void>[] {
  if (!node) return []
  return [...(node instanceof CodeRenderable ? [node.highlightingDone] : []), ...node.getChildren().flatMap(latestHighlights)]
}

/** Owns default Markdown rendering; ref observes it, not custom async callback installation. */
export function ReviewDescription(props: { api: TuiPluginApi; text: string; streaming: boolean; ref?: (value: MarkdownRenderable) => void }) {
  return <DefaultReviewDescription text={props.text} streaming={props.streaming} ref={props.ref}
    syntax={() => SyntaxStyle.fromStyles(reviewSyntaxStyles(props.api.theme.current))} fg={props.api.theme.current.markdownText} />
}

/** V2 semantic tokens and syntax generation, without a legacy API adapter. */
export function HostReviewDescription(props: { context: Plugin.Context; text: string; streaming: boolean; ref?: (value: MarkdownRenderable) => void }) {
  return <DefaultReviewDescription text={props.text} streaming={props.streaming} ref={props.ref}
    syntax={() => generateSyntax(props.context.theme)} fg={props.context.theme.text.base} />
}

function DefaultReviewDescription(props: { text: string; streaming: boolean; syntax(): SyntaxStyle; fg: RGBA; ref?: (value: MarkdownRenderable) => void }) {
  let description: MarkdownRenderable | undefined
  const style = createMemo<SyntaxStyle>((previous) => {
    const syntax = props.syntax()
    if (previous) {
      const pending = latestHighlights(description)
      if (description && !description.isDestroyed) {
        description.syntaxStyle = syntax
        // The setter alone defers propagation to a future paint. Refresh through
        // the public API so even hidden descendants relinquish the old style.
        description.refreshStyles()
      }
      void retireDefaultMarkdownStyle(previous, pending)
    }
    return syntax
  })
  onCleanup(() => {
    const pending = latestHighlights(description)
    // End future readers before releasing the final style. OpenTUI destruction
    // is idempotent; the JSX owner may subsequently dispose the same tree.
    description?.destroyRecursively()
    void retireDefaultMarkdownStyle(style(), pending)
  })
  return <markdown ref={(value: MarkdownRenderable) => { description = value; props.ref?.(value) }} content={displayText(props.text)} syntaxStyle={style()} fg={props.fg} conceal={true} streaming={props.streaming} tableOptions={{ style: "grid" }} width="100%" flexShrink={0} />
}
