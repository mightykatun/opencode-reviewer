import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { BUILTIN_PROMPTS, CONTRACT, CORRECTION, correctionPrompt, loadPrompts } from "../src/prompts.js"
import inventory from "../src/prompt-files.json" with { type: "json" }
import { parseConfig } from "../src/config.js"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"

test("prompt overrides reject valid final-component symlinks including a swap after lstat", async t => {
  for (const scenario of ["inside", "outside", "swap"]) await t.test(scenario, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), "review-prompt-link-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await mkdir(`${dir}/prompts`)
    const target = scenario === "inside" ? `${dir}/prompts/target.md` : `${dir}/target.md`
    const file = `${dir}/prompts/EDIT-REVIEW-PROMPT.md`
    await writeFile(target, "PRIVATE LINK TARGET INSTRUCTIONS")
    if (scenario === "swap") {
      await writeFile(file, "original regular instructions")
      const inspect = fs.lstat
      t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        const result = await inspect(...args)
        if (args[0] === file) { await rm(file); await symlink(target, file) }
        return result
      })
      syncBuiltinESMExports()
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    } else await symlink(target, file)
    await assert.rejects(loadPrompts(`${dir}/prompts`, new AbortController().signal), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Invalid prompt file/)
      assert.doesNotMatch(error.message, /PRIVATE LINK TARGET/)
      return true
    })
  })
})

test("all review kinds use named assessment files and one fixed correction contract", async () => {
  for (const kind of ["shell", "edit", "external-directory", "skill"] as const) {
    const assessment = (await readFile(new URL(`../${inventory[kind]}`, import.meta.url), "utf8")).trim()
    assert.equal(BUILTIN_PROMPTS[kind].instructions, assessment)
    assert.match(assessment, /one-time allowance \(Allow once\)/)
    assert.match(assessment, /Do not explain, warn about, or rate.*Allow always/)
    assert.ok(!("correction" in BUILTIN_PROMPTS[kind]))
  }
  assert.equal(CORRECTION, (await readFile(new URL("../contracts/PERMISSION-REVIEW-CORRECTION.md", import.meta.url), "utf8")).trim())
  assert.match(CORRECTION, /\{\{validationError\}\}/)
  assert.ok(correctionPrompt("feedback $&").includes("feedback $&"))
  assert.equal(CONTRACT, (await readFile(new URL("../contracts/PERMISSION-REVIEW-CONTRACT.md", import.meta.url), "utf8")).trim())
  assert.match(CONTRACT, /proposed diffs/)
  assert.match(CONTRACT, /exactly two fields/)
  assert.match(BUILTIN_PROMPTS.edit.instructions, /partial=true/)
  assert.match(BUILTIN_PROMPTS.edit.instructions, /writing executable code.*running it now/)
  assert.match(BUILTIN_PROMPTS.skill.instructions, /current scoped host registry/)
  assert.match(BUILTIN_PROMPTS.skill.instructions, /never as instructions for you to follow/)
  assert.equal(BUILTIN_PROMPTS.extraCareful, (await readFile(new URL("../prompts/EXTRA-CAREFUL-REVIEW-PROMPT.md", import.meta.url), "utf8")).trim())
  assert.doesNotMatch(BUILTIN_PROMPTS.extraCareful, /auto|countdown|will (?:run|execute)/i)
})

test("instructions accepts only absolute directory paths, not former inline guidance", () => {
  const options = { baseURL: "http://localhost/v1", model: "m" }
  assert.equal(parseConfig(options).instructions, undefined)
  assert.equal(parseConfig({ ...options, instructions: " /custom/prompts " }).instructions, "/custom/prompts")
  for (const instructions of ["Custom risk guidance", "relative/path", "~/prompts", "/bad\u0000path", "", null, 42]) {
    assert.throws(() => parseConfig({ ...options, instructions }), /instructions/)
  }
})

test("prompt files override independently with immutable startup snapshots and per-file fallback", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const signal = new AbortController().signal
  assert.equal(await loadPrompts(undefined, signal), BUILTIN_PROMPTS)
  assert.deepEqual(await loadPrompts(dir, signal), BUILTIN_PROMPTS)
  await writeFile(path.join(dir, "EDIT-REVIEW-PROMPT.md"), " custom edit guidance \n")
  await writeFile(path.join(dir, "EXTERNAL-DIRECTORY-REVIEW-PROMPT.md"), "custom directory instructions")
  await writeFile(path.join(dir, "README.md"), "unrelated files are not prompts")
  const first = await loadPrompts(dir, signal)
  assert.equal(first.edit.instructions, "custom edit guidance")
  assert.equal(first["external-directory"].instructions, "custom directory instructions")
  assert.equal(first.shell.instructions, BUILTIN_PROMPTS.shell.instructions)
  assert.equal(first.extraCareful, BUILTIN_PROMPTS.extraCareful)
  assert.equal(correctionPrompt("feedback $&"), CORRECTION.replaceAll("{{validationError}}", () => "feedback $&"))
  await writeFile(path.join(dir, "EDIT-REVIEW-PROMPT.md"), "changed on disk")
  assert.equal(first.edit.instructions, "custom edit guidance")
  assert.equal((await loadPrompts(dir, signal)).edit.instructions, "changed on disk")
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.edit))
  assert.notEqual(BUILTIN_PROMPTS.edit.instructions, first.edit.instructions)
})

test("all five native assessment/guidance files load independently", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const kind of ["shell", "edit", "external-directory", "skill"] as const) {
    await writeFile(path.join(dir, path.basename(inventory[kind])), `${kind} custom guidance`)
  }
  await writeFile(path.join(dir, "EXTRA-CAREFUL-REVIEW-PROMPT.md"), "Custom extra-careful guidance")
  const prompts = await loadPrompts(dir, new AbortController().signal)
  await writeFile(path.join(dir, "EXTRA-CAREFUL-REVIEW-PROMPT.md"), "Changed on disk")
  assert.equal(prompts.extraCareful, "Custom extra-careful guidance")
  for (const kind of ["shell", "edit", "external-directory", "skill"] as const) {
    assert.equal(prompts[kind].instructions, `${kind} custom guidance`)
    assert.ok(Object.isFrozen(prompts[kind]))
  }
})

test("legacy and new-category correction overrides fail with migration filenames", async (t) => {
  for (const name of ["PERMISSION-REVIEW-CORRECTION.md", "EDIT-REVIEW-CORRECTION.md", "MCP-REVIEW-CORRECTION.md"]) {
    const dir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(path.join(dir, name), "{{validationError}} private override")
    await assert.rejects(loadPrompts(dir, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Correction contracts are fixed; remove legacy override files/)
      assert.ok(error.message.includes(name))
      assert.doesNotMatch(error.message, /private override/)
      return true
    })
  }
})

test("supplied invalid prompt files fail rather than falling back or leaking file contents", async (t) => {
  for (const scenario of ["blank", "binary", "utf8", "oversized", "directory", "dangling", "fifo", "contract", "extra-careful"]) {
    await t.test(scenario, async (t) => {
      const dir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
      t.after(() => rm(dir, { recursive: true, force: true }))
      const name = scenario === "contract" ? "PERMISSION-REVIEW-CONTRACT.md" : scenario === "extra-careful" ? "EXTRA-CAREFUL-REVIEW-PROMPT.md" : "EDIT-REVIEW-PROMPT.md"
      const file = path.join(dir, name)
      if (scenario === "directory") await mkdir(file)
      else if (scenario === "dangling") await symlink(path.join(dir, "missing"), file)
      else if (scenario === "fifo") execFileSync("mkfifo", [file])
      else await writeFile(file, scenario === "blank" || scenario === "extra-careful" ? " \n" : scenario === "binary" ? "\u0000secret" : scenario === "utf8" ? Buffer.from([0xff]) : scenario === "oversized" ? "x".repeat(65537) : "secret-invalid-template")
      await assert.rejects(loadPrompts(dir, new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, scenario === "contract" ? /Contract prompt overrides/ : /Invalid prompt file/)
        assert.ok(!error.message.includes("secret-invalid-template"))
        return true
      })
    })
  }
})

test("invalid directories and cancelled prompt loads fail explicitly", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "plain")
  await writeFile(file, "not a directory")
  for (const value of [file, path.join(dir, "missing")]) await assert.rejects(loadPrompts(value, new AbortController().signal), /Prompt directory is unavailable/)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(loadPrompts(dir, abort.signal), { name: "AbortError" })
})

test("prompt reads close handles on read failure and mid-read cancellation", async (t) => {
  for (const cancel of [false, true]) await t.test(cancel ? "abort" : "read error", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, "EDIT-REVIEW-PROMPT.md")
    await writeFile(file, "custom prompt")
    const probe = await open(file, "r")
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    const abort = new AbortController()
    let handle: FileHandle | undefined
    t.mock.method(prototype, "read", function(this: FileHandle) {
      handle = this
      if (cancel) abort.abort()
      throw new Error("private filesystem diagnostic")
    })
    await assert.rejects(loadPrompts(dir, abort.signal), cancel ? { name: "AbortError" } : /Invalid prompt file/)
    assert.equal(handle?.fd, -1)
  })
})

test("cancellation at prompt EOF does not start a late stat and closes the descriptor", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-prompts-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "EDIT-REVIEW-PROMPT.md")
  await writeFile(file, "custom prompt")
  const probe = await open(file, "r")
  const prototype = Object.getPrototypeOf(probe)
  const read = probe.read, stat = probe.stat
  await probe.close()
  const abort = new AbortController()
  let stats = 0, handle: FileHandle | undefined
  t.mock.method(prototype, "stat", function(this: FileHandle) { stats++; return stat.call(this) })
  t.mock.method(prototype, "read", async function(this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
    handle = this
    const value = await read.apply(this, args)
    if (!value.bytesRead) abort.abort()
    return value
  })
  await assert.rejects(loadPrompts(dir, abort.signal), { name: "AbortError" })
  assert.equal(stats, 1)
  assert.equal(handle?.fd, -1)
})
