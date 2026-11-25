import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { inspectPackageArchive, packageLayout } from "./release-artifact.mjs"
import { validatePublicationPackage } from "./release-version.mjs"
import { assertNoBundledSounds, verifyBundledSounds } from "./bundled-sounds.mjs"
import { assertNoBundledHistoryWorker, verifyBundledHistoryWorker } from "./bundled-history-worker.mjs"

validatePublicationPackage(JSON.parse(await readFile("package.json", "utf8")))
execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" })
const bundles = ["dist/server.js", "dist/tui.js"]
const digest = () => Promise.all(bundles.map(async file => createHash("sha256").update(await readFile(file)).digest("hex")))
const first = await digest()
execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" })
assert.deepEqual(await digest(), first, "two builds must produce identical bundles")
const bundle = await readFile("dist/tui.js", "utf8")
const sounds = Object.fromEntries(await Promise.all(["attention", "unsafe", "question", "approved", "error", "ended"]
  .map(async kind => [kind, await readFile(`sounds/${kind}.mp3`)])))
verifyBundledSounds(bundle, sounds)
const worker = verifyBundledHistoryWorker(bundle)
const server = await readFile("dist/server.js", "utf8")
assertNoBundledSounds(server)
assertNoBundledHistoryWorker(server)
assert.doesNotMatch(server, /mpeg_frame_decoder_create|solid-js|@opentui|@opencode\/theme/)
assert.ok(bundle.includes("mpeg_frame_decoder_create"), "MP3 decoding must be bundled in the terminal")
assert.ok(!bundle.includes('"worker_threads"'), "unused MP3 worker adapters must not enter the package")
assert.ok(worker.includes("bun:sqlite") && worker.includes("BEGIN IMMEDIATE"), "production history worker must be embedded")
const manifest = JSON.parse(await readFile("package.json", "utf8"))
const lock = JSON.parse(await readFile("package-lock.json", "utf8"))
assert.equal(lock.name, manifest.name, "lockfile name must match package.json")
assert.equal(lock.packages[""].name, manifest.name, "lockfile root name must match package.json")
assert.equal(lock.version, manifest.version, "lockfile version must match package.json")
assert.equal(lock.packages[""].version, manifest.version, "lockfile root version must match package.json")
const layout = packageLayout("2.9.0")
assert.deepEqual(manifest.exports, layout.exports)
assert.equal(manifest.publishConfig.access, "public")
assert.equal(manifest.publishConfig.registry, "https://registry.npmjs.org/")
const directory = await mkdtemp(path.join(tmpdir(), "reviewer-package-check-"))
try {
  const output = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { encoding: "utf8" }))
  // npm <=11 returns an array; npm 12 keys results by package name.
  const pack = Array.isArray(output) ? output[0] : output[manifest.name]
  assert.ok(pack?.files, "npm pack must report package contents")
  assert.equal(pack.name, manifest.name)
  assert.equal(pack.version, manifest.version)
  assert.equal(pack.filename, `${manifest.name}-${manifest.version}.tgz`)
  const archive = await readFile(path.join(directory, pack.filename))
  const { pkg, files } = inspectPackageArchive(archive, layout)
  verifyBundledSounds(files.get("dist/tui.js").toString("utf8"), sounds)
  verifyBundledHistoryWorker(files.get("dist/tui.js").toString("utf8"), worker)
  assert.deepEqual(pkg, manifest, "actual archive manifest must match package.json")
  assert.deepEqual(pack.files.map((file) => file.path).sort(), [...files.keys()].sort())
  for (const [file, bytes] of files) assert.ok(bytes.equals(await readFile(file)), `actual packed ${file} must match verified source`)
  for (const [index, file] of bundles.entries()) console.log(`${file}: ${files.get(file).length} bytes, reproducible SHA-256 ${first[index]}`)
  console.log(`Archive: ${archive.length} bytes, ${files.size} files, ${pack.unpackedSize} bytes unpacked`)
} finally { await rm(directory, { recursive: true, force: true }) }
