import path from "node:path"
import { parse } from "shell-quote"
import { reviewStage } from "./deadline.js"
import { runtimeOperands } from "./shell-runtimes.js"
import { shellStructure, type ShellToken } from "./shell-structure.js"

const VARIABLE = "\u0000UNRESOLVED_VARIABLE\u0000"
const python = /^python(?:[23](?:\.\d+)*)?$/
const shell = /^(?:ba|da|k|z)?sh$/
const assignment = /^[A-Za-z_][A-Za-z_0-9]*=/
export interface Reference { filename: string; cwd: string | null; executable: boolean }
/** A declared launch path can name the physical directory without establishing
 * the shell's logical PWD. String callers supply an already-known logical cwd. */
export interface LaunchCwd { declared: string | null; canonical: string | null }

function literal(word: string) { return !word.includes(VARIABLE) && !word.startsWith("~") }
function unsupportedWhitespace(char: string) { return /\s/.test(char) && char !== " " && char !== "\t" }

class DiscoveryLimit extends Error {}
class DiscoveryBudget {
  bytes = 16 * 1024 * 1024
  tokens = 65536
  references = 16384
  expansions = 16384
  steps = 262144
  readonly notices = new Set<string>()
  private end = performance.now() + 500
  constructor(readonly signal?: AbortSignal) {}
  step() {
    if (this.signal) reviewStage(this.signal, "Evidence collection")
    if (--this.steps < 0 || performance.now() >= this.end) throw new DiscoveryLimit()
  }
  admit(command: string) {
    this.step()
    if (command.length > this.bytes) throw new DiscoveryLimit()
    this.bytes -= Buffer.byteLength(command)
    if (this.bytes < 0) throw new DiscoveryLimit()
    // Bound potential tokenizer matches before shell-quote allocates its arrays.
    // Counting operator characters individually is deliberately conservative.
    let quote = "", word = false, units = 0
    for (let i = 0; i < command.length; i++) {
      if (!(i % 4096)) this.step()
      const char = command[i]!
      if (char === "\\" && quote !== "'") { i++; if (!word) { word = true; units++ } }
      else if (quote) {
        if (char === quote) quote = ""
        else if (quote === '"' && char === "$" && --this.expansions < 0) throw new DiscoveryLimit()
      }
      else if (char === "'" || char === '"') { quote = char; if (!word) { word = true; units++ } }
      else if (char === "#" && !word) break
      else if (/\s/.test(char)) word = false
      else if (/[;&|()<>]/.test(char)) { word = false; units++ }
      else {
        // Bound callback expansion/output growth before entering shell-quote.
        if (char === "$" && --this.expansions < 0) throw new DiscoveryLimit()
        if (!word) { word = true; units++ }
      }
      if (units > this.tokens) throw new DiscoveryLimit()
    }
  }
  parsed(count: number) { this.step(); this.tokens -= count; if (this.tokens < 0) throw new DiscoveryLimit() }
  reference() { this.step(); if (--this.references < 0) throw new DiscoveryLimit() }
  notice(text: string) {
    if (this.notices.has(text)) return
    if (this.notices.size >= 256) throw new DiscoveryLimit()
    this.notices.add(text)
  }
}

/** Cursor views share the tokenizer's storage; consuming arguments never shifts it. */
class Words {
  private index = 0
  constructor(readonly words: string[], readonly budget: DiscoveryBudget) {}
  get length() { return this.words.length - this.index }
  peek() { this.budget.step(); return this.words[this.index] }
  take() { const word = this.peek(); if (this.length) this.index++; return word }
  *values() { for (let i = this.index; i < this.words.length; i++) { this.budget.step(); yield this.words[i]! } }
}

function balancedQuotes(command: string, budget: DiscoveryBudget): boolean {
  let quote = ""
  for (let i = 0; i < command.length; i++) {
    if (!(i % 4096)) budget.step()
    const char = command[i]
    if (char === "\\" && quote !== "'") {
      if (++i === command.length) return false
    } else if (quote && char === quote) quote = ""
    else if (!quote && (char === "'" || char === '"')) quote = char
  }
  return !quote
}

function unsupportedShellSyntax(command: string, budget: DiscoveryBudget): string | undefined {
  let quote = ""
  let inWord = false
  const whitespace = "Unsupported unquoted shell whitespace is outside reliable tokenization; script targets were not resolved."
  for (let i = 0; i < command.length; i++) {
    if (!(i % 4096)) budget.step()
    const char = command[i]!
    if (char === "\\" && quote !== "'") {
      // shell-quote's bareword matcher also drops escaped non-ASCII whitespace.
      if (!quote && unsupportedWhitespace(command[i + 1] ?? "")) return whitespace
      i++
      inWord = true
    } else if (quote) { if (char === quote) quote = "" }
    else if (char === "$" && command[i + 1] === "'") {
      return "ANSI-C shell quoting is outside byte-faithful literal discovery; script targets were not resolved."
    }
    else if (char === "'" || char === '"') { quote = char; inWord = true }
    else if (unsupportedWhitespace(char)) return whitespace
    else if (char === "#") {
      if (!inWord) return
      return "Unquoted # within a shell word is outside reliable tokenization; script targets were not resolved."
    } else if (char === "[" || char === "{" || char === "}") {
      return "Unquoted bracket glob or brace syntax is outside literal discovery; script targets were not resolved."
    } else inWord = !/[ \t;&|()<>]/.test(char)
  }
}

/** Conventional spellings only, not basename or normalized-path identity. */
function programIdentity(executable: string): "python" | "shell" | "cat" | "head" | "env" | undefined {
  const name = /^(?:\/(?:usr\/)?bin\/)?([^/]+)$/.exec(executable)?.[1]
  if (!name) return
  if (python.test(name)) return "python"
  if (shell.test(name)) return "shell"
  if (name === "cat" || name === "head" || name === "env") return name
}

/** One shell string's state; a nested external shell gets its own state. */
class DiscoveryState {
  readonly references: Reference[] = []
  readonly candidates: Reference[] = []
  readonly limitations: string[] = []
  uncertainWord = false
  preceded = false
  previousOperator: string | undefined
  conditionalCwd = false
  explicitCdpath = false
  constructor(public cwd: string | null, readonly depth: number, readonly budget: DiscoveryBudget,
    readonly logicalCwdKnown: boolean, readonly collectCandidates: boolean) {}

  note(text: string) { this.budget.notice(text); if (!this.limitations.includes(text)) this.limitations.push(text) }
  invalidateCwd(text: string) { this.cwd = null; this.note(text) }
  observeAssignment(word: string) {
    if (!word.startsWith("CDPATH=")) return
    this.explicitCdpath = true
    this.note("Explicit CDPATH assignment is not evaluated; directory-search targets may be unresolved.")
  }
  qualifySnapshot() {
    if (this.preceded) this.note("Files are current filesystem snapshots; preceding command statements may change them before execution.")
  }
  add(filename: string, executable = false, validatedOperand = false) {
    if (!literal(filename) || (this.uncertainWord && !validatedOperand)) {
      this.note(`File target unresolved: ${filename.replaceAll(VARIABLE, "<variable>")}`)
      return
    }
    this.budget.reference()
    this.qualifySnapshot()
    this.references.push({ filename, cwd: this.cwd, executable })
  }
  addAt(filename: string, cwd: string | null) {
    const previous = this.cwd
    this.cwd = cwd
    try { this.add(filename) } finally { this.cwd = previous }
  }
  candidate(filename: string) {
    if (!this.collectCandidates || !filename || filename === "-" || filename.startsWith("~") || !literal(filename)
      || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(filename)) return
    this.budget.reference()
    this.qualifySnapshot()
    this.candidates.push({ filename, cwd: this.cwd, executable: false })
  }
  nested(command: string, physical: boolean) {
    if (physical) this.note("Physical shell directory mode is outside literal cwd inference; nested relative script targets are unresolved.")
    const nested = scan(command, this.explicitCdpath || physical ? null : this.cwd, this.depth + 1,
      this.budget, this.logicalCwdKnown, this.collectCandidates)
    if (nested.references.length || nested.candidates.length) this.qualifySnapshot()
    this.references.push(...nested.references)
    this.candidates.push(...nested.candidates)
    nested.limitations.forEach((text) => this.note(text))
  }
  afterOperator(operator: string) {
    this.previousOperator = operator
    this.uncertainWord = false
    this.preceded = true
    if (operator === "||") {
      this.invalidateCwd("Conditional fallback makes the working directory uncertain for later statements.")
    } else if (operator === ";" && this.conditionalCwd) {
      this.conditionalCwd = false
      this.invalidateCwd("Earlier cd may fail or be skipped before this statement; the working directory is unresolved at the branch join.")
    }
  }
}

interface Invocation { executable: string; builtins: boolean; builtinOnly: boolean }

/** Unwrap only supported launchers, retaining whether shell builtins can run. */
function unwrap(args: Words, state: DiscoveryState, initialBuiltins = true): Invocation | undefined {
  let builtins = initialBuiltins, builtinOnly = false, wrappers = 0
  while (args.peek() && assignment.test(args.peek()!)) state.observeAssignment(args.take()!)
  while (args.peek()) {
    const name = args.peek()!
    const env = programIdentity(name) === "env"
    if (!env && !["command", "exec", "builtin"].includes(name)) break
    if (wrappers++ >= 8) {
      const text = "Wrapper nesting exceeds literal discovery's eight-wrapper limit; source was not resolved."
      if (builtins) state.invalidateCwd(`${text} The working directory is unresolved.`)
      else state.note(text)
      return
    }
    const wrapper = args.take()!
    if (env) {
      if (builtinOnly) {
        state.note(`Unsupported wrapper composition: ${wrapper} is not assumed to be a shell builtin.`)
        return
      }
      builtins = false
      while (args.peek()?.startsWith("-")) {
        const option = args.take()!
        if (option === "--") break
        if (option === "-i" || option === "--ignore-environment") continue
        if (option === "-u" || option === "--unset") {
          if (!args.peek() || !literal(args.peek()!) || state.uncertainWord) {
            state.note("Missing or unresolved env option argument; invoked source was not resolved.")
            return
          }
          args.take()
          continue
        }
        state.note("Unsupported env option; invoked script source could not be resolved.")
        return
      }
      // `--` ends env options, not its NAME=value operands.
      while (args.peek() && assignment.test(args.peek()!)) state.observeAssignment(args.take()!)
    } else {
      if (!builtins) {
        state.note(`Unsupported wrapper composition: ${wrapper} after an external launcher is not assumed to be a shell builtin.`)
        return
      }
      builtinOnly = wrapper === "builtin"
      if (wrapper === "exec") builtins = false
      if (args.peek() === "--") args.take()
      else if (args.peek()?.startsWith("-")) {
        const text = `Unsupported ${wrapper} option; invoked script source was not resolved.`
        // command -v/-V only query names, rather than invoking their operands.
        if (builtins && !(wrapper === "command" && ["-v", "-V"].includes(args.peek()!))) {
          state.invalidateCwd(`${text} The working directory is unresolved.`)
        } else state.note(text)
        return
      }
    }
    if (!args.peek()) { state.note(`No command operand after ${wrapper}; invoked script source was not resolved.`); return }
  }
  const executable = args.take()
  if (!executable) return
  if (executable.startsWith("-")) { state.note("Wrapper options prevent script discovery."); return }
  return { executable, builtins, builtinOnly }
}

/** In-process operations own cwd transitions; external lookalikes never do. */
function builtin(executable: string, args: Words, state: DiscoveryState, next?: string): boolean {
  if (["export", "readonly", "declare", "typeset"].includes(executable)) {
    let unsupported = state.uncertainWord
    for (const word of args.values()) {
      state.observeAssignment(word)
      unsupported ||= !literal(word) || (word.startsWith("-") && word !== "--") || word.startsWith("+")
    }
    // Options can introduce arrays/namerefs, and expansions can select CDPATH.
    // Track plain literal declarations only, without evaluating their values.
    if (unsupported) {
      state.invalidateCwd(`Unsupported ${executable} operands or options may change shell state; the working directory is unresolved.`)
    }
    return true
  }
  if (["pushd", "popd"].includes(executable)) {
    state.invalidateCwd("Directory-stack operations are outside literal discovery; the working directory is unresolved.")
    return true
  }
  if (executable === "cd") {
    if (args.peek() === "--") args.take()
    const target = args.peek()
    const searchesCdpath = target && !path.isAbsolute(target) && !/^\.\.?(?:\/|$)/.test(target)
    if (state.previousOperator === "|" || next === "|") {
      state.invalidateCwd("Pipeline directory changes do not establish a reliable cwd for later script targets.")
    } else if (!state.logicalCwdKnown) {
      state.invalidateCwd("Declared and canonical launch directories do not establish the shell's logical PWD; working directory after cd is unresolved and relative script targets will not be guessed.")
    } else if (args.length === 1 && target && !target.startsWith("-") && literal(target) && !state.uncertainWord
      && !(state.explicitCdpath && searchesCdpath) && next === "&&" && state.cwd) {
      state.cwd = path.resolve(state.cwd, target)
      state.conditionalCwd = true
    } else {
      state.invalidateCwd("Working directory after cd is unresolved; relative script targets will not be guessed.")
    }
    return true
  }
  if (executable === "source" || executable === ".") {
    if (args.peek() === "--") args.take()
    const target = args.peek()
    if (target?.startsWith("-")) state.note("Unsupported sourcing option; source target was not resolved.")
    else if (target && !target.includes("/")) state.note("Bare source operand uses PATH lookup; its file was not resolved.")
    else if (target) state.add(target)
    state.invalidateCwd("Sourced code may change the shell environment or working directory.")
    return true
  }
  if (["eval", "trap", "read", "readarray", "mapfile", "getopts", "let", "set", "shopt", "alias", "unalias", "enable", "unset"].includes(executable)) {
    state.invalidateCwd(`In-process shell state change through ${executable} is outside literal discovery; the working directory is unresolved.`)
    return true
  }
  if (["if", "then", "else", "fi", "for", "while", "until", "do", "done", "case", "function", "{"].includes(executable)) {
    state.invalidateCwd("Shell control flow is outside literal discovery; script coverage is incomplete.")
    return true
  }
  if (["echo", "printf", ":", "true", "false", "pwd", "test"].includes(executable)) return true
  return false
}

function reader(program: "cat" | "head", args: Words, state: DiscoveryState) {
  const operands: string[] = []
  let options = true
  while (args.length) {
    const arg = args.take()!
    if (options && arg === "--") { options = false; continue }
    if (options && arg.startsWith("-") && arg !== "-") {
      if (program === "cat" && (/^-[AbEenstTuv]+$/.test(arg) || ["--show-all", "--number-nonblank", "--show-ends", "--number", "--squeeze-blank", "--show-tabs", "--show-nonprinting"].includes(arg))) continue
      if (program === "head") {
        if (/^-[qvz]+$/.test(arg) || ["--quiet", "--silent", "--verbose", "--zero-terminated"].includes(arg)) continue
        if (["-n", "-c", "--lines", "--bytes"].includes(arg) && /^-?\d+[kKMGTPEZY]?(?:B|iB)?$/.test(args.peek() ?? "")) { args.take(); continue }
        if (/^(?:-[nc]?|--(?:lines|bytes)=)-?\d+[kKMGTPEZY]?(?:B|iB)?$/.test(arg)) continue
      }
      state.note(`Unsupported ${program} option; file operands were not resolved.`)
      return
    }
    if (arg === "-") state.note(`${program} reads stdin; no file was resolved for that operand.`)
    else operands.push(arg)
  }
  operands.forEach((operand) => state.add(operand))
}

function interpreter(isPython: boolean, args: Words, state: DiscoveryState) {
  let physical = false
  while (args.length) {
    const arg = args.take()!
    if (arg === "--") {
      const operand = args.peek()
      if (!operand || (isPython && operand === "-")) state.note("Interpreter reads stdin; no separate script file was resolved.")
      else if (!isPython && operand === "-") state.note("Shell '-' operand after -- is outside supported script discovery.")
      else state.add(operand)
      return
    }
    if (!isPython && arg === "-") { state.note("Shell '-' invocation is outside supported script discovery."); return }
    if (arg === "-" || (!isPython && /^-[abefhiklmnptuvxBCEHPTs]*s[abefhiklmnptuvxBCEHPTs]*$/.test(arg))) {
      state.note("Interpreter reads stdin; no separate script file was resolved.")
      return
    }
    if ((isPython && arg === "-c") || (!isPython && /^-[abefhiklmnptuvxBCEHPT]*c$/.test(arg))) {
      const code = args.peek()
      if (!code || !literal(code) || state.uncertainWord) state.note("Inline interpreter code contains unresolved expansion or is missing; its runtime contents are unavailable.")
      if (!isPython && code && literal(code) && !state.uncertainWord) state.nested(code, physical || arg.includes("P"))
      return
    }
    if (isPython && (arg === "-m" || arg.startsWith("-m") || arg.startsWith("-c"))) {
      if (!arg.startsWith("-c")) state.note("Python module execution: module source is not resolved by direct-script discovery.")
      return
    }
    if ((isPython && (arg === "-W" || arg === "-X")) || (!isPython && (arg === "-o" || arg === "+o"))) {
      if (!args.peek() || !literal(args.peek()!) || state.uncertainWord) {
        state.note(`Interpreter option ${arg} has a missing or unresolved argument; script source was not resolved.`)
        return
      }
      const option = args.take()
      if (!isPython && option === "physical") physical = arg === "-o"
      continue
    }
    if (arg.startsWith("-") || (!isPython && arg.startsWith("+"))) {
      const known = isPython ? /^-[bBdEIOPqRsSuv]+$/.test(arg) || /^-(W|X).+/.test(arg)
        : /^[-+][abefhiklmnptuvxBCEHPT]+$/.test(arg) || ["--noprofile", "--norc"].includes(arg)
      if (known) {
        if (!isPython && /^[-+][abefhiklmnptuvxBCEHPT]+$/.test(arg) && arg.includes("P")) physical = arg.startsWith("-")
        continue
      }
      state.note(`Interpreter option ${arg} is outside supported script discovery.`)
      return
    }
    state.add(arg)
    return
  }
}

/** These are literal argv values, not alleged inputs. A GNU-style option or
 * assignment may spell a path after '='; never interpret its option meaning. */
function argumentCandidates(executable: string, args: Words, state: DiscoveryState) {
  if (!state.collectCandidates) return
  const name = /^(?:\/(?:usr\/)?bin\/)?([^/]+)$/.exec(executable)?.[1]
  let afterOptions = false
  let first = true
  for (const argument of args.values()) {
    if (first && ((name === "jupyter" && ["lab", "notebook", "execute", "nbconvert"].includes(argument))
      || (["deno", "go", "dotnet", "uv", "bun"].includes(name ?? "") && argument === "run")
      || (name === "tsx" && argument === "watch"))) { first = false; continue }
    first = false
    if (argument === "--" && !afterOptions) { afterOptions = true; continue }
    if (!afterOptions && argument.startsWith("-") && argument !== "-" && !argument.includes("=")) continue
    const equals = argument.indexOf("=")
    const value = !afterOptions && equals > 0 && (/^--?[A-Za-z][\w-]*$/.test(argument.slice(0, equals))
      || assignment.test(argument)) ? argument.slice(equals + 1) : argument
    state.candidate(value)
  }
}

function visit(args: string[], state: DiscoveryState, next?: string, external = false, forwardDepth = 0) {
  // Negation changes pipeline status, not a builtin's in-process effects. Do
  // not reuse ordinary && success inference or preserve cwd for unknown operands.
  if (args[0] === "!") {
    state.invalidateCwd("Shell negation is outside literal state inference; negated source targets and the subsequent working directory are unresolved.")
    return
  }
  // `time` is shell syntax and can run builtins in this process. Do not unwrap
  // it as an external launcher or guess the effects of the timed pipeline.
  // Explicit paths and `command time` retain their external-command semantics.
  if (args[0] === "time") {
    state.invalidateCwd("Shell timed commands are outside literal discovery; the working directory is unresolved.")
    return
  }
  const words = new Words(args, state.budget)
  const invocation = unwrap(words, state, !external)
  if (!invocation) return
  const { executable, builtins, builtinOnly } = invocation
  if (!literal(executable)) {
    const text = "Executable name contains unresolved expansion; script coverage is incomplete."
    if (builtins) state.invalidateCwd(`${text} The working directory is unresolved.`)
    else state.note(text)
    return
  }
  if (builtins && builtin(executable, words, state, next)) return
  if (builtinOnly) {
    if ([":", "true", "false", "pwd", "echo", "printf", "test"].includes(executable)) return
    state.invalidateCwd(`Unsupported builtin operand ${executable}; source and subsequent working directory were not resolved.`)
    return
  }
  argumentCandidates(executable, words, state)
  const program = programIdentity(executable)
  if (program === "cat" || program === "head") return reader(program, words, state)
  if (program === "python" || program === "shell") return interpreter(program === "python", words, state)
  const runtime = runtimeOperands(executable, [...words.values()], () => state.budget.step())
  if (runtime.handled) {
    runtime.files.forEach(file => state.add(file, false, true))
    runtime.limitations.forEach(text => state.note(text))
    if (runtime.child) {
      if (forwardDepth >= 8) state.note("Indirect launcher nesting exceeds the eight-child limit; source was not resolved.")
      else visit(runtime.child, state, undefined, true, forwardDepth + 1)
    }
    return
  }
  if (executable.includes("/")) state.add(executable, true)
  else if (/\.(?:py|sh|bash|zsh|ksh|js|mjs|cjs|jsx|ts|mts|cts|tsx|rb|pl|php|lua)$/.test(executable))
    state.note(`Executable ${executable} uses PATH lookup; its file was not resolved.`)
  else if (["sudo", "su", "ssh", "docker", "podman", "eval", "xargs", "find", "npm", "npx", "make", "uv", "poetry"].includes(executable)) {
    state.note(`Indirect execution through ${executable}: invoked source is not automatically discovered.`)
  }
}

function shellStdin(args: readonly string[]): boolean {
  const name = args[0]
  if (!name || programIdentity(name) !== "shell") return false
  // -c and an explicit script operand do not interpret redirected stdin as a shell program.
  return args.length === 1 || args.length === 2 && /^-[abefhiklmnptuvxBCEHPT]*s[abefhiklmnptuvxBCEHPT]*$/.test(args[1]!)
}

/** The structural path retains literal operand admission in visit(), never
 * executing a command, expanding a word, or assuming a group shares cwd. */
function structured(command: string, state: DiscoveryState, budget: DiscoveryBudget) {
  const parsed = shellStructure(command, () => budget.step())
  budget.parsed(parsed.tokens.length)
  parsed.limitations.forEach(text => state.note(text))
  if (parsed.limitations.length && !parsed.tokens.length) return
  walkStructure(parsed.tokens, state, budget)
}

function walkStructure(tokens: readonly ShellToken[], state: DiscoveryState, budget: DiscoveryBudget) {
  let words: string[] = []
  let redirects: Extract<ShellToken, { kind: "redirect" }>[] = []
  const flush = (next?: string) => {
    if (!words.length && !redirects.length) return
    const before = state.cwd
    const stdinShell = shellStdin(words)
    // Redirection expansion occurs before invocation; neither an output path
    // nor a here-document delimiter names an existing input file.
    for (const redirect of redirects) for (const nested of redirect.nested ?? []) state.nested(nested, false)
    if (words.length) visit(words, state, next)
    for (const redirect of redirects) {
      if (/^(?:\d+)?<$/.test(redirect.operator) && redirect.target) state.addAt(redirect.target, before)
      if ((redirect.operator === "<<" || redirect.operator === "<<-") && redirect.body !== undefined && stdinShell) {
        if (!redirect.quoted && /[$`]|\\(?=[$`\\\n])/.test(redirect.body))
          state.note("Unquoted here-document expansion is unresolved; its shell source was not inspected.")
        else state.nested(redirect.body, false)
      }
    }
    words = []; redirects = []
  }
  for (let i = 0; i < tokens.length; i++) {
    budget.step()
    const token = tokens[i]!
    if (token.kind === "word") {
      for (const nested of token.nested) state.nested(nested, false)
      if (token.nested.length) state.note("Command substitution output is unresolved; its result was not used as a filename.")
      words.push(token.value)
    } else if (token.kind === "redirect") {
      redirects.push(token)
    } else if (token.value === "(" || token.value === "{") {
      if (words.length || redirects.length) {
        state.invalidateCwd("Shell function or group adjacent to another command is outside literal discovery; later relative targets are unresolved.")
        return
      }
      const opener = token.value, closer = opener === "(" ? ")" : "}"
      let level = 1, end = i + 1
      for (; end < tokens.length && level; end++) {
        budget.step()
        const current = tokens[end]
        if (current?.kind !== "op") continue
        if (current.value === opener) level++
        else if (current.value === closer) level--
      }
      if (level || state.depth >= 4) {
        state.invalidateCwd("Unbalanced or deeply nested shell group; later relative file targets are unresolved.")
        return
      }
      const branch = new DiscoveryState(state.cwd, state.depth + 1, budget, state.logicalCwdKnown, state.collectCandidates)
      branch.preceded = state.preceded
      walkStructure(tokens.slice(i + 1, end - 1), branch, budget)
      state.references.push(...branch.references)
      state.candidates.push(...branch.candidates)
      branch.limitations.forEach(text => state.note(text))
      if (opener === "{") state.invalidateCwd("Brace group may change the shell's working directory; later relative targets are unresolved.")
      state.preceded = true
      i = end - 1
    } else if (token.value === ")" || token.value === "}") {
      state.invalidateCwd("Unmatched shell group end; later relative file targets are unresolved.")
      return
    } else {
      flush(token.value)
      state.afterOperator(token.value)
    }
  }
  flush()
}

/** Literal discovery only. shell-quote is a tokenizer, not a shell evaluator. */
export function discover(command: string, cwd: string | null | LaunchCwd, depth = 0, signal?: AbortSignal): { references: Reference[]; limitations: string[] } {
  const launch = typeof cwd === "string" || cwd === null ? { declared: cwd, canonical: cwd } : cwd
  const { references, limitations } = scan(command, launch.declared, depth, new DiscoveryBudget(signal),
    launch.canonical !== null && launch.declared === launch.canonical, false)
  return { references, limitations }
}

/** The same syntax traversal exposes uncertain argv values for scoped,
 * existence-checked capture; ordinary discover() keeps its certain-only API. */
export function discoverWithCandidates(command: string, cwd: string | null | LaunchCwd, signal?: AbortSignal,
  includeCandidates = true) {
  const launch = typeof cwd === "string" || cwd === null ? { declared: cwd, canonical: cwd } : cwd
  return scan(command, launch.declared, 0, new DiscoveryBudget(signal),
    launch.canonical !== null && launch.declared === launch.canonical, includeCandidates)
}

function scan(command: string, cwd: string | null, depth: number, budget: DiscoveryBudget, logicalCwdKnown: boolean,
  collectCandidates: boolean): { references: Reference[]; candidates: Reference[]; limitations: string[] } {
  const state = new DiscoveryState(cwd, depth, budget, logicalCwdKnown, collectCandidates)
  const result = { references: state.references, candidates: state.candidates, limitations: state.limitations }
  try {
    budget.admit(command)
    if (depth > 4 || command.includes("\u0000")) {
      state.note("Script discovery unavailable for NULs or deeply nested shell strings; inspect command text directly.")
      return result
    }
    if (/[\r\n`<>(){}]/.test(command) || command.includes("$(")) {
      structured(command, state, budget)
      return result
    }
    if (!balancedQuotes(command, budget)) {
      state.note("Shell quoting could not be resolved reliably; script contents were not collected.")
      return result
    }
    const unsupported = unsupportedShellSyntax(command, budget)
    if (unsupported) { state.note(unsupported); return result }
    let tokens: ReturnType<typeof parse>
    try { tokens = parse(command, () => VARIABLE) } catch {
      state.note("Shell tokenization failed; script targets could not be resolved.")
      return result
    }
    budget.parsed(tokens.length)
    // No claim to understand control flow, substitutions, heredocs or redirections.
    if (tokens.some((t) => typeof t !== "string" && "op" in t && !["&&", "||", ";", "|", "glob"].includes(t.op))) {
      state.note("Shell grouping, substitution, background execution or redirection prevents reliable script discovery; inspect command text directly.")
      return result
    }
    let words: string[] = []
    for (const token of tokens) {
      budget.step()
      if (typeof token === "string") words.push(token)
      else if ("comment" in token) break
      else if ("op" in token && token.op === "glob" && "pattern" in token) { words.push(VARIABLE); state.uncertainWord = true }
      else if ("op" in token && typeof token.op === "string") {
        visit(words, state, token.op)
        words = []
        state.afterOperator(token.op)
      }
    }
    visit(words, state)
    return result
  } catch (error) {
    if (!(error instanceof DiscoveryLimit)) throw error
    const text = "Shell discovery exceeded its shared 16 MiB/65,536-token/16,384-reference/16,384-expansion/262,144-step/256-notice/500 ms work limits; remaining source targets were not resolved."
    if (!state.limitations.includes(text)) state.limitations.push(text)
    return result
  }
}
