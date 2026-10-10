// Adversarial evidence identity through the pinned native host and built plugin.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, copyFile, symlink, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { pathToFileURL } from "node:url"
import { runtimeArguments } from "./runtime-inventory.mjs"

const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
const { scenario } = runtimeArguments("smoke-evidence.mjs")
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8" }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-evidence-"))
const project = `${temp}/project`, outside = `${temp}/outside`, skills = `${temp}/skills`, skill = `${skills}/evidence-fixture`
const artifacts = path.join(root, ".runtime", scenario === "capture" ? "evidence-identity" : "evidence-prompt-symlink")
await mkdir(project); await mkdir(`${outside}/deep`, { recursive: true }); await mkdir(`${temp}/config`)
await mkdir(`${skill}/nested/deep`, { recursive: true }); await mkdir(`${skill}/scripts`); await mkdir(artifacts, { recursive: true })
execFileSync("git", ["init", "--quiet", project])
await symlink(`${outside}/deep`, `${project}/link`)
const actualSource = 'print("ACTUAL_HOST_LAUNCH_SOURCE")\n'
await writeFile(`${project}/job.py`, actualSource)
await writeFile(`${outside}/job.py`, 'print("PHYSICAL_SHELL_TARGET_WORKDIR_DECOY")\n')
await writeFile(`${temp}/job.py`, 'print("TIMED_CD_LEXICAL_DECOY")\n')
await mkdir(`${project}/sub`)
await writeFile(`${project}/sub/job.py`, 'print("ACTUAL_NEGATED_CD_SOURCE")\n')
await writeFile(`${project}/é.py`, 'print("ACTUAL_ANSI_BYTE_SOURCE")\n')
await writeFile(`${project}/Ã©.py`, 'print("ANSI_BYTE_DECOY")\n')
await writeFile(`${outside}/deep/direct.py`, 'print("ACTUAL_DIRECT_SYMLINK_SOURCE")\n')
await symlink(`${skill}/nested/deep`, `${skill}/link`)
await symlink(`${skill}/SKILL.md`, `${skill}/main-alias.md`)
await writeFile(`${skill}/nested/SKILL.md`, "ACTUAL_SYMLINK_PARENT_SUPPORT\n")
await writeFile(`${skill}/notes.md!`, "ACTUAL_PUNCTUATED_SUPPORT\n")
await writeFile(`${skill}/notes.md`, "UNREFERENCED_PUNCTUATION_DECOY\n")
await writeFile(`${skill}/.md`, "UNREFERENCED_MARKDOWN_FRAGMENT_DECOY\n")
await writeFile(`${skill}/foo(bar).md`, "UNSUPPORTED_DESTINATION_MUST_BE_OMITTED\n")
const supportingSource = `from pathlib import Path\nPath(${JSON.stringify(`${project}/support-executed`)}).write_text("must not execute")\n`
await writeFile(`${skill}/scripts/check.py`, supportingSource)
await writeFile(`${skill}/check.py`, "UNREFERENCED_COMMAND_FRAGMENT_DECOY\n")
const skillText = "# Evidence fixture\n\nFor the user's fixture inspection, read `notes.md!`, `link/../SKILL.md`, `main-alias.md`, [unsupported](foo(bar).md), and inspect the command `python \"scripts/\"check.py`. Do not execute supporting scripts.\n"
await writeFile(`${skill}/SKILL.md`, "---\nname: evidence-fixture\ndescription: Inspect the isolated evidence fixture\n---\n\n" + skillText)
const prompts = `${temp}/prompts`
if (scenario === "prompt-symlink") {
  await mkdir(prompts)
  await writeFile(`${temp}/outside-prompt.md`, "PRIVATE_SYMLINK_PROMPT_MUST_NOT_LOAD")
  await symlink(`${temp}/outside-prompt.md`, `${prompts}/SKILL-REVIEW-PROMPT.md`)
}
const operations = [
  { tool: "skill", input: { name: "evidence-fixture" } },
  { tool: "bash", input: { command: "python3 job.py", workdir: `${project}/link/..`, description: "Lexically normalized launch directory" } },
  ...[
    "bash -P -c 'cd link/.. && python3 job.py'",
    "bash -o physical -c 'cd link/.. && python3 job.py'",
    "bash -ePc 'cd link/.. && python3 job.py'",
    `trap 'cd ${outside}' DEBUG; python3 job.py`,
    "time cd link && python3 ../job.py",
  ].map(command => ({ tool: "bash", input: { command, description: "Unmodeled shell cwd evidence" } })),
  { tool: "bash", input: { command: String.raw`python3 $'\xc3\xa9.py'`, description: "ANSI-C byte identity" } },
  { tool: "bash", input: { command: "! cd sub; python3 job.py", description: "Negated builtin cwd identity" } },
  { tool: "bash", input: { command: "printf 'LAUNCH_PWD=%s\\n' \"$PWD\"; python3 direct.py; cd .. && python3 job.py", workdir: `${project}/link`, description: "Symlinked launch and inherited PWD identity" } },
]
const plugin = `${temp}/reviewer.mjs`
const bundle = `${temp}/bundle.mjs`
await copyFile(path.join(root, "dist/tui.js"), bundle)
await writeFile(plugin, `
import plugin from ${JSON.stringify(pathToFileURL(bundle).href)};
import {realpath, writeFile} from 'node:fs/promises';
import {realpath as callbackRealpath} from 'node:fs';
export default {id:plugin.id, tui:async (api, options) => {
  const link = await realpath(${JSON.stringify(`${skill}/link`)});
  await writeFile(${JSON.stringify(`${artifacts}/host-paths.json`)}, JSON.stringify({
    runtime:process.versions, literal:await realpath(${JSON.stringify(`${skill}/link/../SKILL.md`)}),
    link, physical:await realpath(link + '/../SKILL.md'),
    native:await new Promise((resolve,reject) => callbackRealpath.native(${JSON.stringify(`${skill}/link/../SKILL.md`)}, (error,value) => error ? reject(error) : resolve(value)))
  }, null, 2));
  return plugin.tui(api, options);
}};
`)
const prompt = "Inspect the isolated evidence fixture skill and run the harmless marker jobs to compare source identity. Do not run skill supporting scripts."
const requests = [], reviews = [], errors = [], outputs = new Map()
let sent = 0, started = false
const stream = (res, delta, tool) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  for (const [value, finish_reason] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]])
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`)
  res.end("data: [DONE]\n\n")
}
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); requests.push({ url: req.url, body })
    if (req.url === "/review/chat/completions") {
      const evidence = JSON.parse(body.messages[1].content)
      reviews.push(evidence)
      const index = Number(evidence.permission.tool.callID.slice("w2-".length)), operation = operations[index]
      assert.ok(operation)
      assert.equal(evidence.userPrompt, prompt)
      assert.equal(evidence.session.root.directory, project)
      assert.ok(!outputs.has(index), "review must precede the native tool result")
      if (evidence.kind === "external-directory") {
        assert.deepEqual(evidence.operation.input, operation.input)
        assert.ok(!("files" in evidence), "directory access must not become source collection")
      } else if (index === 0) {
        assert.equal(evidence.kind, "skill")
        assert.equal(evidence.skill.content.trim(), skillText.trim())
        assert.deepEqual(evidence.files.map(file => file.filename), ["notes.md!", "link/../SKILL.md", "scripts/check.py"])
        assert.deepEqual(evidence.files.map(file => file.contents), ["ACTUAL_PUNCTUATED_SUPPORT\n", "ACTUAL_SYMLINK_PARENT_SUPPORT\n", supportingSource])
        assert.equal(evidence.partial, true)
        assert.match(evidence.limitations.join(" "), /Unsupported Markdown.*whole link was omitted/)
        assert.doesNotMatch(JSON.stringify(evidence.files), /DECOY|UNSUPPORTED_DESTINATION|# Evidence fixture/)
      } else {
        assert.equal(evidence.kind, "shell")
        assert.equal(evidence.command, operation.input.command)
        if (index === 1) {
          assert.equal(evidence.execution.requestedWorkdir, `${project}/link/..`)
          assert.equal(evidence.cwd, project)
          assert.equal(evidence.execution.canonicalCwd, project)
          assert.deepEqual(evidence.files.map(file => file.contents), [actualSource])
          assert.equal(evidence.files[0].path, `${project}/job.py`)
        } else if (index === 7) {
          assert.deepEqual(evidence.files, [])
          assert.match(evidence.limitations.join(" "), /ANSI-C shell quoting/)
        } else if (index === 9) {
          assert.equal(evidence.cwd, `${project}/link`)
          assert.equal(evidence.execution.canonicalCwd, `${outside}/deep`)
          assert.equal(evidence.files.length, 2)
          assert.equal(evidence.files[0].contents, 'print("ACTUAL_DIRECT_SYMLINK_SOURCE")\n')
          assert.equal(evidence.files[1].contents, undefined)
          assert.match(evidence.files[1].status, /working directory unresolved/)
          assert.match(evidence.limitations.join(" "), /logical PWD/)
        } else {
          assert.ok(evidence.files.length)
          assert.ok(evidence.files.every(file => file.contents === undefined && /working directory unresolved/.test(file.status)))
          assert.match(evidence.limitations.join(" "), /Physical shell|through trap|Shell timed|Shell negation/)
        }
        assert.doesNotMatch(JSON.stringify(evidence.files), /DECOY/)
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: '{"safe":true,"desc":"Harmless isolated marker fixture. Evidence identity assertions passed."}' }, finish_reason: "stop" }] }))
      return
    }
    for (const message of body.messages) if (message.role === "tool" && /^w2-\d+$/.test(message.tool_call_id ?? "")) {
      const index = Number(message.tool_call_id.slice(3))
      outputs.set(index, message.content)
    }
    const next = operations[sent]
    const use = next && outputs.size === sent && body.tools?.some(tool => tool.function.name === next.tool)
    if (use) {
      const id = "w2-" + sent++
      stream(res, { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: next.tool, arguments: JSON.stringify(next.input) } }] }, true)
    } else stream(res, { role: "assistant", content: "Evidence fixture complete." }, false)
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "evidence")
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", shell: "/bin/bash", autoupdate: false, skills: { paths: [skills] },
    permission: { skill: "ask", bash: "ask", external_directory: "ask" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "synthetic" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1500 } } } } } }
  const tui = `${temp}/tui.json`
  await writeFile(tui, JSON.stringify({ plugin: [[plugin, { baseURL: base + "/review", model: "fixture", notify: false,
    autoApprove: true, autoApproveDelaySeconds: 0, stream: false, reviewExternalDirectories: true,
    ...(scenario === "prompt-symlink" ? { instructions: prompts } : {}) }]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: `${temp}/config`, OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await runtime.start("-d", "-s", "evidence", "-x", "160", "-y", "40", "-c", project, "env",
    ...Object.entries(env).map(([key, value]) => key + "=" + value), host, project, "--prompt", prompt)
  started = true
  const deadline = Date.now() + 120000
  if (scenario === "prompt-symlink") {
    while (!capture().includes("Analysis unavailable") && Date.now() < deadline) { assert.deepEqual(errors, []); await sleep(100) }
    assert.match(capture(), /Analysis unavailable/)
    assert.match(capture(), /Invalid prompt file/)
    assert.match(capture(), /Permission required/)
    await sleep(500)
    assert.equal(reviews.length, 0)
    assert.equal(outputs.size, 0)
    assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_SYMLINK_PROMPT_MUST_NOT_LOAD/)
  } else {
    while (outputs.size < operations.length && Date.now() < deadline) {
      assert.deepEqual(errors, [])
      await sleep(100)
    }
    assert.equal(outputs.size, operations.length, "every native operation must finish")
    assert.match(JSON.stringify(outputs.get(0)), /<skill_content/)
    assert.match(JSON.stringify(outputs.get(1)), /ACTUAL_HOST_LAUNCH_SOURCE/)
    assert.doesNotMatch(JSON.stringify(outputs.get(1)), /DECOY/)
    for (let index = 2; index < 7; index++) {
      assert.match(JSON.stringify(outputs.get(index)), /PHYSICAL_SHELL_TARGET_WORKDIR_DECOY/)
      assert.doesNotMatch(JSON.stringify(outputs.get(index)), /ACTUAL_HOST_LAUNCH_SOURCE|TIMED_CD_LEXICAL_DECOY/)
    }
    assert.match(JSON.stringify(outputs.get(7)), /ACTUAL_ANSI_BYTE_SOURCE/)
    assert.doesNotMatch(JSON.stringify(outputs.get(7)), /ANSI_BYTE_DECOY/)
    assert.match(JSON.stringify(outputs.get(8)), /ACTUAL_NEGATED_CD_SOURCE/)
    assert.doesNotMatch(JSON.stringify(outputs.get(8)), /ACTUAL_HOST_LAUNCH_SOURCE/)
    const launchOutput = JSON.stringify(outputs.get(9))
    assert.ok(launchOutput.includes(`LAUNCH_PWD=${outside}/deep`), "pinned Bash rejects inherited project PWD for the symlinked launch")
    assert.match(launchOutput, /ACTUAL_DIRECT_SYMLINK_SOURCE/)
    assert.match(launchOutput, /PHYSICAL_SHELL_TARGET_WORKDIR_DECOY/)
    assert.doesNotMatch(launchOutput, /ACTUAL_HOST_LAUNCH_SOURCE/)
    const operationsReviewed = reviews.filter(evidence => evidence.kind !== "external-directory")
    assert.deepEqual(operationsReviewed.map(evidence => evidence.permission.tool.callID), operations.map((_, index) => "w2-" + index))
  }
  await assert.rejects(access(`${project}/support-executed`))
  assert.deepEqual(errors, [])
  await writeFile(`${artifacts}/final.txt`, capture())
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ scenario, temp, hostVersion: "1.18.35", operations, reviews, outputs: [...outputs], requests }, null, 2))
  console.log(`PASS evidence ${scenario}: ${scenario === "capture" ? "native workdir/PWD identity, ANSI-C and negation omissions, physical/trap/time omissions, whole skill command operands and main identity" : "valid prompt symlink rejected, native permission remains manual, no reviewer POST"}; ${artifacts}`)
} catch (error) {
  if (started) await writeFile(`${artifacts}/failed.txt`, capture()).catch(() => {})
  await writeFile(`${artifacts}/failure.json`, JSON.stringify({ temp, error: String(error), stack: error.stack, errors, reviews, outputs: [...outputs], requests }, null, 2))
  throw error
} finally { await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
