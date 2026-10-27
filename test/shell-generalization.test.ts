import { test } from "node:test"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectEvidence, discover } from "../src/evidence.js"

const signal = () => new AbortController().signal
const limits = { maxFiles: 16, maxEvidenceBytes: 65536 }

test("literal runtime operands and input redirection are captured across lines", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const name of ["app.js", "settings.json", "job.rb", "main.go", "Main.java", "app.csproj", "job.py"]) {
    await writeFile(`${dir}/${name}`, `# actual ${name}\n`)
  }
  const command = "node app.js < settings.json\nruby job.rb && go run main.go; java Main.java | dotnet run --project app.csproj; uv run python job.py"
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["app.js", "settings.json", "job.rb", "main.go", "Main.java", "app.csproj", "job.py"])
  assert.ok(result.files.every(file => file.status === "captured"))
  assert.equal(result.files[1]?.contents, "# actual settings.json\n")
})

test("static groups and substitutions retain named inputs but not generated operands or output files", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const name of ["nested.txt", "config.json", "app.js", "maybe.js", "out.log"]) await writeFile(`${dir}/${name}`, name)
  const command = "(cat nested.txt); node app.js < config.json > out.log; node \"$(cat nested.txt)\"; node maybe*.js"
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["nested.txt", "app.js", "config.json"])
  assert.match(result.limitations.join(" "), /unresolved|glob|generated|expansion/i)
  assert.equal(result.files.find(file => file.filename === "out.log"), undefined)
})

test("a quoted shell heredoc can contain literal commands without treating its text as a pathname", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/job.py`, "# nested source\n")
  const command = "bash <<'EOF'\npython job.py\nEOF"
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["job.py"])
  assert.equal(result.files[0]?.contents, "# nested source\n")
  assert.deepEqual(discover("cat <<'EOF'\npython job.py\nEOF", dir).references, [])
  assert.deepEqual(discover("bash <<EOF\npython job.py\nEOF", dir).references.map(file => file.filename), ["job.py"])
  assert.deepEqual(discover("bash <<EOF\npython job\\ file.py\nEOF", dir).references.map(file => file.filename), ["job file.py"])
})

test("subshell and command-substitution cwd changes cannot select parent-directory decoys", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(`${dir}/sub`)
  await writeFile(`${dir}/job.py`, "# parent\n")
  await writeFile(`${dir}/sub/job.py`, "# child\n")
  const command = "(cd sub && python job.py); cat $(cd sub && printf job.py); python job.py"
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.equal(result.files.find(file => file.path === `${dir}/sub/job.py`)?.contents, "# child\n")
  assert.equal(result.files.find(file => file.path === `${dir}/job.py`)?.contents, "# parent\n")
  assert.match(result.limitations.join(" "), /unresolved|expansion|substitution/i)
})

test("input redirects use the cwd before a builtin changes it", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(`${dir}/sub`)
  await writeFile(`${dir}/config.txt`, "# parent input\n")
  await writeFile(`${dir}/sub/config.txt`, "# wrong post-cd input\n")
  await writeFile(`${dir}/sub/job.py`, "# sub source\n")
  const result = await collectEvidence({ command: "cd sub < config.txt && python job.py", cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.deepEqual(result.files.map(file => file.contents), ["# parent input\n", "# sub source\n"])
})

test("a non-shell heredoc body is not scanned as shell commands", () => {
  const result = discover("cat <<'EOF'\npython decoy.py\nEOF\npython real.py", "/project")
  assert.deepEqual(result.references.map(file => file.filename), ["real.py"])
})

test("the parser does not execute substitutions, substitutions cannot select their output as a filename", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const marker = `${dir}/marker`
  await writeFile(`${dir}/app.js`, "// decoy\n")
  const result = await collectEvidence({ command: `node "$(touch ${marker}; printf app.js)"`, cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.ok(!result.files.some(file => file.filename === "app.js"))
  assert.match(result.limitations.join(" "), /unresolved|expansion|dynamic/i)
  await assert.rejects(access(marker))
})

test("named task launchers do not inspect manifests or makefiles", () => {
  for (const command of ["npm run build", "make test", "go run *.go", "node \"$(printf app.js)\""]) {
    const result = discover(command, "/project")
    assert.deepEqual(result.references, [], command)
    assert.match(result.limitations.join(" "), /unresolved|indirect|glob|task|expansion/i, command)
  }
})

test("file-descriptor redirects are not script operands or readable file targets", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const name of ["2", "main.py", "out.log"]) await writeFile(`${dir}/${name}`, name)
  const result = await collectEvidence({ command: "python 2>out.log main.py; python '2'>out.log", cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["main.py", "2"])
  assert.ok(result.files.every(file => file.status === "captured"))
  await writeFile(`${dir}/input.txt`, "# input fd\n")
  const input = discover("python main.py 3<input.txt", dir)
  assert.deepEqual(input.references.map(file => file.filename), ["main.py", "input.txt"])
})

test("a comment ends at a newline while quoted filenames remain one operand", () => {
  const result = discover("node 'app file.js' # ruby ignored.rb\nruby real.rb", "/project")
  assert.deepEqual(result.references.map(file => file.filename), ["app file.js", "real.rb"])
})

test("structured parsing keeps quoted Unicode and escaped metacharacters byte-faithful", () => {
  for (const [operand, expected] of [
    ["'file[12].js'", "file[12].js"],
    [String.raw`file\[12\].js`, "file[12].js"],
    ["'fruit script.js'", "fruit script.js"],
    [String.raw`'a\b.js'`, String.raw`a\b.js`],
    [String.raw`"a\$b.js"`, "a$b.js"],
  ] as const) {
    const result = discover(`node ${operand} < config.json`, "/project")
    assert.deepEqual(result.references.map(file => file.filename), [expected, "config.json"], operand)
  }
  assert.deepEqual(discover("node safe.js decoy.js < config.json", "/project").references, [])
  assert.match(discover("node $'\\xff.js' < config.json", "/project").limitations.join(" "), /ANSI-C/)
})

test("function declarations and timed groups do not claim uninvoked source as executed", () => {
  for (const command of ["worker() { python decoy.py; }", "function worker() { python decoy.py; }", "time (python decoy.py)"]) {
    const result = discover(command, "/project")
    assert.deepEqual(result.references, [], command)
    assert.match(result.limitations.join(" "), /group|function|timed|unsupported/i, command)
  }
})

test("an unquoted dynamic heredoc never executes or claims a generated source file", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-general-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const marker = `${dir}/marker`
  await writeFile(`${dir}/app.js`, "// decoy\n")
  const result = await collectEvidence({ command: `bash <<EOF\nnode $(touch ${marker}; printf app.js)\nEOF`, cwd: dir, userPrompt: "Review" }, limits, signal())
  assert.ok(!result.files.some(file => file.filename === "app.js"))
  assert.match(result.limitations.join(" "), /unresolved|expansion|dynamic|heredoc/i)
  await assert.rejects(access(marker))
})
