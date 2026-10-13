import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { setupCompanion } from "../src/companion.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"
import type { FileIO } from "../src/file-access.js"
import { withNotificationProcesses } from "../src/plugin.js"

const skillOptions = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewSkills: true, reviewMcp: true, reviewCustomTools: true, maxFiles: 6, maxEvidenceBytes: 131072 }

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
  const call = (abort = new AbortController()) => ({ signal: abort.signal, error: () => { throw Error("Unexpected scope error") } })
  const one = handlers.invocation(query, call(first)), two = handlers.invocation(query, call(second))
  await tick()
  assert.equal(permissions.length, 2)
  assert.equal(await handlers.invocation(query, call()), null)
  first.abort()
  assert.equal(await one, null)
  assert.equal(await handlers.invocation(query, call()), null, "Caller cancellation cannot release the still-running public read")
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

test("evidence abort retains the server file transaction and late descriptor cleanup during unload", async () => {
  const lifecycle = new PluginLifecycle(), hooks = new Map<string, (event: any) => void>()
  let handlers: any, opened!: () => void, resolve!: (value: unknown) => void, closed = false
  const acquiring = new Promise<void>(yes => { opened = yes })
  const io = { realpath: async (path: string) => path, open: async () => {
    opened()
    return new Promise(yes => { resolve = yes })
  } } as unknown as FileIO
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
      reviewSkills: true, reviewMcp: true, reviewCustomTools: true, maxFiles: 6, maxEvidenceBytes: 131072 } },
    { signal: abort.signal, error: () => { throw Error("unexpected") } })
  await acquiring
  abort.abort()
  assert.equal(await pending, null)
  let stopped = false
  const stopping = lifecycle.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  resolve({ close: async () => { closed = true } })
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
