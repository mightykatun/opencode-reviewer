import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { Controller } from "../src/controller.js"
import { refreshNativeFamily, type NativeFamilyReader } from "../src/host-native-observations.js"
import type { HostRequest } from "../src/host-types.js"
import { InvocationCapture } from "../src/invocation-capture.js"
import { PendingRefresh } from "../src/pending-refresh.js"
import { ownedReview } from "../src/review-admission.js"
import { review } from "../src/reviewer.js"
import { parseConfig } from "../src/config.js"
import type { SessionLocation } from "../src/route-approval.js"
import { SessionAncestry } from "../src/session-ancestry.js"
import { SessionModes } from "../src/session-mode.js"
import { shellEvidence } from "./review-fixtures.js"

const request = (id: string): HostRequest => ({ id, sessionID: "root", action: "shell", resources: [id] })
const safe = { safe: true, desc: "Reads fixture data." }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// These are guarded safety boundaries and recovery reproductions, not changes to
// admission policy. A successful read must still pass the original validation.
test("historical family sync blocks pending admission until sync and ancestry both recover", async t => {
  const evaluated: string[] = [], health: boolean[] = [], syncs: string[] = []
  const controller = new Controller(async req => { evaluated.push(req.id); return safe }, () => {}, { candidate: () => true })
  const cache = new Map<string, SessionLocation>([["root", { id: "root" }]])
  let member = deferred<SessionLocation>()
  const reader: NativeFamilyReader = {
    resolveRoot: async () => "root",
    session: id => cache.get(id),
    family: () => ["historical-child"],
    owned: work => work,
    sync: async id => {
      syncs.push(id)
      if (id === "historical-child") cache.set(id, await member.promise)
    },
  }
  const pending = [request("current")]
  const refresh = new PendingRefresh(controller, async signal => {
    await refreshNativeFamily(pending.map(req => req.sessionID), reader, signal)
    return pending
  }, new AbortController().signal, healthy => { health.push(healthy) })
  t.after(async () => { member.resolve({ id: "historical-child", parentID: "root" }); refresh.dispose(); await controller.dispose() })

  const failed = refresh.refresh()
  await settle()
  assert.deepEqual(syncs, ["root", "historical-child"])
  assert.deepEqual(evaluated, [])
  member.reject(Error("Historical session sync unavailable"))
  await failed
  assert.deepEqual(controller.views, [])
  assert.deepEqual(health, [false])

  member = deferred<SessionLocation>()
  const foreign = refresh.refresh()
  await settle()
  member.resolve({ id: "historical-child", parentID: "other-root" })
  await foreign
  assert.deepEqual(evaluated, [], "successful I/O cannot waive family ancestry validation")
  assert.deepEqual(health, [false, false])

  member = deferred<SessionLocation>()
  const recovered = refresh.refresh()
  await settle()
  member.resolve({ id: "historical-child", parentID: "root" })
  await recovered
  await settle()
  assert.deepEqual(evaluated, ["current"])
  assert.deepEqual(health, [false, false, true])
  assert.deepEqual(syncs, Array.from({ length: 3 }, () => ["root", "historical-child"]).flat())
})

test("repeated activity revisions discard stale pending refreshes; a stable revision admits recovery", async t => {
  const evaluated: string[] = [], health: boolean[] = []
  const reads: ReturnType<typeof deferred<HostRequest[]>>[] = []
  const controller = new Controller(async req => { evaluated.push(req.id); return safe }, () => {}, { candidate: () => true })
  const refresh = new PendingRefresh(controller, () => {
    const read = deferred<HostRequest[]>()
    reads.push(read)
    return read.promise
  }, new AbortController().signal, healthy => { health.push(healthy) })
  t.after(async () => { refresh.dispose(); for (const read of reads) read.resolve([]); await controller.dispose() })

  const first = refresh.refresh()
  await settle()
  for (let index = 0; index < 3; index++) {
    const revision = controller.revision
    controller.replied(`activity-${index}`)
    assert.ok(controller.revision > revision)
    await refresh.refresh() // Coalesce a recovery read at the next revision.
    reads[index]!.resolve([request(`stale-${index}`)])
    await settle()
    assert.deepEqual(evaluated, [])
    assert.deepEqual(controller.views, [])
    assert.equal(reads.length, index + 2)
  }
  reads[3]!.resolve([request("stable")])
  await first
  await settle()
  assert.deepEqual(health, [false, false, false, true])
  assert.deepEqual(evaluated, ["stable"])
})

test("completed ambiguous calls release capacity while pending duplicates remain unavailable", () => {
  const captures = new InvocationCapture({ protocol: 1, hostVersion: "2.0.26",
    epoch: "10000000-1000-4000-8000-100000000000", location: { directory: "/fixture" },
    project: { id: "fixture", directory: "/fixture", canonical: "/fixture" } })
  const event = (id: string) => ({ sessionID: "root", messageID: "assistant", id, tool: "shell", input: { command: "pwd" } })
  const read = (id: string) => captures.read("root", "assistant", id)
  for (let index = 0; index < 512; index++) {
    const call = event(`duplicate-${index}`)
    captures.before(call)
    assert.ok(read(call.id), "each new identity is initially exact")
     captures.before(call)
     captures.after(call)
     assert.equal(read(call.id), undefined, "one completion cannot disambiguate a live sibling")
     captures.after(call)
     assert.equal(read(call.id), undefined, "settlement cannot resurrect captured arguments")
    if (index === 510) {
      const probe = event("probe-at-511")
      captures.before(probe)
       assert.ok(read(probe.id), "completed identities leave capacity for an exact call")
      captures.after(probe)
    }
  }
  captures.after(event("duplicate-0"))
  assert.equal(read("duplicate-0"), undefined, "a late completion does not resurrect an old capture")
  for (const id of ["unrelated-after-512", "later-unrelated"]) {
     captures.before(event(id))
     assert.ok(read(id), "completed Code Mode calls cannot permanently disable unrelated review")
     captures.after(event(id))
  }
})

test("disable/re-enable cannot free evaluator leases before actual fetch settlement", async t => {
  const modes = new SessionModes({ read: async () => true, write: async () => {}, flush: async () => {} },
    new SessionAncestry(async id => ({ id })))
  const fetches: { result: ReturnType<typeof deferred<Response>>; signal: AbortSignal }[] = []
  const config = parseConfig({ baseURL: "https://fixture.invalid/v1", model: "fixture", stream: false })
  const controller = new Controller((_req, parent, identify) => ownedReview(parent, 1000, async signal => {
    identify()
    return review(shellEvidence(), config, signal, { fetcher: (_url, init) => {
      const result = deferred<Response>()
      fetches.push({ result, signal: init!.signal as AbortSignal })
      return result.promise
    } })
  }), () => {}, { candidate: () => true, modes })
  t.after(async () => {
    const closing = controller.dispose()
    for (const fetch of fetches) fetch.result.reject(Error("Fixture cleanup"))
    await closing
  })
  const pending = Array.from({ length: 8 }, (_, index) => request(`pending-${index}`))
  controller.reconcile(pending, controller.revision)
  await settle()
  assert.equal(fetches.length, 4)
  await modes.set("root", false)
  controller.modeChanged("root")
  await settle()
  assert.ok(fetches.every(fetch => fetch.signal.aborted))
  await modes.set("root", true)
  controller.modeChanged("root")
  controller.reconcile(pending, controller.revision)
  await settle()
  assert.equal(fetches.length, 4, "logical abort and a fresh snapshot do not release physical leases")
  fetches[0]!.result.reject(Error("Late physical failure"))
  await settle()
  assert.equal(fetches.length, 5, "one settled fetch releases exactly one evaluator lease")
  assert.equal(fetches[4]!.signal.aborted, false)
  assert.ok(controller.views.every(view => view.assessment === undefined))
})
