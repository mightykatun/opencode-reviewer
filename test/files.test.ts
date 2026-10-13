import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectEvidence, discover } from "../src/evidence.js"
import { collectHostEvidence } from "../src/host-evidence.js"
import { FileAccess } from "../src/file-access.js"
import { nativeInvocation } from "./review-fixtures.js"
import { DiffBudget, diffDelta } from "../src/files.js"
import { withDeadline } from "../src/deadline.js"
import { parseConfig } from "../src/config.js"
import type { JSONObject } from "../src/host-types.js"

const signal = () => new AbortController().signal
const diff = "--- before\n+++ after\n@@ -1,2 +1,3 @@\n-old-secret\n+new-secret\n+extra-secret\n retained\n"
const config = parseConfig({ baseURL: "http://localhost/v1", model: "fixture" })
async function edits(files: JSONObject[], limits = config) {
  const targets = files.map(file => String(file.file))
  const result = await collectHostEvidence(nativeInvocation("patch", {
    patchText: `*** Begin Patch\n${targets.map(file => `*** Update File: ${file}\n@@\n-old\n+new`).join("\n")}\n*** End Patch`,
  }, { files }, "/project", targets), limits, signal(), new FileAccess())
  assert.ok(result.status === "ready" && result.evidence.kind === "edit")
  return result.evidence
}

test("doubled byte default includes a formerly over-budget file; explicit old limits are retained", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-limit-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/data`, "x".repeat(70000))
  const input = { command: "cat data", cwd: dir, userPrompt: "Inspect data" }
  assert.equal((await collectEvidence(input, config, signal())).files[0]?.contents?.length, 70000)
  const explicit = parseConfig({ ...config, maxFiles: 4, maxEvidenceBytes: 65536 })
  assert.equal(explicit.maxFiles, 4)
  const omitted = (await collectEvidence(input, explicit, signal())).files[0]!
  assert.equal(omitted.contents, undefined)
  assert.equal(omitted.warning, `[!] File ${JSON.stringify(`${dir}/data`)} not included in context.`)
})

test("shell counts canonical aliases while native edits count exact declared identities and duplicate previews once", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-files-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/one`, "one")
  await writeFile(`${dir}/two`, "two")
  await symlink(`${dir}/one`, `${dir}/alias`)
  await symlink(dir, `${dir}/directory-alias`)
  const names = ["one", "alias", "./one", "missing", "directory-alias/missing", "two"]
  const limits = { ...config, maxFiles: 2 }
  const shell = await collectEvidence({ command: `cat ${names.join(" ")}`, cwd: dir, userPrompt: "Read" }, limits, signal())
  assert.equal(shell.files.length, 3)
  assert.equal(shell.files[0]?.contents, "one")
  assert.deepEqual(shell.files[0]?.aliases, [`${dir}/alias`, `${dir}/./one`])
  assert.match(shell.files[1]?.status ?? "", /ENOENT/)
  assert.match(shell.files[2]?.status ?? "", /file-count/)
  assert.ok(shell.files.slice(1).every((f) => f.warning && f.contents === undefined))
  const patch = await edits(["one", "one", "alias", "missing", "two"].map(name => ({ file: `${dir}/${name}`, status: "modified", patch: diff })), limits)
  assert.deepEqual(patch.changes.map(c => c.status), ["included", "included", "included", "omitted", "omitted"])
  assert.match(patch.changes[4]?.reason ?? "", /file-count/)
  assert.equal(patch.changes[4]?.delta, `[Δ] ${JSON.stringify(`${dir}/two`)}: +2 −1 lines`)
})

test("six distinct candidates fit by default in shell and patch evidence, seventh has a compact warning", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-six-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const files = Array.from({ length: 7 }, (_, i) => `${dir}/${i}.txt`)
  await Promise.all(files.map((file) => writeFile(file, "text")))
  const shell = await collectEvidence({ command: `head -n 1 ${files.join(" ")}`, cwd: dir, userPrompt: "Inspect" }, config, signal())
  const patch = await edits(files.map(file => ({ file, status: "modified", patch: diff })))
  assert.equal(shell.files.filter((f) => f.contents !== undefined).length, 6)
  assert.equal(patch.changes.filter((c) => c.status === "included").length, 6)
  assert.equal(shell.files[6]?.warning, patch.changes[6]?.warning)
  assert.equal(patch.changes[6]?.patch, undefined)
})

test("edit/write omissions report line counts without leaking diff text, including absent diffs with host counts", async () => {
  for (const tool of ["edit", "write"] as const) {
    for (const metadata of [{ patch: diff }, { additions: 2, deletions: 1 }] as JSONObject[]) {
      const input: JSONObject = tool === "write" ? { path: '/project/a\n"b', content: "new" }
        : { path: '/project/a\n"b', oldString: "old", newString: "new" }
      const result = await collectHostEvidence(nativeInvocation(tool, input,
        { files: [{ file: '/project/a\n"b', status: "modified", ...metadata }] }, "/project", ['/project/a\n"b']),
        { ...config, maxEvidenceBytes: 1 }, signal(), new FileAccess())
      assert.ok(result.status === "ready" && result.evidence.kind === "edit")
      const change = result.evidence.changes[0]!
      assert.equal(change.warning, '[!] File "/project/a\\n\\\"b" not included in context.')
      assert.equal(change.delta, '[Δ] "/project/a\\n\\\"b": +2 −1 lines')
      assert.doesNotMatch(JSON.stringify(result), /secret/)
      assert.equal(change.patch, undefined)
    }
  }
  const unknown = await edits([{ file: "/project/a", status: "modified", additions: -1, deletions: "2" }])
  assert.equal(unknown.changes[0]?.delta, undefined)
  assert.ok(unknown.changes[0]?.warning)
})

test("unified diff counts distinguish headers, context, no-newline markers and multiple hunks", () => {
  assert.deepEqual(diffDelta(diff, signal()), { added: 2, removed: 1 })
  assert.deepEqual(diffDelta("--- a\n+++ b\n@@ -1 +1 @@\n--- text\n+++ text\n\\ No newline at end of file\n@@ -4,0 +5,1 @@\n+last", signal()), { added: 2, removed: 1 })
  assert.deepEqual(diffDelta("@@ -0,0 +1,2 @@\n+a\n+b\n", signal()), { added: 2, removed: 0 })
  assert.deepEqual(diffDelta("@@ -1,2 +0,0 @@\n-a\n-b\n", signal()), { added: 0, removed: 2 })
  for (const bad of [undefined, "", "+not-a-diff", "@@ -1 +1 @@\n-old\n", "@@ -1 +1 @@\n-old\n+new\n+extra", "@@ -1,999999999999999999 +0,0 @@\n-x"]) assert.equal(diffDelta(bad, signal()), undefined)
})

test("diff counting shares exact UTF-8 byte and line allowances, including invalid scans", () => {
  const bytes = Buffer.byteLength(diff)
  const byteBudget = new DiffBudget({ bytes: bytes * 2 - 1, lines: 100, ms: 1000 })
  assert.deepEqual(diffDelta(diff, signal(), byteBudget), { added: 2, removed: 1 })
  assert.equal(diffDelta(diff, signal(), byteBudget), undefined)
  const lineBudget = new DiffBudget({ bytes: 10000, lines: 7, ms: 1000 })
  assert.deepEqual(diffDelta(diff, signal(), lineBudget), { added: 2, removed: 1 })
  assert.equal(diffDelta(diff, signal(), lineBudget), undefined)
  assert.equal(lineBudget.exhausted, true)
  const small = "@@ -1 +1 @@\n-old\n+é\n"
  assert.equal(diffDelta(small, signal(), new DiffBudget({ bytes: small.length, lines: 10, ms: 1000 })), undefined)
  const invalid = new DiffBudget({ bytes: 100, lines: 2, ms: 1000 })
  assert.equal(diffDelta("header\nheader\nheader\n", signal(), invalid), undefined)
  assert.equal(diffDelta("@@ -0,0 +0,0 @@\n", signal(), invalid), undefined)
})

test("optional counting time is cumulative active work and never turns parent cancellation or expiry into omission", async () => {
  let clock = 0
  const budget = new DiffBudget({ bytes: 10000, lines: 100, ms: 5 }, () => ++clock)
  assert.equal(diffDelta(diff, signal(), budget), undefined)
  assert.equal(budget.exhausted, true)
  assert.equal(budget.ms, 0)
  assert.equal(diffDelta(diff, signal(), budget), undefined)
  assert.throws(() => diffDelta(diff, AbortSignal.abort(new Error("native resolved"))), /native resolved/)
  await assert.rejects(withDeadline(signal(), 10, async s => {
    const until = performance.now() + 20
    while (performance.now() < until) { /* Delay timer delivery. */ }
    diffDelta(diff, s)
  }), /timed out/)
})

test("canonical source aliases promote an unqualified direct executable once and preserve its identity", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-promotion-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = "# extensionless interpreter/reader source\n"
  await writeFile(`${dir}/run`, source)
  await symlink(`${dir}/run`, `${dir}/alias`)
  const result = await collectEvidence({ command: "./run; python alias; cat alias", cwd: dir, userPrompt: "Inspect" }, { ...config, maxFiles: 1 }, signal())
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0]?.filename, "./run")
  assert.equal(result.files[0]?.contents, source)
  assert.deepEqual(result.files[0]?.aliases, [`${dir}/alias`])
  assert.equal(result.files[0]?.warning, undefined)
  const exact = await collectEvidence({ command: "./run; python ./run", cwd: dir, userPrompt: "Inspect" }, config, signal())
  assert.equal(exact.files[0]?.contents, source)
})

test("cat/head operands are literal and flags, stdin, expansions and unsupported options are not guessed", () => {
  for (const command of ["cat -n -- 'a file' b", "head -n 5 'a file' b", "head --bytes=10 'a file' b", "env -i cat 'a file' b", "/usr/bin/head -10 'a file' b"]) {
    assert.deepEqual(discover(command, "/p").references.map((r) => r.filename), ["a file", "b"], command)
  }
  assert.deepEqual(discover("cat -- -n", "/p").references.map((r) => r.filename), ["-n"])
  assert.deepEqual(discover("cat -", "/p").references, [])
  for (const command of ["head -n value decoy", "cat --unsupported decoy", "head -n $COUNT decoy", "cat $FILE", "cat *.txt", "cat $(touch sentinel)"]) {
    const result = discover(command, "/p")
    assert.deepEqual(result.references, [], command)
    assert.ok(result.limitations.length, command)
  }
})
