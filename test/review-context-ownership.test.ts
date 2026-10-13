import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { Controller } from "../src/controller.js"
import { ownedReview } from "../src/review-admission.js"
import { evaluateHostReview } from "../src/host-evaluate.js"
import { FileAccess } from "../src/file-access.js"
import { parseConfig } from "../src/config.js"
import { review } from "../src/reviewer.js"
import { withDeadline } from "../src/deadline.js"
import { BUILTIN_PROMPTS } from "../src/prompts.js"
import { nativeClient, nativeInvocation, shellEvidence } from "./review-fixtures.js"
import { snapshotRequest } from "../src/host-request.js"

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

for (const held of ["session", "history"] as const) for (const success of [true, false]) {
  test(`native evidence retains ${held} after its context deadline through ${success ? "successful" : "failed"} late settlement`, async t => {
    const tick = clock(t)
    const operations: ReturnType<typeof deferred<void>>[] = [], signals: AbortSignal[] = []
    let active = 0, maximum = 0, posts = 0
    const hold = (signal: AbortSignal) => {
      const operation = deferred<void>()
      operations.push(operation); signals.push(signal)
      maximum = Math.max(maximum, ++active)
      return operation.promise.finally(() => { active-- })
    }
    const files = new FileAccess()
    const controller = new Controller((request, parent, identify) => {
      const owned = nativeInvocation("shell", { command: "pwd" })
      const { source, ...rest } = request
      owned.snapshot = snapshotRequest({ ...rest, source: { type: "tool", messageID: source!.assistantID, id: source!.id } }, owned.snapshot.scope)!
      const client = nativeClient(owned, files)
      const get = client.session.get
      const list = client.message.list
      if (held === "session") client.session.get = async (input, options) => {
        await hold(options!.signal!)
        return get(input, options)
      }
      else client.message.list = async (input, options) => {
        await hold(options!.signal!)
        return list(input, options)
      }
      return evaluateHostReview(client, owned.snapshot, config, BUILTIN_PROMPTS, parent, identify, { fetcher: async () => {
        posts++
        throw Error("Expired mandatory context cannot reach the reviewer")
      } })
    }, () => {}, { candidate: () => true })
    for (let i = 0; i < 12; i++) controller.asked({ ...nativeInvocation("shell", { command: "pwd" }).snapshot.request,
      id: `p${String(i).padStart(2, "0")}` })
    try {
      await turn()
      assert.equal(operations.length, 4)
      await tick(4000)
      assert.equal(posts, 0, "mandatory native context expiry blocks model dispatch")
      assert.equal(controller.views.filter(view => view.status === "unidentified").length, 4)
      assert.equal(signals.slice(0, 4).every(signal => signal.aborted), true)
      assert.equal(operations.length, 4, `context deadline must not release admission while ${held} is physically pending`)
      assert.equal(maximum, 4)
      if (success) operations[0]!.resolve()
      else operations[0]!.reject(Error("late private client failure"))
      await turn()
      assert.equal(operations.length, 5, "one physical completion admits exactly one waiting evaluation")
      assert.equal(active, 4)
      assert.equal(posts, 0)
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
    async bounded => review(shellEvidence(), config, bounded, { fetcher: () => fetch.promise })))
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
