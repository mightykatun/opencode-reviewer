import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { test } from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { setImmediate as settle } from "node:timers/promises"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Controller, type View } from "../src/controller.js"
import { observePresentationOwnership, type PresentationOwnership, type ReviewPresentation } from "../src/review-presentation.js"
import { NotificationPolicy } from "../src/notification-policy.js"
import { parseConfig } from "../src/config.js"
import { review } from "../src/reviewer.js"
import type { ReviewResult } from "../src/types.js"

// Node's default Solid export is SSR and has no running effects. Exercise the
// production observer with the real client runtime used by the TUI, without a
// bundle, JSX emulation, host, or a second copied implementation of the effect.
if (!process.execArgv.includes("--conditions=browser")) {
  test("client Solid presentation integration", async () => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath,
        ["--conditions=browser", "--import", "tsx", "--test", "--test-reporter=tap", fileURLToPath(import.meta.url)],
        { env: { ...process.env, NODE_TEST_CONTEXT: undefined } })
      assert.match(stdout, /# tests 9\b/, "the child must execute the client-runtime integration cases")
      assert.match(stdout, /# fail 0\b/)
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string }
      assert.fail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)
    }
  })
} else {
  const request: PermissionRequest = { id: "reactive", sessionID: "root", permission: "bash", patterns: ["pwd"], always: [], metadata: {} }
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(yes => { resolve = yes })
    return { promise, resolve }
  }
  const sse = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0,
    delta: { content }, finish_reason: finish }] })}\n\n`
  for (const ordering of ["before", "after"] as const) for (const loss of [undefined, "sidebar", "route", "dialog"] as const) {
    test(`real SSE correction, Solid publication/paint separation: Safe ${ordering} GET, ${loss ?? "same owner"}`, async t => {
      const config = parseConfig({ baseURL: "http://fixture.invalid/v1", model: "fixture", autoApprove: true, fastMode: true,
        stream: true, staleReminderSeconds: 0 })
      const oldRead = deferred<PermissionRequest[]>(), replacement = deferred<Response>(), nextPOST = deferred<void>()
      const notifications: string[] = [], bodies: string[] = []
      const policy = new NotificationPolicy(config, true, {
        show: async message => { notifications.push(message.kind); return { close() {} } }, dispose() {},
      })
      let first!: ReadableStreamDefaultController<Uint8Array>, reviewing!: Promise<ReviewResult>
      const [views, setViews] = createSignal<View[]>([])
      const [ownership, setOwnership] = createSignal<PresentationOwnership>({ session: "root", owner: Symbol(), state: "visible" })
      const [painted, setPainted] = createSignal(true)
      const [callbackRead, setCallbackRead] = createSignal(0)
      let reserved = false, cleared = false, observations = 0, reads = 0, writes = 0
      const presentation = (): ReviewPresentation => {
        views() // The actual panel getter reads reactive view/status/report state.
        const owner = ownership()
        if (owner.state === "lost" || owner.session !== "root" || !painted()) return { state: "lost" }
        return { state: owner.state, id: request.id }
      }
      const controller = new Controller((_req, signal, identified, onProgress) => {
        identified()
        reviewing = review({ kind: "shell", command: "pwd", cwd: "/fixture", userPrompt: "Print cwd", files: [], limitations: [] },
          config, signal, { onProgress, fetcher: async (_url, init) => {
            bodies.push(init!.body as string)
            if (bodies.length === 1) return new Response(new ReadableStream({ start(writer) { first = writer } }),
              { headers: { "content-type": "text/event-stream" } })
            nextPOST.resolve(); return replacement.promise
          } })
        return reviewing
      }, value => {
        setViews(value)
        policy.snapshot(controller.views, new Map([["root", { kind: "permission", id: request.id }]]))
      }, { reviewOptions: config, approval: { presentation, visibleID: () => undefined,
        list: () => ++reads === 1 ? oldRead.promise : Promise.resolve([request]), once: async () => { writes++ } } })
      const dispose = createRoot(dispose => {
        // This is layout invalidation, not an ownership change. Like the captured
        // retry, removal of the checking footer leaves an obsolete hit-grid owner
        // until the next paint. Production may see lost here at a synchronous read.
        createEffect(() => {
          const value = views()[0]
          if (value?.autoApproval?.status === "checking") reserved = true
          if (reserved && !cleared && value?.status === "analyzing" && !value.autoApproval) {
            cleared = true; setPainted(false)
          }
        })
        observePresentationOwnership(ownership, presentation, proof => {
          callbackRead() // Indirect observer/publication reads must be untracked too.
          observations++; controller.presented(proof)
        })
        return dispose
      })
      t.after(async () => { dispose(); await controller.dispose(); await policy.dispose() })
      assert.equal(observations, 1, "the real client effect ran")
      controller.asked(request)
      policy.permission(request, { root: "root", sessionID: "root", title: "Fixture" }, true)
      await settle(); controller.presented(presentation())
      first.enqueue(Buffer.from(sse('{"safe":true,"desc":"Rejected"'))); await settle()
      assert.equal(reads, 1)
      first.enqueue(Buffer.from(sse(',"extra":1}', "stop") + "data: [DONE]\n\n")); first.close()
      await nextPOST.promise; await settle()
      assert.equal(cleared, true); assert.equal(presentation().state, "lost")
      assert.equal(observations, 1, "review/progress/hit-owner publications are not physical-loss observations")
      setCallbackRead(1)
      setOwnership({ ...ownership() })
      assert.equal(observations, 1, "callback reads and equivalent ownership metadata do not resubscribe")
      assert.notEqual(controller.views[0]?.autoApproval?.status, "cancelled")
      assert.equal(writes, 0)
      if (loss) {
        setOwnership(loss === "route" ? { ...ownership(), session: "other" } : { ...ownership(), state: "lost" })
        assert.equal(observations, 2)
        assert.equal(controller.views[0]?.autoApproval?.status, "cancelled", "real ownership loss is immediate while unpainted")
      }
      // The next actual presentation observation restores physical proof. It must
      // not itself be induced by the layout signal/publication above.
      setPainted(true); controller.presented(presentation())
      if (ordering === "after") { oldRead.resolve([request]); await settle() }
      replacement.resolve(new Response(sse('{"safe":true,"desc":"Replacement Safe"}', "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }))
      await reviewing; await settle()
      if (ordering === "before") {
        assert.equal(writes, 0); oldRead.resolve([request])
      }
      await settle(); controller.presented(presentation()); await settle()
      assert.equal(bodies.length, 2)
      assert.equal(writes, loss ? 0 : 1)
      assert.equal(reads, loss ? 1 : 2)
      if (!loss) assert.deepEqual(notifications, [], "no false attention after a validated replacement")
    })
  }

  test("same-session sidebar token replacement observes pending then renewed proof without view subscriptions", () => {
    const [ownership, setOwnership] = createSignal<PresentationOwnership>({ session: "root", owner: Symbol(), state: "visible" })
    const [proof, setProof] = createSignal<ReviewPresentation>({ state: "visible", id: request.id })
    const observations: ReviewPresentation[] = []
    const dispose = createRoot(dispose => {
      observePresentationOwnership(ownership, proof, value => observations.push(value))
      return dispose
    })
    try {
      setProof({ state: "pending", id: request.id })
      assert.equal(observations.length, 1)
      setOwnership({ session: "root", state: "pending" })
      setOwnership({ session: "root", owner: Symbol(), state: "visible" })
      assert.deepEqual(observations.map(value => value.state), ["visible", "pending", "pending"])
      setProof({ state: "visible", id: request.id })
      assert.equal(observations.length, 3, "paint is independently published by the FRAME listener")
    } finally { dispose() }
  })
}
