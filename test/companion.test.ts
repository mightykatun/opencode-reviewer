import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { setupCompanion } from "../src/companion.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import type { FileIO } from "../src/file-access.js"
import { withNotificationProcesses } from "../src/plugin.js"
import { monotonicTimers } from "./reviewer-clock.js"

const skillOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewSkills: true, reviewTools: true, maxFiles: 6, maxEvidenceBytes: 131072 }

test("skill registry evidence cannot survive a changed pending permission identity", async () => {
  const life = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let handlers: any, change = false, calls = 0
  const location = { directory: "/project" }
  const original = { id: "request", sessionID: "session", action: "skill", resources: ["review"],
    source: { type: "tool", messageID: "assistant", id: "call" } }
  let request = original
  const context = { app: { version: "development" }, location: { ...location, project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose() {} } } },
    permission: { get: async () => request }, session: { get: async () => ({ id: "session", location }) },
    skill: { list: async () => {
      calls++
      if (change) request = { ...original, source: { ...original.source, id: "different-call" } }
      return { location, data: [{ id: "review", name: "Review", path: "/project/review.md", content: "Summarize changes." }] }
    } },
  } as unknown as Plugin.Context
  const state = await setupCompanion(context, life)
  try {
    hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "skill", input: { id: "review" } })
    const query = { epoch: state.epoch, location, sessionID: "session", requestID: "request", timeoutMs: 5000, options: skillOptions }
    const valid = await handlers.evidence(query, { signal: life.signal })
    assert.equal(valid.result.status, "ready"); assert.equal(valid.result.evidence.skill.content, "Summarize changes.")
    change = true
    assert.equal(await handlers.evidence(query, { signal: life.signal }), null)
    assert.equal(calls, 2)
  } finally { await life.stop() }
})

test("skill registry reads are scoped, read-only and retain physical ownership after abort", async () => {
  const life = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let handlers: any, release!: (value: unknown) => void, dispatched!: () => void, reads = 0
  const started = new Promise<void>(resolve => { dispatched = resolve })
  const held = new Promise(resolve => { release = resolve })
  const location = { directory: "/project" }
  let request: any = { id: "request", sessionID: "session", action: "skill", resources: ["review"],
    source: { type: "tool", messageID: "assistant", id: "call" } }
  const context = { app: { version: "development" }, location: { ...location, project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string, callback: (event: any) => void) => { hooks.set(name, callback); return { dispose() {} } } },
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose() {} } } },
    permission: { get: async () => request }, session: { get: async () => ({ id: "session", location }) },
    skill: { list: async (input: unknown, options: { signal: AbortSignal }) => {
      assert.deepEqual(input, { location }); assert.equal(options.signal.aborted, false)
      reads++; dispatched(); return held
    } },
  } as unknown as Plugin.Context
  const handshake = await setupCompanion(context, life, { open() { assert.fail("Skill evidence must not open files") } } as any)
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "skill", input: { id: "review" } })
  const query = { epoch: handshake.epoch, location, sessionID: "session", requestID: "request", timeoutMs: 5000, options: skillOptions }
  try {
    const disabled = await handlers.evidence({ ...query, options: { ...skillOptions, reviewSkills: false } }, { signal: life.signal })
    assert.equal(disabled.result.status, "disabled"); assert.equal(reads, 0)
    const abort = new AbortController()
    const pending = handlers.evidence(query, { signal: abort.signal })
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
  const plugin = withNotificationProcesses(() => { constructed++; throw Error("Server must never construct desktop processes") })
  const context = {
    app: { version: "development" },
    location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string) => ({ dispose() { disposed.push(name) } }) },
    rpc: { register: async () => ({ dispose() { disposed.push("rpc") } }) },
  } as unknown as Plugin.Context
  assert.equal(constructed, 0)
  const stop = await plugin.setup(context)
  assert.equal(constructed, 0)
  await stop()
  assert.equal(constructed, 0)
  assert.deepEqual(disposed, ["rpc", "execute.after", "execute.before"])
})

test("companion read admission retains timed-out operations and unload owns their actual settlement", async () => {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>(), disposed: string[] = []
  let handlers: any
  const permissions: { resolve: (value: unknown) => void }[] = []
  const context = {
    app: { version: "2.0.26" }, location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async (name: string, callback: (event: any) => void) => {
      hooks.set(name, callback); return { dispose: async () => { disposed.push(name) } }
    } },
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose: async () => { disposed.push("rpc") } } } },
    permission: { get: async () => new Promise(resolve => { permissions.push({ resolve }) }) },
    session: { get: async () => { throw Error("Canceled reads cannot dispatch session lookup") } },
  } as unknown as Plugin.Context
  const handshake = await setupCompanion(context, lifecycle)
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "shell", input: { command: "python3 task.py" } })
  const query = { epoch: handshake.epoch, location: handshake.location, sessionID: "session", requestID: "request" }
  const first = new AbortController(), second = new AbortController()
  const call = (abort = new AbortController()) => ({ signal: abort.signal, error: (type: string, message: string, data: unknown) => { throw Object.assign(Error(message), { type, data }) } })
  const one = handlers.invocation(query, call(first)), two = handlers.invocation(query, call(second))
  await tick()
  assert.equal(permissions.length, 2)
  await assert.rejects(handlers.invocation(query, call()), { type: "capacity_busy" })
  await assert.rejects(handlers.evidence({ ...query, options: skillOptions, timeoutMs: 5000 }, call()), { type: "capacity_busy" })
  assert.equal(await handlers.evidence({ ...query, options: { ...skillOptions, maxFiles: Infinity }, timeoutMs: 5000 }, call()), null)
  await assert.rejects(handlers.invocation({ ...query, epoch: "another-epoch" }, call()), { type: "scope" })
  assert.equal(permissions.length, 2, "Busy and invalid calls do not dispatch another public read")
  first.abort()
  assert.equal(await one, null)
  await assert.rejects(handlers.invocation(query, call()), { type: "capacity_busy" }, "Caller cancellation cannot release the still-running public read")
  permissions[0]!.resolve({ id: "request", sessionID: "session", action: "shell", resources: [], save: undefined, metadata: undefined,
    source: { type: "tool", messageID: "assistant", id: "call" }, message: undefined })
  await tick()
  const three = handlers.invocation(query, call())
  await tick()
  assert.equal(permissions.length, 3, "Actual settlement frees exactly one slot")
  let stopped = false
  const stopping = lifecycle.stop().then(() => { stopped = true })
  assert.equal(await two, null)
  assert.equal(await three, null)
  await tick()
  assert.equal(stopped, false)
  assert.deepEqual(disposed, ["rpc", "execute.after", "execute.before"])
  permissions[1]!.resolve(undefined); permissions[2]!.resolve(undefined)
  await stopping
  await lifecycle.settled()
  assert.equal(stopped, true)
  assert.equal(await handlers.invocation(query, call()), null)
  assert.equal(permissions.length, 3)
})

test("evidence abort retains the server path probe through settlement during unload", async () => {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let handlers: any, opened!: () => void, resolve!: (value: unknown) => void, closed = false
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
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose() {} } } },
    permission: { get: async () => request }, session: { get: async () => ({ id: "session", location: { directory: "/project" } }) },
  } as unknown as Plugin.Context
  const handshake = await setupCompanion(context, lifecycle, io)
  hooks.get("execute.before")!({ sessionID: "session", messageID: "assistant", id: "call", tool: "shell", input: { command: "python3 fixture.py" } })
  const abort = new AbortController()
  const pending = handlers.evidence({ epoch: handshake.epoch, location: handshake.location, sessionID: "session", requestID: "request",
    timeoutMs: 5000, options: { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
      reviewSkills: true, reviewTools: true, maxFiles: 6, maxEvidenceBytes: 131072 } },
    { signal: abort.signal, error: () => { throw Error("unexpected") } })
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
  let handlers: any, reads = 0
  const context = { app: { version: "2.0.28" },
    location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async () => ({ dispose() {} }) },
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose() {} } } },
    permission: { get: async () => { reads++; throw Error("Permission unavailable") } },
  } as unknown as Plugin.Context
  const state = await setupCompanion(context, lifecycle)
  try {
    const query = { epoch: state.epoch, location: state.location, sessionID: "session", requestID: "request" }
    assert.equal(await handlers.invocation(query, { signal: lifecycle.signal }), null)
    assert.equal(await handlers.evidence(query, { signal: lifecycle.signal }), null)
    assert.equal(reads, 1, "Version does not bypass or disable the actual permission read")
  } finally { await lifecycle.stop() }
})

test("retrieval RPC is scoped, bounded, owns slow operations and returns factual results", async t => {
  const clock = monotonicTimers(t)
  const lifecycle = new PluginLifecycle()
  let handlers: any, release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  const io = { realpath: async (name: string) => { if (name.includes("slow")) await slow; return name },
    open: async () => { throw Object.assign(Error("denied"), { code: "EACCES" }) } } as unknown as FileIO
  const context = {
    app: { version: "2.2.6" }, location: { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async () => ({ dispose() {} }) },
    rpc: { register: async (_definition: unknown, value: unknown) => { handlers = value; return { dispose() {} } } },
  } as unknown as Plugin.Context
  const handshake = await setupCompanion(context, lifecycle, io)
  const call = (abort = new AbortController()) => ({ signal: abort.signal, error: (type: string, message: string, data: unknown) => { throw Object.assign(Error(message), { type, data }) } })
  const query = { epoch: handshake.epoch, location: handshake.location, sessionID: "session", requestID: "request", base: "/project",
    timeoutMs: 1000, maxBytes: 4096 }
  await assert.rejects(handlers.retrieve({ ...query, epoch: "other", call: { tool: "read", arguments: { path: "a" } } }, call()), { type: "scope" })
  assert.equal(await handlers.retrieve({ ...query, base: "relative", call: { tool: "read", arguments: { path: "a" } } }, call()), null)
  assert.deepEqual(await handlers.retrieve({ ...query, call: { tool: "read", arguments: { path: "a.txt" } } }, call()),
    { tool: "read", status: "error", path: "a.txt", absolutePath: "/project/a.txt", canonicalPath: "/project/a.txt", reason: "EACCES" })
  const first = handlers.retrieve({ ...query, call: { tool: "read", arguments: { path: "slow-1" } } }, call())
  const second = handlers.retrieve({ ...query, timeoutMs: 50, call: { tool: "read", arguments: { path: "slow-2" } } }, call())
  await tick()
  await assert.rejects(handlers.retrieve({ ...query, call: { tool: "read", arguments: { path: "c" } } }, call()), { type: "capacity_busy" })
  let secondSettled = false
  void second.then(() => { secondSettled = true })
  clock.tick(50)
  await tick()
  assert.equal(secondSettled, false, "a retrieval response waits for its physical work even after its logical deadline")
  await assert.rejects(handlers.retrieve({ ...query, call: { tool: "read", arguments: { path: "c" } } }, call()), { type: "capacity_busy" },
    "a timed-out operation keeps its slot until it settles")
  let stopped = false
  const stopping = lifecycle.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  release()
  assert.equal((await first)?.status ?? null, null)
  assert.deepEqual(await second, { tool: "read", status: "error", reason: "Retrieval timed out" })
  await stopping
  assert.equal(stopped, true)
})
