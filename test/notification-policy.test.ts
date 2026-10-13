import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { NotificationPolicy } from "../src/notification-policy.js"
import { parseNotificationConfig } from "../src/notification-config.js"
import { notificationMarkup, notificationText, type NotificationMessage } from "../src/notification-types.js"
import type { View } from "../src/controller.js"

const target = { root: "root", sessionID: "root", title: "Fixture title" }
const view = (id = "a", status: View["status"] = "analyzing", safe = true): View => ({
  request: { id, sessionID: "root", action: "shell", resources: ["command"], source: { assistantID: "assistant", id: "call" } },
  status, ...(status === "complete" ? { assessment: { safe, desc: "Fixture" } } : {}),
})
function fixture(auto = false, notify = true, sound = true, options: Record<string, unknown> = {}) {
  let now = 0
  const timers = new Set<{ at: number; callback: () => void }>()
  const messages: NotificationMessage[] = [], closed: string[] = []
  const dismissals: (() => void)[] = []
  const policy = new NotificationPolicy(parseNotificationConfig({ notify, notifySound: sound, ...options }), auto, {
    async show(message, signal) {
      assert.equal(signal.aborted, false)
      messages.push(message)
      const closedPromise = new Promise<void>(resolve => { dismissals.push(resolve) })
      return { close: () => { closed.push(message.title) }, closed: closedPromise }
    }, dispose() {},
  }, { now: () => now, after(ms, callback) {
    const timer = { at: now + ms, callback }; timers.add(timer)
    return () => { timers.delete(timer) }
  } })
  return { policy, messages, closed, timers, dismissals, async advance(ms: number) {
    now += ms
    for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.callback()
    await settle()
  }, add(v = view()) {
    policy.pending(new Map([[target.root, { kind: "permission", id: v.request.id }]]))
    policy.snapshot([v]); policy.permission(v.request, target, true)
  } }
}

test("notification settings are independently strict, default to silent approval banners, and use absolute sound paths", () => {
  assert.deepEqual(parseNotificationConfig(), { notify: true, notifySound: true, notificationSoundDirectory: undefined,
    staleReminderSeconds: 60, notifications: {
      attention: { banner: true, sound: true }, unsafe: { banner: true, sound: true }, question: { banner: true, sound: true },
      approved: { banner: true, sound: false }, error: { banner: true, sound: true }, ended: { banner: true, sound: true },
    } })
  for (const name of ["notify", "notifySound"]) for (const value of [null, "true", 0, [], {}]) {
    assert.throws(() => parseNotificationConfig({ [name]: value }), new RegExp(`${name} must be a boolean`))
  }
  for (const value of ["relative", "", "/bad\0path", 2, null]) assert.throws(() => parseNotificationConfig({ notificationSoundDirectory: value }))
  assert.equal(parseNotificationConfig({ notificationSoundDirectory: "/custom sounds" }).notificationSoundDirectory, "/custom sounds")
  assert.equal(notificationMarkup("<name>&\u001b\u202e"), "&lt;name&gt;&amp;")
  assert.equal(notificationText("x".repeat(500)).length, 256)
})

test("front questions notify once, baseline and repeated asks stay silent, resolution withdraws", async () => {
  const f = fixture()
  f.policy.pending(new Map([["root", { kind: "question", id: "new" }]]))
  f.policy.question("old", target, false); f.policy.question("old", target, true)
  f.policy.question("new", target, true); f.policy.question("new", target, true)
  await settle()
  assert.deepEqual(f.messages.map(m => m.title), ["Agent has a question"])
  f.policy.resolved("question", "new")
  assert.equal(f.closed.length, 1)
  f.policy.dispose()
})

test("queued questions wait for the front before their initial notification and full reminder interval", async () => {
  const f = fixture(false, true, true, { staleReminderSeconds: 10 })
  f.policy.pending(new Map([["root", { kind: "question", id: "first" }]]))
  f.policy.question("first", { ...target, title: "First question" }, true)
  f.policy.question("second", { ...target, title: "Second question" }, true)
  await settle(); assert.deepEqual(f.messages.map(m => m.body), ["First question"])
  await f.advance(10000)
  assert.deepEqual(f.messages.map(m => m.body), ["First question", "First question"])
  f.policy.resolved("question", "first")
  f.policy.pending(new Map([["root", { kind: "question", id: "second" }]]))
  await settle(); assert.equal(f.messages[2]?.title, "Agent has a question")
  assert.equal(f.messages[2]?.body, "Second question")
  await f.advance(9999); assert.equal(f.messages.length, 3)
  await f.advance(1); assert.equal(f.messages[3]?.title, "Agent has a question (Reminder)")
  f.policy.resolved("question", "second"); await f.advance(20000)
  assert.equal(f.messages.length, 4); await f.policy.dispose()
})

test("an automatically handled permission blocks questions without producing either attention or question alerts", async () => {
  const f = fixture(true, true, true, { staleReminderSeconds: 1 })
  f.add(view("a", "complete"))
  f.policy.question("q", target, true)
  await f.advance(60000); assert.equal(f.messages.length, 0)
  f.policy.snapshot([{ ...view("a", "complete"), autoApproval: { status: "countdown", seconds: 15 } }])
  await f.advance(10000); assert.equal(f.messages.length, 0)
  f.policy.snapshot([], new Map([["root", { kind: "question", id: "q" }]]))
  await settle(); assert.deepEqual(f.messages.map(m => m.kind), ["question"])
  await f.policy.dispose()
})

for (const soundOnly of [false, true]) {
  test(`question preemption cancels deferred ${soundOnly ? "sound-only" : "banner"} delivery and queued resolution cannot replay`, async () => {
    const f = fixture(false, true, true, { notifications: { question: { banner: !soundOnly, sound: soundOnly } } })
    f.policy.pending(new Map([["root", { kind: "question", id: "q" }]])); f.policy.question("q", target, true)
    f.policy.pending(new Map([["root", { kind: "permission", id: "p" }]]))
    await settle(); assert.deepEqual(f.messages, []); assert.equal(f.timers.size, 0)
    f.policy.resolved("question", "q")
    f.policy.pending(new Map([["root", { kind: "question", id: "q" }]]))
    await f.advance(60000); assert.deepEqual(f.messages, [])
    f.policy.question("deleted", target, true); f.policy.deleted("root")
    f.policy.pending(new Map([["root", { kind: "question", id: "deleted" }]]))
    await f.advance(60000); assert.deepEqual(f.messages, [])
    await f.policy.dispose()
  })
}

test("question queue loss aborts an in-flight backend and withdraws a late handle", async () => {
  let release!: (handle: { close(): void }) => void, signal!: AbortSignal, closed = 0
  const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 0 }), false, {
    show: (_message, parent) => { signal = parent; return new Promise(resolve => { release = resolve }) }, dispose() {},
  })
  policy.pending(new Map([["root", { kind: "question", id: "q" }]])); policy.question("q", target, true)
  await settle()
  policy.pending(new Map([["root", { kind: "permission", id: "p" }]]))
  assert.equal(signal.aborted, true)
  release({ close() { closed++ } }); await settle(); assert.equal(closed, 1)
  await policy.dispose()
})

test("advisory waits for final assessments, including safe, and ignores previews and baseline permissions", async () => {
  const f = fixture(); f.add()
  f.policy.snapshot([{ ...view(), progress: { attempt: 0, phase: "streaming", preview: { safe: false } } }])
  await settle(); assert.equal(f.messages.length, 0)
  f.policy.snapshot([view("a", "complete")]); await settle()
  f.policy.snapshot([view("a", "complete")]); await settle()
  assert.equal(f.messages.length, 1)
  f.policy.permission(view("old").request, target, false)
  f.policy.snapshot([view("a", "complete"), view("old", "complete", false)])
  await settle(); assert.equal(f.messages.length, 1)
  f.policy.dispose()
})

for (const status of ["unrelated", "unidentified", "unavailable", "suspended"] as const) {
  test(`${status} manual fallback produces one attention episode`, async () => {
    const f = fixture(true); f.add(view("a", status)); await settle()
    f.policy.snapshot([view("a", status)]); await settle()
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0]?.kind, "attention")
    f.policy.dispose()
  })
}

test("Safe automatic requests wait silently for eligibility and countdown; cancellation establishes manual attention", async () => {
  const f = fixture(true); f.add(view("a", "complete"))
  await f.advance(999); assert.equal(f.messages.length, 0)
  await f.advance(60000); assert.equal(f.messages.length, 0)
  assert.equal(f.timers.size, 0, "no grace period can infer manual action")
  const countdown: View = { ...view("a", "complete"), autoApproval: { status: "countdown", seconds: 15 } }
  f.policy.snapshot([countdown]); await settle()
  assert.equal(f.messages.length, 0)
  assert.equal(f.closed.length, 0)
  f.policy.snapshot([{ ...countdown, autoApproval: { status: "countdown", seconds: 14 } }]); await settle()
  assert.equal(f.messages.length, 0)
  f.policy.snapshot([{ ...countdown, autoApproval: { status: "cancelled" } }]); await settle()
  assert.equal(f.messages[0]?.kind, "attention"); assert.equal(f.closed.length, 0)
  f.policy.resolved("permission", "a"); assert.equal(f.closed.length, 1)
  f.policy.dispose()
})

test("final acceptance and request resolution never create a notification timer", async () => {
  const f = fixture(true); f.add(view("a", "complete"))
  f.policy.snapshot([{ ...view("a", "complete"), autoApproval: { status: "countdown", seconds: 15 } }])
  await f.advance(1000)
  assert.deepEqual(f.messages, [])
  f.policy.snapshot([]); await f.advance(2000)
  assert.equal(f.messages.length, 0); f.policy.dispose()
})

test("uncertain writes wait for reconciliation, and confirmed pending failure notifies only once", async () => {
  const f = fixture(true); f.add(view("a", "complete"))
  const failed: View = { ...view("a", "complete"), autoApproval: { status: "failed" } }
  f.policy.snapshot([failed]); await f.advance(1000); assert.equal(f.messages.length, 0)
  f.policy.snapshot([{ ...failed, approvalPendingConfirmed: true }]); await settle()
  f.policy.snapshot([{ ...failed, approvalPendingConfirmed: true }]); await settle()
  assert.equal(f.messages.length, 1); assert.equal(f.closed.length, 0)
  f.policy.dispose()
})

test("zero-delay success requires its explicit fact, not countdown or request disappearance", async () => {
  const f = fixture(true); f.add(view("a", "complete"))
  f.policy.snapshot([{ ...view("a", "complete"), autoApproval: { status: "countdown", seconds: 0 } }])
  await settle(); assert.equal(f.messages.length, 0)
  f.policy.snapshot([]); f.policy.approved(view().request, target); await settle()
  assert.equal(f.messages[0]?.title, "Reviewer approved a permission")
  assert.equal(f.messages[0]?.sound, false)
  f.policy.approved(view().request, target); await settle(); assert.equal(f.messages.length, 1)
  f.policy.dispose()
})

test("positive countdown stays silent through submission and only confirmed success plays approval", async () => {
  const f = fixture(true, true, true, { notifications: { approved: { sound: true } } }); f.add(view("a", "complete"))
  f.policy.snapshot([{ ...view("a", "complete"), autoApproval: { status: "countdown", seconds: 15 } }])
  await f.advance(1000)
  f.policy.snapshot([{ ...view("a", "complete"), autoApproval: { status: "countdown", seconds: 14 } }])
  await f.advance(14000)
  for (const status of ["waiting", "checking", "allowing"] as const) {
    f.policy.snapshot([{ ...view("a", "complete"), autoApproval: { status } }])
    await settle()
  }
  assert.equal(f.messages.length, 0, "no banner or sound before acknowledgement")
  f.policy.approved(view().request, target); f.policy.snapshot([]); await settle()
  f.policy.approved(view().request, target); await settle()
  assert.deepEqual(f.messages.map(m => [m.kind, m.title, m.sound]), [
    ["approved", "Reviewer approved a permission", true],
  ])
  f.policy.dispose()
})

test("every reviewer banner is delivered but its audio is rate limited without suppressing attention", async () => {
  const f = fixture(true, true, true, { notifications: { approved: { sound: true } } })
  f.policy.pending(new Map([["root", { kind: "question", id: "q" }]]))
  for (const id of ["a", "b"]) f.policy.approved(view(id).request, target)
  f.policy.question("q", target, true); await settle()
  assert.deepEqual(f.messages.map(m => [m.kind, m.sound]), [["question", true], ["approved", true], ["approved", false]])
  await f.advance(2000); f.policy.approved(view("c").request, target); await settle()
  assert.equal(f.messages[3]?.sound, true); f.policy.dispose()
})

test("turn outcomes deduplicate across error/idle; disable, mute, disposal and late handles are isolated", async () => {
  const f = fixture(false, true, false)
  f.policy.turn("error", "turn", target); f.policy.turn("ended", "turn", target)
  f.policy.turn("ended", "other", target); await settle()
  assert.deepEqual(f.messages.map(m => [m.title, m.sound]), [["Session error", false], ["Session ended", false]])
  f.policy.dispose(); f.policy.question("late", target, true); await settle(); assert.equal(f.messages.length, 2)
  const disabled = fixture(false, false)
  disabled.policy.question("new", target, true); disabled.policy.turn("error", "turn", target)
  await settle(); assert.equal(disabled.messages.length, 0); disabled.policy.dispose()
  let release!: (value: { close(): void }) => void
  let closed = 0
  const policy = new NotificationPolicy(parseNotificationConfig(), false, {
    show: () => new Promise(resolve => { release = resolve }), dispose() {},
  })
  policy.pending(new Map([["root", { kind: "question", id: "q" }]]))
  policy.question("q", target, true); await settle(); policy.resolved("question", "q")
  release({ close() { closed++ } }); await settle(); assert.equal(closed, 1); policy.dispose()
})

test("notification controls reject malformed schemas and default omitted entries independently", () => {
  for (const notifications of [null, [], true, "all", { unknown: {} }, { unsafe: null }, { question: [] },
    { attention: { banner: 1 } }, { error: { sound: null } }, { ended: { typo: false } },
    JSON.parse('{"__proto__":{"banner":true}}'), new Date()]) assert.throws(() => parseNotificationConfig({ notifications }))
  for (const staleReminderSeconds of [null, -1, 0.5, "60", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseNotificationConfig({ staleReminderSeconds }))
  }
  assert.equal(parseNotificationConfig({ staleReminderSeconds: 0 }).staleReminderSeconds, 0)
  assert.equal(parseNotificationConfig({ staleReminderSeconds: Number.MAX_SAFE_INTEGER }).staleReminderSeconds, Number.MAX_SAFE_INTEGER)
  const config = parseNotificationConfig({ notifications: { unsafe: { banner: false }, question: { sound: false } } })
  assert.deepEqual(config.notifications.unsafe, { banner: false, sound: true })
  assert.deepEqual(config.notifications.question, { banner: true, sound: false })
  assert.deepEqual(config.notifications.attention, { banner: true, sound: true })
  assert.deepEqual(config.notifications.approved, { banner: true, sound: false })
  assert.deepEqual(parseNotificationConfig({ notifications: { approved: { banner: false } } }).notifications.approved,
    { banner: false, sound: false })
})

test("Unsafe is final-only, replaces an earlier fallback, and never follows a preliminary canceled-review alert", async () => {
  const f = fixture(true)
  f.add({ ...view(), autoApproval: { status: "cancelled" } })
  f.policy.snapshot([{ ...view(), autoApproval: { status: "cancelled" },
    progress: { attempt: 0, phase: "streaming", preview: { safe: false } } }])
  await settle(); assert.equal(f.messages.length, 0)
  f.policy.snapshot([view("a", "unavailable")]); await settle()
  assert.equal(f.messages[0]?.kind, "attention")
  f.policy.snapshot([view("a", "identifying")]); await settle()
  await f.advance(60000); assert.equal(f.messages.length, 1, "fresh review must suppress stale generic reminders")
  f.policy.snapshot([view("a", "complete", false)]); await settle()
  assert.deepEqual(f.messages.map(m => m.title), ["Session needs attention", "Unsafe permission needs human approval"])
  await f.advance(59999); assert.equal(f.messages.length, 2)
  await f.advance(1); assert.equal(f.messages[2]?.title, "Unsafe permission needs human approval (Reminder)")
  assert.equal(f.messages[2]?.kind, "unsafe")
  await f.policy.dispose()
})

for (const kind of ["attention", "unsafe", "question"] as const) {
  test(`${kind} reminders reuse presentation, survive banner dismissal, replace old banners and stop on resolution`, async () => {
    const f = fixture()
    if (kind === "question") {
      f.policy.pending(new Map([["root", { kind: "question", id: "q" }]]))
      f.policy.question("q", target, true)
    } else f.add(view("a", "complete", kind !== "unsafe"))
    await settle()
    const initial = f.messages[0]!
    f.dismissals[0]!(); await settle()
    await f.advance(59999); assert.equal(f.messages.length, 1)
    await f.advance(1); assert.deepEqual(f.messages[1], { ...initial, title: `${initial.title} (Reminder)` })
    await f.advance(60000); assert.deepEqual(f.messages[2], f.messages[1], "suffix must not accumulate")
    assert.ok(f.closed.includes(`${initial.title} (Reminder)`))
    f.policy.resolved(kind === "question" ? "question" : "permission", kind === "question" ? "q" : "a")
    await f.advance(120000); assert.equal(f.messages.length, 3)
    assert.equal(f.timers.size, 0)
    await f.policy.dispose()
  })
}

test("only the selected blocker repeats per root, and queue handoff waits a full interval", async () => {
  const f = fixture(false, true, true, { staleReminderSeconds: 10 })
  const a = view("a", "complete"), b = view("b", "complete", false)
  f.policy.snapshot([a, b])
  for (const v of [a, b]) f.policy.permission(v.request, target, true)
  f.policy.question("q", target, true)
  f.policy.question("other", { ...target, root: "other", sessionID: "other" }, true)
  f.policy.pending(new Map([["root", { kind: "permission", id: "a" }], ["other", { kind: "question", id: "other" }]]))
  await settle(); assert.equal(f.messages.length, 2, "queued permissions and questions have no initial notification")
  await f.advance(10000)
  assert.deepEqual(f.messages.slice(2).map(m => [m.kind, m.sessionID]), [["attention", "root"], ["question", "other"]])
  f.policy.resolved("permission", "a")
  f.policy.pending(new Map([["root", { kind: "permission", id: "b" }]]))
  await settle(); assert.equal(f.messages[4]?.title, "Unsafe permission needs human approval", "newly actionable request gets its initial notification")
  await f.advance(9999); assert.equal(f.messages.length, 5)
  await f.advance(1); assert.equal(f.messages[5]?.kind, "unsafe")
  f.policy.pending(new Map([["root", { kind: "permission", id: "baseline" }]]))
  await f.advance(10000); assert.equal(f.messages.length, 6, "a silent baseline blocker must not promote a later request")
  f.policy.deleted("root"); f.policy.deleted("other")
  assert.equal(f.timers.size, 0)
  await f.policy.dispose()
})

test("automatic approval, uncertain writes and disposal cancel pending reminders", async () => {
  const f = fixture(true, true, true, { staleReminderSeconds: 1 })
  f.add(view("a", "complete")); await f.advance(1000)
  assert.equal(f.messages.length, 0)
  for (const status of ["countdown", "checking", "allowing", "failed"] as const) {
    f.policy.snapshot([{ ...view("a", "complete"), autoApproval: status === "countdown" ? { status, seconds: 15 } : { status } }])
    await f.advance(2000); assert.equal(f.messages.length, 0)
  }
  f.policy.snapshot([{ ...view("a", "complete"), autoApproval: { status: "failed" }, approvalPendingConfirmed: true }])
  await settle(); assert.equal(f.messages.length, 1)
  await f.advance(1000); assert.equal(f.messages.length, 2)
  await f.policy.dispose(); assert.equal(f.timers.size, 0)
  await f.advance(10000); assert.equal(f.messages.length, 2)
})

for (const kind of ["attention", "unsafe", "question", "approved", "error", "ended"] as const) {
  for (const [banner, sound] of [[true, false], [false, true], [false, false]] as const) {
    test(`${kind}: banner=${banner}, sound=${sound}, reminders inherit effective controls`, async () => {
      const f = fixture(false, true, true, { staleReminderSeconds: 1, notifications: { [kind]: { banner, sound } } })
      if (kind === "question") {
        f.policy.pending(new Map([["root", { kind: "question", id: "q" }]])); f.policy.question("q", target, true)
      } else if (kind === "attention" || kind === "unsafe") f.add(view("a", "complete", kind !== "unsafe"))
      else if (kind === "approved") f.policy.approved(view().request, target)
      else f.policy.turn(kind, "turn", target)
      await settle()
      const enabled = banner || sound
      assert.equal(f.messages.length, enabled ? 1 : 0)
      if (enabled) assert.deepEqual([f.messages[0]?.banner, f.messages[0]?.sound], [banner, sound])
      await f.advance(1000)
      assert.equal(f.messages.length, enabled ? (["attention", "unsafe", "question"].includes(kind) ? 2 : 1) : 0)
      for (const m of f.messages) assert.deepEqual([m.banner, m.sound], [banner, sound])
      await f.policy.dispose()
    })
  }
}

test("master switches and zero interval cannot be overridden; very long intervals never overflow", async () => {
  const muted = fixture(false, true, false, { notifications: { question: { banner: false, sound: true } } })
  muted.policy.pending(new Map([["root", { kind: "question", id: "q" }]])); muted.policy.question("q", target, true)
  await muted.advance(60000); assert.equal(muted.messages.length, 0); assert.equal(muted.timers.size, 0); await muted.policy.dispose()
  for (const staleReminderSeconds of [0, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(false, true, true, { staleReminderSeconds }); f.add(view("a", "complete"))
    await settle()
    await f.advance(2147483647); assert.equal(f.messages.length, 1)
    for (const timer of f.timers) assert.ok(timer.at > 2147483647)
    await f.policy.dispose(); assert.equal(f.timers.size, 0)
  }
})

test("failed desktop delivery retains interaction reminders without retrying the initial delivery", async () => {
  let callback: (() => void) | undefined, calls = 0, now = 0
  const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 1 }), false, {
    async show() { calls++; throw new Error("desktop unavailable") }, dispose() {},
  }, { now: () => now, after(ms, cb) { if (ms === 1000) callback = cb; return () => {} } })
  policy.pending(new Map([["root", { kind: "question", id: "q" }]])); policy.question("q", target, true)
  await settle(); assert.equal(calls, 1)
  now = 1000; callback!(); await settle(); assert.equal(calls, 2)
  policy.resolved("question", "q"); now = 2000; callback!(); await settle(); assert.equal(calls, 2)
  await policy.dispose()
})

test("losing the blocker invalidates a due reminder before its deferred backend dispatch", async () => {
  const f = fixture(false, true, true, { staleReminderSeconds: 1 })
  f.add(view("a", "complete", false)); await settle()
  // Move the clock without awaiting the dispatch microtask by using a later
  // same-turn timer, just like an event that changes native queue ownership.
  f.timers.add({ at: 1000, callback: () => f.policy.pending(new Map([["root", { kind: "permission", id: "earlier" }]])) })
  await f.advance(1000)
  assert.deepEqual(f.messages.map(m => m.title), ["Unsafe permission needs human approval"])
  await f.advance(1000); assert.equal(f.messages.length, 1)
  await f.policy.dispose()
})

test("a stalled event loop emits one reminder without catching up missed intervals", async () => {
  const f = fixture(false, true, true, { staleReminderSeconds: 10 })
  f.add(view("a", "complete", false)); await settle()
  await f.advance(65000); assert.equal(f.messages.length, 2)
  await f.advance(9999); assert.equal(f.messages.length, 2)
  await f.advance(1); assert.equal(f.messages.length, 3)
  await f.policy.dispose()
})

for (const [name, pending] of [
  ["Unsafe", view("b", "complete", false)],
  ["canceled Safe", { ...view("b", "complete"), autoApproval: { status: "cancelled" } }],
  ["confirmed failed approval", { ...view("b", "complete"), autoApproval: { status: "failed" }, approvalPendingConfirmed: true }],
  ...(["unrelated", "unidentified", "unavailable", "suspended"] as const).map(status => [status, view("b", status)] as const),
] satisfies (readonly [string, View])[]) {
  test(`queued ${name} defers initial notification and reminders until actionable`, async () => {
    const f = fixture(true, true, true, { staleReminderSeconds: 1 })
    f.add(view("a")); f.policy.snapshot([view("a"), pending]); f.policy.permission(pending.request, target, true)
    await f.advance(60000); assert.equal(f.messages.length, 0)
    f.policy.snapshot([pending], new Map([["root", { kind: "permission", id: "b" }]]))
    await settle()
    assert.equal(f.messages.length, 1)
    assert.equal(f.messages[0]?.kind, name === "Unsafe" ? "unsafe" : "attention")
    f.policy.snapshot([pending]); await settle(); assert.equal(f.messages.length, 1)
    await f.advance(999); assert.equal(f.messages.length, 1)
    await f.advance(1); assert.equal(f.messages.length, 2)
    f.policy.pending(new Map([["root", { kind: "permission", id: "earlier" }]]))
    await f.advance(10000); assert.equal(f.messages.length, 2)
    await f.policy.dispose()
  })
}

test("queue handoff uses the current retry/stream state, not an earlier queued Unsafe report", async () => {
  const f = fixture(true, true, true, { staleReminderSeconds: 1 })
  const b = view("b", "complete", false)
  f.add(view("a")); f.policy.snapshot([view("a"), b]); f.policy.permission(b.request, target, true)
  await settle(); assert.equal(f.messages.length, 0)
  const analyzing: View = { ...view("b"), autoApproval: { status: "cancelled" } }
  f.policy.snapshot([analyzing], new Map([["root", { kind: "permission", id: "b" }]]))
  for (const progress of [
    { attempt: 0, phase: "evaluating" },
    { attempt: 0, phase: "streaming", preview: { safe: false } },
    { attempt: 1, phase: "retrying" },
    { attempt: 1, phase: "streaming", preview: { safe: true } },
  ] as const) {
    f.policy.snapshot([{ ...analyzing, progress }]); await f.advance(5000)
    assert.equal(f.messages.length, 0, progress.phase)
  }
  f.policy.snapshot([{ ...view("b", "complete"), autoApproval: { status: "cancelled" } }]); await settle()
  assert.deepEqual(f.messages.map(m => m.title), ["Session needs attention"])
  f.policy.snapshot([view("b", "identifying")]); await f.advance(5000)
  assert.equal(f.messages.length, 1, "new evaluation suppresses previous manual reminders")
  await f.policy.dispose()
})

test("queue preemption cancels initial delivery before dispatch, not only reminders", async () => {
  const f = fixture(false)
  f.add(view("b", "complete", false))
  f.policy.pending(new Map([["root", { kind: "permission", id: "a" }]]))
  await settle(); assert.equal(f.messages.length, 0)
  f.policy.snapshot([view("b", "complete")])
  f.policy.pending(new Map([["root", { kind: "permission", id: "b" }]]))
  await settle(); assert.deepEqual(f.messages.map(m => m.title), ["Session needs attention"])
  await f.policy.dispose()
})

for (const automatic of [false, true]) for (const soundOnly of [false, true]) {
  test(`F33 returning notified permission stays silent after ${automatic ? "automatic" : "manual"} covering approval, ${soundOnly ? "sound-only" : "banner and sound"}`, async () => {
    const f = fixture(automatic, true, true, { staleReminderSeconds: 0,
      notifications: { attention: { banner: !soundOnly, sound: true } } })
    const a = view("a", "unavailable"), b = view("b", "complete", automatic)
    f.add(a); await settle()
    assert.equal(f.messages.length, 1)
    assert.equal(f.messages[0]?.kind, "attention")
    f.policy.snapshot([a, b], new Map([["root", { kind: "permission", id: "b" }]]))
    f.policy.permission(b.request, target, true)
    await settle()
    if (automatic) f.policy.approved(b.request)
    f.policy.resolved("permission", "b")
    f.policy.snapshot([a], new Map([["root", { kind: "permission", id: "a" }]]))
    await f.advance(120000)
    assert.deepEqual(f.messages.map(message => message.kind), ["attention", automatic ? "approved" : "unsafe"])
    assert.equal(f.messages[0]?.banner, !soundOnly)
    assert.equal(f.messages[0]?.sound, true)
    assert.ok(f.closed.includes("Session needs attention"), "coverage still withdraws A's banner")
    await f.policy.dispose()
  })
}

test("F33 re-entry restarts a full reminder interval without an initial replay; a new Unsafe outcome still alerts once", async () => {
  const f = fixture(false, true, true, { staleReminderSeconds: 1 })
  f.add(view("a", "unavailable")); await settle()
  await f.advance(900)
  f.policy.pending(new Map([["root", { kind: "permission", id: "b" }]]))
  await f.advance(5000)
  f.policy.pending(new Map([["root", { kind: "permission", id: "a" }]]))
  await f.advance(999)
  assert.deepEqual(f.messages.map(message => message.title), ["Session needs attention"])
  await f.advance(1)
  assert.equal(f.messages[1]?.title, "Session needs attention (Reminder)")
  f.policy.snapshot([view("a", "complete", false)]); await settle()
  assert.equal(f.messages[2]?.title, "Unsafe permission needs human approval")
  f.policy.pending(new Map([["root", { kind: "permission", id: "b" }]]))
  f.policy.pending(new Map([["root", { kind: "permission", id: "a" }]]))
  await settle()
  assert.equal(f.messages.length, 3, "the newly delivered Unsafe outcome is remembered on later handoffs too")
  f.policy.resolved("permission", "a")
  await f.advance(5000)
  assert.equal(f.messages.length, 3)
  await f.policy.dispose()
})

test("F33 permission preempted before backend dispatch retains its initial alert", async () => {
  const pending: { signal: AbortSignal; dispatch(): void }[] = []
  const messages: NotificationMessage[] = []
  const policy = new NotificationPolicy(parseNotificationConfig({ staleReminderSeconds: 0 }), false, {
    async show(message, signal) {
      let finish!: () => void
      const dispatched = new Promise<void>(resolve => { finish = resolve })
      pending.push({ signal, dispatch() { if (!signal.aborted) messages.push(message); finish() } })
      return { close() { finish() }, dispatched }
    }, dispose() {},
  })
  const a = view("a", "unavailable")
  const front = (id: string) => policy.pending(new Map([["root", { kind: "permission", id }]]))
  front("a"); policy.snapshot([a]); policy.permission(a.request, target, true)
  await settle()
  front("b"); await settle()
  assert.equal(pending[0]?.signal.aborted, true)
  pending[0]!.dispatch(); await settle()
  front("a"); await settle()
  assert.equal(pending.length, 2)
  pending[1]!.dispatch(); await settle()
  assert.equal(messages.length, 1)
  front("b"); front("a"); await settle()
  assert.equal(pending.length, 2, "only genuinely dispatched initial outcomes suppress re-entry")
  policy.resolved("permission", "a")
  await policy.dispose()
})

test("uncertain failed approval does not notify even after becoming actionable until pending is confirmed", async () => {
  const f = fixture(true)
  const failed: View = { ...view("b", "complete"), autoApproval: { status: "failed" } }
  f.add(view("a")); f.policy.snapshot([view("a"), failed]); f.policy.permission(failed.request, target, true)
  f.policy.snapshot([failed], new Map([["root", { kind: "permission", id: "b" }]]))
  await f.advance(120000); assert.equal(f.messages.length, 0)
  f.policy.snapshot([{ ...failed, approvalPendingConfirmed: true }]); await settle()
  assert.equal(f.messages.length, 1)
  f.policy.snapshot([]); await f.advance(120000); assert.equal(f.messages.length, 1)
  await f.policy.dispose()
})

test("W4: a one-shot banner survives ticket saturation and delivers once capacity returns", async () => {
  const f = fixture(true)
  for (let i = 0; i < 65; i++) f.policy.approved(view(String(i)).request, target)
  await settle()
  assert.ok(f.messages.length <= 64)
  for (const dismiss of [...f.dismissals]) dismiss()
  await settle()
  assert.equal(f.messages.length, 65)
  assert.equal(new Set(f.messages.map(m => m.history?.permission)).size, 65)
  await f.policy.dispose()
})

test("routine overflow drops newest, actionable tickets remain available, and queued resolution cancels delivery", async () => {
  const f = fixture(true, true, true, { staleReminderSeconds: 0 })
  for (let i = 0; i < 128; i++) f.policy.approved(view(String(i)).request, target)
  f.policy.approved(view("overflow").request, target)
  await settle(); assert.equal(f.messages.length, 48)
  f.policy.pending(new Map([["root", { kind: "question", id: "q" }]])); f.policy.question("q", target, true)
  await settle(); assert.equal(f.messages.at(-1)?.kind, "question")
  for (const dismiss of [...f.dismissals]) dismiss()
  await settle()
  for (const dismiss of [...f.dismissals]) dismiss()
  await settle()
  assert.equal(f.messages.filter(m => m.kind === "approved").length, 128)
  assert.ok(!f.messages.some(m => m.history?.permission === "overflow"))
  assert.ok(f.messages.every(m => m.banner))
  await f.policy.dispose()
})

test("capacity waiting does not replace initial delivery with reminders", async () => {
  const f = fixture(false, true, true, { staleReminderSeconds: 1 })
  for (let i = 0; i < 65; i++) {
    f.policy.question(String(i), { ...target, root: String(i), sessionID: String(i) }, true)
  }
  f.policy.pending(new Map(Array.from({ length: 65 }, (_, i) => [String(i), { kind: "question" as const, id: String(i) }])))
  await settle(); assert.equal(f.messages.length, 64)
  await f.advance(1000)
  assert.ok(!f.messages.some(m => m.sessionID === "64"))
  // The fake transport keeps physical closure separate from close requests.
  for (const dismiss of [...f.dismissals]) dismiss()
  await settle()
  assert.equal(f.messages.find(m => m.sessionID === "64")?.title, "Agent has a question")
  await f.policy.dispose()
})

test("child deletion withdraws an exact approval target even when its banner belongs to the root", async () => {
  const f = fixture(true)
  for (let i = 0; i < 48; i++) f.policy.approved(view(String(i)).request, target)
  await settle()
  f.policy.approved({ ...view("child-permission").request, sessionID: "child" }, target)
  f.policy.deleted("child")
  for (const dismiss of f.dismissals) dismiss()
  await settle(); assert.equal(f.messages.length, 48)
  await f.policy.dispose()
})
