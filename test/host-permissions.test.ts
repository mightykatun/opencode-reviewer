import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { hostPermissionTransport } from "../src/host-permissions.js"
import { snapshotRequest } from "../src/host-request.js"
import { ApprovalTransaction } from "../src/approval-transaction.js"
import { withDeadline } from "../src/deadline.js"
import { setImmediate as tick } from "node:timers/promises"
import { getEventListeners } from "node:events"
import { Controller, type ApprovalFact, type ReviewLifecycleFact } from "../src/controller.js"
import type { HostRequest, HostRequestSnapshot } from "../src/host-types.js"

const location = { directory: "/invocation", workspaceID: "workspace" }, scope = { location, epoch: "10000000-1000-4000-8000-100000000000" }
const raw = (id = "request", sessionID = "session") => ({ id, sessionID, action: "shell", resources: ["python3 fixture.py"], save: ["python3 *"] })
const signal = () => new AbortController().signal
const key = (sessionID: string, requestID: string) => JSON.stringify([sessionID, requestID])
const resolution = (request = raw(), decision = "once") => ({ sessionID: request.sessionID, requestID: request.id, decision })
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function fixture() {
  const request = raw(), child = raw("child-request", "child")
  const state = {
    epoch: scope.epoch, directory: location.directory, request, calls: [] as unknown[], reject: false, reads: 0,
    pending: new Map([request, child].map(item => [key(item.sessionID, item.id), item])),
    replyGate: undefined as Promise<void> | undefined, getGate: undefined as Promise<void> | undefined,
    onReply: undefined as (() => void) | undefined,
  }
  const client = {
    rpc: () => ({ handshake: async () => ({ protocol: 1, hostVersion: "2.0.26", epoch: state.epoch, location,
      project: { id: "project", directory: "/project", canonical: "/canonical" } }) }),
    session: { get: async () => ({ id: "session", location: { directory: state.directory } }) },
    permission: {
      request: { list: async () => ({ location: { directory: state.directory }, data: [...state.pending.values()] }) },
      get: async ({ sessionID, requestID }: { sessionID: string; requestID: string }) => {
        state.reads++
        if (state.getGate) await state.getGate
        const request = state.pending.get(key(sessionID, requestID))
        if (!request) throw Error("Permission not pending")
        return state.request.id === requestID && state.request.sessionID === sessionID ? state.request : request
      },
      list: async ({ sessionID }: { sessionID: string }) => [...state.pending.values()].filter(item => item.sessionID === sessionID),
      reply: async (input: { sessionID: string; requestID: string }, options: unknown) => {
        state.calls.push({ input, options })
        state.onReply?.()
        if (state.replyGate) await state.replyGate
        if (state.reject) throw Error("uncertain delivery")
        state.pending.delete(key(input.sessionID, input.requestID))
      },
    },
  }
  return {
    state, transport: hostPermissionTransport(client as unknown as OpenCodeClient, scope),
    add(request: ReturnType<typeof raw>) {
      state.request = request
      state.pending.set(key(request.sessionID, request.id), request)
      return snapshotRequest(request, scope)!
    },
  }
}

test("permission transport retains exact ordered pending data and only submits once in invocation scope", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
  assert.deepEqual(await f.transport.list("session", signal()), [snapshot])
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "submitted")
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "unavailable")
  assert.equal(f.state.calls.length, 1)
  assert.deepEqual((f.state.calls[0] as any).input, { sessionID: "session", requestID: "request", decision: "once" })
  assert.deepEqual((f.state.calls[0] as any).options.location, location)
})

test("location reconciliation retains root and descendant requests instead of mistaking one session for a complete snapshot", async () => {
  const f = fixture()
  const all = await f.transport.listScope(signal())
  assert.deepEqual(all.map(item => [item.request.sessionID, item.request.id]), [["session", "request"], ["child", "child-request"]])
  f.state.directory = "/other"
  await assert.rejects(f.transport.listScope(signal()), /location unavailable/)
})

test("location inventory admits each 9 MiB preview separately but fails closed on their aggregate", async () => {
  const f = fixture(), requests = [raw("large-one"), raw("large-two", "child")].map(request =>
    ({ ...request, metadata: { preview: "p".repeat(9 * 1024 * 1024) } }))
  for (const request of requests) {
    assert.ok(snapshotRequest(request, scope), "Individual native preview remains supported")
    f.state.pending.clear(); f.add(request)
    assert.equal((await f.transport.listScope(signal())).length, 1)
  }
  f.state.pending.clear()
  for (const request of requests) f.add(request)
  await assert.rejects(f.transport.listScope(signal()), /Pending permissions unavailable/)
  assert.equal(f.state.calls.length, 0)
})

test("epoch/location/identity/presentation loss blocks dispatch without gaining a retry tombstone", async () => {
  for (const change of ["epoch", "location", "identity", "eligible"] as const) {
    const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
    if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
    if (change === "location") f.state.directory = "/tool-workdir"
    if (change === "identity") f.state.request.resources = ["changed"]
    assert.equal((await f.transport.once(snapshot, signal(), () => change !== "eligible")).status, "unavailable")
    assert.deepEqual(f.state.calls, [])
    f.state.epoch = scope.epoch; f.state.directory = location.directory; f.state.request = raw()
    assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "submitted")
  }
})

test("parallel attempts are single-flight and uncertain writes cannot be retried", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
  f.state.reject = true
  const results = await Promise.all([f.transport.once(snapshot, signal(), () => true), f.transport.once(snapshot, signal(), () => true)])
  assert.deepEqual(results.map(item => item.status).sort(), ["unavailable", "uncertain"])
  f.state.reject = false
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "unavailable")
  assert.equal(f.state.calls.length, 1)
})

test("a snapshot from another connection cannot write, including metadata-only mutations", async () => {
  const f = fixture()
  const other = snapshotRequest(raw(), { ...scope, epoch: "20000000-1000-4000-8000-100000000000" })!
  assert.equal((await f.transport.once(other, signal(), () => true)).status, "unavailable")
  const withMetadata = snapshotRequest({ ...raw(), metadata: { command: "different" } }, scope)!
  assert.equal((await f.transport.once(withMetadata, signal(), () => true)).status, "unavailable")
  assert.deepEqual(f.state.calls, [])
})

test("actual-dispatch guard runs only after preparation and immediately before native invocation", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!, order: string[] = []
  const pending = f.transport.once(snapshot, signal(), () => {
    assert.equal(f.state.calls.length, 0)
    order.push("dispatch")
    queueMicrotask(() => { assert.equal(f.state.calls.length, 1); order.push("after invocation") })
    return true
  })
  assert.deepEqual(order, [], "async host preparation is not dispatch")
  assert.equal((await pending).status, "submitted")
  assert.deepEqual(order, ["dispatch", "after invocation"])
})

test("failed epoch/source checks and aborted preparation never invoke the dispatch callback", async () => {
  for (const change of ["epoch", "source", "abort"] as const) {
    const f = fixture(), controller = new AbortController()
    const snapshot = snapshotRequest({ ...raw(), ...(change === "source" ? { source: { type: "tool", messageID: "assistant", id: "call" } } : {}) }, scope)!
    if (change === "epoch") f.state.epoch = "20000000-1000-4000-8000-100000000000"
    if (change === "abort") controller.abort()
    let dispatched = 0
    assert.equal((await f.transport.once(snapshot, controller.signal, () => { dispatched++; return true })).status, "unavailable")
    assert.equal(dispatched, 0)
    assert.deepEqual(f.state.calls, [])
  }
})

test("successful physical replies and exact native once events prune many reservations in either order", async () => {
  const f = fixture()
  for (let index = 0; index < 200; index++) {
    const request = raw(`request-${index}`), snapshot = f.add(request)
    f.state.onReply = index % 2 ? () => f.transport.resolved(resolution(request)) : undefined
    assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "submitted")
    assert.equal(f.transport.retainedReservations, index % 2 ? 0 : 1)
    f.transport.resolved(resolution(request))
    assert.equal(f.transport.retainedReservations, 0)
    assert.equal(f.state.pending.has(key(request.sessionID, request.id)), false)
    await assert.rejects(f.transport.get(request.sessionID, request.id, signal()), /not pending/)
    const reads = f.state.reads
    assert.equal((await f.transport.once(snapshot, signal(), () => assert.fail("old snapshot retried"))).status, "unavailable")
    assert.equal(f.state.reads, reads, "original dispatched snapshot is blocked before another host read")
    const fresh = snapshotRequest(request, scope)!
    assert.equal((await f.transport.once(fresh, signal(), () => assert.fail("resolved native ID retried"))).status, "unavailable")
    assert.equal(f.transport.retainedReservations, 0)
  }
  assert.equal(f.state.calls.length, 200)
})

test("an admitted once event cannot release the reservation before physical reply settlement", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!, physical = gate(), invoked = gate()
  f.state.replyGate = physical.promise
  f.state.onReply = () => { f.transport.resolved(resolution()); invoked.release() }
  const pending = f.transport.once(snapshot, signal(), () => true)
  await invoked.promise
  assert.equal(f.transport.retainedReservations, 1)
  assert.equal(f.state.pending.has(key("session", "request")), true)
  assert.equal((await f.transport.once(snapshotRequest(raw(), scope)!, signal(), () => assert.fail("parallel write"))).status, "unavailable")
  physical.release()
  assert.equal((await pending).status, "submitted")
  assert.equal(f.transport.retainedReservations, 0)
  assert.equal(f.state.calls.length, 1)
})

test("unknown identities and pre-dispatch events cannot release scoped reservations", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!, preparation = gate()
  f.state.getGate = preparation.promise
  f.transport.resolved(resolution())
  const pending = f.transport.once(snapshot, signal(), () => {
    // Even an event observed inside admission precedes actual native dispatch.
    f.transport.resolved(resolution())
    return true
  })
  assert.equal(f.transport.retainedReservations, 1, "reservation is synchronous before host preparation")
  f.transport.resolved(resolution())
  f.transport.resolved(resolution(raw("unknown")))
  f.transport.resolved(resolution(raw("request", "other-session")))
  assert.equal(f.transport.retainedReservations, 1)
  preparation.release()
  assert.equal((await pending).status, "submitted")
  assert.equal(f.transport.retainedReservations, 1, "pre-dispatch events do not pair with the later ACK")
  f.transport.resolved(resolution(raw("unknown")))
  f.transport.resolved(resolution(raw("request", "other-session")))
  assert.equal(f.transport.retainedReservations, 1)
  f.transport.resolved(resolution())
  assert.equal(f.transport.retainedReservations, 0)
})

test("an ACK alone remains reserved and disappearance is not native resolution proof", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "submitted")
  assert.equal(f.transport.retainedReservations, 1)
  assert.deepEqual(await f.transport.list("session", signal()), [])
  await assert.rejects(f.transport.get("session", "request", signal()), /not pending/)
  assert.equal(f.transport.retainedReservations, 1)
  assert.equal((await f.transport.once(snapshotRequest(raw(), scope)!, signal(), () => assert.fail("ACK-only retry"))).status, "unavailable")
  f.transport.resolved(resolution())
  assert.equal(f.transport.retainedReservations, 0)
})

test("uncertain physical failures remain protected despite exact once resolution and later new requests", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
  f.state.reject = true
  f.state.onReply = () => f.transport.resolved(resolution())
  assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "uncertain")
  assert.equal(f.transport.retainedReservations, 1, "event alone cannot confirm physical success")
  f.state.reject = false
  f.transport.resolved(resolution())
  assert.equal((await f.transport.once(snapshotRequest(raw(), scope)!, signal(), () => assert.fail("uncertain retry"))).status, "unavailable")
  const request = raw("new-request"), next = f.add(request)
  f.state.onReply = () => f.transport.resolved(resolution(request))
  assert.equal((await f.transport.once(next, signal(), () => true)).status, "submitted")
  assert.equal(f.transport.retainedReservations, 1, "new success prunes only its own reservation")
  assert.equal(f.state.calls.length, 2)
})

test("non-once native outcomes never release dispatched identities", async () => {
  for (const decision of ["always", "reject", "unknown"]) {
    for (const eventFirst of [false, true]) {
      const f = fixture(), snapshot = snapshotRequest(raw(), scope)!
      if (eventFirst) f.state.onReply = () => f.transport.resolved(resolution(raw(), decision))
      assert.equal((await f.transport.once(snapshot, signal(), () => true)).status, "submitted")
      if (!eventFirst) f.transport.resolved(resolution(raw(), decision))
      f.transport.resolved(resolution())
      assert.equal(f.transport.retainedReservations, 1)
      assert.equal((await f.transport.once(snapshotRequest(raw(), scope)!, signal(), () => assert.fail("non-once retry"))).status, "unavailable")
      assert.equal(f.state.calls.length, 1)
    }
  }
})

test("deadline abort followed by a late successful physical ACK remains uncertain in either event order", async () => {
  for (const eventFirst of [false, true]) {
    const f = fixture(), snapshot = snapshotRequest(raw(), scope)!, controller = new AbortController()
    const physical = gate(), invoked = gate()
    f.state.replyGate = physical.promise
    f.state.onReply = () => {
      if (eventFirst) f.transport.resolved(resolution())
      invoked.release()
    }
    const pending = f.transport.once(snapshot, controller.signal, () => true)
    await invoked.promise
    controller.abort(Error("review deadline expired"))
    assert.equal(f.transport.retainedReservations, 1)
    physical.release()
    assert.equal((await pending).status, "uncertain")
    assert.equal(f.state.pending.has(key("session", "request")), false, "native reply did physically settle")
    f.transport.resolved(resolution())
    assert.equal(f.transport.retainedReservations, 1, "late ACK is not accepted as successful local settlement")
    assert.equal((await f.transport.once(snapshotRequest(raw(), scope)!, signal(), () => assert.fail("late-ACK retry"))).status, "unavailable")
    assert.equal(f.state.calls.length, 1)
  }
})

test("physical ACK followed by confirmation timeout retains uncertainty after a late native once event", async () => {
  const f = fixture(), snapshot = snapshotRequest(raw(), scope)!, parent = new AbortController(), invoked = gate()
  const facts: string[] = []
  const transaction = new ApprovalTransaction(snapshot.request, "session", "review", true, {}, fact => { facts.push(fact.type) })
  f.state.onReply = invoked.release
  const native = { once: (_request: typeof snapshot.request, signal: AbortSignal, dispatch: () => boolean) => f.transport.once(snapshot, signal, dispatch) }
  const submitting = withDeadline(parent.signal, 100, signal => transaction.submit(signal, native, {
    guard: () => true, dispatch() {}, confirming: () => assert.fail("timed-out approval confirmed"), confirmed() {},
  }))
  const rejected = assert.rejects(submitting, /timed out/)
  await invoked.promise; await tick()
  assert.equal(transaction.state, "acknowledged")
  assert.equal(f.transport.retainedReservations, 1)
  await rejected; await tick()
  assert.equal(transaction.state, "uncertain")
  f.transport.resolved(resolution())
  assert.equal(transaction.resolved({ sessionID: "session", requestID: "request", decision: "once" }), false)
  assert.equal(f.transport.retainedReservations, 1, "a late event cannot prune a deadline-uncertain write whose ACK arrived first")
  assert.deepEqual(facts, ["dispatched", "settled"])
  assert.equal((await f.transport.once(snapshotRequest(raw(), scope)!, signal(), () => assert.fail("uncertain retry"))).status, "unavailable")
  assert.equal(f.state.calls.length, 1)
})

test("successful confirmation and unsent preparation release reservation abort listeners", async () => {
  for (const dispatch of [false, true]) {
    const f = fixture(), snapshot = snapshotRequest(raw(), scope)!, abort = new AbortController()
    const result = await f.transport.once(snapshot, abort.signal, () => dispatch)
    assert.equal(result.status, dispatch ? "submitted" : "unavailable")
    if (dispatch) {
      assert.equal(getEventListeners(abort.signal, "abort").length, 1)
      f.transport.resolved(resolution())
    }
    assert.equal(f.transport.retainedReservations, 0)
    assert.equal(getEventListeners(abort.signal, "abort").length, 0)
  }
})

for (const outcome of ["rejected acknowledgement", "acknowledgement timeout", "confirmation timeout"] as const) {
  test(`controller + native transport: disappearance before ${outcome} cannot reprepare or rewrite a reappearing ID`, async t => {
    if (outcome !== "rejected acknowledgement") t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture(), physical = gate(), report = gate(), invoked = gate()
    f.state.pending.clear()
    const request = raw(), snapshot = f.add(request), snapshots = new Map<string, HostRequestSnapshot>([[request.id, snapshot]])
    const safe = { safe: true, desc: "Reads the fixture." }
    const facts: ApprovalFact<HostRequest>[] = [], lifecycle: ReviewLifecycleFact<HostRequest>[] = []
    let reviews = 0, preparations = 0
    if (outcome !== "confirmation timeout") f.state.replyGate = physical.promise
    f.state.reject = outcome === "rejected acknowledgement"
    f.state.onReply = invoked.release
    const controller = new Controller<HostRequest>(async (_request, _signal, identify, progress) => {
      reviews++; identify()
      progress({ attempt: 0, phase: "evaluating" }); progress({ attempt: 0, phase: "streaming", preview: safe })
      await report.promise
      return safe
    }, () => {}, { candidate: () => true, nativeFront: () => request.id, approvalReady: () => true,
      reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode: true, stream: true },
      nativeApproval: {
        list: async signal => (await f.transport.listScope(signal)).map(value => value.request),
        once: (request, signal, dispatch) => {
          preparations++
          return f.transport.once(snapshots.get(request.id)!, signal, dispatch)
        },
      }, onApproval: fact => { facts.push(fact) }, onLifecycle: fact => { lifecycle.push(fact) },
    })
    t.after(async () => { physical.release(); report.release(); await controller.dispose() })
    const refresh = async () => {
      const requests = await f.transport.listScope(signal())
      snapshots.clear(); for (const snapshot of requests) snapshots.set(snapshot.request.id, snapshot)
      controller.reconcile(requests.map(value => value.request), controller.revision)
      await tick()
    }
    controller.asked(snapshot.request); await invoked.promise; await tick()
    assert.equal(f.state.calls.length, 1)
    assert.equal(f.transport.retainedReservations, 1)
    f.state.pending.clear(); await refresh()
    assert.equal(controller.views[0]?.resolved, true)
    assert.deepEqual(facts.map(fact => fact.type), ["dispatched"])
    if (outcome === "rejected acknowledgement") physical.release()
    else t.mock.timers.tick(5000)
    await tick()
    assert.equal(controller.views.length, 0)
    assert.deepEqual(lifecycle.filter(fact => fact.type === "removed").map(fact => fact.reason), ["reconciled"])
    assert.equal(f.transport.retainedReservations, 1)
    physical.release(); await tick() // A late physical ACK cannot reclaim uncertainty.
    f.state.reject = false; f.add(raw()); await refresh()
    report.release(); await tick()
    assert.equal(controller.views[0]?.autoApproval?.status, "failed")
    assert.equal(reviews, 2, "read-only removal permits a fresh advisory review, not another approval")
    const reads = f.state.reads
    for (let index = 0; index < 3; index++) {
      await refresh(); controller.refreshApprovalEligibility(); await controller.approveNow(request.id, true); await tick()
    }
    assert.equal(reviews, 2)
    assert.equal(preparations, 1, "controller tombstone blocks transport entry, before the transport's own reservation check")
    assert.equal(f.state.reads, reads, "no fresh native preparation reads")
    assert.equal(f.state.calls.length, 1)
    assert.deepEqual(facts.map(fact => [fact.type, fact.result]), [["dispatched", undefined], ["settled", "uncertain"]])
    const event = resolution(request)
    f.transport.resolved(event); controller.permissionReplied(event)
    assert.equal(controller.views.length, 0)
    assert.equal(f.transport.retainedReservations, 1, "exact late events do not release uncertain once transport reservations")
  })
}

test("controller + native transport: exact resolution after disappearance confirms and releases only acknowledged approval", async t => {
  const f = fixture(), report = gate(), invoked = gate(), facts: ApprovalFact<HostRequest>[] = [], lifecycle: ReviewLifecycleFact<HostRequest>[] = []
  f.state.pending.clear()
  const request = raw(), snapshot = f.add(request), safe = { safe: true, desc: "Reads the fixture." }
  f.state.onReply = invoked.release
  const controller = new Controller<HostRequest>(async (_request, _signal, identify, progress) => {
    identify(); progress({ attempt: 0, phase: "evaluating" }); progress({ attempt: 0, phase: "streaming", preview: safe })
    await report.promise; return safe
  }, () => {}, { candidate: () => true, nativeFront: () => request.id, approvalReady: () => true,
    reviewOptions: { reviewBash: true, reviewEdits: true, autoApprove: true, fastMode: true, stream: true },
    nativeApproval: { list: async signal => (await f.transport.listScope(signal)).map(value => value.request),
      once: (_request, signal, dispatch) => f.transport.once(snapshot, signal, dispatch) },
    onApproval: fact => { facts.push(fact) }, onLifecycle: fact => { lifecycle.push(fact) },
  })
  t.after(async () => { report.release(); await controller.dispose() })
  controller.asked(snapshot.request); await invoked.promise; await tick()
  controller.reconcile((await f.transport.listScope(signal())).map(value => value.request), controller.revision)
  assert.equal(controller.views[0]?.resolved, true)
  assert.equal(f.transport.retainedReservations, 1)
  const event = resolution(request)
  f.transport.resolved(event); controller.permissionReplied(event); await tick()
  assert.equal(controller.views[0]?.autoApproval?.status, "approved")
  assert.equal(f.transport.retainedReservations, 0)
  report.release(); await tick()
  assert.equal(controller.views.length, 0)
  assert.deepEqual(facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
  assert.deepEqual(lifecycle.filter(fact => fact.type === "removed").map(fact => fact.reason), ["resolved"])
  assert.equal(f.state.calls.length, 1)
})
