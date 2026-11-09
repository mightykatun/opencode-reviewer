import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises"
import { mkdtemp, symlink, rm, mkdir, writeFile, realpath, open } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileHandle } from "node:fs/promises"
import { FileAccess, type FileIO } from "../src/file-access.js"
import { withDeadline, reviewStage } from "../src/deadline.js"
import { loadHostConversationContext, type HostContextReader } from "../src/host-context.js"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { collectHostEvidence } from "../src/host-evidence.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import { ownedReview } from "../src/review-admission.js"
import { nativeInvocation, nativeClient } from "./review-fixtures.js"
import { parseConfig } from "../src/config.js"

const timing = { totalMs: 80, pathMs: 15, captureMs: 25, concurrency: 2 }
const limits = { maxFiles: 6, maxEvidenceBytes: 131072 }
// Isolate source-capture ownership after the native collector's launch-path probe,
// as in the production evaluator. Standalone launch probes are tested separately.
const input = { command: "cat source", cwd: "/virtual", userPrompt: "Inspect source",
  execution: { canonicalCwd: "/virtual" } }
const signal = () => new AbortController().signal

const stat = { isFile: () => true, size: 8, mtimeMs: 1, ctimeMs: 1 }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settled(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await sleep(5)
  assert.ok(check(), "underlying operation and owned cleanup must settle")
}

function fakeIO(stage?: string) {
  const held = deferred<any>()
  const calls: string[] = []
  let reads = 0
  const handle = {
    stat: async () => { calls.push("stat"); return stage === "stat" ? held.promise : stat },
    read: async (buffer: Buffer) => {
      calls.push("read")
      if (stage === "read") return held.promise
      buffer.write("fixture\n")
      return { bytesRead: reads++ ? 0 : 8 }
    },
    close: async () => { calls.push("close"); if (stage === "close") await held.promise },
  } as unknown as FileHandle
  const io: FileIO = {
    realpath: async (filename) => { calls.push("realpath"); return stage === "realpath" ? held.promise : filename },
    open: async () => { calls.push("open"); reads = 0; return stage === "open" ? held.promise : handle },
  }
  const release = () => held.resolve(stage === "realpath" ? "/virtual/source" : stage === "open" ? handle : stage === "stat" ? stat : { bytesRead: 0 })
  return { io, calls, release }
}

/** Scheduling pauses spend no test budget; only explicit I/O/timer steps do. */
function controlledTime(t: TestContext) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  return { advance(ms: number) { now += ms; t.mock.timers.tick(ms) } }
}


test("physical parent probes own late directory descriptors and cleanup after timeout or cancellation", async t => {
  for (const stage of ["open", "descriptor", "close"]) for (const cancel of [false, true]) await t.test(`${stage} ${cancel ? "cancel" : "timeout"}`, async t => {
    const clock = controlledTime(t), entered = deferred<void>(), held = deferred<any>()
    let closes = 0, opens = 0
    const handle = { fd: 42, close: async () => {
      closes++
      if (stage === "close") { entered.resolve(); await held.promise }
    } } as unknown as FileHandle
    const files = new FileAccess({ open: (async () => {
      opens++
      if (stage === "open") { entered.resolve(); return held.promise }
      return handle
    }) as typeof open, realpath: async name => {
      if (name === "/proc/self/fd/42" && stage === "descriptor") { entered.resolve(); return held.promise }
      return "/outside/deep"
    } }, { ...timing, concurrency: 1 })
    const abort = new AbortController(), scope = files.scope(abort.signal)
    const pending = scope.canonical("/virtual/link/../target")
    try {
      await entered.promise
      if (cancel) abort.abort(Error("stop parent traversal"))
      else clock.advance(timing.pathMs)
      if (cancel) await assert.rejects(pending, /stop parent traversal/)
      else {
        const result = await pending
        assert.equal(result.path, null)
        assert.match(result.reason!, /timed out/)
        assert.match((await scope.canonical("/other")).reason!, /probes busy/)
      }
      assert.equal(files.outstanding, 1)
      assert.equal(opens, 1)
    } finally {
      held.resolve(stage === "open" ? handle : "/outside/deep")
      await pending.catch(() => {})
      await nextTurn()
      assert.equal(files.outstanding, 0)
      assert.equal(closes, 1)
    }
  })
})

test("physical parent traversal has a fixed probe-work bound", async t => {
  controlledTime(t)
  let opens = 0, closes = 0
  const files = new FileAccess({ realpath: async () => "/",
    open: (async () => { opens++; return { fd: 42, close: async () => { closes++ } } as FileHandle }) as typeof open })
  const result = await files.scope(signal()).canonical("/" + "../".repeat(300) + "target")
  assert.equal(result.path, null)
  assert.match(result.reason!, /256-component limit/)
  assert.ok(opens <= 256)
  assert.equal(closes, opens)
  assert.equal(files.outstanding, 0)
})

test("native edit diffs never launch filesystem probes, even with a stalled filesystem adapter", async () => {
  const fixture = fakeIO("realpath")
  const access = new FileAccess(fixture.io, timing)
  const diff = "@@ -1 +1 @@\n-before\n+after\n"
  const targets = ["source", "source", "alias", "other"]
  const context = nativeInvocation("patch", {
    patchText: "*** Begin Patch\n*** Update File: source\n@@\n-before\n+after\n*** Update File: alias\n@@\n-before\n+after\n*** Update File: other\n@@\n-before\n+after\n*** End Patch",
  }, { files: targets.map(file => ({ file, status: "modified", patch: diff })) }, "/virtual", targets)
  const s = signal()
  const result = await collectHostEvidence(context, { ...parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture" }), ...limits, maxFiles: 2 }, s, access)
  assert.ok(result.status === "ready" && result.evidence.kind === "edit")
  assert.deepEqual(result.evidence.changes.map(change => change.status), ["included", "included", "included", "omitted"])
  assert.equal(result.evidence.changes[0]!.patch, diff)
  assert.deepEqual(fixture.calls, [])
  fixture.release()
  await settled(() => access.outstanding === 0)
})

test("a busy event loop cannot turn an expired overall deadline into success or start a later phase", async () => {
  for (const nextPhase of [false, true]) {
    let advanced = false
    await assert.rejects(withDeadline(signal(), 20, async (s) => {
      reviewStage(s, "Evidence collection")
      const until = performance.now() + 40
      while (performance.now() < until) { /* Simulate synchronous evidence traversal. */ }
      if (nextPhase) { reviewStage(s, "Reviewer response"); advanced = true }
      return "late result"
    }), /Evidence collection timed out/)
    assert.equal(advanced, false)
  }
})

test("stalled mandatory native context fails closed and owns late client settlement", async () => {
  const late = deferred<Awaited<ReturnType<HostContextReader["message"]["list"]>>>()
  let aborted = false
  const reader: HostContextReader = {
    session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: "/virtual" }, projectID: "p" }) as any },
    message: { list: async (_, options) => { options!.signal!.addEventListener("abort", () => { aborted = true }); return late.promise } },
  }
  let result = false, settled = false
  const pending = ownedReview(signal(), 600, async s => {
    await loadHostConversationContext({ sessionID: "root", location: { directory: "/virtual" } }, reader, s)
    result = true
  })
  void pending.settled!.then(() => { settled = true })
  try {
    await assert.rejects(pending, /timed out/)
    assert.equal(aborted, true)
    assert.equal(result, false)
    assert.equal(settled, false, "expired mandatory context retains its physical client transaction")
    late.resolve({ data: [], cursor: {} })
    await pending.settled
    assert.equal(settled, true)
    assert.equal(result, false, "late mandatory context cannot publish a result")
  } finally { late.resolve({ data: [], cursor: {} }); await pending.settled }
})

for (const outcome of ["slow", "timeout", "cancel"] as const) {
  test(`${outcome} conversation lookup does not consume or start shell filesystem work`, async () => {
    const io = fakeIO()
    const access = new FileAccess(io.io, timing)
    const parent = new AbortController()
    const entered = deferred<void>()
    const history = deferred<Awaited<ReturnType<HostContextReader["message"]["list"]>>>()
    const owned = nativeInvocation("shell", { command: "cat source" }, undefined, "/virtual", ["cat source"])
    const reader = nativeClient(owned, access)
    reader.message.list = async () => { entered.resolve(); return history.promise }
    const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", retrieval: false })
    let evidence: any, posts = 0
    const pending = withDeadline(parent.signal, 1500, s => evaluateHostReview(reader, owned.snapshot, config, BUILTIN_PROMPTS, s, () => {}, {
      observeEvidence: value => { evidence = value }, fetcher: async () => { posts++; return Response.json({ choices: [{ message: { content: '{"safe":true,"desc":"Captured."}' } }] }) },
    }))
    try {
      await entered.promise
      assert.deepEqual(io.calls, [], "conversation context precedes the first filesystem probe")
      if (outcome === "cancel") {
        parent.abort(new Error("native resolution"))
        await assert.rejects(pending, /native resolution/)
        assert.deepEqual(io.calls, [])
        assert.equal(posts, 0)
        return
      }
      if (outcome === "slow") {
        await sleep(timing.totalMs + 30)
        history.resolve({ data: [], cursor: {} })
      }
      if (outcome === "timeout") {
        await assert.rejects(pending, /timed out/)
        assert.equal(posts, 0)
        assert.deepEqual(io.calls, [])
        return
      }
      const result = await pending
      assert.equal(result?.safe, true)
      assert.equal(posts, 1)
      assert.equal(evidence?.kind, "shell")
      assert.equal(Object.hasOwn(evidence, "files"), false)
      assert.equal(evidence.execution?.canonicalCwd, "/virtual")
      assert.equal(io.calls.filter(call => call === "open").length, 0)
      const snapshot = JSON.stringify(evidence)
      history.resolve({ data: [], cursor: {} })
      await sleep(0)
      assert.equal(JSON.stringify(evidence), snapshot)
    } finally {
      parent.abort()
      history.resolve({ data: [], cursor: {} })
      await pending.catch(() => {})
    }
    assert.equal(access.outstanding, 0)
  })
}
