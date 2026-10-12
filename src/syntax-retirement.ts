/** Only the pinned default Markdown renderer, after synchronous handoff/destruction. */
export async function retireDefaultMarkdownStyle(style: { destroy(): void }, latestHighlights: readonly Promise<void>[]) {
  // OpenTUI's highlightingDone exposes only the latest transaction, not all
  // outstanding ones. This wait is conservative, not a general reader fence.
  // Default Markdown callbacks read styles synchronously. Older parser requests
  // check their revision/destruction before reading the current style; after
  // refreshStyles/destruction they cannot read the detached style. Replacing
  // onHighlight/onChunks/renderNode with custom async readers is unsupported.
  await Promise.allSettled(latestHighlights)
  style.destroy()
}
