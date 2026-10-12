import { test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep, setImmediate as settle } from "node:timers/promises"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller as CoreController, displayText, visibleReview, type View } from "../src/controller.js"
import type { ContextReader } from "../src/context.js"
import { evaluateEvidence } from "../src/evaluate.js"
import { FileAccess } from "../src/file-access.js"
import { parseConfig } from "../src/config.js"
import { withDeadline } from "../src/reviewer.js"
import type { Assessment, ReviewProgress, ReviewTiming } from "../src/types.js"
import { SessionModes } from "../src/session-mode.js"

// Lifecycle seams explicitly control classification/completion. Composition cases
// below use evaluateEvidence; directory review is independently enabled in both.
class Controller extends CoreController {
  constructor(...args: ConstructorParameters<typeof CoreController>) {
    super(args[0], args[1], { ...args[2], reviewOptions: { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true, ...args[2]?.reviewOptions } })
  }
}

const request = (id: string, sessionID = "root", permission = "bash"): PermissionRequest => ({ id, sessionID, permission, patterns: [id], metadata: {}, always: [], tool: { callID: id, messageID: id } })
const result: Assessment = { safe: true, desc: "Counts fruit." }
const tick = () => sleep(0)
const getSession = (id: string) => ({ id })
const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", reviewExternalDirectories: true })

const contextReader = (message: ContextReader["message"]): ContextReader => ({
  message,
  session: async () => undefined,
  messages: async () => [],
  projects: async () => [],
  toolIDs: async () => ["bash"],
})

const shellMessage: ContextReader["message"] = async (sessionID, messageID) => ({
  info: {
    id: messageID, sessionID, role: "assistant", parentID: "user", time: { created: 2 },
    providerID: "fixture", modelID: "fixture", mode: "build", agent: "build", path: { cwd: "/", root: "/" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [{
    id: "tool-part", messageID, sessionID, type: "tool", callID: messageID, tool: "bash",
    state: { status: "running", input: { command: "python x.py" }, time: { start: 1 } },
  }],
})

test("deduplicates events and keeps concurrent assessments bound to their request", async () => {
  const pending = new Map<string, (value: Assessment) => void>()
  const controller = new Controller((req) => new Promise((resolve) => pending.set(req.id, resolve)), () => {})
  controller.asked(request("a")); controller.asked(request("b")); controller.asked(request("a"))
  await tick()
  assert.equal(pending.size, 2)
  pending.get("b")!({ safe: false, desc: "Deletes data." })
  pending.get("a")!(result)
  await tick()
  assert.deepEqual(controller.views.map((v) => [v.request.id, v.assessment?.safe]), [["a", true], ["b", false]])
  controller.dispose()
})

test("lifetime ratings observe each accepted final review once, not previews, retries, errors or republishes", async () => {
  const ratings: boolean[] = []
  const controller = new CoreController(async (req, _signal, identified, progress) => {
    identified()
    progress({ attempt: 0, phase: "evaluating" })
    progress({ attempt: 0, phase: "streaming", preview: { safe: true } })
    progress({ attempt: 1, phase: "retrying" })
    progress({ attempt: 1, phase: "streaming", preview: { safe: false } })
    if (req.id === "error") throw new Error("Analysis unavailable")
    if (req.id === "unrelated") return null
    return { safe: req.id === "safe", desc: "Final review without usage." }
  }, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true, stream: true },
  onRating: safe => { ratings.push(safe) } })
  const requests = ["safe", "unsafe", "error", "unrelated"].map(id => request(id))
  for (const req of requests) { controller.asked(req); controller.asked(req) }
  await tick()
  assert.deepEqual(ratings, [true, false])
  controller.reconcile(requests, controller.revision)
  controller.presented("safe"); controller.presented()
  await tick()
  assert.deepEqual(ratings, [true, false])
  await controller.dispose()
})

test("review timing uses the accepted attempt's first rating and excludes later display/approval time", async () => {
  let now = 100, finish!: (value: Assessment) => void, progress!: (value: ReviewProgress) => void
  const timings: ReviewTiming[] = []
  const controller = new CoreController((_req, _signal, identified, onProgress) => {
    identified(); progress = onProgress; return new Promise(resolve => { finish = resolve })
  }, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true, stream: true },
  clock: { now: () => now, after: () => () => {} }, onRating: (_safe, timing) => { timings.push(timing) } })
  controller.asked(request("a")); await tick()
  progress({ attempt: 0, phase: "evaluating" })
  now = 150; progress({ attempt: 0, phase: "streaming", preview: { desc: "Description first" } })
  now = 300; progress({ attempt: 0, phase: "streaming", preview: { safe: false } })
  now = 500; progress({ attempt: 1, phase: "retrying" })
  now = 700; progress({ attempt: 1, phase: "streaming", preview: { safe: true } })
  now = 800; progress({ attempt: 1, phase: "streaming", preview: { safe: true, desc: "More text" } })
  now = 900; progress({ attempt: 0, phase: "streaming", preview: { safe: false } })
  now = 1000; finish(result); await tick()
  now = 5000; controller.presented("a"); controller.reconcile([request("a")], controller.revision)
  assert.deepEqual(timings, [{ fullReportMs: 900, ratingMs: 600 }])
  await controller.dispose()
})

test("non-streaming timing records the final response time for both measures", async () => {
  let now = 100
  const timings: ReviewTiming[] = []
  const controller = new CoreController(async () => { now = 1100; return result }, () => {}, {
    clock: { now: () => now, after: () => () => {} }, onRating: (_safe, timing) => { timings.push(timing) } })
  controller.asked(request("a")); await tick()
  assert.deepEqual(timings, [{ fullReportMs: 1000, ratingMs: 1000 }])
  await controller.dispose()
})

for (const action of ["reply", "delete", "disable", "dispose"] as const) {
  test(`late rating after ${action} is not counted`, async () => {
    const modes = modeFixture(), ratings: boolean[] = []
    let finish!: (value: Assessment) => void
    const controller = new CoreController((_req, _signal, identified) => {
      identified(); return new Promise(resolve => { finish = resolve })
    }, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true }, modes,
    onRating: safe => { ratings.push(safe) } })
    controller.asked(request("a")); await tick()
    if (action === "reply") controller.replied("a")
    if (action === "delete") controller.deleted("root")
    if (action === "disable") { await modes.set("root", false); controller.modeChanged("root") }
    const disposing = action === "dispose" ? controller.dispose() : undefined
    finish(result); await tick(); await disposing
    assert.deepEqual(ratings, [])
    await controller.dispose()
  })
}

test("a fresh final review after re-enabling contributes a new rating", async () => {
  const modes = modeFixture(), ratings: boolean[] = []
  const controller = new CoreController(async () => result, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true },
    modes, onRating: safe => { ratings.push(safe) } })
  const req = request("a")
  controller.asked(req); await tick()
  await modes.set("root", false); controller.modeChanged("root")
  await modes.set("root", true); controller.modeChanged("root")
  controller.reconcile([req], controller.revision); await tick()
  assert.deepEqual(ratings, [true, true])
  await controller.dispose()
})

for (const failure of ["throw", "reject"] as const) test(`rating observer ${failure} cannot change a review`, async () => {
  const controller = new CoreController(async () => result, () => {}, {
    onRating: () => { if (failure === "throw") throw new Error("storage unavailable"); return Promise.reject(new Error("storage unavailable")) } })
  controller.asked(request("a")); await tick()
  assert.equal(controller.views[0]?.status, "complete")
  assert.equal(controller.views[0]?.assessment?.safe, true)
  await controller.dispose()
})

test("resolution aborts work, removes panel and suppresses a late noncooperative result", async () => {
  let resolve!: (value: Assessment) => void
  let signal!: AbortSignal
  let published: View[] = []
  const controller = new Controller((_, s) => { signal = s; return new Promise((r) => { resolve = r }) }, (views) => { published = views })
  controller.asked(request("a"))
  await tick()
  controller.replied("a")
  assert.ok(signal.aborted)
  assert.deepEqual(published, [])
  resolve(result)
  await tick()
  assert.deepEqual(published, [])
  controller.dispose()
})

test("stale startup snapshot cannot resurrect a resolved permission", () => {
  const controller = new Controller(async () => result, () => {})
  const revision = controller.revision
  controller.replied("a")
  controller.reconcile([request("a")], revision)
  assert.equal(controller.views.length, 0)
  controller.reconcile([request("b")], controller.revision)
  assert.equal(controller.views[0]?.request.id, "b")
  controller.reconcile([], controller.revision)
  assert.deepEqual(controller.views, [])
  controller.dispose()
})

test("unknown-session deletion invalidates an in-flight startup snapshot", async () => {
  const evaluated: string[] = []
  const controller = new Controller(async (req) => { evaluated.push(req.id); return result }, () => {})
  const revision = controller.revision
  controller.deleted("deleted")
  assert.ok(controller.revision > revision)
  controller.reconcile([request("stale", "deleted")], revision)
  await tick()
  assert.equal(controller.views.length, 0)
  assert.deepEqual(evaluated, [])
  controller.reconcile([request("fresh")], controller.revision)
  await tick()
  assert.deepEqual(evaluated, ["fresh"])
  assert.equal(controller.views[0]?.assessment, result)
  controller.dispose()
})

test("deletion cancels every matching request and ignores late callbacks without disturbing another session", async () => {
  const pending = new Map<string, { signal: AbortSignal; onIdentified: () => void; resolve: (value: Assessment) => void; reject: (error: Error) => void }>()
  let publications = 0
  const controller = new Controller((req, signal, onIdentified) => new Promise((resolve, reject) => {
    pending.set(req.id, { signal, onIdentified, resolve, reject })
  }), () => { publications++ })
  const directory = request("directory", "deleted", "external_directory")
  const execution = { ...request("execute", "deleted"), tool: directory.tool }
  controller.asked(directory); controller.asked(execution); controller.asked(request("survivor"))
  await tick()
  const revision = controller.revision
  controller.deleted("deleted")
  assert.ok(controller.revision > revision)
  assert.ok(pending.get("directory")!.signal.aborted)
  assert.ok(pending.get("execute")!.signal.aborted)
  assert.equal(pending.get("survivor")!.signal.aborted, false)
  const before = publications
  controller.reconcile([directory, execution, request("survivor")], revision)
  pending.get("directory")!.onIdentified()
  pending.get("execute")!.onIdentified()
  pending.get("directory")!.resolve(result)
  pending.get("execute")!.reject(new Error("Late failure"))
  await tick()
  assert.equal(publications, before)
  assert.deepEqual(controller.views.map((view) => view.request.id), ["survivor"])
  pending.get("survivor")!.resolve(result)
  await tick()
  assert.equal(visibleReview(controller.views, "root", getSession)?.assessment, result)
  controller.dispose()
})

for (const removal of ["reply", "dispose"] as const) {
  test(`${removal} suppresses late identification, result and error callbacks`, async () => {
    const pending: { signal: AbortSignal; onIdentified: () => void; resolve: (value: Assessment) => void; reject: (error: Error) => void }[] = []
    let publications = 0
    const controller = new Controller((_, signal, onIdentified) => new Promise((resolve, reject) => {
      pending.push({ signal, onIdentified, resolve, reject })
    }), () => { publications++ })
    controller.asked(request("a", "root", "external_directory")); controller.asked(request("b"))
    await tick()
    if (removal === "reply") { controller.replied("a"); controller.replied("b") }
    else controller.dispose()
    const before = publications
    for (const entry of pending) {
      assert.ok(entry.signal.aborted)
      entry.onIdentified()
    }
    pending[0]!.resolve(result)
    pending[1]!.reject(new Error("Late failure"))
    await tick()
    assert.equal(publications, before)
    assert.deepEqual(controller.views, [])
    controller.dispose()
  })
}

for (const failure of ["missing message", "reader error", "timeout"] as const) {
  test(`pre-identification ${failure} stays hidden for every unverified origin and blocks later reviews`, { timeout: 2000 }, async (t) => {
    const reader = contextReader(async () => {
      if (failure === "missing message") return undefined
      if (failure === "reader error") throw new Error("Context unavailable")
      return new Promise(() => {})
    })
    const callbacks: (() => void)[] = []
    let finished!: () => void
    const failed = new Promise<void>((resolve) => { finished = resolve })
    let publications = 0
    const controller = new Controller((req, parent, onIdentified) => {
      if (req.id === "c-later") return Promise.resolve(result)
      callbacks.push(onIdentified)
      return withDeadline(parent, failure === "timeout" ? 10 : 1000, async (signal) => {
        const evidence = await evaluateEvidence(req, reader, config, config, "", signal, onIdentified, new FileAccess())
        return evidence ? result : null
      })
    }, (views) => {
      publications++
      if (views.filter((view) => view.error).length === 2) finished()
    })
    t.after(() => controller.dispose())
    controller.asked({ ...request("a-directory", "root", "external_directory"), metadata: { command: "unverified metadata command" } })
    controller.asked(request("b-bash"))
    controller.asked(request("c-later"))
    await failed
    const expected = failure === "timeout" ? "Permission context lookup timed out"
      : failure === "reader error" ? "Context unavailable" : "Pending tool message unavailable or mismatched"
    assert.equal(controller.views[0]?.error, expected)
    assert.equal(controller.views[0]?.assessment, undefined)
    assert.equal(controller.views[2]?.status, "complete")
    assert.equal(visibleReview(controller.views, "root", getSession), undefined)
    const before = publications
    for (const onIdentified of callbacks) onIdentified()
    assert.equal(publications, before)
    assert.equal(visibleReview(controller.views, "root", getSession), undefined)
    controller.replied("a-directory")
    const visible = visibleReview(controller.views, "root", getSession)
    assert.equal(visible, undefined)
    assert.equal(controller.views[0]?.status, "unidentified")
    assert.equal(controller.views[0]?.error, expected)
    controller.replied("b-bash")
    assert.equal(visibleReview(controller.views, "root", getSession)?.request.id, "c-later")
  })
}

test("context-identified directory review failures remain visible without a rating", { timeout: 2000 }, async (t) => {
  let finished!: () => void
  const failed = new Promise<void>((resolve) => { finished = resolve })
  const controller = new Controller(async (req, signal, onIdentified) => {
    const evidence = await evaluateEvidence(req, contextReader(shellMessage), config, config, "", signal, onIdentified, new FileAccess())
    assert.equal(evidence?.kind, "external-directory")
    assert.ok(evidence && !("files" in evidence))
    throw new Error("Reviewer HTTP 503")
  }, (views) => { if (views[0]?.error) finished() })
  t.after(() => controller.dispose())
  controller.asked(request("directory", "root", "external_directory"))
  await failed
  const visible = visibleReview(controller.views, "root", getSession)
  assert.equal(visible?.request.permission, "external_directory")
  assert.equal(visible?.status, "unavailable")
  assert.equal(visible?.error, "Reviewer HTTP 503")
  assert.equal(visible?.assessment, undefined)
})

test("errors are visible without a rating; unrelated requests are never evaluated", async () => {
  let calls = 0
  const controller = new Controller(async (_, __, identified) => { calls++; identified(); throw new Error("Reviewer HTTP 503") }, () => {})
  controller.asked(request("a", "root", "read"))
  controller.asked(request("b"))
  controller.asked(request("c", "root", "edit"))
  await tick()
  assert.equal(calls, 2)
  assert.equal(controller.views[1]?.status, "unavailable")
  assert.equal(controller.views[1]?.assessment, undefined)
  assert.equal(controller.views[2]?.status, "unavailable")
  assert.equal(controller.views[2]?.assessment, undefined)
  controller.dispose()
})

test("display follows root/direct-child approval order and hides unrelated sessions", async () => {
  const controller = new Controller(async () => result, () => {})
  const sessions = new Map([ ["root", { id: "root" }], ["sub", { id: "sub", parentID: "root" }], ["other", { id: "other" }] ])
  const get = (id: string) => sessions.get(id)
  controller.asked(request("sub-request", "sub"))
  controller.asked(request("other-request", "other"))
  await tick()
  assert.equal(visibleReview(controller.views, "root", get)?.request.id, "sub-request")
  assert.equal(visibleReview(controller.views, "sub", get)?.request.id, "sub-request")
  assert.equal(visibleReview(controller.views, undefined, get), undefined)
  controller.asked(request("root-request", "root", "read"))
  assert.equal(visibleReview(controller.views, "root", get), undefined)
  assert.equal(visibleReview(controller.views, "sub", get), undefined, "child navigation cannot bypass the root queue blocker")
  controller.dispose()
})

for (const scope of ["root", "child"] as const) {
  test(`mixed-case request IDs use native code-unit order in the ${scope} session`, () => {
    const get = (id: string) => ({ id, parentID: id === "child" ? "root" : undefined })
    const views: View[] = ["per_a", "per_B", "per_A"].map((id) => ({ request: request(id, scope), status: "complete", assessment: result }))
    for (const order of [views, views.toReversed(), [views[1]!, views[0]!, views[2]!]]) {
      let pending = [...order]
      for (const expected of ["per_A", "per_B", "per_a"]) {
        const before = [...pending]
        const visible = visibleReview(pending, "root", get)
        assert.equal(visible?.request.id, expected)
        assert.deepEqual(pending, before, "selection must not reorder the supplied views")
        pending = pending.filter((view) => view !== visible)
      }
      assert.equal(visibleReview(pending, "root", get), undefined)
    }
  })
}

test("mixed-case session IDs take precedence over request IDs within root/direct-child scope", () => {
  const sessions = new Map([
    ["ses_a", { id: "ses_a" }],
    ["ses_A", { id: "ses_A", parentID: "ses_a" }],
    ["ses_B", { id: "ses_B", parentID: "ses_a" }],
    ["ses_0", { id: "ses_0" }],
    ["ses_1", { id: "ses_1", parentID: "ses_A" }],
  ])
  const get = (id: string) => sessions.get(id)
  const views: View[] = [
    request("per_A", "ses_a"), request("per_B", "ses_B"), request("per_z", "ses_A"),
    request("per_0", "ses_0", "read"), request("per_1", "ses_1", "read"), request("per_2", "ses_2", "read"),
  ].map((req) => ({ request: req, status: req.permission === "read" ? "unrelated" : "complete", assessment: req.permission === "bash" ? result : undefined }))
  for (const order of [views, views.toReversed()]) {
    let pending = [...order]
    for (const expected of ["per_z", "per_B", "per_A"]) {
      const visible = visibleReview(pending, "ses_a", get)
      assert.equal(visible?.request.id, expected)
      pending = pending.filter((view) => view !== visible)
    }
    assert.equal(visibleReview(pending, "ses_a", get), undefined)
  }
  for (const route of ["ses_A", "ses_B"]) {
    assert.equal(visibleReview(views, route, get)?.request.id, "per_z", "sibling routes retain root queue priority")
  }
  for (const route of ["ses_1", "missing", undefined]) {
    assert.equal(visibleReview(views, route, get), undefined)
  }
})

for (const scope of ["root request", "child request", "root session", "child session"] as const) {
  test(`native-first mixed-case ${scope} blockers suppress later assessments`, () => {
    const root = scope === "child session" ? "ses_a" : "ses_A"
    const child = scope === "child session" ? "ses_A" : "ses_a"
    const sessions = new Map([[root, { id: root }], [child, { id: child, parentID: root }]])
    const get = (id: string) => sessions.get(id)
    const bySession = scope.endsWith("session")
    const firstSession = scope.startsWith("root") ? root : child
    const laterSession = bySession ? scope.startsWith("root") ? child : root : firstSession
    const later: View = { request: request(bySession ? "per_A" : "per_a", laterSession), status: "complete", assessment: result }
    for (const status of ["unrelated", "identifying", "unidentified"] as const) {
      const blocker: View = {
        request: request(bySession ? "per_z" : "per_A", firstSession, status === "unrelated" ? "read" : "external_directory"),
        status,
      }
      for (const order of [[later, blocker], [blocker, later]]) {
        assert.equal(visibleReview(order, root, get), undefined, `${status} must block the later assessment`)
      }
      assert.equal(visibleReview([later], root, get), later, "removing the blocker reveals the later assessment")
      assert.equal(visibleReview([{ ...blocker, status: "analyzing" }, later], root, get)?.request.id, blocker.request.id)
    }
  })
}

test("equal session/request keys preserve the first input view", () => {
  const first: View = { request: request("per_A"), status: "complete", assessment: result }
  const second: View = { ...first, status: "unrelated", assessment: undefined }
  assert.equal(visibleReview([first, second], "root", getSession), first)
  assert.equal(visibleReview([second, first], "root", getSession), undefined)
})

test("session deletion and disposal cancel and release pending reviews", async () => {
  const signals: AbortSignal[] = []
  let publications = 0
  const controller = new Controller((_, signal) => { signals.push(signal); return new Promise(() => {}) }, () => { publications++ })
  controller.asked(request("a")); controller.asked(request("b", "child"))
  await tick()
  controller.deleted("child")
  assert.ok(signals[1]!.aborted)
  controller.dispose()
  assert.ok(signals[0]!.aborted)
  const before = publications
  controller.asked(request("c"))
  assert.equal(publications, before)
  assert.deepEqual(controller.views, [])
})

test("terminal control sequences and bidi text cannot manipulate displayed ratings", () => {
  assert.equal(displayText("x\x1b[2J\r\u202ey"), "x\\u001b[2J\\u000d\\u202ey")
  assert.equal(displayText("first\nsecond\tthird"), "first\nsecond\tthird")
  assert.equal(displayText("**Effects**\n- `\x1b[2J`\n- *\u202eRisk*"), "**Effects**\n- `\\u001b[2J`\n- *\\u202eRisk*")
})

test("directory identification reveals analysis before completion and late identification cannot reopen it", async (t) => {
  let identify!: () => void
  let complete!: (value: Assessment) => void
  let publications = 0
  const controller = new Controller((_req, _signal, onIdentified) => {
    identify = onIdentified
    return new Promise((resolve) => { complete = resolve })
  }, () => { publications++ })
  t.after(() => controller.dispose())
  controller.asked(request("directory", "root", "external_directory"))
  assert.equal(controller.views[0]?.status, "identifying")
  assert.equal(visibleReview(controller.views, "root", getSession), undefined)
  await tick()
  identify()
  const analyzing = visibleReview(controller.views, "root", getSession)
  assert.equal(analyzing?.request.id, "directory")
  assert.equal(analyzing?.request.permission, "external_directory")
  assert.equal(analyzing?.status, "analyzing")
  assert.equal(analyzing?.assessment, undefined)
  complete(result)
  await tick()
  const completed = visibleReview(controller.views, "root", getSession)
  assert.equal(completed?.status, "complete")
  assert.equal(completed?.assessment, result)
  const before = publications
  identify()
  assert.equal(publications, before)
  assert.equal(visibleReview(controller.views, "root", getSession), completed)
})

test("a null evaluator result stays hidden and directory/execution stages deduplicate independently", async () => {
  const evaluated: string[] = []
  // This is a deterministic lifecycle seam, not a claim that directory reads are unsupported.
  const controller = new Controller(async (req) => { evaluated.push(req.id); return req.id === "unrelated" ? null : result }, () => {})
  controller.asked(request("unrelated", "root", "external_directory"))
  await tick()
  assert.equal(controller.views[0]?.status, "unrelated")
  controller.replied("unrelated")
  const directory = request("directory", "root", "external_directory")
  const execution = { ...request("execute", "root", "bash"), tool: directory.tool }
  controller.asked(directory)
  await tick()
  controller.replied("directory")
  controller.asked(execution)
  controller.asked(execution)
  await tick()
  assert.deepEqual(evaluated, ["unrelated", "directory", "execute"])
  assert.equal(controller.views[0]?.request.permission, "bash")
  controller.dispose()
})

test("edit reviews deduplicate and share native ordering with shell and unrelated permissions", async (t) => {
  const evaluated: string[] = []
  const controller = new Controller(async (req) => { evaluated.push(req.id); return { safe: true, desc: req.permission } }, () => {})
  t.after(() => controller.dispose())
  const edit = request("a-edit", "root", "edit")
  controller.asked(edit); controller.asked(edit); controller.asked(request("b-shell"))
  await tick()
  assert.deepEqual(evaluated, ["a-edit", "b-shell"])
  assert.equal(visibleReview(controller.views, "root", getSession)?.assessment?.desc, "edit")
  controller.asked(request("0-read", "root", "read"))
  assert.equal(visibleReview(controller.views, "root", getSession), undefined)
  controller.replied("0-read"); controller.replied(edit.id)
  assert.equal(visibleReview(controller.views, "root", getSession)?.assessment?.desc, "bash")
})

for (const removal of ["reply", "delete", "dispose"] as const) {
  test(`edit ${removal} aborts and suppresses late analysis/identification`, async () => {
    let finish!: (assessment: Assessment) => void
    let identify!: () => void
    let signal!: AbortSignal
    const controller = new Controller((_, s, onIdentified) => {
      signal = s; identify = onIdentified
      return new Promise((resolve) => { finish = resolve })
    }, () => {})
    controller.asked(request("edit-request", "root", "edit"))
    await tick()
    if (removal === "reply") controller.replied("edit-request")
    else if (removal === "delete") controller.deleted("root")
    else controller.dispose()
    assert.ok(signal.aborted)
    identify(); finish(result)
    await tick()
    assert.deepEqual(controller.views, [])
    controller.dispose()
  })
}

test("disabled review types never evaluate but still block later native permissions", async (t) => {
  for (const reviewBash of [true, false]) for (const reviewEdits of [true, false]) for (const reviewExternalDirectories of [true, false]) {
    const evaluated: string[] = []
    const controller = new Controller(async (req, _, identified) => {
      evaluated.push(req.id); identified(); return result
    }, () => {}, { reviewOptions: { reviewBash, reviewEdits, reviewExternalDirectories } })
    t.after(() => controller.dispose())
    const requests = [request("0-read", "root", "read"), request("1-directory", "root", "external_directory"), request("2-edit", "root", "edit"), request("3-bash")]
    controller.reconcile(requests, controller.revision)
    await tick()
    assert.deepEqual(evaluated, [ ...(reviewExternalDirectories ? ["1-directory"] : []), ...(reviewEdits ? ["2-edit"] : []), ...(reviewBash ? ["3-bash"] : []) ])
    assert.equal(visibleReview(controller.views, "root", getSession), undefined)
    controller.replied("0-read")
    assert.equal(visibleReview(controller.views, "root", getSession)?.request.id, reviewExternalDirectories ? "1-directory" : undefined)
    controller.replied("1-directory")
    assert.equal(visibleReview(controller.views, "root", getSession)?.request.id, reviewEdits ? "2-edit" : undefined)
    controller.replied("2-edit")
    assert.equal(visibleReview(controller.views, "root", getSession)?.request.id, reviewBash ? "3-bash" : undefined)
    const count = evaluated.length
    controller.reconcile([requests[3]!], controller.revision)
    await tick()
    assert.equal(evaluated.length, count)
  }
})

test("new review categories are opt-in in the production controller defaults", async () => {
  let calls = 0
  const controller = new CoreController(async () => { calls++; return result }, () => {})
  for (const permission of ["external_directory", "fixture_mcp", "custom-allowance", "read"]) controller.asked(request(permission, "root", permission))
  await tick()
  assert.equal(calls, 0)
  assert.ok(controller.views.every((view) => view.status === "unrelated"))
  controller.dispose()
})

test("native-like permission names remain hidden until origin and enablement are identified", async () => {
  let finish!: (value: Assessment | null) => void
  const controller = new CoreController(async () => new Promise((resolve) => { finish = resolve }), () => {})
  controller.asked(request("custom-bash", "root", "bash"))
  assert.equal(controller.views[0]?.status, "identifying")
  assert.equal(visibleReview(controller.views, "root", getSession), undefined)
  await tick()
  finish(null) // Classification discovers a disabled custom-tool permission.
  await tick()
  assert.equal(controller.views[0]?.status, "unrelated")
  assert.equal(visibleReview(controller.views, "root", getSession), undefined)
  controller.dispose()
})

function modeFixture(settings: { session?: (id: string, signal: AbortSignal) => Promise<{ id: string; parentID?: string } | undefined>; read?: () => Promise<boolean> } = {}) {
  return new SessionModes({ read: settings.read ?? (async () => true), write: async () => {}, flush: async () => {} },
    settings.session ?? (async (id) => ({ id, ...(id === "child" ? { parentID: "root" } : id === "grandchild" ? { parentID: "child" } : {}) })))
}

test("disabled root and all descendants skip enrichment while independent roots review", async () => {
  const modes = modeFixture()
  await modes.set("root", false)
  const calls: string[] = []
  const controller = new CoreController(async (req) => { calls.push(req.id); return result }, () => {}, { modes })
  for (const id of ["root", "child", "grandchild", "other"]) controller.asked(request(id, id))
  await tick()
  // The two ancestry slots defer excess roots to ordinary fresh reconciliation.
  // Capacity loss cannot bypass mode loading or turn a snapshot into enrichment.
  assert.deepEqual(calls, [])
  controller.reconcile(["root", "child", "grandchild", "other"].map(id => request(id, id)), controller.revision)
  await tick()
  assert.deepEqual(calls, ["other"])
  assert.ok(controller.views.slice(0, 3).every((view) => view.status === "suspended"))
  const revision = controller.revision
  await modes.set("root", true)
  controller.modeChanged("root")
  controller.reconcile([request("root", "root")], revision)
  await tick()
  assert.deepEqual(calls, ["other"], "enable cannot consume a pre-switch snapshot")
  const fresh = ["root", "child", "grandchild", "other"].map((id) => request(id, id))
  controller.reconcile(fresh, controller.revision)
  await tick()
  controller.reconcile(fresh, controller.revision)
  await tick()
  assert.deepEqual(calls, ["other", "child", "root", "grandchild"], "native front precedes FIFO background work")
  await controller.dispose()
})

test("switch while root lookup is unresolved rechecks root-key state without enriching", async () => {
  let resolve!: (value: { id: string; parentID: string }) => void
  const modes = modeFixture({ session: async (id) => id === "child" ? new Promise((yes) => { resolve = yes }) : { id } })
  let calls = 0
  const controller = new CoreController(async () => { calls++; return result }, () => {}, { modes })
  controller.asked(request("child-request", "child"))
  await tick()
  await modes.set("root", false)
  controller.modeChanged("root")
  resolve({ id: "child", parentID: "root" })
  await tick()
  assert.equal(calls, 0)
  assert.equal(controller.views[0]?.status, "suspended")
  await controller.dispose()
})

test("disable then enable during unresolved ancestry requires a post-switch snapshot", async () => {
  let resolve!: (value: { id: string; parentID: string }) => void
  const modes = modeFixture({ session: async (id) => id === "child" ? new Promise((yes) => { resolve = yes }) : { id } })
  let calls = 0
  const controller = new CoreController(async () => { calls++; return result }, () => {}, { modes })
  controller.asked(request("a", "child"))
  await tick()
  await modes.set("root", false); controller.modeChanged("root")
  await modes.set("root", true); controller.modeChanged("root")
  resolve({ id: "child", parentID: "root" })
  await tick()
  assert.equal(calls, 0)
  controller.reconcile([request("a", "child")], controller.revision)
  await tick()
  assert.equal(calls, 1)
  await controller.dispose()
})

for (const failure of ["ancestry", "store"] as const) test(`${failure} failure cannot enrich or expose a later native review`, async () => {
  let calls = 0
  const modes = modeFixture(failure === "ancestry" ? { session: async () => undefined } : { read: async () => { throw new Error("bad store") } })
  const controller = new CoreController(async () => { calls++; return result }, () => {}, { modes })
  controller.asked(request("a"))
  await tick()
  assert.equal(calls, 0)
  assert.equal(visibleReview([...controller.views, { request: request("z"), status: "complete", assessment: result }], "root", getSession), undefined)
  await controller.dispose()
})

for (const enabled of [true, false]) test(`unavailable saved mode recovers to ${enabled ? "enabled" : "disabled"} only through current reconciliation`, async () => {
  let available = false, reads = 0, calls = 0
  const modes = modeFixture({ read: async () => {
    reads++
    if (!available) throw new Error("unavailable record")
    return enabled
  } })
  const controller = new CoreController(async () => { calls++; return result }, () => {}, { modes })
  controller.asked(request("a"))
  await tick()
  assert.equal(controller.views[0]?.status, "suspended")
  assert.equal(reads, 1)
  assert.equal(calls, 0)
  assert.equal(visibleReview([...controller.views, { request: request("z"), status: "complete", assessment: result }], "root", getSession), undefined)

  const stale = controller.revision
  controller.replied("unknown")
  available = true
  controller.reconcile([request("a")], stale)
  await tick()
  assert.equal(reads, 1, "a stale snapshot cannot retry loading")
  assert.equal(calls, 0)
  controller.reconcile([request("a")], controller.revision)
  await tick()
  assert.equal(reads, 2)
  assert.equal(calls, enabled ? 1 : 0)
  assert.equal(controller.views[0]?.status, enabled ? "complete" : "suspended")
  assert.equal(modes.enabled("root"), enabled)
  for (let i = 0; i < 3; i++) controller.reconcile([request("a")], controller.revision)
  await tick()
  assert.equal(reads, 2, "a loaded disabled choice is not an unavailable read")
  assert.equal(calls, enabled ? 1 : 0)
  await controller.dispose()
})

test("repeated unavailable mode reads remain hidden and a local disable stops recovery attempts", async () => {
  let reads = 0, calls = 0
  const modes = modeFixture({ read: async () => { reads++; throw new Error("unavailable record") } })
  const controller = new CoreController(async () => { calls++; return result }, () => {}, { modes })
  controller.asked(request("a"))
  await tick()
  for (let i = 0; i < 3; i++) {
    controller.reconcile([request("a")], controller.revision)
    await tick()
    assert.equal(controller.views[0]?.status, "suspended")
    assert.equal(visibleReview([...controller.views, { request: request("z"), status: "complete", assessment: result }], "root", getSession), undefined)
  }
  assert.equal(reads, 4)
  assert.equal(calls, 0)
  await modes.set("root", false)
  controller.modeChanged("root")
  controller.reconcile([request("a")], controller.revision)
  await tick()
  assert.equal(reads, 4)
  assert.equal(calls, 0)
  await controller.dispose()
})

test("expired saved-mode loading recovers and its late result cannot replace the recovered setting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let finish!: (value: boolean) => void
  let expired!: AbortSignal
  let reads = 0, calls = 0
  const modes = new SessionModes({
    read: (_, signal) => ++reads === 1 ? new Promise<boolean>((resolve) => { finish = resolve; expired = signal }) : Promise.resolve(true),
    write: async () => {}, flush: async () => {},
  }, async (id) => ({ id }))
  const controller = new CoreController(async () => { calls++; return result }, () => {}, { modes })
  controller.asked(request("a"))
  await settle()
  t.mock.timers.tick(5000)
  await settle()
  assert.ok(expired.aborted)
  assert.equal(controller.views[0]?.status, "suspended")
  controller.reconcile([request("a")], controller.revision)
  await settle()
  assert.equal(reads, 1, "expired reads keep ownership until actual settlement")
  assert.equal(calls, 0)
  finish(false)
  await settle()
  assert.equal(modes.enabled("root"), false, "expired values cannot populate the cache")
  controller.reconcile([request("a")], controller.revision)
  await settle()
  assert.equal(reads, 2)
  assert.equal(calls, 1)
  assert.equal(controller.views[0]?.assessment, result)
  assert.equal(modes.enabled("root"), true)
  assert.equal(controller.views[0]?.assessment, result)
  await controller.dispose()
})

for (const outcome of ["resolve", "reject"] as const) test(`many reconciliation deadlines cap stalled mode reads across roots and recover after late ${outcome} cleanup`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending: { root: string; signal: AbortSignal; value: { resolve: (value: boolean) => void; reject: (error: Error) => void }; cleanup: () => void }[] = []
  const readCalls = new Map<string, number>(), perRoot = new Map<string, number>()
  const evaluated: string[] = []
  let available = false, actual = 0, maximum = 0, maximumPerRoot = 0
  const modes = new SessionModes({ read: async (root, signal) => {
    readCalls.set(root, (readCalls.get(root) ?? 0) + 1)
    actual++
    maximum = Math.max(maximum, actual)
    perRoot.set(root, (perRoot.get(root) ?? 0) + 1)
    maximumPerRoot = Math.max(maximumPerRoot, perRoot.get(root)!)
    const settled = () => { actual--; perRoot.set(root, perRoot.get(root)! - 1) }
    if (available) { settled(); return true }
    let resolve!: (value: boolean) => void, reject!: (error: Error) => void, cleanup!: () => void
    const value = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
    const closing = new Promise<void>((yes) => { cleanup = yes })
    pending.push({ root, signal, value: { resolve, reject }, cleanup })
    try { return await value }
    finally { try { await closing } finally { settled() } }
  }, write: async () => {}, flush: async () => {} }, async (id) => ({ id }))
  const controller = new CoreController(async (req) => { evaluated.push(req.id); return result }, () => {}, { modes })
  t.after(async () => {
    await controller.dispose()
    for (const read of pending) { read.value.resolve(false); read.cleanup() }
    await settle()
    assert.equal(actual, 0)
    assert.ok(maximum <= 2)
    assert.ok(maximumPerRoot <= 1)
  })
  const requests = [request("a-first", "rootA"), request("a-second", "rootA"), request("b-first", "rootB"),
    request("c-disabled", "rootC"), ...["D", "E", "F", "G", "H"].map((id) => request(`other-${id}`, `root${id}`))]
  controller.reconcile(requests, controller.revision)
  await settle()
  assert.deepEqual(pending.map((read) => read.root), ["rootA", "rootB"])
  for (let cycle = 0; cycle < 40; cycle++) {
    controller.reconcile(requests, controller.revision)
    await settle()
    t.mock.timers.tick(5000)
    await settle()
    assert.equal(actual, 2)
    assert.equal(pending.length, 2, "repeated current snapshots cannot accumulate unresolved filesystem reads")
    assert.ok(controller.views.every((view) => view.status === "suspended"))
    assert.equal(visibleReview(controller.views, "rootA", getSession), undefined)
    assert.deepEqual(evaluated, [])
  }
  assert.ok(pending.every((read) => read.signal.aborted))
  await modes.set("rootC", false)
  controller.modeChanged("rootC")
  for (let cycle = 0; cycle < 20; cycle++) {
    controller.reconcile(requests, controller.revision)
    await settle()
    t.mock.timers.tick(5000)
    await settle()
    assert.equal(pending.length, 2)
    assert.equal(actual, 2)
  }
  if (outcome === "resolve") pending[0]!.value.resolve(true)
  else pending[0]!.value.reject(new Error("late store failure"))
  await settle()
  for (let cycle = 0; cycle < 5; cycle++) {
    controller.reconcile(requests, controller.revision)
    await settle()
    t.mock.timers.tick(5000)
    await settle()
    assert.equal(pending.length, 2, "late I/O settlement still owns capacity through actual cleanup")
    assert.equal(actual, 2)
  }
  pending[0]!.cleanup()
  await settle()
  assert.equal(actual, 1)
  assert.equal(modes.enabled("rootA"), false)
  controller.reconcile(requests, controller.revision)
  await settle()
  assert.equal(pending.length, 3)
  assert.equal(pending[2]!.root, "rootA")
  assert.equal(actual, 2)
  available = true
  pending[2]!.value.resolve(true)
  pending[2]!.cleanup()
  await settle()
  assert.deepEqual(evaluated.toSorted(), ["a-first", "a-second"])
  assert.equal(visibleReview(controller.views, "rootA", getSession)?.request.id, "a-first")
  for (let cycle = 0; cycle < 12; cycle++) {
    controller.reconcile(requests, controller.revision)
    await settle()
    assert.equal(actual, 1, "the other expired read remains the only unsettled transaction")
  }
  assert.equal(readCalls.get("rootC"), undefined, "a known disabled choice never reads, even at saturation")
  assert.equal(controller.views.find((view) => view.request.id === "c-disabled")?.status, "suspended")
  assert.equal(controller.views.find((view) => view.request.id === "b-first")?.status, "suspended")
  pending[1]!.value.resolve(true)
  pending[1]!.cleanup()
  await settle()
  assert.equal(modes.enabled("rootB"), false)
  controller.reconcile(requests, controller.revision)
  await settle()
  assert.deepEqual(evaluated.toSorted(), requests.filter((req) => req.id !== "c-disabled").map((req) => req.id).toSorted())
  assert.equal(readCalls.get("rootA"), 2)
  assert.equal(readCalls.get("rootB"), 2)
  assert.equal(actual, 0)
  assert.equal(maximum, 2)
  assert.equal(maximumPerRoot, 1)
})

test("unavailable ancestry retries on reconciliation without restarting a natively resolved request", async () => {
  let available = false, calls = 0
  const modes = modeFixture({ session: async (id) => available ? { id } : undefined })
  const controller = new CoreController(async () => { calls++; return result }, () => {}, { modes })
  controller.asked(request("a"))
  controller.asked(request("b", "other"))
  await tick()
  const stale = controller.revision
  controller.replied("a")
  available = true
  controller.reconcile([request("a"), request("b", "other")], stale)
  await tick()
  assert.deepEqual(controller.views.map((view) => view.request.id), ["b"])
  assert.equal(calls, 0)
  controller.reconcile([request("b", "other")], controller.revision)
  await tick()
  assert.equal(calls, 1)
  assert.equal(controller.views[0]?.assessment, result)
  await controller.dispose()
})

for (const outcome of ["result", "error"] as const) test(`disabled generation suppresses late identification and ${outcome} after fresh enable`, async () => {
  const modes = modeFixture()
  const pending: { identify: () => void; resolve: (value: Assessment) => void; reject: (error: Error) => void; signal: AbortSignal }[] = []
  const controller = new CoreController((_, signal, identify) => new Promise((resolve, reject) => { pending.push({ signal, identify, resolve, reject }) }),
    () => {}, { modes })
  controller.asked(request("a"))
  await tick()
  await modes.set("root", false); controller.modeChanged("root")
  assert.ok(pending[0]!.signal.aborted)
  await modes.set("root", true); controller.modeChanged("root")
  controller.reconcile([request("a")], controller.revision)
  await tick()
  pending[0]!.identify()
  if (outcome === "result") pending[0]!.resolve({ safe: false, desc: "obsolete" })
  else pending[0]!.reject(new Error("obsolete failure"))
  await tick()
  assert.equal(controller.views[0]?.assessment, undefined)
  pending[1]!.resolve(result)
  await tick()
  assert.equal(controller.views[0]?.assessment, result)
  await controller.dispose()
})

for (const stage of ["countdown", "checking", "failed", "allowing"] as const) test(`${stage} tombstone survives mode unavailability and fresh review and prevents another approval`, async () => {
  const modes = modeFixture()
  let unavailable = false
  const gate = {
    root: (id: string, signal: AbortSignal) => modes.root(id, signal),
    load: (root: string, signal: AbortSignal) => unavailable ? Promise.reject(new Error("mode unavailable")) : modes.load(root, signal),
    enabled: (root: string) => modes.enabled(root),
  }
  let reads = 0, writes = 0
  let resolve!: (value: PermissionRequest[]) => void
  let finish!: () => void
  const controller = new CoreController(async () => result, () => {}, { reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true }, approval: {
    visibleID: () => "a",
    list: () => {
      reads++
      if (stage === "checking" && reads === 1) return new Promise((yes) => { resolve = yes })
      return Promise.resolve([request("a")])
    },
    once: () => {
      writes++
      if (stage === "failed") return Promise.reject(new Error("uncertain invoked write"))
      return new Promise((yes) => { finish = yes })
    },
  }, modes: gate })
  controller.asked(request("a"))
  await tick()
  controller.presented("a")
  const approval = stage === "countdown" ? Promise.resolve() : controller.approveNow("a")
  await tick()
  assert.equal(controller.views[0]?.autoApproval?.status, stage)
  await modes.set("root", false); controller.modeChanged("root")
  await modes.set("root", true); controller.modeChanged("root")
  unavailable = true
  controller.reconcile([request("a")], controller.revision)
  await tick()
  assert.equal(controller.views[0]?.status, "suspended")
  unavailable = false
  controller.reconcile([request("a")], controller.revision)
  await tick()
  controller.presented("a")
  await controller.approveNow("a")
  assert.equal(writes, ["failed", "allowing"].includes(stage) ? 1 : 0)
  assert.equal(controller.views[0]?.autoApproval?.status, ["failed", "allowing"].includes(stage) ? "failed" : "cancelled")
  resolve?.([request("a")]); finish?.()
  await approval
  controller.replied("a")
  controller.asked(request("a"))
  await tick()
  assert.equal(controller.views[0]?.autoApproval, undefined, "native resolution clears the tombstone")
  await controller.dispose()
})

test("disposal aborts and drains removed review finalizers before caller flush", async () => {
  let finish!: () => void
  const events: string[] = []
  const controller = new CoreController(async (_, signal) => {
    try { await new Promise<void>((yes) => { finish = yes }); return result }
    finally { assert.ok(signal.aborted); events.push("usage-finalized") }
  }, () => {})
  controller.asked(request("a"))
  await tick()
  controller.replied("a")
  const disposal = controller.dispose().then(() => { events.push("flush") })
  await tick()
  assert.deepEqual(events, [])
  finish()
  await disposal
  assert.deepEqual(events, ["usage-finalized", "flush"])
})
