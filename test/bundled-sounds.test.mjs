import { test } from "node:test"
import assert from "node:assert/strict"
import { assertNoBundledSounds, verifyBundledSounds, soundBanner } from "../scripts/bundled-sounds.mjs"
import { archiveFixture, fixturePackage } from "./release-fixture.mjs"
import { inspectPackageArchive, packageLayout } from "../scripts/release-artifact.mjs"

const layout = packageLayout("2.9.0")

const kinds = ["attention", "unsafe", "question", "approved", "error", "ended"]
const assets = Object.fromEntries(kinds.map(kind => [kind, Buffer.from(`independent ${kind} bytes`)]))
const mapping = () => Object.fromEntries(kinds.map(kind => [kind, { format: "mp3", data: assets[kind].toString("base64") }]))
const emit = value => `const __REVIEWER_BUNDLED_SOUNDS__ = ${JSON.stringify(value)};\nthrow new Error("never evaluate package code");\n`

test("sound mapping verification reads six exact associations as data in bundle and archive", () => {
  const bundle = emit(mapping())
  verifyBundledSounds(bundle, assets)
  assert.equal(soundBanner(mapping()), bundle.split("\n")[0])
  const files = inspectPackageArchive(archiveFixture({ pkg: fixturePackage("2.9.0") }), layout).files
  assertNoBundledSounds(files.get("dist/server.js").toString("utf8"))
  assert.throws(() => assertNoBundledSounds(bundle))
  files.set("dist/tui.js", Buffer.from(bundle))
  const archive = archiveFixture({ entries: [...files].map(([name, content]) => ({ name: `package/${name}`, content })) })
  verifyBundledSounds(inspectPackageArchive(archive, layout).files.get("dist/tui.js").toString("utf8"), assets)
})

test("missing, replaced and swapped unsafe/question associations fail even with correct decoy bytes", () => {
  for (const mutate of [
    m => { delete m.unsafe }, m => { delete m.question },
    m => { m.unsafe.data = assets.attention.toString("base64") },
    m => { m.question.data = assets.approved.toString("base64") },
    m => { [m.unsafe, m.question] = [m.question, m.unsafe] },
    m => { m.question.format = "wav" }, m => { m.unsafe.data += "!" },
    m => { m.extra = m.attention }, m => { m.question.extra = true },
  ]) {
    const value = mapping(); mutate(value)
    const bundle = emit(value) + `// decoy: ${JSON.stringify(mapping())}\n`
    assert.throws(() => verifyBundledSounds(bundle, assets))
    const files = inspectPackageArchive(archiveFixture({ pkg: fixturePackage("2.9.0") }), layout).files
    files.set("dist/tui.js", Buffer.from(bundle))
    const archive = archiveFixture({ entries: [...files].map(([name, content]) => ({ name: `package/${name}`, content })) })
    assert.throws(() => verifyBundledSounds(inspectPackageArchive(archive, layout).files.get("dist/tui.js").toString("utf8"), assets))
  }
})

test("duplicate mappings, duplicate JSON fields and executable initializers are rejected", () => {
  const bundle = emit(mapping())
  for (const invalid of [bundle + bundle, bundle.replace('{"attention":', '{"attention":{},"attention":'),
    bundle.replace(' = {', ' = globalThis.execute({'), `// ${bundle}`, "export default {}\n"]) {
    assert.throws(() => verifyBundledSounds(invalid, assets))
  }
})
