import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir, mkdtemp, mkdir, copyFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import inventory from "../scripts/helper-tests.json" with { type: "json" }
import { runtimeInventory } from "../scripts/runtime-inventory.mjs"

const read = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")

test("PR CI is read-only, pinned, and checks the supported development Node floors", async () => {
  const workflow = await read(".github/workflows/ci.yml")
  assert.match(workflow, /\n  pull_request:\n/)
  assert.match(workflow, /\npermissions:\n  contents: read\n/)
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|id-token:|secrets\.|GH_TOKEN|NODE_AUTH_TOKEN|npm publish/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /node: \["22\.22\.2", "24\.15\.0"\]/)
  assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/)
  const pins = { checkout: "34e114876b0b11c390a56381ad16ebd13914f8d5", "setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
    "upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02" }
  const actions = [...workflow.matchAll(/uses: actions\/([\w-]+)@(\S+)/g)]
  assert.equal(actions.length, 5)
  for (const [, name, sha] of actions) assert.equal(sha, pins[name])
  const check = workflow.split("\n  runtime:\n")[0]
  const commands = [...check.matchAll(/^      - run: (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(commands, ["npm ci --ignore-scripts", "mkdir -p /tmp/opencode", "npm run check", "npm run check:package",
    "node --test test/release-artifact-smoke.test.mjs", "npm install --global npm@12.2.0 --ignore-scripts", "node --test test/npm-cli-smoke.test.mjs",
    "sudo apt-get update && sudo apt-get install --yes tmux", "npm run test:runtime-cleanup"])
  const runtime = workflow.split("\n  runtime:\n")[1]
  assert.deepEqual([...runtime.matchAll(/^      - run: (.+)$/gm)].map(m => m[1]), ["npm ci --ignore-scripts",
    "sudo apt-get update && sudo apt-get install --yes tmux git python3",
    'npm install --prefix "$RUNNER_TEMP/reviewer-host" --ignore-scripts --no-audit --no-fund "@opencode/cli-linux-x64@${{ matrix.host }}"',
    'echo "${{ matrix.sha256 }}  $OPENCODE_BIN" | sha256sum --check',
    "npm run build", "node scripts/test-runtime.mjs --profile ci"])
  assert.match(runtime, /if: always\(\)/)
  assert.match(runtime, /path: \.runtime\//)
  assert.match(runtime, /host: "2\.0\.26"\n\s+sha256: "d9123b9bcdb0a31f7ab9fe9812b58a9dc1768ad6d97e7b276dff1181813218c9"/)
  assert.match(runtime, /host: "2\.0\.27"\n\s+sha256: "e26aa101cfdc40f0e680baa609ff18f131bbc6b91c60fdc11b2b2e2cba7281a4"/)
  assert.match(runtime, /name: pinned-host-runtime-\$\{\{ matrix\.host \}\}/)
})

test("normal checks aggregate every pure helper while keeping host and built-package checks separate", async () => {
  const pkg = JSON.parse(await read("package.json")), lock = JSON.parse(await read("package-lock.json"))
  assert.equal(pkg.scripts["test:helpers"], "node scripts/test-helpers.mjs")
  assert.equal(pkg.scripts.check, "npm run typecheck && npm test && npm run test:helpers && npm run build")
  assert.equal(pkg.scripts["test:runtime-cleanup"], "node --test test/smoke-runtime.test.mjs")
  assert.equal(pkg.devEngines.runtime.version, "^22.22.2 || ^24.15.0")
  assert.equal(pkg.devEngines.runtime.onFail, "error")
  assert.equal(pkg.engines.node, ">=22", "development floors are independent of distributed runtime metadata")
  assert.equal(lock.packages[""].engines.node, pkg.engines.node)
  assert.equal(pkg.devDependencies["@opencode-ai/plugin"], "1.18.35")
  for (const name of ["@opencode/plugin", "@opencode/client", "@opencode/theme"]) assert.equal(pkg.devDependencies[name], "2.0.26")
  for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) assert.equal(pkg.devDependencies[name], "0.5.17")
  assert.equal(pkg.devDependencies["solid-js"], "1.9.15")
  const separate = new Set(["smoke-runtime.test.mjs", "release-artifact-smoke.test.mjs", "npm-cli-smoke.test.mjs"])
  const pure = (await readdir(new URL("./", import.meta.url))).filter((file) => file.endsWith(".test.mjs") && !separate.has(file))
    .map((file) => `test/${file}`).sort()
  assert.deepEqual([...inventory].sort(), pure, "the shared inventory must cover every current pure helper")
  for (const file of ["README.md", "AGENTS.md"]) {
    const docs = await read(file)
    assert.match(docs, /24\.15\.0\+/)
    assert.match(docs, /22\.22\.2\+/)
    assert.match(docs, /npm run test:helpers/)
  }
})

test("active release validation runs the same helper inventory with a complete sparse dependency closure", async t => {
  const workflow = await read(".github/workflows/release.yml")
  const validate = workflow.split("\n  validate:\n")[1].split("\n  publish:\n")[0]
  assert.match(validate, /node release-policy\/scripts\/test-helpers\.mjs/)
  assert.doesNotMatch(validate, /node --test test\/smoke-measurements\.test\.mjs/)
  const policy = validate.split("      - name: Check out active validation policy\n")[1].split("\n      - ")[0]
  for (const file of [...inventory, ...Object.keys(runtimeInventory).map(file => `scripts/${file}`), "scripts/test-helpers.mjs", "scripts/helper-tests.json", "scripts/smoke-runtime.mjs",
    "scripts/release-provenance.mjs", "scripts/bundled-sounds.mjs",
    "scripts/smoke-reviewer.mjs", "scripts/smoke-notification-recorder.mjs", "scripts/smoke-stages.mjs", "scripts/smoke-permissions.mjs", "scripts/smoke.mjs",
    "test/release-fixture.mjs", "test/npm-cli-smoke.test.mjs", "package.json", "package-lock.json", "README.md", "AGENTS.md", ".github/workflows/ci.yml"]) {
    assert.ok(policy.includes(`/${file}\n`), `active policy checkout must include ${file}`)
  }
  assert.match(policy, /ref: \$\{\{ github\.workflow_sha \}\}/)
  // Execute the planning entrypoints using only the actual sparse-checkout
  // files. A full local checkout otherwise hides missing transitive imports.
  const sparse = await mkdtemp(path.join(tmpdir(), "reviewer-sparse-policy-"))
  t.after(() => rm(sparse, { recursive: true, force: true }))
  for (const [, file] of policy.matchAll(/^\s+\/([^\s]+)$/gm)) {
    const destination = path.join(sparse, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(new URL(`../${file}`, import.meta.url), destination)
  }
  for (const [script, scenario] of [["smoke.mjs", "auto-shell"], ["smoke-permissions.mjs", "mcp"]]) {
    const plan = execFileSync(process.execPath, [path.join(sparse, "scripts", script), scenario, "--plan"], {
      cwd: sparse, encoding: "utf8", timeout: 10000, env: { ...process.env, OPENCODE_BIN: "/no-host-required" },
    })
    assert.equal(typeof JSON.parse(plan), "object")
  }
  const listing = execFileSync(process.execPath, [path.join(sparse, "scripts/test-runtime.mjs"), "--list"], {
    cwd: sparse, encoding: "utf8", env: { PATH: "", OPENCODE_BIN: "/no-host-required" },
  })
  assert.deepEqual(Object.keys(JSON.parse(listing)).sort(), Object.keys(runtimeInventory).sort())
  execFileSync(process.execPath, ["--test", path.join(sparse, "test/runtime-inventory.test.mjs"), path.join(sparse, "test/smoke-helpers.test.mjs")], {
    cwd: sparse, encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  })
  const publish = workflow.split("\n  publish:\n")[1]
  assert.doesNotMatch(publish, /test-helpers|helper-tests\.json|npm run check|npm run test/)
})
