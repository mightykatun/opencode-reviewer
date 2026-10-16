import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { Controller, type ControllerCheckpoint } from "../src/controller.js"
import type { HostRequest } from "../src/host-types.js"

const request: HostRequest = { id: "permission", sessionID: "root", action: "shell", resources: ["pwd"],
  source: { id: "call", assistantID: "assistant" } }
function fixture() {
  let now = 0, writes = 0, reviews = 0
  const timers = new Map<() => void, number>()
  const pending = [request]
  const create = (checkpoint?: ControllerCheckpoint<HostRequest>) => new Controller<HostRequest>(async () => {
    reviews++; return { safe: true, desc: "Reads current directory." }
  }, () => {}, {
    checkpoint, candidate: () => true, nativeFront: () => pending[0]?.id, approvalReady: () => true,
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, autoApproveDelaySeconds: 15 },
    clock: { now: () => now, after: (ms, callback) => { timers.set(callback, now + ms); return () => { timers.delete(callback) } } },
    nativeApproval: { list: async () => pending, once: async (_request, _signal, dispatch) => {
      if (!dispatch()) return { status: "unavailable" }
      writes++; return { status: "uncertain" }
    } },
  })
  return { create, pending, writes: () => writes, reviews: () => reviews,
    async advance(ms: number) {
      now += ms
      for (const [callback, at] of [...timers]) if (at <= now) { timers.delete(callback); callback() }
      await settle()
    } }
}

test("reconnection re-reviews fresh evidence but resumes the original monotonic countdown deadline", async t => {
  const f = fixture(), first = f.create()
  t.after(() => first.dispose())
  first.asked(request); await settle()
  const checkpoint = first.checkpoint()
  assert.equal(checkpoint.pending.get(request.id)?.deadline, 15200)
  await first.dispose(); await f.advance(10000)
  const next = f.create(checkpoint); t.after(() => next.dispose())
  assert.equal(next.views.length, 0, "No old report or assessment is carried across connections")
  next.asked(structuredClone(request)); await settle()
  assert.equal(f.reviews(), 2)
  assert.deepEqual(next.views[0]?.autoApproval, { status: "countdown", seconds: 6 })
  await f.advance(5199); assert.equal(f.writes(), 0)
  await f.advance(1); assert.equal(f.writes(), 1, "No fresh fifteen-second delay after reconnect")
})

for (const reason of ["cancelled", "failed"] as const) test(`reconnection cannot erase a ${reason} approval tombstone`, async t => {
  const f = fixture(), first = f.create()
  t.after(() => first.dispose())
  first.asked(request); await settle()
  if (reason === "cancelled") first.cancelAutoApproval(request.id)
  else await first.approveNow(request.id, true)
  const before = f.writes(), checkpoint = first.checkpoint()
  assert.equal(checkpoint.manual.get(request.id), reason)
  await first.dispose()
  const next = f.create(checkpoint); t.after(() => next.dispose())
  next.asked(request); await settle(); await f.advance(60000)
  await next.approveNow(request.id, true)
  assert.equal(next.views[0]?.autoApproval?.status, reason)
  assert.equal(f.writes(), before)
  const newer = { ...request, id: "fresh-permission" }
  f.pending.splice(0, 1, newer)
  next.reconcile(f.pending, next.revision); await settle()
  await f.advance(15200)
  assert.equal(f.writes(), before + 1, "A protected old request does not disable subsequent live review")
})

test("a changed request cannot inherit a previous countdown or become automatically approvable", async t => {
  const f = fixture(), first = f.create()
  t.after(() => first.dispose())
  first.asked(request); await settle()
  const checkpoint = first.checkpoint(); await first.dispose()
  const next = f.create(checkpoint); t.after(() => next.dispose())
  const changed = { ...request, resources: ["different command"] }
  f.pending.splice(0, 1, changed)
  next.asked(changed); await settle(); await f.advance(60000)
  assert.equal(f.writes(), 0); assert.equal(next.views[0]?.autoApproval?.status, "failed")
})

test("changed identity stays manual even when disconnect interrupted an unarmed review", async t => {
  const f = fixture(), first = f.create()
  t.after(() => first.dispose())
  first.asked(request)
  const checkpoint = first.checkpoint()
  assert.equal(checkpoint.pending.get(request.id)?.deadline, undefined)
  await first.dispose()
  const next = f.create(checkpoint); t.after(() => next.dispose())
  const changed = { ...request, sessionID: "different-conversation" }
  f.pending.splice(0, 1, changed)
  next.asked(changed); await settle(); await f.advance(60000)
  assert.equal(f.writes(), 0); assert.equal(next.views[0]?.autoApproval?.status, "failed")
})
