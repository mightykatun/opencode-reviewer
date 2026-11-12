import type { Assessment, AssessmentPreview } from "./types.js"

export const MAX_ASSESSMENT_BYTES = 65536
export class AssessmentFormatError extends Error {}

type State = "start" | "first-key" | "key" | "key-string" | "colon" | "value" | "literal" | "value-string" | "after-value" | "done"
type TextField = "reason" | "desc" | "steering"
const whitespace = (char: string) => char === " " || char === "\t" || char === "\r" || char === "\n"
const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }

/** Single-pass lexer for the fixed verdict contract: safe, reason and desc, plus an
 * steering when enabled and Unsafe. Safe may omit steering or return null. Syntax failures are retained
 * until finish(), so transport can still consume terminal usage. Resource limits fail
 * immediately. Previews contain decoded Unicode scalar prefixes, never unfinished
 * escapes/surrogates, and mark reason/steering complete only after their closing token.
 */
export class StreamingAssessment {
  constructor(private options: { steering?: boolean } = {}) {}
  private state: State = "start"
  private error?: AssessmentFormatError
  private parts: string[] = []
  private bytes = 0
  private byteHigh = false
  private fields = new Set<string>()
  private key = ""
  private text = ""
  private escaped = false
  private unicode: string | undefined
  private high = ""
  private literal = ""
  private literalIndex = 0
  private value: Omit<AssessmentPreview, "steering"> & { steering?: string | null } = {}

  get content(): string { return this.parts.join("") }
  preview(): AssessmentPreview | undefined {
    if (this.error) return undefined
    const { steering, ...rest } = this.value
    return { ...rest, ...(typeof steering === "string" ? { steering } : {}) }
  }

  push(chunk: string): void {
    // Account for a literal surrogate pair split between content deltas without counting it twice.
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i)
      this.bytes += this.byteHigh && code >= 0xdc00 && code <= 0xdfff ? 1 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3
      this.byteHigh = code >= 0xd800 && code <= 0xdbff
      if (this.bytes > MAX_ASSESSMENT_BYTES) throw new Error("Reviewer assessment exceeds 64 KiB")
      if (this.error) continue
      try { this.character(chunk[i]!) }
      catch (error) {
        if (!(error instanceof AssessmentFormatError)) throw error
        this.error = error
      }
    }
    if (chunk) this.parts.push(chunk)
  }

  finish(): Assessment {
    if (this.error) throw this.error
    if (this.state !== "done") throw new AssessmentFormatError("Invalid JSON")
    if (!this.fields.has("safe") || !this.fields.has("reason") || !this.fields.has("desc")
      || typeof this.value.safe !== "boolean" || !this.value.reason?.trim() || !this.value.desc?.trim()) {
      throw new AssessmentFormatError("Invalid assessment fields or types")
    }
    // Unsafe steering-mode verdicts need actionable text. Safe ignores steering.
    const steering = !this.value.safe && typeof this.value.steering === "string" ? this.value.steering.trim() : ""
    if (this.options.steering && !this.value.safe && !steering)
      throw new AssessmentFormatError("Unsafe assessments require nonempty steering when steering is enabled")
    return { safe: this.value.safe, reason: this.value.reason.trim(), desc: this.value.desc.trim(), ...(steering ? { steering } : {}) }
  }

  private invalid(): never { throw new AssessmentFormatError("Invalid JSON") }
  private schema(): never { throw new AssessmentFormatError("Invalid assessment fields or types") }

  private decoded(char: string): void {
    const code = char.charCodeAt(0)
    if (this.high) {
      if (code < 0xdc00 || code > 0xdfff) this.invalid()
      this.text += this.high + char
      this.high = ""
    } else if (code >= 0xd800 && code <= 0xdbff) {
      this.high = char
      return
    } else {
      if (code >= 0xdc00 && code <= 0xdfff) this.invalid()
      this.text += char
    }
    if (this.state === "value-string") this.value[this.key as TextField] = this.text
  }

  private string(char: string): void {
    if (this.unicode !== undefined) {
      if (!/^[0-9a-fA-F]$/.test(char)) this.invalid()
      this.unicode += char
      if (this.unicode.length === 4) {
        this.decoded(String.fromCharCode(parseInt(this.unicode, 16)))
        this.unicode = undefined
      }
    } else if (this.escaped) {
      this.escaped = false
      if (char === "u") this.unicode = ""
      else if (Object.hasOwn(escapes, char)) this.decoded(escapes[char]!)
      else this.invalid()
    } else if (char === "\\") this.escaped = true
    else if (char === '"') {
      if (this.high) this.invalid()
      if (this.state === "key-string") {
        if (this.fields.has(this.text)) throw new AssessmentFormatError("Duplicate assessment field")
        if (!["safe", "reason", "desc", ...(this.options.steering ? ["steering"] : [])].includes(this.text)) this.schema()
        this.key = this.text
        this.fields.add(this.key)
        this.state = "colon"
      } else {
        if (this.key === "reason") this.value.reasonComplete = true
        if (this.key === "steering") this.value.steeringComplete = true
        this.state = "after-value"
      }
    } else {
      if (char.charCodeAt(0) < 0x20) this.invalid()
      this.decoded(char)
    }
  }

  private character(char: string): void {
    if (this.state === "key-string" || this.state === "value-string") { this.string(char); return }
    if (this.state === "literal") {
      if (this.literalIndex < this.literal.length) {
        if (char !== this.literal[this.literalIndex++]) this.invalid()
        return
      }
      // A complete spelling alone is not a token boundary (truex must never preview Safe).
      if (!whitespace(char) && char !== "," && char !== "}") this.invalid()
      if (this.literal === "null") { this.value.steering = null; this.value.steeringComplete = true }
      else this.value.safe = this.literal === "true"
      this.state = "after-value"
    }
    if (whitespace(char)) return
    switch (this.state) {
      case "start":
        if (char !== "{") this.invalid()
        this.state = "first-key"
        return
      case "first-key":
        if (char === "}") { this.state = "done"; return }
        // Fall through: a trailing comma uses key, which cannot accept a closing brace.
      case "key":
        if (char !== '"') this.invalid()
        this.text = ""
        this.state = "key-string"
        return
      case "colon":
        if (char !== ":") this.invalid()
        this.state = "value"
        return
      case "value":
        if (this.key === "safe" || (this.key === "steering" && char === "n")) {
          if (this.key === "safe" ? char !== "t" && char !== "f" : char !== "n") this.schema()
          this.literal = char === "t" ? "true" : char === "f" ? "false" : "null"
          this.literalIndex = 1
          this.state = "literal"
        } else {
          if (char !== '"') this.schema()
          this.text = ""
          this.value[this.key as TextField] = ""
          this.state = "value-string"
        }
        return
      case "after-value":
        if (char === ",") this.state = "key"
        else if (char === "}") this.state = "done"
        else this.invalid()
        return
      default: this.invalid()
    }
  }
}
