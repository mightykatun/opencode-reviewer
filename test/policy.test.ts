import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdtemp, mkdir, open, rename, rm, symlink, watch, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { loadPolicy, parsePolicySections, parseServerConfig, parseTuiConfig, policyFile, PolicyWatcher, type PolicyChange } from "../src/policy.js"
import { loadPrompts } from "../src/prompts.js"

const server = { baseURL: "http://127.0.0.1:1/v1", model: "judge", autoApprove: true }
const until = async (what: string, check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error("Timeout: " + what); await sleep(20) }
}

test("the policy file lives in the server user's XDG config directory with a home fallback", () => {
  assert.equal(policyFile({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"), "/xdg/opencode/opencode-reviewer.json")
  assert.equal(policyFile({ XDG_CONFIG_HOME: "relative" }, "/home/u"), "/home/u/.config/opencode/opencode-reviewer.json")
  assert.equal(policyFile({}, "/home/u"), "/home/u/.config/opencode/opencode-reviewer.json")
})

test("sections validate independently and viewer keys never enter the server section", () => {
  assert.deepEqual(parsePolicySections(JSON.stringify({ server, tui: { notify: false } })), { server, tui: { notify: false } })
  assert.throws(() => parsePolicySections("{"), /not valid JSON/)
  assert.throws(() => parsePolicySections(JSON.stringify([])), /JSON object/)
  assert.throws(() => parsePolicySections(JSON.stringify({ baseURL: "x" })), /Unknown reviewer policy section: baseURL/)
  assert.throws(() => parsePolicySections(JSON.stringify({ server: [] })), /server must be an object/)
  assert.throws(() => parseServerConfig({ ...server, notify: true }), /notify belongs to the tui section/)
  assert.equal(parseServerConfig(server).autoApprove, true)
  assert.throws(() => parseTuiConfig({ baseURL: "x" }), /Unknown tui setting: baseURL/)
  assert.equal(parseTuiConfig({ notify: false }).notify, false)
  assert.equal(parseTuiConfig({}).notify, true)
})

test("loading reports a missing file as no policy and an invalid file as both sections invalid", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-policy-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "opencode-reviewer.json")
  const signal = new AbortController().signal
  assert.deepEqual(await loadPolicy(file, signal), { file })
  await writeFile(file, "{", { mode: 0o600 })
  const invalid = await loadPolicy(file, signal)
  assert.match(invalid.serverError!, /not valid JSON/)
  assert.equal(invalid.tuiError, invalid.serverError)
  assert.equal(invalid.server, undefined)
  await writeFile(file, JSON.stringify({ server: { ...server, timeoutMs: "slow" }, tui: { notify: false } }), { mode: 0o600 })
  const partial = await loadPolicy(file, signal)
  assert.match(partial.serverError!, /timeoutMs/)
  assert.equal(partial.server, undefined)
  assert.equal(partial.tui?.notify, false)
  assert.equal(partial.tuiError, undefined)
  await writeFile(file, JSON.stringify({ server }), { mode: 0o600 })
  const valid = await loadPolicy(file, signal)
  assert.equal(valid.server?.config.model, "judge")
  assert.equal(valid.server?.config.autoApprove, true)
  assert.ok(valid.server?.prompts.shell.instructions.length)
  assert.equal(valid.tui, undefined)
  assert.equal(valid.tuiError, undefined)
  await chmod(file, 0o666)
  const untrusted = await loadPolicy(file, signal)
  assert.match(untrusted.serverError!, /owned by the current user and not writable by others/)
  assert.equal(untrusted.tuiError, untrusted.serverError)
})

test("the watcher publishes complete generations only for effective changes of each section", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-policy-watch-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "opencode-reviewer.json")
  const changes: PolicyChange[] = []
  const controller = new AbortController()
  t.after(() => controller.abort())
  const watcher = new PolicyWatcher(file, change => changes.push(change), controller.signal, { debounceMs: 30 })
  const first = await watcher.start()
  assert.equal(first.id, 1)
  assert.equal(first.server, undefined)
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0]!.changed, { server: true, tui: true })
  // Atomic replacement: write a temporary file, then rename over the target.
  const temporary = path.join(dir, "policy.tmp")
  await writeFile(temporary, JSON.stringify({ server, tui: { notify: false } }), { mode: 0o600 })
  await rename(temporary, file)
  await until("server policy", () => changes.length === 2)
  assert.deepEqual(changes[1]!.changed, { server: true, tui: true })
  assert.equal(changes[1]!.generation.id, 2)
  assert.equal(changes[1]!.generation.server?.config.model, "judge")
  assert.equal(changes[1]!.generation.tui?.notify, false)
  // Semantically identical rewrite with different key order and whitespace.
  await writeFile(file, JSON.stringify({ tui: { notify: false }, server: { model: "judge", autoApprove: true, baseURL: "http://127.0.0.1:1/v1" } }, null, 2), { mode: 0o600 })
  await sleep(300)
  assert.equal(changes.length, 2, "identical effective settings publish nothing")
  // A tui-only edit changes only the tui section.
  await writeFile(file, JSON.stringify({ server, tui: { notify: false, staleReminderSeconds: 5 } }), { mode: 0o600 })
  await until("tui change", () => changes.length === 3)
  assert.deepEqual(changes[2]!.changed, { server: false, tui: true })
  assert.equal(changes[2]!.generation.server?.config.model, "judge")
  // Deletion revokes both sections without resurrecting an old snapshot.
  await rm(file)
  await until("deletion", () => changes.length === 4)
  assert.deepEqual(changes[3]!.changed, { server: true, tui: true })
  assert.equal(changes[3]!.generation.server, undefined)
  assert.equal(changes[3]!.generation.tui, undefined)
  assert.equal(watcher.current?.id, 4)
  controller.abort()
  await writeFile(file, JSON.stringify({ server }), { mode: 0o600 })
  await sleep(200)
  assert.equal(changes.length, 4, "a disposed watcher publishes nothing")
})

test("a policy section with an invalid type leaves its valid sibling available", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-policy-shape-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "policy.json")
  const signal = new AbortController().signal
  await writeFile(file, JSON.stringify({ server, tui: null }), { mode: 0o600 })
  const validServer = await loadPolicy(file, signal)
  assert.equal(validServer.server?.config.model, "judge")
  assert.equal(validServer.serverError, undefined)
  assert.match(validServer.tuiError!, /tui must be an object/)
  await writeFile(file, JSON.stringify({ server: [], tui: { notify: false } }))
  const validTui = await loadPolicy(file, signal)
  assert.equal(validTui.tui?.notify, false)
  assert.equal(validTui.tuiError, undefined)
  assert.match(validTui.serverError!, /server must be an object/)
})

test("symlinked and oversized policy files invalidate both sections", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-policy-file-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "policy.json")
  const alias = path.join(dir, "link")
  const signal = new AbortController().signal
  await writeFile(file, JSON.stringify({ server }), { mode: 0o600 })
  await symlink(file, alias)
  const linked = await loadPolicy(alias, signal)
  assert.match(linked.serverError!, /symlink/)
  assert.equal(linked.tuiError, linked.serverError)
  await writeFile(file, "{}".padEnd(1024 * 1024 + 1))
  const oversized = await loadPolicy(file, signal)
  assert.match(oversized.serverError!, /exceeds 1 MiB/)
  assert.equal(oversized.tuiError, oversized.serverError)
})

test("policy reads stay on the validated descriptor and reject a size change during the read", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-policy-descriptor-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "policy.json")
  const replacement = path.join(dir, "replacement.json")
  const signal = new AbortController().signal
  await writeFile(file, JSON.stringify({ server }), { mode: 0o600 })
  await writeFile(replacement, JSON.stringify({ server: { ...server, model: "replacement" } }), { mode: 0o600 })
  const sample = await open(file)
  const prototype = Object.getPrototypeOf(sample)
  const stat = sample.stat
  await sample.close()
  let change: (() => Promise<void>) | undefined = () => rename(replacement, file)
  t.mock.method(prototype, "stat", async function(this: FileHandle) {
    const info = await stat.call(this)
    const afterStat = change
    change = undefined
    await afterStat?.()
    return info
  })
  assert.equal((await loadPolicy(file, signal)).server?.config.model, "judge")
  assert.equal((await loadPolicy(file, signal)).server?.config.model, "replacement")
  change = () => writeFile(file, "{}")
  const unstable = await loadPolicy(file, signal)
  assert.match(unstable.serverError!, /size changed/)
  assert.equal(unstable.tuiError, unstable.serverError)
})

test("a policy replacement during initial prompt loading publishes only the replacement", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-policy-start-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "policy.json")
  const replacement = path.join(dir, "replacement.json")
  await writeFile(file, JSON.stringify({ server }), { mode: 0o600 })
  await writeFile(replacement, JSON.stringify({ server: { ...server, model: "replacement" } }), { mode: 0o600 })
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const readingPrompts = new Promise<void>(resolve => { started = resolve })
  const changes: PolicyChange[] = []
  const controller = new AbortController()
  t.after(() => controller.abort())
  const watcher = new PolicyWatcher(file, change => changes.push(change), controller.signal, {
    load: (file, signal) => loadPolicy(file, signal, async (directory, signal) => {
      started()
      await hold
      return loadPrompts(directory, signal)
    }),
  })
  const first = watcher.start()
  await readingPrompts
  const events = watch(dir, { signal: controller.signal })
  const renamed = (async () => {
    for await (const event of events) if (event.filename === path.basename(file)) break
  })()
  await rename(replacement, file)
  await renamed
  release()
  assert.equal((await first).server?.config.model, "replacement")
  assert.deepEqual(changes.map(change => change.generation.server?.config.model), ["replacement"])
})

test("the watcher starts before its directory exists and catches up through its retry", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-policy-late-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "opencode", "opencode-reviewer.json")
  const changes: PolicyChange[] = []
  const controller = new AbortController()
  t.after(() => controller.abort())
  const watcher = new PolicyWatcher(file, change => changes.push(change), controller.signal, { debounceMs: 20, retryMs: 50 })
  await watcher.start()
  assert.equal(changes.length, 1)
  await mkdir(path.dirname(file))
  await writeFile(file, JSON.stringify({ tui: { notify: true } }), { mode: 0o600 })
  await until("late directory", () => changes.length === 2)
  assert.equal(changes[1]!.generation.tui?.notify, true)
})
