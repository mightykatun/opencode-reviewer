import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, rename, mkdir, readdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { setImmediate as turn } from "node:timers/promises"
import { observationPublisher, readObservation } from "../scripts/smoke-observations.mjs"
import { selectedPaletteResult, activatePalette } from "../scripts/smoke-ui.mjs"
import { smokeGitInit } from "../scripts/smoke-runtime.mjs"
import { runtimeInventory } from "../scripts/runtime-inventory.mjs"

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "smoke-publisher-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return path.join(directory, "observations.json")
}

test("fixture Git initialization ignores hostile directory, config and template overrides", async t => {
  const directory = await mkdtemp("/tmp/opencode/reviewer-git-isolation-")
  t.after(() => rm(directory, { recursive: true, force: true }))
  const home = path.join(directory, "private home"), project = path.join(home, "project")
  const outside = path.join(directory, "unrelated-git"), template = path.join(directory, "hostile-template")
  await Promise.all([mkdir(project, { recursive: true }), mkdir(outside), mkdir(template)])
  await writeFile(path.join(outside, "sentinel"), "unrelated state")
  await writeFile(path.join(template, "inherited-template"), "must not be copied")
  const global = path.join(directory, "global-config")
  await writeFile(global, `[init]\n\ttemplateDir = ${JSON.stringify(template)}\n`)
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { smokeGitInit } from ${JSON.stringify(new URL("../scripts/smoke-runtime.mjs", import.meta.url).href)};
    smokeGitInit(${JSON.stringify(home)}, ${JSON.stringify(project)});
  `], { env: { ...process.env, GIT_DIR: outside, GIT_WORK_TREE: outside, GIT_COMMON_DIR: outside,
    GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: global, GIT_TEMPLATE_DIR: template,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "init.templateDir", GIT_CONFIG_VALUE_0: template }, timeout: 20000 })
  assert.ok((await stat(path.join(project, ".git"))).isDirectory())
  assert.match(await readFile(path.join(project, ".git/HEAD"), "utf8"), /^ref: refs\/heads\//)
  await assert.rejects(stat(path.join(project, ".git/inherited-template")), { code: "ENOENT" })
  assert.deepEqual(await readdir(outside), ["sentinel"])
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "unrelated state")
})

test("fixture Git setup rejects targets outside its namespace before dispatch", () => {
  for (const [home, project] of [["relative", "/outside"], ["/private", "relative"], ["/private", "/outside"], ["/private", "/private"]])
    assert.throws(() => smokeGitInit(home, project), /Fixture Git/)
})

test("every inventoried Git fixture uses the bounded isolated initialization helper", async () => {
  const fixtures = Object.entries(runtimeInventory).filter(([, entry]) => entry.requires?.includes("git"))
  assert.equal(fixtures.length, 15)
  for (const [file] of fixtures) {
    const source = await readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8")
    assert.match(source, /smokeGitInit\(temp, project\)/, file)
    assert.doesNotMatch(source, /execFileSync\(["']git["']/, `${file} bypasses isolated Git setup`)
  }
})

test("observation publication serializes, coalesces, snapshots inputs, and flushes the newest update", async t => {
  const file = await fixture(t), releases = [], paths = []
  let active = 0, peak = 0
  const publisher = observationPublisher(file, { io: { writeFile: async (...args) => {
    paths.push(args[0]); peak = Math.max(peak, ++active)
    await new Promise(resolve => releases.push(resolve))
    await writeFile(...args); active--
  }, rename, rm } })
  publisher.publish({ revision: 1 })
  await turn()
  assert.equal(await readObservation(file, { optional: true }), undefined)
  const snapshot = { revision: 2 }
  publisher.publish(snapshot); snapshot.revision = 999
  publisher.publish({ revision: 3 })
  assert.throws(() => publisher.publish(undefined), /must be JSON/)
  const closing = publisher.close()
  releases.shift()(); await turn()
  while (!releases.length) await turn()
  assert.deepEqual(await readObservation(file), { revision: 1 })
  releases.shift()(); await closing
  assert.deepEqual(await readObservation(file), { revision: 3 })
  assert.equal(peak, 1); assert.equal(paths.length, 2)
  assert.notEqual(paths[0], paths[1]); assert.ok(paths.every(p => path.dirname(p) === path.dirname(file)))
  await publisher.close()
  assert.throws(() => publisher.publish({ revision: 4 }), /closed/)
})

test("a queued snapshot is immutable and rapid readers never see partial JSON", async t => {
  const file = await fixture(t), publisher = observationPublisher(file)
  const value = { revision: 1, text: "x".repeat(100000) }
  publisher.publish(value); value.revision = 200
  await publisher.flush()
  assert.equal((await readObservation(file)).revision, 1)
  for (let n = 2; n <= 30; n++) {
    publisher.publish({ revision: n, text: value.text })
    assert.ok((await readObservation(file)).revision <= n)
  }
  await publisher.close()
  assert.equal((await readObservation(file)).revision, 30)
})

for (const operation of ["writeFile", "rename"]) test(`${operation} failures are owned immediately and surfaced to driver and disposal`, async t => {
  const file = await fixture(t)
  const publisher = observationPublisher(file, { io: { writeFile, rename, rm,
    [operation]: async () => { throw new Error("simulated ENOSPC") } } })
  publisher.publish({ revision: 1 }) // Deliberately unawaited, as host event callbacks are.
  await assert.rejects(publisher.close(), /simulated ENOSPC/)
  await assert.rejects(readObservation(file, { optional: true }), /simulated ENOSPC/)
  await assert.rejects(publisher.flush(), /simulated ENOSPC/)
})

test("only explicit initial absence is optional; corrupt observations retain their path and cause", async t => {
  const file = await fixture(t)
  await assert.rejects(readObservation(file), /observations.json/)
  assert.equal(await readObservation(file, { optional: true }), undefined)
  await writeFile(file, "{broken")
  await assert.rejects(readObservation(file, { optional: true }), /Invalid JSON.*observations.json/)
})

const title = "Reviewer: Statistics"
const palette = (selected = "Previous command", target = true) =>
  `\x1b[48;2;20;20;20mCommands\n ${title} \n` +
  `\x1b[48;2;100;100;200m ${selected} \x1b[48;2;20;20;20m\n` +
  (target && selected !== title ? ` ${title} \n` : "")

test("palette readiness rejects input echoes and unselected results, accepts the selected exact row", () => {
  assert.equal(selectedPaletteResult(palette(), title), false)
  assert.equal(selectedPaletteResult(palette("Previous command", false), title), false)
  assert.equal(selectedPaletteResult(palette(title), title), true)
  assert.equal(selectedPaletteResult(palette(title + " extra"), title), false)
})

test("delayed palette filtering cannot send Enter early; activation waits for its postcondition", async () => {
  const sent = []
  let polls = 0, activated = false, ready = false
  await activatePalette({ send: (...keys) => { sent.push(keys); if (keys[0] === "Enter") {
    assert.ok(polls >= 4); activated = true
  } }, capture: () => {
    if (activated) { ready = ++polls >= 7; return ready ? "Reviewer statistics" : "Loading" }
    return palette(++polls >= 4 ? title : "Previous command")
  }, intervalMs: 0 }, title, s => s.includes("Reviewer statistics"))
  assert.equal(ready, true)
  assert.deepEqual(sent, [["C-p"], ["C-u"], ["-l", title], ["Enter"]])
})

test("wrong selection times out with the command and capture, without Enter", async () => {
  const sent = []
  await assert.rejects(activatePalette({ send: (...keys) => sent.push(keys), capture: () => palette(), timeoutMs: 15, intervalMs: 1 },
    title, () => false), /Reviewer: Statistics[\s\S]*Previous command/)
  assert.ok(!sent.some(keys => keys[0] === "Enter"))
})

test("palette disappearance is not proof the command's required postcondition happened", async () => {
  let activated = false
  await assert.rejects(activatePalette({ send: key => { if (key === "Enter") activated = true },
    capture: () => activated ? "Wrong view" : palette(title), timeoutMs: 15, intervalMs: 1 }, title,
  s => s.includes("Reviewer statistics")), /postcondition[\s\S]*Wrong view/)
})
