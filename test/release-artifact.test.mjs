import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { archiveIntegrity } from "../scripts/npm-publication.mjs"
import { expectedArtifact, inspectPackageArchive, loadReleaseArtifact, packageFiles, prepareReleaseArtifact, validateArtifactManifest } from "../scripts/release-artifact.mjs"
import { archiveFixture, artifactFixture, fixturePackage, highBitNumericArchiveFixture } from "./release-fixture.mjs"

async function directory(t) {
  const value = await mkdtemp(path.join(tmpdir(), "release-artifact-test-"))
  t.after(() => rm(value, { recursive: true, force: true }))
  return value
}
async function writeArtifact(t, bytes = archiveFixture(), options) {
  const root = await directory(t), fixture = artifactFixture(bytes, options)
  await writeFile(path.join(root, fixture.manifest.archive.filename), bytes)
  await writeFile(path.join(root, "release-manifest.json"), JSON.stringify(fixture.manifest))
  return { root, bytes, ...fixture }
}

test("artifact handoff verifies exact files, digest, version and validated workflow identity", async (t) => {
  const fixture = await writeArtifact(t)
  const loaded = await loadReleaseArtifact(fixture.root, expectedArtifact(fixture.env))
  assert.equal(loaded.pkg.version, "0.4.0")
  assert.ok(loaded.bytes.equals(fixture.bytes))
  assert.equal(loaded.tarball, path.join(fixture.root, fixture.manifest.archive.filename))
  assert.deepEqual([...inspectPackageArchive(loaded.bytes).files.keys()].sort(), packageFiles)
})

test("stale artifacts cannot override tag, commit, policy, run, attempt or digest outputs", async (t) => {
  const fixture = await writeArtifact(t)
  for (const [field, value] of [["tag", "v0.4.1"], ["packageVersion", "0.4.1"], ["commit", "c".repeat(40)],
    ["workflowCommit", "c".repeat(40)], ["runId", "456"], ["runAttempt", "2"], ["integrity", archiveIntegrity(Buffer.from("stale"))]]) {
    const expected = { ...fixture.expected, [field]: value }
    if (["tag", "packageVersion"].includes(field)) Object.assign(expected, { tag: "v0.4.1", packageVersion: "0.4.1" })
    await assert.rejects(loadReleaseArtifact(fixture.root, expected), /differs from validated workflow/)
  }
  assert.throws(() => expectedArtifact({ ...fixture.env, RELEASE_VERIFIED_TAG: "v0.4.1" }), /Requested tag differs/)
  assert.throws(() => expectedArtifact({ ...fixture.env, RELEASE_INTEGRITY: undefined }), /validated archive integrity/)
})

test("failed-publish reruns reuse only the artifact bound to the successful validation attempt", async (t) => {
  const fixture = await writeArtifact(t)
  const expected = expectedArtifact({ ...fixture.env, GITHUB_RUN_ATTEMPT: "2" })
  assert.equal(expected.runAttempt, "1", "the current publish rerun does not change the validated artifact identity")
  const loaded = await loadReleaseArtifact(fixture.root, expected)
  assert.equal(loaded.manifest.runAttempt, "1")
  await writeFile(path.join(fixture.root, "release-manifest.json"), JSON.stringify({ ...fixture.manifest, runAttempt: "2" }))
  await assert.rejects(loadReleaseArtifact(fixture.root, expected), /runAttempt differs from validated workflow/)
})

test("manifest schema rejects unknown fields, unsafe names, invalid counts and duplicate JSON fields", async (t) => {
  const fixture = await writeArtifact(t)
  for (const change of [
    (m) => { m.extra = "executable-helper" }, (m) => { m.version = 2 },
    (m) => { m.archive.filename = "../escape.tgz" }, (m) => { m.archive.bytes = -1 },
    (m) => { m.archive.bytes = 0 }, (m) => { m.archive.bytes = 1.5 },
    (m) => { m.archive.extra = "helper.mjs" }, (m) => { m.archive.integrity = "sha512-invalid" },
    (m) => { m.commit = "not-a-commit" }, (m) => { m.runAttempt = "01" },
  ]) {
    const manifest = structuredClone(fixture.manifest)
    change(manifest)
    assert.throws(() => validateArtifactManifest(manifest, fixture.expected))
  }
  await writeFile(path.join(fixture.root, "release-manifest.json"), JSON.stringify(fixture.manifest).replace('{"version":1,', '{"version":2,"version":1,'))
  await assert.rejects(loadReleaseArtifact(fixture.root, fixture.expected), /duplicate fields/)
})

test("artifact directories reject extra archives, executable helpers, nested files and symlinks", async (t) => {
  for (const extra of ["second.tgz", "publish.mjs", "nested"]) {
    const fixture = await writeArtifact(t)
    if (extra === "nested") await mkdir(path.join(fixture.root, extra))
    else await writeFile(path.join(fixture.root, extra), "unexpected")
    await assert.rejects(loadReleaseArtifact(fixture.root, fixture.expected), /exactly one archive/)
  }
  for (const file of ["release-manifest.json", "opencode-reviewer-0.4.0.tgz"]) {
    const fixture = await writeArtifact(t), target = path.join(fixture.root, file)
    const saved = await readFile(target)
    await rm(target)
    const savedPath = path.join(await directory(t), "saved")
    await writeFile(savedPath, saved)
    await symlink(savedPath, target)
    await assert.rejects(loadReleaseArtifact(fixture.root, fixture.expected))
  }
})

test("archive digest, byte count and internal package version are independently cross-checked", async (t) => {
  const fixture = await writeArtifact(t)
  await writeFile(path.join(fixture.root, fixture.manifest.archive.filename), Buffer.alloc(fixture.bytes.length))
  await assert.rejects(loadReleaseArtifact(fixture.root, fixture.expected), /digest differs/)
  await writeFile(path.join(fixture.root, fixture.manifest.archive.filename), fixture.bytes.subarray(0, -1))
  await assert.rejects(loadReleaseArtifact(fixture.root, fixture.expected), /size differs/)
  const stale = await writeArtifact(t, archiveFixture({ pkg: fixturePackage("0.4.1") }))
  await assert.rejects(loadReleaseArtifact(stale.root, stale.expected), /package version differs/)
})

test("actual archive parsing rejects extra, duplicate, linked, traversal and malformed tar members", () => {
  const original = inspectPackageArchive(archiveFixture())
  const entries = [...original.files].map(([file, content]) => ({ name: `package/${file}`, content }))
  for (const changed of [
    entries.slice(1), [...entries, entries[0]], [...entries, { name: "package/helper.mjs", content: "throw new Error('must not run')" }],
    [{ ...entries[0], name: "../LICENSE" }, ...entries.slice(1)],
    [{ ...entries[0], name: "/package/LICENSE" }, ...entries.slice(1)],
    [{ ...entries[0], type: "2", link: "/outside" }, ...entries.slice(1)],
    [{ ...entries[0], type: "1", link: "package/README.md" }, ...entries.slice(1)],
    [{ ...entries[0], type: "x" }, ...entries.slice(1)],
  ]) assert.throws(() => inspectPackageArchive(archiveFixture({ entries: changed })))
  const tar = gunzipSync(archiveFixture())
  tar[0] ^= 1
  assert.throws(() => inspectPackageArchive(gzipSync(tar)), /checksum/)
  assert.throws(() => inspectPackageArchive(gzipSync(gunzipSync(archiveFixture()).subarray(0, -512))), /end marker/)
  assert.throws(() => inspectPackageArchive(gzipSync(Buffer.concat([gunzipSync(archiveFixture()), Buffer.alloc(512, 1)]))), /end marker/)
  assert.throws(() => inspectPackageArchive(archiveFixture({ alterHeader(header) { header.write("0004644\0", 100) } })), /special mode/)
})

test("tar prefixes require the exact USTAR marker understood by npm's parser", () => {
  const entries = [...inspectPackageArchive(archiveFixture()).files].map(([name, content]) => ({ name, content }))
  const prefixed = archiveFixture({ entries, alterHeader(header) { header.write("package", 345) } })
  assert.deepEqual([...inspectPackageArchive(prefixed).files.keys()].sort(), packageFiles)
  for (const marker of [Buffer.alloc(8), Buffer.from("ustar  \0"), Buffer.from("ustar\0" + "01"), Buffer.from("notar\0" + "00")]) {
    const disagreement = archiveFixture({ entries, alterHeader(header) {
      header.write("package", 345)
      marker.copy(header, 257)
    } })
    assert.throws(() => inspectPackageArchive(disagreement), /npm-compatible USTAR magic and version/)
  }
  assert.throws(() => inspectPackageArchive(archiveFixture({ alterHeader(header) { header.fill(0, 257, 265) } })), /USTAR/)
})

test("checksummed size, checksum and mode fields reject high-bit bytes before ASCII decoding", () => {
  for (const field of ["size", "checksum", "mode"]) {
    const bytes = highBitNumericArchiveFixture(field), header = gunzipSync(bytes).subarray(0, 512)
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    assert.equal(Number.parseInt(header.subarray(148, 156).toString("ascii"), 8), checksum,
      "the fixture must bypass the old checksum check so raw numeric validation is exercised")
    assert.throws(() => inspectPackageArchive(bytes), /Unsupported tar numeric field encoding/)
  }
})

test("tar numeric fields reject base-256 and unsupported ASCII encodings with valid checksums", () => {
  for (const [offset, value] of [[124, 0x80], [100, 0xff], [124, 0x09], [124, 0x2d], [134, 0x38]]) {
    const bytes = archiveFixture({ alterHeader(header, index) { if (index === 0) header[offset] = value } })
    const header = gunzipSync(bytes).subarray(0, 512)
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    assert.equal(Number.parseInt(header.subarray(148, 156).toString("ascii"), 8), checksum)
    assert.throws(() => inspectPackageArchive(bytes), /Unsupported tar numeric field encoding/)
  }
})

test("package metadata is inspected as data and cannot request project dependency installation", () => {
  for (const change of [
    (pkg) => { pkg.name = "another-package" }, (pkg) => { pkg.exports["./tui"] = "./other.js" },
    (pkg) => { pkg.publishConfig.registry = "https://elsewhere.test" },
    (pkg) => { pkg.dependencies = { malicious: "1" } }, (pkg) => { pkg.optionalDependencies = { malicious: "1" } },
  ]) {
    const pkg = fixturePackage()
    change(pkg)
    assert.throws(() => inspectPackageArchive(archiveFixture({ pkg })))
  }
  const pkg = { ...fixturePackage(), scripts: { prepack: "exit 1", postinstall: "exit 1" } }
  assert.deepEqual(inspectPackageArchive(archiveFixture({ pkg })).pkg, pkg, "lifecycle text is never executed by archive inspection")
})

test("V2 archives retain five files and require the current engine contract and shared entrypoint", () => {
  const pkg = fixturePackage()
  assert.equal(inspectPackageArchive(archiveFixture({ pkg })).files.size, 5)
  for (const exports of [{ "./tui": "./dist/tui.js" }, { ...pkg.exports, "./server": "./dist/server.js" },
    { ...pkg.exports, "./extra": "./dist/tui.js" }])
    assert.throws(() => inspectPackageArchive(archiveFixture({ pkg: { ...pkg, exports } })))
  for (const target of [undefined, "1.18.35", "2.0.26", "2.0.28", ">=2.0.26", "^2.0.26", "2.0.26 || 2.0.28", "2.0.27-beta.1"])
    assert.throws(() => inspectPackageArchive(archiveFixture({ pkg: { ...pkg, engines: { ...pkg.engines, opencode: target } } })), /API generation/)
  for (const target of [undefined, ">=20", "22.22.2", ">=24"])
    assert.throws(() => inspectPackageArchive(archiveFixture({ pkg: { ...pkg, engines: { ...pkg.engines, node: target } } })), /Node runtime engine/)
})

test("archives reject top-level tags, arbitrary publication config and normalized npm versions", () => {
  for (const [change, expected] of [
    [(pkg) => { pkg.tag = "latest" }, /top-level tag/], [(pkg) => { pkg.tag = false }, /top-level tag/],
    [(pkg) => { pkg.publishConfig.tag = "latest" }, /only access and registry/],
    [(pkg) => { pkg.publishConfig["ignore-scripts"] = false }, /only access and registry/],
    [(pkg) => { pkg.publishConfig["fetch-retries"] = 2 }, /only access and registry/],
    [(pkg) => { pkg.publishConfig.provenanceFile = "/untrusted/provenance" }, /only access and registry/],
    [(pkg) => { pkg.publishConfig.cache = "/shared/cache" }, /only access and registry/],
    [(pkg) => { pkg.publishConfig.access = "restricted" }, /must be public/],
    [(pkg) => { pkg.publishConfig.registry = "https://elsewhere.test" }, /must be npm/],
    [(pkg) => { pkg.version = "0.4.0+build" }, /build metadata/],
    [(pkg) => { pkg.version = "0.5.0-beta.1+build" }, /build metadata/],
  ]) {
    const pkg = fixturePackage()
    change(pkg)
    assert.throws(() => inspectPackageArchive(archiveFixture({ pkg })), expected)
  }
})

test("invalid release identity or source publication fields reject before any pack attempt", async (t) => {
  const root = await directory(t), source = path.join(root, "source")
  await mkdir(source)
  const { expected } = artifactFixture()
  for (const [pkg, identity, error] of [
    [fixturePackage("0.4.0+build"), { ...expected, packageVersion: "0.4.0+build", tag: "v0.4.0+build" }, /build metadata/],
    [{ ...fixturePackage(), tag: "latest" }, expected, /top-level tag/],
    [{ ...fixturePackage(), publishConfig: { ...fixturePackage().publishConfig, tag: "latest" } }, expected, /only access and registry/],
    [fixturePackage("0.4.0+build"), expected, /build metadata/],
  ]) {
    await writeFile(path.join(source, "package.json"), JSON.stringify(pkg))
    let attempts = 0
    await assert.rejects(prepareReleaseArtifact(path.join(root, "artifact"), identity, { source, run: () => { attempts++ } }), error)
    assert.equal(attempts, 0)
  }
})

test("artifact preparation packs with scripts disabled and compares every actual member to source", async (t) => {
  const root = await directory(t), source = path.join(root, "source"), output = path.join(root, "artifact")
  await mkdir(path.join(source, "dist"), { recursive: true })
  const bytes = archiveFixture(), { files } = inspectPackageArchive(bytes), { expected } = artifactFixture(bytes)
  for (const [file, content] of files) await writeFile(path.join(source, file), content)
  let calls = 0
  const run = (command, args, options) => {
    calls++
    assert.equal(command, "npm")
    assert.deepEqual(args, ["pack", "--ignore-scripts", "--pack-destination", output])
    assert.equal(options.cwd, source)
    writeFileSync(path.join(output, "opencode-reviewer-0.4.0.tgz"), bytes)
  }
  const loaded = await prepareReleaseArtifact(output, expected, { source, run })
  assert.equal(calls, 1)
  assert.equal(loaded.manifest.archive.integrity, expected.integrity)
  await writeFile(path.join(source, "README.md"), "changed after validation")
  await assert.rejects(prepareReleaseArtifact(path.join(root, "mismatched"), expected, {
    source, run: (_, args) => writeFileSync(path.join(args.at(-1), "opencode-reviewer-0.4.0.tgz"), bytes),
  }), /Packed README.md differs/)
})
