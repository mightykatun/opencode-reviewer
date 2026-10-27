import assert from "node:assert/strict"
import { test } from "node:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runtimeOperands } from "../src/shell-runtimes.js"
import { collectEvidence, discover } from "../src/evidence.js"

test("documented script, data, document and SQL inputs are identified without their output or option values", () => {
  const cases: [string, string[], string[]][] = [
    ["Rscript", ["--vanilla", "script.R", "argument.csv"], ["script.R"]],
    ["Rscript", ["--file=script.R", "other.R"], ["script.R"]],
    ["julia", ["--threads=2", "-L", "preload.jl", "main.jl", "other.jl"], ["preload.jl", "main.jl"]],
    ["awk", ["-F", ",", "-f", "filter.awk", "a.csv", "NAME=not-a-file.csv", "b.csv"], ["filter.awk", "a.csv", "b.csv"]],
    ["gawk", ["-v", "n=1", "{print $1}", "data.txt"], ["data.txt"]],
    ["awk", ["--", "-e", "data.txt"], ["data.txt"]],
    ["gawk", ["-e", "{print $1}", "data.txt"], ["data.txt"]],
    ["sed", ["-n", "-f", "edits.sed", "--", "-data.txt"], ["edits.sed", "-data.txt"]],
    ["sed", ["-e", "s/a/b/", "first.txt", "second.txt"], ["first.txt", "second.txt"]],
    ["sed", ["s/a/b/", "first.txt"], ["first.txt"]],
    ["sed", ["--", "-e", "data.txt"], ["data.txt"]],
    ["jq", ["--arg", "name", "not-file.json", "-f", "filter.jq", "--slurpfile", "ref", "ref.json", "data.json"],
      ["filter.jq", "ref.json", "data.json"]],
    ["jq", ["--rawfile", "text", "notes.txt", ".", "data.json", "--args", "not-input.json"],
      ["notes.txt", "data.json"]],
    ["jq", ["--", "--from-file=not-a-file.jq", "data.json"], ["data.json"]],
    ["pandoc", ["-f", "markdown", "first.md", "-o", "generated.html", "-L", "filter.lua", "second.md"],
      ["first.md", "filter.lua", "second.md"]],
    ["pandoc", ["--defaults=opts.yaml", "--metadata-file", "meta.yaml", "--template=layout.html", "doc.md"],
      ["opts.yaml", "meta.yaml", "layout.html", "doc.md"]],
    ["psql", ["-d", "database.sql", "-c", "SELECT 1", "-f", "setup.sql", "--output", "generated.sql", "--file=next.sql"],
      ["setup.sql", "next.sql"]],
  ]
  for (const [exe, args, files] of cases)
    assert.deepEqual(runtimeOperands(exe, args), { handled: true, files, limitations: [] }, `${exe} ${args.join(" ")}`)
})

test("unclassified commands, unsupported options and indirect sources cannot disclose decoy operands", () => {
  const cases: [string, string[]][] = [
    ["Rscript", ["-e", "source('hidden.R')", "decoy.R"]],
    ["Rscript", ["--mystery", "decoy.R"]],
    ["julia", ["--project", "other", "main.jl"]],
    ["julia", ["-e", "include(\"hidden.jl\")", "decoy.jl"]],
    ["awk", ["-i", "local.awk", "-f", "main.awk"]],
    ["awk", ["--source", "{print $1}", "decoy.txt"]],
    ["awk", ["-f", "main.awk", "--unknown", "decoy.txt"]],
    ["sed", ["-i", "secret.txt"]],
    ["sed", ["-e", "script", "--unknown", "decoy.txt"]],
    ["jq", ["-L", "modules", ".", "decoy.json"]],
    ["jq", ["-n", ".", "decoy.json"]],
    ["jq", ["-f", "filter.jq", "--mystery", "decoy.json"]],
    ["pandoc", ["--resource-path", "sources", "decoy.md"]],
    ["pandoc", ["doc.md", "--unknown", "decoy.md"]],
    ["psql", ["database.sql", "user.sql"]],
    ["psql", ["-f", "setup.sql", "--unknown", "decoy.sql"]],
  ]
  for (const [exe, args] of cases) {
    const parsed = runtimeOperands(exe, args)
    assert.deepEqual(parsed.files, [], `${exe} ${args.join(" ")}`)
    assert.ok(parsed.limitations.length, `${exe} ${args.join(" ")}`)
  }
  assert.deepEqual(runtimeOperands("mystery", ["input.sql"]), { handled: false, files: [], limitations: [] })
  assert.deepEqual(runtimeOperands("./jq", ["-f", "filter.jq"]), { handled: false, files: [], limitations: [] })
})

test("capture only named text and SQL snapshots under the existing file and byte budgets", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-text-inputs-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = "SELECT * FROM users;\n"
  for (const [name, content] of [["script.R", "print(42)\n"], ["filter.awk", "{print $1}\n"],
    ["data.csv", "username,password\nalice,secret\n"], ["query.sql", source],
    ["notes.md", "# Notes\n"], ["filter.jq", ".items[]\n"], ["rows.json", "{\"items\":[]}\n"],
    ["generated.sql", "not an input\n"]] as const) await writeFile(`${dir}/${name}`, content)
  const marker = `${dir}/not-executed`
  const command = `Rscript script.R; awk -f filter.awk data.csv; jq -f filter.jq rows.json; `
    + `psql -f query.sql -o generated.sql; pandoc -o generated.html notes.md; psql < query.sql > generated.sql; `
    + `psql -f "$(touch ${marker}; printf generated.sql)"`
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Review" },
    { maxEvidenceBytes: 65536, maxFiles: 8 }, new AbortController().signal)
  assert.deepEqual(result.files.map(file => file.filename),
    ["script.R", "filter.awk", "data.csv", "filter.jq", "rows.json", "query.sql", "notes.md"])
  assert.equal(result.files.find(file => file.filename === "query.sql")?.contents, source)
  const broad = await collectEvidence({ command, cwd: dir, userPrompt: "Review" },
    { maxEvidenceBytes: 65536, maxFiles: 8, includeShellArgumentFiles: true }, new AbortController().signal)
  assert.equal(broad.files.find(file => file.filename === "generated.sql")?.basis, "literal argument; input role unknown")
  assert.ok(result.files.every(file => file.status === "captured"))
  await assert.rejects(access(marker))
  const limited = await collectEvidence({ command: "pandoc notes.md data.csv; psql -f query.sql", cwd: dir, userPrompt: "Review" },
    { maxEvidenceBytes: 100, maxFiles: 1 }, new AbortController().signal)
  assert.deepEqual(limited.files.map(file => file.status), ["captured", "file-count limit reached", "file-count limit reached"])
  assert.deepEqual(discover("psql -f missing.sql", dir).references,
    [{ filename: "missing.sql", cwd: dir, executable: false }])
})
