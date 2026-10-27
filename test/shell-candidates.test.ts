import assert from "node:assert/strict"
import { test } from "node:test"
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectEvidence, discover, discoverWithCandidates } from "../src/evidence.js"
import { parseConfig } from "../src/config.js"

const limits = { maxFiles: 3, maxEvidenceBytes: 4096, includeShellArgumentFiles: true }
const signal = () => new AbortController().signal
const basis = "literal argument; input role unknown"

test("literal argument files require an explicit strict boolean setting", () => {
  const options = { baseURL: "http://localhost/v1", model: "reviewer" }
  assert.equal(parseConfig(options).includeShellArgumentFiles, false)
  assert.equal(parseConfig({ ...options, includeShellArgumentFiles: false }).includeShellArgumentFiles, false)
  assert.equal(parseConfig({ ...options, includeShellArgumentFiles: true }).includeShellArgumentFiles, true)
  for (const value of [null, "true", 1, [], {}])
    assert.throws(() => parseConfig({ ...options, includeShellArgumentFiles: value }), /includeShellArgumentFiles/)
  assert.throws(() => parseConfig({ ...options, includeShellArguments: true }), /Unknown opencode-reviewer setting/)
})

test("one syntax traversal exposes certain inputs separately from unclassified argv candidates", () => {
  const dir = "/project"
  const command = "custom --config=settings --file ./source --output old.txt < stdin.txt > stdout.txt"
  assert.deepEqual(discover(command, dir).references, [{ filename: "stdin.txt", cwd: dir, executable: false }])
  const found = discoverWithCandidates(command, dir)
  assert.deepEqual(discoverWithCandidates(command, dir, signal(), false).candidates, [])
  assert.deepEqual(found.references, [{ filename: "stdin.txt", cwd: dir, executable: false }])
  assert.deepEqual(found.candidates.map(item => item.filename), ["settings", "./source", "old.txt"])
  assert.ok(!found.candidates.some(item => item.filename === "stdout.txt"))
  assert.deepEqual(discoverWithCandidates("custom '$(not executed)' $DYNAMIC *.txt https://example.test/a", dir).candidates,
    [{ filename: "$(not executed)", cwd: dir, executable: false }])
})

test("default discovery captures known operands and redirects, not unknown command argument files", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-argv-default-off-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/data.txt`, "existing data\n")
  await writeFile(`${dir}/stdin.txt`, "redirected data\n")
  const command = "unknown-tool data.txt < stdin.txt; cat data.txt"
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Inspect" },
    { maxFiles: 3, maxEvidenceBytes: 4096 }, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["stdin.txt", "data.txt"])
  assert.ok(result.files.every(file => file.basis === undefined))
  assert.match(result.limitations.join(" "), /Only literal file inputs recognized/)
  const unknown = await collectEvidence({ command: "unknown-tool data.txt", cwd: dir, userPrompt: "Inspect" },
    { maxFiles: 3, maxEvidenceBytes: 4096 }, signal())
  assert.deepEqual(unknown.files, [])
})

test("any external tool can supply literal file values, even when their roles are unknown", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-argv-candidates-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, contents] of [["dataset", "from-data\n"], ["settings", "from-config\n"],
    ["previous.out", "old-output\n"], ["script.py", "print(3)\n"]] as const)
    await writeFile(path.join(dir, name), contents)
  const command = "custom-tool --input dataset --config=settings -o previous.out --missing unknown "
    + "--remote https://example.test/not-a-file"
  const evidence = await collectEvidence({ command, cwd: dir, userPrompt: "Run custom tool" }, limits, signal())
  assert.deepEqual(evidence.files.map(file => file.filename), ["dataset", "settings", "previous.out"])
  assert.deepEqual(evidence.files.map(file => file.contents), ["from-data\n", "from-config\n", "old-output\n"])
  assert.ok(evidence.files.every(file => file.basis === basis))
  assert.match(evidence.limitations.join(" "), /may be outputs or unrelated/)
  const known = await collectEvidence({ command: "python script.py dataset", cwd: dir, userPrompt: "Run" }, limits, signal())
  assert.deepEqual(known.files.map(file => file.filename), ["script.py", "dataset"])
  assert.equal(known.files[0]?.basis, undefined)
  assert.equal(known.files[1]?.basis, basis)
})

test("missing arguments do not occupy file slots before certain inputs or later existing candidates", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-argv-budget-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/late.txt`, "late\n")
  await writeFile(`${dir}/stdin.txt`, "stdin\n")
  const command = `custom --missing=${Array.from({ length: 10 }, (_, i) => `absent${i}`).join(" absent")} late.txt < stdin.txt`
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Run" },
    { ...limits, maxFiles: 2 }, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["stdin.txt", "late.txt"])
  assert.equal(result.files[1]?.basis, basis)
  await mkdir(`${dir}/folder`)
  await writeFile(`${dir}/binary.bin`, Buffer.from([0, 1, 2]))
  const unavailable = await collectEvidence({ command: "custom folder binary.bin late.txt", cwd: dir, userPrompt: "Run" }, limits, signal())
  assert.deepEqual(unavailable.files.map(file => file.filename), ["binary.bin", "late.txt"])
  assert.equal(unavailable.files[0]?.status, "binary content; contents not provided")
  assert.equal(unavailable.files[1]?.contents, "late\n")
  assert.ok(unavailable.files.every(file => file.basis === basis))
  const certainFirst = await collectEvidence({ command: "custom late.txt < stdin.txt", cwd: dir, userPrompt: "Run" },
    { ...limits, maxFiles: 1 }, signal())
  assert.deepEqual(certainFirst.files.map(file => file.filename), ["stdin.txt", "late.txt"])
  assert.equal(certainFirst.files[0]?.contents, "stdin\n")
  assert.equal(certainFirst.files[1]?.status, "file-count limit reached")
  assert.equal(certainFirst.files[1]?.basis, basis)
  await symlink("stdin.txt", `${dir}/same-file`)
  const alias = await collectEvidence({ command: "custom same-file < stdin.txt", cwd: dir, userPrompt: "Run" },
    { ...limits, maxFiles: 1 }, signal())
  assert.equal(alias.files.length, 1)
  assert.equal(alias.files[0]?.contents, "stdin\n")
  assert.deepEqual(alias.files[0]?.aliases, [`${dir}/same-file`])
})

test("unknown cwd, command substitutions and shell builtins do not turn outputs into file evidence", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-argv-nonexec-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const marker = `${dir}/not-executed`
  await writeFile(`${dir}/source`, "content\n")
  const commands = ["cd elsewhere; custom source", `custom "$(touch ${marker}; printf source)"`,
    "echo source", "printf source", "custom https://example.test/source"]
  for (const command of commands) {
    const result = await collectEvidence({ command, cwd: dir, userPrompt: "Run" }, limits, signal())
    assert.ok(!result.files.some(file => file.contents === "content\n"), command)
  }
  await assert.rejects(access(marker))
  const absolute = await collectEvidence({ command: `cd elsewhere; custom ${dir}/source`, cwd: dir, userPrompt: "Run" }, limits, signal())
  assert.equal(absolute.files[0]?.contents, "content\n")
  assert.equal(absolute.files[0]?.basis, basis)
})
