// Phase 1: the actual five-file production archive, not the W6 synthetic package.
// Inventory owner: default/cold-startup scenarios, no flags; linux/git/tmux/bundle/npm-pack/tar.
// Host execution requires the inventory owner's registration and execution grant.
// No permission-review, approval, notification or storage-activity coverage.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, lstat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"

// Independent client contract. The instrumented server compares the actual
// archived registration with this entire schema before forwarding it unchanged.
function handshakeDefinition() {
  const text = { type: "string", minLength: 1, maxLength: 16384 }
  const location = { type: "object", properties: { directory: text, workspaceID: text },
    required: ["directory"], additionalProperties: false }
  return { id: "opencode-reviewer", methods: { handshake: {
    input: location,
    output: { type: "object", properties: {
      protocol: { const: 1 }, hostVersion: text, epoch: { type: "string", format: "uuid" }, location,
      project: { type: "object", properties: { id: text, directory: text, canonical: text },
        required: ["id", "directory", "canonical"], additionalProperties: false },
    }, required: ["protocol", "hostVersion", "epoch", "location", "project"], additionalProperties: false },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } },
  }, invocation: {
    input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text },
      required: ["location", "epoch", "sessionID", "requestID"], additionalProperties: false },
    output: { anyOf: [{ type: "null" }, { type: "object", properties: {
      request: { type: "object" }, invocation: { type: "object" },
    }, required: ["request", "invocation"], additionalProperties: false }] },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } },
  }, evidence: {
    input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text,
      options: { type: "object", properties: {
        reviewBash: { type: "boolean" }, reviewEdits: { type: "boolean" }, reviewExternalDirectories: { type: "boolean" },
        reviewSkills: { type: "boolean" }, reviewMcp: { type: "boolean" }, reviewCustomTools: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1, maximum: 1000 }, maxEvidenceBytes: { type: "integer", minimum: 1, maximum: 16777216 },
      }, required: ["reviewBash", "reviewEdits", "reviewExternalDirectories", "reviewSkills", "reviewMcp", "reviewCustomTools", "maxFiles", "maxEvidenceBytes"], additionalProperties: false },
      timeoutMs: { type: "number", exclusiveMinimum: 0, maximum: 5000 } },
      required: ["location", "epoch", "sessionID", "requestID", "options", "timeoutMs"], additionalProperties: false },
    output: { anyOf: [{ type: "null" }, { type: "object", properties: {
      request: { type: "object" }, invocation: { type: "object" }, result: { type: "object" },
    }, required: ["request", "invocation", "result"], additionalProperties: false }] },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } },
  } }, events: {} }
}

// Serialized only into the independent fixture monitor. It has no production
// imports, and stays active while the production CLI is disabled/reloaded.
async function monitorSetup(ctx) {
  const { Rpc } = await import("@opencode/plugin/rpc")
  const rpc = ctx.client.rpc(Rpc.define(handshakeDefinition()))
  const result = { version: ctx.app.version, ready: true, replies: {}, forbidden: [], errors: [], cleaned: false }
  const publisher = observationPublisher(fixture.monitor)
  const save = () => publisher.publish(result)
  const abort = new AbortController()
  const location = { directory: fixture.project }
  const request = () => ({ location, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
  const off = ctx.data.listen(({ details }) => {
    if (["permission.asked", "permission.replied", "session.execution.started"].includes(details.type)) {
      result.forbidden.push(details.type); void save()
    }
  })
  let busy, seen = 0, stopped = false
  const run = async () => {
    const command = await readObservation(fixture.control, { optional: true })
    if (!command || command.id <= seen) return
    seen = command.id
    const reply = {}
    if (command.action === "status") {
      reply.plugins = await ctx.client.plugin.list({ location }, request())
      try { reply.handshake = await rpc.handshake(location, request()) }
      catch (error) { reply.failure = { type: error.type, message: String(error) } }
    } else if (command.action === "scope") {
      for (const [name, input] of Object.entries({ directory: { directory: fixture.project + "-wrong" },
        workspace: { ...location, workspaceID: "fixture-wrong-workspace" } })) {
        try { await rpc.handshake(input, request()); throw Error("Scope mismatch unexpectedly succeeded") }
        catch (error) { assert.equal(error.type, "scope"); reply[name] = error.type }
      }
    } else if (command.action === "pulse") {
      // An actual server event exercises every still-registered CLI listener.
      const session = await ctx.client.session.create({ title: "LIFECYCLE " + command.id, location }, request())
      reply.sessionID = session.id
    } else throw Error("Unknown lifecycle monitor command")
    result.replies[command.id] = reply
    await save()
  }
  const timer = setInterval(() => {
    if (busy || stopped) return
    busy = run().catch(error => { if (!stopped) result.errors.push(String(error)) })
      .finally(() => { busy = undefined; if (!stopped) void save() })
  }, 100)
  await save()
  return async () => {
    stopped = true; clearInterval(timer); abort.abort(); off()
    await busy
    result.cleaned = true; await save(); await publisher.close()
  }
}

// Serialized into a fixture-only embedding wrapper, never into the archive.
// All production behavior below is imported from the exact installed archive.
async function observeConnectionMarker(ctx, signal, result, save) {
  for await (const event of ctx.client.event.subscribe({ signal })) {
    signal.throwIfAborted()
    if (event.type !== "server.connected") continue
    assert.ok(typeof event.id === "string" && event.id.length > 0, "Actual public connection marker ID")
    result.publicConnection = { id: event.id }
    await save()
    return
  }
  signal.throwIfAborted()
  throw Error("Public connection stream ended without a connection marker")
}

async function observedSetup(ctx) {
  const cli = "ui" in ctx
  const control = await readObservation(fixture.control)
  const phase = cli ? control.cliPhase : control.serverPhase
  const instance = randomUUID()
  const result = { role: cli ? "cli" : "server", phase, instance, moduleURL: fixture.moduleURL,
    errors: [], events: [], ticks: 0, mounts: 0, unmounts: 0, cleanups: {}, aborted: false, cleaned: false }
  const publisher = observationPublisher(fixture.observations + "/" + result.role + "-" + phase + "-" + instance + ".json")
  const save = () => publisher.publish(result)
  const started = performance.now()
  const connections = cli && phase === "cold-startup" ? ctx.data.on("server.connected", event => {
    (result.connections ??= []).push({ id: event.id, received: performance.now() - started }); void save()
  }) : () => {}
  // A native echo may already have been delivered before plugin setup. Observe
  // the real public client's current marker independently, without delaying or
  // gating production setup or injecting/replaying any host events.
  const connectionAbort = new AbortController()
  const connectionRead = cli && phase === "cold-startup"
    ? observeConnectionMarker(ctx, connectionAbort.signal, result, save).catch(async error => {
      if (!connectionAbort.signal.aborted) { result.errors.push(String(error)); await save() }
    }) : Promise.resolve()
  const stopConnections = async () => { connections(); connectionAbort.abort(); await connectionRead }
  let life, cleanup
  // Override only public context members, retaining real host ownership for
  // slots, listeners, RPC and renderer. Response mutations are explicit controls.
  let context = ctx
  if (cli && (phase.startsWith("response-") || phase === "startup-recovery" || phase === "cold-startup")) {
    const client = new Proxy(ctx.client, { get(target, key) {
      if (key !== "rpc") return Reflect.get(target, key)
      return definition => {
        assert.deepEqual(definition, handshakeDefinition())
        const rpc = target.rpc(definition)
        return { ...rpc, handshake: async (...args) => {
          if (phase === "cold-startup") {
            const attempt = { started: performance.now() - started, startup: result.readyCalls === undefined }
            const attempts = result.handshakes ??= []
            attempts.push(attempt)
            try {
              const value = await rpc.handshake(...args)
              attempt.success = true
              return value
            } catch (error) {
              attempt.error = { type: error?.type, name: error?.name, message: String(error) }
              throw error
            } finally {
              attempt.finished = performance.now() - started
              attempt.aborted = args[1].signal.aborted
              await save()
            }
          }
          if (phase === "startup-recovery") {
            result.handshakeCalls = (result.handshakeCalls ?? 0) + 1
            if (result.handshakeCalls === 1) {
              const started = performance.now(), signal = args[1].signal
              await new Promise((_, reject) => {
                const aborted = () => {
                  result.firstHandshakeAborted = signal.aborted
                  result.firstHandshakeMs = performance.now() - started
                  reject(signal.reason)
                }
                signal.addEventListener("abort", aborted, { once: true })
                if (signal.aborted) aborted()
              })
            }
            return rpc.handshake(...args)
          }
          const actual = await rpc.handshake(...args)
          result.originalHandshake = actual
          const changed = structuredClone(actual)
          if (phase === "response-epoch") changed.epoch = "invalid-epoch"
          if (phase === "response-location") changed.location.directory += "-wrong"
          if (phase === "response-workspace") changed.location.workspaceID = "fixture-wrong-workspace"
          if (phase === "response-version") changed.hostVersion = ""
          if (phase === "response-protocol") changed.protocol = 2
          return changed
        } }
      }
    } })
    context = new Proxy(ctx, { get: (target, key) => key === "client" ? client : Reflect.get(target, key) })
  } else if (!cli) {
    const rpc = new Proxy(ctx.rpc, { get(target, key) {
      if (key !== "register") return Reflect.get(target, key)
      return async (definition, handlers) => {
        assert.deepEqual(definition, handshakeDefinition())
        result.schemaMatched = true
        return target.register(definition, handlers)
      }
    } })
    context = new Proxy(ctx, { get: (target, key) => key === "rpc" ? rpc : Reflect.get(target, key) })
  }
  const observer = async (ready, lifecycle) => {
    assert.equal(life, undefined, "One ready callback per setup")
    life = lifecycle
    result.readyCalls = (result.readyCalls ?? 0) + 1
    result.role = ready.role
    result.state = ready.state
    if (phase === "cold-startup") await save()
    assert.equal(ready.role, cli ? "cli" : "server")
    assert.equal(lifecycle.signal.aborted, false)
    lifecycle.signal.addEventListener("abort", () => { result.aborted = true }, { once: true })
    // Oldest cleanup publishes only after every actual resource was released.
    const pending = []
    lifecycle.addCleanup(async () => {
      await stopConnections()
      await Promise.all(pending)
      result.cleaned = true; await save(); await publisher.close()
    })
    const own = (name, release) => lifecycle.addCleanup(() => {
      if (!lifecycle.signal.aborted) result.errors.push("Cleanup before abort: " + name)
      result.cleanups[name] = (result.cleanups[name] ?? 0) + 1
      const task = Promise.resolve().then(release).catch(error => { result.errors.push(String(error)) })
      pending.push(task)
      return task
    })
    if (cli) {
      assert.deepEqual(ready.state.dependencies, {}, "User options cannot supply embedding dependencies")
      if (phase === "invalid-config") {
        assert.match(ready.state.configError, /Unknown opencode-reviewer setting: fileIO/)
        assert.equal(ready.state.config, undefined)
      } else {
        assert.equal(ready.state.configError, undefined)
        assert.equal(ready.state.config.baseURL, fixture.endpoint + "/review")
        assert.equal(ready.state.config.model, "lifecycle-sentinel")
        assert.equal(ready.state.config.autoApprove, true)
        assert.equal(ready.state.config.autoApproveDelaySeconds, 7)
        assert.equal(ready.state.config.maxFiles, 3)
        assert.equal(ready.state.config.stream, true)
        if (phase !== "cold-startup") assert.equal(ready.state.prompts.shell.instructions, "PHASE1 CUSTOM PROMPT")
        assert.ok(ready.state.prompts.edit.instructions.length > 0, "Absent overrides retain built-ins")
      }
      if (phase.startsWith("response-") || phase === "no-companion") assert.equal(ready.state.companion, undefined)
      else {
        assert.equal(ready.state.companion.protocol, 1)
        assert.equal(ready.state.companion.hostVersion, fixture.hostVersion)
        assert.equal(ready.state.companion.location.directory, fixture.project)
      }
      if (phase === "startup-recovery") {
        assert.equal(result.handshakeCalls, 2)
        assert.equal(result.firstHandshakeAborted, true)
        assert.ok(result.firstHandshakeMs >= 1400 && result.firstHandshakeMs < 5000)
        assert.ok(ready.state.runtime?.controller, "Recovery installs the actual production reviewer, not notification-only fallback")
        result.recoveredController = true
      }
      if (phase === "cold-startup") {
        const attempts = result.handshakes.filter(attempt => attempt.startup)
        assert.ok(ready.state.runtime?.controller, "Cold startup installs the production reviewer")
        assert.equal(attempts.length, 1, "Initial connection must not cancel a premature RPC")
        assert.equal(attempts[0].success, true)
      }
      const { TextRenderable } = await import("@opentui/core")
      const { onCleanup } = await import("solid-js")
      own("slot", ctx.ui.slot({ append: "home.footer", render: () => {
        result.mounts++
        onCleanup(() => { result.unmounts++; if (!result.cleaned) void save() })
        void save()
        return new TextRenderable(ctx.renderer, { id: "lifecycle-" + instance,
          content: "PHASE1 LIFECYCLE " + phase, fg: ctx.theme.text.base, height: 1 })
      } }))
      own("listener", ctx.data.on("session.created", event => {
        result.events.push(event.data.sessionID); void save()
      }))
    } else {
      assert.equal(ready.state.protocol, 1)
      assert.equal(ready.state.hostVersion, fixture.hostVersion)
      assert.equal(ready.state.location.directory, fixture.project)
    }
    const timer = setInterval(() => { result.ticks++; void save() }, 100)
    own("timer", () => clearInterval(timer))
    await save()
    if (phase === "partial-failure") throw Error("LIFECYCLE_EXPECTED_PARTIAL_FAILURE")
  }
  try {
    const plugin = production.withPluginSetup(observer)
    assert.equal(production.default.id, "opencode-reviewer")
    assert.equal(plugin.id, production.default.id)
    cleanup = await plugin.setup(context)
    assert.equal(typeof cleanup, "function")
    result.setupReturned = true
    await save()
  } catch (error) {
    await stopConnections()
    if (life) await life.settled()
    if (phase !== "partial-failure" || !String(error).includes("LIFECYCLE_EXPECTED_PARTIAL_FAILURE")) {
      // Cleanup may already have closed its publisher; report via a separate
      // owned error destination rather than attempting a post-close write.
      const failure = observationPublisher(fixture.observations + "/failure-" + instance + ".json")
      await failure.publish({ error: String(error), phase, role: result.role }); await failure.close()
    }
    if (!result.cleaned) { await save(); await publisher.close() }
    throw error
  }
  return async () => {
    await stopConnections()
    // Repeat the returned production cleanup to prove its idempotence as well
    // as the host's real disable/reload boundary.
    await Promise.all([cleanup(), cleanup()])
    await life.settled()
  }
}

const { scenario } = runtimeArguments("smoke-v2-lifecycle.mjs")
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
await mkdir("/tmp/opencode", { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-lifecycle-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-lifecycle-")
const runtime = await smokeRuntime(temp)
const env = smokeEnvironment(temp)
const host = process.env.OPENCODE_BIN ?? "opencode"
const project = path.join(temp, "project")
const cliPath = path.join(temp, "config/opencode/cli.json")
const observations = path.join(artifacts, "observations")
const controlPath = path.join(artifacts, "control.json")
const monitorPath = path.join(artifacts, "monitor.json")
const archiveFiles = ["dist/tui.js", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].sort()
const publishers = new Map()
const publish = async (file, value) => {
  let publisher = publishers.get(file)
  if (!publisher) { publisher = observationPublisher(file); publishers.set(file, publisher) }
  await publisher.publish(value); await publisher.flush()
}
const readMonitor = () => readObservation(monitorPath, { optional: true })
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-lifecycle")
const records = async (role, phase) => {
  const files = (await readdir(observations)).filter(name => name.startsWith(role + "-" + phase + "-") && name.endsWith(".json"))
  assert.ok(files.length <= 1, "Duplicate setup instance: " + role + "/" + phase)
  return files.length ? readObservation(path.join(observations, files[0])) : undefined
}
const registryRequests = []
const network = { modelPOSTs: 0, reviewPOSTs: 0, otherPOSTs: 0 }
let registry, sentinel, version
let control = { id: 0, cliPhase: scenario === "cold-startup" ? "cold-startup" : "default", serverPhase: "default" }
const quietCheck = async () => {
  const monitor = await readMonitor()
  if (monitor) { assert.deepEqual(monitor.errors, []); assert.deepEqual(monitor.forbidden, []) }
  assert.deepEqual(network, { modelPOSTs: 0, reviewPOSTs: 0, otherPOSTs: 0 })
  const failures = (await readdir(observations)).filter(name => name.startsWith("failure-") && name.endsWith(".json"))
  for (const file of failures) assert.fail(JSON.stringify(await readObservation(path.join(observations, file))))
}
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    await quietCheck()
    const value = await predicate()
    if (value) return value
    await sleep(100)
  } while (Date.now() < end)
  throw Error("Timed out waiting for " + label)
}
const command = async action => {
  control = { ...control, id: control.id + 1, action }
  await publish(controlPath, control)
  return until("monitor " + action, async () => (await readMonitor())?.replies[control.id])
}
const window = async () => { await sleep(800); await quietCheck() }
const walk = async (directory, prefix = "") => {
  const files = []
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), stat = await lstat(file)
    assert.equal(stat.isSymbolicLink(), false, "Archive install must not use source symlinks")
    if (stat.isDirectory()) files.push(...await walk(file, prefix + name + "/")); else files.push(prefix + name)
  }
  return files.sort()
}
try {
  version = execFileSync(host, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim()
  assertV2HostVersion(version)
  await mkdir(project)
  await mkdir(observations)
  await mkdir(path.dirname(cliPath), { recursive: true })
  execFileSync("git", ["init", "--quiet", project], { env, timeout: 10000 })
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.equal(manifest.name, "opencode-reviewer")
  assert.equal(manifest.engines.opencode, ">=2.0.0 <3")
  assert.deepEqual(manifest.exports, { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" })
  const npmOptions = { env: { ...env, npm_config_cache: path.join(temp, "npm-cache"), npm_config_ignore_scripts: "true" },
    encoding: "utf8", timeout: 60000 }
  // The caller builds first. This packs the repository unchanged and never
  // invokes prepack or constructs a substitute package.
  const packOutput = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", temp],
    { ...npmOptions, cwd: root }))
  const packed = Array.isArray(packOutput) ? packOutput : Object.values(packOutput)
  assert.equal(packed.length, 1)
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), archiveFiles)
  await publish(path.join(artifacts, "npm-pack.json"), packed)
  const archive = path.join(temp, packed[0].filename)
  assert.deepEqual(execFileSync("tar", ["-tzf", archive], { env, encoding: "utf8", timeout: 10000 }).trim().split("\n").sort(),
    archiveFiles.map(file => "package/" + file).sort())
  const install = path.join(temp, "installed")
  await mkdir(install)
  await publish(path.join(install, "package.json"), { name: "phase1-private-install", version: "0.0.0", private: true })
  execFileSync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--legacy-peer-deps", "--omit=optional", "--package-lock=false", archive],
    { ...npmOptions, cwd: install })
  const installed = path.join(install, "node_modules/opencode-reviewer")
  const verifyPackage = async directory => {
    assert.deepEqual(await walk(directory), archiveFiles)
    for (const file of archiveFiles) assert.deepEqual(await readFile(path.join(directory, file)), await readFile(path.join(root, file)))
  }
  await verifyPackage(installed)
  const archiveBytes = await readFile(archive)
  registry = createServer((request, response) => {
    registryRequests.push({ method: request.method, url: request.url })
    const json = (status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)) }
    if (request.method !== "GET") return json(405, { error: "Read-only lifecycle registry" })
    if (request.url === "/archive.tgz") { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(archiveBytes); return }
    const metadata = { ...manifest, dist: { tarball: `http://127.0.0.1:${registry.address().port}/archive.tgz`,
      shasum: packed[0].shasum, integrity: packed[0].integrity } }
    if (request.url === "/" + manifest.name) return json(200, { name: manifest.name,
      "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: metadata } })
    if (request.url === "/" + manifest.name + "/" + manifest.version) return json(200, metadata)
    json(404, { error: "Not the archived lifecycle package" })
  })
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve))
  sentinel = createServer((request, response) => {
    if (request.method === "POST") {
      const key = request.url.startsWith("/review/") ? "reviewPOSTs" : request.url.startsWith("/main/") ? "modelPOSTs" : "otherPOSTs"
      network[key]++
    }
    request.resume(); response.writeHead(503); response.end("No model requests belong in the lifecycle fixture")
  })
  await new Promise(resolve => sentinel.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${sentinel.address().port}`
  const promptDirectory = path.join(temp, "prompts")
  await mkdir(promptDirectory)
  await writeFile(path.join(promptDirectory, "PERMISSION-REVIEW-PROMPT.md"), "PHASE1 CUSTOM PROMPT\n")
  await writeFile(path.join(temp, ".npmrc"), `registry=http://127.0.0.1:${registry.address().port}/\nlegacy-peer-deps=true\nignore-scripts=true\naudit=false\nfund=false\n`)
  const fixture = { project, observations, control: controlPath, monitor: monitorPath, endpoint, hostVersion: version.slice("opencode v".length),
    moduleURL: pathToFileURL(path.join(installed, "dist/tui.js")).href }
  const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
  const prelude = helpers + '\nimport assert from "node:assert/strict"\nconst fixture = ' + JSON.stringify(fixture) + "\n"
    + handshakeDefinition.toString() + "\n" + observeConnectionMarker.toString() + "\n"
  const monitor = path.join(temp, "monitor"), wrapper = path.join(temp, "embedding")
  await mkdir(monitor); await mkdir(wrapper)
  await publish(path.join(monitor, "package.json"), { name: "lifecycle-monitor", type: "module", exports: { "./tui": "./tui.mjs" } })
  await writeFile(path.join(monitor, "tui.mjs"), prelude + monitorSetup.toString() + '\nexport default { id: "fixture.lifecycle.monitor", setup: monitorSetup }\n')
  await publish(path.join(wrapper, "package.json"), { name: "lifecycle-embedding", type: "module",
    exports: { ".": "./index.mjs", "./tui": "./tui.mjs" } })
  const embedded = prelude + '\nimport * as production from ' + JSON.stringify(fixture.moduleURL) + "\n" + observedSetup.toString()
    + '\nexport default { id: "opencode-reviewer", setup: observedSetup }\n'
  await writeFile(path.join(wrapper, "index.mjs"), embedded)
  await writeFile(path.join(wrapper, "tui.mjs"), embedded)
  for (const file of [path.join(monitor, "tui.mjs"), path.join(wrapper, "index.mjs"), path.join(wrapper, "tui.mjs")])
    execFileSync(process.execPath, ["--check", file], { env, timeout: 10000 })
  const target = manifest.name + "@" + manifest.version
  const options = { baseURL: endpoint + "/review", model: "lifecycle-sentinel", autoApprove: true,
    autoApproveDelaySeconds: 7, maxFiles: 3, stream: true, notify: false, notifySound: false, instructions: promptDirectory }
  if (scenario === "cold-startup") delete options.instructions
  const cliConfig = plugins => ({ animations: false, attention: { notifications: false, sound: false }, plugins })
  const serverConfig = plugins => ({ update: "disable", plugins, model: "fixture/fixture",
    providers: { fixture: { name: "Lifecycle sentinel", package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: endpoint + "/main" }, models: { fixture: { name: "Lifecycle sentinel" } } } } })
  const serverPath = path.join(project, "opencode.json")
  await publish(controlPath, control)
  await publish(serverPath, serverConfig([{ package: target, options }]))
  await publish(cliPath, cliConfig([{ package: scenario === "cold-startup" ? wrapper : target, options }, monitor]))
  await publish(path.join(artifacts, "setup.json"), { version, temp, archive, manifest, fixture,
    socket: runtime.socket, supervisorPID: runtime.supervisorPID })
  await runtime.start("-d", "-s", "v2-lifecycle", "-x", "160", "-y", "40", "-c", project, host, "--standalone", project)
  await until("independent CLI monitor", async () => (await readMonitor())?.ready)
  const initial = await until("default production companion", async () => {
    const status = await command("status")
    return status.handshake && status
  })
  assert.equal(initial.handshake.protocol, 1)
  assert.equal(initial.handshake.hostVersion, fixture.hostVersion)
  assert.equal(initial.handshake.location.directory, project)
  assert.match(initial.handshake.epoch, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
  const defaultInfo = initial.plugins.data.find(plugin => plugin.id === "opencode-reviewer")
  assert.equal(defaultInfo?.state.status, "active", "Default server stable ID is active")
  assert.equal(defaultInfo.features.server, true)
  assert.equal(defaultInfo.features.tui, true)
  assert.equal(defaultInfo.source.type, "package")
  let cold
  if (scenario === "cold-startup") {
    cold = await until("cold production CLI admission", async () => {
      const value = await records("cli", "cold-startup")
      assert.deepEqual(value?.errors ?? [], [])
      return value?.setupReturned && value.publicConnection && value
    })
    assert.equal(cold.state.connectionID, cold.publicConnection.id, "Startup admits the independently observed actual public marker")
    await window()
    cold = await records("cli", "cold-startup")
    assert.deepEqual(cold.errors, [])
    for (const echo of cold.connections ?? []) assert.equal(echo.id, cold.state.connectionID,
      "Any native connection echo delivered during setup is the same admitted marker")
    const log = await readFile(path.join(env.XDG_DATA_HOME, "opencode/log/opencode.log"), "utf8")
    assert.equal(log.split("\n").some(line => line.includes("http.url=/api/rpc/opencode-reviewer/handshake")
      && line.includes("http.status=499")), false, "Cold startup must not cancel an early handshake")
    // Subsequent lifecycle controls still exercise the normal custom prompts.
    options.instructions = promptDirectory
  }
  await command("scope")
  await window()
  await writeFile(path.join(artifacts, "default.txt"), capture())
  // Verify the host's isolated cache as well as the separately installed archive
  // imported by the embedding wrapper. Neither may contain a source symlink.
  const installations = []
  const findArchives = async directory => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue
      const child = path.join(directory, item.name)
      if (item.name === "opencode-reviewer") {
        try {
          const candidate = JSON.parse(await readFile(path.join(child, "package.json"), "utf8"))
          if (candidate.name === manifest.name) { await verifyPackage(child); installations.push(child); continue }
        } catch (error) { if (error.code !== "ENOENT") throw error }
      }
      await findArchives(child)
    }
  }
  await findArchives(path.join(temp, "cache"))
  assert.ok(installations.length, "Host downloaded the actual archive into its private cache")
  assert.ok(registryRequests.some(request => request.url === "/archive.tgz"))

  const setPhase = async (role, phase) => {
    control = { ...control, [role + "Phase"]: phase }
    await publish(controlPath, control)
  }
  const cliOn = async phase => {
    await setPhase("cli", phase)
    await publish(cliPath, cliConfig([{ package: wrapper, options: phase === "invalid-config" ? { ...options, fileIO: {} } : options }, monitor]))
    return until("CLI " + phase, async () => {
      const record = await records("cli", phase)
      if (!record) return
      assert.deepEqual(record.errors, [])
      return (phase === "partial-failure" ? record.cleaned : record.setupReturned && record.ticks >= 2) && record
    })
  }
  const cliOff = async phase => {
    await publish(cliPath, cliConfig(["*", "-opencode-reviewer", monitor]))
    const record = await until("CLI cleanup " + phase, async () => { const value = await records("cli", phase); return value?.cleaned && value })
    assert.equal(record.readyCalls, 1)
    assert.deepEqual(record.errors, [])
    assert.equal(record.aborted, true)
    assert.deepEqual(record.cleanups, { timer: 1, listener: 1, slot: 1 })
    assert.equal(record.mounts, record.unmounts)
    await command("pulse")
    await window()
    assert.deepEqual(await records("cli", phase), record, "Disabled instance is physically quiescent")
    assert.equal(capture().includes("PHASE1 LIFECYCLE"), false)
    return record
  }
  // Default server stays untouched throughout the first repeated CLI cycles.
  const cycles = []
  for (const phase of ["cycle-1", "cycle-2", "cycle-3", "startup-recovery"]) {
    const ready = await cliOn(phase)
    assert.equal(ready.state.companion.epoch, initial.handshake.epoch)
    await until("exactly one painted fixture slot", async () => {
      const screen = capture()
      return screen.split("PHASE1 LIFECYCLE " + phase).length === 2
    })
    const pulse = await command("pulse")
    await until("actual listener callback", async () => (await records("cli", phase))?.events.includes(pulse.sessionID))
    await window()
    assert.equal((await records("cli", phase)).events.filter(id => id === pulse.sessionID).length, 1)
    cycles.push(await cliOff(phase))
    assert.equal((await command("status")).handshake.epoch, initial.handshake.epoch)
  }
  for (const phase of ["invalid-config", "response-epoch", "response-location", "response-workspace", "response-version", "response-protocol", "partial-failure"]) {
    await cliOn(phase)
    await cliOff(phase)
    assert.equal((await command("status")).handshake.epoch, initial.handshake.epoch)
  }
  await publish(serverPath, serverConfig(["*", "-opencode-reviewer"]))
  await until("default companion RPC removed", async () => (await command("status")).failure?.type === "rpc.unavailable")
  await cliOn("no-companion")
  await cliOff("no-companion")
  const epochs = [initial.handshake.epoch]
  for (const phase of ["server-1", "server-2", "partial-failure"]) {
    await setPhase("server", phase)
    await publish(serverPath, serverConfig([{ package: wrapper, options }]))
    const record = await until("server " + phase, async () => {
      const value = await records("server", phase)
      return (phase === "partial-failure" ? value?.cleaned : value?.setupReturned) && value
    })
    assert.equal(record.schemaMatched, true)
    assert.deepEqual(record.errors, [])
    if (phase !== "partial-failure") {
      const status = await command("status")
      assert.equal(status.handshake.epoch, record.state.epoch)
      assert.ok(!epochs.includes(status.handshake.epoch), "Reload acquires a fresh server epoch")
      epochs.push(status.handshake.epoch)
    }
    await publish(serverPath, serverConfig(["*", "-opencode-reviewer"]))
    const final = await until("server cleanup " + phase, async () => { const value = await records("server", phase); return value?.cleaned && value })
    assert.equal(final.aborted, true)
    assert.equal(final.readyCalls, 1)
    assert.deepEqual(final.errors, [])
    assert.deepEqual(final.cleanups, { timer: 1 })
    await until("RPC registration disposed " + phase, async () => (await command("status")).failure?.type === "rpc.unavailable")
    await window()
    assert.deepEqual(await records("server", phase), final)
  }
  for (const record of cycles) assert.deepEqual(await records("cli", record.phase), record, "Earlier instances remain quiescent across later reloads")
  await publish(cliPath, cliConfig(["*", "-opencode-reviewer", "-fixture.lifecycle.monitor"]))
  await until("monitor cleanup", async () => (await readMonitor())?.cleaned)
  await publish(path.join(artifacts, "results.json"), { outcome: "pass", version, scenario, cold, archiveFiles, installations, epochs,
    cycles, registryRequests, network,
    assertions: ["Actual repository npm archive with unchanged five files and shared exports", "Default package configured in server and global CLI before embedding controls",
      ...(cold ? ["Real initial client/native marker identity admits one successful startup handshake without HTTP 499"] : []),
      "Public scoped protocol-1 handshake and exact archived RPC schema", "Production CLI option parsing and rejected user-config dependency key",
      "Three CLI disable/reload cycles retain server epoch", "Owned real slot/listener/timer cleanup after abort, repeated cleanup and partial setup failure",
      "A canceled first CLI handshake recovers to an actual production controller through a second scoped RPC",
      "Invalid epoch/location/workspace/version/protocol response controls", "Server unload removes RPC and reload creates new epoch",
      "Negative model/review POST and permission/execution event windows"],
    limits: ["Lifecycle and recovered production-controller construction only; no permission review, approval, notification or history activity is exercised.",
      "One standalone host and terminal; no shared-service, multi-terminal, disconnect or authoritative deletion proof.",
      cold ? "Cold CLI uses a read-only embedding observer of the installed archive and an independent public connection subscription. A native echo may precede observer registration; any delivered echo is checked against the admitted marker. Markers and RPC responses are not injected or delayed."
        : "Default CLI is loaded through global configuration; its inert setup has no public per-plugin completion observer.",
      "Response mismatch controls alter a real public handshake response in the fixture wrapper, not the server implementation.",
      "Startup recovery injects a first client-side read held until its real production timeout; it does not delay host initialization or exercise an active-runtime reconnect.",
      "Current with* helpers do not compose with withPluginSetup, so injected state.dependencies identity is not observable through the archive seam.",
      "No worker is acquired before production storage integration; the exported legacy worker probe is not production history coverage."] })
  console.log(`PASS V2 production archive lifecycle: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  try { await writeFile(path.join(artifacts, "failed.txt"), capture()) } catch { /* Host may not have started. */ }
  await publish(path.join(artifacts, "failure.json"), { version, temp, error: String(error), stack: error.stack, registryRequests, network })
  throw error
} finally {
  await runtime.dispose()
  for (const server of [registry, sentinel]) if (server) {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
  await Promise.all([...publishers.values()].map(publisher => publisher.close()))
}
