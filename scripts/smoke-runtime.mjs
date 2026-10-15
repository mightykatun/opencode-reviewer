import { execFileSync, fork } from "node:child_process"
import { lstat, mkdir } from "node:fs/promises"
import path from "node:path"

/** Start both the supervisor and tmux with fixture-local state and no inherited startup hooks. */
export function smokeEnvironment(directory, parent = process.env) {
  if (!path.isAbsolute(directory)) throw new Error("Fixture directory must be absolute")
  // The fixture asserts exact theme RGB values; tmux supports truecolor even without an attached client.
  return { PATH: parent.PATH ?? "/usr/bin:/bin", HOME: directory, SHELL: "/bin/sh", TERM: "xterm-256color", COLORTERM: "truecolor",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", OPENCODE_DISABLE_AUTOUPDATE: "1", XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"), XDG_STATE_HOME: path.join(directory, "state"), XDG_CACHE_HOME: path.join(directory, "cache") }
}

function fixtureGitEnvironment(directory, project) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(project)) throw new Error("Fixture Git paths must be absolute")
  const relative = path.relative(directory, project)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Fixture Git project must be inside its private namespace")
  return { ...smokeEnvironment(directory), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "",
    GIT_CEILING_DIRECTORIES: directory }
}

/** Git setup shares the fixture namespace, never the caller's Git overrides. */
export function smokeGitInit(directory, project) {
  execFileSync("git", ["init", "--quiet", project], {
    env: fixtureGitEnvironment(directory, project),
    timeout: 10000, killSignal: "SIGKILL",
  })
}

/** Bounded fixture-owned commits and metadata reads, with no inherited Git configuration. */
export function smokeGit(directory, project, args) {
  const env = fixtureGitEnvironment(directory, project)
  if (!Array.isArray(args) || !args.length || args.length > 128
    || args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 16384))
    throw new Error("Fixture Git arguments must be a bounded string array")
  return execFileSync("git", args, { cwd: project, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })
}

const tmux = (socket, args) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
  env: smokeEnvironment(path.dirname(socket)),
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL",
})
const stop = (socket) => { try { tmux(socket, ["kill-server"]) } catch { /* Already stopped or not started. */ } }

if (process.argv[2] === "--guard") {
  const socket = process.argv[3]
  if (!socket || !path.isAbsolute(socket) || !process.send) process.exit(1)
  const cleanup = () => { stop(socket); process.exit() }
  process.on("disconnect", cleanup)
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("message", ({ id, args }) => {
    // Own startup as well as cleanup. If the parent dies during new-session,
    // disconnect is handled only after the synchronous launch has settled.
    let error
    try { tmux(socket, ["new-session", ...args]) } catch (cause) { error = String(cause) }
    if (!process.connected) return cleanup()
    process.send({ id, error }, (failure) => { if (failure) cleanup() })
  })
  process.send({ ready: true }, (error) => { if (error) cleanup() })
}

/** Each fixture supplies its own mkdtemp directory, never a shared/default socket. */
export async function smokeRuntime(directory) {
  if (!path.isAbsolute(directory)) throw new Error("Fixture directory must be absolute")
  // Only the caller's owned mkdtemp namespace. Host mkdir inherits umask (often
  // 0002), so create private XDG state ancestors before ANY pane/probe can start.
  // Reused private fixtures are allowed; never chmod or follow an existing path.
  const privateDirectory = async target => {
    const stat = await lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077))
      throw new Error("Fixture state requires private owned directories")
  }
  await privateDirectory(directory)
  for (const target of [path.join(directory, "state"), path.join(directory, "state/opencode")]) {
    try { await mkdir(target, { mode: 0o700 }) }
    catch (error) { if (error.code !== "EEXIST") throw error }
    await privateDirectory(target)
  }
  const socket = path.join(directory, "tmux.sock")
  const guard = fork(new URL(import.meta.url), ["--guard", socket], {
    detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: [], env: smokeEnvironment(directory),
  })
  let closed = false, sequence = 0
  const requests = new Map()
  let ready, failed
  const initialized = new Promise((resolve, reject) => { ready = resolve; failed = reject })
  const cleanup = () => stop(socket)
  process.on("exit", cleanup)
  guard.on("message", (message) => {
    if (message.ready) { ready(); return }
    const request = requests.get(message.id)
    requests.delete(message.id)
    if (!requests.size) guard.channel?.unref()
    if (message.error) request?.reject(new Error(message.error))
    else request?.resolve()
  })
  guard.on("error", failed)
  const exited = new Promise((resolve) => guard.once("exit", () => {
    closed = true
    cleanup() // Also handle a supervisor failure while the owner remains alive.
    process.off("exit", cleanup)
    const error = new Error("Fixture supervisor stopped")
    failed(error)
    for (const request of requests.values()) request.reject(error)
    requests.clear()
    resolve()
  }))
  await initialized
  guard.unref()
  guard.channel?.unref()
  return {
    socket,
    supervisorPID: guard.pid,
    tmux: (...args) => {
      if (closed) throw new Error("Fixture runtime is closed")
      if (args[0] === "new-session") throw new Error("Use supervised start for new sessions")
      return tmux(socket, args)
    },
    start: (...args) => new Promise((resolve, reject) => {
      if (closed) { reject(new Error("Fixture runtime is closed")); return }
      const id = ++sequence
      requests.set(id, { resolve, reject })
      guard.channel?.ref()
      guard.send({ id, args }, (error) => {
        if (error) {
          requests.delete(id)
          if (!requests.size) guard.channel?.unref()
          reject(error)
        }
      })
    }),
    dispose: async () => {
      closed = true
      guard.ref()
      if (guard.connected) guard.disconnect()
      await exited
    },
  }
}
