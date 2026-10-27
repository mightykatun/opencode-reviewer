/** Decoded shell operands only. The caller marks unquoted globs and expansions as unresolved. */
export interface RuntimeOperands {
  handled: boolean
  files: string[]
  limitations: string[]
  child?: string[]
}

const unresolved = "\u0000UNRESOLVED_VARIABLE\u0000"
const unsafe = (word: string) => word.startsWith("~") || word.includes(unresolved)
  || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(word)
const result = (files: string[] = [], limitations: string[] = [], child?: string[]): RuntimeOperands =>
  ({ handled: true, files, limitations, ...(child === undefined ? {} : { child }) })
const limit = (runtime: string, detail: string) => result([], [`${runtime}: ${detail}; source operands were not resolved.`])

/** Never basename an arbitrary path or normalize a command identity. */
function identity(executable: string): string | undefined {
  return /^(?:\/(?:usr\/)?bin\/)?([^/]+)$/.exec(executable)?.[1]
}

interface Options {
  flags?: readonly string[]
  values?: readonly string[]
  attached?: readonly string[]
  inputFiles?: readonly string[]
  pathOnlyInputs?: readonly string[]
  source?: readonly string[]
  inline?: readonly string[]
  modules?: readonly string[]
  tasks?: readonly string[]
}

/** Parse options before the first positional operand, preserving -- as a boundary.
 * A value for an option is never interpreted as a script. Unknown options stop
 * discovery rather than risk taking their arguments as source operands. */
function leading(runtime: string, args: readonly string[], options: Options, check?: () => void):
  | { rest: string[]; files: string[] }
  | { stopped: RuntimeOperands } {
  let i = 0
  const files: string[] = []
  for (; i < args.length; i++) {
    if ((i & 127) === 0) check?.()
    const arg = args[i]!
    if (unsafe(arg)) return { stopped: limit(runtime, "unresolved or nonliteral option/operand") }
    if (arg === "--") return { rest: args.slice(i + 1), files }
    if (!arg.startsWith("-") || arg === "-") break
    const base = arg.split("=", 1)[0]!
    if (options.source?.includes(base)) {
      const source = arg === base ? args[i + 1] : arg.slice(base.length + 1)
      return source && !unsafe(source) && !(arg === base && source.startsWith("-"))
        ? { rest: [source], files } : { stopped: limit(runtime, `missing or unresolved source for ${base}`) }
    }
    if (options.inline?.includes(base) || options.modules?.includes(base) || options.tasks?.includes(base)
      || options.attached?.some(flag => arg.startsWith(flag) && arg.length > flag.length
        && (options.inline?.includes(flag) || options.modules?.includes(flag) || options.tasks?.includes(flag)))) {
      const kind = options.tasks?.includes(base) || options.tasks?.some(flag => arg.startsWith(flag) && arg.length > flag.length)
        ? "task runner" : options.modules?.includes(base) || options.modules?.some(flag => arg.startsWith(flag) && arg.length > flag.length)
          ? "module selection" : "inline evaluation"
      return { stopped: limit(runtime, `${kind} does not identify a separate script file`) }
    }
    const input = options.inputFiles?.find(flag => base === flag
      || (options.attached?.includes(flag) && arg.startsWith(flag) && arg.length > flag.length))
    if (input) {
      const value = base === input ? arg === input ? args[++i] : arg.slice(input.length + 1) : arg.slice(input.length)
      if (!value || unsafe(value) || (arg === input && value.startsWith("-")))
        return { stopped: limit(runtime, `missing or unresolved input for ${input}`) }
      if (!options.pathOnlyInputs?.includes(input) || /^(?:\.\.?\/|\/)/.test(value)) files.push(value)
      continue
    }
    if (options.flags?.includes(arg) || options.flags?.includes(base) && arg !== base) continue
    if (options.values?.includes(base) || options.attached?.some(flag => arg.startsWith(flag) && arg.length > flag.length)) {
      if (arg !== base || options.attached?.some(flag => arg.startsWith(flag) && arg.length > flag.length)) continue
      const value = args[++i]
      if (value === undefined || unsafe(value) || (value.startsWith("-") && value !== "-"))
        return { stopped: limit(runtime, `missing or unresolved value for ${arg}`) }
      continue
    }
    return { stopped: limit(runtime, `unsupported option ${arg}`) }
  }
  return { rest: args.slice(i), files }
}

function script(runtime: string, args: readonly string[], options: Options, check?: () => void): RuntimeOperands {
  const parsed = leading(runtime, args, options, check)
  if ("stopped" in parsed) return parsed.stopped
  const file = parsed.rest[0]
  if (file === undefined || file === "-") return limit(runtime, "stdin or missing script")
  if (unsafe(file)) return limit(runtime, "unresolved or nonliteral script")
  return result([...parsed.files, file])
}

/** File-oriented tools can accept options after positional inputs. Keep their
 * arguments in order and publish nothing if any option changes their meaning. */
interface FileOptions {
  flags?: readonly string[]
  values?: readonly string[]
  inputs?: readonly string[]
  pairs?: readonly string[]
  pairedInputs?: readonly string[]
  attached?: readonly string[] // exact short options whose value may be joined
  blocked?: readonly string[] // cwd/search-directory or unsupported mode
  stop?: readonly string[] // subsequent arguments are data, not file inputs
}
interface FileArg { word: string; input: boolean }
function fileArgs(runtime: string, args: readonly string[], options: FileOptions, check?: () => void):
  | { entries: FileArg[]; stopped: boolean; seen: string[] }
  | { error: RuntimeOperands } {
  const entries: FileArg[] = []
  const seen: string[] = []
  let positional = false
  for (let i = 0; i < args.length; i++) {
    if ((i & 127) === 0) check?.()
    const arg = args[i]!
    if (unsafe(arg)) return { error: limit(runtime, "unresolved or nonliteral operand") }
    if (!positional && arg === "--") { positional = true; continue }
    if (positional || !arg.startsWith("-") || arg === "-") {
      entries.push({ word: arg, input: false }); continue
    }
    const base = arg.split("=", 1)[0]!
    const joined = options.attached?.find(flag => arg.startsWith(flag) && arg.length > flag.length)
    const flag = joined ?? base
    if (options.blocked?.includes(flag)) return { error: limit(runtime, `unsupported directory or mode option ${flag}`) }
    if (options.stop?.includes(flag)) return { entries, stopped: true, seen }
    if (options.flags?.includes(arg)) { seen.push(flag); continue }
    const count = options.pairs?.includes(flag) || options.pairedInputs?.includes(flag) ? 2
      : options.values?.includes(flag) || options.inputs?.includes(flag) ? 1 : 0
    if (!count || (arg !== flag && !joined && !arg.startsWith(`${flag}=`)))
      return { error: limit(runtime, `unsupported option ${arg}`) }
    seen.push(flag)
    // Only short options explicitly listed in attached accept -fFILE; long
    // options accept --file=FILE. Never treat another flag as a value.
    const inline = joined ? arg.slice(flag.length) : arg === flag ? undefined : arg.slice(flag.length + 1)
    for (let n = 0; n < count; n++) {
      const value = n === 0 && inline !== undefined ? inline : args[++i]
      if (!value || unsafe(value) || (inline === undefined && value.startsWith("-") && value !== "-"))
        return { error: limit(runtime, `missing or unresolved value for ${flag}`) }
      if ((options.inputs?.includes(flag) || options.pairedInputs?.includes(flag) && n === 1) && value !== "-")
        entries.push({ word: value, input: true })
    }
  }
  return { entries, stopped: false, seen }
}

function files(runtime: string, args: readonly string[], options: FileOptions,
  select: (entries: FileArg[], stopped: boolean, seen: readonly string[]) => string[], check?: () => void): RuntimeOperands {
  const parsed = fileArgs(runtime, args, options, check)
  if ("error" in parsed) return parsed.error
  const selected = select(parsed.entries, parsed.stopped, parsed.seen)
  return selected.length ? result(selected) : limit(runtime, "no supported explicit file inputs")
}

const inputs = (entries: FileArg[]) => entries.filter(entry => entry.input).map(entry => entry.word)
const positional = (entries: FileArg[]) => entries.filter(entry => !entry.input).map(entry => entry.word)
const regular = (word: string) => word !== "-" && !unsafe(word)

function jupyter(name: string, args: readonly string[], check?: () => void): RuntimeOperands {
  const mode = name === "jupyter" ? args[0] : name.slice("jupyter-".length)
  if (!mode || !["lab", "notebook", "nbconvert", "execute"].includes(mode))
    return limit("jupyter", "unsupported subcommand or indirect launcher")
  const runtime = `jupyter ${mode}`
  const operands = name === "jupyter" ? args.slice(1) : args
  const server = mode === "lab" || mode === "notebook"
  const parsed = fileArgs(runtime, operands, {
    flags: ["--debug", "--quiet", ...(server ? ["--no-browser"] : mode === "nbconvert"
      ? ["--execute", "--yes", "-y", "--stdin"] : ["--allow-errors", "--inplace"])],
    values: server ? ["--port"] : mode === "nbconvert"
      ? ["--to", "--output", "--output-dir", "--template"]
      : ["--output", "--kernel_name", "--timeout", "--startup_timeout"],
    inputs: ["--config", ...(mode === "nbconvert" ? ["--template-file"] : [])],
    blocked: server ? ["--notebook-dir", "--preferred-dir", "--ServerApp.root_dir", "--ServerApp.notebook_dir", "--LabApp.root_dir"] : [],
  }, check)
  if ("error" in parsed) return parsed.error
  const named = positional(parsed.entries)
  if (server) {
    if (!named.length && inputs(parsed.entries).length)
      return result(inputs(parsed.entries), [`${runtime}: no literal notebook launch operand; browser-opened files were not resolved.`])
    // The server treats one existing positional path as a file_to_run or a
    // root directory. Restrict discovery to an explicit notebook filename.
    if (named.length !== 1 || !/\.ipynb$/i.test(named[0]!) || !regular(named[0]!) || /[*?\[\]]/.test(named[0]!))
      return limit(runtime, "directory, browser-only launch, or unsupported positional file")
  } else if (!named.length || named.some(word => !/\.ipynb$/i.test(word) || !regular(word)
    || /[*?\[\]]/.test(word))) {
    // nbconvert also expands quoted notebook globs itself; never enumerate them.
    return limit(runtime, "missing, generated, or nonliteral notebook inputs")
  }
  return result([...inputs(parsed.entries), ...named])
}

function awk(name: string, args: readonly string[], check?: () => void): RuntimeOperands {
  const gnu = name === "gawk"
  return files(name, args, {
    flags: gnu ? ["--posix", "--traditional", "--sandbox"] : [],
    values: ["-F", "-v", ...(gnu ? ["-e", "--source", "--field-separator", "--assign"] : [])],
    inputs: ["-f", ...(gnu ? ["--file"] : [])], attached: ["-F", "-v", "-f", ...(gnu ? ["-e"] : [])],
    blocked: ["-i", "--include", "-l", "--load"],
  }, (entries, _stopped, seen) => {
    const names = positional(entries)
    const programs = inputs(entries)
    // With -f the first positional is input; otherwise it is awk program text.
    const data = programs.length || seen.includes("-e") || seen.includes("--source")
      ? names : names.slice(1)
    return [...programs, ...data.filter(word => regular(word) && !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word))]
  }, check)
}

function sed(args: readonly string[], check?: () => void): RuntimeOperands {
  return files("sed", args, {
    flags: ["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-z", "--null-data"],
    values: ["-e", "--expression"], inputs: ["-f", "--file"], attached: ["-e", "-f"],
    blocked: ["-i", "--in-place"],
  }, (entries, _stopped, seen) => {
    const program = entries.some(entry => entry.input) || seen.includes("-e") || seen.includes("--expression")
    return [...inputs(entries), ...(program ? positional(entries) : positional(entries).slice(1)).filter(regular)]
  }, check)
}

function jq(args: readonly string[], check?: () => void): RuntimeOperands {
  return files("jq", args, {
    flags: ["-R", "--raw-input", "-s", "--slurp", "-c", "--compact-output", "-r", "--raw-output", "-e", "--exit-status", "-S", "--sort-keys"],
    values: ["--indent"], inputs: ["-f", "--from-file"], attached: ["-f"],
    pairs: ["--arg", "--argjson"], pairedInputs: ["--slurpfile", "--rawfile"],
    blocked: ["-L", "-n", "--null-input"], stop: ["--args", "--jsonargs"],
  }, (entries, stopped, seen) => {
    const named = positional(entries)
    const namedFiles = inputs(entries)
    const fromFile = seen.includes("-f") || seen.includes("--from-file")
    if (stopped && !namedFiles.length && !named.length) return []
    return [...namedFiles, ...named.slice(fromFile ? 0 : 1).filter(regular)]
  }, check)
}

function pandoc(args: readonly string[], check?: () => void): RuntimeOperands {
  return files("pandoc", args, {
    flags: ["-s", "--standalone", "--toc", "--table-of-contents", "--sandbox", "--file-scope", "-C", "--citeproc", "--wrap=none"],
    values: ["-o", "--output", "-f", "--from", "-t", "--to", "-M", "--metadata", "-V", "--variable"],
    inputs: ["-d", "--defaults", "--metadata-file", "--template", "-H", "--include-in-header", "-B", "--include-before-body", "-A", "--include-after-body", "--bibliography", "--csl", "-L", "--lua-filter"],
    attached: ["-o", "-f", "-t", "-M", "-V", "-d", "-H", "-B", "-A", "-L"],
    blocked: ["--data-dir", "--resource-path", "--extract-media"],
  }, entries => entries.filter(entry => entry.input || regular(entry.word)).map(entry => entry.word), check)
}

function psql(args: readonly string[], check?: () => void): RuntimeOperands {
  return files("psql", args, {
    flags: ["-X", "--no-psqlrc", "-q", "--quiet", "-1", "--single-transaction", "-A", "--no-align", "-t", "--tuples-only", "-w", "--no-password"],
    values: ["-c", "--command", "-d", "--dbname", "-h", "--host", "-p", "--port", "-U", "--username", "-v", "--set", "--variable", "-o", "--output"],
    inputs: ["-f", "--file"], attached: ["-c", "-d", "-h", "-p", "-U", "-v", "-o", "-f"],
  }, entries => positional(entries).length <= 2 ? inputs(entries) : [], check)
}

const node: Options = {
  flags: ["--watch", "--watch-preserve-output", "--no-warnings", "--trace-warnings", "--enable-source-maps", "--preserve-symlinks", "--preserve-symlinks-main", "--inspect", "--inspect-brk", "--no-deprecation", "--experimental-strip-types", "--check", "-c"],
  values: ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--conditions", "--input-type", "--inspect-port", "--max-old-space-size", "--cpu-prof-dir", "--diagnostic-dir"],
  attached: ["-r", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
  inputFiles: ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists"],
  pathOnlyInputs: ["-r", "--require", "--import", "--loader", "--experimental-loader"],
  tasks: ["--run", "--test"],
}
const bun: Options = {
  flags: ["--watch", "--hot", "--smol", "--bun", "--silent", "--no-clear-screen"],
  values: ["-r", "--preload", "--loader", "--env-file", "--conditions"],
  attached: ["-r", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
  inputFiles: ["-r", "--preload", "--loader", "--env-file"], pathOnlyInputs: ["-r", "--preload", "--loader"],
}
const tsx: Options = {
  flags: ["--watch", "--clear-screen", "--no-warnings", "--inspect"],
  values: ["-r", "--require", "--import", "--tsconfig", "--env-file", "--conditions"],
  attached: ["-r", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
  inputFiles: ["-r", "--require", "--import", "--tsconfig", "--env-file"],
  pathOnlyInputs: ["-r", "--require", "--import"],
  tasks: ["--test"],
}
const tsNode: Options = {
  flags: ["--files", "--transpile-only", "-T", "--esm", "--swc", "--skip-project", "--script-mode", "--cwd-mode", "--prefer-ts-exts"],
  values: ["-r", "--require", "-P", "--project", "--compiler", "--compiler-options", "--scope-dir", "--cwd"],
  attached: ["-r", "-P", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
  inputFiles: ["-r", "--require", "-P", "--project"], pathOnlyInputs: ["-r", "--require"],
}
const ruby: Options = {
  flags: ["-w", "-W", "-v", "-d", "-c", "--disable-gems", "--enable-gems", "--verbose"],
  values: ["-r", "-I", "--require", "--include"], attached: ["-r", "-I", "-e"],
  inline: ["-e"],
  inputFiles: ["-r", "--require"], pathOnlyInputs: ["-r", "--require"],
}
const perl: Options = {
  flags: ["-w", "-W", "-T", "-t", "-c", "-s", "-n", "-p", "-a", "-l"],
  values: ["-I", "-M", "-m", "-F"], attached: ["-I", "-M", "-m", "-F", "-e", "-E"],
  inline: ["-e", "-E"],
}
const php: Options = {
  flags: ["-n", "-q", "-C", "--no-php-ini"],
  values: ["-c", "--php-ini", "-d", "--define"], attached: ["-d"],
  source: ["-f", "--file"],
  inline: ["-r", "--run", "-B", "-R", "-F", "-E"],
}
const lua: Options = {
  flags: ["-i", "-v", "-E", "-W"], values: ["-l", "-e"],
  attached: ["-l", "-e"], inline: ["-e"],
}
const deno: Options = {
  flags: ["-A", "--allow-all", "--allow-read", "--allow-write", "--allow-env", "--allow-net", "--allow-run", "--allow-ffi", "--no-check", "--check", "--cached-only", "--reload", "--quiet", "-q", "--unstable", "--watch"],
  values: ["--config", "-c", "--import-map", "--lock", "--cert", "--location", "--v8-flags", "--node-modules-dir", "--seed"],
  attached: ["-c"],
  inputFiles: ["--config", "-c", "--import-map", "--lock", "--cert"],
}

function uv(args: readonly string[], check?: () => void): RuntimeOperands {
  if (args[0] !== "run") return limit("uv", "unsupported subcommand or task runner")
  const parsed = leading("uv run", args.slice(1), {
    flags: ["--no-project", "--no-sync", "--locked", "--frozen", "--active", "--isolated", "--no-env-file", "--no-dev", "--all-extras", "--exact", "--no-cache", "-q", "--quiet"],
    values: ["--python", "-p", "--project", "--with", "--with-requirements", "--env-file", "--package", "--extra", "--group", "--default-index", "--index"],
    attached: ["-p"], modules: ["-m", "--module"],
    inputFiles: ["--with-requirements", "--env-file"],
  }, check)
  if ("stopped" in parsed) return parsed.stopped
  if (!parsed.rest.length || parsed.rest.some(unsafe)) return limit("uv run", "missing or unresolved child command/arguments")
  // The child is a decoded argv, not an instruction to execute or resolve PATH.
  return result(parsed.files, [], parsed.rest)
}

function go(args: readonly string[], check?: () => void): RuntimeOperands {
  if (args[0] !== "run") return limit("go", "unsupported subcommand or package/task runner")
  const parsed = leading("go run", args.slice(1), {
    flags: ["-race", "-work", "-a", "-x", "-n", "-trimpath"],
    values: ["-mod", "-modfile", "-overlay", "-tags", "-gcflags", "-ldflags", "-asmflags", "-toolexec", "-exec"],
    inputFiles: ["-modfile", "-overlay"],
  }, check)
  if ("stopped" in parsed) return parsed.stopped
  const files: string[] = []
  for (let i = 0; i < parsed.rest.length; i++) {
    if ((i & 127) === 0) check?.()
    const word = parsed.rest[i]!
    if (!word.endsWith(".go")) break // following words are program arguments
    if (unsafe(word)) return limit("go run", "unresolved or nonliteral Go source")
    files.push(word)
  }
  return files.length ? result([...parsed.files, ...files]) : limit("go run", "package, directory, or missing explicit .go files")
}

function java(args: readonly string[], check?: () => void): RuntimeOperands {
  const parsed = leading("java", args, {
    flags: ["--enable-preview", "-ea", "-da", "--show-version"],
    values: ["--source", "-cp", "-classpath", "--class-path", "-p", "--module-path", "--enable-native-access"],
    modules: ["-m", "--module", "-jar"],
  }, check)
  if ("stopped" in parsed) return parsed.stopped
  const word = parsed.rest[0]
  return word?.endsWith(".java") && !unsafe(word) ? result([word]) : limit("java", "class/module launch or missing explicit .java source")
}

function dotnet(args: readonly string[], check?: () => void): RuntimeOperands {
  if (args[0] !== "run") return limit("dotnet", "unsupported subcommand or task runner")
  let project: string | undefined
  for (let i = 1; i < args.length; i++) {
    if ((i & 127) === 0) check?.()
    const arg = args[i]!
    if (arg === "--") break
    if (arg === "--project" || arg.startsWith("--project=")) {
      const value = arg === "--project" ? args[++i] : arg.slice("--project=".length)
      if (!value || unsafe(value) || (value.startsWith("-") && arg === "--project")) return limit("dotnet run", "missing or unresolved --project value")
      project = value
    } else if (["--configuration", "-c", "--framework", "-f", "--runtime", "-r", "--property", "-p"].includes(arg)) {
      if (!args[++i] || unsafe(args[i]!)) return limit("dotnet run", `missing or unresolved ${arg} value`)
    } else if (["--no-build", "--no-restore", "--interactive", "--no-launch-profile"].includes(arg)) continue
    else return limit("dotnet run", `unsupported option or operand ${arg}`)
  }
  return project && /\.(?:cs|fs|vb)proj$/.test(project) ? result([project])
    : limit("dotnet run", "directory, manifest inference, or missing literal project file")
}

/** Analyze only conventional runtime spellings, never arbitrary executable paths. */
export function runtimeOperands(executable: string, args: readonly string[], check?: () => void): RuntimeOperands {
  const name = identity(executable)
  if (!name) return { handled: false, files: [], limitations: [] }
  if (name === "uv") return uv(args, check)
  if (name === "go") return go(args, check)
  if (name === "java") return java(args, check)
  if (name === "dotnet") return dotnet(args, check)
  if (name === "jupyter" || ["jupyter-lab", "jupyter-notebook", "jupyter-nbconvert", "jupyter-execute"].includes(name))
    return jupyter(name, args, check)
  if (name === "Rscript") return script(name, args, {
    flags: ["--vanilla", "--no-environ", "--no-init-file", "--no-restore", "--no-save", "--slave"],
    values: ["--default-packages"], source: ["--file"], inline: ["-e"],
  }, check)
  if (name === "julia") return script(name, args, {
    flags: ["-q", "--quiet", "--startup-file=no", "--startup-file=yes", "--color=yes", "--color=no"],
    values: ["-t", "--threads"], inputFiles: ["-L", "--load"], attached: ["-L", "-t"],
    inline: ["-e", "--eval"],
  }, check)
  if (name === "awk" || name === "gawk") return awk(name, args, check)
  if (name === "sed") return sed(args, check)
  if (name === "jq") return jq(args, check)
  if (name === "pandoc") return pandoc(args, check)
  if (name === "psql") return psql(args, check)
  if (/^node(?:js)?$/.test(name)) return script(name, args, node, check)
  if (name === "bun") {
    if (args[0] === "run") {
      const source = args[1]
      return source && /^(?:\.\.?\/|\/).*\.(?:[cm]?[jt]sx?|jsx?)$/.test(source)
        ? script("bun run", args.slice(1), bun, check) : limit("bun run", "task name or missing explicit script path")
    }
    if (["test", "build", "x", "install"].includes(args[0] ?? "")) return limit("bun", "task runner")
    return script(name, args, bun, check)
  }
  if (name === "deno") {
    if (args[0] !== "run") return limit("deno", "unsupported subcommand or task runner")
    return script("deno run", args.slice(1), deno, check)
  }
  if (name === "tsx") {
    if (args[0] === "watch") return script("tsx watch", args.slice(1), tsx, check)
    return script(name, args, tsx, check)
  }
  if (/^ts-node(?:-esm)?$/.test(name)) return script(name, args, tsNode, check)
  if (/^ruby(?:\d+(?:\.\d+)*)?$/.test(name)) return script(name, args, ruby, check)
  if (/^perl(?:\d+(?:\.\d+)*)?$/.test(name)) return script(name, args, perl, check)
  if (name === "php") return script(name, args, php, check)
  if (/^lua(?:\d+(?:\.\d+)*)?$/.test(name) || name === "luajit") return script(name, args, lua, check)
  if (["npm", "npx", "pnpm", "yarn", "make", "poetry", "pipenv", "bunx", "cargo", "gradle", "mvn"].includes(name))
    return limit(name, "task runner or indirect launcher")
  return { handled: false, files: [], limitations: [] }
}
