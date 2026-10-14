import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runtimeSummary } from "../scripts/runtime-summary.mjs"
import { latestV2Host, verifyInstalledHost } from "../scripts/ci-host.mjs"
import { connectionProbe } from "../scripts/smoke-connection.mjs"

test("a version tag runs verification and artifact-only publication in one workflow without branch-CI polling or TUI prerequisites", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  assert.match(workflow, /\n  push:\n    tags:\n      - "v\*"\n/)
  assert.match(workflow, /\n  workflow_dispatch:\n/)
  assert.deepEqual([...workflow.matchAll(/^  (\w+):$/gm)].map(match => match[1]).filter(name => !["push", "workflow_dispatch"].includes(name)),
    ["validate", "publish"], "One verification job and one dependent publication job")
  assert.doesNotMatch(workflow, /workflow_run:|pull_request:|release-ci|Require exact default-branch CI|test-runtime|OPENCODE_BIN|tmux|continue-on-error:/)
  const validate = workflow.split("\n  validate:\n")[1].split("\n  publish:\n")[0]
  assert.doesNotMatch(validate, /needs:|contents: write|id-token:|secrets\.|GH_TOKEN|NODE_AUTH_TOKEN/)
  for (const check of ["bash release-policy/scripts/lint-workflows.sh", "npm run typecheck && npm test",
    "node release-policy/scripts/test-helpers.mjs", "npm run check:package",
    "node --test release-policy/test/release-artifact-smoke.test.mjs", "node --test release-policy/test/npm-cli-smoke.test.mjs"])
    assert.ok(validate.includes(check), `Required verification: ${check}`)
  const publish = workflow.split("\n  publish:\n")[1]
  assert.match(publish, /^    needs: validate$/m)
  assert.doesNotMatch(publish.split("    steps:\n")[0], /if:.*always\(/)
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

test("history uses portable Alt+H input and retains both legacy Backspace encodings", async () => {
  const { parseKeypress } = await import("@opentui/core")
  for (const sequence of ["\x1bh", "\x1b[27;3;104~", "\x1b[104;3u"]) {
    const key = parseKeypress(sequence, { useKittyKeyboard: true })
    assert.equal(key.name, "h")
    assert.equal(key.meta, true)
    assert.equal(key.ctrl, false)
    assert.equal(key.shift, false)
  }
  for (const sequence of ["\x08", "\x7f"]) {
    const key = parseKeypress(sequence)
    assert.equal(key.name, "backspace")
    assert.equal(key.ctrl, false)
    assert.equal(key.meta, false)
  }
  const fixture = await readFile(new URL("../scripts/smoke-v2-review.mjs", import.meta.url), "utf8")
  assert.equal(fixture.split('runtime.tmux("send-keys", "-t", "v2-review", "-l", "\\x1bh")').length - 1, 2)
  assert.match(fixture, /\[\["\\x08", "V2_HISTORY_INPUT_AB"\], \["\\x7f", "V2_HISTORY_INPUT_A"\]\]/)
  assert.doesNotMatch(fixture, /runtime\.tmux\("send-keys", "-t", "v2-review", "C-h"\)|\\x1b\[27;5;104~/)
})

test("connection barrier retires missed startup probes and requires exact real birth and deletion", async () => {
  let clock = 0, created = 0
  const removed = [], directory = "/fixture"
  const birth = id => ({ data: { sessionID: id, location: { directory } }, durable: { aggregateID: id } })
  const value = await connectionProbe({ directory,
    create: async () => ({ id: `probe${++created}` }), remove: async id => { removed.push(id) },
    observe: async () => ({ connectionBirths: [birth("sibling"), ...(created >= 2 ? [birth("probe2")] : [])],
      connectionDeletes: removed.map(sessionID => ({ data: { sessionID } })) }),
  }, { now: () => clock, pause: async ms => { clock += ms } })
  assert.deepEqual(value.attempts, ["probe1", "probe2"])
  assert.equal(value.sessionID, "probe2")
  assert.equal(value.birth.data.sessionID, "probe2")
  assert.equal(value.deletion.data.sessionID, "probe2")
  assert.deepEqual(removed, ["probe1", "probe2"])
})

test("connection barrier never substitutes snapshots, wrong location, missed deletion or late events", async () => {
  for (const failure of ["absent", "location", "aggregate", "deletion", "late"]) {
    let clock = 0, creates = 0, removes = 0
    await assert.rejects(connectionProbe({ directory: "/fixture", create: async () => ({ id: `probe${++creates}` }),
      remove: async () => { removes++ }, observe: async () => {
        if (failure === "late") clock = 100
        return { connectionBirths: failure === "absent" ? [] : [{ data: { sessionID: "probe1",
          location: { directory: failure === "location" ? "/wrong" : "/fixture" } },
          durable: { aggregateID: failure === "aggregate" ? "other" : "probe1" } }], connectionDeletes: [] }
      } }, { timeoutMs: 100, now: () => clock, pause: async ms => { clock += ms } }))
    assert.equal(creates, 1)
    assert.equal(removes, 1, "Each owned probe is retired exactly once, including failures")
  }
})

test("connection barrier includes native control calls in its original deadline and keeps late cleanup separate", async () => {
  let clock = 0
  const budgets = [], removed = [], directory = "/fixture"
  const birth = { data: { sessionID: "owned-probe", location: { directory } }, durable: { aggregateID: "owned-probe" } }
  const value = await connectionProbe({ directory,
    create: async budget => { budgets.push(budget); clock += 35; return { id: "owned-probe" } },
    remove: async (id, budget) => { removed.push(id); budgets.push(budget); clock += 25 },
    observe: async () => ({ connectionBirths: [birth], connectionDeletes: removed.map(sessionID => ({ data: { sessionID } })) }),
  }, { timeoutMs: 100, now: () => clock, pause: async ms => { clock += ms } })
  assert.deepEqual(budgets, [{ timeoutMs: 100 }, { timeoutMs: 65 }])
  assert.equal(value.sessionID, "owned-probe")
  assert.equal(clock, 60)
  budgets.length = 0; removed.length = 0; clock = 0
  await assert.rejects(connectionProbe({ directory,
    create: async budget => { budgets.push(budget); clock = 100; return { id: "owned-probe" } },
    remove: async (id, budget) => { removed.push(id); budgets.push(budget) },
    observe: async () => { assert.fail("No late event admission") },
  }, { timeoutMs: 100, now: () => clock, pause: async ms => { clock += ms } }), /Timed out/)
  assert.deepEqual(budgets, [{ timeoutMs: 100 }, undefined], "Late cleanup does not create a new admission window")
  assert.deepEqual(removed, ["owned-probe"])
})
