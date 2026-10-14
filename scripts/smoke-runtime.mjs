import { execFileSync, fork } from "node:child_process"
import { lstat, mkdir } from "node:fs/promises"
import path from "node:path"

/** Fixture-server observations only. Never retain URLs, headers, bodies or native IDs. */
export function smokeMetrics(server, { pollIntervalMs, hostVersion, origin = "shared" } = {}) {
  const start = performance.now()
  const now = () => performance.now() - start
  const sockets = new WeakMap()
  const attached = new WeakSet()
  const connections = [], requests = [], milestones = []
  const role = (url) => url === "/review/chat/completions" ? "reviewer"
    : url === "/main/chat/completions" ? "main" : url === "/mcp" ? "mcp" : "other"
  const connection = (socket, origin) => {
    let record = sockets.get(socket)
    if (!record) {
      record = { id: connections.length + 1, origin, connectedAtMs: now(), requests: 0 }
      connections.push(record)
      sockets.set(socket, record)
      socket.once("close", () => { record.closedAtMs = now() })
    }
    return record
  }
  const attach = (server, origin) => {
    if (attached.has(server)) throw new Error("Fixture server metrics already attached")
    if (!["shared", "main", "reviewer"].includes(origin)) throw new Error("Unknown fixture origin label")
    attached.add(server)
    server.on("connection", (socket) => connection(socket, origin))
    // Run before the fixture handler starts reading the body. This observes the
    // same request, not a second listener that parses or copies its payload.
    server.prependListener("request", (req, res) => {
      const socket = connection(req.socket, origin)
      const kind = role(req.url)
      const previous = requests.findLast((item) => item.role === kind)
      const record = { id: requests.length + 1, origin, role: kind, attempt: (previous?.attempt ?? 0) + 1,
        socket: socket.id, socketRequest: ++socket.requests, receivedAtMs: now(), requestBytes: 0, responseBytes: 0,
        reusedRoleSocket: requests.some((item) => item.role === kind && item.socket === socket.id) }
      requests.push(record)
      if (previous?.finishedAtMs !== undefined) record.previousResponseGapMs = record.receivedAtMs - previous.finishedAtMs
      req.on("data", (chunk) => { record.requestBytes += chunk.length })
      req.once("end", () => { record.bodyReadAtMs = now() })
      req.once("aborted", () => { record.requestAbortedAtMs = now() })
      const writeHead = res.writeHead
      res.writeHead = function (...args) {
        const result = writeHead.apply(this, args)
        record.headersAtMs ??= now()
        return result
      }
      // Only wrap this fixture response. No host fetch, socket or filesystem globals.
      for (const method of ["write", "end"]) {
        const original = res[method]
        res[method] = function (...args) {
          const result = original.apply(this, args)
          const chunk = args[0]
          const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, typeof args[1] === "string" ? args[1] : "utf8")
            : ArrayBuffer.isView(chunk) ? chunk.byteLength : 0
          if (bytes) {
            record.firstBodyWriteAtMs ??= now()
            record.responseBytes += bytes
          }
          return result
        }
      }
      res.once("finish", () => { record.finishedAtMs = now(); record.status = res.statusCode })
      res.once("close", () => { record.closedAtMs = now(); record.responseAborted = !res.writableFinished })
    })
  }
  attach(server, origin)
  const rounded = (record) => Object.fromEntries(Object.entries(record).map(([key, value]) =>
    [key, typeof value === "number" ? Math.round(value * 1000) / 1000 : value]))
  return {
    attach,
    // Callers supply fixed fixture milestone names and local attempt ordinals only.
    mark(event, reviewerAttempt) { milestones.push({ event, atMs: now(), ...(reviewerAttempt === undefined ? {} : { reviewerAttempt }) }) },
    snapshot(outcome) {
      const byRole = Object.fromEntries(["main", "reviewer", "mcp", "other"].map((kind) => {
        const items = requests.filter((item) => item.role === kind)
        return [kind, { requests: items.length, sockets: new Set(items.map((item) => item.socket)).size,
          reusedSocketRequests: items.filter((item) => item.reusedRoleSocket).length,
          completed: items.filter((item) => item.finishedAtMs !== undefined).length,
          aborted: items.filter((item) => item.responseAborted).length }]
      }))
      return { version: 2, outcome, hostVersion, nodeVersion: process.version, pollIntervalMs,
        clock: "monotonic milliseconds since fixture metrics initialization",
        timingScope: "server receive/body-read/header-write/body-write/finish; UI milestones are polling observations, not client dispatch or validation",
        limitations: "Loopback HTTP only; no DNS/TLS/provider generation measurements. Byte counts exclude HTTP framing. SSE body writes include framing, not just assessment text. Socket novelty does not measure client connection setup latency.",
        elapsedMs: Math.round(now() * 1000) / 1000, counts: { requests: requests.length, sockets: connections.length, byRole },
        connections: connections.map(rounded), requests: requests.map((record) => rounded({ ...record,
          ...(record.headersAtMs === undefined ? {} : { receiveToHeadersMs: record.headersAtMs - record.receivedAtMs }),
          ...(record.firstBodyWriteAtMs === undefined ? {} : { receiveToFirstBodyWriteMs: record.firstBodyWriteAtMs - record.receivedAtMs }),
          ...(record.finishedAtMs === undefined ? {} : { receiveToFinishMs: record.finishedAtMs - record.receivedAtMs }),
        })), milestones: milestones.map(rounded) }
    },
  }
}

/** Preserve the complete literal path reported by a fixture, or explicitly supplied by its caller. */
export function isolatedStateDirectory(output, existing) {
  const paths = existing ? [existing] : [...output.matchAll(/(?:^|[ \t])Isolated files: ([^\r\n]+)\r?$/gm)].map(match => match[1])
  if (paths.length !== 1 || !path.isAbsolute(paths[0])) throw new Error("fixture must identify its isolated state")
  return paths[0]
}

/** Start both the supervisor and tmux with fixture-local state and no inherited startup hooks. */
export function smokeEnvironment(directory, parent = process.env) {
  if (!path.isAbsolute(directory)) throw new Error("Fixture directory must be absolute")
  // The fixture asserts exact theme RGB values; tmux supports truecolor even without an attached client.
  return { PATH: parent.PATH ?? "/usr/bin:/bin", HOME: directory, SHELL: "/bin/sh", TERM: "xterm-256color", COLORTERM: "truecolor",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", OPENCODE_DISABLE_AUTOUPDATE: "1", XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"), XDG_STATE_HOME: path.join(directory, "state"), XDG_CACHE_HOME: path.join(directory, "cache") }
}

/** Git setup shares the fixture namespace, never the caller's Git overrides. */
export function smokeGitInit(directory, project) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(project)) throw new Error("Fixture Git paths must be absolute")
  const relative = path.relative(directory, project)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Fixture Git project must be inside its private namespace")
  execFileSync("git", ["init", "--quiet", project], {
    env: { ...smokeEnvironment(directory), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "" },
    timeout: 10000, killSignal: "SIGKILL",
  })
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
