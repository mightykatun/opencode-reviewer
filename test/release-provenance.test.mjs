import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { archiveFixture, artifactFixture, provenanceEnv } from "./release-fixture.mjs"
import { attestStatement, releaseStatement, prepareProvenance, validateProvenanceBundle, signingDiagnostic } from "../scripts/release-provenance.mjs"

const fakeBundle = statement => ({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
  dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ sig: "offline-fixture" }] }, verificationMaterial: { tlogEntries: [{}] } })

test("manual provenance binds source bytes and commit independently of policy and signing attempt", () => {
  const bytes = archiveFixture(), { manifest, env } = artifactFixture(bytes)
  const context = provenanceEnv(env), before = structuredClone(context)
  const statement = releaseStatement(manifest, bytes, context)
  assert.deepEqual(statement.subject, [{ name: "pkg:npm/opencode-reviewer@0.4.0",
    digest: { sha512: createHash("sha512").update(bytes).digest("hex") } }])
  assert.equal(statement._type, "https://in-toto.io/Statement/v1")
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1")
  const { buildDefinition: build, runDetails: run } = statement.predicate
  assert.deepEqual(build.externalParameters, { workflow: { repository: "https://github.com/mightykatun/opencode-reviewer",
    path: ".github/workflows/release.yml", ref: "refs/heads/main" }, inputs: { tag: "v0.4.0" } })
  assert.deepEqual(build.resolvedDependencies, [
    { name: "workflow-policy", uri: "git+https://github.com/mightykatun/opencode-reviewer@refs/heads/main", digest: { gitCommit: "b".repeat(40) } },
    { name: "release-source", uri: "git+https://github.com/mightykatun/opencode-reviewer@refs/tags/v0.4.0", digest: { gitCommit: "a".repeat(40) } },
  ])
  assert.equal(run.builder.id, `https://github.com/mightykatun/opencode-reviewer/.github/workflows/release.yml@${"b".repeat(40)}`)
  assert.equal(run.metadata.invocationId, "https://github.com/mightykatun/opencode-reviewer/actions/runs/123/attempts/2")
  assert.deepEqual(build.internalParameters.release, { validationAttempt: "1", signingAttempt: "2",
    signingInvocationId: "https://github.com/mightykatun/opencode-reviewer/actions/runs/123/attempts/2" })
  assert.deepEqual(context, before, "constructing provenance must never rewrite GitHub identity")
})

test("tag-push provenance records the tag for both independently named inputs", () => {
  const bytes = archiveFixture(), { manifest, env } = artifactFixture(bytes, { workflowCommit: "a".repeat(40) })
  const context = provenanceEnv(env, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.4.0",
    GITHUB_SHA: "a".repeat(40), GITHUB_WORKFLOW_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_REF: "mightykatun/opencode-reviewer/.github/workflows/release.yml@refs/tags/v0.4.0", RELEASE_INPUT_TAG: "" })
  const build = releaseStatement(manifest, bytes, context).predicate.buildDefinition
  assert.equal(build.externalParameters.workflow.ref, "refs/tags/v0.4.0")
  assert.equal(build.externalParameters.inputs, undefined)
  assert.equal(build.resolvedDependencies.length, 2)
  assert.ok(build.resolvedDependencies.every(value => value.digest.gitCommit === "a".repeat(40)))
})

test("provenance rejects mismatched artifact, workflow, trigger and invocation identities", () => {
  const bytes = archiveFixture(), { manifest, env } = artifactFixture(bytes)
  for (const override of [
    { RELEASE_COMMIT: "c".repeat(40) }, { RELEASE_INTEGRITY: `sha512-${Buffer.alloc(64).toString("base64")}` },
    { RELEASE_VERIFIED_TAG: "v0.4.1" }, { GITHUB_WORKFLOW_SHA: "c".repeat(40) }, { GITHUB_SHA: "c".repeat(40) },
    { GITHUB_RUN_ID: "124" }, { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_RUN_ATTEMPT: "01" },
    { GITHUB_WORKFLOW_REF: "other/repo/.github/workflows/release.yml@refs/heads/main" },
    { GITHUB_REF: "refs/heads/other" }, { RELEASE_INPUT_TAG: "v0.4.1" }, { RELEASE_DEFAULT_BRANCH: "other" },
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_SERVER_URL: "https://elsewhere.test" },
    { RUNNER_ENVIRONMENT: "self-hosted" }, { GITHUB_REPOSITORY_ID: "" }, { GITHUB_ACTIONS: "false" },
  ]) assert.throws(() => releaseStatement(manifest, bytes, provenanceEnv(env, override)), JSON.stringify(override))
  assert.throws(() => releaseStatement(manifest, Buffer.alloc(bytes.length), provenanceEnv(env)), /digest/)
  const future = artifactFixture(bytes, { runAttempt: "3" })
  assert.throws(() => releaseStatement(future.manifest, bytes, provenanceEnv(future.env)), /attempt/)
})

test("returned signed envelope must retain the exact statement and in-toto payload type", () => {
  const bytes = archiveFixture(), { manifest, env } = artifactFixture(bytes)
  const statement = releaseStatement(manifest, bytes, provenanceEnv(env))
  assert.deepEqual(validateProvenanceBundle(fakeBundle(statement), statement), fakeBundle(statement))
  for (const mutate of [
    b => { b.dsseEnvelope.payloadType = "text/plain" }, b => { b.dsseEnvelope.payload = "!!!" },
    b => { b.dsseEnvelope.signatures = [] }, b => { b.verificationMaterial.tlogEntries = [] },
    b => { b.dsseEnvelope.payload = Buffer.from(JSON.stringify({ ...statement, subject: [] })).toString("base64") },
  ]) { const bundle = fakeBundle(statement); mutate(bundle); assert.throws(() => validateProvenanceBundle(bundle, statement)) }
})

test("signing is one bounded child using stdin and a private bundle outside the artifact", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "provenance test "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = archiveFixture(), { manifest, env } = artifactFixture(bytes)
  const context = provenanceEnv(env, { RUNNER_TEMP: root }), before = { ...context }
  const statement = releaseStatement(manifest, bytes, context)
  let calls = 0
  const lease = await prepareProvenance(statement, { env: context, run(command, args, options) {
    calls++
    assert.equal(command, process.execPath)
    assert.equal(args.at(-1), "sign")
    assert.ok(args[0].endsWith("/scripts/release-provenance.mjs"))
    assert.equal(options.timeout, 120000)
    assert.equal(options.killSignal, "SIGKILL")
    assert.equal(options.maxBuffer, 1024 * 1024)
    assert.deepEqual(JSON.parse(options.input), statement)
    assert.equal(options.env.GITHUB_SHA, "b".repeat(40))
    assert.equal(options.env.GITHUB_REF, "refs/heads/main")
    return JSON.stringify(fakeBundle(statement))
  } })
  assert.equal(calls, 1)
  assert.ok(lease.file.startsWith(`${root}${path.sep}`))
  assert.equal((await lstat(path.dirname(lease.file))).mode & 0o777, 0o700)
  assert.equal((await lstat(lease.file)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(lease.file, "utf8")), fakeBundle(statement))
  assert.deepEqual(context, before)
  await lease.dispose()
  assert.deepEqual(await readdir(root), [])
})

test("signing failure, timeout or altered payload never leaves a usable bundle or retries", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "provenance-failure-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const output of ["timeout", "bad json", JSON.stringify(fakeBundle({ subject: [] }))]) {
    let calls = 0
    await assert.rejects(prepareProvenance({ subject: ["expected"] }, { env: { RUNNER_TEMP: root }, run() {
      calls++
      if (output === "timeout") throw Object.assign(new Error("private token must not escape"), { code: "ETIMEDOUT" })
      return output
    } }))
    assert.equal(calls, 1)
    assert.deepEqual(await readdir(root), [])
  }
})

test("unverified npm installations reject before a signing dependency can be loaded", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wrong-signing-toolchain-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "npm", version: "12.1.0" }))
  await assert.rejects(attestStatement({}, { npmRoot: root }), error => error.diagnostic.stage === "toolchain")
})

test("signing diagnostics expose only fixed stages, allowlisted codes and HTTP status through bounded causes", () => {
  const secret = "PRIVATE_OIDC_TOKEN https://secret.invalid/?token=secret"
  const cause = Object.assign(Error(secret), { code: "ETIMEDOUT", statusCode: 503 })
  const error = Object.assign(Error(secret), { code: "CA_CREATE_SIGNING_CERTIFICATE_ERROR", cause })
  cause.cause = error
  assert.deepEqual(signingDiagnostic(error, "attestation"), {
    stage: "attestation", codes: ["CA_CREATE_SIGNING_CERTIFICATE_ERROR", "ETIMEDOUT"], statuses: [503],
  })
  let accessed = false
  const accessor = Object.defineProperty({}, "code", { get() { accessed = true; return secret } })
  assert.deepEqual(signingDiagnostic(accessor, secret), { stage: "input", codes: [], statuses: [] })
  assert.equal(accessed, false)
  assert.equal(JSON.stringify(signingDiagnostic({ code: secret, message: secret, stack: secret })).includes(secret), false)
})

test("parent reports safe signing failures but never dependency stderr or arbitrary diagnostic fields", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "signing-diagnostics-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const stderr of [JSON.stringify({ stage: "attestation", codes: ["IDENTITY_TOKEN_READ_ERROR"], statuses: [403] }),
    "PRIVATE_OIDC_TOKEN", JSON.stringify({ stage: "attestation", codes: ["PRIVATE_OIDC_TOKEN"], statuses: [] })]) {
    await assert.rejects(prepareProvenance({}, { env: { RUNNER_TEMP: root }, run() {
      throw Object.assign(Error("PRIVATE_OIDC_TOKEN"), { stderr })
    } }), error => {
      assert.doesNotMatch(error.message, /PRIVATE_OIDC_TOKEN/)
      if (stderr.includes("IDENTITY_TOKEN_READ_ERROR")) assert.match(error.message, /attestation.*IDENTITY_TOKEN_READ_ERROR.*HTTP 403/)
      else assert.equal(error.message, "Provenance signing failed; no upload was attempted")
      return true
    })
    assert.deepEqual(await readdir(root), [])
  }
})

test("the signing process deadline kills an uncooperative child before temporary ownership is released", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "stalled-signing-child-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let childPID, calls = 0
  await assert.rejects(prepareProvenance({}, { env: { RUNNER_TEMP: root }, run(command, args, options) {
    calls++
    assert.equal(options.timeout, 120000)
    // Substitute only the child workload and test duration. Exercise the real
    // execFileSync timeout/kill boundary without OIDC, a signing library or HTTP.
    try { return execFileSync(command, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeout: 50 }) }
    catch (error) { childPID = error.pid; assert.equal(error.signal, "SIGKILL"); throw error }
  } }), /120-second deadline/)
  assert.equal(calls, 1)
  assert.throws(() => process.kill(childPID, 0), { code: "ESRCH" })
  assert.deepEqual(await readdir(root), [])
})
