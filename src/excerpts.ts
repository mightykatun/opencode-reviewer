import { reviewStage } from "./deadline.js"

export interface Excerpt {
  includedLines: number
  /** Absent when the bounded scan did not reach EOF. Never estimated from bytes. */
  totalLines?: number
}

export function missingLines(excerpt: Excerpt): string {
  return excerpt.totalLines === undefined ? "missing more lines (count unavailable: scan limit reached)"
    : `missing ${excerpt.totalLines - excerpt.includedLines} more lines`
}

/** Validate the numbered representation as well as its count metadata across
 * the companion boundary. Counts describe source/diff lines, not output lines. */
export function validExcerpt(value: unknown, contents: string): value is Excerpt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const excerpt = value as Excerpt
  if (Object.keys(value).some(key => key !== "includedLines" && key !== "totalLines")
    || !Number.isSafeInteger(excerpt.includedLines) || excerpt.includedLines <= 0 || excerpt.includedLines > 16384
    || (Object.hasOwn(value, "totalLines") && (!Number.isSafeInteger(excerpt.totalLines)
      || excerpt.totalLines! <= excerpt.includedLines))) return false
  const lines = contents.split("\n", 16386)
  if (lines.pop() !== missingLines(excerpt) || lines.length !== excerpt.includedLines) return false
  let previous = 0
  for (const line of lines) {
    const match = /^L([1-9]\d*): /.exec(line), number = Number(match?.[1])
    if (!match || !Number.isSafeInteger(number) || number <= previous
      || (excerpt.totalLines !== undefined && number > excerpt.totalLines)) return false
    previous = number
  }
  return true
}

type Line = { number: number; text?: string; score: number; bytes: number }
const worse = (a: Line, b: Line) => a.score < b.score || (a.score === b.score && a.number > b.number)

/** A bounded best-line sample, with nearby context and explicit original line
 * numbers. Selection is relevance guidance, never an assessment of omitted text.
 * Complete inputs bypass this helper and remain byte-for-byte unchanged. */
export class LineExcerpt {
  private heap: Line[] = []
  private recent: Line[] = []
  private bytes = 0
  private lines = 0
  private context = 0
  private allowance: number
  constructor(readonly budget: number, private kind: "source" | "diff") {
    // Reserve the largest possible numeric footer, or the explicit unknown count.
    this.allowance = Math.max(0, budget - 80)
  }
  add(text?: string) {
    const number = ++this.lines
    const important = text !== undefined && (this.kind === "diff"
      ? /^@@ |^[+-](?!\+\+|--)/.test(text)
      : /^(?:#!|\s*(?:(?:async\s+)?def\s|class\s|function\s|import\s|from\s|if\s+__name__\s*==|[\w]+\s*\(\)\s*\{))/.test(text))
    if (important) {
      this.context = 3
      for (const line of this.recent.slice(-2)) line.score = Math.max(line.score, 3)
    }
    const score = this.kind === "diff" && text?.startsWith("@@ ") ? 5 : important ? 4 : this.context-- > 0 || number <= 4 ? 3
      : text?.trim() && !/^\s*#/.test(text) ? 2 : 1
    // Count the numbered representation, not just source bytes.
    const bytes = text === undefined ? Infinity : Buffer.byteLength(`L${number}: ${text}\n`)
    this.recent.push({ number, text: bytes <= this.allowance ? text : undefined, score, bytes })
    if (this.recent.length > 4) this.keep(this.recent.shift()!)
  }
  private keep(line: Line) {
    if (line.text === undefined) return
    this.bytes += line.bytes
    let index = this.heap.length
    this.heap.push(line)
    while (index) {
      const parent = (index - 1) >>> 1
      if (!worse(line, this.heap[parent]!)) break
      this.heap[index] = this.heap[parent]!; index = parent
    }
    this.heap[index] = line
    while (this.bytes > this.allowance || this.heap.length > 16384) {
      this.bytes -= this.heap[0]!.bytes
      const last = this.heap.pop()!
      if (!this.heap.length) break
      let index = 0
      while (index * 2 + 1 < this.heap.length) {
        let child = index * 2 + 1
        if (child + 1 < this.heap.length && worse(this.heap[child + 1]!, this.heap[child]!)) child++
        if (!worse(this.heap[child]!, last)) break
        this.heap[index] = this.heap[child]!; index = child
      }
      this.heap[index] = last
    }
  }
  finish(complete: boolean): { contents: string; excerpt: Excerpt } | undefined {
    for (const line of this.recent) { line.score = Math.max(line.score, 3); this.keep(line) }
    this.recent = []
    if (!this.heap.length) return
    const excerpt: Excerpt = { includedLines: this.heap.length, ...(complete ? { totalLines: this.lines } : {}) }
    const contents = this.heap.sort((a, b) => a.number - b.number).map(line => `L${line.number}: ${line.text}\n`).join("")
      + missingLines(excerpt)
    return { contents, excerpt }
  }
}

/** Stream complete lines without retaining a single oversized line. LF and CRLF
 * count identically; a final unterminated line counts once, a trailing LF does not
 * create a phantom empty line. UTF-8 validation belongs to the file reader. */
export class ExcerptLines {
  private text = ""
  private bytes = 0
  private hasLine = false
  private oversized = false
  constructor(private sample: LineExcerpt) {}
  push(chunk: string) {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf("\n", start)
      const part = chunk.slice(start, newline < 0 ? chunk.length : newline)
      this.hasLine = true
      if (!this.oversized) {
        this.bytes += Buffer.byteLength(part)
        if (this.bytes > this.sample.budget) { this.oversized = true; this.text = "" }
        else this.text += part
      }
      if (newline < 0) break
      this.flush()
      start = newline + 1
    }
  }
  private flush() {
    this.sample.add(this.oversized ? undefined : this.text)
    this.text = ""; this.bytes = 0; this.oversized = false; this.hasLine = false
  }
  finish(complete: boolean) {
    if (complete && this.hasLine) this.flush()
    return this.sample.finish(complete)
  }
}

export const excerptScanBytes = 16 * 1024 * 1024

/** Native diffs already exist in memory. Copy only selected complete lines and
 * keep each original hunk header/line number rather than inventing a new patch. */
export function diffExcerpt(text: string, budget: number, signal: AbortSignal) {
  if (budget <= 80) return
  const lines = new ExcerptLines(new LineExcerpt(budget, "diff"))
  const end = Math.min(text.length, excerptScanBytes)
  for (let start = 0; start < end;) {
    reviewStage(signal, "Evidence collection")
    let next = Math.min(start + 16384, end)
    // Do not split a UTF-16 surrogate pair across UTF-8 byte accounting chunks.
    if (next < end && /[\uD800-\uDBFF]/.test(text[next - 1]!)) next--
    lines.push(text.slice(start, next))
    start = next
  }
  return lines.finish(end === text.length)
}
