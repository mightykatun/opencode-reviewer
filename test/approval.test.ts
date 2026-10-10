import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { remainingTime } from "../src/deadline.js"
import { setImmediate as settle } from "node:timers/promises"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { approvalTransport, type ApprovalTransport } from "../src/approval.js"
import { parseConfig } from "../src/config.js"
import { Controller, visibleReview, type ApprovalClock, type ApprovalFact, type View } from "../src/controller.js"
import type { Assessment } from "../src/types.js"
import { HistoryCover } from "../src/history-cover.js"

const safe: Assessment = { safe: true, desc: "Reads the requested temporary fixture." }
const request = (id = "b-review", permission = "bash", sessionID = "root"): PermissionRequest => ({
  id, permission, sessionID, patterns: ["python fixture.py"], always: ["python *"],
  metadata: { command: "python fixture.py", workdir: "/tool/target", nested: { scope: ["fixture.py"] } },
  tool: { callID: "shared-call", messageID: "assistant-message" },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Late event-loop delivery advances monotonic time without replaying missed ticks. */
class FakeClock implements ApprovalClock {
  private time = 0
  private jobs = new Set<{ due: number; callback: () => void }>()
  now() { return this.time }
  after(ms: number, callback: () => void) {
    assert.ok(Number.isFinite(ms) && ms >= 0)
    const job = { due: this.time + ms, callback }
    this.jobs.add(job)
    return () => { this.jobs.delete(job) }
  }
  get pending() { return this.jobs.size }
  // Once dequeued, callbacks deliberately remain callable even after cancellation.
  dequeueAfter(ms: number) {
    assert.ok(ms >= 0)
    this.time += ms
    const due = [...this.jobs].filter((job) => job.due <= this.time).sort((a, b) => a.due - b.due)
    for (const job of due) this.jobs.delete(job)
    return due.map((job) => job.callback)
  }
  jump(ms: number) { for (const callback of this.dequeueAfter(ms)) callback() }
}

type Options = NonNullable<NonNullable<ConstructorParameters<typeof Controller>[2]>["reviewOptions"]>
type Evaluate = ConstructorParameters<typeof Controller>[0]
function fixture(t: TestContext, settings: {
  options?: Partial<Options>
  evaluate?: Evaluate
  writer?: boolean
  transport?: ApprovalTransport
  changed?: (views: View[], controller: Controller) => void
  presentation?: () => boolean
  observer?: (fact: ApprovalFact, controller: Controller) => void
} = {}) {
  const clock = new FakeClock()
  const reads: AbortSignal[] = []
  const writes: { request: PermissionRequest; signal: AbortSignal }[] = []
  const evaluated: string[] = []
  const publications: View[][] = []
  const facts: ApprovalFact[] = []
  let enabled = true
  const host = { pending: [] as PermissionRequest[], shown: true, extra: [] as View[] }
  const getSession = (id: string) => ({ id, ...(id === "child" ? { parentID: "root" } : {}) })
  const visible = (): string | undefined => host.shown && (settings.presentation?.() ?? true)
    ? visibleReview([...controller.views, ...host.extra], "root", getSession)?.request.id : undefined
  const transport: ApprovalTransport = settings.transport ?? {
    list: async () => structuredClone(host.pending),
    once: async (req) => { host.pending = host.pending.filter((item) => item.id !== req.id) },
  }
  const controller: Controller = new Controller((req, signal, identified, progress) => {
    evaluated.push(req.id)
    if (settings.evaluate) return settings.evaluate(req, signal, identified, progress)
    identified()
    return Promise.resolve(safe)
  }, (views) => {
    publications.push([...views])
    settings.changed?.(views, controller)
  }, { reviewOptions: { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true, autoApprove: true, ...settings.options }, approval: settings.writer === false ? undefined : {
    visibleID: visible,
    list: (signal) => { reads.push(signal); return transport.list(signal) },
    once: (req, signal) => { writes.push({ request: req, signal }); return transport.once(req, signal) },
  }, clock, modes: { root: async () => "root", load: async () => {}, enabled: () => enabled }, onApproval: fact => {
    facts.push(fact); settings.observer?.(fact, controller)
  } })
  t.after(() => controller.dispose())
  const view = (id = "b-review") => controller.views.find((item) => item.request.id === id)
  const add = async (req = request()) => {
    host.pending.push(req)
    controller.asked(req)
    await settle()
  }
  const present = () => controller.presented(visible())
  return { controller, clock, reads, writes, facts, evaluated, publications, host, visible, view, add, present,
    mode: (value: boolean) => { enabled = value; controller.modeChanged("root") } }
}

test("production history hit-grid handoff preserves the original countdown through same-frame navigation and close", async t => {
  const cover = new HistoryCover()
  let physical = true, children = [1, 2]
  const hits: [number, number] = [1, 2]
  const f = fixture(t, { options: { autoApproveDelaySeconds: 2 }, presentation: () => physical || cover.covers("root", hits) })
  await f.add(); f.present(); f.clock.jump(1000)
  const close = cover.mount("root", hit => children.includes(hit))
  physical = false; cover.frame(); f.present()
  children = [3, 4] // navigation replaces children before the next hit-grid paint
  f.clock.jump(500); f.present()
  close(); f.clock.jump(500); f.present()
  assert.equal(f.view()?.autoApproval?.status, "countdown")
  physical = true; cover.frame(); f.present(); f.clock.jump(1000); await settle()
  assert.equal(f.writes.length, 1, "original three-second deadline includes the initial hold, without a restart")
})

test("a native cover cannot inherit history hits or revive its cancelled countdown after close", async t => {
  const cover = new HistoryCover()
  let physical = false, hits: [number, number] = [1, 2]
  const close = cover.mount("root", hit => hit === 1 || hit === 2)
  const f = fixture(t, { options: { autoApproveDelaySeconds: 2 }, presentation: () => physical || cover.covers("root", hits) })
  await f.add(); cover.frame(); f.present()
  hits = [1, 9]; f.present()
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  close(); physical = true; cover.frame(); f.present(); f.clock.jump(10000); await settle()
  assert.equal(f.writes.length, 0)
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
})

test("approval configuration defaults to disabled and a 15-second bounded integer delay", () => {
  const config = { baseURL: "http://fixture.invalid/v1", model: "fixture" }
  const defaults = parseConfig(config)
  assert.equal(defaults.autoApprove, false)
  assert.equal(defaults.autoApproveDelaySeconds, 15)
  for (const delay of [0, 1, 15, 3600]) {
    const parsed = parseConfig({ ...config, autoApprove: true, autoApproveDelaySeconds: delay })
    assert.equal(parsed.autoApprove, true)
    assert.equal(parsed.autoApproveDelaySeconds, delay)
  }
  for (const delay of [-1, 3601, 0.5, NaN, Infinity, "15", null]) {
    assert.throws(() => parseConfig({ ...config, autoApproveDelaySeconds: delay }), /autoApproveDelaySeconds/)
  }
  for (const enabled of ["true", 1, null]) assert.throws(() => parseConfig({ ...config, autoApprove: enabled }), /autoApprove/)
})

const gates: { name: string; options?: Partial<Options>; writer?: boolean; permission?: string; evaluate?: Evaluate; status: View["status"]; evaluated?: number }[] = [
  { name: "default disabled", options: { autoApprove: undefined }, status: "complete" },
  { name: "explicitly disabled", options: { autoApprove: false }, status: "complete" },
  { name: "no writer", writer: false, status: "complete" },
  { name: "Unsafe", evaluate: async () => ({ safe: false, desc: "Deletes unrelated data." }), status: "complete" },
  { name: "no assessment", evaluate: async () => null, status: "unrelated" },
  { name: "review unavailable", evaluate: async (_, __, identified) => { identified(); throw new Error("Unavailable") }, status: "unavailable" },
  { name: "unidentified directory", permission: "external_directory", evaluate: async () => { throw new Error("Unknown context") }, status: "unidentified" },
  { name: "disabled bash", options: { reviewBash: false }, status: "unrelated", evaluated: 0 },
  { name: "disabled directory", permission: "external_directory", options: { reviewExternalDirectories: false }, status: "unrelated", evaluated: 0 },
  { name: "disabled edit", permission: "edit", options: { reviewEdits: false }, status: "unrelated", evaluated: 0 },
  { name: "unrelated native kind", permission: "read", status: "unrelated", evaluated: 0 },
]
for (const gate of gates) test(`${gate.name} never lists or writes, even with explicit presentation and clicks`, async (t) => {
  const f = fixture(t, gate)
  await f.add(request("b-review", gate.permission))
  f.controller.presented("b-review")
  await f.controller.approveNow("b-review")
  f.clock.jump(3_600_000)
  await settle()
  assert.equal(f.view()?.status, gate.status)
  assert.equal(f.view()?.autoApproval, undefined)
  assert.equal(f.evaluated.length, gate.evaluated ?? 1)
  assert.equal(f.clock.pending, 0)
  assert.equal(f.reads.length, 0)
  assert.equal(f.writes.length, 0)
})

test("countdown starts only after completed Safe assessment AND a subsequent displayed frame", async (t) => {
  const review = deferred<Assessment>()
  const f = fixture(t, { evaluate: (_, __, identified) => { identified(); return review.promise } })
  await f.add()
  f.present()
  f.clock.jump(60_000)
  await f.controller.approveNow("b-review")
  assert.equal(f.view()?.status, "analyzing")
  assert.equal(f.clock.pending, 0)
  review.resolve(safe)
  await settle()
  f.clock.jump(60_000)
  assert.equal(f.view()?.status, "complete")
  assert.equal(f.view()?.autoApproval, undefined)
  assert.equal(f.reads.length, 0)
  f.present()
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 15 })
  f.clock.jump(1000)
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 15 })
  f.clock.jump(1000)
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 14 })
  f.present()
  f.clock.jump(13_199)
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 1 })
  assert.equal(f.reads.length, 0)
  f.clock.jump(1)
  await settle()
  assert.equal(f.reads.length, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(f.view(), undefined)
})

test("a late monotonic clock jump expires the original deadline instead of extending it", async (t) => {
  const f = fixture(t, { options: { autoApproveDelaySeconds: 3 } })
  await f.add()
  f.present()
  f.clock.jump(3100)
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 1 })
  f.present()
  f.clock.jump(20_000)
  await settle()
  assert.equal(f.reads.length, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(f.clock.pending, 0)
})

for (const delay of [1, 5, 3600]) test(`${delay}-second countdown adds exactly 200ms and updates at remaining-time boundaries`, async t => {
  const f = fixture(t, { options: { autoApproveDelaySeconds: delay } })
  await f.add(); f.present()
  const displayed = () => f.view()?.autoApproval
  assert.deepEqual(displayed(), { status: "countdown", seconds: delay })
  f.clock.jump(1199)
  assert.deepEqual(displayed(), { status: "countdown", seconds: delay })
  assert.equal(f.writes.length, 0)
  if (delay > 1) {
    f.clock.jump(1)
    assert.deepEqual(displayed(), { status: "countdown", seconds: delay - 1 })
    f.clock.jump((delay - 1) * 1000 - 1)
  }
  assert.equal(f.writes.length, 0)
  f.clock.jump(1); await settle()
  assert.equal(f.writes.length, 1)
  assert.equal(f.view(), undefined)
  assert.ok(f.publications.every(views => views.every(view => view.autoApproval?.status !== "countdown" || view.autoApproval.seconds <= delay)))
})

test("zero delay is deferred and still verifies a fresh request before allowing once", async (t) => {
  const fresh = deferred<PermissionRequest[]>()
  const reply = deferred<void>()
  const f = fixture(t, { options: { autoApproveDelaySeconds: 0 }, transport: { list: () => fresh.promise, once: () => reply.promise } })
  await f.add()
  f.present()
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 0 })
  assert.equal(f.reads.length, 0)
  f.clock.jump(0)
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "checking")
  assert.equal(f.writes.length, 0)
  // New object identity and property order must not invalidate equivalent evidence.
  const original = request()
  const { metadata, ...rest } = structuredClone(original)
  fresh.resolve([{ metadata, ...rest }])
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "allowing")
  assert.equal(f.reads.length, 1)
  assert.deepEqual(f.writes.map((item) => item.request), [original])
  assert.ok(remainingTime(f.writes[0]!.signal) <= remainingTime(f.reads[0]!) + 1,
    "separate acknowledgement signal retains only the original verification time")
  reply.resolve()
  await settle()
  assert.equal(f.view(), undefined)
  assert.deepEqual(f.publications.flatMap((views) => views[0]?.autoApproval ? [views[0].autoApproval.status] : []), ["countdown", "checking", "allowing"])
})

for (const delay of [0, 15]) test(`cancel beats an already queued ${delay}-second countdown callback`, async (t) => {
  const f = fixture(t, { options: { autoApproveDelaySeconds: delay } })
  await f.add()
  f.present()
  const queued = f.clock.dequeueAfter(delay * 1000 + (delay > 0 ? 200 : 0))
  assert.equal(queued.length, 1)
  f.controller.cancelAutoApproval("b-review")
  for (const callback of queued) callback()
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  assert.equal(f.reads.length, 0)
  assert.equal(f.writes.length, 0)
})

test("shared-tool directory, bash and edit stages require their own native-first presentation and full delay", async (t) => {
  const f = fixture(t, { options: { autoApproveDelaySeconds: 2 } })
  const stages = [request("a-directory", "external_directory"), request("b-bash"), request("c-edit", "edit")]
  for (const req of stages.toReversed()) await f.add(req)
  assert.equal(f.visible(), stages[0]!.id)
  for (const req of stages.slice(1)) {
    f.controller.presented(req.id)
    await f.controller.approveNow(req.id)
    assert.equal(f.view(req.id)?.autoApproval, undefined)
  }
  for (const [index, req] of stages.entries()) {
    assert.equal(f.visible(), req.id)
    assert.equal(f.view(req.id)?.autoApproval, undefined)
    f.clock.jump(30_000)
    assert.equal(f.reads.length, index, "waiting while queued must not consume this ID's delay")
    f.present()
    f.clock.jump(1000)
    assert.deepEqual(f.view(req.id)?.autoApproval, { status: "countdown", seconds: 2 })
    f.clock.jump(200)
    assert.deepEqual(f.view(req.id)?.autoApproval, { status: "countdown", seconds: 1 })
    assert.equal(f.writes.length, index)
    f.clock.jump(1000)
    await settle()
    assert.equal(f.view(req.id), undefined)
    assert.equal(f.writes.length, index + 1)
  }
  assert.deepEqual(f.writes.map((write) => write.request), stages)
})

for (const blocker of ["unrelated", "disabled", "identifying"] as const) test(`${blocker} native-first child blocks a queued Safe root review from starting approval`, async (t) => {
  const pending = deferred<Assessment>()
  const f = fixture(t, {
    options: { reviewEdits: blocker !== "disabled" },
    evaluate: (req) => req.permission === "external_directory" ? pending.promise : Promise.resolve(safe),
  })
  await f.add()
  const first = request("z-child", blocker === "unrelated" ? "read" : blocker === "disabled" ? "edit" : "external_directory", "child")
  await f.add(first)
  assert.equal(f.visible(), undefined, "session order takes precedence over request ID")
  f.controller.presented("b-review")
  await f.controller.approveNow("b-review")
  f.clock.jump(30_000)
  assert.equal(f.view()?.autoApproval, undefined)
  assert.equal(f.reads.length, 0)
  assert.equal(f.writes.length, 0)
  f.controller.replied(first.id)
  pending.resolve(safe) // Disposal now drains even removed review workers.
  f.host.pending = [request()]
  f.present()
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 15 })
  await f.controller.approveNow("b-review")
  assert.equal(f.writes.length, 1)
})

test("cancellation is durable across presentation, remount, duplicate asks and equivalent reconciliation", async (t) => {
  const f = fixture(t)
  await f.add()
  f.present()
  f.controller.cancelAutoApproval("b-review")
  const assessment = f.view()?.assessment
  for (let i = 0; i < 3; i++) {
    f.controller.presented()
    f.controller.asked(structuredClone(request()))
    f.controller.reconcile([structuredClone(request())], f.controller.revision)
    f.present()
    await f.controller.approveNow("b-review")
    f.clock.jump(60_000)
  }
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  assert.equal(f.view()?.assessment, assessment)
  assert.equal(f.evaluated.length, 1)
  assert.equal(f.reads.length, 0)
  assert.equal(f.writes.length, 0)
  f.controller.replied("b-review")
  f.host.pending = []
  await f.add(request("c-new"))
  f.present()
  await f.controller.approveNow("c-new")
  assert.deepEqual(f.writes.map((item) => item.request.id), ["c-new"])
})

for (const effect of ["cancel", "dispose"] as const) test(`synchronous ${effect} on a countdown publication leaves no timer behind`, async (t) => {
  const f = fixture(t, { changed: (views, controller) => {
    if (views.some((view) => view.autoApproval?.status === "countdown")) {
      if (effect === "cancel") controller.cancelAutoApproval("b-review")
      else controller.dispose()
    }
  } })
  await f.add()
  f.present()
  assert.equal(f.clock.pending, 0)
  assert.equal(f.reads.length, 0)
  assert.equal(f.writes.length, 0)
})

for (const notified of [true, false]) test(`hidden countdown cancels ${notified ? "on presentation loss" : "using freshly recomputed visibility"}`, async (t) => {
  const f = fixture(t)
  await f.add()
  f.present()
  f.host.shown = false
  if (notified) f.present()
  f.clock.jump(16_000)
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  f.host.shown = true
  f.present()
  await f.controller.approveNow("b-review")
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  assert.equal(f.reads.length, 0)
  assert.equal(f.writes.length, 0)
})

for (const notified of [true, false]) test(`hiding during a noncooperative fresh read blocks writing ${notified ? "with" : "without"} a presentation effect`, async (t) => {
  const fresh = deferred<PermissionRequest[]>()
  const f = fixture(t, { transport: { list: () => fresh.promise, once: async () => {} } })
  await f.add()
  f.present()
  const operation = f.controller.approveNow("b-review")
  await settle()
  f.host.shown = false
  if (notified) f.present()
  fresh.resolve([request()])
  await operation
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  assert.equal(f.reads[0]?.aborted, true)
  assert.equal(f.reads.length, 1)
  assert.equal(f.writes.length, 0)
  f.host.shown = true
  f.present()
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
})

type Removal = "cancel" | "reply" | "delete" | "dispose"
function remove(controller: Controller, removal: Removal) {
  if (removal === "cancel") controller.cancelAutoApproval("b-review")
  else if (removal === "reply") controller.replied("b-review")
  else if (removal === "delete") controller.deleted("root")
  else controller.dispose()
}

for (const removal of ["reply", "delete", "dispose"] as const) test(`${removal} defeats an already dequeued countdown timer`, async (t) => {
  const f = fixture(t)
  await f.add()
  f.present()
  const queued = f.clock.dequeueAfter(16_000)
  assert.equal(queued.length, 1)
  remove(f.controller, removal)
  const publications = f.publications.length
  queued[0]!()
  f.controller.presented("b-review")
  await f.controller.approveNow("b-review")
  await settle()
  assert.equal(f.publications.length, publications)
  assert.deepEqual(f.controller.views, [])
  assert.equal(f.reads.length, 0)
  assert.equal(f.writes.length, 0)
  assert.equal(f.clock.pending, 0)
})

for (const removal of ["cancel", "reply", "delete", "dispose"] as const) {
  for (const outcome of ["resolve", "reject"] as const) test(`${removal} aborts a noncooperative list and ignores its late ${outcome}`, async (t) => {
    const fresh = deferred<PermissionRequest[]>()
    const f = fixture(t, { transport: { list: () => fresh.promise, once: async () => {} } })
    await f.add()
    f.present()
    const operation = f.controller.approveNow("b-review")
    await settle()
    assert.equal(f.view()?.autoApproval?.status, "checking")
    remove(f.controller, removal)
    assert.equal(f.reads[0]?.aborted, true)
    await operation // Cancellation must settle without the transport's cooperation.
    const publications = f.publications.length
    if (outcome === "resolve") fresh.resolve([request()])
    else fresh.reject(new Error("Late private HTTP error"))
    await settle()
    f.clock.jump(60_000)
    assert.equal(f.publications.length, publications)
    assert.equal(f.reads.length, 1, "cancelled work must not launch recovery reads")
    assert.equal(f.writes.length, 0)
    assert.equal(f.clock.pending, 0)
    if (removal === "cancel") assert.equal(f.view()?.autoApproval?.status, "cancelled")
    else assert.deepEqual(f.controller.views, [])
  })
}

for (const removal of ["reply", "delete", "dispose"] as const) {
  for (const outcome of ["resolve", "reject"] as const) test(`${removal} while once is outstanding suppresses late ${outcome}, failure and resurrection`, async (t) => {
    const reply = deferred<void>()
    const f = fixture(t, { transport: { list: async () => [request()], once: () => reply.promise } })
    await f.add()
    f.present()
    const operation = f.controller.approveNow("b-review")
    await settle()
    assert.equal(f.view()?.autoApproval?.status, "allowing")
    assert.equal(f.writes.length, 1)
    remove(f.controller, removal)
    assert.equal(f.writes[0]?.signal.aborted, removal !== "reply",
      "native resolution retains only the bounded dispatched acknowledgement")
    await operation
    const publications = f.publications.length
    if (outcome === "resolve") reply.resolve()
    else reply.reject(new Error("HTTP response arrived after native resolution"))
    await settle()
    assert.equal(f.publications.length, publications)
    assert.deepEqual(f.controller.views, [])
    assert.equal(f.reads.length, 1)
    assert.equal(f.writes.length, 1)
    assert.equal(f.publications.some((views) => views.some((view) => view.autoApproval?.status === "failed")), false)
  })
}

test("duplicate clicks racing expiry are single-flight through checking and allowing", async (t) => {
  const fresh = deferred<PermissionRequest[]>()
  const reply = deferred<void>()
  const f = fixture(t, { transport: { list: () => fresh.promise, once: () => reply.promise } })
  await f.add()
  f.present()
  const expiry = f.clock.dequeueAfter(16_000)
  const operation = f.controller.approveNow("b-review")
  expiry[0]!()
  await Promise.all([f.controller.approveNow("b-review"), f.controller.approveNow("b-review")])
  assert.equal(f.reads.length, 1)
  assert.equal(f.writes.length, 0)
  fresh.resolve([request()])
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "allowing")
  // Once submitted, a local cancel cannot unsend the native reply or enable another.
  f.controller.cancelAutoApproval("b-review")
  f.present()
  expiry[0]!()
  await f.controller.approveNow("b-review")
  assert.equal(f.view()?.autoApproval?.status, "allowing")
  assert.equal(f.writes[0]?.signal.aborted, false)
  assert.equal(f.writes.length, 1)
  reply.resolve()
  await operation
  await f.controller.approveNow("b-review")
  assert.equal(f.reads.length, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(f.view(), undefined)
})

test("fresh-list disappearance resolves the review without replying", async (t) => {
  const f = fixture(t, { transport: { list: async () => [], once: async () => {} } })
  await f.add()
  f.present()
  await f.controller.approveNow("b-review")
  assert.equal(f.view(), undefined)
  assert.equal(f.reads.length, 1)
  assert.equal(f.writes.length, 0)
  assert.equal(f.clock.pending, 0)
})

const changedScopes: [string, (req: PermissionRequest) => void][] = [
  ["patterns", (req) => { req.patterns.push("/unreviewed/**") }],
  ["nested metadata", (req) => { req.metadata.nested = { scope: ["secret.txt"] } }],
  ["remembered patterns", (req) => { req.always = ["*"] }],
  ["permission kind", (req) => { req.permission = "edit" }],
  ["session", (req) => { req.sessionID = "child" }],
  ["tool identity", (req) => { req.tool = { callID: "new-call", messageID: "new-message" } }],
]
for (const [name, change] of changedScopes) test(`same-ID changed ${name} invalidates approval and is never retried`, async (t) => {
  const altered = request()
  change(altered)
  const f = fixture(t, { transport: { list: async () => [altered], once: async () => {} } })
  await f.add()
  f.present()
  await f.controller.approveNow("b-review")
  assert.equal(f.view()?.autoApproval?.status, "failed")
  assert.equal(f.view()?.status, "complete")
  assert.equal(f.view()?.assessment, safe)
  assert.equal(f.view()?.error, undefined)
  assert.deepEqual(f.view()?.request, request())
  assert.equal(f.reads.length, 2, "only a fresh verification and a read-only recovery")
  f.controller.reconcile([request()], f.controller.revision)
  f.controller.presented()
  f.present()
  f.clock.jump(60_000)
  await f.controller.approveNow("b-review")
  assert.equal(f.reads.length, 2)
  assert.equal(f.writes.length, 0)
})

for (const event of ["new request", "unknown reply", "unknown deletion"] as const) test(`${event} rejects stale snapshots and recovers through bounded fresh verification`, async (t) => {
  const fresh = deferred<PermissionRequest[]>()
  const recovery = deferred<PermissionRequest[]>()
  const latest = deferred<PermissionRequest[]>()
  let reads = 0
  const f = fixture(t, { transport: { list: () => [fresh, recovery, latest][reads++]!.promise, once: async () => {} } })
  await f.add()
  f.present()
  const operation = f.controller.approveNow("b-review")
  await settle()
  const revision = f.controller.revision
  if (event === "new request") f.controller.asked(request("z-new"))
  else if (event === "unknown reply") f.controller.replied("unknown")
  else f.controller.deleted("unknown-session")
  assert.ok(f.controller.revision > revision)
  fresh.resolve([request()])
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "checking")
  assert.equal(f.writes.length, 0)
  assert.equal(f.reads.length, 2)
  if (event === "new request") assert.ok(f.view("z-new"), "stale verification cannot erase the newer request")
  // Even the recovery read is revision guarded; it must not erase this new event.
  f.controller.asked(request("z-recovery-event"))
  recovery.resolve([request()])
  await settle()
  assert.ok(f.view("z-recovery-event"))
  assert.equal(f.view()?.autoApproval?.status, "checking")
  assert.equal(f.reads.length, 3)
  latest.resolve(f.controller.views.map(view => structuredClone(view.request)))
  await operation
  assert.equal(f.writes.length, 1)
  assert.ok(f.view("z-recovery-event"))
  if (event === "new request") assert.ok(f.view("z-new"))
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
})

for (const source of ["fresh list", "native visibility"] as const) test(`post-list native-first blocker from ${source} prevents once despite stale presentation`, async (t) => {
  const fresh = deferred<PermissionRequest[]>()
  const f = fixture(t, { transport: { list: () => fresh.promise, once: async () => {} } })
  await f.add()
  f.present()
  const operation = f.controller.approveNow("b-review")
  await settle()
  const blocker = request("a-blocker", "read")
  if (source === "native visibility") f.host.extra = [{ request: blocker, status: "unrelated" }]
  fresh.resolve(source === "fresh list" ? [request(), blocker] : [request()])
  await operation
  assert.equal(f.visible(), undefined)
  assert.equal(f.view()?.autoApproval?.status, "cancelled")
  assert.equal(f.writes.length, 0)
  assert.equal(f.reads.length, 1)
  if (source === "fresh list") assert.equal(f.view(blocker.id)?.status, "unrelated")
})

for (const effect of ["hide", "reply", "delete", "dispose"] as const) test(`synchronous ${effect} when allowing is published still prevents a write`, async (t) => {
  const f = fixture(t, { changed: (views, controller) => {
    if (views.some((view) => view.autoApproval?.status === "allowing")) {
      if (effect === "hide") { f.host.shown = false; controller.presented() }
      else remove(controller, effect)
    }
  } })
  await f.add()
  f.present()
  await f.controller.approveNow("b-review")
  assert.equal(f.writes.length, 0)
  assert.equal(f.reads.length, 1)
  if (effect === "hide") assert.equal(f.view()?.autoApproval?.status, "cancelled")
  else assert.deepEqual(f.controller.views, [])
})

test("five-second verification deadline retains noncooperative list ownership without overlapping recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const fresh = deferred<PermissionRequest[]>()
  const recovery = deferred<PermissionRequest[]>()
  let reads = 0
  const f = fixture(t, { transport: { list: () => ++reads === 1 ? fresh.promise
    : reads === 2 ? recovery.promise : Promise.resolve([request()]), once: async () => {} } })
  await f.add()
  f.present()
  const operation = f.controller.approveNow("b-review")
  await settle()
  t.mock.timers.tick(4999)
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "checking")
  assert.equal(f.reads[0]?.aborted, false)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "checking")
  assert.equal(f.reads[0]?.aborted, true)
  assert.equal(f.reads.length, 1, "a timed-out unsettled read still owns the read slot")
  await operation
  const oldRevision = f.controller.revision
  for (let i = 0; i < 20; i++) {
    f.controller.reconcile([request()], f.controller.revision); f.present()
  }
  assert.equal(reads, 1, "polls and frames cannot release unsettled verification")
  fresh.resolve([request()])
  await settle()
  assert.equal(reads, 2, "only actual settlement permits a bounded fresh recovery read")
  f.controller.reconcile([request()], oldRevision); f.present()
  assert.equal(f.view()?.assessment, safe)
  assert.equal(f.view()?.autoApproval?.status, "checking")
  assert.equal(f.writes.length, 0)
  recovery.resolve([structuredClone(request())]); await settle(); f.present()
  assert.deepEqual(f.view()?.autoApproval, { status: "countdown", seconds: 15 })
  f.clock.jump(15199); await settle(); assert.equal(f.writes.length, 0)
  f.clock.jump(1); await settle()
  assert.equal(reads, 3); assert.equal(f.writes.length, 1)
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [
    ["settled", "not-sent"], ["dispatched", undefined], ["confirmed", undefined], ["settled", undefined],
  ])
})

test("stale-read retry shares the original five-second budget and never overlaps an unsettled read", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const first = deferred<PermissionRequest[]>(), second = deferred<PermissionRequest[]>()
  let reads = 0, active = 0, maximum = 0
  const f = fixture(t, { transport: {
    list: async () => {
      maximum = Math.max(maximum, ++active)
      try { return await (++reads === 1 ? first.promise : reads === 2 ? second.promise : Promise.resolve([request()])) }
      finally { active-- }
    }, once: async () => {},
  } })
  await f.add(); f.present()
  const operation = f.controller.approveNow("b-review", true)
  await settle(); t.mock.timers.tick(4000)
  f.controller.replied("unrelated")
  first.resolve([request()]); await settle()
  assert.equal(reads, 2)
  assert.equal(maximum, 1)
  assert.equal(f.view()?.autoApproval?.status, "checking")
  assert.equal(f.reads[1], f.reads[0], "retry uses the original verification signal/deadline")
  t.mock.timers.tick(999); await settle()
  assert.equal(f.reads[1]!.aborted, false)
  t.mock.timers.tick(1); await operation
  assert.equal(f.reads[1]!.aborted, true)
  assert.equal(reads, 2, "timeout cannot launch a recovery read over unsettled I/O")
  assert.equal(active, 1)
  assert.equal(f.writes.length, 0)
  second.resolve([request()]); await settle()
  assert.equal(active, 0)
  assert.equal(f.writes.length, 0, "late settlement cannot dispatch")
  assert.equal(reads, 3, "recovery receives a new read only after actual settlement")
  f.present(); f.clock.jump(15200); await settle()
  assert.equal(reads, 4); assert.equal(maximum, 1); assert.equal(f.writes.length, 1)
})

test("old resolved read-slot timeout recovers the new request only after old I/O settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const oldRead = deferred<PermissionRequest[]>()
  let reads = 0, active = 0, maximum = 0
  const f = fixture(t, { transport: { list: async () => {
    maximum = Math.max(maximum, ++active)
    try { return ++reads === 1 ? await oldRead.promise : [request("c-new")] }
    finally { active-- }
  }, once: async () => {} } })
  await f.add(); f.present()
  const old = f.controller.approveNow("b-review", true)
  await settle(); f.controller.replied("b-review"); await old
  await f.add(request("c-new")); f.present()
  const next = f.controller.approveNow("c-new", true)
  await settle(); t.mock.timers.tick(5000); await next
  assert.equal(reads, 1); assert.equal(f.writes.length, 0)
  assert.equal(f.view("c-new")?.autoApproval?.status, "checking")
  for (let i = 0; i < 20; i++) {
    f.controller.reconcile([request("c-new")], f.controller.revision); f.present()
  }
  assert.equal(reads, 1)
  oldRead.resolve([request()]); await settle()
  assert.equal(reads, 2); assert.equal(maximum, 1)
  assert.equal(f.view(), undefined, "late old snapshot cannot resurrect a resolved review")
  f.present(); f.clock.jump(15200); await settle()
  assert.equal(reads, 3); assert.equal(maximum, 1)
  assert.deepEqual(f.writes.map(write => write.request.id), ["c-new"])
})

for (const outcome of ["resolve", "reject"] as const) test(`canceled verification owns its read across a newer approval until late ${outcome}`, async t => {
  const first = deferred<PermissionRequest[]>()
  let reads = 0, active = 0, maximum = 0
  const f = fixture(t, { transport: {
    list: async () => {
      maximum = Math.max(maximum, ++active)
      try { return ++reads === 1 ? await first.promise : [request("c-new")] }
      finally { active-- }
    }, once: async () => {},
  } })
  await f.add(); f.present()
  const old = f.controller.approveNow("b-review", true)
  await settle(); f.controller.replied("b-review"); await old
  await f.add(request("c-new")); f.present()
  const next = f.controller.approveNow("c-new", true)
  await settle()
  assert.equal(reads, 1)
  assert.equal(active, 1)
  if (outcome === "resolve") first.resolve([request()])
  else first.reject(Error("late read error"))
  await next
  assert.equal(reads, 2)
  assert.equal(maximum, 1)
  assert.equal(active, 0)
  assert.deepEqual(f.writes.map(write => write.request.id), ["c-new"])
})

for (const effect of ["hide", "blocker", "disable", "reply", "delete", "dispose", "cancel", "changed scope"] as const) {
  test(`fresh retry after unrelated churn still prevents dispatch on ${effect}`, async t => {
    const first = deferred<PermissionRequest[]>(), next = deferred<PermissionRequest[]>()
    let reads = 0
    const f = fixture(t, { transport: {
      list: () => ++reads === 1 ? first.promise : next.promise, once: async () => {},
    } })
    await f.add(); f.present()
    const operation = f.controller.approveNow("b-review", true)
    await settle(); f.controller.replied("unrelated"); first.resolve([request()]); await settle()
    assert.equal(f.reads.length, 2)
    assert.equal(f.view()?.autoApproval?.status, "checking")
    if (effect === "hide") { f.host.shown = false; f.present() }
    else if (effect === "blocker") f.controller.asked(request("z-child", "read", "child"))
    else if (effect === "disable") f.mode(false)
    else if (effect !== "changed scope") remove(f.controller, effect)
    const current = request()
    if (effect === "changed scope") current.metadata.command = "different command"
    next.resolve([current]); await operation
    assert.equal(f.writes.length, 0)
    assert.equal(f.facts.some(fact => fact.type === "dispatched" || fact.type === "confirmed"), false)
    if (effect === "changed scope") {
      assert.equal(f.view()?.autoApproval?.status, "failed")
      f.present(); await f.controller.approveNow("b-review", true)
      assert.equal(f.writes.length, 0)
    }
  })
}

test("an unrelated event in the deferred dispatch gap requires another fresh list before once", async t => {
  const next = deferred<PermissionRequest[]>()
  let queued = false, reads = 0
  const f = fixture(t, {
    changed: views => {
      if (queued || !views.some(view => view.autoApproval?.status === "allowing")) return
      queued = true
      queueMicrotask(() => f.controller.asked(request("z-later")))
    },
    transport: { list: () => ++reads === 1 ? Promise.resolve([request()]) : next.promise, once: async () => {} },
  })
  await f.add(); f.present()
  const operation = f.controller.approveNow("b-review", true)
  await settle()
  assert.equal(reads, 2)
  assert.equal(f.writes.length, 0)
  assert.ok(f.view("z-later"))
  assert.equal(f.view()?.autoApproval?.status, "checking")
  next.resolve([request(), request("z-later")]); await operation
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.facts.map(fact => fact.type), ["dispatched", "confirmed", "settled"])
})

test("a synchronous once throw is a single uncertain invocation, even when its observer reenters", async t => {
  const observed: number[] = []
  const f = fixture(t, { transport: { list: async () => [request()], once: () => { throw Error("uncertain") } },
    observer: fact => {
      if (fact.type !== "dispatched") return
      observed.push(f.writes.length); f.controller.cancelAutoApproval("b-review")
    },
  })
  await f.add(); f.present(); await f.controller.approveNow("b-review", true)
  assert.deepEqual(observed, [1])
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["dispatched", undefined], ["settled", "uncertain"]])
  f.mode(false); f.mode(true); f.controller.reconcile([request()], f.controller.revision); await settle()
  f.present(); await f.controller.approveNow("b-review", true)
  assert.equal(f.writes.length, 1)
  assert.equal(f.view()?.autoApproval?.status, "failed")
})

for (const effect of ["hide", "blocker", "disable", "reply", "delete", "dispose", "cancel"] as const) {
  test(`dispatch reservation: microtask ${effect} before once sends nothing and emits no dispatch facts`, async t => {
    let queued = false
    const f = fixture(t, { changed: views => {
      if (queued || !views.some(view => view.autoApproval?.status === "allowing")) return
      queued = true
      queueMicrotask(() => {
        if (effect === "hide") { f.host.shown = false; f.present() }
        else if (effect === "blocker") f.controller.asked(request("z-child", "read", "child"))
        else if (effect === "disable") f.mode(false)
        else remove(f.controller, effect)
      })
    } })
    await f.add(); f.present(); await f.controller.approveNow("b-review", true); await settle()
    assert.equal(queued, true)
    assert.equal(f.writes.length, 0)
    assert.equal(f.facts.some(fact => fact.type === "dispatched" || fact.type === "confirmed"), false)
    assert.ok(f.facts.every(fact => fact.type === "settled" && fact.result === "not-sent"))
    assert.ok(f.controller.views.every(view => !view.retained))
    if (["hide", "blocker", "cancel"].includes(effect)) {
      assert.equal(f.view()?.autoApproval?.status, "cancelled")
      f.host.shown = true; f.controller.replied("z-child"); f.present()
      await f.controller.approveNow("b-review", true)
      assert.equal(f.writes.length, 0, "actual cancellation stays durable")
    }
    if (effect === "disable") {
      f.mode(true); f.controller.reconcile([request()], f.controller.revision); await settle(); f.present()
      assert.equal(f.view()?.autoApproval?.status, "cancelled", "reservation is canceled, never an uncertain write")
    }
  })
}

for (const effect of ["hide", "disable", "reply", "delete", "dispose"] as const) {
  test(`dispatch observer sees an actual invocation before synchronous ${effect}`, async t => {
    const observations: number[] = []
    const f = fixture(t, { observer: fact => {
      if (fact.type !== "dispatched") return
      observations.push(f.writes.length)
      if (effect === "hide") { f.host.shown = false; f.present() }
      else if (effect === "disable") f.mode(false)
      else remove(f.controller, effect)
    } })
    await f.add(); f.present(); await f.controller.approveNow("b-review", true); await settle()
    assert.deepEqual(observations, [1], "a dispatch observer must never describe a merely reserved write")
    assert.equal(f.writes.length, 1)
    assert.equal(f.facts.filter(fact => fact.type === "dispatched").length, 1)
    assert.equal(f.facts.some(fact => fact.result === "not-sent"), false)
    assert.equal(f.facts.filter(fact => fact.type === "confirmed").length, ["hide", "reply"].includes(effect) ? 1 : 0)
  })
}

test("fresh read and once share one five-second deadline; a timed-out write is never retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const fresh = deferred<PermissionRequest[]>()
  const reply = deferred<void>()
  let reads = 0
  const f = fixture(t, { transport: { list: () => ++reads === 1 ? fresh.promise : Promise.resolve([request()]), once: () => reply.promise } })
  await f.add()
  f.present()
  const operation = f.controller.approveNow("b-review")
  await settle()
  t.mock.timers.tick(4000)
  fresh.resolve([request()])
  await settle()
  assert.equal(f.view()?.autoApproval?.status, "allowing")
  t.mock.timers.tick(999)
  await settle()
  assert.equal(f.writes[0]?.signal.aborted, false)
  t.mock.timers.tick(1)
  await operation
  assert.equal(f.writes[0]?.signal.aborted, true)
  assert.equal(f.view()?.autoApproval?.status, "failed")
  assert.equal(f.view()?.assessment, safe)
  assert.equal(f.view()?.status, "complete")
  reply.resolve()
  await settle()
  f.present()
  await f.controller.approveNow("b-review")
  f.clock.jump(60_000)
  assert.equal(f.reads.length, 2)
  assert.equal(f.writes.length, 1)
  assert.equal(f.view()?.autoApproval?.status, "failed")
})

const directory = "/instance/review café & fixtures"
function sdkTransport(respond: (request: Request, index: number) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init)
    requests.push(req)
    return respond(req, requests.length - 1)
  }
  const client = createOpencodeClient({ baseUrl: "http://host.invalid", directory, fetch: fetcher })
  return { transport: approvalTransport(client, directory), requests }
}

for (const failure of ["HTTP", "network", "unconfirmed acknowledgement", "unknown thrown value"] as const) {
  test(`${failure} during once preserves assessment, exposes only generic failure, and never retries`, async (t) => {
    const sdk = sdkTransport((req) => {
      if (req.method === "GET") return Response.json([request()])
      if (failure === "HTTP") return Response.json({ name: "InternalError", data: { message: "PRIVATE HTTP detail" } }, { status: 503 })
      if (failure === "network") throw new TypeError("PRIVATE network detail")
      if (failure === "unknown thrown value") throw { private: "unknown transport outcome" }
      return Response.json(false)
    })
    const f = fixture(t, { transport: sdk.transport })
    await f.add()
    f.present()
    const before = f.view()!
    await f.controller.approveNow("b-review")
    assert.deepEqual(f.view(), { ...before, autoApproval: { status: "failed" }, approvalPendingConfirmed: true })
    assert.deepEqual(sdk.requests.map((req) => req.method), ["GET", "POST", "GET"])
    assert.equal(f.reads.length, 2)
    assert.equal(f.writes.length, 1)
    f.controller.reconcile([request()], f.controller.revision)
    f.controller.presented()
    f.present()
    f.controller.cancelAutoApproval("b-review")
    await f.controller.approveNow("b-review")
    f.clock.jump(60_000)
    assert.deepEqual(f.view(), { ...before, autoApproval: { status: "failed" }, approvalPendingConfirmed: true })
    assert.equal(sdk.requests.length, 3)
    assert.equal(JSON.stringify(f.publications).includes("PRIVATE"), false)
  })
}

test("unknown verification and recovery errors wait for fresh reconciliation, never frames", async (t) => {
  const f = fixture(t, { transport: { list: async () => { throw undefined }, once: async () => {} } })
  await f.add()
  f.present()
  const before = f.view()!
  await f.controller.approveNow("b-review")
  assert.deepEqual(f.view(), { ...before, autoApproval: { status: "checking" } })
  for (let i = 0; i < 20; i++) {
    f.present(); await f.controller.approveNow("b-review")
  }
  assert.equal(f.reads.length, 2)
  assert.equal(f.writes.length, 0)
  f.controller.reconcile([request()], f.controller.revision); f.present()
  assert.equal(f.view()?.autoApproval?.status, "countdown")
})

test("SDK verification GET 503 recovers with a fresh identical request and exactly one once", async t => {
  const sdk = sdkTransport((req, index) => index === 0
    ? Response.json({ name: "Error", data: { message: "PRIVATE" } }, { status: 503 })
    : Response.json(req.method === "GET" ? [request()] : true))
  const f = fixture(t, { transport: sdk.transport })
  await f.add(); f.present(); await f.controller.approveNow("b-review", true)
  assert.deepEqual(sdk.requests.map(req => req.method), ["GET", "GET"])
  assert.equal(f.view()?.assessment, safe)
  assert.equal(f.view()?.autoApproval, undefined)
  assert.deepEqual(f.facts.map(fact => [fact.type, fact.result]), [["settled", "not-sent"]])
  f.present(); f.clock.jump(15200); await settle()
  assert.deepEqual(sdk.requests.map(req => req.method), ["GET", "GET", "GET", "POST"])
  assert.equal(f.writes.length, 1)
  assert.equal(JSON.stringify(f.publications).includes("PRIVATE"), false)
})

for (const effect of ["cancel", "hide", "disable", "changed scope"] as const) {
  test(`read-only recovery cannot revive ${effect}, even after identical reconciliation returns`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const read = deferred<PermissionRequest[]>()
    const f = fixture(t, { transport: { list: () => read.promise, once: async () => {} } })
    await f.add(); f.present()
    const operation = f.controller.approveNow("b-review", true)
    await settle(); t.mock.timers.tick(5000); await operation
    if (effect === "cancel") f.controller.cancelAutoApproval("b-review")
    if (effect === "hide") { f.host.shown = false; f.present() }
    if (effect === "disable") f.mode(false)
    if (effect === "changed scope") {
      const changed = request(); changed.metadata.command = "unreviewed command"
      f.controller.reconcile([changed], f.controller.revision)
    }
    read.resolve([request()]); await settle()
    f.host.shown = true
    if (effect === "disable") f.mode(true)
    f.controller.reconcile([request()], f.controller.revision); await settle()
    f.present(); f.clock.jump(60000); await settle()
    assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 1)
    assert.equal(f.view()?.autoApproval?.status, effect === "changed scope" ? "failed" : "cancelled")
  })
}

test("bounded recovery timeout retains its own I/O and requires a post-settlement poll", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const recovery = deferred<PermissionRequest[]>()
  let reads = 0
  const f = fixture(t, { transport: { list: () => ++reads === 1 ? Promise.reject(Error("GET 503"))
    : reads === 2 ? recovery.promise : Promise.resolve([request()]), once: async () => {} } })
  await f.add(); f.present()
  const operation = f.controller.approveNow("b-review", true)
  await settle(); assert.equal(reads, 2)
  t.mock.timers.tick(5000); await operation
  const beforeSettlement = f.controller.revision
  f.controller.reconcile([request()], beforeSettlement); f.present()
  assert.equal(f.view()?.autoApproval?.status, "checking")
  recovery.resolve([request()]); await settle()
  f.controller.reconcile([request()], beforeSettlement); f.present()
  assert.equal(f.view()?.autoApproval?.status, "checking", "an earlier poll cannot release recovery")
  for (let i = 0; i < 20; i++) f.present()
  assert.equal(reads, 2)
  f.controller.reconcile([request()], f.controller.revision); f.present(); f.clock.jump(15200); await settle()
  assert.equal(f.writes.length, 1); assert.equal(reads, 3)
})

test("uncertain acknowledgement reconciles a disappeared permission without retrying once", async (t) => {
  const sdk = sdkTransport((req, index) => req.method === "POST" ? Response.json(null) : Response.json(index === 0 ? [request()] : []))
  const f = fixture(t, { transport: sdk.transport })
  await f.add()
  f.present()
  await f.controller.approveNow("b-review")
  assert.equal(f.view(), undefined)
  assert.deepEqual(sdk.requests.map((req) => req.method), ["GET", "POST", "GET"])
  assert.equal(f.writes.length, 1)
})

test("real SDK adapter targets the instance directory and sends exactly one once-only reply body", async () => {
  const sdk = sdkTransport((req) => Response.json(req.method === "GET" ? [request()] : true))
  const abort = new AbortController()
  assert.deepEqual(await sdk.transport.list(abort.signal), [request()])
  assert.equal(await sdk.transport.once(request(), abort.signal), undefined)
  assert.equal(sdk.requests.length, 2)
  const [list, reply] = sdk.requests as [Request, Request]
  for (const req of sdk.requests) {
    const url = new URL(req.url)
    assert.equal(url.origin, "http://host.invalid")
    assert.deepEqual([...url.searchParams], [["directory", directory]])
    assert.equal(req.signal.aborted, false)
    assert.equal(req.url.includes("/tool/target"), false)
  }
  assert.equal(list.method, "GET")
  assert.equal(new URL(list.url).pathname, "/permission")
  assert.equal(list.headers.get("x-opencode-directory"), null, "SDK relocates GET instance header into query")
  assert.equal(list.body, null)
  assert.equal(reply.method, "POST")
  assert.equal(new URL(reply.url).pathname, "/permission/b-review/reply")
  assert.equal(reply.headers.get("x-opencode-directory"), encodeURIComponent(directory))
  assert.equal(reply.headers.get("content-type"), "application/json")
  assert.deepEqual(await reply.json(), { reply: "once" }, "no message, reject, always, scope, or rule-writing fields")
  abort.abort()
  assert.ok(list.signal.aborted)
  assert.ok(reply.signal.aborted)
})

test("adapter accepts an empty pending list", async () => {
  const sdk = sdkTransport(() => Response.json([]))
  assert.deepEqual(await sdk.transport.list(new AbortController().signal), [])
  assert.equal(sdk.requests.length, 1)
})

const invalidLists: [string, () => Response][] = [
  ["null", () => Response.json(null)],
  ["false", () => Response.json(false)],
  ["object", () => Response.json({})],
  ["string", () => Response.json("pending")],
  ["true", () => Response.json(true)],
  ["204 missing body", () => new Response(null, { status: 204 })],
  ["200 empty JSON body", () => new Response("", { headers: { "content-type": "application/json" } })],
]
for (const [name, response] of invalidLists) test(`adapter rejects ${name} instead of returning a non-list pending response`, async () => {
  const sdk = sdkTransport(response)
  await assert.rejects(sdk.transport.list(new AbortController().signal))
  assert.equal(sdk.requests.length, 1)
})

const invalidAcks: [string, () => Response][] = [
  ["false", () => Response.json(false)], ["null", () => Response.json(null)],
  ["object", () => Response.json({ ok: true })], ["string true", () => Response.json("true")],
  ["number one", () => Response.json(1)], ["array", () => Response.json([true])],
  ["204 missing body", () => new Response(null, { status: 204 })],
  ["empty JSON body", () => new Response("", { headers: { "content-type": "application/json" } })],
]
for (const [name, response] of invalidAcks) test(`adapter rejects ${name} as an unconfirmed once acknowledgement without retry`, async () => {
  const sdk = sdkTransport(response)
  await assert.rejects(sdk.transport.once(request(), new AbortController().signal), /Permission reply unconfirmed/)
  assert.equal(sdk.requests.length, 1)
})

for (const method of ["list", "once"] as const) {
  const call = (transport: ApprovalTransport, signal: AbortSignal) => method === "list" ? transport.list(signal) : transport.once(request(), signal)
  for (const status of [400, 404, 503]) test(`adapter ${method} surfaces SDK HTTP ${status} errors rather than accepting an error result`, async () => {
    const body = { name: "FixtureError", data: { message: "SDK fixture failure" } }
    const sdk = sdkTransport(() => Response.json(body, { status }))
    await assert.rejects(call(sdk.transport, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, "SDK fixture failure")
      assert.deepEqual(error.cause, { body, status })
      return true
    })
    assert.equal(sdk.requests.length, 1)
  })
  for (const failure of ["network", "HTML server", "invalid JSON"] as const) test(`adapter ${method} rejects ${failure} without retry`, async () => {
    const network = new TypeError("Network unavailable")
    const sdk = sdkTransport(() => {
      if (failure === "network") throw network
      if (failure === "HTML server") return new Response("<html>wrong server</html>", { headers: { "content-type": "text/html" } })
      return new Response("{malformed", { headers: { "content-type": "application/json" } })
    })
    await assert.rejects(call(sdk.transport, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error)
      if (failure === "network") assert.equal(error, network)
      else if (failure === "HTML server") assert.match(error.message, /not supported/)
      else assert.ok(error instanceof SyntaxError)
      return true
    })
    assert.equal(sdk.requests.length, 1)
  })
  for (const when of ["before fetch", "in flight"] as const) test(`adapter ${method} propagates abort ${when} through the real SDK request`, async () => {
    const entered = deferred<Request>()
    const sdk = sdkTransport((req) => {
      entered.resolve(req)
      return new Promise<Response>((_resolve, reject) => {
        if (req.signal.aborted) reject(req.signal.reason)
        else req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true })
      })
    })
    const abort = new AbortController()
    const reason = new Error("Test cancellation")
    if (when === "before fetch") abort.abort(reason)
    const rejected = assert.rejects(call(sdk.transport, abort.signal), (error: unknown) => error === reason)
    const req = await entered.promise
    if (when === "in flight") {
      assert.equal(req.signal.aborted, false)
      abort.abort(reason)
    }
    await rejected
    assert.equal(req.signal.aborted, true)
    assert.equal(req.signal.reason, reason)
    assert.equal(sdk.requests.length, 1)
  })
}
