import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, open, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectEvidence, discover } from "../src/evidence.js"
import { collectHostEvidence } from "../src/host-evidence.js"
import { nativeInvocation } from "./review-fixtures.js"
import { parseConfig } from "../src/config.js"
import { FileAccess } from "../src/file-access.js"

const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", maxFiles: 16 })
const signal = () => new AbortController().signal
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "review-shell-differential-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

// Only these tests execute shell text. The probes run fixed harmless fixtures in
// an empty environment and print operands/cwd, never execute the Python sources.
function bash(command: string, cwd: string, pwd = cwd): Buffer {
  return execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
    cwd, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", PWD: pwd }, timeout: 5000,
  })
}

async function evaluated(command: string, cwd: string, workdir?: string, files = new FileAccess()) {
  const collected = await collectHostEvidence(nativeInvocation("shell", { command,
    ...(workdir === undefined ? {} : { workdir }) }, undefined, cwd, [command]), config, signal(), files)
  assert.ok(collected.status === "ready" && collected.evidence.kind === "shell")
  const result = collected.evidence
  assert.equal(result.command, command)
  assert.deepEqual(result.permission.resources, [command])
  return result
}

test("F01 Bash byte operands never become tokenizer-decoded source decoys", async t => {
  const dir = await fixture(t)
  for (const [operand, bytes, decoy] of [
    [String.raw`$'\xc3\xa9.py'`, [0xc3, 0xa9], "Ã©.py"],
    [String.raw`$'\303\251.py'`, [0xc3, 0xa9], "Ã©.py"],
    [String.raw`$'\xff.py'`, [0xff], "ÿ.py"],
    [String.raw`$'\377.py'`, [0xff], "ÿ.py"],
    [String.raw`$'\xe2\x82\xac.py'`, [0xe2, 0x82, 0xac], "â\u0082¬.py"],
  ] as const) {
    const expected = Buffer.concat([Buffer.from(bytes), Buffer.from(".py")])
    const observed = bash(`printf '%s' ${operand}`, dir)
    assert.deepEqual(observed, expected, operand)
    assert.notDeepEqual(observed, Buffer.from(decoy), "Bash selects different filename bytes from the decoy")
    await writeFile(Buffer.concat([Buffer.from(`${dir}/`), expected]), "# actual byte-selected source\n")
    await writeFile(`${dir}/${decoy}`, "# ANSI-C DECOY\n")
    for (const command of [`python ${operand}`, `python prefix${operand}`, `bash -c ${quote(`python ${operand}`)}`]) {
      const found = discover(command, dir)
      assert.deepEqual(found.references, [], command)
      assert.match(found.limitations.join(" "), /ANSI-C shell quoting/, command)
      for (const result of [await collectEvidence({ command, cwd: dir, userPrompt: "Inspect" }, config, signal()), await evaluated(command, dir)]) {
        assert.equal(result.command, command)
        assert.deepEqual(result.files, [], command)
        assert.match(result.limitations.join(" "), /ANSI-C shell quoting/)
        assert.doesNotMatch(JSON.stringify(result), /ANSI-C DECOY/)
      }
    }
  }
  // The syntax detector must respect ordinary quoting, escaping and comments.
  for (const operand of ['"\\$\'literal.py"', String.raw`\$\'literal.py`]) {
    const filename = "$'literal.py"
    await writeFile(`${dir}/${filename}`, "# literal dollar and quote\n")
    assert.deepEqual(bash(`printf '%s' ${operand}`, dir), Buffer.from(filename))
    const result = await evaluated(`python ${operand}`, dir)
    assert.equal(result.files[0]?.contents, "# literal dollar and quote\n")
  }
  assert.doesNotMatch(discover('python "$\'literal.py"', dir).limitations.join(" "), /ANSI-C shell quoting/)
  assert.deepEqual(discover("python plain.py # $'ignored'", dir).limitations, [])
})

test("F02 Bash negation changes status, not cwd effects, and unknown negated state stays unresolved", async t => {
  const dir = await fixture(t)
  await mkdir(`${dir}/sub`)
  await writeFile(`${dir}/job.py`, "# NEGATION PARENT DECOY\n")
  await writeFile(`${dir}/sub/job.py`, "# changed cwd target\n")
  await writeFile(`${dir}/change.sh`, "cd sub\n")
  const cases = [
    ["! cd sub", `${dir}/sub`],
    ["! command cd sub", `${dir}/sub`],
    ["! builtin cd sub", `${dir}/sub`],
    ["! ! cd sub", `${dir}/sub`],
    ["! source ./change.sh", `${dir}/sub`],
    ["! . ./change.sh", `${dir}/sub`],
    ["! eval 'cd sub'", `${dir}/sub`],
    ["! pushd sub", `${dir}/sub`],
    ["! set -P; cd sub", `${dir}/sub`],
    ["! /bin/true", dir],
    ["! /bin/false", dir],
    ["! /bin/bash -c 'cd sub'", dir],
  ]
  for (const [statement, expected] of cases) {
    // Ignore pushd's own stdout; the last line is the independent cwd probe.
    const observed = bash(`${statement}; pwd -P`, dir).toString().trim().split("\n").at(-1)
    assert.equal(observed, expected, statement)
    const command = `${statement}; python job.py`
    for (const result of [await collectEvidence({ command, cwd: dir, userPrompt: "Inspect" }, config, signal()), await evaluated(command, dir)]) {
      assert.equal(result.command, command)
      assert.equal(result.files.length, 1, command)
      assert.equal(result.files[0]?.contents, undefined, command)
      assert.match(result.files[0]!.status, /working directory unresolved/, command)
      assert.match(result.limitations.join(" "), /negation.*unresolved/, command)
      assert.doesNotMatch(JSON.stringify(result), /NEGATION PARENT DECOY/)
    }
  }
  for (const command of ["! cd sub && python job.py", "! cd sub || python job.py", "! $ACTION sub; python job.py", "! unsupported sub; python job.py"]) {
    assert.equal(discover(command, dir).references.at(-1)?.cwd, null, command)
  }
  for (const [command, output] of [
    ["! cd sub; python job.py", `${dir}/sub\njob.py\n`],
    ["! cd sub && python job.py", ""],
    ["! cd sub || python job.py", `${dir}/sub\njob.py\n`],
    ["! /bin/false && python job.py", `${dir}\njob.py\n`],
  ]) {
    // Turn the interpreter into a harmless argv/cwd recorder. An explicit true
    // keeps the probe process successful even when ! skips the invocation.
    const probe = `python() { builtin printf '%s\\n' "$PWD" "$1"; }; ${command}; true`
    assert.equal(bash(probe, dir).toString(), output, command)
  }
  // Explicit external children do not change the parent's cwd, without negation.
  const control = await evaluated("/bin/bash -c 'cd sub'; python job.py", dir)
  assert.equal(control.files[0]?.contents, "# NEGATION PARENT DECOY\n")
  // A rejected negated statement in a child must not taint the outer shell.
  const nested = discover(`bash -c '! cd sub; python job.py'; python job.py`, dir)
  assert.deepEqual(nested.references.map(reference => reference.cwd), [null, dir])
  assert.equal(await readFile(`${dir}/change.sh`, "utf8"), "cd sub\n")
  const payload = "! eval 'printf executed > marker'; python job.py"
  await collectEvidence({ command: payload, cwd: dir, userPrompt: "Inspect" }, config, signal())
  await evaluated(payload, dir)
  await assert.rejects(readFile(`${dir}/marker`), { code: "ENOENT" })
})

test("F04 Bash logical and physical launch controls preserve direct source but omit ambiguous post-cd targets", async t => {
  const dir = await fixture(t)
  const project = `${dir}/project`, outside = `${dir}/outside`, launch = `${project}/launch-link`
  await mkdir(project)
  await mkdir(`${outside}/deep`, { recursive: true })
  await symlink(`${outside}/deep`, launch)
  await writeFile(`${project}/job.py`, "# logical PWD target\n")
  await writeFile(`${outside}/job.py`, "# physical PWD target\n")
  await writeFile(`${outside}/deep/direct.py`, "# direct source before cd\n")
  await writeFile(`${project}/direct.py`, "# DIRECT SOURCE DECOY\n")
  for (const [pwd, expected] of [[launch, project], [project, outside], ["/missing-inherited-pwd", outside]]) {
    assert.equal(bash("cd .. && pwd -P", launch, pwd).toString().trim(), expected)
    assert.equal(bash("cat direct.py", launch, pwd).toString(), "# direct source before cd\n")
    assert.equal(bash("cat ../job.py", launch, pwd).toString(), "# physical PWD target\n")
    assert.equal(bash("cd .. && cat job.py", launch, pwd).toString(), await readFile(`${expected}/job.py`, "utf8"))
  }
  for (const command of [
    "python direct.py; cd .. && python job.py",
    "python direct.py; command cd .. && python job.py",
    "python direct.py; bash -c 'cd .. && python job.py'",
    "python direct.py; bash -c 'sh -c \"cd .. && python job.py\"'",
  ]) {
    for (const result of [
      await collectEvidence({ command, cwd: launch, userPrompt: "Inspect" }, config, signal()),
      await evaluated(command, launch),
      await evaluated(command, project, "launch-link"),
      await evaluated(command, project, launch),
    ]) {
      assert.equal(result.command, command)
      assert.equal(result.cwd, launch)
      assert.equal(result.files.length, 2)
      assert.equal(result.files[0]?.contents, "# direct source before cd\n")
      assert.equal(result.files[0]?.path, `${launch}/direct.py`)
      assert.equal(result.files[1]?.contents, undefined)
      assert.match(result.files[1]!.status, /working directory unresolved/)
      assert.match(result.limitations.join(" "), /logical PWD.*after cd is unresolved/)
      assert.doesNotMatch(JSON.stringify(result), /# logical PWD target|# physical PWD target|DIRECT SOURCE DECOY/)
      if (result.execution) {
        assert.equal(result.execution.canonicalCwd, `${outside}/deep`)
        assert.match(result.limitations.join(" "), /Declared invocation directory differs/)
      }
    }
  }
  const directParent = await evaluated("python ../job.py", launch)
  assert.equal(directParent.files[0]?.contents, "# physical PWD target\n")
  const absolute = await evaluated(`cd .. && python ${outside}/job.py`, launch)
  assert.equal(absolute.files[0]?.contents, "# physical PWD target\n")
  const unambiguous = await evaluated("cd .. && python job.py", `${outside}/deep`)
  assert.equal(unambiguous.files[0]?.contents, "# physical PWD target\n")
  // An unavailable canonical path cannot justify post-cd inference either.
  const unresolved = discover("python direct.py; cd .. && python job.py", { declared: launch, canonical: null })
  assert.deepEqual(unresolved.references.map(reference => reference.cwd), [launch, null])
  const inaccessible = await evaluated("python direct.py; cd .. && python job.py", launch, undefined,
    new FileAccess({ open, realpath: async filename => {
      if (filename === launch) throw Object.assign(new Error("fixture probe unavailable"), { code: "EACCES" })
      return realpath(filename)
    } }))
  assert.equal(inaccessible.execution?.canonicalCwd, null)
  assert.equal(inaccessible.files[0]?.contents, "# direct source before cd\n")
  assert.equal(inaccessible.files[1]?.contents, undefined)
  assert.match(inaccessible.limitations.join(" "), /Canonical invocation working directory unavailable \(EACCES\)/)
})
