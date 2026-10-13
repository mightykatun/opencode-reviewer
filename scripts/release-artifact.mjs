import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"
import { archiveIntegrity } from "./npm-publication.mjs"
import { npmReleaseVersion, validatePublicationPackage } from "./release-version.mjs"

export const packageFiles = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/tui.js", "package.json"]
const maxArchiveBytes = 16 * 1024 * 1024, maxUnpackedBytes = 64 * 1024 * 1024
const manifestFile = "release-manifest.json"
const json = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
const keys = (value, expected, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `Invalid ${label}`)
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `Unexpected ${label} fields`)
}
const sha = (value, label) => assert.match(value ?? "", /^[a-f0-9]{40}$/, `Invalid ${label}`)
const ordinal = (value, label) => assert.match(value ?? "", /^[1-9]\d*$/, `Invalid ${label}`)

/** Parse regular tar members in memory. No extraction, package imports or lifecycle scripts. */
export function inspectPackageArchive(bytes) {
  assert.ok(bytes.length > 0 && bytes.length <= maxArchiveBytes, "Archive size exceeds release bounds")
  const tar = gunzipSync(bytes, { maxOutputLength: maxUnpackedBytes })
  assert.equal(tar.length % 512, 0, "Truncated package tar archive")
  const files = new Map()
  const text = (field) => {
    const end = field.indexOf(0)
    if (end >= 0) assert.ok(field.subarray(end).every((byte) => byte === 0), "Invalid tar text padding")
    return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? field : field.subarray(0, end))
  }
  const octal = (field) => {
    // Buffer's ASCII decoder masks high bits; validate bytes before decoding so
    // size, checksum and mode agree with npm's UTF-8 tar numeric interpretation.
    assert.ok(field.every((byte) => byte === 0 || byte === 0x20 || byte >= 0x30 && byte <= 0x37), "Unsupported tar numeric field encoding")
    const value = field.toString("ascii").replace(/[\0 ]+$/, "").trim()
    assert.match(value, /^[0-7]+$/, "Invalid tar numeric field")
    const number = Number.parseInt(value, 8)
    assert.ok(Number.isSafeInteger(number), "Oversized tar numeric field")
    return number
  }
  let offset = 0, ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      assert.ok(tar.length - offset >= 1024 && tar.subarray(offset).every((byte) => byte === 0), "Invalid tar end marker")
      ended = true
      break
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    assert.equal(octal(header.subarray(148, 156)), checksum, "Invalid tar header checksum")
    assert.ok(header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00")), "Package tar headers require npm-compatible USTAR magic and version")
    assert.ok(header[156] === 0 || header[156] === 48, "Package members must be regular files")
    assert.equal(text(header.subarray(157, 257)), "", "Package members must not have link targets")
    assert.equal(octal(header.subarray(100, 108)) & 0o7000, 0, "Package members must not have special mode bits")
    const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100))
    const member = prefix ? `${prefix}/${name}` : name
    assert.ok(packageFiles.some((file) => member === `package/${file}`), `Unexpected package member: ${JSON.stringify(member)}`)
    const file = member.slice(8)
    assert.ok(!files.has(file), "Duplicate package member")
    const size = octal(header.subarray(124, 136)), start = offset + 512
    const next = start + Math.ceil(size / 512) * 512
    assert.ok(size > 0 && next <= tar.length, "Empty or truncated package member")
    assert.ok(tar.subarray(start + size, next).every((byte) => byte === 0), "Invalid tar member padding")
    files.set(file, tar.subarray(start, start + size))
    offset = next
  }
  assert.ok(ended, "Missing tar end marker")
  assert.deepEqual([...files.keys()].sort(), packageFiles, "Package must contain exactly the five intended files")
  const pkg = json(files.get("package.json"))
  validatePublicationPackage(pkg)
  assert.equal(pkg.type, "module")
  assert.equal(pkg.license, "MIT")
  assert.equal(pkg.engines?.node, ">=22", "Unexpected Node runtime engine")
  assert.equal(pkg.engines?.opencode, ">=2.0.0 <3", "Unexpected OpenCode API generation")
  assert.deepEqual(pkg.exports, { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" })
  assert.ok(!pkg.dependencies && !pkg.optionalDependencies, "Release package must not install project dependencies")
  return { pkg, files }
}

function identity(value) {
  assert.equal(value.name, "opencode-reviewer", "Unexpected release package")
  npmReleaseVersion(value.packageVersion)
  assert.equal(value.tag, `v${value.packageVersion}`, "Artifact tag must match its package version")
  sha(value.commit, "release commit")
  sha(value.workflowCommit, "workflow commit")
  ordinal(value.runId, "workflow run")
  ordinal(value.runAttempt, "validation attempt")
}

export function validateArtifactManifest(manifest, expected) {
  keys(manifest, ["version", "name", "packageVersion", "tag", "commit", "workflowCommit", "runId", "runAttempt", "archive"], "artifact manifest")
  assert.equal(manifest.version, 1, "Unsupported artifact manifest version")
  identity(manifest)
  identity(expected)
  for (const field of ["name", "packageVersion", "tag", "commit", "workflowCommit", "runId", "runAttempt"]) {
    assert.equal(manifest[field], expected[field], `Artifact ${field} differs from validated workflow outputs`)
  }
  keys(manifest.archive, ["filename", "bytes", "integrity"], "archive metadata")
  assert.equal(manifest.archive.filename, `${manifest.name}-${manifest.packageVersion}.tgz`, "Unexpected archive filename")
  assert.ok(Number.isSafeInteger(manifest.archive.bytes) && manifest.archive.bytes > 0 && manifest.archive.bytes <= maxArchiveBytes, "Invalid archive byte count")
  assert.match(manifest.archive.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, "Invalid archive integrity")
  assert.equal(manifest.archive.integrity, expected.integrity, "Artifact integrity differs from validated workflow output")
  return manifest
}

export function expectedArtifact(env = process.env, requireIntegrity = true) {
  assert.equal(env.RELEASE_TAG, env.RELEASE_VERIFIED_TAG, "Requested tag differs from validated workflow output")
  const expected = { name: "opencode-reviewer", packageVersion: env.RELEASE_VERSION, tag: env.RELEASE_TAG,
    commit: env.RELEASE_COMMIT, workflowCommit: env.RELEASE_WORKFLOW_COMMIT, runId: env.RELEASE_RUN_ID,
    runAttempt: env.RELEASE_VALIDATION_ATTEMPT, integrity: env.RELEASE_INTEGRITY }
  identity(expected)
  if (requireIntegrity) assert.match(expected.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, "Missing validated archive integrity")
  return expected
}

async function regularFile(file, limit) {
  const stat = await lstat(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, "Expected a bounded regular artifact file")
  const bytes = await readFile(file)
  assert.equal(bytes.length, stat.size, "Artifact file changed while reading")
  return bytes
}

export async function loadReleaseArtifact(directory, expected) {
  assert.ok((await lstat(directory)).isDirectory(), "Expected a regular artifact directory")
  const manifestBytes = await regularFile(path.join(directory, manifestFile), 16384)
  const decoded = json(manifestBytes)
  assert.equal(manifestBytes.toString("utf8"), JSON.stringify(decoded), "Artifact manifest must be canonical JSON without duplicate fields")
  const manifest = validateArtifactManifest(decoded, expected)
  assert.deepEqual((await readdir(directory)).sort(), [manifest.archive.filename, manifestFile].sort(), "Artifact must contain exactly one archive and its manifest")
  const tarball = path.resolve(directory, manifest.archive.filename)
  const bytes = await regularFile(tarball, maxArchiveBytes)
  assert.equal(bytes.length, manifest.archive.bytes, "Artifact archive size differs from its manifest")
  assert.equal(archiveIntegrity(bytes), manifest.archive.integrity, "Artifact archive digest differs from its manifest")
  const { pkg } = inspectPackageArchive(bytes)
  assert.equal(pkg.version, manifest.packageVersion, "Archive package version differs from its manifest")
  return { manifest, tarball, bytes, pkg }
}

export async function prepareReleaseArtifact(directory, expected, { run = execFileSync, source = process.cwd() } = {}) {
  identity(expected)
  const sourcePkg = validatePublicationPackage(json(await readFile(path.join(source, "package.json"))))
  assert.equal(sourcePkg.version, expected.packageVersion, "Source version differs from validated workflow output")
  await mkdir(directory, { recursive: true })
  assert.deepEqual(await readdir(directory), [], "Release artifact directory must be empty")
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", path.resolve(directory)], { cwd: source, stdio: "inherit" })
  const filename = `${expected.name}-${expected.packageVersion}.tgz`
  assert.deepEqual(await readdir(directory), [filename], "Packing must produce exactly one expected archive")
  const bytes = await regularFile(path.join(directory, filename), maxArchiveBytes)
  const { pkg, files } = inspectPackageArchive(bytes)
  assert.deepEqual(pkg, sourcePkg, "Packed manifest differs from validated source")
  assert.equal(pkg.version, expected.packageVersion, "Packed version differs from validated workflow output")
  for (const file of packageFiles) assert.ok(files.get(file).equals(await readFile(path.join(source, file))), `Packed ${file} differs from validated source`)
  const manifest = { version: 1, ...expected, archive: { filename, bytes: bytes.length, integrity: archiveIntegrity(bytes) } }
  delete manifest.integrity
  validateArtifactManifest(manifest, { ...expected, integrity: manifest.archive.integrity })
  await writeFile(path.join(directory, manifestFile), JSON.stringify(manifest), { flag: "wx", mode: 0o600 })
  return loadReleaseArtifact(directory, { ...expected, integrity: manifest.archive.integrity })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [mode, directory] = process.argv.slice(2)
  assert.ok(["prepare", "verify"].includes(mode) && directory && process.argv.length === 4, "Expected prepare|verify and one artifact directory")
  const artifact = mode === "prepare" ? await prepareReleaseArtifact(directory, expectedArtifact(process.env, false))
    : await loadReleaseArtifact(directory, expectedArtifact())
  if (mode === "prepare" && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `integrity=${artifact.manifest.archive.integrity}\n`)
  console.log(`Verified release artifact ${artifact.manifest.tag} at ${artifact.manifest.commit}: exactly five package files, matching digest and workflow identity`)
}
