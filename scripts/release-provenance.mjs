import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expectedArtifact, validateArtifactManifest } from "./release-artifact.mjs"
import { archiveIntegrity } from "./npm-publication.mjs"

const payloadType = "application/vnd.in-toto+json"
const maxBundleBytes = 1024 * 1024
const workflowPath = ".github/workflows/release.yml"
const ordinal = value => assert.match(value ?? "", /^[1-9]\d*$/, "Invalid provenance invocation ordinal")

/** Build identity belongs to validation; signing can happen in a later publish-only rerun. */
export function releaseStatement(manifest, bytes, env = process.env) {
  validateArtifactManifest(manifest, expectedArtifact(env))
  assert.equal(bytes.length, manifest.archive.bytes, "Provenance archive size differs")
  assert.equal(archiveIntegrity(bytes), manifest.archive.integrity, "Provenance archive digest differs")
  assert.equal(env.GITHUB_ACTIONS, "true", "Provenance requires GitHub Actions")
  assert.equal(env.GITHUB_SERVER_URL, "https://github.com", "Unexpected provenance server")
  assert.equal(env.GITHUB_REPOSITORY, "mightykatun/opencode-reviewer", "Unexpected provenance repository")
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Provenance requires a GitHub-hosted runner")
  assert.equal(env.GITHUB_WORKFLOW_SHA, manifest.workflowCommit, "Provenance workflow policy differs")
  assert.equal(env.GITHUB_SHA, manifest.workflowCommit, "Unexpected top-level workflow trigger commit")
  assert.equal(env.GITHUB_RUN_ID, manifest.runId, "Provenance run differs from validation")
  for (const value of [env.GITHUB_RUN_ATTEMPT, env.GITHUB_REPOSITORY_ID, env.GITHUB_REPOSITORY_OWNER_ID]) ordinal(value)
  assert.ok(BigInt(env.GITHUB_RUN_ATTEMPT) >= BigInt(manifest.runAttempt), "Signing attempt precedes validation attempt")
  const sourceRef = `refs/tags/${manifest.tag}`
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    assert.ok(env.RELEASE_DEFAULT_BRANCH && !/[\s\x00-\x1f]/.test(env.RELEASE_DEFAULT_BRANCH), "Missing default branch")
    assert.equal(env.GITHUB_REF, `refs/heads/${env.RELEASE_DEFAULT_BRANCH}`, "Dispatch must use the default branch")
    assert.equal(env.RELEASE_INPUT_TAG, manifest.tag, "Dispatch input differs from validated tag")
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, "push", "Unsupported provenance event")
    assert.equal(env.GITHUB_REF, sourceRef, "Push ref differs from release source")
    assert.equal(env.GITHUB_SHA, manifest.commit, "Push commit differs from release source")
    assert.ok(!env.RELEASE_INPUT_TAG, "Push cannot supply dispatch inputs")
  }
  assert.equal(env.GITHUB_WORKFLOW_REF, `${env.GITHUB_REPOSITORY}/${workflowPath}@${env.GITHUB_REF}`, "Unexpected workflow identity")
  const repository = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`
  const invocation = attempt => `${repository}/actions/runs/${manifest.runId}/attempts/${attempt}`
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/${manifest.name}@${manifest.packageVersion}`, digest: { sha512: createHash("sha512").update(bytes).digest("hex") } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: { repository, path: workflowPath, ref: env.GITHUB_REF },
          ...(env.GITHUB_EVENT_NAME === "workflow_dispatch" ? { inputs: { tag: manifest.tag } } : {}),
        },
        internalParameters: {
          github: { event_name: env.GITHUB_EVENT_NAME, repository_id: env.GITHUB_REPOSITORY_ID, repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID },
          release: { validationAttempt: manifest.runAttempt, signingAttempt: env.GITHUB_RUN_ATTEMPT, signingInvocationId: invocation(env.GITHUB_RUN_ATTEMPT) },
        },
        resolvedDependencies: [
          // npm checks the first input against the signing certificate's actual
          // GitHub source identity. Keep the separately validated tag explicit.
          { name: "workflow-policy", uri: `git+${repository}@${env.GITHUB_REF}`, digest: { gitCommit: manifest.workflowCommit } },
          { name: "release-source", uri: `git+${repository}@${sourceRef}`, digest: { gitCommit: manifest.commit } },
        ],
      },
      runDetails: { builder: { id: `${repository}/${workflowPath}@${manifest.workflowCommit}` }, metadata: { invocationId: invocation(manifest.runAttempt) } },
    },
  }
}

/** Structural/payload check here; npm's verifyProvenance performs cryptographic verification before PUT. */
export function validateProvenanceBundle(bundle, statement) {
  assert.equal(bundle?.mediaType, "application/vnd.dev.sigstore.bundle.v0.3+json", "Unexpected Sigstore bundle format")
  assert.equal(bundle.dsseEnvelope?.payloadType, payloadType, "Unexpected provenance payload type")
  const payload = bundle.dsseEnvelope.payload
  assert.equal(typeof payload, "string", "Missing provenance payload")
  const bytes = Buffer.from(payload, "base64")
  assert.equal(bytes.toString("base64"), payload, "Invalid provenance payload encoding")
  assert.ok(bytes.equals(Buffer.from(JSON.stringify(statement))), "Signed provenance payload differs from verified statement")
  assert.ok(bundle.dsseEnvelope.signatures?.length === 1 && typeof bundle.dsseEnvelope.signatures[0].sig === "string"
    && bundle.dsseEnvelope.signatures[0].sig.length > 0, "Missing provenance signature")
  assert.ok(bundle.verificationMaterial?.tlogEntries?.length > 0, "Missing provenance transparency entry")
  return bundle
}

/** Only the pinned npm toolchain is loaded, never dependencies from the project/archive. */
export async function attestStatement(statement, { npmRoot } = {}) {
  npmRoot ??= path.join(execFileSync("npm", ["root", "--global"], { encoding: "utf8", timeout: 10000, maxBuffer: 16384 }).trim(), "npm")
  assert.ok(path.isAbsolute(npmRoot), "Expected an absolute npm installation")
  const pkg = JSON.parse(await readFile(path.join(npmRoot, "package.json"), "utf8"))
  assert.equal(pkg.name, "npm")
  assert.equal(pkg.version, "12.2.0", "Provenance requires pinned npm 12.2.0")
  const require = createRequire(path.join(npmRoot, "node_modules/libnpmpublish/lib/provenance.js"))
  assert.equal(require("sigstore/package.json").version, "5.0.0", "Unexpected pinned npm Sigstore toolchain")
  const bundle = await require("sigstore").attest(Buffer.from(JSON.stringify(statement)), payloadType,
    { tlogUpload: true, retry: 0, timeout: 10000 })
  return validateProvenanceBundle(bundle, statement)
}

/** A killable child bounds OIDC, signing and log I/O together; timeout never causes a retry. */
export async function prepareProvenance(statement, { env = process.env, run = execFileSync } = {}) {
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP), "Expected private runner temporary storage")
  const directory = await mkdtemp(path.join(env.RUNNER_TEMP, "release-provenance-"))
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    await chmod(directory, 0o700)
    let output
    try {
      output = run(process.execPath, [fileURLToPath(import.meta.url), "sign"], {
        input: JSON.stringify(statement), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env,
        timeout: 120000, killSignal: "SIGKILL", maxBuffer: maxBundleBytes,
      })
    } catch { throw new Error("Provenance signing failed or exceeded its 120-second deadline; no upload was attempted") }
    assert.ok(Buffer.byteLength(output) <= maxBundleBytes, "Oversized provenance bundle")
    const bundle = validateProvenanceBundle(JSON.parse(output), statement)
    const file = path.join(directory, "release.sigstore")
    await writeFile(file, JSON.stringify(bundle), { flag: "wx", mode: 0o600 })
    return { file, dispose }
  } catch (error) { await dispose(); throw error }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    assert.ok(process.argv.length === 3 && process.argv[2] === "sign", "Expected sign mode")
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      assert.ok(size <= 16384, "Oversized provenance statement")
      chunks.push(chunk)
    }
    const bundle = await attestStatement(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    process.stdout.write(JSON.stringify(bundle))
  } catch {
    // Signing dependencies may include OIDC tokens in error messages. Do not relay them.
    process.stderr.write("Provenance signing failed\n")
    process.exitCode = 1
  }
}
