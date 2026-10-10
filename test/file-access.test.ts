import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises"
import { mkdtemp, symlink, rm, mkdir, writeFile, realpath, open } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileHandle } from "node:fs/promises"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2"
import { FileAccess, type FileIO } from "../src/file-access.js"
import { withDeadline, reviewStage } from "../src/deadline.js"
import { collectEvidence, collectEditEvidence, discover } from "../src/evidence.js"
import { loadConversationContext, type ContextReader } from "../src/context.js"
import { evaluateEvidence } from "../src/evaluate.js"
import { parseConfig } from "../src/config.js"
import type { EditContext } from "../src/types.js"

const timing = { totalMs: 80, pathMs: 15, captureMs: 25, concurrency: 2 }
const limits = { maxFiles: 6, maxEvidenceBytes: 131072 }
// Isolate source-capture ownership after the context loader's launch-path probe,
// as in the production evaluator. Standalone launch probes are tested separately.
const input = { command: "cat source", cwd: "/virtual", userPrompt: "Inspect source",
  execution: { tool: "bash" as const, requestedWorkdir: null, instanceDirectory: "/virtual", instanceWorktree: "/virtual",
    cwdSource: "assistant.path.cwd" as const, canonicalCwd: "/virtual" } }
const signal = () => new AbortController().signal

test("source parent traversal stays physical even with a lexically normalizing host realpath", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-physical-path-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(`${dir}/project`); await mkdir(`${dir}/outside/deep`, { recursive: true })
  await symlink(`${dir}/outside/deep`, `${dir}/project/link`)
  await writeFile(`${dir}/outside/job.py`, "# physical target\n")
  await writeFile(`${dir}/project/job.py`, "# lexical path decoy\n")
  await writeFile(`${dir}/project/not-directory`, "# regular file\n")
  const files = new FileAccess({ open, realpath: name => realpath(path.resolve(name)) })
  for (const operand of ["link/../job.py", "not-directory/../job.py"]) {
    const s = signal()
    const result = await collectEvidence({ command: `python ${operand}`, cwd: `${dir}/project`, userPrompt: null }, limits, s, files.scope(s))
    if (operand.startsWith("link")) assert.equal(result.files[0]?.contents, "# physical target\n")
    else { assert.equal(result.files[0]?.contents, undefined); assert.match(result.files[0]!.status, /ENOTDIR/) }
    assert.doesNotMatch(JSON.stringify(result.files), /lexical path decoy/)
  }
  assert.equal(files.outstanding, 0)
})
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

test("standalone launch-cwd probes preserve direct capture and own timeout/cancellation through settlement", async t => {
  for (const cancel of [false, true]) await t.test(cancel ? "cancel" : "timeout", async t => {
    const clock = controlledTime(t), fixture = fakeIO(), entered = deferred<void>(), held = deferred<string>()
    const probed: string[] = []
    const files = new FileAccess({ ...fixture.io, realpath: async filename => {
      probed.push(filename)
      if (filename === "/virtual") { entered.resolve(); return held.promise }
      return filename
    } }, timing)
    const abort = new AbortController()
    const pending = collectEvidence({ command: "cat source; cd .. && python decoy.py", cwd: "/virtual", userPrompt: "Inspect" },
      limits, abort.signal, files.scope(abort.signal))
    try {
      await entered.promise
      assert.equal(files.outstanding, 1)
      if (cancel) {
        abort.abort(new Error("launch lookup cancelled"))
        await assert.rejects(pending, /launch lookup cancelled/)
        assert.deepEqual(probed, ["/virtual"])
        assert.ok(!fixture.calls.includes("open"))
      } else {
        clock.advance(timing.pathMs)
        const result = await pending
        assert.equal(result.files[0]?.contents, "fixture\n")
        assert.equal(result.files[1]?.contents, undefined)
        assert.match(result.files[1]!.status, /working directory unresolved/)
        assert.match(result.limitations.join(" "), /logical PWD/)
        assert.deepEqual(probed, ["/virtual", "/virtual/source"])
        assert.equal(fixture.calls.filter(call => call === "open").length, 1)
      }
      assert.equal(files.outstanding, 1, "timed-out or cancelled launch lookup retains its actual slot")
    } finally {
      held.resolve("/virtual")
      await pending.catch(() => {})
      await nextTurn()
      assert.equal(files.outstanding, 0)
    }
  })
})

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

for (const stage of ["realpath", "open", "stat", "read", "close"]) {
  test(`stalled ${stage} becomes an omission before the overall deadline; late completion is owned`, async () => {
    const fixture = fakeIO(stage)
    const access = new FileAccess(fixture.io, timing)
    const start = performance.now()
    const result = await withDeadline(signal(), 1000, (s) => collectEvidence(input, limits, s, access.scope(s)))
    assert.ok(performance.now() - start < 800)
    assert.match(result.files[0]!.status, /timed out/)
    assert.equal(result.files[0]!.contents, undefined)
    assert.match(result.files[0]!.warning!, /not included/)
    assert.equal(access.outstanding, 1, "timeout must not release a still-running probe slot")
    const before = JSON.stringify(result)
    fixture.release()
    await settled(() => access.outstanding === 0)
    assert.equal(JSON.stringify(result), before, "late results must not mutate the published evidence")
    assert.equal(fixture.calls.filter((call) => call === "close").length, stage === "realpath" ? 0 : 1)
    if (stage === "open") assert.deepEqual(fixture.calls, ["realpath", "open", "close"])
  })
}

test("probe saturation bounds abandoned work across reviews and recovers after settlement", async () => {
  const fixture = fakeIO("realpath")
  const access = new FileAccess(fixture.io, timing)
  for (let i = 0; i < 2; i++) { const s = signal(); await collectEvidence(input, limits, s, access.scope(s)) }
  assert.equal(access.outstanding, 2)
  for (let i = 0; i < 10; i++) {
    const s = signal()
    const result = await collectEvidence(input, limits, s, access.scope(s))
    assert.match(result.files[0]!.status, /probes busy/)
  }
  assert.deepEqual(fixture.calls, ["realpath", "realpath"])
  fixture.release()
  await settled(() => access.outstanding === 0)
  const s = signal()
  const result = await collectEvidence(input, limits, s, access.scope(s))
  assert.equal(result.files[0]!.contents, "fixture\n")
})

test("shared budget limits long candidate lists and avoids repeated canonicalization", async (t) => {
  const clock = controlledTime(t)
  const fixture = fakeIO()
  const calls: string[] = []
  const access = new FileAccess({ ...fixture.io, realpath: async (name) => {
    calls.push(name)
    fixture.calls.push(`path:${name}`)
    if (name === "/virtual/source") { clock.advance(20); return name }
    if (name === "/virtual/alias") return "/virtual/source"
    // This later probe consumes the exact 15 ms left after the healthy source.
    clock.advance(15)
    return name
  } }, { ...timing, totalMs: 35, pathMs: 30 })
  const s = signal()
  const command = `cat source alias source alias ${Array.from({ length: 30 }, (_, i) => `file${i}`).join(" ")}`
  const result = await collectEvidence({ ...input, command }, { ...limits, maxEvidenceBytes: Buffer.byteLength(command) + 8 }, s, access.scope(s))
  assert.deepEqual(calls, ["/virtual/source", "/virtual/alias", "/virtual/file0"], "expiry prevents every subsequent I/O launch, including parent probes")
  assert.equal(fixture.calls.filter(call => call === "open").length, 1)
  assert.ok(fixture.calls.indexOf("close") < fixture.calls.indexOf("path:/virtual/alias"), "capture and cleanup precede later canonicalization")
  assert.equal(result.files.length, 31)
  assert.equal(result.files[0]?.contents, "fixture\n", "admitted source is captured before later probes spend the allowance")
  assert.deepEqual(result.files[0]?.aliases, ["/virtual/alias"], "canonical aliases consume neither a second file nor a second byte allowance")
  assert.match(result.files[1]?.status ?? "", /timed out/)
  assert.ok(result.files.slice(2, limits.maxFiles).every(file => /budget exhausted/.test(file.status)))
  assert.ok(result.files.slice(limits.maxFiles).every(file => /file-count limit/.test(file.status)))
  assert.ok(result.files.slice(1).every((file) => file.contents === undefined))
  await nextTurn()
  assert.equal(access.outstanding, 0)
})

test("later slow or count-rejected paths cannot starve a healthy admitted capture", async (t) => {
  const clock = controlledTime(t)
  for (const maxFiles of [1, 6]) {
    const fixture = fakeIO()
    const late = deferred<string>()
    const slowStarted = deferred<void>(), rejectedStarted = deferred<void>()
    const probed: string[] = []
    const io = { ...fixture.io, realpath: async (name: string) => {
      probed.push(name)
      if (name === "/virtual/source") return name
      if (name === "/virtual/slow") slowStarted.resolve()
      if (name === "/virtual/rejected") rejectedStarted.resolve()
      return late.promise
    } }
    const access = new FileAccess(io, timing)
    const s = signal()
    const pending = collectEvidence({ ...input, command: "cat source slow rejected source" }, { ...limits, maxFiles }, s, access.scope(s))
    try {
      await slowStarted.promise
      assert.ok(fixture.calls.includes("close"), "first capture and cleanup precede the first later path probe")
      assert.equal(access.outstanding, 1)
      clock.advance(timing.pathMs)
      await rejectedStarted.promise
      assert.equal(access.outstanding, 2, "the first timed-out transaction retains its slot until actual settlement")
      clock.advance(timing.pathMs)
      const result = await pending
      assert.equal(result.files[0]?.contents, "fixture\n")
      assert.equal(fixture.calls.filter(call => call === "open").length, 1)
      assert.deepEqual(probed, ["/virtual/source", "/virtual/slow", "/virtual/rejected"])
      assert.equal(result.files.length, 3)
      assert.ok(result.files.slice(1).every(file => (maxFiles === 1 ? /file-count limit/ : /timed out/).test(file.status)))
      assert.ok(result.files.slice(1).every(file => file.contents === undefined))
      assert.equal(access.outstanding, 2)
      const published = JSON.stringify(result)
      late.resolve("/virtual/late")
      await nextTurn()
      assert.equal(access.outstanding, 0)
      assert.equal(JSON.stringify(result), published)
    } finally {
      late.resolve("/virtual/late")
      await pending.catch(() => {})
      await nextTurn()
      assert.equal(access.outstanding, 0)
    }
  }
})

test("alias qualification promotion never retries a failed capture transaction", async (t) => {
  const clock = controlledTime(t)
  const fixture = fakeIO("open")
  const opened = deferred<void>()
  const access = new FileAccess({ ...fixture.io, realpath: async () => "/virtual/source",
    open: (...args) => { const pending = fixture.io.open(...args); opened.resolve(); return pending } }, timing)
  const s = signal()
  const pending = collectEvidence({ ...input, command: "./source; python alias; cat alias" }, limits, s, access.scope(s))
  try {
    await opened.promise
    clock.advance(timing.captureMs)
    const result = await pending
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0]?.contents, undefined)
    assert.match(result.files[0]?.status ?? "", /timed out/)
    assert.deepEqual(result.files[0]?.aliases, ["/virtual/alias"])
    assert.equal(fixture.calls.filter(call => call === "open").length, 1)
    assert.equal(access.outstanding, 1)
  } finally {
    fixture.release()
    await pending.catch(() => {})
    await nextTurn()
    assert.equal(access.outstanding, 0)
    assert.equal(fixture.calls.filter(call => call === "close").length, 1)
  }
})

test("exact aliases prequalify once while canonical alias promotion captures at most twice and charges bytes once", async (t) => {
  controlledTime(t)
  for (const operand of ["./source", "alias"]) {
    const fixture = fakeIO()
    const access = new FileAccess({ ...fixture.io, realpath: async () => "/virtual/source" }, timing)
    const command = `./source; python ${operand}; cat ${operand}`
    const s = signal()
    const result = await collectEvidence({ ...input, command }, { ...limits, maxFiles: 1, maxEvidenceBytes: Buffer.byteLength(command) + 8 }, s, access.scope(s))
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0]?.contents, "fixture\n")
    assert.equal(result.files[0]?.warning, undefined)
    assert.equal(fixture.calls.filter(call => call === "open").length, operand === "./source" ? 1 : 2)
    assert.equal(access.outstanding, 0)
  }
})

test("complete edit diffs survive stalled canonicalization with conservative alias accounting", async () => {
  const fixture = fakeIO("realpath")
  const access = new FileAccess(fixture.io, timing)
  const diff = "@@ -1 +1 @@\n-before\n+after\n"
  const context: EditContext = { kind: "edit", tool: "apply_patch", userPrompt: "Update", limitations: [],
    location: { instanceDirectory: "/virtual", instanceWorktree: "/virtual" },
    permission: { id: "p", type: "edit", patterns: ["*"], always: ["*"], tool: null,
      metadata: { files: ["source", "source", "alias", "other"].map((name) => ({ filePath: `/virtual/${name}`, type: "update", patch: diff })) } } }
  const s = signal()
  const result = await collectEditEvidence(context, { ...limits, maxFiles: 2 }, s, access.scope(s))
  assert.deepEqual(result.changes.map((change) => change.status), ["included", "included", "included", "omitted"])
  assert.equal(result.changes[0]!.diff, diff)
  assert.match(result.limitations.join(" "), /timed out.*aliases count separately/)
  assert.ok(!fixture.calls.includes("open"))
  fixture.release()
  await settled(() => access.outstanding === 0)
})

test("parent cancellation rejects the review and a late open still closes its handle", async () => {
  const fixture = fakeIO("open")
  const access = new FileAccess(fixture.io, timing)
  const parent = new AbortController()
  const reason = new Error("native request resolved")
  const pending = collectEvidence(input, limits, parent.signal, access.scope(parent.signal))
  await settled(() => fixture.calls.includes("open"))
  parent.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  assert.equal(access.outstanding, 1)
  fixture.release()
  await settled(() => access.outstanding === 0)
  assert.deepEqual(fixture.calls, ["realpath", "open", "close"])
})

test("late I/O errors are consumed, exhausted probes never launch, and stage labels identify hard timeouts", async () => {
  const held = deferred<string>()
  const access = new FileAccess({ ...fakeIO().io, realpath: () => held.promise }, timing)
  const s = signal()
  await collectEvidence(input, limits, s, access.scope(s))
  held.reject(new Error("private late error"))
  await settled(() => access.outstanding === 0)
  let launched = false
  await assert.rejects(withDeadline(s, 0, async () => { launched = true }), /timed out/)
  assert.equal(launched, false)
  await assert.rejects(withDeadline(s, 10, async (child) => { reviewStage(child, "Permission context lookup"); return new Promise(() => {}) }), /Permission context lookup timed out/)
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

test("ordinary filesystem failures and special files remain factual omissions", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-special-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await symlink("absent", path.join(directory, "dangling"))
  execFileSync("mkfifo", [path.join(directory, "pipe")])
  for (const [name, expected] of [["missing", /ENOENT/], ["dangling", /ENOENT/], ["pipe", /not a regular file/]] as const) {
    const result = await collectEvidence({ ...input, cwd: directory, command: `cat ${name}` }, limits, signal())
    assert.match(result.files[0]!.status, expected)
  }
  const access = new FileAccess({ ...fakeIO().io, realpath: async () => { throw Object.assign(new Error("private error"), { code: "EACCES" }) } }, timing)
  const s = signal()
  const result = await collectEvidence(input, limits, s, access.scope(s))
  assert.match(result.files[0]!.status, /EACCES/)
  assert.doesNotMatch(JSON.stringify(result), /private error/)
  for (const command of ["ssh fixture 'cat /srv/remote.py'", "docker exec fixture python /srv/remote.py"]) {
    const discovered = discover(command, directory)
    assert.deepEqual(discovered.references, [])
    assert.match(discovered.limitations.join(" "), /Indirect execution/)
  }
})

test("stalled optional context leaves partial provenance and time for the reviewer", async () => {
  const late = deferred<Awaited<ReturnType<ContextReader["messages"]>>>()
  let aborted = false
  const reader: ContextReader = {
    message: async () => undefined, projects: async () => [],
    session: async (id) => ({ id, directory: "/virtual", projectID: "p" } as Session),
    messages: async (_, signal) => { signal.addEventListener("abort", () => { aborted = true }); return late.promise },
  }
  await withDeadline(signal(), 600, async (s) => {
    const result = await loadConversationContext({ id: "p", sessionID: "root", permission: "bash", patterns: [], always: [], metadata: {} }, reader, s)
    assert.equal(s.aborted, false)
    assert.equal(result.session.current?.directory, "/virtual")
    assert.equal(result.userPrompt, null)
    assert.match(result.limitations.join(" "), /Conversation context lookup timed out/)
    assert.equal(aborted, true)
    const before = JSON.stringify(result)
    late.resolve([])
    await sleep(0)
    assert.equal(JSON.stringify(result), before)
  })
})

for (const outcome of ["slow", "timeout", "cancel"] as const) {
  test(`${outcome} conversation lookup does not consume or start shell filesystem work`, async () => {
    const io = fakeIO()
    const access = new FileAccess(io.io, timing)
    const parent = new AbortController()
    const entered = deferred<void>()
    const history = deferred<Awaited<ReturnType<ContextReader["messages"]>>>()
    const request: PermissionRequest = { id: "p", sessionID: "root", permission: "bash", patterns: ["cat source"],
      always: [], metadata: {}, tool: { messageID: "m", callID: "c" } }
    const reader: ContextReader = {
      message: async () => ({ info: { id: "m", sessionID: "root", role: "assistant", parentID: "user", time: { created: 2 },
        providerID: "fixture", modelID: "fixture", mode: "build", agent: "build", path: { cwd: "/virtual", root: "/virtual" },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ id: "part", type: "tool", tool: "bash", messageID: "m", sessionID: "root", callID: "c",
          state: { status: "running", input: { command: "cat source" }, time: { start: 1 } } }] }),
      toolIDs: async () => ["bash"],
      session: async id => ({ id, directory: "/origin", projectID: "p" } as Session),
      messages: async () => { entered.resolve(); return history.promise },
      projects: async () => [],
    }
    const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture" })
    const pending = withDeadline(parent.signal, 1500, s => evaluateEvidence(request, reader, config, config, "", s, () => {}, access))
    try {
      await entered.promise
      assert.deepEqual(io.calls, [], "conversation context precedes the first filesystem probe")
      if (outcome === "cancel") {
        parent.abort(new Error("native resolution"))
        await assert.rejects(pending, /native resolution/)
        assert.deepEqual(io.calls, [])
        return
      }
      if (outcome === "slow") {
        await sleep(timing.totalMs + 30)
        history.resolve([])
      }
      const evidence = await pending
      assert.ok(evidence?.kind === "shell")
      assert.equal(evidence.files[0]!.contents, "fixture\n")
      assert.equal(evidence.execution?.canonicalCwd, "/virtual")
      assert.equal(io.calls.filter(call => call === "open").length, 1)
      if (outcome === "timeout") assert.match(evidence.limitations.join(" "), /Conversation context lookup timed out/)
      const snapshot = JSON.stringify(evidence)
      history.resolve([])
      await sleep(0)
      assert.equal(JSON.stringify(evidence), snapshot)
    } finally {
      parent.abort()
      history.resolve([])
      await pending.catch(() => {})
    }
    assert.equal(access.outstanding, 0)
  })
}
