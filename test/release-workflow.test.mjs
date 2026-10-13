import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { archiveFixture, artifactFixture, provenanceEnv } from "./release-fixture.mjs"
import { PUBLICATION_TIMEOUT_MS } from "../scripts/npm-publication.mjs"

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
const validate = workflow.split("\n  validate:\n")[1]?.split("\n  publish:\n")[0]
const publish = workflow.split("\n  publish:\n")[1]
const step = (job, name) => job.split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0]

test("release concurrency retains pending versions within GitHub's bounded queue", () => {
  assert.match(workflow, /\nconcurrency:\n  group: release-opencode-reviewer\n  cancel-in-progress: false\n  queue: max\n/)
})

test("read-only validation prepares the source-test temporary parent before tests", () => {
  const prepare = "      - run: mkdir -p /tmp/opencode\n"
  const tests = "      - run: npm run typecheck && npm test\n"
  assert.ok(validate.includes(prepare))
  assert.ok(validate.indexOf(prepare) < validate.indexOf(tests))
  assert.doesNotMatch(publish, /\/tmp\/opencode/)
})

test("workflow separates read-only validation from artifact-only privileged publication", () => {
  assert.ok(validate && publish)
  assert.match(workflow, /\nconcurrency:\n  group: release-opencode-reviewer\n  cancel-in-progress: false\n/)
  assert.match(validate, /permissions:\n      contents: read\n/)
  assert.doesNotMatch(validate, /id-token:|contents: write|secrets\.|GH_TOKEN|NODE_AUTH_TOKEN|npm publish/)
  assert.match(publish, /needs: validate\n/)
  assert.match(publish, /permissions:\n      contents: write\n      id-token: write\n/)
  assert.doesNotMatch(publish, /npm ci|npm (?:run|test|pack)|node --test|RELEASE_REF|\/test\/|\/src\/|package-lock\.json|package\.json/)
  assert.equal((publish.match(/uses: actions\/checkout@/g) ?? []).length, 1)
  const policy = step(publish, "Check out immutable publication policy only")
  assert.match(policy, /ref: \$\{\{ github\.workflow_sha \}\}/)
  assert.match(policy, /sparse-checkout-cone-mode: false/)
  assert.match(policy, /persist-credentials: false/)
  const paths = [...policy.matchAll(/^            (\/.+)$/gm)].map((match) => match[1])
  assert.deepEqual(paths, ["/scripts/release-version.mjs", "/scripts/release-artifact.mjs", "/scripts/release-provenance.mjs", "/scripts/publish-release.mjs",
    "/scripts/npm-publication.mjs", "/scripts/github-release.mjs"])
  assert.match(publish, /npm install --global npm@12\.2\.0 --ignore-scripts/)
  assert.match(step(publish, "Publish package and verify npm availability"), /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  assert.match(step(publish, "Create GitHub release and attach the verified archive"), /GH_TOKEN: \$\{\{ github\.token \}\}/)
})

test("workflow pins every action to the remotely verified release commit", () => {
  const verified = { checkout: "34e114876b0b11c390a56381ad16ebd13914f8d5", "setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
    "upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02", "download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093" }
  const actions = [...workflow.matchAll(/uses: actions\/([\w-]+)@(\S+)/g)]
  assert.equal(actions.length, 10)
  for (const [, name, sha] of actions) assert.equal(sha, verified[name])
})

test("publish job allows the full npm verification window plus setup and release upload", () => {
  const minutes = Number(publish.match(/^    timeout-minutes: (\d+)$/m)?.[1])
  assert.ok(minutes * 60000 >= PUBLICATION_TIMEOUT_MS + 15 * 60000)
  assert.doesNotMatch(step(publish, "Publish package and verify npm availability"), /timeout-minutes:|continue-on-error:/)
})

test("artifact transfer binds an immutable ID and manifest expectations to validation outputs", () => {
  assert.match(validate, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/)
  assert.match(validate, /integrity: \$\{\{ steps\.artifact\.outputs\.integrity \}\}/)
  for (const [env, output] of [["RELEASE_VERIFIED_TAG", "tag"], ["RELEASE_COMMIT", "commit"], ["RELEASE_VERSION", "version"],
    ["RELEASE_VALIDATION_ATTEMPT", "validation_attempt"], ["RELEASE_INTEGRITY", "integrity"]]) {
    assert.ok(publish.includes(`${env}: \${{ needs.validate.outputs.${output} }}`))
  }
  assert.match(workflow, /RELEASE_WORKFLOW_COMMIT: \$\{\{ github\.workflow_sha \}\}/)
  assert.match(workflow, /RELEASE_RUN_ID: \$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /RELEASE_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/)
  assert.match(workflow, /RELEASE_INPUT_TAG: \$\{\{ inputs\.tag \|\| '' \}\}/)
  assert.doesNotMatch(workflow, /(?:^|\n)\s+(?:GITHUB_SHA|GITHUB_REF|GITHUB_WORKFLOW_SHA|GITHUB_RUN_ATTEMPT):/)
  const upload = step(validate, "Upload immutable release artifact")
  assert.match(upload, /overwrite: false/)
  assert.match(upload, /if-no-files-found: error/)
  const download = step(publish, "Download validated archive by immutable artifact ID")
  assert.match(download, /artifact-ids: \$\{\{ needs\.validate\.outputs\.artifact_id \}\}/)
  assert.doesNotMatch(download, /run-id:|github-token:|pattern:/)
  const commands = [...publish.matchAll(/^        run: (.+)$/gm)].map((match) => match[1]).filter((command) => command !== "|")
  assert.deepEqual(commands, ["npm install --global npm@12.2.0 --ignore-scripts",
    'node release-policy/scripts/release-artifact.mjs verify "$RUNNER_TEMP/release-package"',
    'node release-policy/scripts/publish-release.mjs "$RUNNER_TEMP/release-package"',
    'node release-policy/scripts/github-release.mjs "$RUNNER_TEMP/release-package"'])
})

test("actual workflow shell commands pass one artifact directory even with spaces", () => {
  const commands = [...publish.matchAll(/^        run: (node .+)$/gm)].map((match) => match[1])
  for (const command of commands) {
    const output = execFileSync("bash", ["-c", `set -euo pipefail\nnode() { printf '%s\\n' "$@"; }\n${command}`], {
      encoding: "utf8", env: { ...process.env, RUNNER_TEMP: "/tmp/runner with spaces" },
    })
    const args = output.trim().split("\n")
    assert.equal(args.at(-1), "/tmp/runner with spaces/release-package")
    assert.equal(args.length, command.includes(" verify ") ? 3 : 2)
  }
})

test("publish job creates a private cache before npm and exports it to subsequent steps", async (t) => {
  const block = step(publish, "Create private job-local npm cache")
  assert.ok(block)
  assert.ok(publish.indexOf("Create private job-local npm cache") < publish.indexOf("Use an OIDC-capable npm CLI"))
  const command = block.split("\n        run: |\n")[1].split("\n").filter(Boolean).map((line) => line.slice(10)).join("\n")
  const root = await mkdtemp(path.join(tmpdir(), "release-private-cache-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const temp = path.join(root, "runner temp"), envFile = path.join(root, "github-env")
  await mkdir(temp)
  execFileSync("bash", ["-c", command], { env: { ...process.env, RUNNER_TEMP: temp, GITHUB_ENV: envFile }, stdio: "pipe" })
  const exported = Object.fromEntries((await readFile(envFile, "utf8")).trim().split("\n").map(line => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]
  }))
  const cache = exported.NPM_CONFIG_CACHE
  assert.equal(path.dirname(cache), temp)
  assert.ok((await lstat(cache)).isDirectory())
  assert.equal((await lstat(cache)).mode & 0o777, 0o700)
  assert.match(path.basename(cache), /^npm-release-cache\./)
  assert.equal(exported.XDG_DATA_HOME, path.join(cache, "xdg"))
  assert.equal((await lstat(exported.XDG_DATA_HOME)).mode & 0o777, 0o700)
})

test("validation gates dispatch branch and exact tag commit before exporting package identity", () => {
  const block = step(validate, "Check release version and tag commit")
  const command = block.split("\n        run: |\n")[1].split("\n").filter(Boolean).map((line) => line.slice(10)).join("\n")
  const record = `
    git() {
      if test "$1" = "show-ref"; then return 0; fi
      if test "$2" = "HEAD"; then printf '%s\\n' "$FIXTURE_HEAD"; else printf '%s\\n' "$FIXTURE_TAG_COMMIT"; fi
    }
    node() { printf '%s:%s:%s\\n' "$1" "$RELEASE_TAG" "$RELEASE_COMMIT"; }
  `
  const run = (overrides = {}) => execFileSync("bash", ["-c", `${record}\n${command}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", TRIGGER_REF: "refs/heads/main", DEFAULT_BRANCH: "main",
      RELEASE_TAG: "v0.4.0", FIXTURE_HEAD: "a".repeat(40), FIXTURE_TAG_COMMIT: "a".repeat(40), ...overrides },
  })
  assert.equal(run().trim(), `release-policy/scripts/release-version.mjs:v0.4.0:${"a".repeat(40)}`)
  assert.throws(() => run({ TRIGGER_REF: "refs/heads/other" }))
  assert.throws(() => run({ FIXTURE_TAG_COMMIT: "c".repeat(40) }))
})

test("artifact-only CLIs publish and attach the exact validated bytes without project files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "release-publish-cli-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = path.join(root, "artifact"), policy = path.join(root, "release-policy", "scripts")
  await mkdir(artifact)
  await mkdir(policy, { recursive: true })
  const bytes = archiveFixture(), { manifest, env } = artifactFixture(bytes)
  const tarball = path.join(artifact, manifest.archive.filename)
  await writeFile(tarball, bytes)
  await writeFile(path.join(artifact, "release-manifest.json"), JSON.stringify(manifest))
  for (const helper of ["release-version", "release-artifact", "release-provenance", "npm-publication", "publish-release", "github-release"]) {
    await writeFile(path.join(policy, `${helper}.mjs`), await readFile(new URL(`../scripts/${helper}.mjs`, import.meta.url)))
  }
  const setup = `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { readFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const bytes = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64");
    let submitted = false;
    childProcess.execFileSync = (command, args, options) => {
      if (command === process.execPath) {
        assert.equal(args.at(-1), "sign");
        const statement = JSON.parse(options.input);
        assert.equal(statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, "a".repeat(40));
        assert.equal(statement.predicate.buildDefinition.resolvedDependencies[1].digest.gitCommit, "b".repeat(40));
        return JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(options.input).toString("base64"), signatures: [{ sig: "offline" }] },
          verificationMaterial: { tlogEntries: [{}] } });
      }
      const file = command === "npm" ? args[1] : args[1] === "upload" ? args[3] : undefined;
      if (file) assert.ok(readFileSync(file).equals(bytes), "every upload reads exactly the validated archive");
      if (command === "npm") {
        const provenance = args[args.indexOf("--provenance-file") + 1];
        assert.ok(provenance.startsWith(process.env.RUNNER_TEMP + "/release-provenance-"));
        const bundle = JSON.parse(readFileSync(provenance));
        assert.ok(bundle.dsseEnvelope.payload);
        args = args.map(value => value === provenance ? "<signed-file>" : value);
      }
      submitted = true;
      console.log("WRITE " + JSON.stringify({ command, args }));
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url, init) => {
      const target = new URL(url);
      assert.equal(init.redirect, "error");
      console.log("READ " + target.pathname);
      if (target.origin === "https://api.github.com") return Response.json({ tag_name: target.pathname.endsWith("/latest") ? "v1.0.0" : "v0.4.0" });
      assert.equal(target.origin, "https://registry.npmjs.org");
      if (target.pathname.endsWith("/dist-tags")) return Response.json({ latest: "1.0.0" });
      if (target.pathname.endsWith(".tgz")) return new Response(bytes);
      assert.equal(target.pathname, "/opencode-reviewer/0.4.0");
      return submitted ? Response.json({ version: "0.4.0", dist: { integrity: ${JSON.stringify(env.RELEASE_INTEGRITY)},
        tarball: "https://registry.npmjs.org/opencode-reviewer/-/opencode-reviewer-0.4.0.tgz" } }) : new Response(null, { status: 404 });
    };
  `
  const run = (helper, override = {}) => execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(setup)}`,
    path.join(policy, `${helper}.mjs`), artifact], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...provenanceEnv(env), RUNNER_TEMP: root, GH_TOKEN: "fixture-token", ...override } })
  const writes = (output) => output.trim().split("\n").filter((line) => line.startsWith("WRITE ")).map((line) => JSON.parse(line.slice(6)))
  assert.deepEqual(writes(run("publish-release")), [{ command: "npm", args: ["publish", tarball, "--ignore-scripts", "--access", "public",
    "--provenance-file", "<signed-file>", "--tag", "archive", "--registry", "https://registry.npmjs.org/", "--fetch-retries=0"] }])
  assert.deepEqual(writes(run("github-release")), [
    { command: "gh", args: ["release", "upload", "v0.4.0", tarball, "--repo", "mightykatun/opencode-reviewer", "--clobber"] },
    { command: "gh", args: ["release", "edit", "v0.4.0", "--draft=false", "--prerelease=false", "--latest=false", "--repo", "mightykatun/opencode-reviewer"] },
  ])
  for (const helper of ["publish-release", "github-release"]) {
    assert.throws(() => run(helper, { RELEASE_COMMIT: "c".repeat(40) }), (error) => {
      assert.match(error.stderr.toString(), /differs from validated workflow/)
      assert.doesNotMatch(error.stdout.toString(), /READ |WRITE /)
      return true
    })
  }
  await writeFile(tarball, Buffer.alloc(bytes.length))
  assert.throws(() => run("github-release"), (error) => {
    assert.match(error.stderr.toString(), /digest differs/)
    assert.doesNotMatch(error.stdout.toString(), /READ |WRITE /)
    return true
  })
})
