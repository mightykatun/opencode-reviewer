import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { chmodSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { CompanionBusyError, createCompanionServer } from "../src/companion-reads.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import type { FileIO } from "../src/file-access.js"
import * as server from "../src/server.js"
import { withNotificationProcesses } from "../src/tui.js"
import { monotonicTimers } from "./reviewer-clock.js"

const skillOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewSkills: true, reviewTools: true, maxFiles: 6, maxEvidenceBytes: 131072 }

test("the companion never reads server options or exposes them through its identity", async () => {
  const life = new PluginLifecycle()
  const location = { directory: "/project", workspaceID: "workspace" }
  const secret = "server-only-key-sentinel"
  let optionReads = 0
  const context = { app: { version: "development" }, get options() { optionReads++; return { apiKey: secret } },
    location: { ...location, project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async () => ({ dispose() {} }) },
    rpc: { register: async () => assert.fail("The companion must not register RPC methods") },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(context, life)
  try {
    const first = companion.handshake
    assert.deepEqual(first.location, location)
    assert.equal(JSON.stringify(first).includes(secret), false)
    assert.equal("options" in first, false)
    assert.equal(optionReads, 0)
  } finally { await life.stop() }
})

test("skill registry evidence cannot survive a changed pending permission identity", async () => {
  const life = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let change = false, calls = 0
  const location = { directory: "/project" }
  const original = { id: "request", sessionID: "session", action: "skill", resources: ["review"],
    source: { type: "tool", messageID: "assistant", id: "call" } }
  let request = original
  const context = { app: { version: "development" }, location: { ...location, project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    permission: { get: async () => request }, session: { get: async () => ({ id: "session", location }) },
    skill: { list: async () => {
      calls++
      if (change) request = { ...original, source: { ...original.source, id: "different-call" } }
      return { location, data: [{ id: "review", name: "Review", path: "/project/review.md", content: "Summarize changes." }] }
    } },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(context, life)
  try {
    hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "skill", input: { id: "review" } })
    const query = { sessionID: "session", requestID: "request" }
    const collection = { timeoutMs: 5000, options: skillOptions }
    const valid = await companion.read(query, life.signal, collection) as any
    assert.equal(valid.result.status, "ready"); assert.equal(valid.result.evidence.skill.content, "Summarize changes.")
    change = true
    assert.equal(await companion.read(query, life.signal, collection), null)
    assert.equal(calls, 2)
  } finally { await life.stop() }
})

test("skill registry reads are scoped, read-only and retain physical ownership after abort", async () => {
  const life = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let release!: (value: unknown) => void, dispatched!: () => void, reads = 0
  const started = new Promise<void>(resolve => { dispatched = resolve })
  const held = new Promise(resolve => { release = resolve })
  const location = { directory: "/project" }
  let request: any = { id: "request", sessionID: "session", action: "skill", resources: ["review"],
    source: { type: "tool", messageID: "assistant", id: "call" } }
  const context = { app: { version: "development" }, location: { ...location, project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    permission: { get: async () => request }, session: { get: async () => ({ id: "session", location }) },
    skill: { list: async (input: unknown, options: { signal: AbortSignal }) => {
      assert.deepEqual(input, { location }); assert.equal(options.signal.aborted, false)
      reads++; dispatched(); return held
    } },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(context, life, { open() { assert.fail("Skill evidence must not open files") } } as any)
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "skill", input: { id: "review" } })
  const query = { sessionID: "session", requestID: "request" }
  const collection = { timeoutMs: 5000, options: skillOptions }
  try {
    const disabled = await companion.read(query, life.signal, { ...collection, options: { ...skillOptions, reviewSkills: false } }) as any
    assert.equal(disabled.result.status, "disabled"); assert.equal(reads, 0)
    const abort = new AbortController()
    const pending = companion.read(query, abort.signal, collection)
    await started; abort.abort(); assert.equal(await pending, null)
    let stopped = false
    const stopping = life.stop().then(() => { stopped = true })
    await tick(); assert.equal(stopped, false, "Catalog read remains owned through actual settlement")
    request = null
    release({ location, data: [{ id: "review", name: "Review", path: "/project/review.md", content: "Summarize changes." }] })
    await stopping; await life.settled()
    assert.equal(reads, 1)
  } finally { release(undefined); await life.stop() }
})

test("the public notification-process seam stays dormant in the server lifecycle", async () => {
  const disposed: string[] = []
  let constructed = 0
  const terminal = withNotificationProcesses(() => { constructed++; throw Error("Server must never construct desktop processes") })
  assert.equal(terminal.id, server.default.id)
  assert.equal("withNotificationProcesses" in server, false)
  const context = {
    app: { version: "development", channel: "latest" },
    location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string) => ({ dispose() { disposed.push(name) } }) },
    rpc: { register: async () => ({ dispose() {}, events: { emit: async () => {} } }) },
    model: { list: async () => ({ location: { directory: "/project" }, data: [] }) },
    provider: { list: async () => ({ location: { directory: "/project" }, data: [] }) },
    event: { subscribe: (options: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() {
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }))
    } }) },
  } as unknown as Plugin.Context
  assert.equal(constructed, 0)
  // Isolated policy, state and hosting: the production default reads the server user's files.
  const temp = await mkdtemp(path.join(tmpdir(), "reviewer-server-entry-"))
  chmodSync(temp, 0o700)
  try {
    const plugin = server.withServerDependencies({ policyFile: path.join(temp, "opencode-reviewer.json"), stateRoot: temp, ledger: null, accounting: null,
      registrationFile: path.join(temp, "service.json"), hosting: { discover: async () => undefined } })
    const stop = await plugin.setup(context)
    assert.equal(constructed, 0)
    await stop()
    assert.equal(constructed, 0)
    assert.deepEqual(disposed.sort(), ["execute.after", "execute.before"])
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test("companion read admission retains timed-out operations and unload owns their actual settlement", async () => {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>(), disposed: string[] = []
  const permissions: { resolve: (value: unknown) => void }[] = []
  const context = {
    app: { version: "2.0.26" }, location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string, callback: (event: any) => void) => {
      hooks.set(name, callback); return { dispose: async () => { disposed.push(name) } }
    } },
    permission: { get: async () => new Promise(resolve => { permissions.push({ resolve }) }) },
    session: { get: async () => { throw Error("Canceled reads cannot dispatch session lookup") } },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(context, lifecycle)
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "shell", input: { command: "python3 task.py" } })
  const query = { sessionID: "session", requestID: "request" }
  const first = new AbortController(), second = new AbortController()
  const signal = new AbortController().signal
  const one = companion.read(query, first.signal), two = companion.read(query, second.signal)
  await tick()
  assert.equal(permissions.length, 2)
  await assert.rejects(companion.read(query, signal), CompanionBusyError)
  await assert.rejects(companion.read(query, signal, { options: skillOptions, timeoutMs: 5000 }), CompanionBusyError)
  assert.equal(await companion.read(query, signal, { options: { ...skillOptions, maxFiles: Infinity }, timeoutMs: 5000 }), null)
  assert.equal(permissions.length, 2, "Busy and invalid calls do not dispatch another public read")
  first.abort()
  assert.equal(await one, null)
  await assert.rejects(companion.read(query, signal), CompanionBusyError, "Caller cancellation cannot release the still-running public read")
  permissions[0]!.resolve({ id: "request", sessionID: "session", action: "shell", resources: [], save: undefined, metadata: undefined,
    source: { type: "tool", messageID: "assistant", id: "call" }, message: undefined })
  await tick()
  const three = companion.read(query, signal)
  await tick()
  assert.equal(permissions.length, 3, "Actual settlement frees exactly one slot")
  let stopped = false
  const stopping = lifecycle.stop().then(() => { stopped = true })
  assert.equal(await two, null)
  assert.equal(await three, null)
  await tick()
  assert.equal(stopped, false)
  assert.deepEqual(disposed, ["execute.after", "execute.before"])
  permissions[1]!.resolve(undefined); permissions[2]!.resolve(undefined)
  await stopping
  await lifecycle.settled()
  assert.equal(stopped, true)
  assert.equal(await companion.read(query, signal), null)
  assert.equal(permissions.length, 3)
})

test("evidence abort retains the server path probe through settlement during unload", async () => {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let opened!: () => void, resolve!: (value: unknown) => void, closed = false
  const acquiring = new Promise<void>(yes => { opened = yes })
  const io = { realpath: async (path: string) => {
    opened()
    await new Promise(yes => { resolve = yes })
    closed = true
    return path
  }, open: async () => { throw Error("mandatory shell evidence never opens files") } } as unknown as FileIO
  const request = { id: "request", sessionID: "session", action: "shell", resources: ["python3 fixture.py"],
    source: { type: "tool", messageID: "assistant", id: "call" } }
  const context = {
    app: { version: "2.0.26" }, location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    permission: { get: async () => request }, session: { get: async () => ({ id: "session", location: { directory: "/project" } }) },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(context, lifecycle, io)
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "shell", input: { command: "python3 fixture.py" } })
  const abort = new AbortController()
  const pending = companion.read({ sessionID: "session", requestID: "request" }, abort.signal, {
    timeoutMs: 5000, options: { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
      reviewSkills: true, reviewTools: true, maxFiles: 6, maxEvidenceBytes: 131072 } })
  await acquiring
  abort.abort()
  assert.equal(await pending, null)
  let stopped = false
  const stopping = lifecycle.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  resolve(undefined)
  await stopping
  await lifecycle.settled()
  assert.equal(closed, true)
})

test("an unfamiliar host version still requires exact readable invocation evidence", async () => {
  const lifecycle = new PluginLifecycle()
  let reads = 0
  const context = { app: { version: "2.0.28" },
    location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async () => ({ dispose() {} }) },
    permission: { get: async () => { reads++; throw Error("Permission unavailable") } },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(context, lifecycle)
  try {
    const query = { sessionID: "session", requestID: "request" }
    assert.equal(await companion.read(query, lifecycle.signal), null)
    assert.equal(await companion.read(query, lifecycle.signal, { options: undefined, timeoutMs: 5000 }), null)
    assert.equal(reads, 1, "Version does not bypass or disable the actual permission read")
  } finally { await lifecycle.stop() }
})

test("retrieval is scoped, bounded, owns slow operations and returns factual results", async t => {
  const clock = monotonicTimers(t)
  const lifecycle = new PluginLifecycle()
  let release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  const io = { realpath: async (name: string) => { if (name.includes("slow")) await slow; return name },
    open: async () => { throw Object.assign(Error("denied"), { code: "EACCES" }) } } as unknown as FileIO
  const context = {
    app: { version: "2.2.6" }, location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async () => ({ dispose() {} }) },
  } as unknown as Plugin.Context
  const companion = await createCompanionServer(context, lifecycle, io)
  const signal = new AbortController().signal
  const query = { sessionID: "session", requestID: "request", base: "/project",
    timeoutMs: 1000, maxBytes: 4096 }
  assert.equal(await companion.retrieve({ ...query, base: "relative", call: { tool: "read", arguments: { path: "a" } } }, signal), null)
  assert.deepEqual(await companion.retrieve({ ...query, call: { tool: "read", arguments: { path: "a.txt" } } }, signal),
    { tool: "read", status: "error", path: "a.txt", absolutePath: "/project/a.txt", canonicalPath: "/project/a.txt", reason: "EACCES" })
  const first = companion.retrieve({ ...query, call: { tool: "read", arguments: { path: "slow-1" } } }, signal)
  const second = companion.retrieve({ ...query, timeoutMs: 50, call: { tool: "read", arguments: { path: "slow-2" } } }, signal)
  await tick()
  await assert.rejects(companion.retrieve({ ...query, call: { tool: "read", arguments: { path: "c" } } }, signal), CompanionBusyError)
  let secondSettled = false
  void second.then(() => { secondSettled = true })
  clock.tick(50)
  await tick()
  assert.equal(secondSettled, false, "a retrieval response waits for its physical work even after its logical deadline")
  await assert.rejects(companion.retrieve({ ...query, call: { tool: "read", arguments: { path: "c" } } }, signal), CompanionBusyError,
    "a timed-out operation keeps its slot until it settles")
  let stopped = false
  const stopping = lifecycle.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  release()
  assert.equal(await first, null)
  assert.deepEqual(await second, { tool: "read", status: "error", reason: "Retrieval timed out" })
  await stopping
  assert.equal(stopped, true)
})
