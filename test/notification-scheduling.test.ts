import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { open } from "node:fs/promises"
import { NotificationAudio } from "../src/notification-audio.js"
import { NotificationProcessPool, type NotificationProcesses, type ProcessResult, type ProcessScheduling } from "../src/notification-process.js"
import { NotificationQueue } from "../src/notification-queue.js"
import { fixtureWav } from "./notification-fixtures.js"
import { NotificationPolicy } from "../src/notification-policy.js"
import { parseNotificationConfig } from "../src/notification-config.js"

function transport() {
  const calls: { command: string; args: readonly string[]; signal: AbortSignal; finish(): void }[] = []
  const raw: NotificationProcesses = {
    start(command, args, _ms, signal) {
      let finish!: () => void
      const result = new Promise<ProcessResult>(resolve => { finish = () => resolve({ code: 0, stdout: "" }) })
      calls.push({ command, args, signal, finish })
      return { result, cancel() {} } // deliberately noncooperative until physical settlement
    }, dispose() { for (const call of calls) call.finish() },
  }
  return { raw, calls }
}

test("process capacity owns 24 physical children, queues the next banner and reserves both control lanes", async () => {
  const f = transport(), pool = new NotificationProcessPool(f.raw)
  const signal = new AbortController().signal
  const start = (id: string, lane: ProcessScheduling["lane"] = "banner", attention = true) =>
    pool.start("fixture", [id], 120000, signal, undefined, { lane, root: id, attention })!
  const banners = Array.from({ length: 20 }, (_, i) => start(String(i)))
  const later = start("later")
  start("audio1", "audio"); start("audio2", "audio"); start("withdraw", "close"); start("click", "activation")
  await settle()
  assert.equal(f.calls.length, 24)
  assert.ok(f.calls.some(c => c.args[0] === "withdraw")); assert.ok(f.calls.some(c => c.args[0] === "click"))
  assert.ok(!f.calls.some(c => c.args[0] === "later"))
  banners[0]!.cancel(); await settle()
  assert.equal(f.calls.length, 24, "abort is not child close")
  f.calls.find(c => c.args[0] === "0")!.finish(); await settle()
  assert.equal(f.calls.length, 25); assert.equal(await later.started, true)
  pool.dispose(); await later.result
})

test("routine banners leave actionable capacity and queued cancellation never dispatches", async () => {
  const f = transport(), pool = new NotificationProcessPool(f.raw), signal = new AbortController().signal
  for (let i = 0; i < 20; i++) pool.start("fixture", [String(i)], 100, signal, undefined, { lane: "banner", attention: false })
  await settle(); assert.equal(f.calls.length, 16)
  const abort = new AbortController()
  const cancelled = pool.start("fixture", ["cancelled"], 100, abort.signal, undefined, { lane: "banner" })!
  abort.abort(); await cancelled.result
  pool.start("fixture", ["urgent"], 100, signal, undefined, { lane: "banner", attention: true })
  await settle(); assert.equal(f.calls.at(-1)?.args[0], "urgent")
  pool.dispose(); assert.ok(!f.calls.some(c => c.args[0] === "cancelled"))
})

for (const soundOnly of [false, true]) {
  test(`question announcement follows physical ${soundOnly ? "audio" : "banner"} process admission, not capacity waiting`, async () => {
    const f = transport(), pool = new NotificationProcessPool(f.raw)
    const lane = soundOnly ? "audio" : "banner", capacity = soundOnly ? 2 : 20
    const signal = new AbortController().signal
    for (let i = 0; i < capacity; i++) pool.start("fixture", [`held-${i}`], 120000, signal, undefined, { lane, attention: true })
    await settle(); assert.equal(f.calls.length, capacity)
    const messages: string[] = []
    const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 0,
      notifications: { question: { banner: !soundOnly, sound: soundOnly } } }), false, {
      async show(message, parent) {
        const process = pool.start("fixture", [message.title], 120000, parent, undefined, { lane, root: message.sessionID, attention: true })!
        return { close: () => process.cancel(), closed: process.result.then(() => {}),
          dispatched: process.started!.then(started => { if (started) messages.push(message.title) }) }
      }, dispose() { pool.dispose() },
    })
    const front = new Map([["root", { kind: "question" as const, id: "q" }]])
    try {
      policy.pending(front); policy.question("q", { root: "root", sessionID: "root", title: "Root" }, true)
      await settle(); assert.equal(f.calls.length, capacity)
      policy.snapshot([], new Map(), false); await settle()
      policy.snapshot([], front, true); await settle()
      f.calls[0]!.finish(); await settle()
      assert.equal(f.calls.length, capacity + 1)
      assert.deepEqual(messages, ["Agent has a question"], "capacity-preempted initial must survive")
      policy.snapshot([], new Map(), false); await settle()
      policy.snapshot([], front, true); await settle()
      for (const call of [...f.calls]) call.finish()
      await settle()
      assert.equal(f.calls.length, capacity + 1, "an actually admitted initial cannot replay after health loss")
      assert.deepEqual(messages, ["Agent has a question"])
    } finally { await policy.dispose() }
  })
}

test("bounded priority rotates roots and services a routine item after eight actionable items", () => {
  const queue = new NotificationQueue<{ root: string; attention: boolean; id: string }>(30, 2)
  for (const root of ["a", "b", "c"]) for (let i = 0; i < 9; i++) assert.equal(queue.add({ root, attention: true, id: root + i }), true)
  queue.add({ root: "r", attention: false, id: "routine" })
  const selected = Array.from({ length: 9 }, () => queue.take()!.id)
  assert.deepEqual(selected, ["a0", "b0", "c0", "a1", "b1", "c1", "a2", "b2", "routine"])
  assert.equal(queue.add({ root: "r", attention: false, id: "r1" }), true)
  assert.equal(queue.add({ root: "r", attention: false, id: "r2" }), true)
  assert.equal(queue.add({ root: "r", attention: false, id: "overflow" }), false)
})

test("sound preparation reserves two slots before deferred callbacks and retains them after timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0
  // Deadlines use monotonic absolute time as well as timers. Keep both clocks
  // aligned, including exact expiry and the replacement preparation's budget.
  t.mock.method(performance, "now", () => now)
  const f = transport(), writes: (() => void)[] = []
  const sound = { format: "wav" as const, data: fixtureWav().toString("base64") }
  const audio = new NotificationAudio(f.raw, undefined, { attention: sound, unsafe: sound, question: sound }, {
    open, mkdtemp: (async () => "/fixture-sounds") as never,
    writeFile: () => new Promise<void>(resolve => writes.push(resolve)), rm: async () => {},
  })
  const signal = new AbortController().signal
  const waits = [audio.ready("attention", signal), audio.ready("unsafe", signal), audio.ready("question", signal)]
  for (let i = 0; i < 20 && writes.length < 2; i++) await settle()
  assert.equal(writes.length, 2)
  now = 2000; t.mock.timers.tick(2000); await settle()
  assert.equal(await waits[0], false); assert.equal(await waits[1], false)
  assert.equal(await waits[2], false, "Queueing is included in the caller's preparation budget")
  assert.equal(writes.length, 2, "timed-out writes still own preparation slots")
  writes[0]!()
  for (let i = 0; i < 20 && writes.length < 3; i++) await settle()
  assert.equal(writes.length, 3)
  const recovered = audio.ready("question", signal)
  writes[1]!(); writes[2]!(); assert.equal(await recovered, true)
  await audio.dispose()
})

test("queued sound preparation has a bounded wait even while both physical writes remain stuck", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0
  t.mock.method(performance, "now", () => now)
  const f = transport(), writes: (() => void)[] = []
  const sound = { format: "wav" as const, data: fixtureWav().toString("base64") }
  const audio = new NotificationAudio(f.raw, undefined, { attention: sound, unsafe: sound, question: sound }, {
    open, mkdtemp: (async () => "/fixture-sounds") as never,
    writeFile: () => new Promise<void>(resolve => writes.push(resolve)), rm: async () => {},
  })
  t.after(async () => { const stopped = audio.dispose(); for (const release of writes) release(); await stopped })
  const signal = new AbortController().signal
  const first = audio.ready("attention", signal), second = audio.ready("unsafe", signal)
  for (let turn = 0; turn < 20 && writes.length < 2; turn++) await settle()
  assert.equal(writes.length, 2)
  now = 2000; t.mock.timers.tick(2000); await settle()
  assert.equal(await first, false); assert.equal(await second, false)
  let result: boolean | undefined
  void audio.ready("question", signal).then(value => { result = value })
  await settle()
  now = 4000; t.mock.timers.tick(2000); await settle()
  assert.equal(result, false, "An unavailable sound must not hold its banner's preparation indefinitely")
  assert.equal(writes.length, 2, "A caller timeout cannot release either physical preparation slot")
  assert.equal(f.calls.length, 0)
})

test("approval playback spacing begins at actual player dispatch after cold preparation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0, release!: () => void
  t.mock.method(performance, "now", () => now)
  const f = transport()
  const audio = new NotificationAudio(f.raw, undefined, { approved: { format: "wav", data: fixtureWav().toString("base64") } }, {
    open, mkdtemp: (async () => "/fixture") as never,
    writeFile: () => new Promise<void>(resolve => { release = resolve }), rm: async () => {},
  })
  const first = audio.play("approved", new AbortController().signal, "first"), second = audio.play("approved", new AbortController().signal, "second")
  for (let i = 0; i < 20 && !release; i++) await settle()
  now = 1800; t.mock.timers.tick(1800); release(); await settle()
  assert.equal(f.calls.length, 1)
  now = 2000; t.mock.timers.tick(200); await settle(); assert.equal(f.calls.length, 1)
  now = 3799; t.mock.timers.tick(1799); await settle(); assert.equal(f.calls.length, 1)
  now = 3800; t.mock.timers.tick(1); await settle(); assert.equal(f.calls.length, 2)
  for (const call of f.calls) call.finish()
  await Promise.all([first, second]); await audio.dispose()
})

test("same-session sounds wait for physical player exit, while another session can play", async () => {
  const f = transport(), pool = new NotificationProcessPool(f.raw)
  const sound = { format: "wav" as const, data: fixtureWav().toString("base64") }
  const audio = new NotificationAudio(pool, undefined, { approved: sound, unsafe: sound, question: sound })
  const approval = new AbortController(), signal = new AbortController().signal
  await Promise.all([audio.ready("approved", signal), audio.ready("unsafe", signal), audio.ready("question", signal)])
  const first = audio.play("approved", approval.signal, "session")
  await settle()
  const next = audio.play("unsafe", signal, "session")
  const other = audio.play("question", signal, "other")
  const cancelled = new AbortController()
  const stale = audio.play("question", cancelled.signal, "session")
  cancelled.abort(); await stale; await settle()
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls[0]!.args.at(-1)!.endsWith("approved.wav"))
  assert.ok(f.calls[1]!.args.at(-1)!.endsWith("question.wav"))
  approval.abort(); await settle()
  assert.equal(f.calls.length, 2, "cancellation must not release a still-running player")
  f.calls[0]!.finish(); await first; await settle()
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls[2]!.args.at(-1)!.endsWith("unsafe.wav"))
  f.calls[1]!.finish(); f.calls[2]!.finish()
  await Promise.all([next, other]); await audio.dispose(); pool.dispose()
})
