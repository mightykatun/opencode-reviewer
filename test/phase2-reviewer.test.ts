import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import type { HostRequest } from "../src/host-types.js"
import { Controller, type ApprovalFact } from "../src/controller.js"
import { parseConfig } from "../src/config.js"
import { NotificationPolicy } from "../src/notification-policy.js"
import type { NotificationMessage } from "../src/notification-types.js"
import { review } from "../src/reviewer.js"
import type { ReviewAttemptEvent, ReviewProgress, ReviewResult } from "../src/types.js"
import { shellEvidence } from "./review-fixtures.js"

const request: HostRequest = { id: "phase2", sessionID: "root", action: "shell",
  resources: ["python fixture.py"], metadata: { command: "python fixture.py" } }
const evidence = shellEvidence({ command: "python fixture.py", userPrompt: "Read the fixture" })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const frame = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [
  { index: 0, delta: { content }, finish_reason: finish },
] })}\n\n`
const terminal = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n'
const response = (content: string, stream: boolean) => stream
  ? new Response(frame(content, "stop") + terminal, { headers: { "content-type": "text/event-stream" } })
  : Response.json({ choices: [{ index: 0, message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } })

for (const failure of ["transport", "format", "transport+format"] as const) {
  for (const ordering of ["before", "after"] as const) {
    test(`source reviewer SSE ${failure}: replacement Safe ${ordering} held GET settlement`, async t => {
      const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", autoApprove: true,
        fastMode: true, stream: true, staleReminderSeconds: 0 })
      const oldRead = deferred<HostRequest[]>(), replacement = deferred<Response>(), nextPOST = deferred<void>()
      const facts: ApprovalFact[] = [], messages: NotificationMessage[] = [], bodies: string[] = []
      const progress: ReviewProgress[] = [], attempts: ReviewAttemptEvent[] = []
      const target = { root: "root", sessionID: "root", title: "Fixture" }
      const policy = new NotificationPolicy(config, true, {
        async show(message) { messages.push(message); return { close() {} } }, dispose() {},
      })
      let first!: ReadableStreamDefaultController<Uint8Array>, reads = 0, writes = 0
      let hadReservation = false, clearedRating = false
      let reviewing!: Promise<ReviewResult>
      const prefix = '{"safe":true,"desc":"Rejected preview"'
      const invalid = prefix + ',"safe":false}'
      const controller = new Controller((_req, signal, identified, onProgress) => {
        identified()
        reviewing = review(evidence, config, signal, {
          fetcher: async (_url, init) => {
            bodies.push(init!.body as string)
            if (bodies.length === 1) return new Response(new ReadableStream({ start(writer) { first = writer } }),
              { headers: { "content-type": "text/event-stream" } })
            if (failure === "transport+format" && bodies.length === 2) return response(invalid, true)
            nextPOST.resolve(); return replacement.promise
          }, onProgress: value => { progress.push(value); onProgress(value) },
          observation: { review: "phase2", observe: value => { attempts.push(value) } },
        })
        return reviewing
      }, views => {
        policy.snapshot(views, new Map([["root", { kind: "permission", id: request.id }]]))
        const view = views[0]
        if (view?.autoApproval?.status === "checking") hadReservation = true
        if (hadReservation && !clearedRating && view?.status === "analyzing" && !view.autoApproval) {
          clearedRating = true
        }
      }, {
        candidate: () => true, approvalReady: () => true, nativeFront: () => request.id,
        reviewOptions: config, nativeApproval: {
          list: () => ++reads === 1 ? oldRead.promise : Promise.resolve([structuredClone(request)]),
          once: async (_request, _signal, dispatch) => {
            if (!dispatch()) return { status: "unavailable" }; writes++
            controller.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
            return { status: "submitted" }
          },
        }, onApproval: fact => {
          facts.push(fact)
          if (fact.type === "confirmed") policy.approved(fact.request, target)
        },
      })
      t.after(async () => { await controller.dispose(); await policy.dispose() })
      controller.asked(request); policy.permission(request, target, true)
      await settle(); controller.refreshApprovalEligibility()
      first.enqueue(Buffer.from(frame(prefix))); await settle()
      assert.equal(reads, 1); assert.equal(writes, 0)
      assert.equal(controller.views[0]?.progress?.preview?.safe, true)
      first.enqueue(Buffer.from(failure === "format"
        ? frame(',"safe":false}', "stop") + terminal : frame("", "length") + terminal))
      first.close()
      await nextPOST.promise; await settle()
      assert.ok(progress.some(value => value.phase === "streaming" && !value.preview), "real parser clears the rejected Safe preview")
      assert.equal(controller.views[0]?.progress?.preview, undefined)
      assert.equal(clearedRating, true)
      assert.notEqual(controller.views[0]?.autoApproval?.status, "cancelled", "retry publication is not a hide observation")
      assert.equal(writes, 0)
      if (ordering === "after") {
        oldRead.resolve([request]); await settle()
        assert.equal(reads, 1); assert.equal(writes, 0)
      }
      replacement.resolve(response('{"safe":true,"desc":"Validated replacement"}', true))
      const result = await reviewing; await settle()
      assert.equal(result.desc, "Validated replacement")
      if (ordering === "before") {
        assert.equal(reads, 1); assert.equal(writes, 0, "new Safe cannot reuse the invalidated GET")
        oldRead.resolve([request])
      }
      await settle()
      controller.refreshApprovalEligibility(); await settle()
      assert.equal(reads, 2); assert.equal(writes, 1)
      assert.equal(controller.views.length, 0)
      assert.deepEqual(messages.map(message => message.kind), ["approved"], "no false attention banner or sound")
      assert.deepEqual(facts.map(fact => [fact.type, fact.result]), [
        ["settled", "not-sent"], ["dispatched", undefined], ["confirmed", undefined], ["settled", undefined],
      ])
      const dispatched = attempts.filter(event => event.type === "dispatched")
      assert.deepEqual(dispatched.map(event => event.retry), failure === "transport+format"
        ? ["initial", "transport", "format"] : ["initial", failure])
      assert.equal(attempts.filter(event => event.type === "finalized").length, bodies.length)
      if (failure !== "format") assert.equal(bodies[1], bodies[0], "transport retry is byte-identical")
      if (failure !== "transport") {
        const corrected = JSON.parse(bodies.at(-1)!)
        assert.equal(corrected.messages.length, 4)
        assert.deepEqual(corrected.messages.slice(0, 2), JSON.parse(bodies[0]!).messages)
        assert.deepEqual(corrected.messages[2], { role: "assistant", content: invalid })
        assert.ok(corrected.messages[3].content.length > 0)
      }
      assert.ok(bodies.every(body => JSON.parse(body).max_tokens === config.maxOutputTokens))
      assert.equal(result.usage?.input, bodies.length * 10)
      assert.equal(result.usage?.output, bodies.length * 5)
    })
  }
}

for (const stream of [false, true]) for (const safe of [false, true]) {
  test(`${stream ? "SSE" : "nonstream"} source format correction final ${safe ? "Safe" : "Unsafe"} control`, async t => {
    const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", autoApprove: true,
      fastMode: true, stream, staleReminderSeconds: 0 })
    const nextPOST = deferred<void>(), replacement = deferred<Response>(), held = deferred<HostRequest[]>()
    let reads = 0, writes = 0, posts = 0, reviewing!: Promise<ReviewResult>
    const messages: NotificationMessage[] = []
    const policy = new NotificationPolicy(config, true, {
      async show(message) { messages.push(message); return { close() {} } }, dispose() {},
    })
    const controller = new Controller((_req, signal, identified, onProgress) => {
      identified()
      reviewing = review(evidence, config, signal, { onProgress, fetcher: async () => {
        if (++posts === 1) return response('{"safe":true,"desc":""}', stream)
        nextPOST.resolve(); return replacement.promise
      } })
      return reviewing
    }, views => policy.snapshot(views, new Map([["root", { kind: "permission", id: request.id }]])), {
      candidate: () => true, approvalReady: () => true, nativeFront: () => request.id,
      reviewOptions: config, nativeApproval: {
        list: () => { reads++; return held.promise }, once: async (_request, _signal, dispatch) => {
          if (!dispatch()) return { status: "unavailable" }; writes++
          controller.permissionReplied({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
          return { status: "submitted" }
        } },
    })
    t.after(async () => { await controller.dispose(); await policy.dispose() })
    controller.asked(request)
    policy.permission(request, { root: "root", sessionID: "root", title: "Fixture" }, true)
    controller.refreshApprovalEligibility()
    await nextPOST.promise; await settle()
    assert.equal(writes, 0)
    assert.equal(reads, stream ? 1 : 0, "nonstream never publishes an unvalidated rating")
    held.resolve([request]); await settle()
    assert.equal(writes, 0, "the rejected preview cannot write after its GET")
    replacement.resolve(response(JSON.stringify({ safe, desc: "Final assessment" }), stream))
    await reviewing; await settle(); controller.refreshApprovalEligibility(); await settle()
    assert.equal(posts, 2)
    assert.equal(writes, safe ? 1 : 0)
    assert.equal(reads, (stream ? 1 : 0) + (safe ? 1 : 0))
    assert.deepEqual(messages.map(message => message.kind), safe ? [] : ["unsafe"])
  })
}
