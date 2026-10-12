import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2"
import { Controller } from "../src/controller.js"
import { ownedReview } from "../src/review-admission.js"
import { evaluateEvidence } from "../src/evaluate.js"
import type { ContextReader } from "../src/context.js"
import { FileAccess } from "../src/file-access.js"
import { parseConfig } from "../src/config.js"
import { review } from "../src/reviewer.js"
import { withDeadline } from "../src/deadline.js"

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function clock(t: TestContext) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  return async (ms: number) => { now += ms; t.mock.timers.tick(ms); await turn() }
}
const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", timeoutMs: 12000 })
const session = (id: string, parentID?: string): Session => ({ id, parentID, directory: "/fixture", slug: id,
  projectID: "project", title: id, version: "1", time: { created: 1, updated: 1 } })
const good = JSON.stringify({ choices: [{ message: { content: '{"safe":true,"desc":"Bounded."}' } }] })

for (const held of ["projects", "session", "delegation"] as const) for (const success of [true, false]) {
  test(`production evidence retains ${held} after its internal context deadline and ${success ? "successful" : "failed"} review`, async t => {
    const tick = clock(t)
    const operations: ReturnType<typeof deferred<void>>[] = [], signals: AbortSignal[] = []
    let active = 0, maximum = 0, posts = 0
    const hold = (signal: AbortSignal) => {
      const operation = deferred<void>()
      operations.push(operation); signals.push(signal)
      maximum = Math.max(maximum, ++active)
      return operation.promise.finally(() => { active-- })
    }
    const reader: ContextReader = {
      toolIDs: async () => ["bash"],
      session: async (id, signal) => {
        if (held === "session") await hold(signal)
        return session(id, held === "delegation" && id === "child" ? "root" : undefined)
      },
      // When ancestry branches run in parallel, the cooperative root-history
      // branch ends at cancellation while the delegation branch still owns I/O.
      messages: async (_id, signal) => held === "delegation" ? new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }) : [],
      message: async (sessionID, messageID, signal) => {
        if (messageID === "user") { await hold(signal); return undefined }
        const info: AssistantMessage = { id: messageID, sessionID, role: "assistant", parentID: "user", time: { created: 2 },
          providerID: "fixture", modelID: "fixture", mode: "build", agent: "build", path: { cwd: "", root: "" },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
        return { info, parts: [{ id: "part", messageID, sessionID, type: "tool", callID: "call", tool: "bash",
          state: { status: "running", input: { command: "pwd" }, time: { start: 1 } } }] }
      },
      projects: async signal => { if (held === "projects") await hold(signal); return [] },
    }
    const files = new FileAccess()
    const controller = new Controller((request, parent, identify) => ownedReview(parent, config.timeoutMs, async signal => {
      const evidence = await evaluateEvidence(request, reader, config, config, "", signal, identify, files)
      assert.ok(evidence)
      assert.match(evidence.limitations.join(" "), held === "projects" ? /Project context lookup timed out/ : /Conversation context lookup timed out/)
      return review(evidence, config, signal, { fetcher: async () => {
        posts++
        return success ? new Response(good) : new Response(null, { status: 401 })
      } })
    }), () => {})
    for (let i = 0; i < 12; i++) controller.asked({ id: `p${String(i).padStart(2, "0")}`, sessionID: held === "delegation" ? "child" : "root",
      permission: "bash", patterns: ["pwd"], metadata: {}, always: [], tool: { messageID: "tool-message", callID: "call" } })
    try {
      await turn()
      assert.equal(operations.length, 4)
      await tick(4000)
      assert.equal(posts, 4, "optional context expiry does not prevent the visible review result")
      assert.equal(controller.views.filter(view => view.status === (success ? "complete" : "unavailable")).length, 4)
      assert.equal(signals.slice(0, 4).every(signal => signal.aborted), true)
      assert.equal(operations.length, 4, `context deadline must not release admission while ${held} is physically pending`)
      assert.equal(maximum, 4)
      operations[0]!.resolve()
      await turn()
      assert.equal(operations.length, 5, "one physical completion admits exactly one waiting evaluation")
      assert.equal(active, 4)
    } finally {
      const closing = controller.dispose()
      for (const operation of operations) operation.resolve()
      await closing
    }
    assert.equal(active, 0)
  })
}

test("raw nested deadlines inherit transport ownership through late headers and cancellation", async t => {
  const tick = clock(t), fetch = deferred<Response>(), cancel = deferred<void>()
  let canceled = false, settled = false
  const evaluation = ownedReview(new AbortController().signal, 1000, async signal => withDeadline(signal, 20,
    async bounded => review({ kind: "shell", command: "pwd", cwd: null, userPrompt: null, files: [], limitations: [] }, config, bounded,
      { fetcher: () => fetch.promise })))
  const rejected = assert.rejects(evaluation, /timed out/)
  void evaluation.settled!.then(() => { settled = true })
  try {
    await turn()
    await tick(20)
    await rejected
    assert.equal(settled, false)
    fetch.resolve(new Response(new ReadableStream({ cancel() { canceled = true; return cancel.promise } })))
    await turn()
    assert.equal(canceled, true)
    assert.equal(settled, false, "late response disposal remains inside the inherited scope")
  } finally {
    fetch.reject(new Error("cleanup")); cancel.resolve()
    await evaluation.settled
  }
})
