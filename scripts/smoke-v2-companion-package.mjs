// W6 packed companion feasibility probe. Synthetic sessions only, no model calls.
// Inventory owner: register scenario "default", no flags; linux/git/tmux/npm-pack/tar/source.
// A pass proves these controls, not authoritative history lineage or deletion policy.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rename, readdir, lstat, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeGitInit, smokeRuntime } from "./smoke-runtime.mjs"
import { readObservation } from "./smoke-observations.mjs"

// Serialized into dist/tui.js. All non-Node dependencies are public host APIs.
// No repository path or runtime helper import survives into the packed package.
async function companionSetup(ctx) {
  const { Rpc } = await import("@opencode/plugin/rpc")
  const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false })
  const string = { type: "string" }
  const scope = { directory: string, candidate: string, sessionID: string }
  const contract = Rpc.define({ id: "research.v2.companion-package", methods: {
    storage: { input: object({ operation: { enum: ["get", "set", "remove"] }, key: string, value: {} }),
      output: object({ directory: string, value: {} }) },
    session: { input: object({ ...scope, fault: { enum: ["none", "401", "404", "wrong-id"] } }),
      output: object({ ...scope, exists: { type: "boolean" } }),
      errors: {
        absent: object({ ...scope, tag: { const: "Session.NotFoundError" } }),
        scope_mismatch: object({ directory: string }),
        candidate_mismatch: object({ directory: string }),
      } },
    status: { input: object({}), output: object({ directory: string, instance: string, version: string, storageKeys: { type: "array", items: string } }) },
  }, events: {} })
  const cli = "ui" in ctx
  const options = ctx.options
  const location = cli ? ctx.location ?? ctx.data.location.default() : ctx.location
  const label = cli ? "cli" : options.locations.indexOf(location.directory) === 0 ? "server-a" : "server-b"
  if (!cli && !options.locations.includes(location.directory)) throw Error("Unexpected fixture location")
  const destination = options.observations + "/" + label + "-" + options.round + ".json"
  const publisher = observationPublisher(destination)
  const result = { role: label, round: options.round, instance: randomUUID(), version: ctx.app.version,
    moduleURL: import.meta.url, location, errors: [], events: [], storage: [], ticks: 0, cleaned: false }
  const publish = () => publisher.publish(result)
  const abort = new AbortController(), tasks = new Set()
  let stopped = false
  const requestOptions = directory => ({ location: { directory }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const own = fn => {
    const task = Promise.resolve().then(fn).catch(error => {
      if (!stopped) result.errors.push({ message: String(error), value: JSON.parse(JSON.stringify(error)) })
    }).finally(() => { tasks.delete(task); if (!stopped) void publish() })
    tasks.add(task)
  }
  const check = (condition, message) => { if (!condition) throw Error(message) }
  const serializeError = error => ({ ...JSON.parse(JSON.stringify(error)), message: error?.message })
  const cleanups = []
  let timer
  try {
    if (!cli) {
      // The server branch never imports any terminal renderer or Solid module.
      const registration = await ctx.rpc.register(contract, {
        storage: async input => {
          if (input.operation === "set") await ctx.storage.set(input.key, input.value)
          if (input.operation === "remove") await ctx.storage.remove(input.key)
          const value = await ctx.storage.get(input.key)
          result.storage.push({ operation: input.operation, key: input.key, value: value ?? null })
          await publish()
          return { directory: location.directory, value: value ?? null }
        },
        status: async () => ({ directory: location.directory, instance: result.instance, version: ctx.app.version,
          storageKeys: (await ctx.storage.scan({ prefix: "w6/", limit: 100 })).entries.map(item => item.key) }),
        session: async (input, call) => {
          if (input.directory !== location.directory)
            return call.error("scope_mismatch", "Fixture location mismatch", { directory: location.directory })
          if (input.candidate !== await ctx.storage.get("w6/candidate"))
            return call.error("candidate_mismatch", "Fixture candidate mismatch", { directory: location.directory })
          try {
            // Failure-shape controls use the same classifier as the real read.
            // A status-like envelope, even 404, must not become absence authority.
            if (input.fault === "401" || input.fault === "404")
              throw { status: Number(input.fault), data: { message: "Synthetic transport envelope" } }
            if (input.fault === "wrong-id")
              throw { _tag: "Session.NotFoundError", sessionID: "ses_11111111111111111111111111" }
            const session = await ctx.session.get({ sessionID: input.sessionID }, { signal: call.signal })
            if (session.location.directory !== input.directory)
              return call.error("scope_mismatch", "Session belongs to another fixture location", { directory: location.directory })
            result.lastSession = { input, exists: true }
            await publish()
            return { directory: input.directory, candidate: input.candidate, sessionID: input.sessionID, exists: true }
          } catch (error) {
            result.lastSession = { input, error: serializeError(error) }
            await publish()
            // Pinned direct server context error, distinct from HTTP's
            // SessionNotFoundError envelope. Do not accept both spellings.
            if (error?._tag === "Session.NotFoundError" && error.sessionID === input.sessionID)
              return call.error("absent", "Exact server session absence", {
                directory: input.directory, candidate: input.candidate, sessionID: input.sessionID, tag: error._tag,
              })
            throw error
          }
        },
      })
      cleanups.push(() => registration.dispose())
      result.ready = true
    } else {
      // Lazy CLI-only public dependencies. Both exports still target this file.
      const { TextRenderable } = await import("@opentui/core")
      const { onCleanup } = await import("solid-js")
      const rpc = ctx.client.rpc(contract)
      cleanups.push(ctx.ui.slot({ append: "sidebar.content", render: () => {
        const text = new TextRenderable(ctx.renderer, { id: "w6-package-" + result.instance,
          content: "W6 PACKED COMPANION", fg: ctx.theme.text.base, height: 1 })
        result.mounts = (result.mounts ?? 0) + 1
        onCleanup(() => { result.unmounts = (result.unmounts ?? 0) + 1; if (!stopped) void publish() })
        void publish()
        return text
      } }))
      cleanups.push(ctx.data.listen(({ details }) => {
        if (["permission.asked", "permission.replied", "session.execution.started"].includes(details.type)) {
          result.events.push(details.type); void publish()
        }
      }))
      own(async () => {
        const [a, b] = options.locations
        const storage = (directory, operation, key, value = null) => rpc.storage({ operation, key, value }, requestOptions(directory))
        // plugin.list/session.create activate each real server-side location.
        const sessions = []
        for (const directory of [a, b]) {
          await ctx.client.plugin.list({ location: { directory } }, requestOptions(directory))
          sessions.push(await ctx.client.session.create({ title: "W6 PACKAGE " + options.round,
            location: { directory } }, requestOptions(directory)))
        }
        result.sessions = sessions
        ctx.ui.router.navigate({ type: "session", sessionID: sessions[0].id })
        result.servers = await Promise.all([a, b].map(directory => rpc.status({}, requestOptions(directory))))
        check(result.servers[0].instance !== result.servers[1].instance, "Two location instances required")
        const prior = (await storage(a, "get", "w6/candidate")).value
        result.priorCandidate = prior
        if (options.round === 1) {
          check(prior === null, "Fresh fixture storage must be empty")
          await storage(a, "set", "w6/candidate", "synthetic-candidate")
        } else check(prior === "synthetic-candidate", "Candidate must survive CLI lifecycle")
        result.crossLocation = await storage(b, "get", "w6/candidate")
        check(result.crossLocation.value === "synthetic-candidate", "Same plugin ID storage must cross locations")
        await storage(b, "set", "w6/shared", { writer: "b", round: options.round })
        result.reverseRead = await storage(a, "get", "w6/shared")
        check(result.reverseRead.value.writer === "b", "Reverse location storage read failed")

        // Deterministically force the problematic first-initialization interleaving.
        // Both readers finish before either writer begins; no CAS is available.
        await storage(a, "remove", "w6/naive")
        const reads = await Promise.all([a, b].map(directory => storage(directory, "get", "w6/naive")))
        check(reads.every(item => item.value === null), "Race readers must both see missing")
        const proposals = [randomUUID(), randomUUID()]
        await Promise.all([a, b].map((directory, index) => storage(directory, "set", "w6/naive", proposals[index])))
        const final = await Promise.all([a, b].map(directory => storage(directory, "get", "w6/naive")))
        check(proposals[0] !== proposals[1] && final[0].value === final[1].value && proposals.includes(final[0].value),
          "Read/set negative control must end with only one proposal durable")
        result.naiveRace = { reads, proposals, final, losingInitializer: proposals.findIndex(value => value !== final[0].value) }

        const base = { directory: a, candidate: "synthetic-candidate", sessionID: sessions[0].id, fault: "none" }
        result.present = await rpc.session(base, requestOptions(a))
        check(result.present.exists && result.present.sessionID === sessions[0].id, "Existing session RPC failed")
        const expectFailure = async (name, input, type) => {
          try { await rpc.session(input, requestOptions(a)) }
          catch (error) {
            const value = serializeError(error)
            result[name] = value
            check(value.type === type, name + ": unexpected RPC error " + JSON.stringify(value))
            return value
          }
          throw Error(name + ": unexpected success")
        }
        await expectFailure("wrongLocation", { ...base, directory: b }, "scope_mismatch")
        await expectFailure("wrongCandidate", { ...base, candidate: "unrelated" }, "candidate_mismatch")
        await expectFailure("otherLocationSession", { ...base, sessionID: sessions[1].id }, "scope_mismatch")
        for (const fault of ["401", "404", "wrong-id"])
          await expectFailure("injected-" + fault, { ...base, fault }, "rpc.internal")
        await ctx.client.session.remove({ sessionID: sessions[0].id }, requestOptions(a))
        const missing = await expectFailure("missing", base, "absent")
        check(missing.data.tag === "Session.NotFoundError" && missing.data.sessionID === base.sessionID
          && missing.data.directory === a && missing.data.candidate === base.candidate, "Missing RPC must retain exact scoped input")
        // Return to a live root for the real sidebar capture after the deletion control.
        const display = await ctx.client.session.create({ title: "W6 PACKED SIDEBAR", location: { directory: a } }, requestOptions(a))
        ctx.ui.router.navigate({ type: "session", sessionID: display.id })
        result.displaySession = display.id
        result.done = true
      })
    }
    timer = setInterval(() => { result.ticks++; void publish() }, 100)
    await publish()
  } catch (error) {
    result.errors.push(serializeError(error)); await publish()
    for (const cleanup of cleanups.reverse()) await cleanup()
    await publisher.close()
    throw error
  }
  return async () => {
    stopped = true; clearInterval(timer); abort.abort()
    await Promise.allSettled([...tasks])
    for (const cleanup of cleanups.reverse()) await cleanup()
    result.cleaned = true; await publish(); await publisher.close()
  }
}

runtimeArguments("smoke-v2-companion-package.mjs")
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
await mkdir("/tmp/opencode", { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-companion-package-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-companion-package-")
// Creates private state/opencode before even the custom-environment version probe.
const runtime = await smokeRuntime(temp)
const env = smokeEnvironment(temp)
const host = process.env.OPENCODE_BIN ?? "opencode"
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-companion")
const cliPath = path.join(temp, "config/opencode/cli.json")
const locations = [path.join(temp, "project-a"), path.join(temp, "project-b")]
const id = "research.v2.companion-package"
const packageName = "research-v2-companion-package"
const archiveFiles = ["dist/tui.js", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].sort()
const atomicJSON = async (file, value) => { await writeFile(file + ".next", JSON.stringify(value)); await rename(file + ".next", file) }
const observation = (label, round = 1) => path.join(artifacts, label + "-" + round + ".json")
const read = (label, round = 1) => readObservation(observation(label, round), { optional: true })
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    for (const round of [1, 2]) for (const role of ["cli", "server-a", "server-b"]) {
      const record = await read(role, round)
      if (record) { assert.deepEqual(record.errors, []); assert.deepEqual(record.events, []) }
    }
    const value = await predicate()
    if (value) return value
    await sleep(100)
  } while (Date.now() < end)
  throw Error("Timed out waiting for " + label)
}
let version
let registry
const registryRequests = []
try {
  version = execFileSync(host, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim()
  assertV2HostVersion(version)
  const source = path.join(temp, "package-source"), install = path.join(temp, "installed")
  await mkdir(path.join(source, "dist"), { recursive: true })
  await mkdir(install)
  await mkdir(path.dirname(cliPath), { recursive: true })
  for (const project of locations) { await mkdir(project); smokeGitInit(temp, project) }
  const manifest = { name: packageName, version: "0.0.0-w6", type: "module",
    exports: { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" },
    files: archiveFiles,
    // Failing lifecycle sentinels prove packing/installation really disable scripts.
    scripts: { prepack: "node -e \"process.exit(91)\"", install: "node -e \"process.exit(92)\"" },
    peerDependencies: { "@opentui/core": ">=0.5.8", "solid-js": ">=1.9.0" },
    peerDependenciesMeta: { "@opentui/core": { optional: true }, "solid-js": { optional: true } } }
  await writeFile(path.join(source, "package.json"), JSON.stringify(manifest, null, 2))
  // Inline the real serialized/coalesced publisher and reader, including Node imports.
  const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
  const bundle = helpers + "\n" + companionSetup.toString() + "\nexport default { id: " + JSON.stringify(id) + ", async setup(ctx) { return companionSetup(ctx) } }\n"
  assert.ok(!bundle.includes(root), "Packed source must not reference the repository")
  await writeFile(path.join(source, "dist/tui.js"), bundle)
  for (const file of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"])
    await writeFile(path.join(source, file), "Synthetic W6 fixture only. Not the published reviewer package.\n")
  execFileSync(process.execPath, ["--check", path.join(source, "dist/tui.js")], { env, timeout: 10000 })
  const npmOptions = { env: { ...env, npm_config_cache: path.join(temp, "npm-cache"), npm_config_ignore_scripts: "true" },
    encoding: "utf8", timeout: 60000 }
  const packOutput = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", temp], { ...npmOptions, cwd: source }))
  await writeFile(path.join(artifacts, "npm-pack.json"), JSON.stringify(packOutput, null, 2))
  const packed = Array.isArray(packOutput) ? packOutput : Object.values(packOutput)
  assert.equal(packed.length, 1)
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), archiveFiles)
  const archive = path.join(temp, packed[0].filename)
  const listed = execFileSync("tar", ["-tzf", archive], { env, encoding: "utf8", timeout: 10000 }).trim().split("\n").sort()
  assert.deepEqual(listed, archiveFiles.map(file => "package/" + file).sort())
  await writeFile(path.join(install, "package.json"), JSON.stringify({ name: "w6-private-install", version: "0.0.0", private: true }))
  const installed = execFileSync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--legacy-peer-deps", "--omit=optional", "--package-lock=false", archive],
    { ...npmOptions, cwd: install })
  await writeFile(path.join(artifacts, "npm-install.txt"), installed)
  const plugin = path.join(install, "node_modules", packageName)
  const walk = async (directory, prefix = "") => {
    const files = []
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), relative = prefix + name, stat = await lstat(file)
      assert.ok(!stat.isSymbolicLink(), "Installed archive contains no source-directory symlinks")
      if (stat.isDirectory()) files.push(...await walk(file, relative + "/")); else files.push(relative)
    }
    return files.sort()
  }
  assert.deepEqual(await walk(plugin), archiveFiles)
  for (const file of archiveFiles) assert.deepEqual(await readFile(path.join(plugin, file)), await readFile(path.join(source, file)))
  // Local directory loading uses conventional index/tui filenames in 2.0.26.
  // A loopback registry exercises real package exports without adding wrappers
  // or files to the verified archive, and keeps host installation private.
  const archiveBytes = await readFile(archive)
  registry = createServer((request, response) => {
    registryRequests.push({ method: request.method, url: request.url })
    const send = (status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)) }
    if (request.method !== "GET") return send(405, { error: "Fixture registry is read-only" })
    if (request.url === "/archive.tgz") {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": archiveBytes.length })
      response.end(archiveBytes); return
    }
    const metadata = { ...manifest, dist: { tarball: `http://127.0.0.1:${registry.address().port}/archive.tgz`,
      shasum: packed[0].shasum, integrity: packed[0].integrity } }
    if (request.url === "/" + packageName) return send(200, { name: packageName,
      "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: metadata } })
    if (request.url === "/" + packageName + "/" + manifest.version) return send(200, metadata)
    send(404, { error: "Not a fixture package" })
  })
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve))
  await writeFile(path.join(temp, ".npmrc"), `registry=http://127.0.0.1:${registry.address().port}/\nlegacy-peer-deps=true\nignore-scripts=true\naudit=false\nfund=false\n`)
  const target = packageName + "@" + manifest.version
  const serverConfig = { update: "disable", plugins: [{ package: target, options: { locations, observations: artifacts, round: 1 } }] }
  for (const project of locations) await atomicJSON(path.join(project, "opencode.json"), serverConfig)
  const cliConfig = round => ({ animations: false, attention: { notifications: false, sound: false }, session: { sidebar: "auto" },
    plugins: [{ package: target, options: { locations, observations: artifacts, round } }] })
  await atomicJSON(cliPath, cliConfig(1))
  const launch = ["-d", "-s", "v2-companion", "-x", "160", "-y", "40", "-c", locations[0], host, "--standalone", locations[0]]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, temp, archive, packed, manifest, plugin,
    serverConfig, cliConfig: cliConfig(1), launch, socket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
  await runtime.start(...launch)
  const initial = await until("packed CLI/server RPC and storage", async () => { const value = await read("cli"); return value?.done && value })
  let loadedFile
  for (const role of ["cli", "server-a", "server-b"]) {
    const record = await read(role)
    // The supported local loader may append its reload generation query.
    const actualFile = fileURLToPath(record.moduleURL)
    assert.ok(actualFile.startsWith(temp + path.sep), "Host package install stays inside the private fixture root")
    loadedFile ??= actualFile
    assert.equal(actualFile, loadedFile, "CLI and both server locations load the same packed module")
    const actualPackage = path.dirname(path.dirname(actualFile))
    assert.deepEqual(await walk(actualPackage), archiveFiles)
    for (const file of archiveFiles) assert.deepEqual(await readFile(path.join(actualPackage, file)), await readFile(path.join(source, file)))
    assert.equal(record.version, initial.version)
  }
  const painted = async round => until("packed sidebar painted", async () => {
    const cli = await read("cli", round), screen = capture()
    if (!cli?.done || !cli.mounts || !screen.split("\n").some(line => line.slice(118).includes("W6 PACKED COMPANION"))) return false
    await writeFile(path.join(artifacts, "sidebar-" + round + ".txt"), screen)
    return cli
  })
  await painted(1)
  await atomicJSON(cliPath, { ...cliConfig(1), plugins: ["*", "-" + id] })
  const cleaned = await until("CLI disable cleanup", async () => { const value = await read("cli"); return value?.cleaned && value })
  await sleep(750)
  assert.deepEqual(await read("cli"), cleaned, "Disabled CLI publisher stays quiescent")
  assert.equal(cleaned.mounts, cleaned.unmounts, "All packed sidebar contributions unmount")
  assert.equal(capture().includes("W6 PACKED COMPANION"), false, "Disable removes actual sidebar content")
  const serverBefore = await read("server-a")
  assert.equal(serverBefore.cleaned, false, "CLI disable does not unload server companion")
  await atomicJSON(cliPath, cliConfig(2))
  const reloaded = await painted(2)
  assert.notEqual(reloaded.instance, initial.instance)
  assert.equal(reloaded.priorCandidate, "synthetic-candidate")
  assert.deepEqual(reloaded.servers.map(server => server.instance), initial.servers.map(server => server.instance), "CLI reload reuses server registrations")
  await atomicJSON(cliPath, { ...cliConfig(2), plugins: ["*", "-" + id] })
  await until("reloaded CLI cleanup", async () => (await read("cli", 2))?.cleaned)
  // Project config is a supported watched unload boundary. Keep each location's
  // snapshot separate and require both actual cleanup functions to finish.
  for (const project of locations) await atomicJSON(path.join(project, "opencode.json"), { ...serverConfig, plugins: ["*", "-" + id] })
  await until("both server plugin cleanups", async () => (await read("server-a"))?.cleaned && (await read("server-b"))?.cleaned)
  const finalServers = await Promise.all(["server-a", "server-b"].map(role => read(role)))
  await sleep(750)
  assert.deepEqual(await Promise.all(["server-a", "server-b"].map(role => read(role))), finalServers)
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, temp, archiveFiles, loadedFile, registryRequests,
    assertions: ["npm pack and install with disabled lifecycle scripts", "exact five-file self-contained archive",
      "one shared default module via server and global CLI configurations", "real sidebar text from lazy CLI import",
      "connected-client scoped RPC", "same plugin storage keys across two location instances", "read/set initialization race loses one proposed token",
      "existing and removed session RPC with exact typed error and matching input", "scope/candidate and synthetic error negative controls",
      "CLI disable/reload retains server registrations and storage", "both server location cleanups"],
    limits: ["Standalone server with one terminal and two locations only; shared-service and multiple-terminal behavior remains open.",
      "Synthetic candidate is not authoritative lineage. No CAS or atomic initialization protocol is established.",
      "No process restart, copied storage, database replacement, cross-server or disconnect/stale-response proof.",
      "Injected 401/404 values are server classifier controls, not authenticated HTTP transport failures.",
      "No production history deletion, accounting, approvals, model requests or complete W6 acceptance claimed."] }, null, 2))
  console.log(`PASS V2 packed companion: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  try { await writeFile(path.join(artifacts, "failed.txt"), capture()) } catch { /* Pane may not have started. */ }
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ version, temp, error: String(error), stack: error.stack, registryRequests }, null, 2))
  throw error
} finally {
  await runtime.dispose()
  if (registry) { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)) }
}
