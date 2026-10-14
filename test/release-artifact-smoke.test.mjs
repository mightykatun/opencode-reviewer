import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire, isBuiltin } from "node:module"
import { packageFiles, inspectPackageArchive } from "../scripts/release-artifact.mjs"
import { archiveIntegrity } from "../scripts/npm-publication.mjs"
import { soundBanner, verifyBundledSounds } from "../scripts/bundled-sounds.mjs"
import { historyWorkerBanner, verifyBundledHistoryWorker } from "../scripts/bundled-history-worker.mjs"
import { archiveFixture } from "./release-fixture.mjs"

test("terminal payload excludes Effect/theme parsing, preserves public module mapping and upstream syntax semantics", async () => {
  const { parseSync } = createRequire(path.resolve("package.json"))("@babel/core")
  const parse = (source, sourceType) => parseSync(source, { sourceType, babelrc: false, configFile: false })
  const nodesOf = ast => {
    const nodes = []
    const walk = node => {
      if (!node || typeof node !== "object") return
      if (node.type) nodes.push(node)
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key)) continue
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === "object") walk(value)
      }
    }
    walk(ast.program)
    return nodes
  }
  const bundle = await readFile("dist/tui.js", "utf8")
  const outer = nodesOf(parse(bundle, "module"))
  const payloads = outer.filter(node => node.type === "CallExpression" && node.callee.type === "MemberExpression"
    && node.callee.object.name === "Buffer" && node.callee.property.name === "from"
    && node.arguments[0]?.type === "StringLiteral" && node.arguments[1]?.value === "base64")
  assert.equal(payloads.length, 1, "one fixed terminal payload must feed the CLI loader")
  const terminal = Buffer.from(payloads[0].arguments[0].value, "base64").toString("utf8")
  verifyBundledHistoryWorker(bundle)
  assert.doesNotMatch(bundle.slice(bundle.indexOf("\n", bundle.indexOf("\n") + 1) + 1), /node_modules\/(?:mpg123-decoder|@wasm-audio-decoders)\//)
  assert.equal(outer.filter(node => node.type === "VariableDeclarator" && node.id.name === "LinuxNotifications").length, 0)
  assert.doesNotMatch(terminal, /node_modules\/effect\/|Symbol\.for\(["']effect\//)
  assert.doesNotMatch(terminal, /@opencode\/theme\/dist\/tui\/(?:schema|resolve|expand|select|color|v1-migrate)\.js/)
  assert.doesNotMatch(terminal, /\b(?:ThemeDocument|parseThemeDocument|themeDecodeError)\b/)
  const nodes = nodesOf(parse(terminal, "script"))
  const requires = nodes.filter(node => node.type === "CallExpression" && node.callee.name === "require"
    && node.arguments[0]?.type === "StringLiteral").map(node => node.arguments[0].value)
  const hostModules = ["@opencode/plugin/rpc", "@opentui/core", "@opentui/solid", "solid-js"]
  assert.deepEqual([...new Set(requires.filter(name => !isBuiltin(name)))].sort(), hostModules)
  const imports = outer.filter(node => node.type === "CallExpression" && node.callee.type === "Import")
    .map(node => node.arguments[0]?.value).filter(name => hostModules.includes(name))
  assert.deepEqual([...new Set(imports)].sort(), hostModules)

  // Execute only the two extracted fixed helper functions with a recording
  // SyntaxStyle stub, never the package or terminal runtime. Compare every
  // upstream rule, foreground, background and flag, including categorical fallback.
  const functions = (all, source) => ["generateSyntax", "rule"].map(name => {
    const matches = all.filter(node => node.type === "FunctionDeclaration" && node.id.name === name)
    assert.equal(matches.length, 1, `one upstream ${name} function must remain`)
    return source.slice(matches[0].start, matches[0].end)
  }).join("\n")
  const syntax = await readFile("node_modules/@opencode/theme/dist/tui/syntax.js", "utf8")
  const coreReferences = nodes.filter(node => node.type === "MemberExpression" && node.property.name === "SyntaxStyle"
    && node.object.type === "Identifier")
  const generate = nodes.find(node => node.type === "FunctionDeclaration" && node.id.name === "generateSyntax")
  const syntaxCore = coreReferences.filter(node => node.start >= generate.start && node.end <= generate.end)
  assert.equal(syntaxCore.length, 1)
  const coreBinding = nodes.find(node => node.type === "VariableDeclarator" && node.id.name === syntaxCore[0].object.name)
  assert.equal(coreBinding?.init.callee.name, "require")
  assert.equal(coreBinding.init.arguments[0].value, "@opentui/core")
  let receivedOwner
  const SyntaxStyle = { fromTheme: (rules, owner) => { receivedOwner = owner; return rules } }
  const upstream = new Function("SyntaxStyle", `${functions(nodesOf(parse(syntax, "module")), syntax)}\nreturn generateSyntax`)(SyntaxStyle)
  const emitted = new Function(syntaxCore[0].object.name, `${functions(nodes, terminal)}\nreturn generateSyntax`)({ SyntaxStyle })
  const tokens = (names, prefix) => Object.fromEntries(names.split(" ").map(name => [name, `${prefix}.${name}`]))
  const theme = {
    syntax: tokens("comment string number keyword type function operator variable punctuation", "syntax"),
    markdown: tokens("heading strong emphasis listItem blockQuote code link linkText", "markdown"),
    text: { base: "text.base", muted: "text.muted", action: { primary: { focused: "action.focused" } },
      feedback: Object.fromEntries(["error", "warning", "info", "success"].map(kind => [kind, { base: `${kind}.base` }])) },
    background: { base: "background.base" }, hue: { accent: { 200: "hue.accent.200" } },
    diff: { text: tokens("added removed context", "diff.text"), background: tokens("added removed context", "diff.background") },
  }
  for (const categorical of [[{ 200: "first" }], [{ 200: "first" }, { 200: "second" }]]) {
    const owner = Symbol("nativeScene")
    const expected = upstream({ ...theme, categorical })
    assert.deepEqual(emitted({ ...theme, categorical }, owner), expected)
    assert.equal(receivedOwner, owner)
  }
})

test("the built audio constructor consumes the inspected mapping and actual bundle/archive mutations fail", async () => {
  const bundle = await readFile("dist/tui.js", "utf8")
  const assets = Object.fromEntries(await Promise.all(["attention", "unsafe", "question", "approved", "error", "ended"]
    .map(async kind => [kind, await readFile(`sounds/${kind}.mp3`)])))
  const sounds = verifyBundledSounds(bundle, assets)
  // Parse only, without evaluating any package code. Follow the emitted binding
  // to the production constructor default so a detached data banner cannot pass.
  const { parseSync } = createRequire(path.resolve("package.json"))("@babel/core")
  const outer = parseSync(bundle, { sourceType: "module", babelrc: false, configFile: false })
  const payload = bundle.match(/Buffer\.from\("([A-Za-z0-9+/=]{10000,})", "base64"\)/)
  assert.ok(payload, "fixed terminal payload must contain the sole audio implementation")
  const terminal = Buffer.from(payload[1], "base64").toString("utf8")
  const ast = parseSync(terminal, { sourceType: "script", babelrc: false, configFile: false })
  const nodes = []
  const walk = node => {
    if (!node || typeof node !== "object") return
    if (node.type) nodes.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key)) continue
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === "object") walk(value)
    }
  }
  walk(ast.program)
  const bindings = nodes.filter(node => node.type === "VariableDeclarator" && node.init?.type === "ConditionalExpression"
    && node.init.alternate?.name === "__REVIEWER_BUNDLED_SOUNDS__")
  assert.equal(bindings.length, 1, "the inspected object must feed one audio default binding")
  const audio = nodes.find(node => node.type === "VariableDeclarator" && node.id.name === "NotificationAudio")
  assert.equal(audio?.init.type, "ClassExpression")
  const constructor = audio.init.body.body.find(node => node.kind === "constructor")
  assert.ok(constructor.params.some(node => node.type === "AssignmentPattern" && node.left.name === "sounds"
    && node.right.name === bindings[0].id.name), "audio must consume the inspected mapping by default")
  nodes.length = 0; walk(outer.program)
  assert.equal(nodes.filter(node => node.type === "VariableDeclarator" && node.id.name === "NotificationAudio").length, 0)
  const loader = nodes.find(node => node.type === "CallExpression" && node.callee.type === "NewExpression" && node.callee.callee.name === "Function")
  assert.equal(loader.arguments[3].name, "__REVIEWER_BUNDLED_SOUNDS__", "sole audio backend receives the exact inspected mapping")
  const originalFiles = new Map(await Promise.all(packageFiles.map(async file => [file, await readFile(file)])))
  for (const mutate of [s => { delete s.unsafe }, s => { delete s.question },
    s => { s.unsafe = s.approved }, s => { s.question = s.attention },
    s => { [s.unsafe, s.question] = [s.question, s.unsafe] }]) {
    const changed = structuredClone(sounds); mutate(changed)
    const invalid = soundBanner(changed) + bundle.slice(bundle.indexOf("\n"))
    assert.throws(() => verifyBundledSounds(invalid, assets))
    const files = new Map(originalFiles); files.set("dist/tui.js", Buffer.from(invalid))
    const archive = archiveFixture({ entries: [...files].map(([name, content]) => ({ name: `package/${name}`, content })) })
    assert.throws(() => verifyBundledSounds(inspectPackageArchive(archive).files.get("dist/tui.js").toString("utf8"), assets))
  }
})

test("the actual bundle and archive share one worker source and reject changed consumers", async () => {
  const bundle = await readFile("dist/tui.js", "utf8")
  const source = verifyBundledHistoryWorker(bundle)
  const originalFiles = new Map(await Promise.all(packageFiles.map(async file => [file, await readFile(file)])))
  for (const invalid of [
    bundle.replace(historyWorkerBanner(source), ""),
    bundle + `\n${historyWorkerBanner(source)}`,
    bundle.replace(historyWorkerBanner(source), historyWorkerBanner("replacement")),
    bundle.replace('module.exports, __REVIEWER_BUNDLED_SOUNDS__, __REVIEWER_HISTORY_WORKER__', 'module.exports, __REVIEWER_BUNDLED_SOUNDS__, "replacement"'),
  ]) {
    assert.notEqual(invalid, bundle)
    assert.throws(() => verifyBundledHistoryWorker(invalid, source))
    const files = new Map(originalFiles); files.set("dist/tui.js", Buffer.from(invalid))
    const archive = archiveFixture({ entries: [...files].map(([name, content]) => ({ name: `package/${name}`, content })) })
    assert.throws(() => verifyBundledHistoryWorker(inspectPackageArchive(archive).files.get("dist/tui.js").toString("utf8"), source))
  }
})

const outputs = (text) => Object.fromEntries(text.trim().split("\n").map((line) => {
  const split = line.indexOf("=")
  return [line.slice(0, split), line.slice(split + 1)]
}))

test("built package crosses the real version, npm pack, artifact and isolated verification CLIs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "release-artifact-smoke-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "source"), artifact = path.join(root, "artifact"), isolated = path.join(root, "isolated")
  await mkdir(path.join(source, "dist"), { recursive: true })
  await mkdir(isolated)
  for (const file of [...packageFiles, "package-lock.json"]) await writeFile(path.join(source, file), await readFile(file))
  const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"))
  const versionOutput = path.join(root, "version-output"), artifactOutput = path.join(root, "artifact-output")
  const env = { ...process.env, RELEASE_TAG: `v${pkg.version}`, RELEASE_COMMIT: "a".repeat(40), GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: versionOutput }
  execFileSync(process.execPath, [new URL("../scripts/release-version.mjs", import.meta.url).pathname], { cwd: source, env, stdio: "pipe" })
  const version = outputs(await readFile(versionOutput, "utf8"))
  assert.equal(version.tag, env.RELEASE_TAG)
  assert.equal(version.commit, env.RELEASE_COMMIT)
  const artifactEnv = { ...env, RELEASE_VERIFIED_TAG: version.tag, RELEASE_VERSION: version.version, RELEASE_COMMIT: version.commit,
    RELEASE_VALIDATION_ATTEMPT: version.validation_attempt, RELEASE_WORKFLOW_COMMIT: "b".repeat(40), RELEASE_RUN_ID: "123", GITHUB_OUTPUT: artifactOutput }
  const helper = new URL("../scripts/release-artifact.mjs", import.meta.url).pathname
  execFileSync(process.execPath, [helper, "prepare", artifact], { cwd: source, env: artifactEnv, stdio: "pipe" })
  const prepared = outputs(await readFile(artifactOutput, "utf8"))
  const bytes = await readFile(path.join(artifact, `${pkg.name}-${pkg.version}.tgz`))
  assert.equal(prepared.integrity, archiveIntegrity(bytes))
  assert.deepEqual(inspectPackageArchive(bytes).pkg, pkg)
  const sounds = Object.fromEntries(await Promise.all(["attention", "unsafe", "question", "approved", "error", "ended"]
    .map(async kind => [kind, await readFile(`sounds/${kind}.mp3`)])))
  verifyBundledSounds((await readFile(path.join(source, "dist/tui.js"))).toString("utf8"), sounds)
  verifyBundledSounds(inspectPackageArchive(bytes).files.get("dist/tui.js").toString("utf8"), sounds)
  verifyBundledHistoryWorker(inspectPackageArchive(bytes).files.get("dist/tui.js").toString("utf8"))
  const verifyEnv = { ...artifactEnv, RELEASE_INTEGRITY: prepared.integrity }
  const verified = execFileSync(process.execPath, [helper, "verify", artifact], { cwd: isolated, env: verifyEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  assert.match(verified, /exactly five package files, matching digest and workflow identity/)
  assert.throws(() => execFileSync(process.execPath, [helper, "verify", artifact], { cwd: isolated,
    env: { ...verifyEnv, RELEASE_COMMIT: "c".repeat(40) }, stdio: "pipe" }), (error) => {
    assert.match(error.stderr.toString(), /commit differs from validated workflow/)
    return true
  })
})
