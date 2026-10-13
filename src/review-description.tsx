import { createMemo, onCleanup } from "solid-js"
import { CodeRenderable, type SyntaxStyle, type MarkdownRenderable, type Renderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { generateSyntax } from "@opencode/theme/tui"
import { displayText } from "./controller.js"
import { retireDefaultMarkdownStyle } from "./syntax-retirement.js"

function latestHighlights(node: Renderable | undefined): Promise<void>[] {
  if (!node) return []
  return [...(node instanceof CodeRenderable ? [node.highlightingDone] : []), ...node.getChildren().flatMap(latestHighlights)]
}

/** Public host semantic tokens and syntax generation; ref only observes Markdown. */
export function HostReviewDescription(props: { context: Plugin.Context; text: string; streaming: boolean; ref?: (value: MarkdownRenderable) => void }) {
  let description: MarkdownRenderable | undefined
  const style = createMemo<SyntaxStyle>((previous) => {
    const syntax = generateSyntax(props.context.theme)
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
  return <markdown ref={(value: MarkdownRenderable) => { description = value; props.ref?.(value) }} content={displayText(props.text)} syntaxStyle={style()} fg={props.context.theme.text.base} conceal={true} streaming={props.streaming} tableOptions={{ style: "grid" }} width="100%" flexShrink={0} />
}
