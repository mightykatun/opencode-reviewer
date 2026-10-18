import stringWidth from "string-width"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Preserve metadata rows, shortening only their display, in terminal cells. */
export function metadataText(text: string, width: number): string {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  return text.split("\n").map(line => {
    line = line.replace(/\t/g, " ")
    if (stringWidth(line) <= columns) return line
    const suffix = "..".slice(0, columns)
    let used = 0, end = 0
    for (const { segment, index } of graphemes.segment(line)) {
      const size = stringWidth(segment)
      if (used + size > columns - suffix.length) break
      used += size; end = index + segment.length
    }
    return line.slice(0, end) + suffix
  }).join("\n")
}
