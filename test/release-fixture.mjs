import { gunzipSync, gzipSync } from "node:zlib"
import { archiveIntegrity } from "../scripts/npm-publication.mjs"

export const fixturePackage = (version = "0.4.0") => ({ name: "opencode-reviewer", version, type: "module", license: "MIT",
  exports: { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" },
  publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
  engines: { node: ">=22", opencode: ">=2.0.0 <3" } })

export function archiveFixture({ pkg = fixturePackage(), entries, alterHeader } = {}) {
  entries ??= ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/tui.js", "package.json"].map((file) => ({
    name: `package/${file}`, content: file === "package.json" ? JSON.stringify(pkg) : file === "dist/tui.js" ? "export default {}\n" : `${file} fixture\n`,
  }))
  const parts = []
  for (const [index, entry] of entries.entries()) {
    const header = Buffer.alloc(512), bytes = Buffer.from(entry.content)
    header.write(entry.name)
    header.write("0000644\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124)
    header.write("00000000000\0", 136)
    header.fill(32, 148, 156)
    header[156] = (entry.type ?? "0").charCodeAt(0)
    header.write(entry.link ?? "", 157)
    header.write("ustar\0", 257)
    header.write("00", 263)
    alterHeader?.(header, index)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148)
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
}

/** Valid checksum under the former ASCII interpretation, with one high-bit numeric digit. */
export function highBitNumericArchiveFixture(field) {
  const offset = { size: 134, mode: 106, checksum: 153 }[field]
  if (offset === undefined) throw new Error("Unknown numeric fixture field")
  const tar = gunzipSync(archiveFixture()), header = tar.subarray(0, 512)
  if (field !== "checksum") header[offset] |= 0x80
  const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148)
  if (field === "checksum") header[offset] |= 0x80
  return gzipSync(tar)
}

export function artifactFixture(bytes = archiveFixture(), { version = "0.4.0", ...overrides } = {}) {
  const expected = { name: "opencode-reviewer", packageVersion: version, tag: `v${version}`, commit: "a".repeat(40),
    workflowCommit: "b".repeat(40), runId: "123", runAttempt: "1", integrity: archiveIntegrity(bytes), ...overrides }
  const manifest = { version: 1, ...expected, archive: { filename: `opencode-reviewer-${version}.tgz`, bytes: bytes.length, integrity: expected.integrity } }
  delete manifest.integrity
  const env = { RELEASE_TAG: expected.tag, RELEASE_VERIFIED_TAG: expected.tag, RELEASE_VERSION: expected.packageVersion,
    RELEASE_COMMIT: expected.commit, RELEASE_WORKFLOW_COMMIT: expected.workflowCommit, RELEASE_RUN_ID: expected.runId,
    RELEASE_VALIDATION_ATTEMPT: expected.runAttempt, RELEASE_INTEGRITY: expected.integrity }
  return { expected, manifest, env }
}

export function provenanceEnv(env, overrides = {}) {
  return { ...env, GITHUB_ACTIONS: "true", GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "mightykatun/opencode-reviewer", GITHUB_REPOSITORY_ID: "12345", GITHUB_REPOSITORY_OWNER_ID: "6789",
    GITHUB_WORKFLOW_REF: "mightykatun/opencode-reviewer/.github/workflows/release.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: env.RELEASE_WORKFLOW_COMMIT, GITHUB_SHA: env.RELEASE_WORKFLOW_COMMIT,
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: env.RELEASE_RUN_ID,
    GITHUB_RUN_ATTEMPT: "2", RUNNER_ENVIRONMENT: "github-hosted", RELEASE_DEFAULT_BRANCH: "main",
    RELEASE_INPUT_TAG: env.RELEASE_TAG, ...overrides }
}
