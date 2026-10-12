import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile, rm, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runtimeInventory, runtimeProfiles, runtimePlan, profilePlan, assertRuntimeHostVersion } from "./runtime-inventory.mjs"
import { publishObservation } from "./smoke-observations.mjs"
import { executeFixture } from "./runtime-runner.mjs"

const args = process.argv.slice(2)
if (args[0] === "--list") {
  assert.equal(args.length, 1)
  console.log(JSON.stringify({ ...runtimeInventory, "test-runtime.mjs": {
    ...runtimeInventory["test-runtime.mjs"], profiles: runtimeProfiles,
  } }, null, 2))
} else {
  const planning = args[0] === "--plan"
  if (planning) args.shift()
  const selected = args[0] === "--profile" ? (assert.equal(args.length, 2), profilePlan(args[1]))
    : [runtimePlan(args[0], args.slice(1))]
  if (planning) console.log(JSON.stringify(selected, null, 2))
  else {
    const root = fileURLToPath(new URL("../", import.meta.url))
    assert.ok(selected.every(item => item.classification !== "interactive"), "Run interactive desktop checks explicitly in your desktop terminal")
    // The runner is intentionally serial. A fixture may own two hosts itself.
    assert.ok(selected.every(item => item.hosts <= 2))
    const prerequisites = new Set(selected.flatMap(item => item.requires))
    for (const binary of ["git", "python3", "tmux", "tar", "bash"]) if (prerequisites.has(binary))
      execFileSync(binary, [binary === "tmux" ? "-V" : "--version"], { stdio: "pipe", timeout: 10000 })
    if (prerequisites.has("npm-pack")) execFileSync("npm", ["--version"], { stdio: "pipe", timeout: 10000 })
    if (prerequisites.has("source-sqlite")) await access(path.join(root, "src/history-schema.ts"))
    if (prerequisites.has("source-sqlite") || prerequisites.has("node-sqlite")) await import("node:sqlite")
    if (prerequisites.has("git-tag:v0.7.0")) execFileSync("git", ["rev-parse", "--verify", "refs/tags/v0.7.0^{commit}"], { cwd: root, stdio: "pipe" })
    let hostVersion
    if (selected.some(item => item.hosts)) {
      assert.equal(process.platform, "linux")
      const host = process.env.OPENCODE_BIN ?? "opencode"
      hostVersion = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
      assertRuntimeHostVersion(selected, hostVersion)
    }
    if (prerequisites.has("bundle")) await access(path.join(root, "dist/tui.js"))
    await mkdir(path.join(root, ".runtime"), { recursive: true })
    const lock = path.join(root, ".runtime/runtime-runner.lock")
    await mkdir(lock).catch(cause => { throw new Error(`Runtime runner already owned or lock unavailable: ${lock}`, { cause }) })
    let interrupted, directory
    const abort = new AbortController()
    const stop = signal => { interrupted = signal; abort.abort(new Error(signal)) }
    const onINT = () => stop("SIGINT"), onTERM = () => stop("SIGTERM")
    process.on("SIGINT", onINT); process.on("SIGTERM", onTERM)
    const results = []
    try {
      await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }))
      directory = await mkdtemp(path.join(root, ".runtime/runtime-run-"))
      for (const item of selected) {
        if (interrupted) break
        const start = Date.now(), output = [], log = path.join(directory, `${results.length + 1}.log`)
        console.log(`RUN ${item.id}`)
        const result = await executeFixture(process.execPath, [item.entrypoint, ...item.args], { cwd: root,
          signal: abort.signal, timeoutMs: item.timeoutMs, output: (chunk, channel) => { output.push(chunk); process[channel].write(chunk) } })
        await writeFile(log, Buffer.concat(output))
        const expectedFailure = item.flags.includes("fail-after-listen")
        const cleanupProof = !expectedFailure || /PASS post-listen cleanup/.test(Buffer.concat(output).toString())
        results.push({ ...item, defaultHostVersion: item.hostVersion, hostVersion: item.hosts ? hostVersion : item.hostVersion,
          ...result, durationMs: Date.now() - start, log,
          invocation: [process.execPath, item.entrypoint, ...item.args],
          status: result.code === (expectedFailure ? 1 : 0) && cleanupProof && !result.timedOut && !result.interrupted ? "passed" : "failed" })
        await publishObservation(path.join(directory, "results.json"), { profile: args[0] === "--profile" ? args[1] : undefined,
          hostVersion, nodeVersion: process.version, concurrency: "serial; at most two hosts", results })
        if (results.at(-1).status !== "passed") break
      }
      console.log(`Runtime results: ${directory}/results.json`)
      if (interrupted || results.length !== selected.length || results.some(item => item.status !== "passed")) process.exitCode = 1
    } finally {
      process.off("SIGINT", onINT); process.off("SIGTERM", onTERM)
      await rm(lock, { recursive: true, force: true })
    }
  }
}
