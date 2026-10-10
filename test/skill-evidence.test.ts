import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, mkdir, writeFile, rm, open, realpath, symlink, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectSkillEvidence, skillReferences } from "../src/skill-evidence.js"
import { FileAccess } from "../src/file-access.js"
import { parseConfig } from "../src/config.js"
import { evaluateEvidence } from "../src/evaluate.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import type { SkillContext } from "../src/types.js"
import type { ContextReader } from "../src/context.js"
import type { AssistantMessage, Part, PermissionRequest } from "@opencode-ai/sdk/v2"

const signal = () => new AbortController().signal
const limits = { maxFiles: 6, maxEvidenceBytes: 131072 }
async function fixture(t: TestContext, content = "Read `scripts/check.py` and [context](docs/context.md#details).") {
  const directory = await mkdtemp(path.join(tmpdir(), "reviewer-skill-")), base = path.join(directory, "skill")
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(path.join(base, "scripts"), { recursive: true }); await mkdir(path.join(base, "docs"))
  await writeFile(path.join(base, "SKILL.md"), "DISK CONTENT CHANGED AFTER THE HOST LOADED THE SKILL")
  await writeFile(path.join(base, "scripts/check.py"), 'import hidden_dependency\nprint("REVIEW SOURCE ONLY")\n')
  await writeFile(path.join(base, "scripts/hidden_dependency.py"), "NOT DIRECTLY REFERENCED")
  await writeFile(path.join(base, "docs/context.md"), "Supporting context. See [nested](nested.md).")
  await writeFile(path.join(base, "docs/nested.md"), "DO NOT RECURSE")
  await writeFile(path.join(directory, "secret.txt"), "OUTSIDE CONTENT MUST NOT BE SENT")
  const context: SkillContext = { kind: "skill", tool: "skill", input: { name: "fixture" },
    skill: { name: "fixture", description: "Review fixture", location: path.join(base, "SKILL.md"), content },
    permission: { id: "permission", type: "skill", patterns: ["fixture"], always: ["fixture"], metadata: {}, tool: { messageID: "message", callID: "call" } },
    location: { instanceDirectory: directory, instanceWorktree: directory }, userPrompt: "Check the fixture", limitations: [] }
  return { directory, base, context }
}

test("skill evidence uses the exact host text and direct supporting files, never disk replacement or recursive imports", async t => {
  const f = await fixture(t), result = await collectSkillEvidence(f.context, limits, signal())
  assert.equal(result.skill.content, f.context.skill.content)
  assert.deepEqual(result.files.map(file => file.filename), ["scripts/check.py", "docs/context.md"])
  assert.ok(result.files.every(file => file.status === "captured"))
  assert.match(result.files[0]!.contents!, /REVIEW SOURCE ONLY/)
  assert.doesNotMatch(JSON.stringify(result), /DISK CONTENT CHANGED|DO NOT RECURSE|NOT DIRECTLY REFERENCED|OUTSIDE CONTENT/)
  assert.equal(result.partial, false)
})

test("quoted skill filenames preserve punctuation rather than capturing prose-cleaned decoys", async t => {
  const f = await fixture(t)
  await writeFile(`${f.base}/notes.md!`, "ACTUAL PUNCTUATED SUPPORT")
  await writeFile(`${f.base}/notes.md`, "UNREFERENCED DECOY")
  for (const text of ['Read `notes.md!`.', 'Read "notes.md!".', "Read 'notes.md!'.", 'Run `cat "notes.md!"`.', 'Run `cat notes.md!`.']) {
    f.context.skill.content = text
    const result = await collectSkillEvidence(f.context, limits, signal())
    assert.deepEqual(result.files.map(file => file.filename), ["notes.md!"], text)
    assert.equal(result.files[0]?.contents, "ACTUAL PUNCTUATED SUPPORT", text)
    assert.equal(result.partial, false)
  }
  assert.deepEqual(skillReferences("Read notes.md!", signal()).references, ["notes.md"])
})

test("skill command operands retain whole concatenated and escaped quote identities instead of collecting decoys", async t => {
  const f = await fixture(t)
  for (const name of ["check.py", "tool.py", "s.py", 'check.py"']) await writeFile(`${f.base}/${name}`, "UNREFERENCED COMMAND DECOY")
  const cases = [
    ['"scripts/"check.py', "scripts/check.py"],
    ["'scripts/'check.py", "scripts/check.py"],
    ['scripts/"check".py', "scripts/check.py"],
    ["'scripts/'\"check\".py", "scripts/check.py"],
    ['"scripts/check.py"', "scripts/check.py"],
    ["'scripts/check.py'", "scripts/check.py"],
    ['"scripts/check tool.py"', "scripts/check tool.py"],
    [String.raw`scripts/check\ tool.py`, "scripts/check tool.py"],
    [String.raw`"scripts/check\"tool.py"`, 'scripts/check"tool.py'],
    [String.raw`scripts/check\"tool.py`, 'scripts/check"tool.py'],
    [String.raw`'scripts/check'\''s.py'`, "scripts/check's.py"],
    [String.raw`"scripts/check's.py"`, "scripts/check's.py"],
  ]
  const opened: string[] = []
  const access = new FileAccess({ realpath, open: (async (...args: Parameters<typeof open>) => { opened.push(String(args[0])); return open(...args) }) as typeof open })
  for (const [operand, target] of cases) {
    const expected = `ACTUAL SUPPORT: ${target}`
    await writeFile(`${f.base}/${target}`, expected)
    f.context.skill.content = `Run \`python ${operand}\`.`
    opened.length = 0
    const s = signal(), result = await collectSkillEvidence(f.context, limits, s, access.scope(s))
    assert.equal(result.skill.content, f.context.skill.content)
    assert.deepEqual(result.files.map(file => [file.filename, file.status, file.contents]), [[target, "captured", expected]], operand)
    assert.deepEqual(opened, [`${f.base}/${target}`], operand)
    assert.equal(result.partial, false, operand)
    assert.doesNotMatch(JSON.stringify(result), /UNREFERENCED COMMAND DECOY|DISK CONTENT CHANGED/)
  }
  assert.deepEqual(skillReferences('Run `./scripts/"check".py --check`.', signal()).references, ["./scripts/check.py"])
})

test("unsupported skill commands are omitted atomically, including earlier literal operands and fragment decoys", async t => {
  const f = await fixture(t)
  await writeFile(`${f.base}/check.py`, "UNREFERENCED COMMAND DECOY")
  const commands = [
    'python "scripts/"check.py; cat check.py',
    'python "scripts/"check.py && cat check.py',
    'python "scripts/"check.py | cat check.py',
    'python "scripts/"check.py > check.py',
    'python "scripts/"check.py # check.py',
    'python "scripts/"check.py "$ROOT/"check.py',
    'python "scripts/"check.py $(cat check.py)',
    'python "scripts/"check.py `cat check.py` --check',
    'python "scripts/"check.py <(cat check.py)',
    'python "scripts/"check.py scripts/*.py',
    'python "scripts/"check.py scripts/[ab].py',
    'python "scripts/"check.py scripts/{a,b}.py',
    'python "scripts/"check.py ~/check.py',
    String.raw`python "scripts/"check.py $'scripts/'check.py`,
    'python "scripts/"check.py "unclosed check.py',
    "python scripts/check.py 'unclosed check.py",
    'python scripts/check.py \\',
    'python scripts/check.py\ncat check.py',
    'python scripts/check.py\rcheck.py',
    'python scripts/check.py\0check.py',
    'python scripts/check.py\u007fcheck.py',
  ]
  const opened: string[] = []
  const access = new FileAccess({ realpath, open: (async (...args: Parameters<typeof open>) => { opened.push(String(args[0])); return open(...args) }) as typeof open })
  for (const command of commands) {
    // Double-backtick Markdown spans also contain literal shell backticks.
    const text = `Run \`\`${command}\`\`. Read \`docs/context.md\`.`
    const discovered = skillReferences(text, signal())
    assert.deepEqual(discovered.references, ["docs/context.md"], command)
    assert.match(discovered.limitations.join(" "), /Unsupported shell syntax.*whole command was omitted/, command)
    if (command.includes("\0")) continue // Mandatory catalog instructions reject NUL independently.
    f.context.skill.content = text
    opened.length = 0
    const s = signal(), result = await collectSkillEvidence(f.context, limits, s, access.scope(s))
    assert.equal(result.skill.content, text)
    assert.deepEqual(result.files.map(file => file.filename), ["docs/context.md"], command)
    assert.deepEqual(opened, [`${f.base}/docs/context.md`], command)
    assert.equal(result.partial, true, command)
    assert.doesNotMatch(JSON.stringify(result.files), /UNREFERENCED COMMAND DECOY|REVIEW SOURCE ONLY/)
  }
})

test("decoded skill command references still obey skill directory confinement", async t => {
  const f = await fixture(t, 'Run `cat "../"secret.txt`.')
  const result = await collectSkillEvidence(f.context, limits, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["../secret.txt"])
  assert.match(result.files[0]!.status, /outside the skill directory/)
  assert.equal(result.partial, true)
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE CONTENT/)
})

test("skill command token and argument limits omit the entire command without retaining a literal prefix", t => {
  t.mock.method(performance, "now", () => 0)
  const tooMany = skillReferences('`python scripts/check.py ' + "x ".repeat(16384) + '`', signal())
  assert.deepEqual(tooMany.references, [])
  assert.match(tooMany.limitations.join(" "), /bounded work limit/)
  const tooLong = skillReferences('`python scripts/check.py "' + "x".repeat(4097) + '.py"` Read `docs/context.md`.', signal())
  assert.deepEqual(tooLong.references, ["docs/context.md"])
  assert.match(tooLong.limitations.join(" "), /argument length limit.*whole command was omitted/)
})

test("skill command tokenization shares discovery's time budget and propagates mid-scan cancellation", async t => {
  const text = '`python "scripts/"check.py' + " --flag".repeat(100) + '`'
  for (const abort of [false, true]) await t.test(abort ? "parent cancellation" : "work deadline", t => {
    const controller = new AbortController(), reason = Error("stop command discovery")
    let checks = 0
    // Allow the enclosing code span scan, then interrupt literal tokenization.
    t.mock.method(performance, "now", () => {
      if (++checks <= text.length + 10) return 0
      if (abort) controller.abort(reason)
      return abort ? 0 : 251
    })
    if (abort) assert.throws(() => skillReferences(text, controller.signal), error => error === reason)
    else {
      const result = skillReferences(text, controller.signal)
      assert.deepEqual(result.references, [])
      assert.match(result.limitations.join(" "), /bounded work limit/)
    }
  })
})

test("unsupported nested Markdown destinations are omitted whole with a limitation and no fragment decoys", async t => {
  const f = await fixture(t)
  for (const name of [".md", "foo", "bar.md", "foo(bar).md"]) await writeFile(`${f.base}/${name}`, "UNREFERENCED LINK DECOY")
  for (const text of ["[reference](foo(bar).md)", "[bar.md](foo(bar).md)", "[reference](foo(bar(baz)).md)", "[reference](foo(bar).md \"title\")"]) {
    f.context.skill.content = `${text} Read \`docs/context.md\`.`
    const result = await collectSkillEvidence(f.context, limits, signal())
    assert.deepEqual(result.files.map(file => file.filename), ["docs/context.md"], text)
    assert.equal(result.partial, true)
    assert.match(result.limitations.join(" "), /[Uu]nsupported.*[Mm]arkdown|[Mm]arkdown.*not resolved/)
    assert.doesNotMatch(JSON.stringify(result.files), /LINK DECOY/)
  }
})

test("main skill exclusion uses canonical identity rather than lexical symlink-parent equality", async t => {
  const f = await fixture(t, "Read `link/../SKILL.md`, `main-alias.md` and `docs/context.md`.")
  await mkdir(`${f.base}/nested/deep`, { recursive: true })
  await symlink(`${f.base}/nested/deep`, `${f.base}/link`)
  await symlink(`${f.base}/SKILL.md`, `${f.base}/main-alias.md`)
  await writeFile(`${f.base}/nested/SKILL.md`, "ACTUAL REFERENCED SUPPORT")
  const opened: string[] = []
  const files = new FileAccess({ realpath, open: (async (...args: Parameters<typeof open>) => { opened.push(String(args[0])); return open(...args) }) as typeof open })
  const s = signal(), result = await collectSkillEvidence(f.context, { ...limits, maxFiles: 3 }, s, files.scope(s))
  assert.deepEqual(result.files.map(file => file.filename), ["link/../SKILL.md", "docs/context.md"])
  assert.equal(result.files[0]?.contents, "ACTUAL REFERENCED SUPPORT")
  assert.equal(result.files[1]?.status, "captured")
  assert.equal(result.partial, false)
  assert.ok(!opened.includes(`${f.base}/SKILL.md`))
  assert.doesNotMatch(JSON.stringify(result.files), /DISK CONTENT CHANGED/)
})

test("unavailable main skill identity omits supporting files without rereading catalog instructions", async t => {
  const f = await fixture(t)
  let opened = 0
  const files = new FileAccess({ realpath: async name => {
    if (name === f.context.skill.location) throw Object.assign(Error("private"), { code: "EACCES" })
    return realpath(name)
  }, open: (async (...args: Parameters<typeof open>) => { opened++; return open(...args) }) as typeof open })
  const s = signal(), result = await collectSkillEvidence(f.context, limits, s, files.scope(s))
  assert.equal(opened, 0)
  assert.equal(result.partial, true)
  assert.equal(result.skill.content, f.context.skill.content)
  assert.match(result.limitations.join(" "), /[Mm]ain skill.*identity/)
  assert.ok(result.files.every(file => file.contents === undefined))
})

test("literal discovery handles links, quoted command operands and paths with spaces without expanding URLs or shell expressions", () => {
  const result = skillReferences('Run `python "scripts/check tool.py"`. Then `./scripts/next.py --check`. Read "my notes.md" and `other notes.md` and [notes](<docs/my notes.md>#section). https://example.com/remote.py `$HOME/secret.txt` `scripts/*.py`', signal())
  assert.deepEqual(result.references, ["scripts/check tool.py", "./scripts/next.py", "my notes.md", "other notes.md", "docs/my notes.md"])
  assert.ok(result.limitations.some(line => line.includes("Dynamic")))
})

test("skill discovery preserves prose after apostrophes and omits entire URLs and incomplete links", () => {
  const result = skillReferences("The user's task needs `docs/context.md`. https://example.com/foo(bar).md mailto:foo(bar).md [bad](foo(bar).md) Then [good](scripts/check.py).", signal())
  assert.deepEqual(result.references, ["docs/context.md", "scripts/check.py"])
  assert.equal(result.limitations.length, 1)
  for (const text of ["[bad](foo(bar).md", "[bad](foo[bar].md)", '[bad](foo\\(bar\\).md)']) {
    const invalid = skillReferences(text, signal())
    assert.deepEqual(invalid.references, [])
    assert.match(invalid.limitations.join(" "), /whole link was omitted/)
  }
})

test("skill scanner bounds whole-construct work and propagates parent cancellation", t => {
  const reason = Error("skill resolved")
  assert.throws(() => skillReferences("[bad](foo(bar).md)", AbortSignal.abort(reason)), error => error === reason)
  let clock = 0
  t.mock.method(performance, "now", () => { clock += 100; return clock })
  const result = skillReferences("[reference](" + "(".repeat(10000) + ".md)", signal())
  assert.deepEqual(result.references, [])
  assert.match(result.limitations.join(" "), /bounded work limit/)
})

test("an ancestor swap onto the main skill never rereads main instructions through a supporting alias", async t => {
  const f = await fixture(t, "Read `scripts/SKILL.md`.")
  await writeFile(`${f.base}/scripts/SKILL.md`, "supporting source before swap")
  let reads = 0, closes = 0
  const files = new FileAccess({ realpath, open: (async (filename, flags) => {
    await rename(`${f.base}/scripts`, `${f.base}/original`)
    await symlink(f.base, `${f.base}/scripts`)
    const handle = await open(filename, flags)
    return new Proxy(handle, { get(target, key) {
      if (key === "read") return (...args: any[]) => { reads++; return (target.read as any)(...args) }
      if (key === "close") return () => { closes++; return target.close() }
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value
    } })
  }) as typeof open })
  const s = signal(), result = await collectSkillEvidence(f.context, limits, s, files.scope(s))
  assert.equal(reads, 0); assert.equal(closes, 1)
  assert.equal(result.partial, true)
  assert.match(result.files[0]!.status, /opened file is the main skill/)
  assert.doesNotMatch(JSON.stringify(result), /DISK CONTENT CHANGED/)
})

test("timed-out main identity probes retain physical ownership and ignore late results", async t => {
  const f = await fixture(t)
  let release!: (value: string) => void
  const held = new Promise<string>(resolve => { release = resolve })
  const files = new FileAccess({ realpath: name => name === f.context.skill.location ? held : realpath(name),
    open: async () => { throw Error("must not open") } }, { totalMs: 1000, pathMs: 15, captureMs: 50, concurrency: 2 })
  const s = signal()
  try {
    const result = await collectSkillEvidence(f.context, limits, s, files.scope(s))
    assert.equal(result.partial, true)
    assert.equal(files.outstanding, 1)
    assert.match(result.limitations.join(" "), /Main skill file identity unavailable.*timed out/)
    const published = JSON.stringify(result)
    release(f.context.skill.location)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(files.outstanding, 0)
    assert.equal(JSON.stringify(result), published)
  } finally { release(f.context.skill.location) }
})

test("supporting files cannot escape by traversal, encoded links, absolute paths or symlinks", async t => {
  const f = await fixture(t)
  await symlink(path.join(f.directory, "secret.txt"), path.join(f.base, "leak.txt"))
  f.context.skill.content = `Read \`../secret.txt\`, [encoded](%2e%2e/secret.txt), \`${path.join(f.directory, "secret.txt")}\` and \`leak.txt\`.`
  let opened = 0
  const files = new FileAccess({ realpath, open: (async (...args: Parameters<typeof open>) => { opened++; return open(...args) }) as typeof open })
  const s = signal(), result = await collectSkillEvidence(f.context, limits, s, files.scope(s))
  assert.equal(opened, 0)
  assert.ok(result.files.length > 0 && result.files.every(file => file.contents === undefined))
  assert.equal(result.partial, true); assert.doesNotMatch(JSON.stringify(result), /OUTSIDE CONTENT/)
})

test("an ancestor symlink swapped after canonicalization cannot disclose an outside file through the opened descriptor", async t => {
  const f = await fixture(t, "Read `scripts/check.py`.")
  const outside = path.join(f.directory, "outside")
  await mkdir(outside); await writeFile(path.join(outside, "check.py"), "OUTSIDE SECRET")
  let reads = 0, closes = 0
  const files = new FileAccess({ realpath, open: (async (filename, flags) => {
    await rename(path.join(f.base, "scripts"), path.join(f.base, "original"))
    await symlink(outside, path.join(f.base, "scripts"))
    const handle = await open(filename, flags)
    return new Proxy(handle, { get(target, key) {
      if (key === "read") return (...args: any[]) => { reads++; return (target.read as any)(...args) }
      if (key === "close") return () => { closes++; return target.close() }
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value
    } })
  }) as typeof open })
  const s = signal(), result = await collectSkillEvidence(f.context, limits, s, files.scope(s))
  assert.equal(reads, 0); assert.equal(closes, 1)
  assert.match(result.files[0]!.status, /opened file is outside/)
  assert.equal(result.files[0]!.contents, undefined)
})

test("file and byte budgets include the main skill and omit whole optional files without truncating instructions", async t => {
  const f = await fixture(t)
  const noFiles = await collectSkillEvidence(f.context, { ...limits, maxFiles: 1 }, signal())
  assert.ok(noFiles.files.every(file => file.status === "file-count limit reached"))
  await writeFile(path.join(f.base, "scripts/check.py"), "x".repeat(5000))
  const small = await collectSkillEvidence(f.context, { ...limits, maxEvidenceBytes: 1500 }, signal())
  assert.equal(small.skill.content, f.context.skill.content)
  assert.equal(small.files[0]!.contents, undefined); assert.equal(small.files[1]!.status, "captured")
  await assert.rejects(collectSkillEvidence(f.context, { ...limits, maxEvidenceBytes: 10 }, signal()), /budget/)
})

test("builtin skills never substitute the working directory for a missing skill directory", async t => {
  const f = await fixture(t), s = signal()
  const files = new FileAccess({ open: async () => { throw Error("must not open") }, realpath: async () => { throw Error("must not probe") } })
  const result = await collectSkillEvidence({ ...f.context, skill: { ...f.context.skill, location: "<built-in>" } }, limits, s, files.scope(s))
  assert.equal(result.skill.content, f.context.skill.content)
  assert.ok(result.files.every(file => file.status === "local skill directory unavailable"))
})

test("parent cancellation closes an opened supporting file rather than becoming an optional omission", async t => {
  const f = await fixture(t), abort = new AbortController()
  let closed = false
  let finishClose!: () => void
  const cleanup = new Promise<void>(resolve => { finishClose = resolve })
  const files = new FileAccess({ realpath, open: (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args), close = handle.close.bind(handle)
    handle.close = async () => { await close(); closed = true; finishClose() }
    abort.abort(new Error("stop skill review")); return handle
  }) as typeof open })
  await assert.rejects(collectSkillEvidence(f.context, limits, abort.signal, files.scope(abort.signal)), /stop skill review/)
  await cleanup; await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, true); assert.equal(files.outstanding, 0)
})

test("strict skill origin and default switch gate catalog reads; custom tools cannot acquire native skill semantics", async t => {
  const f = await fixture(t), cfg = parseConfig({ baseURL: "http://fixture/v1", model: "m" })
  const request: PermissionRequest = { id: "permission", sessionID: "root", permission: "skill", patterns: ["fixture"], always: ["fixture"], metadata: {}, tool: { messageID: "message", callID: "call" } }
  let tool = "skill", reads = 0, identified = 0
  let catalog = [f.context.skill]
  const reader: ContextReader = {
    session: async id => ({ id, projectID: "p", directory: f.directory } as any), projects: async () => [], messages: async () => [],
    message: async () => ({ info: { id: "message", sessionID: "root", role: "assistant", path: { cwd: f.directory, root: f.directory } } as AssistantMessage,
      parts: [{ id: "part", sessionID: "root", messageID: "message", type: "tool", callID: "call", tool, state: { status: "running", input: { name: "fixture" }, time: { start: 1 } } } as Part] }),
    toolIDs: async () => ["skill", "local"], skills: async () => { reads++; return catalog },
  }
  const run = (req = request, config = cfg) => evaluateEvidence(req, reader, config, config, "", signal(), () => identified++, new FileAccess())
  const result = await run(); assert.equal(result?.kind, "skill"); assert.equal(reads, 1); assert.equal(identified, 1)
  assert.equal(await run(request, { ...cfg, reviewSkills: false }), null); assert.equal(reads, 1)
  tool = "local"; assert.equal(await run(), null); assert.equal(reads, 1)
  assert.equal((await run(request, { ...cfg, reviewCustomTools: true }))?.kind, "custom"); assert.equal(reads, 1)
  tool = "skill"
  assert.equal(await run({ ...request, patterns: ["other"] }), null)
  assert.equal(await run({ ...request, always: ["*"] }), null)
  assert.equal(await run({ ...request, metadata: { arbitrary: true } }), null)
  catalog = []; await assert.rejects(run(), /unavailable or ambiguous/)
  catalog = [f.context.skill, f.context.skill]; await assert.rejects(run(), /unavailable or ambiguous/)
  assert.match(BUILTIN_PROMPTS.skill.instructions, /BOTH routine, bounded risk AND clear relevance/)
  assert.match(BUILTIN_PROMPTS.skill.instructions, /irrelevant skill is safe=false/)
})
