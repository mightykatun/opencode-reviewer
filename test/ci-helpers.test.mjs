import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { requireReleaseCI } from "../scripts/release-ci.mjs"
import { runtimeSummary } from "../scripts/runtime-summary.mjs"
import { latestV2Host, verifyInstalledHost } from "../scripts/ci-host.mjs"

const identity = { repository: "owner/repo", commit: "a".repeat(40), branch: "main", token: "fixture" }
const run = overrides => ({ id: 10, head_sha: identity.commit, head_branch: "main", event: "push",
  status: "completed", conclusion: "success", ...overrides })
const response = runs => ({ ok: true, json: async () => ({ workflow_runs: runs }) })

test("release gate requires newest exact default-branch push CI and authenticates only to GitHub", async () => {
  const id = await requireReleaseCI(identity, { fetcher: async (url, options) => {
    assert.equal(url.origin, "https://api.github.com")
    assert.equal(url.searchParams.get("head_sha"), identity.commit)
    assert.equal(url.searchParams.get("branch"), "main")
    assert.equal(url.searchParams.get("event"), "push")
    assert.equal(options.redirect, "error")
    assert.equal(options.headers.Authorization, "Bearer fixture")
    return response([run({ id: 12 }), run({ id: 11 })])
  } })
  assert.equal(id, 12)
  for (const conclusion of ["failure", "cancelled", "skipped", null])
    await assert.rejects(requireReleaseCI(identity, { fetcher: async () => response([run({ id: 12, conclusion }), run({ id: 11 })]) }), /successful CI/)
})

test("release gate waits boundedly for matching CI, ignoring other commits, PRs and branches", async () => {
  let clock = 0, reads = 0
  const unrelated = [run({ head_sha: "b".repeat(40) }), run({ event: "pull_request" }), run({ head_branch: "feature" })]
  const options = { timeoutMs: 50, now: () => clock, sleep: async ms => { clock += ms },
    fetcher: async () => response(++reads === 1 ? unrelated : [run()]) }
  await assert.rejects(requireReleaseCI(identity, options), /Timed out/)
  assert.equal(reads, 1)
  clock = 0; reads = 0
  options.timeoutMs = 30000
  assert.equal(await requireReleaseCI(identity, options), 10)
  assert.equal(reads, 2)
})

test("release gate never accepts late successful reads, unavailable APIs or malformed replies", async () => {
  let clock = 0
  await assert.rejects(requireReleaseCI(identity, { timeoutMs: 50, now: () => clock,
    fetcher: async () => { clock = 51; return response([run()]) } }), /Timed out/)
  await assert.rejects(requireReleaseCI(identity, { fetcher: async () => ({ ok: false, status: 403 }) }), /HTTP 403/)
  await assert.rejects(requireReleaseCI(identity, { fetcher: async () => ({ ok: true, json: async () => ({}) }) }), /Invalid CI/)
  await assert.rejects(requireReleaseCI(identity, { fetcher: async () => response([run({ id: undefined })]) }), /Invalid CI run identity/)
})

test("release workflow gates read-only validation on exact CI without changing artifact-only publication", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  const gate = workflow.split("\n  ci:\n")[1].split("\n  validate:\n")[0]
  assert.match(gate, /actions: read/)
  assert.doesNotMatch(gate, /contents: write|id-token:|npm|secrets\./)
  assert.match(gate, /ref: \$\{\{ github\.workflow_sha \}\}/)
  assert.match(gate, /export RELEASE_COMMIT="\$\(git rev-parse HEAD\)"/)
  assert.match(gate, /node release-policy\/scripts\/release-ci\.mjs/)
  assert.match(workflow, /\n  validate:\n    needs: ci/)
  const publish = workflow.split("\n  publish:\n")[1]
  assert.doesNotMatch(publish, /release-ci|cache: npm/)
})

test("runtime summary reports measured totals and slowest cases without changing results", () => {
  const results = [{ id: "fast", status: "passed", durationMs: 1000 }, { id: "slow", status: "failed", durationMs: 59000 }]
  const before = structuredClone(results), summary = runtimeSummary(results)
  assert.match(summary, /2 completed cases; 1\.0 minutes/)
  assert.ok(summary.indexOf("| slow | failed | 59.0 |") < summary.indexOf("| fast | passed | 1.0 |"))
  assert.deepEqual(results, before)
  assert.match(runtimeSummary([]), /0 completed cases; 0\.0 minutes/)
})

test("runtime summary CLI tolerates pre-start failure and incomplete directories but rejects corrupt results", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-ci-summary-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = fileURLToPath(new URL("../scripts/runtime-summary.mjs", import.meta.url))
  const invoke = () => execFileSync(process.execPath, [cli], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  assert.equal(invoke(), "")
  const runDirectory = path.join(directory, ".runtime/runtime-run-fixture")
  await mkdir(runDirectory, { recursive: true })
  assert.equal(invoke(), "")
  const file = path.join(runDirectory, "results.json")
  const data = JSON.stringify({ results: [{ id: "fixture", status: "failed", durationMs: 1500 }] })
  await writeFile(file, data)
  assert.match(invoke(), /\| fixture \| failed \| 1\.5 \|/)
  assert.equal(await readFile(file, "utf8"), data)
  await writeFile(file, "{")
  assert.throws(invoke)
})

test("CI chooses the newest stable V2 regardless of dist-tags, excluding prereleases and V3", () => {
  const entry = version => ({ name: "@opencode/cli-linux-x64", version,
    dist: { integrity: `sha512-${"a".repeat(86)}==`, tarball: `https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${version}.tgz` } })
  const metadata = { name: "@opencode/cli-linux-x64", "dist-tags": { latest: "3.0.0" },
    versions: Object.fromEntries(["2.0.9", "2.0.10", "2.1.0", "2.2.0-beta.1", "3.0.0"].map(version => [version, entry(version)])) }
  const selected = latestV2Host(metadata)
  assert.equal(selected.version, "2.1.0")
  const installed = { ...selected, resolved: selected.tarball }
  const lock = value => ({ packages: { "node_modules/@opencode/cli-linux-x64": value } })
  verifyInstalledHost(lock(installed), selected)
  for (const key of ["version", "integrity", "resolved"]) assert.throws(() => verifyInstalledHost(lock({ ...installed, [key]: "wrong" }), selected))
  assert.throws(() => latestV2Host({ ...metadata, versions: { "3.0.0": entry("3.0.0") } }), /No stable OpenCode V2/)
  const malformed = structuredClone(metadata)
  malformed.versions["2.1.0"].dist.integrity = "sha1-unverified"
  assert.throws(() => latestV2Host(malformed))
})

test("history fixture sends native Ctrl+H rather than tmux's ambiguous Backspace byte", async () => {
  const { parseKeypress } = await import("@opentui/core")
  const legacy = parseKeypress("\x08"), extended = parseKeypress("\x1b[27;5;104~")
  assert.equal(legacy.name, "backspace")
  assert.equal(legacy.ctrl, false)
  assert.equal(extended.name, "h")
  assert.equal(extended.ctrl, true)
  const fixture = await readFile(new URL("../scripts/smoke-v2-review.mjs", import.meta.url), "utf8")
  assert.equal(fixture.split('runtime.tmux("send-keys", "-t", "v2-review", "-l", "\\x1b[27;5;104~")').length - 1, 2)
  assert.doesNotMatch(fixture, /runtime\.tmux\("send-keys", "-t", "v2-review", "C-h"\)/)
})
