import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { adaptThemeSyntax, themeSyntaxOnlyPlugin, verifyThemeSyntaxInputs, verifyThemeSyntaxBuild } from "../scripts/theme-syntax-adapter.mjs"

const manifest = {
  name: "@opencode/theme", version: "2.1.4",
  exports: { "./tui": { import: "./dist/tui/index.js" } },
  dependencies: { "@opentui/core": "0.6.8", effect: "4.0.1" },
}
// Independent published-input expectations, not imported adapter constants.
const digests = {
  "index.js": "70f5649897f56c66ab0cbf095915c68f6ac7a1e2089ff215504d0d77a347e317",
  "schema.js": "d958ce796a79a06449ad6f9083a106b72459c4aa5d37f1727f77936a406e2055",
  "syntax.js": "d31a110203ddfb4849440522951f82f02de1d5028f9a4174cfb45ee0a6e69358",
}

test("theme adapter admits only the reviewed package identity and exact public build inputs", () => {
  verifyThemeSyntaxInputs(manifest, digests)
  verifyThemeSyntaxInputs({ ...manifest, version: "2.99.99" }, digests)
  for (const mutate of [m => { m.name = "other" }, m => { m.version = "3.0.0" },
    m => { m.exports["./tui"].import = "./private.js" }, m => { delete m.exports },
    m => { m.dependencies.effect = "other" }, m => { m.dependencies["@opentui/core"] = "other" }]) {
    const changed = structuredClone(manifest); mutate(changed)
    assert.throws(() => verifyThemeSyntaxInputs(changed, digests), /Pinned theme package/)
  }
  for (const file of Object.keys(digests)) {
    assert.throws(() => verifyThemeSyntaxInputs(manifest, { ...digests, [file]: "0".repeat(64) }), /Pinned theme build input changed/)
    const missing = { ...digests }; delete missing[file]
    assert.throws(() => verifyThemeSyntaxInputs(manifest, missing), /Pinned theme build inputs changed/)
  }
  assert.throws(() => verifyThemeSyntaxInputs(manifest, { ...digests, "other.js": digests["syntax.js"] }), /Pinned theme build inputs changed/)
})

test("the build adapter hashes actual adjacent sources and rejects changed or missing installed files", async t => {
  const root = await mkdtemp("/tmp/opencode/reviewer-theme-adapter-")
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, "node_modules/@opencode/theme/dist/tui")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "../../package.json"), JSON.stringify(manifest))
  for (const file of Object.keys(digests)) await writeFile(path.join(directory, file), "unexpected upstream source")
  let filter, load
  themeSyntaxOnlyPlugin.setup({ onLoad(options, callback) { filter = options.filter; load = callback } })
  const barrel = path.join(directory, "index.js"), syntax = path.join(directory, "syntax.js")
  assert.ok(filter.test(barrel))
  assert.ok(filter.test(syntax))
  assert.ok(!filter.test(path.join(directory, "schema.js")))
  assert.ok(!filter.test(path.join(root, "src/review-description.tsx")))
  await assert.rejects(load({ path: barrel }), /Pinned theme build input changed: index.js/)
  await assert.rejects(load({ path: syntax }), /Pinned theme build input changed: index.js/)
  await rm(path.join(directory, "schema.js"))
  await assert.rejects(load({ path: barrel }), /ENOENT/)
  const upstream = await readFile(new URL("./syntax.js", import.meta.resolve("@opencode/theme/tui")), "utf8")
  const adapted = adaptThemeSyntax(upstream)
  assert.match(adapted, /^import \{ SyntaxStyle \} from "@opentui\/core";\nexport function generateSyntax\(theme, owner\) \{/)
  assert.equal(adapted, upstream)
  assert.match(adapted, /return SyntaxStyle\.fromTheme\(rules, owner\);/)
  assert.throws(() => adaptThemeSyntax(upstream.replace("generateSyntax(theme, owner)", "generateSyntax()")), /Pinned theme syntax source changed/)
  assert.throws(() => adaptThemeSyntax(upstream.replace("fromTheme(rules, owner)", "fromTheme(rules)")), /Pinned theme syntax source changed/)
})

test("theme adapter checks resolve installed inputs outside the active policy checkout", async t => {
  const root = await mkdtemp("/tmp/opencode/reviewer-theme-policy-")
  t.after(() => rm(root, { recursive: true, force: true }))
  const policy = path.join(root, "release-policy")
  const installed = path.join(root, "node_modules/@opencode/theme")
  await mkdir(path.join(policy, "test"), { recursive: true })
  await mkdir(path.join(policy, "scripts"))
  await mkdir(path.join(installed, "dist/tui"), { recursive: true })
  await copyFile(new URL(import.meta.url), path.join(policy, "test/theme-syntax-adapter.test.mjs"))
  await copyFile(new URL("../scripts/theme-syntax-adapter.mjs", import.meta.url), path.join(policy, "scripts/theme-syntax-adapter.mjs"))
  await writeFile(path.join(installed, "package.json"), JSON.stringify(manifest))
  await writeFile(path.join(installed, "dist/tui/index.js"), "export {}\n")
  await copyFile(new URL("./syntax.js", import.meta.resolve("@opencode/theme/tui")), path.join(installed, "dist/tui/syntax.js"))
  execFileSync(process.execPath, ["--test", "--test-name-pattern=^the build adapter hashes actual adjacent sources",
    "test/theme-syntax-adapter.test.mjs"], {
    cwd: policy, encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  })
})

const themePrefix = "node_modules/@opencode/theme/"
const buildInputs = (...extra) => ({ inputs: Object.fromEntries([
  `${themePrefix}dist/tui/index.js`, `${themePrefix}dist/tui/syntax.js`, "src/host-runtime.tsx", ...extra,
].map(input => [input, {}])) })

test("terminal metafile rejects unused Effect, theme parsers/schema, bypasses and duplicate installations", () => {
  verifyThemeSyntaxBuild(buildInputs())
  for (const file of ["dist/tui/schema.js", "dist/tui/resolve.js", "dist/tui/expand.js", "dist/tui/color.js", "private.js"]) {
    assert.throws(() => verifyThemeSyntaxBuild(buildInputs(themePrefix + file)), /Unexpected bundled theme input/)
  }
  for (const input of ["node_modules/effect/dist/Schema.js", "node_modules/@opencode/theme/node_modules/effect/dist/Schema.js"]) {
    assert.throws(() => verifyThemeSyntaxBuild(buildInputs(input)), /Unused Effect dependency/)
  }
  assert.throws(() => verifyThemeSyntaxBuild(buildInputs(`node_modules/other/${themePrefix}dist/tui/syntax.js`)), /Unexpected bundled theme input/)
  for (const file of ["dist/tui/index.js", "dist/tui/syntax.js"]) {
    const missing = buildInputs(); delete missing.inputs[themePrefix + file]
    assert.throws(() => verifyThemeSyntaxBuild(missing), /adapter was not used/)
  }
})
