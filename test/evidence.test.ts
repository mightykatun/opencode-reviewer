import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, appendFile, utimes, open, symlink, rm, access, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { discover, collectEvidence } from "../src/evidence.js"
import { withDeadline } from "../src/deadline.js"

const limits = { maxFiles: 4, maxEvidenceBytes: 65536 }
const signal = () => new AbortController().signal

test("physical shell modes, traps and timed builtins never capture known-cwd decoys", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-shell-state-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = `${dir}/project`, outside = `${dir}/outside`
  await mkdir(project); await mkdir(`${outside}/deep`, { recursive: true })
  await symlink(`${outside}/deep`, `${project}/link`)
  await writeFile(`${project}/job.py`, "# stale cwd decoy\n")
  await writeFile(`${dir}/job.py`, "# timed cd decoy\n")
  await writeFile(`${outside}/job.py`, "# physical target\n")
  for (const command of [
    "bash -P -c 'cd link/.. && python3 job.py'",
    "bash -o physical -c 'cd link/.. && python3 job.py'",
    "bash -ePc 'cd link/.. && python3 job.py'",
    "bash +P -P -c 'cd link/.. && python3 job.py'",
    "bash +o physical -o physical -c 'cd link/.. && python3 job.py'",
    `trap 'cd ${outside}' DEBUG; python3 job.py`,
    `builtin trap 'cd ${outside}' DEBUG; python3 job.py`,
    "time cd link && python3 ../job.py",
    "time -p cd link && python3 ../job.py",
  ]) await t.test(command, async () => {
    const result = await collectEvidence({ command, cwd: project, userPrompt: "Inspect job" }, limits, signal())
    assert.ok(result.files.length, command)
    assert.ok(result.files.every(file => file.contents === undefined), command)
    assert.match(result.limitations.join(" "), /physical|trap|timed|time.*unresolved/, command)
    assert.ok(result.files.every(file => /working directory unresolved/.test(file.status)), command)
  })
  for (const command of [
    "bash -P +P -c 'cd link/.. && python3 job.py'",
    "bash -o physical +o physical -c 'cd link/.. && python3 job.py'",
    "bash -P +eP -c 'cd link/.. && python3 job.py'",
    "bash -P job.py",
  ]) {
    const result = await collectEvidence({ command, cwd: project, userPrompt: null }, limits, signal())
    assert.equal(result.files[0]?.contents, "# stale cwd decoy\n", command)
  }
  const nested = discover("bash -Pc 'cd link/.. && python job.py'; python job.py", project)
  assert.deepEqual(nested.references.map(ref => ref.cwd), [null, project])
  assert.equal(discover(`/usr/bin/time cd link; python job.py`, project).references.at(-1)?.cwd, project)
  assert.equal(discover(`command time cd link; python job.py`, project).references.at(-1)?.cwd, project)
})

test("literal discovery: quoted paths, flags, wrappers, compounds and nested shell strings", () => {
  for (const command of [
    'python3 "fruit script.py"',
    'python3 -I -W ignore -X utf8 -- "fruit script.py"',
    'env -i LANG=C python3 "fruit script.py"',
    'command -- python3 "fruit script.py"',
    `bash -lc 'python3 "fruit script.py"'`,
  ]) {
    assert.deepEqual(discover(command, "/project").references.map((r) => r.filename), ["fruit script.py"], command)
  }
  const result = discover("cd scripts && python main.py; bash check.sh", "/project")
  assert.deepEqual(result.references.map((r) => [r.filename, r.cwd]), [["main.py", "/project/scripts"], ["check.sh", null]])
  assert.match(result.limitations.join("\n"), /cd may fail or be skipped/)
  assert.equal(discover("python -c 'print(1)'", "/p").references.length, 0)
  assert.deepEqual(discover("bash -eu task.sh | python3 summarize.py", "/p").references.map((r) => r.filename), ["task.sh", "summarize.py"])
})

test("interpreter options stay distinct from script operands and preserve option terminators", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const filename of ["main.sh", "main.py", "task", "+x", "+ex", "-W", "-X", "-"]) {
    await writeFile(`${dir}/${filename}`, `# literal source ${filename}\n`)
  }
  for (const [command, filename] of [
    ["bash +x main.sh", "main.sh"],
    ["bash +ex -u main.sh", "main.sh"],
    ["sh +x task", "task"],
    ["bash -o pipefail +o xtrace -- task", "task"],
    ["bash --noprofile --norc +x task", "task"],
    ["python3 -I -W ignore -X utf8 -- main.py", "main.py"],
    ["python -Wignore -Xutf8 -s task", "task"],
    ["python +x", "+x"],
    ["bash -- +x", "+x"],
    ["bash -- -W", "-W"],
    ["python -- -X", "-X"],
    ["python -- ./-", "./-"],
  ]) {
    const discovered = discover(command!, dir)
    assert.deepEqual(discovered.references.map((r) => r.filename), [filename], command)
    assert.deepEqual(discovered.limitations, [], command)
    const result = await collectEvidence({ command: command!, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.command, command)
    assert.equal(result.files[0]?.status, "captured", command)
    assert.equal(result.files[0]?.contents, `# literal source ${path.basename(filename!)}\n`, command)
  }
})

test("stdin and unsupported interpreter options never claim argv candidates as interpreter source", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const filename of ["-", "+W", "-W", "-X", "ignore", "utf8", "main.py", "main.sh"]) {
    await writeFile(`${dir}/${filename}`, "# option or stdin decoy\n")
  }
  for (const command of ["python -- -", "python -I -- - main.py", "python - main.py", "bash -s main.sh", "bash -eus main.sh", "python --", "bash --"]) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references, [], command)
    assert.match(discovered.limitations.join("\n"), /reads stdin/, command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.ok(result.files.every(file => file.basis === "literal argument; input role unknown"), command)
    assert.ok(result.files.every(file => !["-", "-W", "-X"].includes(file.filename)), command)
  }
  for (const command of [
    "bash -W ignore main.sh", "bash -X utf8 main.sh", "sh -Wignore main.sh", "sh -Xutf8 main.sh",
    "bash +W main.sh", "bash +s main.sh", "bash -Ws main.sh", "bash -Xc 'python main.py'",
    "bash -Wc 'python main.py'", "bash -ce 'python main.py'", "bash -- -", "bash - main.sh",
    "python -W", "python -X", "bash -o", "bash +o", 'python -W "$FILTER" main.py',
  ]) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references, [], command)
    assert.match(discovered.limitations.join("\n"), /outside supported script discovery|missing or unresolved argument/, command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.command, command)
    assert.ok(result.files.every(file => file.basis === "literal argument; input role unknown"), command)
    assert.ok(result.files.every(file => !["-", "-W", "-X"].includes(file.filename)), command)
  }
})

test("bounded wrapper compositions preserve literal and extensionless interpreter operands", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/task file`, "# extensionless wrapped source\n")
  for (const command of [
    'command env python "task file"',
    'exec env python "task file"',
    'env -- MODE=test python "task file"',
    'command -- exec -- /usr/bin/env -i -u UNUSED -- MODE=test python "task file"',
    'MODE=test command env -- OTHER=value python "task file"',
    'env --ignore-environment --unset UNUSED env -- MODE=test python "task file"',
    'command command -- python "task file"',
    'env env env env env env env env python "task file"',
    'exec env bash +x "task file"',
  ]) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references, [{ filename: "task file", cwd: dir, executable: false }], command)
    assert.deepEqual(discovered.limitations, [], command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.command, command)
    assert.equal(result.files[0]?.contents, "# extensionless wrapped source\n", command)
  }
  assert.equal(discover("command env cd sub && python main.py", dir).references[0]?.cwd, dir)
  assert.equal(discover("exec env -- CDPATH=/elsewhere bash -c 'cd sub && python main.py'", dir).references[0]?.cwd, null)
})

test("unsupported, missing and over-deep wrappers give specific limitations", () => {
  for (const command of [
    "command env -C elsewhere python main.py",
    "exec env -S 'python main.py'",
    "env --split-string='python main.py'",
    "command -v python main.py",
    "exec -a other python main.py",
    "env command python main.py",
    "env exec python main.py",
    "exec command python main.py",
    "env -u", 'env -u "$NAME" python main.py',
    "command", "exec env -- MODE=test",
    "env env env env env env env env env python main.py",
  ]) {
    const result = discover(command, "/project")
    assert.deepEqual(result.references, [], command)
    assert.match(result.limitations.join("\n"), /Unsupported .*option|Unsupported wrapper composition|env option argument|No command operand|eight-wrapper limit/, command)
  }
})

test("nested shell references retain preceding-statement snapshot qualifications", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/main.py`, "# review-time original\n")
  await writeFile(`${dir}/replacement.py`, "# proposed replacement\n")
  for (const command of [
    "cp replacement.py main.py; bash -c 'python main.py'",
    "cp replacement.py main.py && exec env bash -lc 'python main.py'",
    `cp replacement.py main.py; bash -c 'sh -c "python main.py"'`,
    "bash -c 'cp replacement.py main.py; python main.py'",
    "cp replacement.py main.py; bash -c 'true; python main.py'",
  ]) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references, [{ filename: "main.py", cwd: dir, executable: false }], command)
    assert.equal(discovered.limitations.filter((text) => text.includes("preceding command statements may change")).length, 1, command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.command, command)
    assert.equal(result.files[0]?.contents, "# review-time original\n", command)
    assert.match(result.limitations.join("\n"), /preceding command statements may change/, command)
  }
  assert.equal(await readFile(`${dir}/main.py`, "utf8"), "# review-time original\n")
  assert.deepEqual(discover("bash -c 'python main.py'", dir).limitations, [])
  assert.deepEqual(discover(`bash -c 'sh -c "python main.py"'`, dir).limitations, [])
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  let nested = "python main.py"
  for (let depth = 0; depth < 4; depth++) nested = `bash -c ${quote(nested)}`
  assert.equal(discover(nested, dir).references[0]?.filename, "main.py")
  const tooDeep = discover(`bash -c ${quote(nested)}`, dir)
  assert.deepEqual(tooDeep.references, [])
  assert.match(tooDeep.limitations.join("\n"), /deeply nested shell strings/)
})

test("unresolved constructs are explicit and never resolve from the plugin environment", () => {
  for (const command of [
    "python $SECRET_SCRIPT", 'python "${SCRIPT:-fallback.py}"', "python *.py", "python ~/main.py",
    "python $(touch sentinel)", "python `touch sentinel`", "if true; then python a.py; fi",
    "python -m application",
    "python main.py\nbash other.sh", "python3 -Q main.py",
    "python 'unterminated.py", "env -C elsewhere python x.py", "exec -a newname python x.py",
  ]) assert.ok(discover(command, "/p").limitations.length, command)
  assert.equal(discover("cd sub; python main.py", "/p").references[0]?.cwd, null)
  assert.equal(discover("cd sub || python main.py", "/p").references[0]?.cwd, null)
  assert.equal(discover('python "$HOME/main.py"', "/p").references.length, 0)
  assert.equal(discover("python '$HOME/main.py'", "/p").references[0]?.filename, "$HOME/main.py")
})

test("unsupported unquoted bracket, brace and in-word hash syntax cannot capture decoys", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const filename of ["file[12].py", "{a,b}.py", "safe", "safe#other.py", "file1.py", "a.py", "b.py"]) {
    await writeFile(`${dir}/${filename}`, `# ${filename}\n`)
  }
  for (const command of ["python file[12].py", "python {a,b}.py", "python safe#other.py", 'python "safe"#other.py']) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references, [], command)
    assert.match(discovered.limitations.join("\n"), /bracket glob or brace syntax|Unquoted # within a shell word/, command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.command, command)
    assert.deepEqual(result.files, [], command)
  }
  assert.deepEqual(discover("bash -c 'python file[12].py'", dir).references, [])
})

test("quoted and escaped bracket, brace and hash filenames remain literal", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const filename of ["file[12].py", "{a,b}.py", "safe#other.py"]) {
    await writeFile(`${dir}/${filename}`, `# literal ${filename}\n`)
    for (const operand of [`'${filename}'`, `"${filename}"`, filename.replace(/[\[\]{}#]/g, "\\$&")]) {
      const command = `python ${operand}`
      const discovered = discover(command, dir)
      assert.deepEqual(discovered.limitations, [], command)
      assert.deepEqual(discovered.references.map((r) => r.filename), [filename], command)
      const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
      assert.equal(result.command, command)
      assert.equal(result.files[0]?.status, "captured", command)
      assert.equal(result.files[0]?.contents, `# literal ${filename}\n`, command)
    }
  }
  assert.equal(discover('python safe"#"other.py', dir).references[0]?.filename, "safe#other.py")
  const commented = discover("python safe.py # file[12].py {a,b}.py safe#other.py", dir)
  assert.deepEqual(commented.references.map((r) => r.filename), ["safe.py"])
  assert.deepEqual(commented.limitations, [])
})

test("unsupported unquoted whitespace cannot split an operand or executable and capture a source decoy", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/safe.py`, "# wrongly selected source decoy\n")
  for (const whitespace of ["\u000b", "\u000c", "\u00a0", "\u1680", "\u2003", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]) {
    await writeFile(`${dir}/safe.py${whitespace}other.py`, "# actual literal operand\n")
    for (const command of [
      `python safe.py${whitespace}other.py`,
      `python${whitespace}safe.py`,
      `python safe.py\\${whitespace}other.py`,
      `bash -c 'python safe.py${whitespace}other.py'`,
    ]) {
      const discovered = discover(command, dir)
      assert.deepEqual(discovered.references, [], JSON.stringify(command))
      assert.match(discovered.limitations.join("\n"), /Unsupported unquoted shell whitespace/, JSON.stringify(command))
      const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
      assert.equal(result.command, command)
      assert.deepEqual(result.files, [], JSON.stringify(command))
    }
  }
  assert.equal(discover("python \t safe.py", dir).references[0]?.filename, "safe.py")
  assert.deepEqual(discover("python safe.py # ignored\u00a0comment", dir).limitations, [])
})

test("quoted Unicode whitespace paths are preserved literally, including nested shell strings", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const whitespace of ["\u00a0", "\u1680", "\u2003", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]) {
    const filename = `task${whitespace}file.py`
    const contents = `# literal ${filename}\n`
    await writeFile(`${dir}/${filename}`, contents)
    for (const command of [
      `python '${filename}'`, `python "${filename}"`, `python task"${whitespace}"file.py`,
      `bash -c 'python "${filename}"'`,
    ]) {
      const discovered = discover(command, dir)
      assert.deepEqual(discovered.references, [{ filename, cwd: dir, executable: false }], JSON.stringify(command))
      assert.deepEqual(discovered.limitations, [], JSON.stringify(command))
      const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
      assert.equal(result.command, command)
      assert.equal(result.files[0]?.contents, contents, JSON.stringify(command))
    }
  }
})

test("program identity recognizes only bare names and exact conventional executable paths", () => {
  for (const command of [
    "/bin/python task.py", "/usr/bin/python3.12 -I -- task.py", "/bin/bash +x task.py",
    "/usr/bin/sh -- task.py", "/bin/cat -- task.py", "/usr/bin/head -10 task.py",
    "/bin/env -i python task.py", "/usr/bin/env -- MODE=test /usr/bin/python3 task.py",
    "command -- /usr/bin/head -n 1 task.py", "exec -- /bin/env /bin/bash task.py",
    "/bin/bash -lc 'python task.py'",
  ]) {
    assert.deepEqual(discover(command, "/project").references, [{ filename: "task.py", cwd: "/project", executable: false }], command)
  }
  for (const executable of [
    "./python", "../bin/python3", "/custom/bin/python3.12", "./bash", "/usr/local/bin/sh",
    "./head", "/custom/cat", "/usr/bin/../bin/python", "/usr/bin//python", "/bin/./head", "//usr/bin/env",
  ]) {
    assert.deepEqual(discover(`${executable} task.py`, "/project").references, [{ filename: executable, cwd: "/project", executable: true }], executable)
  }
})

test("explicit named executables retain their own source before uncertain argument files", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/decoy.py`, "# must not be selected as invoked source\n")
  await writeFile(`${dir}/later.py`, "# later source in the unchanged parent cwd\n")
  for (const name of ["python", "python3.12", "bash", "sh", "cat", "head", "env", "builtin", "command", "exec", "cd", "source", "eval", "if"]) {
    const contents = `#!/bin/sh\n# executable named ${name}\n`
    await writeFile(`${dir}/${name}`, contents)
    for (const executable of [`./${name}`, `${dir}/${name}`]) {
      for (const prefix of ["", "command -- ", "env -- ", "builtin command -- "]) {
        const command = `${prefix}${executable} decoy.py; python later.py`
        assert.deepEqual(discover(command, dir).references, [
          { filename: executable, cwd: dir, executable: true },
          { filename: "later.py", cwd: dir, executable: false },
        ], command)
        const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
        assert.deepEqual(result.files.map((file) => file.contents), [contents, "# later source in the unchanged parent cwd\n",
          "# must not be selected as invoked source\n"], command)
        assert.equal(result.files[2]?.basis, "literal argument; input role unknown")
      }
    }
  }
  assert.deepEqual(discover("./bash -c 'python decoy.py'", dir).references, [{ filename: "./bash", cwd: dir, executable: true }])
  assert.deepEqual(discover("./env python decoy.py", dir).references, [{ filename: "./env", cwd: dir, executable: true }])
})

test("builtin wrapper compositions preserve cd inference and explicit sourcing semantics", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(`${dir}/sub`)
  await writeFile(`${dir}/main.py`, "# parent cwd decoy\n")
  await writeFile(`${dir}/sub/main.py`, "# correct builtin-cd source\n")
  await writeFile(`${dir}/helpers.sh`, "# explicit builtin source\n")
  for (const prefix of ["builtin", "builtin --", "command -- builtin --", "builtin command --", "builtin builtin --"]) {
    const command = `${prefix} cd sub && python main.py`
    assert.deepEqual(discover(command, dir).references, [{ filename: "main.py", cwd: `${dir}/sub`, executable: false }], command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.files[0]?.contents, "# correct builtin-cd source\n", command)
  }
  for (const command of ["builtin source -- ./helpers.sh && python main.py", "command builtin . ./helpers.sh && python main.py"]) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references.map((reference) => [reference.filename, reference.cwd]), [["./helpers.sh", dir], ["main.py", null]], command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.files[0]?.contents, "# explicit builtin source\n", command)
    assert.equal(result.files[1]?.contents, undefined, command)
  }
  for (const command of [
    "true | builtin cd sub && python main.py", "builtin cd sub | python main.py",
    "builtin cd - && python main.py", "builtin cd -P sub && python main.py",
    "builtin export CDPATH=/elsewhere; builtin cd sub && python main.py",
  ]) assert.equal(discover(command, dir).references[0]?.cwd, null, command)
})

test("builtin-only and external wrapper dispatch never fabricate interpreter or nested-shell source", () => {
  for (const command of [
    "builtin python decoy.py", "command builtin /bin/bash -c 'python decoy.py'",
    "builtin head decoy.py", "builtin env python decoy.py", "env builtin cd sub",
    "exec builtin python decoy.py", "builtin exec command python decoy.py",
  ]) {
    const result = discover(command, "/project")
    assert.deepEqual(result.references, [], command)
    assert.match(result.limitations.join("\n"), /Unsupported builtin operand|Unsupported wrapper composition/, command)
  }
  for (const command of [
    "builtin command python task.py", "builtin exec env python task.py",
    "builtin command -- exec -- /usr/bin/env python task.py",
    "command builtin command env python task.py",
  ]) {
    const result = discover(command, "/project")
    assert.deepEqual(result.references, [{ filename: "task.py", cwd: "/project", executable: false }], command)
    assert.deepEqual(result.limitations, [], command)
  }
  assert.equal(discover("builtin true; python task.py", "/project").references[0]?.cwd, "/project")
  const tooDeep = discover("builtin builtin builtin builtin builtin builtin builtin builtin builtin cd sub && python task.py", "/project")
  assert.equal(tooDeep.references[0]?.cwd, null)
  assert.match(tooDeep.limitations.join("\n"), /eight-wrapper limit/)
})

test("unmodeled in-process shell state and builtin eval invalidate cwd without selecting source decoys", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/main.py`, "# stale cwd decoy\n")
  for (const statement of [
    "eval 'cd elsewhere'", "builtin eval 'cd elsewhere'", "command -- builtin -- eval 'cd elsewhere'",
    "builtin command eval 'cd elsewhere'", "builtin read CDPATH", "set -o posix", "shopt -s cdable_vars",
    "alias cd=pushd", "enable -n cd", "builtin -x cd elsewhere", "command -p cd elsewhere", "$ACTION elsewhere",
    "declare -n location=CDPATH", "builtin declare -a CDPATH", 'export "$DECLARATION"',
  ]) {
    const command = `${statement}; python main.py`
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references, [{ filename: "main.py", cwd: null, executable: false }], command)
    assert.match(discovered.limitations.join("\n"), /working directory is unresolved/, command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.command, command)
    assert.equal(result.files[0]?.contents, undefined, command)
    assert.match(result.files[0]?.status ?? "", /working directory unresolved/, command)
  }
  for (const statement of ["env eval 'cd elsewhere'", "exec eval 'cd elsewhere'", "command -v cd", "command -V cd"]) {
    assert.equal(discover(`${statement}; python main.py`, dir).references[0]?.cwd, dir, statement)
  }
  const absolute = discover(`builtin eval 'cd elsewhere'; python ${dir}/main.py`, dir)
  assert.deepEqual(absolute.references, [{ filename: `${dir}/main.py`, cwd: null, executable: false }])
  const nested = discover("bash -c 'builtin cd sub && python inner.py'; python main.py", dir)
  assert.deepEqual(nested.references.map((reference) => reference.cwd), [`${dir}/sub`, dir])
})

test("cwd inference stays within successful cd chains and becomes uncertain at branch joins", () => {
  for (const command of [
    "cd sub && python a.py; python b.py",
    "false && cd sub && python a.py; python b.py",
    "cd sub && python a.py || python b.py",
  ]) {
    const result = discover(command, "/project")
    assert.deepEqual(result.references.map((r) => [r.filename, r.cwd]), [["a.py", "/project/sub"], ["b.py", null]], command)
    assert.match(result.limitations.join("\n"), /directory.*uncertain|working directory is unresolved/, command)
  }
  const supported = discover("cd sub && python a.py && bash b.sh", "/project")
  assert.deepEqual(supported.references.map((r) => r.cwd), ["/project/sub", "/project/sub"])
  assert.match(supported.limitations.join("\n"), /preceding command statements may change/)
  assert.equal(discover("true; python main.py", "/project").references[0]?.cwd, "/project")
})

test("pipeline cd, directory stacks, cd - and explicit CDPATH cannot select cwd decoys", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const sub of [".", "sub", "-"]) {
    await mkdir(`${dir}/${sub}`, { recursive: true })
    await writeFile(`${dir}/${sub}/main.py`, `# cwd decoy ${sub}\n`)
  }
  for (const command of [
    "true | cd sub && python main.py",
    "cd sub | python main.py",
    "cd sub && true | cd sub && python main.py",
    "cd - && python main.py",
    "cd -- - && python main.py",
    "CDPATH=/elsewhere cd sub && python main.py",
    "CDPATH=/elsewhere; cd sub && python main.py",
    "export CDPATH=/elsewhere; cd sub && python main.py",
    "env CDPATH=/elsewhere bash -c 'cd sub && python main.py'",
    "pushd sub && python main.py",
    "popd && python main.py",
    "false && cd sub; python main.py",
  ]) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references.map((r) => [r.filename, r.cwd]), [["main.py", null]], command)
    assert.match(discovered.limitations.join("\n"), /unresolved|reliable cwd/, command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.command, command)
    assert.match(result.files[0]!.status, /working directory unresolved/, command)
    assert.equal(result.files[0]?.contents, undefined, command)
  }
  await writeFile(`${dir}/sub/a.py`, "# conditional target\n")
  await writeFile(`${dir}/sub/b.py`, "# skipped-cd decoy\n")
  await writeFile(`${dir}/b.py`, "# alternate branch target\n")
  const result = await collectEvidence({ command: "false && cd sub && python a.py; python b.py", cwd: dir, userPrompt: null }, limits, signal())
  assert.equal(result.files[0]?.contents, "# conditional target\n")
  assert.match(result.files[1]!.status, /working directory unresolved/)
  assert.equal(result.files[1]?.contents, undefined)
})

test("only builtin directory changes affect cwd; supported literal cd operands still work", () => {
  for (const command of ["./cd sub && python main.py", "/bin/cd sub && python main.py", "env cd sub && python main.py"]) {
    const result = discover(command, "/project")
    assert.equal(result.references.find((r) => r.filename === "main.py")?.cwd, "/project", command)
  }
  assert.deepEqual(discover("./cd sub", "/project").references, [{ filename: "./cd", cwd: "/project", executable: true }])
  for (const command of [
    "cd sub && python main.py",
    "command -- cd sub && python main.py",
    "cd -- ./sub && python main.py",
    "CDPATH=/elsewhere cd ./sub && python main.py",
    "CDPATH=/elsewhere cd /project/sub && python main.py",
  ]) assert.equal(discover(command, "/project").references[0]?.cwd, "/project/sub", command)
  assert.equal(discover("cd ./- && python main.py", "/project").references[0]?.cwd, "/project/-")
})

test("bare sourcing is PATH-dependent while explicit paths and -- retain the real operand", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(`${dir}/elsewhere`)
  await writeFile(`${dir}/helpers.sh`, "# explicit local source or bare-name decoy\n")
  await writeFile(`${dir}/elsewhere/helpers.sh`, "# PATH-selected source\n")
  await writeFile(`${dir}/--`, "# option decoy\n")
  for (const command of [
    "source helpers.sh", ". helpers.sh", "source -- helpers.sh", ". -- helpers.sh",
    `PATH=${dir}/elsewhere source helpers.sh`,
    `PATH=${dir}/elsewhere . helpers.sh`,
  ]) {
    const discovered = discover(command, dir)
    assert.deepEqual(discovered.references, [], command)
    assert.match(discovered.limitations.join("\n"), /PATH lookup/, command)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.deepEqual(result.files, [], command)
  }
  for (const command of ["source ./helpers.sh", ". ./helpers.sh", "source -- ./helpers.sh", ". -- ./helpers.sh", `source ${dir}/helpers.sh`]) {
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(result.files.length, 1, command)
    assert.equal(result.files[0]?.status, "captured", command)
    assert.equal(result.files[0]?.contents, "# explicit local source or bare-name decoy\n", command)
  }
  const sourced = discover("source ./helpers.sh && python main.py", dir)
  assert.equal(sourced.references[1]?.cwd, null)
  assert.match(sourced.limitations.join("\n"), /Sourced code may change/)
  const external = discover("./source helpers.sh && python main.py", dir)
  assert.deepEqual(external.references.map((r) => [r.filename, r.cwd]), [["./source", dir], ["main.py", dir]])
})

test("captures real source snapshots including external files and symlinks", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "project"))
  await writeFile(path.join(dir, "external.py"), "print('pear')\n")
  await symlink(path.join(dir, "external.py"), path.join(dir, "project/link.py"))
  const result = await collectEvidence({ command: "python link.py; python ../external.py", cwd: path.join(dir, "project"), userPrompt: "Count fruit" }, limits, signal())
  assert.equal(result.files.length, 1)
  assert.ok(result.files.every((f) => f.contents === "print('pear')\n"))
  assert.equal(result.userPrompt, "Count fruit")
})

test("source operands traverse symlinks before parent components, including symlinked launch directories", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  const outside = path.join(dir, "outside")
  await mkdir(project)
  await mkdir(path.join(outside, "deep"), { recursive: true })
  await symlink(path.join(outside, "deep"), `${project}/link`)
  await writeFile(`${outside}/job.py`, "# actual filesystem target\n")
  await writeFile(`${project}/job.py`, "# lexical operand decoy\n")
  await writeFile(`${dir}/job.py`, "# lexical launch-directory decoy\n")
  for (const [cwd, operand] of [
    [project, "link/../job.py"],
    [project, `${project}/link/../job.py`],
    [`${project}/link`, "../job.py"],
  ]) {
    const original = path.isAbsolute(operand!) ? operand! : `${cwd}/${operand}`
    const expected = await readFile(original, "utf8")
    const result = await collectEvidence({ command: `python ${operand}`, cwd: cwd!, userPrompt: null }, limits, signal())
    assert.equal(result.files[0]?.status, "captured")
    assert.equal(result.files[0]?.contents, expected)
    assert.equal(result.files[0]?.contents, "# actual filesystem target\n")
    assert.equal(result.files[0]?.path, original)
  }
})

test("missing, oversized, binary, invalid UTF-8 and special files have factual placeholders", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "big.py"), "x".repeat(200))
  await writeFile(path.join(dir, "binary.py"), Buffer.from([0, 1, 2]))
  await writeFile(path.join(dir, "invalid.py"), Buffer.from([255, 254]))
  for (const [filename, expected] of [
    ["missing.py", /ENOENT/], ["big.py", /too large/], ["binary.py", /binary/], ["invalid.py", /UTF-8/], [".", /regular file/],
  ] as const) {
    const result = await collectEvidence({ command: `python ${filename}`, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: 100 }, signal())
    assert.match(result.files[0]!.status, expected)
    assert.equal(result.files[0]!.contents, undefined)
    assert.ok(result.limitations.includes("User prompt unavailable."))
  }
})

test("oversized files reach evidence as relevant UTF-8 excerpts with exact omitted lines", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-excerpts-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = ["#!/usr/bin/env python3", ...Array(5000).fill("# context 🍐"),
    "def entry():", "    print('café')", ...Array(5000).fill("# context"), "entry()"]
  const command = "python large.py"
  for (const newline of ["\n", "\r\n"]) for (const trailing of ["", newline]) {
    await writeFile(`${dir}/large.py`, source.join(newline) + trailing)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: "Run entry" }, { ...limits, maxEvidenceBytes: 600 }, signal())
    const file = result.files[0]!
    assert.equal(file.status, "excerpt")
    assert.equal(file.excerpt?.totalLines, source.length)
    assert.match(file.contents!, /L5002: def entry\(\):/)
    assert.match(file.contents!, /L5003:     print\('café'\)/)
    assert.match(file.contents!, /entry\(\)/)
    const included = file.contents!.split("\n").slice(0, -1)
    assert.equal(file.contents!.split("\n").at(-1), `missing ${source.length - included.length} more lines`)
    assert.equal(file.warning, undefined)
    assert.ok(Buffer.byteLength(command) + Buffer.byteLength(file.contents!) <= 600)
    assert.ok(!file.contents!.includes("�"))
  }
})

test("oversized source still validates UTF-8 and binary bytes outside selected excerpts", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-excerpts-invalid-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [byte, expected] of [[0xff, /UTF-8/], [0, /binary/]] as const) {
    await writeFile(`${dir}/large.py`, Buffer.concat([Buffer.from("# header\n".repeat(10000)), Buffer.from([byte])]))
    const result = await collectEvidence({ command: "python large.py", cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: 400 }, signal())
    assert.match(result.files[0]!.status, expected)
    assert.equal(result.files[0]!.contents, undefined)
  }
})

test("excerpt capture preserves streaming Unicode boundaries, rejects races, and closes on abort", async t => {
  const { FileAccess } = await import("../src/file-access.js")
  const dir = await mkdtemp(path.join(tmpdir(), "checker-excerpt-race-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filename = `${dir}/large.py`, source = "#".repeat(65535) + "🍐\ndef entry():\n    return 'café'\n"
  await writeFile(filename, source)
  const clean = await collectEvidence({ command: "python large.py", cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: 300 }, signal())
  assert.equal(clean.files[0]?.excerpt?.totalLines, 3)
  assert.match(clean.files[0]!.contents!, /L2: def entry\(\):\nL3:     return 'café'/)
  for (const scenario of ["rewrite", "abort"] as const) {
    await writeFile(filename, source)
    await utimes(filename, new Date(0), new Date(0))
    const controller = new AbortController()
    let handle: FileHandle | undefined, first = true
    const files = new FileAccess({ realpath: async name => name, open: async (...args) => {
      handle = await open(...args)
      const read = handle.read.bind(handle)
      handle.read = (async (...args: Parameters<typeof read>) => {
        const result = await read(...args)
        if (first) {
          first = false
          if (scenario === "abort") controller.abort()
          else await appendFile(filename, "# changed\n")
        }
        return result
      }) as typeof handle.read
      return handle
    } })
    const pending = collectEvidence({ command: "python large.py", cwd: dir, userPrompt: null },
      { ...limits, maxEvidenceBytes: 300 }, controller.signal, files.scope(controller.signal))
    if (scenario === "abort") await assert.rejects(pending, { name: "AbortError" })
    else {
      const result = await pending
      assert.equal(result.files[0]?.contents, undefined)
      assert.match(result.files[0]!.status, /changed while being read/)
    }
    // Caller abort can win the race with physical cleanup; the owned slot and
    // descriptor must settle before another transaction is admitted.
    for (let turn = 0; files.outstanding && turn < 100; turn++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(files.outstanding, 0)
    assert.equal(handle?.fd, -1)
  }
})

test("total UTF-8 budget, file-count limit, deduplication and command-size failure", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "a.py"), "é".repeat(15))
  await writeFile(path.join(dir, "b.py"), "x".repeat(30))
  const input = { command: "python a.py; python b.py; python a.py", cwd: dir, userPrompt: "Read" }
  const result = await collectEvidence(input, { maxFiles: 1, maxEvidenceBytes: 70 }, signal())
  assert.equal(result.files.length, 2)
  assert.equal(Buffer.byteLength(result.files[0]!.contents!), 30)
  assert.match(result.files[1]!.status, /file-count/)
  const second = await collectEvidence(input, { maxFiles: 4, maxEvidenceBytes: 70 }, signal())
  assert.match(second.files[1]!.status, /too large/)
  await assert.rejects(collectEvidence(input, { ...limits, maxEvidenceBytes: 3 }, signal()), /Command exceeds/)
})

test("direct extensionless Python/shell shebangs and extensionless interpreter operands", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "run"), "#!/usr/bin/env python3\nprint('apple')")
  await writeFile(path.join(dir, "other"), "print('apple')")
  const result = await collectEvidence({ command: "./run; python other", cwd: dir, userPrompt: null }, limits, signal())
  assert.ok(result.files.every((f) => f.contents?.includes("apple")))
  await writeFile(path.join(dir, "task.sh"), "#!/bin/sh\nprintf pear\n")
  const shell = await collectEvidence({ command: "bash task.sh; ./task.sh", cwd: dir, userPrompt: null }, limits, signal())
  assert.ok(shell.files.every((f) => f.contents === "#!/bin/sh\nprintf pear\n"))
})

test("direct script paths recognize supported runtimes without capturing unrelated executables", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-direct-runtimes-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, contents] of [
    ["task.ts", "console.log('literal source')\n"],
    ["run", "#!/usr/bin/env -S node --no-warnings\nconsole.log('source')\n"],
    ["worker", "#!/usr/bin/ruby\nputs 'source'\n"],
    ["binary", "#!/usr/bin/env arbitrary-tool\n# not a supported script\n"],
    ["fake", "#!/bin/echo node\n# not a node shebang\n"],
  ] as const) await writeFile(`${dir}/${name}`, contents)
  const result = await collectEvidence({ command: "./task.ts; ./run; ./worker; ./binary; ./fake", cwd: dir, userPrompt: null },
    { ...limits, maxFiles: 5 }, signal())
  assert.deepEqual(result.files.map(file => file.status), ["captured", "captured", "captured",
    "direct executable is not identifiable as supported script source; contents not provided",
    "direct executable is not identifiable as supported script source; contents not provided"])
  assert.equal(result.files[0]?.contents, "console.log('literal source')\n")
})

test("BOM source stays byte-faithful and does not create a byte-zero extensionless shebang", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [interpreter, shebang, extension] of [["python", "#!/usr/bin/env python3", "py"], ["bash", "#!/bin/sh", "sh"]]) {
    const source = `\uFEFF${shebang}\n# café\n`
    await writeFile(`${dir}/run`, source)
    await writeFile(`${dir}/run.${extension}`, source)
    for (const command of [`${interpreter} run`, `${interpreter} run.${extension}`, `./run.${extension}`]) {
      const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, limits, signal())
      assert.equal(result.files[0]?.status, "captured", command)
      assert.equal(result.files[0]?.contents, source, command)
      assert.deepEqual(Buffer.from(result.files[0]!.contents!), await readFile(`${dir}/run`), command)
    }
    const direct = await collectEvidence({ command: "./run", cwd: dir, userPrompt: null }, limits, signal())
    assert.match(direct.files[0]!.status, /not identifiable as supported script source/)
    assert.equal(direct.files[0]?.contents, undefined)
    await writeFile(`${dir}/run`, source.slice(1))
    const withoutBom = await collectEvidence({ command: "./run", cwd: dir, userPrompt: null }, limits, signal())
    assert.equal(withoutBom.files[0]?.status, "captured")
    assert.equal(withoutBom.files[0]?.contents, source.slice(1))
  }
})

test("BOM bytes count toward exact, insufficient and aggregate evidence budgets", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = "\uFEFF# café\n"
  const bytes = Buffer.byteLength(source)
  await writeFile(`${dir}/bom`, source)
  await writeFile(`${dir}/second`, "#\n")
  const command = "python bom; python second"
  const commandBytes = Buffer.byteLength(command)
  const exact = await collectEvidence({ command, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: commandBytes + bytes + 2 }, signal())
  assert.deepEqual(exact.files.map((f) => f.contents), [source, "#\n"])
  assert.equal(Buffer.byteLength(exact.command) + exact.files.reduce((sum, f) => sum + Buffer.byteLength(f.contents!), 0), commandBytes + bytes + 2)
  const aggregate = await collectEvidence({ command, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: commandBytes + bytes }, signal())
  assert.equal(aggregate.files[0]?.contents, source)
  assert.match(aggregate.files[1]!.status, /too large/)
  assert.equal(aggregate.files[1]?.contents, undefined)
  const singleCommand = "python bom"
  const insufficient = await collectEvidence({ command: singleCommand, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: Buffer.byteLength(singleCommand) + bytes - 1 }, signal())
  assert.match(insufficient.files[0]!.status, /too large/)
  assert.equal(insufficient.files[0]?.contents, undefined)
  await writeFile(`${dir}/bom`, "\uFEFF")
  const onlyBom = await collectEvidence({ command: singleCommand, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: Buffer.byteLength(singleCommand) + 3 }, signal())
  assert.equal(onlyBom.files[0]?.contents, "\uFEFF")
  await writeFile(`${dir}/bom`, Buffer.from([0xef, 0xbb]))
  const invalid = await collectEvidence({ command: singleCommand, cwd: dir, userPrompt: null }, limits, signal())
  assert.match(invalid.files[0]!.status, /not valid UTF-8/)
  assert.equal(invalid.files[0]?.contents, undefined)
})

test("capture handles empty, exact-budget and invalid source at byte boundaries", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const command = "python task"
  for (const [contents, budget, status] of [
    ["", 0, "captured"],
    ["é", 2, "captured"],
    ["é", 1, "file too large for remaining evidence budget; contents not provided; assess risk accordingly"],
    [Buffer.from([0xc3]), 1, "not valid UTF-8 source; contents not provided"],
    [Buffer.from([0]), 1, "binary content; contents not provided"],
  ] as const) {
    await writeFile(`${dir}/task`, contents)
    const result = await collectEvidence({ command, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: Buffer.byteLength(command) + budget }, signal())
    assert.equal(result.files[0]?.status, status)
    assert.equal(result.files[0]?.contents, status === "captured" ? contents : undefined)
  }
})

test("capture preserves short reads, deterministic growth/race notices, aborts and handle cleanup", async (t) => {
  for (const scenario of ["short reads", "growth within budget", "growth beyond budget", "growth after EOF", "shrink", "same-size rewrite", "abort", "read error"]) {
    await t.test(scenario, async (t) => {
      const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
      t.after(() => rm(dir, { recursive: true, force: true }))
      const filename = `${dir}/task`
      const contents = scenario === "short reads" ? "\uFEFF# café🍐\n" : "# first\n"
      await writeFile(filename, contents)
      // Make the same-size rewrite's mtime change deterministic even on coarse filesystems.
      await utimes(filename, new Date(0), new Date(0))
      const probe = await open(filename, "r")
      const prototype = Object.getPrototypeOf(probe)
      const read: (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }> = probe.read
      await probe.close()
      const controller = new AbortController()
      let capturedHandle: FileHandle | undefined
      const reads: { position: number; length: number; capacity: number }[] = []
      t.mock.method(prototype, "read", async function(this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
        capturedHandle = this
        reads.push({ position, length, capacity: buffer.length })
        if (reads.length === 1) {
          if (scenario === "growth within budget") await appendFile(filename, "#".repeat(10000))
          if (scenario === "growth beyond budget") await appendFile(filename, "#".repeat(64))
          if (scenario === "shrink") await writeFile(filename, "#\n")
        }
        if (scenario === "read error" && reads.length === 2) throw Object.assign(new Error("synthetic read failure"), { code: "EIO" })
        const partial = ["short reads", "abort", "read error"].includes(scenario)
        const result = await read.call(this, buffer, offset, partial ? Math.min(length, 1) : length, position)
        if (reads.length === 1 && scenario === "same-size rewrite") await writeFile(filename, "# other\n")
        if (!result.bytesRead && scenario === "growth after EOF") await appendFile(filename, "# appended after EOF\n")
        if (scenario === "abort") controller.abort()
        return result
      })
      const command = "python task"
      const budget = scenario === "growth beyond budget" ? 32 : 32768
      const pending = collectEvidence({ command, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: Buffer.byteLength(command) + budget }, controller.signal)
      if (scenario === "abort") await assert.rejects(pending, { name: "AbortError" })
      else {
        const result = await pending
        if (scenario === "short reads") {
          assert.equal(result.files[0]?.status, "captured")
          assert.equal(result.files[0]?.contents, contents)
          assert.equal(reads.length, Buffer.byteLength(contents) + 1)
        } else {
          const status = scenario === "growth beyond budget" ? "file grew beyond evidence budget; contents not provided"
            : scenario === "read error" ? "cannot read file (EIO); contents not provided"
            : "file changed while being read; contents not provided"
          assert.equal(result.files[0]?.status, status)
          assert.equal(result.files[0]?.contents, undefined)
        }
      }
      assert.equal(capturedHandle?.fd, -1, "capture closes its descriptor on every exit")
      assert.ok(reads.every((r) => r.capacity <= budget + 1 && r.position + r.length <= budget + 1))
      if (scenario === "growth within budget") assert.ok(reads.at(-1)!.position > Buffer.byteLength(contents), "reads continue past the initial stat-sized buffer")
    })
  }
})

test("underreported file sizes read to EOF with linear allocation and copying", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const contents = `\uFEFF# ${"é".repeat(3000)}\n`
  await writeFile(`${dir}/task`, contents)
  const probe = await open(`${dir}/task`, "r")
  const prototype = Object.getPrototypeOf(probe)
  const stat = probe.stat
  await probe.close()
  // Some regular virtual files report zero size while still yielding content.
  t.mock.method(prototype, "stat", async function(this: FileHandle) {
    const result = await stat.call(this)
    Object.defineProperty(result, "size", { value: 0 })
    return result
  })
  const alloc = Buffer.alloc
  const copy = Buffer.prototype.copy
  let allocatedBytes = 0
  let copiedBytes = 0
  let largestAllocation = 0
  Buffer.alloc = (size, fill?, encoding?) => {
    allocatedBytes += size
    largestAllocation = Math.max(largestAllocation, size)
    return alloc(size, fill, encoding)
  }
  Buffer.prototype.copy = function(this: Buffer, ...args: Parameters<Buffer["copy"]>) {
    const bytes = copy.apply(this, args)
    copiedBytes += bytes
    return bytes
  }
  const command = "python task"
  const budget = 16384
  let result
  try { result = await collectEvidence({ command, cwd: dir, userPrompt: null }, { ...limits, maxEvidenceBytes: Buffer.byteLength(command) + budget }, signal()) }
  finally { Buffer.alloc = alloc; Buffer.prototype.copy = copy }
  assert.equal(result.files[0]?.status, "captured")
  assert.equal(result.files[0]?.contents, contents)
  const bytes = Buffer.byteLength(contents)
  assert.ok(largestAllocation <= budget + 1)
  assert.ok(allocatedBytes <= 4 * (bytes + 1), "allocation stays linear in bytes read")
  assert.ok(copiedBytes <= 2 * (bytes + 1), "growth must not repeatedly copy the entire accumulated prefix on short reads")
})

test("tiny-file allocation at maximum evidence limits", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filenames = Array.from({ length: 1000 }, (_, index) => `f${String(index).padStart(4, "0")}.py`)
  const source = "# tiny\n"
  for (const filename of filenames) await writeFile(`${dir}/${filename}`, source)
  const command = filenames.map((filename) => `python ${filename}`).join("; ")
  const maximum = { maxFiles: 1000, maxEvidenceBytes: 16 * 1024 * 1024 }
  const alloc = Buffer.alloc
  let allocations = 0
  let allocatedBytes = 0
  let largestAllocation = 0
  // Count requests without a mock call log retaining every allocated buffer.
  Buffer.alloc = (size, fill?, encoding?) => {
    allocations++
    allocatedBytes += size
    largestAllocation = Math.max(largestAllocation, size)
    return alloc(size, fill, encoding)
  }
  let result
  try { result = await collectEvidence({ command, cwd: dir, userPrompt: null }, maximum, signal()) }
  finally { Buffer.alloc = alloc }
  assert.equal(result.files.length, 1000)
  assert.ok(result.files.every((file) => file.status === "captured" && file.contents === source))
  t.diagnostic(JSON.stringify({ files: result.files.length, sourceBytes: Buffer.byteLength(source), commandBytes: Buffer.byteLength(command), ...maximum, allocations, allocatedBytes, largestAllocation }))
  assert.ok(allocatedBytes <= 65536, "tiny sources must not allocate the remaining 16 MiB allowance per file")
})

test("wrapped nested capture remains abortable after discovery starts", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(`${dir}/task`, "\uFEFF# source snapshot\n")
  const controller = new AbortController()
  const pending = collectEvidence({ command: "command env bash -c 'python task'", cwd: dir, userPrompt: null }, limits, controller.signal)
  // collectEvidence has reached its first filesystem await, without executing the fixture.
  controller.abort()
  await assert.rejects(pending, { name: "AbortError" })
})

test("does not execute discovery payloads and respects pre-aborted work", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "checker-evidence-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const marker = path.join(dir, "executed")
  await collectEvidence({ command: `python $(touch ${marker})`, cwd: dir, userPrompt: null }, limits, signal())
  await assert.rejects(access(marker))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(collectEvidence({ command: "python x.py", cwd: dir, userPrompt: null }, limits, controller.signal), { name: "AbortError" })
})

test("cursor discovery retains operands after long assignment prefixes and option lists", () => {
  const assignments = Array.from({ length: 8000 }, (_, index) => `A${index}=value`).join(" ")
  for (const command of [
    `${assignments} command env -- MODE=test python -I -- task.py`,
    `env -- ${assignments} /usr/bin/head ${"-q ".repeat(8000)}-- task.py`,
  ]) {
    const result = discover(command, "/project")
    assert.deepEqual(result.references, [{ filename: "task.py", cwd: "/project", executable: false }])
    assert.deepEqual(result.limitations, [])
  }
})

test("discovery limits tokenizer input and shares token/reference work across nested shell strings", async () => {
  const tooMany = discover(`cat ${"operand ".repeat(65536)}`, "/project")
  assert.deepEqual(tooMany.references, [])
  assert.match(tooMany.limitations.join(" "), /shared .*work limits/)
  const many = Array.from({ length: 10000 }, (_, index) => `f${index}`).join(" ")
  const nested = discover(`cat ${many}; bash -c 'cat ${many}'; cat final`, "/project")
  assert.equal(nested.references.length, 16384, "nested strings must not each get a fresh reference budget")
  assert.match(nested.limitations.join(" "), /remaining source targets were not resolved/)
  const large = "x".repeat(16 * 1024 * 1024 + 1)
  assert.deepEqual(discover(large, "/project").references, [])
  const command = `cat ${"operand ".repeat(65536)}`
  const result = await collectEvidence({ command, cwd: "/project", userPrompt: "Inspect" }, { maxFiles: 1, maxEvidenceBytes: 16 * 1024 * 1024 }, signal())
  assert.equal(result.command, command)
  assert.deepEqual(result.files, [])
  assert.match(result.limitations.join(" "), /work limits/)
})

test("synchronous discovery propagates cancellation and checks monotonic overall expiry", async () => {
  const reason = new Error("permission resolved")
  assert.throws(() => discover("python task.py", "/project", 0, AbortSignal.abort(reason)), error => error === reason)
  await assert.rejects(withDeadline(signal(), 10, async s => {
    const until = performance.now() + 20
    while (performance.now() < until) { /* Delay timer delivery before synchronous discovery. */ }
    return discover("python task.py", "/project", 0, s)
  }), /timed out/)
})

test("discovery bounds UTF-8 input, expansion growth, unique notices and its own synchronous time", (t) => {
  const unicode = "é".repeat(8 * 1024 * 1024 + 1)
  assert.match(discover(unicode, "/project").limitations.join(" "), /work limits/)
  const expansions = `python "${"$SCRIPT/".repeat(16385)}task.py"`
  assert.match(discover(expansions, "/project").limitations.join(" "), /16,384-expansion/)
  const notices = discover(Array.from({ length: 300 }, (_, index) => `python "$SCRIPT/file${index}.py"`).join("; "), "/project")
  assert.equal(notices.references.length, 0)
  assert.equal(notices.limitations.length, 257, "256 unique notices plus one fixed exhaustion notice")
  let clock = 0
  t.mock.method(performance, "now", () => { clock += 600; return clock })
  const timed = discover("python task.py", "/project")
  assert.deepEqual(timed.references, [])
  assert.match(timed.limitations.join(" "), /500 ms work limits/)
})
