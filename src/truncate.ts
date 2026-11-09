/** Number of lines: LF/CRLF terminate a line, a final unterminated line counts once
 * and a trailing LF does not create an empty line. */
export function lineCount(text: string, check?: () => void): number {
  if (!text) return 0
  let count = 0
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    if (!(count & 4095)) check?.()
    count++
  }
  return text.endsWith("\n") ? count : count + 1
}

/** Byte-faithful leading complete lines within a UTF-8 budget. Never splits a line. */
export function leadingLines(text: string, budget: number, check?: () => void): { text: string; lines: number; bytes: number } {
  let end = 0, bytes = 0, lines = 0
  while (end < text.length) {
    if (!(lines & 4095)) check?.()
    const newline = text.indexOf("\n", end)
    const stop = newline < 0 ? text.length : newline + 1
    const size = Buffer.byteLength(text.slice(end, stop))
    if (bytes + size > budget) break
    bytes += size; lines++; end = stop
  }
  return { text: text.slice(0, end), lines, bytes }
}
