/** Literal source operands only. The caller owns shell decoding, cwd and file access. */
export interface RuntimeOperands {
  handled: boolean
  files: string[]
  limitations: string[]
  child?: string[]
}

const unresolved = "\u0000UNRESOLVED_VARIABLE\u0000"
const unsafe = (word: string) => word.startsWith("~") || word.includes(unresolved) || /[*?\[\]{}]/.test(word)
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
  source?: readonly string[]
  inline?: readonly string[]
  modules?: readonly string[]
  tasks?: readonly string[]
}

/** Parse options before the first positional operand, preserving -- as a boundary.
 * A value for an option is never interpreted as a script. Unknown options stop
 * discovery rather than risk taking their arguments as source operands. */
function leading(runtime: string, args: readonly string[], options: Options):
  | { rest: string[] }
  | { stopped: RuntimeOperands } {
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]!
    if (unsafe(arg)) return { stopped: limit(runtime, "unresolved or nonliteral option/operand") }
    if (arg === "--") return { rest: args.slice(i + 1) }
    if (!arg.startsWith("-") || arg === "-") break
    const base = arg.split("=", 1)[0]!
    if (options.source?.includes(base)) {
      const source = arg === base ? args[i + 1] : arg.slice(base.length + 1)
      return source && !unsafe(source) && !(arg === base && source.startsWith("-"))
        ? { rest: [source] } : { stopped: limit(runtime, `missing or unresolved source for ${base}`) }
    }
    if (options.inline?.includes(base) || options.modules?.includes(base) || options.tasks?.includes(base)
      || options.attached?.some(flag => arg.startsWith(flag) && arg.length > flag.length
        && (options.inline?.includes(flag) || options.modules?.includes(flag) || options.tasks?.includes(flag)))) {
      const kind = options.tasks?.includes(base) || options.tasks?.some(flag => arg.startsWith(flag) && arg.length > flag.length)
        ? "task runner" : options.modules?.includes(base) || options.modules?.some(flag => arg.startsWith(flag) && arg.length > flag.length)
          ? "module selection" : "inline evaluation"
      return { stopped: limit(runtime, `${kind} does not identify a separate script file`) }
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
  return { rest: args.slice(i) }
}

function script(runtime: string, args: readonly string[], options: Options): RuntimeOperands {
  const parsed = leading(runtime, args, options)
  if ("stopped" in parsed) return parsed.stopped
  const file = parsed.rest[0]
  if (file === undefined || file === "-") return limit(runtime, "stdin or missing script")
  if (unsafe(file)) return limit(runtime, "unresolved or nonliteral script")
  return result([file])
}

const node: Options = {
  flags: ["--watch", "--watch-preserve-output", "--no-warnings", "--trace-warnings", "--enable-source-maps", "--preserve-symlinks", "--preserve-symlinks-main", "--inspect", "--inspect-brk", "--no-deprecation", "--experimental-strip-types", "--disable-warning", "--check", "-c"],
  values: ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--conditions", "--input-type", "--inspect-port", "--max-old-space-size", "--cpu-prof-dir", "--diagnostic-dir"],
  attached: ["-r", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
  tasks: ["--run", "--test"],
}
const bun: Options = {
  flags: ["--watch", "--hot", "--smol", "--bun", "--silent", "--no-clear-screen"],
  values: ["-r", "--preload", "--loader", "--env-file", "--conditions"],
  attached: ["-r", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
}
const tsx: Options = {
  flags: ["--watch", "--clear-screen", "--no-warnings", "--inspect"],
  values: ["-r", "--require", "--import", "--tsconfig", "--env-file", "--conditions"],
  attached: ["-r", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
  tasks: ["--test"],
}
const tsNode: Options = {
  flags: ["--files", "--transpile-only", "-T", "--esm", "--swc", "--skip-project", "--script-mode", "--cwd-mode", "--prefer-ts-exts"],
  values: ["-r", "--require", "-P", "--project", "--compiler", "--compiler-options", "--scope-dir", "--cwd"],
  attached: ["-r", "-P", "-e", "-p"], inline: ["-e", "--eval", "-p", "--print"],
}
const ruby: Options = {
  flags: ["-w", "-W", "-v", "-d", "-c", "--disable-gems", "--enable-gems", "--verbose"],
  values: ["-r", "-I", "--require", "--include"], attached: ["-r", "-I", "-e"],
  inline: ["-e"],
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
}

function uv(args: readonly string[]): RuntimeOperands {
  if (args[0] !== "run") return limit("uv", "unsupported subcommand or task runner")
  const parsed = leading("uv run", args.slice(1), {
    flags: ["--no-project", "--no-sync", "--locked", "--frozen", "--active", "--isolated", "--no-env-file", "--no-dev", "--all-extras", "--exact", "--no-cache", "-q", "--quiet"],
    values: ["--python", "-p", "--project", "--with", "--with-requirements", "--env-file", "--package", "--extra", "--group", "--default-index", "--index"],
    attached: ["-p"], modules: ["-m", "--module"],
  })
  if ("stopped" in parsed) return parsed.stopped
  if (!parsed.rest.length || parsed.rest.some(unsafe)) return limit("uv run", "missing or unresolved child command/arguments")
  // The child is a decoded argv, not an instruction to execute or resolve PATH.
  return result([], [], parsed.rest)
}

function go(args: readonly string[]): RuntimeOperands {
  if (args[0] !== "run") return limit("go", "unsupported subcommand or package/task runner")
  const parsed = leading("go run", args.slice(1), {
    flags: ["-race", "-work", "-a", "-x", "-n", "-trimpath"],
    values: ["-mod", "-modfile", "-overlay", "-tags", "-gcflags", "-ldflags", "-asmflags", "-toolexec", "-exec"],
  })
  if ("stopped" in parsed) return parsed.stopped
  const files: string[] = []
  for (const word of parsed.rest) {
    if (!word.endsWith(".go")) break // following words are program arguments
    if (unsafe(word)) return limit("go run", "unresolved or nonliteral Go source")
    files.push(word)
  }
  return files.length ? result(files) : limit("go run", "package, directory, or missing explicit .go files")
}

function java(args: readonly string[]): RuntimeOperands {
  const parsed = leading("java", args, {
    flags: ["--enable-preview", "-ea", "-da", "--show-version"],
    values: ["--source", "-cp", "-classpath", "--class-path", "-p", "--module-path", "--enable-native-access"],
    modules: ["-m", "--module", "-jar"],
  })
  if ("stopped" in parsed) return parsed.stopped
  const word = parsed.rest[0]
  return word?.endsWith(".java") && !unsafe(word) ? result([word]) : limit("java", "class/module launch or missing explicit .java source")
}

function dotnet(args: readonly string[]): RuntimeOperands {
  if (args[0] !== "run") return limit("dotnet", "unsupported subcommand or task runner")
  let project: string | undefined
  for (let i = 1; i < args.length; i++) {
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
export function runtimeOperands(executable: string, args: readonly string[]): RuntimeOperands {
  const name = identity(executable)
  if (!name) return { handled: false, files: [], limitations: [] }
  if (name === "uv") return uv(args)
  if (name === "go") return go(args)
  if (name === "java") return java(args)
  if (name === "dotnet") return dotnet(args)
  if (/^node(?:js)?$/.test(name)) return script(name, args, node)
  if (name === "bun") {
    if (args[0] === "run") {
      const source = args[1]
      return source && /^(?:\.\.?\/|\/).*\.(?:[cm]?[jt]sx?|jsx?)$/.test(source)
        ? script("bun run", args.slice(1), bun) : limit("bun run", "task name or missing explicit script path")
    }
    if (["test", "build", "x", "install"].includes(args[0] ?? "")) return limit("bun", "task runner")
    return script(name, args, bun)
  }
  if (name === "deno") {
    if (args[0] !== "run") return limit("deno", "unsupported subcommand or task runner")
    return script("deno run", args.slice(1), deno)
  }
  if (name === "tsx") {
    if (args[0] === "watch") return script("tsx watch", args.slice(1), tsx)
    return script(name, args, tsx)
  }
  if (/^ts-node(?:-esm)?$/.test(name)) return script(name, args, tsNode)
  if (/^ruby(?:\d+(?:\.\d+)*)?$/.test(name)) return script(name, args, ruby)
  if (/^perl(?:\d+(?:\.\d+)*)?$/.test(name)) return script(name, args, perl)
  if (name === "php") return script(name, args, php)
  if (/^lua(?:\d+(?:\.\d+)*)?$/.test(name) || name === "luajit") return script(name, args, lua)
  if (["npm", "npx", "pnpm", "yarn", "make", "poetry", "pipenv", "bunx", "cargo", "gradle", "mvn"].includes(name))
    return limit(name, "task runner or indirect launcher")
  return { handled: false, files: [], limitations: [] }
}
