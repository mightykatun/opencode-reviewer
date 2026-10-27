import { parse } from "shell-quote"

export const UNRESOLVED = "\u0000UNRESOLVED_VARIABLE\u0000"

export type ShellToken =
  | { kind: "word"; value: string; nested: string[] }
  | { kind: "op"; value: string }
  | { kind: "redirect"; operator: string; target?: string; body?: string; quoted?: boolean; nested?: string[] }

const LIMIT = 64 * 1024
const TOKEN_LIMIT = 65536
const unsupported = {
  syntax: "Unsupported or ambiguous shell syntax; structured shell discovery is unavailable.",
  quote: "Unclosed shell quoting or substitution; structured shell discovery is unavailable.",
  whitespace: "Unsupported unquoted shell whitespace; structured shell discovery is unavailable.",
  ansi: "ANSI-C shell quoting is outside byte-faithful literal discovery.",
  glob: "Unquoted bracket glob or brace syntax is outside literal discovery.",
  hash: "Unquoted # within a shell word is outside reliable tokenization.",
  heredoc: "Unclosed or unresolved heredoc delimiter; structured shell discovery is unavailable.",
  limit: "Structured shell discovery exceeded its input or token limit.",
} as const

class StructureError extends Error {}

/** Only lexical structure is observed here; no substitutions are evaluated. */
export function shellStructure(command: string, check: () => void): { tokens: ShellToken[]; limitations: string[] } {
  const tokens: ShellToken[] = []
  let ticks = 0
  const tick = () => { if (!(ticks++ % 4096)) check() }
  const fail = (reason: string): never => { throw new StructureError(reason) }
  try {
    check()
    if (command.length > LIMIT || Buffer.byteLength(command) > LIMIT) fail(unsupported.limit)
    if (command.includes("\u0000")) fail(unsupported.syntax)
    let i = 0
    let raw = ""
    let nested: string[] = []
    let quote = ""
    let pending: Array<{ index: number; delimiter: string; stripTabs: boolean }> = []
    const emit = (token: ShellToken) => {
      if (tokens.length >= TOKEN_LIMIT) fail(unsupported.limit)
      tokens.push(token)
    }

    // Capture the *source*, not the output, of a substitution. Parentheses in
    // quoted strings and in nested substitutions must not close its outer pair.
    const backtickEnd = (at: number): number => {
      let innerQuote = ""
      for (let j = at + 1; j < command.length; j++) {
        tick()
        if (command[j] === "\\") { j++; continue }
        if (command[j] === "$" && command[j + 1] === "'" && !innerQuote) fail(unsupported.ansi)
        if (command[j] === "'" || command[j] === '"') {
          if (!innerQuote) innerQuote = command[j]!
          else if (innerQuote === command[j]) innerQuote = ""
        }
        if (command[j] === "`") {
          if (innerQuote) fail(unsupported.syntax)
          return j
        }
      }
      return fail(unsupported.quote)
    }
    const substitutionEnd = (at: number): number => {
      const stack: Array<{ depth: number; quote: string }> = [{ depth: 1, quote: "" }]
      for (let j = at + 2; j < command.length; j++) {
        tick()
        const c = command[j]!
        const current = stack[stack.length - 1]!
        if (c === "\\" && current.quote !== "'") { j++; continue }
        if (current.quote === "'") { if (c === "'") current.quote = ""; continue }
        if (c === "`") { j = backtickEnd(j); continue }
        if (c === "$" && command[j + 1] === "(") {
          if (command[j + 2] === "(") fail(unsupported.syntax)
          stack.push({ depth: 1, quote: "" }); j++; continue
        }
        // A parameter expansion can contain quoted ) or operators. A
        // premature close would turn its suffix into fabricated commands.
        if (c === "$" && command[j + 1] === "{") fail(unsupported.syntax)
        if (!current.quote && c === "$" && command[j + 1] === "'") fail(unsupported.ansi)
        // A comment inside command substitution can hide its closing parenthesis.
        // Its source is opaque here, so do not guess where it ends.
        if (!current.quote && c === "#") fail(unsupported.syntax)
        if (current.quote === '"') { if (c === '"') current.quote = ""; continue }
        if (c === "'" || c === '"') { current.quote = c; continue }
        if (c === "(") current.depth++
        if (c === ")" && --current.depth === 0) {
          stack.pop()
          if (!stack.length) return j
        }
      }
      return fail(unsupported.quote)
    }
    const parameterEnd = (at: number): number => {
      let depth = 1
      for (let j = at + 2; j < command.length; j++) {
        tick()
        if (command[j] === "\\") { j++; continue }
        if (command[j] === "$" && command[j + 1] === "'") fail(unsupported.ansi)
        if (command[j] === "$" && command[j + 1] === "(") {
          if (command[j + 2] === "(") fail(unsupported.syntax)
          const end = substitutionEnd(j)
          nested.push(command.slice(j + 2, end))
          j = end; continue
        }
        if (command[j] === "`") {
          const end = backtickEnd(j)
          nested.push(command.slice(j + 1, end))
          j = end; continue
        }
        if (command[j] === "$" && command[j + 1] === "{") { depth++; j++; continue }
        if (command[j] === "'" || command[j] === '"') fail(unsupported.syntax)
        if (command[j] === "}" && --depth === 0) return j
      }
      return fail(unsupported.quote)
    }
    const decoded = (source: string): string => {
      let result: ReturnType<typeof parse>
      try { result = parse(source, () => UNRESOLVED) }
      catch { return fail(unsupported.syntax) }
      if (result.length !== 1) fail(unsupported.syntax)
      const value = result[0]
      if (typeof value === "string") return value
      if (value && "op" in value && value.op === "glob") return UNRESOLVED
      return fail(unsupported.syntax)
    }
    const flush = () => {
      if (!raw) return
      emit({ kind: "word", value: decoded(raw), nested })
      raw = ""; nested = []
    }
    const space = (c: string) => c === " " || c === "\t" || c === "\n"
    const boundary = (c: string | undefined) => c === undefined || space(c) || ";&|()<>".includes(c)
    // Consume the body only after the opening line ends. All queued heredocs
    // own consecutive bodies, including text that looks like shell statements.
    const bodies = () => {
      for (const item of pending) {
        const start = i
        let closed = false
        while (i < command.length) {
          let lineEnd = i
          while (lineEnd < command.length && command[lineEnd] !== "\n") { tick(); lineEnd++ }
          const end = lineEnd === command.length ? -1 : lineEnd
          const line = command.slice(i, lineEnd)
          if ((item.stripTabs ? line.replace(/^\t+/, "") : line) === item.delimiter) {
            (tokens[item.index] as Extract<ShellToken, { kind: "redirect" }>).body = command.slice(start, i)
            i = end < 0 ? command.length : end + 1
            closed = true
            break
          }
          if (end < 0) break
          i = end + 1
        }
        if (!closed) fail(unsupported.heredoc)
      }
      pending = []
    }
    const redirect = (operator: string) => {
      // An IO number is only a wholly unquoted, adjacent decimal word.
      if (/^[0-9]+$/.test(raw)) { operator = raw + operator; raw = ""; nested = [] }
      else flush()
      while (i < command.length && (command[i] === " " || command[i] === "\t")) { tick(); i++ }
      if (i >= command.length || boundary(command[i]) || command[i] === "#") fail(unsupported.syntax)
      const start = tokens.length
      const before = i
      word()
      if (!raw) fail(unsupported.syntax)
      const target = decoded(raw)
      const quoted = /['"\\]/.test(command.slice(before, i))
      emit({ kind: "redirect", operator, target, ...(operator.includes("<<") ? { quoted } : {}), ...(nested.length ? { nested } : {}) })
      if (operator.includes("<<") && !operator.endsWith("<<<")) {
        if (target.includes(UNRESOLVED) || nested.length) fail(unsupported.heredoc)
        pending.push({ index: start, delimiter: target, stripTabs: operator.endsWith("<<-") })
      }
      raw = ""; nested = []
    }
    const word = () => {
      while (i < command.length) {
        tick()
        const c = command[i]!
        if (c === "\\" && quote !== "'") {
          if (i + 1 >= command.length) fail(unsupported.quote)
          const next = command[i + 1]!
          if (next === "\n") { i += 2; continue }
          if (!quote && /\s/u.test(next) && next !== " " && next !== "\t") fail(unsupported.whitespace)
          // shell-quote incorrectly treats escaped globs as live globs.
          raw += !quote && (next === "*" || next === "?") ? `'${next}'` : command.slice(i, i + 2)
          i += 2; continue
        }
        if (quote === "'") { raw += c; i++; if (c === "'") quote = ""; continue }
        if (c === "'" || c === '"') {
          if (!quote) quote = c
          else if (quote === c) quote = ""
          raw += c; i++; continue
        }
        if (c === "$" && command[i + 1] === "'" && !quote) fail(unsupported.ansi)
        if (c === "$" && command[i + 1] === "(") {
          if (command[i + 2] === "(") fail(unsupported.syntax)
          const end = substitutionEnd(i)
          nested.push(command.slice(i + 2, end))
          raw += UNRESOLVED
          i = end + 1; continue
        }
        if (c === "$" && command[i + 1] === "{") {
          const end = parameterEnd(i)
          raw += command.slice(i, end + 1)
          i = end + 1; continue
        }
        if (c === "`") {
          const end = backtickEnd(i)
          nested.push(command.slice(i + 1, end))
          raw += UNRESOLVED
          i = end + 1; continue
        }
        if (!quote) {
          if (space(c) || ";&|()<>".includes(c)) return
          if (/\s/u.test(c)) fail(unsupported.whitespace)
          if (c === "[" || c === "]" || c === "{" || c === "}") fail(unsupported.glob)
          if (c === "#") fail(unsupported.hash)
          if (c === "~" && (!raw || raw.endsWith("="))) {
            raw += UNRESOLVED; i++; continue
          }
        }
        raw += c; i++
      }
    }
    while (i < command.length) {
      tick()
      const c = command[i]!
      if (c === " " || c === "\t") { flush(); i++; continue }
      if (c === "\n") {
        flush(); emit({ kind: "op", value: ";" }); i++
        if (pending.length) bodies()
        continue
      }
      if (/\s/u.test(c)) fail(unsupported.whitespace)
      if (c === "#" && !raw) { while (i < command.length && command[i] !== "\n") { tick(); i++ } continue }
      if (c === "{" && !raw && space(command[i + 1] ?? "")) { emit({ kind: "op", value: "{" }); i++; continue }
      if (c === "}" && !raw && boundary(command[i + 1])) { emit({ kind: "op", value: "}" }); i++; continue }
      if (";&|()".includes(c)) {
        flush()
        const pair = command.slice(i, i + 2)
        if (c === "&" && pair !== "&&" || c === "|" && pair === "|&" || pair === ";;" || pair === ";&") fail(unsupported.syntax)
        const op = pair === "&&" || pair === "||" ? pair : c
        emit({ kind: "op", value: op }); i += op.length; continue
      }
      if (c === "<" || c === ">") {
        if (command[i + 1] === "(") fail(unsupported.syntax)
        const op = command.slice(i, i + 3).startsWith("<<<") ? "<<<"
          : command.slice(i, i + 2) === "<<" ? "<<"
          : command.slice(i, i + 2) === ">>" ? ">>" : c
        i += op.length
        const full = op === "<<" && command[i] === "-" ? "<<-" : op
        if (full === "<<-") i++
        redirect(full); continue
      }
      word()
      if (quote) fail(unsupported.quote)
    }
    flush()
    if (pending.length) fail(unsupported.heredoc)
    return { tokens, limitations: [] }
  } catch (error) {
    if (!(error instanceof StructureError)) throw error
    return { tokens: [], limitations: [error.message] }
  }
}
