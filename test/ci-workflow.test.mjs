import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir, mkdtemp, mkdir, copyFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import inventory from "../scripts/helper-tests.json" with { type: "json" }
import { runtimeInventory } from "../scripts/runtime-inventory.mjs"

const read = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")

test("extended host checks are explicitly manual, read-only, and use maintained Node majors and the latest stable V2", async () => {
  const workflow = await read(".github/workflows/ci.yml")
  assert.match(workflow, /^name: Extended host checks\n/)
  assert.match(workflow, /\non:\n  workflow_dispatch:\n/)
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request|schedule|workflow_run):/)
  assert.match(workflow, /\npermissions:\n  contents: read\n/)
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|id-token:|secrets\.|GH_TOKEN|NODE_AUTH_TOKEN|npm publish/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /node: \["22", "24"\]/)
  assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/)
  const pins = { checkout: "3d3c42e5aac5ba805825da76410c181273ba90b1", "setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1",
    "upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9" }
  const actions = [...workflow.matchAll(/uses: actions\/([\w-]+)@(\S+)/g)]
  assert.equal(actions.length, 6)
  for (const [, name, sha] of actions) assert.equal(sha, pins[name])
  const check = workflow.split("\n  check:\n")[1].split("\n  runtime:\n")[0]
  const commands = [...check.matchAll(/^      - run: (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(commands, ["npm ci --ignore-scripts", "mkdir -p /tmp/opencode", "npm run typecheck && npm test && npm run test:helpers", "npm run check:package",
    "node --test test/release-artifact-smoke.test.mjs", 'npm install --global --prefix "$RUNNER_TEMP/reviewer-npm" npm@12.2.0 --ignore-scripts --no-audit --no-fund',
    'echo "$RUNNER_TEMP/reviewer-npm/bin" >> "$GITHUB_PATH"', 'echo "NPM_CONFIG_PREFIX=$RUNNER_TEMP/reviewer-npm" >> "$GITHUB_ENV"',
    "node --test test/npm-cli-smoke.test.mjs",
    "sudo apt-get update && sudo apt-get install --yes tmux", "npm run test:runtime-cleanup"])
  const runtime = workflow.split("\n  runtime:\n")[1]
  assert.doesNotMatch(runtime.split("    steps:\n")[0], /\$\{\{\s*runner\./,
    "runner context is unavailable in job-level configuration")
  assert.deepEqual([...runtime.matchAll(/^      - run: (.+)$/gm)].map(m => m[1]), ["npm ci --ignore-scripts",
    "sudo apt-get update && sudo apt-get install --yes tmux git python3",
    'echo "OPENCODE_BIN=$RUNNER_TEMP/reviewer-host/node_modules/@opencode/cli-linux-x64/bin/opencode" >> "$GITHUB_ENV"',
    'node scripts/ci-host.mjs resolve',
    'npm install --prefix "$RUNNER_TEMP/reviewer-host" --ignore-scripts --no-audit --no-fund "@opencode/cli-linux-x64@$OPENCODE_HOST_VERSION"',
    'node scripts/ci-host.mjs verify "$RUNNER_TEMP/reviewer-host"',
    "npm run build", "node scripts/test-runtime.mjs --profile v2-acceptance"])
  assert.match(runtime, /if: always\(\)/)
  assert.match(runtime, /path: \.runtime\//)
  assert.doesNotMatch(runtime, /matrix:|matrix\.host|2\.0\.26|2\.0\.27/)
  assert.match(runtime, /name: latest-v2-runtime/)
  assert.match(runtime, /node-version: 24\n/)
  assert.equal([...workflow.matchAll(/runs-on: ubuntu-24\.04/g)].length, 3)
  assert.doesNotMatch(workflow, /ubuntu-latest/)
  assert.match(check, /needs: workflows/)
  assert.match(runtime, /needs: workflows/)
  for (const job of [check, runtime]) assert.match(job, /cache: npm\n\s+cache-dependency-path: package-lock\.json/)
  assert.match(runtime, /name: Report runtime durations\n\s+if: always\(\)\n\s+run: node scripts\/runtime-summary\.mjs >> "\$GITHUB_STEP_SUMMARY"/)
  const lint = await read("scripts/lint-workflows.sh")
  assert.match(workflow, /run: bash scripts\/lint-workflows\.sh/)
  assert.match(lint, /actionlint\/releases\/download\/v1\.7\.12/)
  assert.match(lint, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/)
  assert.match(lint, /sha256sum --check/)
  assert.match(lint, /"\$root\/\.github\/workflows\/ci\.yml" "\$root\/\.github\/workflows\/release\.yml"/)
  assert.match(lint, /dirname "\$\{BASH_SOURCE\[0\]\}"/)
  assert.match(lint, /--retry 3 --retry-delay 2 --retry-max-time 180/)
})

test("normal checks aggregate every pure helper while keeping host and built-package checks separate", async () => {
  const pkg = JSON.parse(await read("package.json")), lock = JSON.parse(await read("package-lock.json"))
  assert.equal(pkg.scripts["test:helpers"], "node scripts/test-helpers.mjs")
  assert.equal(pkg.scripts.check, "npm run typecheck && npm test && npm run test:helpers && npm run build")
  assert.equal(pkg.scripts["test:runtime-cleanup"], "node --test test/smoke-runtime.test.mjs")
  assert.equal(pkg.scripts["test:runtime"], "node scripts/test-runtime.mjs --profile v2-acceptance")
  assert.equal(pkg.scripts["test:runtime-permissions"], "node scripts/test-runtime.mjs --profile v2-permissions")
  assert.equal(pkg.devEngines.runtime.version, "^22.22.2 || ^24.15.0")
  assert.equal(pkg.devEngines.runtime.onFail, "error")
  assert.equal(pkg.engines.node, ">=22", "development floors are independent of distributed runtime metadata")
  assert.equal(lock.packages[""].engines.node, pkg.engines.node)
  assert.ok(!Object.keys(pkg.devDependencies).some(name => name.startsWith("@opencode-ai/")))
  assert.ok(!Object.keys(lock.packages).some(name => name.includes("node_modules/@opencode-ai/")))
  for (const name of ["@opencode/plugin", "@opencode/client", "@opencode/theme"]) {
    assert.equal(pkg.devDependencies[name], "^2.0.0")
    assert.match(lock.packages[`node_modules/${name}`].version, /^2\.\d+\.\d+$/)
  }
  assert.equal(lock.packages["node_modules/@opencode/client"].version, lock.packages["node_modules/@opencode/plugin"].version)
  for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) assert.equal(pkg.devDependencies[name], "0.6.6")
  assert.equal(pkg.devDependencies["solid-js"], "1.9.15")
  assert.equal(pkg.overrides.seroval, "1.6.3", "The patched serializer must also override peer-owned installations")
  const serializers = Object.entries(lock.packages).filter(([name]) => name === "node_modules/seroval" || name.endsWith("/node_modules/seroval"))
  assert.ok(serializers.length > 0)
  for (const [name, record] of serializers) assert.equal(record.version, "1.6.3", `${name} must resolve the patched serializer`)
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

test("active release validation uses a complete policy checkout without a manually maintained helper path list", async t => {
  const workflow = await read(".github/workflows/release.yml")
  const validate = workflow.split("\n  validate:\n")[1].split("\n  publish:\n")[0]
  assert.match(validate, /node release-policy\/scripts\/test-helpers\.mjs/)
  assert.doesNotMatch(validate, /node --test test\//)
  const policy = validate.split("      - name: Check out active validation policy\n")[1].split("\n      - ")[0]
  assert.match(policy, /ref: \$\{\{ github\.workflow_sha \}\}/)
  assert.match(policy, /path: release-policy/)
  assert.match(policy, /persist-credentials: false/)
  assert.doesNotMatch(policy, /sparse-checkout|filter:|\/scripts\/|\/test\//)
  assert.match(validate, /bash release-policy\/scripts\/lint-workflows\.sh/)
  // Model checkout's complete tree, including new uncommitted helper inputs.
  // No workflow path list needs updating when tests or helpers are added.
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-complete-policy-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" })
    .split("\0").filter(Boolean)
  for (const file of new Set(files)) {
    const destination = path.join(directory, file)
    await mkdir(path.dirname(destination), { recursive: true })
    try { await copyFile(new URL(`../${file}`, import.meta.url), destination) }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
  for (const profile of ["ci", "v2-acceptance", "v2-permissions"]) {
    const plan = execFileSync(process.execPath, [path.join(directory, "scripts/test-runtime.mjs"), "--plan", "--profile", profile], {
      cwd: directory, encoding: "utf8", timeout: 10000, env: { ...process.env, OPENCODE_BIN: "/no-host-required" },
    })
    assert.equal(typeof JSON.parse(plan), "object")
  }
  const listing = execFileSync(process.execPath, [path.join(directory, "scripts/test-runtime.mjs"), "--list"], {
    cwd: directory, encoding: "utf8", env: { PATH: "", OPENCODE_BIN: "/no-host-required" },
  })
  assert.deepEqual(Object.keys(JSON.parse(listing)).sort(), Object.keys(runtimeInventory).sort())
  execFileSync(process.execPath, ["--test", path.join(directory, "test/runtime-inventory.test.mjs"), path.join(directory, "test/smoke-helpers.test.mjs")], {
    cwd: directory, encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  })
  const publish = workflow.split("\n  publish:\n")[1]
  assert.doesNotMatch(publish, /test-helpers|helper-tests\.json|npm run check|npm run test/)
})
