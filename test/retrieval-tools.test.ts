import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath, open, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { absoluteRetrievalPath, globSource, retrievalArguments, runRetrievalTool, type RetrievalCall } from "../src/retrieval-tools.js"

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "review-retrieval-")))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(`${dir}/project/src/nested`, { recursive: true })
  await mkdir(`${dir}/outside`, { recursive: true })
  await writeFile(`${dir}/project/run.sh`, "#!/bin/sh\nsource ./lib.sh\nrm -rf \"$TARGET\"\n")
  await writeFile(`${dir}/project/lib.sh`, "TARGET=/tmp/cache\n")
  await writeFile(`${dir}/project/src/app.ts`, "export const token = process.env.TOKEN\n")
  await writeFile(`${dir}/project/src/nested/deep.ts`, "const TOKEN = 1\n")
  await writeFile(`${dir}/project/.env`, "TOKEN=secret\n")
  await writeFile(`${dir}/project/binary.bin`, Buffer.from([0x41, 0x00, 0x42]))
  await writeFile(`${dir}/project/latin1.txt`, Buffer.from([0x66, 0xe9, 0x0a]))
  await writeFile(`${dir}/outside/target.txt`, "outside\n")
  await symlink(`${dir}/outside`, `${dir}/project/linked`)
  return dir
}

function context(base: string, home = "/home/fixture", maxBytes = 131072, softMs = 5000) {
  return { base, home, maxBytes, io: { open, realpath: (name: string) => realpath(name) }, signal: new AbortController().signal,
    softEnd: performance.now() + softMs }
}
const run = (call: RetrievalCall, ctx: ReturnType<typeof context>) => runRetrievalTool(call, ctx)

test("arguments are strict per tool and paths resolve absolute, relative-to-base and home forms", () => {
  assert.deepEqual(retrievalArguments("read", { path: "a", offset: 2 }), { ok: true, args: { path: "a", offset: 2 } })
  for (const [tool, value, reason] of [
    ["write", { path: "a" }, /unknown tool/], ["read", [], /expected an object/], ["read", {}, /path is required/],
    ["read", { path: "a", extra: 1 }, /unknown field/], ["read", { path: "a", offset: 0 }, /positive integer/],
    ["grep", { pattern: "" }, /nonempty string/], ["grep", { pattern: "x", ignoreCase: "yes" }, /boolean/],
  ] as const) {
    const result = retrievalArguments(tool, value)
    assert.ok(!result.ok && reason.test(result.reason), `${tool} ${JSON.stringify(value)}`)
  }
  assert.equal(absoluteRetrievalPath("/etc/hosts", "/base", "/home/u"), "/etc/hosts")
  assert.equal(absoluteRetrievalPath("~", "/base", "/home/u"), "/home/u")
  assert.equal(absoluteRetrievalPath("~/.bashrc", "/base", "/home/u"), "/home/u/.bashrc")
  assert.equal(absoluteRetrievalPath("../x", "/base/", "/home/u"), "/base/../x", "parents resolve physically later")
  assert.equal(new RegExp(`^${globSource("src/**/*.{ts,tsx}")}$`).test("src/a/b/c.tsx"), true)
  assert.equal(new RegExp(`^${globSource("src/**/*.{ts,tsx}")}$`).test("src/c.ts"), true)
  assert.equal(new RegExp(`^${globSource("*.ts")}$`).test("src/c.ts"), false)
  assert.equal(new RegExp(`^${globSource("[!a]?.md")}$`).test("bx.md"), true)
})

test("list, glob and grep accept only optional positive integer limits up to 500", () => {
  for (const tool of ["list", "glob", "grep"] as const) {
    const required = tool === "list" ? { path: "." } : { pattern: "hit" }
    for (const limit of [undefined, 1, 75, 500]) {
      const args = { ...required, ...(limit === undefined ? {} : { limit }) }
      assert.deepEqual(retrievalArguments(tool, args), { ok: true, args })
    }
    for (const limit of [0, -1, 1.5, 501, "3", true, null]) {
      const result = retrievalArguments(tool, { ...required, limit })
      assert.ok(!result.ok, `${tool} rejects limit ${JSON.stringify(limit)}`)
      assert.match(result.reason, limit === 501 ? /at most 500/ : /positive integer/)
    }
    const unknown = retrievalArguments(tool, { ...required, limit: 3, offset: 1 })
    assert.ok(!unknown.ok && /unknown field/.test(unknown.reason), `${tool} still rejects unknown arguments`)
  }
  assert.deepEqual(retrievalArguments("read", { path: "a", limit: 501 }), { ok: true, args: { path: "a", limit: 501 } })
})

test("read returns exact line ranges with canonical paths, paging and factual failures", async t => {
  const dir = await fixture(t), ctx = context(`${dir}/project`, dir)
  const whole = await run({ tool: "read", arguments: { path: "run.sh" } }, ctx)
  assert.deepEqual(whole, { tool: "read", status: "ok", path: "run.sh", absolutePath: `${dir}/project/run.sh`, canonicalPath: `${dir}/project/run.sh`,
    startLine: 1, endLine: 3, totalLines: 3, truncated: false, content: "#!/bin/sh\nsource ./lib.sh\nrm -rf \"$TARGET\"\n" })
  const page = await run({ tool: "read", arguments: { path: "run.sh", offset: 2, limit: 1 } }, ctx)
  assert.equal(page.content, "source ./lib.sh\n")
  assert.deepEqual([page.startLine, page.endLine, page.truncated, page.nextOffset, page.totalLines] as unknown[], [2, 2, true, 3, undefined])
  const viaLink = await run({ tool: "read", arguments: { path: "linked/target.txt" } }, ctx)
  assert.equal(viaLink.canonicalPath, `${dir}/outside/target.txt`, "explicit paths follow symlinks")
  const viaHome = await run({ tool: "read", arguments: { path: "~/outside/target.txt" } }, ctx)
  assert.equal(viaHome.content, "outside\n")
  const parent = await run({ tool: "read", arguments: { path: "linked/../outside/target.txt" } }, context(`${dir}/project`, dir))
  assert.equal(parent.canonicalPath, `${dir}/outside/target.txt`, "the parent of a symlinked directory is physical, not lexical")
  for (const [file, reason] of [["missing.txt", "ENOENT"], ["binary.bin", "binary content"], ["latin1.txt", "invalid UTF-8"], ["src", "not a regular file"]] as const) {
    const result = await run({ tool: "read", arguments: { path: file } }, ctx)
    assert.equal(result.status, "error", file)
    assert.equal(result.reason, reason, file)
    assert.equal(result.path, file)
  }
  assert.match(String((await run({ tool: "read", arguments: { path: "run.sh", offset: 9 } }, ctx)).reason), /offset beyond end of file \(3 lines\)/)
})

test("read without a limit returns the whole file and explicit line limits can exceed 500", async t => {
  const dir = await fixture(t), lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}\n`)
  await writeFile(`${dir}/project/long.txt`, lines.join(""))
  const whole = await run({ tool: "read", arguments: { path: "long.txt" } }, context(`${dir}/project`, dir))
  assert.equal(whole.content, lines.join(""))
  assert.equal(whole.totalLines, 600)
  assert.equal(whole.truncated, false)
  const page = await run({ tool: "read", arguments: { path: "long.txt", limit: 501 } }, context(`${dir}/project`, dir))
  assert.equal(page.content, lines.slice(0, 501).join(""))
  assert.deepEqual([page.endLine, page.nextOffset, page.truncated], [501, 502, true])
})

test("read results fit the byte cap, cut at complete lines and reject a single oversized first line", async t => {
  const dir = await fixture(t)
  await writeFile(`${dir}/project/many.txt`, Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n") + "\n")
  await writeFile(`${dir}/project/wide.txt`, "y".repeat(5000) + "\nshort\n")
  const ctx = context(`${dir}/project`, dir, 1500)
  const many = await run({ tool: "read", arguments: { path: "many.txt" } }, ctx)
  assert.equal(many.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(many)) <= 1500)
  assert.equal(String(many.content).split("\n").length - 1, many.endLine)
  assert.equal(many.nextOffset, Number(many.endLine) + 1)
  assert.equal((await run({ tool: "read", arguments: { path: "wide.txt" } }, ctx)).reason, "line exceeds result size limit")
  const after = await run({ tool: "read", arguments: { path: "wide.txt", offset: 2 } }, ctx)
  assert.deepEqual([after.content, after.totalLines], ["short\n", 2], "an oversized earlier line is skipped, not buffered")
})

test("list is non-recursive and reports symlinks without following them", async t => {
  const dir = await fixture(t)
  const result = await run({ tool: "list", arguments: { path: "." } }, context(`${dir}/project`, dir))
  assert.equal(result.status, "ok")
  assert.deepEqual((result.entries as any[]).map(entry => [entry.name, entry.type]), [
    [".env", "file"], ["binary.bin", "file"], ["latin1.txt", "file"], ["lib.sh", "file"], ["linked", "symlink"], ["run.sh", "file"], ["src", "directory"]])
  assert.equal((result.entries as any[]).find(entry => entry.name === "lib.sh").size, 18)
  assert.equal((await run({ tool: "list", arguments: { path: "run.sh" } }, context(`${dir}/project`, dir))).reason, "ENOTDIR")
})

test("list and glob honor limits, default to 500, detect overflow and preserve the byte cap", async t => {
  const dir = await fixture(t), base = `${dir}/project/entries`
  await mkdir(base)
  const names = Array.from({ length: 500 }, (_, i) => `entry-${String(i).padStart(3, "0")}.txt`)
  await Promise.all(names.map(name => writeFile(`${base}/${name}`, "hit\n")))
  const calls: RetrievalCall[] = [
    { tool: "list", arguments: { path: "." } },
    { tool: "glob", arguments: { pattern: "*.txt", path: "." } },
  ]
  for (const call of calls) {
    const key = call.tool === "list" ? "entries" : "matches"
    for (const limit of [3, 75, 500, undefined]) {
      const result = await run({ ...call, arguments: { ...call.arguments, ...(limit === undefined ? {} : { limit }) } }, context(base, dir))
      assert.equal(result.status, "ok")
      const returned = call.tool === "list" ? (result.entries as any[]).map(entry => entry.name)
        : (result.matches as string[]).map(file => path.basename(file))
      assert.deepEqual(returned, names.slice(0, limit ?? 500), `${call.tool} limit ${limit}`)
      assert.equal(result.truncated, (limit ?? 500) < 500, `${call.tool} an exact count is not truncated`)
    }
    const bounded = await run({ ...call, arguments: { ...call.arguments, limit: 75 } }, context(base, dir, 1500))
    assert.equal(bounded.status, "ok")
    assert.equal(bounded.truncated, true)
    assert.ok((bounded[key] as unknown[]).length > 0 && (bounded[key] as unknown[]).length < 75)
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1500, `${call.tool} still obeys the byte cap`)
  }
  await writeFile(`${base}/entry-500.txt`, "hit\n")
  for (const call of calls) {
    for (const limit of [500, undefined]) {
      const result = await run({ ...call, arguments: { ...call.arguments, ...(limit === undefined ? {} : { limit }) } }, context(base, dir))
      const key = call.tool === "list" ? "entries" : "matches"
      assert.equal((result[key] as unknown[]).length, 500)
      assert.equal(result.truncated, true, `${call.tool} detects the additional entry`)
    }
  }
})

test("glob walks breadth-first without skipping hidden files or descending symlinked directories", async t => {
  const dir = await fixture(t), ctx = context(`${dir}/project`, dir)
  const all = await run({ tool: "glob", arguments: { pattern: "**/*" } }, ctx)
  const matches = (all.matches as string[]).map(file => path.relative(`${dir}/project`, file))
  assert.ok(matches.includes(".env"), "hidden files are included")
  assert.ok(matches.includes("linked"), "symlinks are reported")
  assert.ok(!matches.some(file => file.startsWith("linked/")), "symlinked directories are not descended")
  assert.ok(matches.indexOf("run.sh") < matches.indexOf("src/nested/deep.ts"), "breadth-first")
  const ts = await run({ tool: "glob", arguments: { pattern: "src/**/*.ts" } }, ctx)
  assert.deepEqual(ts.matches, [`${dir}/project/src/app.ts`, `${dir}/project/src/nested/deep.ts`])
  const rooted = await run({ tool: "glob", arguments: { pattern: "*.txt", path: "linked" } }, ctx)
  assert.deepEqual(rooted.matches, [`${dir}/outside/target.txt`], "an explicit root follows its symlink")
  assert.match(String((await run({ tool: "glob", arguments: { pattern: "/etc/*" } }, ctx)).reason), /relative/)
})

test("glob counts only matching entries and detects overflow in later directories", async t => {
  const dir = await fixture(t), files = [`${dir}/project/src/app.ts`, `${dir}/project/src/nested/deep.ts`]
  for (const limit of [1, 2, 75]) {
    const result = await run({ tool: "glob", arguments: { pattern: "**/*.ts", limit } }, context(`${dir}/project`, dir))
    assert.deepEqual(result.matches, files.slice(0, limit))
    assert.equal(result.truncated, limit < files.length)
  }
})

test("grep searches UTF-8 text with include filters, skips binary and invalid files, and caps result size", async t => {
  const dir = await fixture(t), ctx = context(`${dir}/project`, dir)
  const result = await run({ tool: "grep", arguments: { pattern: "token", ignoreCase: true, include: "*.ts" } }, ctx)
  assert.deepEqual((result.matches as any[]).map(match => [path.relative(`${dir}/project`, match.path), match.line]), [["src/app.ts", 1], ["src/nested/deep.ts", 1]])
  const all = await run({ tool: "grep", arguments: { pattern: "B|é|TOKEN" } }, ctx)
  assert.deepEqual(all.skipped, { binary: 1, invalidUtf8: 1, unreadable: 0, large: 0 })
  assert.ok((all.matches as any[]).some(match => match.path.endsWith(".env")))
  assert.equal((await run({ tool: "grep", arguments: { pattern: "(" } }, ctx)).reason, "invalid arguments: invalid regular expression")
  const single = await run({ tool: "grep", arguments: { pattern: "rm", path: "run.sh" } }, ctx)
  assert.deepEqual((single.matches as any[]).map(match => match.line), [3])
  await writeFile(`${dir}/project/many.txt`, "hit\n".repeat(2000))
  const capped = await run({ tool: "grep", arguments: { pattern: "hit", path: "many.txt" } }, context(`${dir}/project`, dir, 4000))
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 4000)
})

test("grep shares its requested cap across files and needs an additional matching line for truncation", async t => {
  const dir = await fixture(t), base = `${dir}/project/grep-limits`
  await mkdir(base)
  await writeFile(`${base}/a.txt`, "miss\nhit one\nhit two\n")
  await writeFile(`${base}/b.txt`, "miss\n")
  await writeFile(`${base}/c.txt`, "hit three\nmiss\nhit four\n")
  await writeFile(`${base}/d.log`, "hit ignored\n")
  await writeFile(`${base}/e.txt`, "miss\n")
  const expected = [["a.txt", 2, "hit one"], ["a.txt", 3, "hit two"], ["c.txt", 1, "hit three"], ["c.txt", 3, "hit four"]]
  for (const limit of [1, 2, 3, 4, 75]) {
    const result = await run({ tool: "grep", arguments: { pattern: "hit", include: "*.txt", limit } }, context(base, dir))
    assert.equal(result.status, "ok")
    assert.deepEqual((result.matches as any[]).map(match => [path.basename(match.path), match.line, match.text]), expected.slice(0, limit))
    assert.equal(result.truncated, limit < expected.length)
  }
  for (const limit of [1, 2]) {
    const single = await run({ tool: "grep", arguments: { pattern: "hit", path: "a.txt", limit } }, context(base, dir))
    assert.deepEqual((single.matches as any[]).map(match => match.line), [2, 3].slice(0, limit))
    assert.equal(single.truncated, limit < 2)
  }
})

test("grep defaults to 500, accepts larger inspection limits and keeps the byte cap", async t => {
  const dir = await fixture(t), base = `${dir}/project/grep-many`
  await mkdir(base)
  await writeFile(`${base}/a.txt`, "hit\n".repeat(300))
  await writeFile(`${base}/b.txt`, "hit\n".repeat(200))
  for (const limit of [75, 350, 500, undefined]) {
    const result = await run({ tool: "grep", arguments: { pattern: "hit", ...(limit === undefined ? {} : { limit }) } }, context(base, dir))
    assert.equal((result.matches as any[]).length, limit ?? 500)
    assert.equal(result.truncated, (limit ?? 500) < 500)
    const last = (result.matches as any[]).at(-1)
    assert.equal(last.path, `${base}/${(limit ?? 500) > 300 ? "b" : "a"}.txt`)
    assert.equal(last.line, (limit ?? 500) > 300 ? (limit ?? 500) - 300 : limit)
  }
  const bounded = await run({ tool: "grep", arguments: { pattern: "hit", limit: 75 } }, context(base, dir, 1500))
  assert.equal(bounded.truncated, true)
  assert.ok((bounded.matches as any[]).length > 0 && (bounded.matches as any[]).length < 75)
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1500)
  await writeFile(`${base}/b.txt`, "hit\n".repeat(201))
  for (const limit of [500, undefined]) {
    const result = await run({ tool: "grep", arguments: { pattern: "hit", ...(limit === undefined ? {} : { limit }) } }, context(base, dir))
    assert.equal((result.matches as any[]).length, 500)
    assert.equal(result.truncated, true)
  }
})

test("grep worker stops after the requested matches plus one overflow match", async t => {
  const dir = await fixture(t)
  await writeFile(`${dir}/project/lookahead.txt`, `hit\nhit\n${"a".repeat(40)}!\n`)
  const result = await run({ tool: "grep", arguments: { pattern: "hit|^(a+)+$", path: "lookahead.txt", limit: 1 } },
    context(`${dir}/project`, dir, 131072, 300))
  assert.deepEqual((result.matches as any[]).map(match => [match.line, match.text]), [[1, "hit"]])
  assert.equal(result.truncated, true)
  assert.equal(result.timedOut, undefined, "the worker never reaches the pathological expression after the lookahead match")
})

test("a pathological expression is stopped at the soft deadline without blocking the event loop", async t => {
  const dir = await fixture(t)
  await writeFile(`${dir}/project/redos.txt`, `${"a".repeat(40)}!\n`)
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  try {
    const started = performance.now()
    const result = await run({ tool: "grep", arguments: { pattern: "^(a+)+$", path: "redos.txt" } }, context(`${dir}/project`, dir, 131072, 300))
    assert.equal(result.timedOut, true)
    assert.ok(performance.now() - started < 3000)
    assert.ok(ticks >= 10, "the server event loop kept running")
  } finally { clearInterval(timer) }
})

test("unreadable entries are factual failures, and abort propagates rather than becoming a result", async t => {
  if (process.getuid?.() === 0) return t.skip("root bypasses permissions")
  const dir = await fixture(t)
  await writeFile(`${dir}/project/private.txt`, "x\n")
  await chmod(`${dir}/project/private.txt`, 0)
  assert.equal((await run({ tool: "read", arguments: { path: "private.txt" } }, context(`${dir}/project`, dir))).reason, "EACCES")
  const aborted = context(`${dir}/project`, dir), controller = new AbortController()
  controller.abort(new Error("review canceled"))
  await assert.rejects(runRetrievalTool({ tool: "read", arguments: { path: "run.sh" } }, { ...aborted, signal: controller.signal }), /review canceled/)
})
