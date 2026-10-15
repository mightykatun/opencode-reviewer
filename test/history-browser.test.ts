import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { HistoryController, type HistoryViewState } from "../src/history-controller.js"
import type { HistorySelection } from "../src/history-schema.js"
import type { HistoryQuery } from "../src/history-records.js"
import { opaque } from "../src/history-records.js"
import { historyLayout, historyMetadata } from "../src/history-layout.js"
import { uiText } from "../src/ui-text.js"
import { SessionAncestry } from "../src/session-ancestry.js"
import { HistoryCoordinator } from "../src/history-coordinator.js"

const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }
const entry = "a".repeat(64)
const selection: HistorySelection = { revision: 1, total: 1, rank: 1, entry,
  order: { completed: 1, tie: "r", id: entry }, record: { outcome: "manual",
    context: { scope: "/project", root: "root", session: "root", permission: "p", review: "r", category: "bash", configuredModel: "m", provider: "https://example.com" },
    payload: { safe: true, completedAt: 1, desc: "report" } } }
function fixture(t: any, ancestry: (id: string, signal: AbortSignal) => Promise<string> = async () => "root") {
  const pending: { query: HistoryQuery; resolve: (s: HistorySelection) => void; reject: () => void }[] = []
  let commit = () => {}, onMaintenance = () => {}, dirty = false
  let published: HistoryViewState | undefined
  const controller = new HistoryController("/project", {
    query: query => new Promise((resolve, reject) => pending.push({ query, resolve, reject: () => reject(Error()) })),
    onCommit: cb => { commit = cb; return () => {} }, onWriteFailure: () => () => {},
    get maintenanceDirty() { return dirty }, onMaintenance: cb => { onMaintenance = cb; return () => {} },
  }, ancestry, state => { published = state })
  t.after(() => controller.dispose())
  return { controller, pending, commit: () => commit(), get published() { return published },
    maintenance: (value: boolean) => { dirty = value; onMaintenance() } }
}
test("history has independent exact copy and extreme footer layouts", () => {
  assert.deepEqual(uiText.history.outcomes, { auto: "Auto approved", manual: "Manually approved", approved: "Approved", cancelled: "Cancelled", rejected: "Rejected" })
  assert.equal(uiText.commands.history, "Reviewer: Report history")
  assert.deepEqual([uiText.history.heading, uiText.history.close, uiText.history.older, uiText.history.newer,
    uiText.history.empty, uiText.history.loading, uiText.history.unavailable, uiText.history.unreadable],
  ["Analysis history", "Close", "<", ">", "No history entries", "Loading history", "History could not be read", "! Unreadable entry"])
  assert.equal(uiText.history.model("fixture"), "model: fixture")
  assert.equal(uiText.history.provider("https://example.com"), "provider: https://example.com")
  assert.equal(uiText.history.index(12, 300), "12/300")
  assert.deepEqual(historyLayout("Manually approved", "1/1"), { label: "Manually approved", rows: 1 })
  for (const [label, short] of [["Auto approved", "Aut..ved"], ["Manually approved", "Man..ved"], ["Cancelled", "Can..led"], ["Rejected", "Rejected"], ["Approved", "Approved"]]) {
    assert.deepEqual(historyLayout(label, "123456789/123456789"), { label: short, rows: 1 })
    assert.deepEqual(historyLayout(label, "123456789/1234567890"), { label, rows: 2 })
  }
  assert.deepEqual(historyLayout("Manually approved", "9007199254740991/9007199254740991"), { label: "Manually approved", rows: 3 })
  assert.equal(historyLayout("Manually approved", "12345678/123456789").label, "Manu..ved")
})
test("historical metadata order, fallback, usage independence and control sanitization", () => {
  assert.equal(historyMetadata(selection.record!), "model: m\nprovider: https://example.com")
  assert.equal(historyMetadata({ ...selection.record!, payload: { ...selection.record!.payload, reportedModel: "reported",
    usage: { input: 12, output: 3, cost: 0.0001 }, timing: { ratingMs: 1250, fullReportMs: 3500 } } }),
    "token: 12 in 3 out\ncost: $0.0001\nmodel: reported\nprovider: https://example.com\nTime to first rating: 1.25s\nTime to full report: 3.50s")
  const unsafe = historyMetadata({ ...selection.record!, payload: { ...selection.record!.payload, reportedModel: "x\x1b[31m\u202ey" } })
  assert.ok(!unsafe.includes("\x1b")); assert.ok(!unsafe.includes("\u202e")); assert.ok(!unsafe.includes("lifetime"))
})
test("real bounded ancestry is available without loading disabled or invalid mode records", async t => {
  let loads = 0
  const ancestry = new SessionAncestry(async id => ({ id, ...(id === "child" ? { parentID: "root" } : {}) }))
  const f = fixture(t, (id, signal) => ancestry.root(id, signal))
  f.controller.open("child"); await tick()
  assert.equal(loads, 0); assert.equal((f.pending[0]!.query as any).root, "root")
})
for (const kind of ["missing", "cycle", "depth"] as const) test(`history rejects actual ${kind} ancestry without mode loads or guessed queries`, async t => {
  const ancestry = new SessionAncestry(async id => {
    if (kind === "missing") return undefined
    return { id, parentID: kind === "cycle" ? id : String(Number(id) + 1) } as any
  })
  const f = fixture(t, (id, signal) => ancestry.root(id, signal))
  f.controller.open("0"); await settle()
  assert.equal(f.controller.state.status, "error"); assert.equal(f.pending.length, 0)
})
test("unavailable ancestry retries after two seconds and close cancels further retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let attempts = 0
  const f = fixture(t, async () => { if (++attempts === 1) throw Error("unavailable"); return "root" })
  f.controller.open("child"); await tick(); assert.equal(f.controller.state.status, "error")
  t.mock.timers.tick(1999); await tick(); assert.equal(attempts, 1)
  t.mock.timers.tick(1); await tick(); assert.equal(attempts, 2)
  f.pending.shift()!.resolve(selection); await tick(); assert.equal(f.controller.state.status, "ready")
  f.controller.close(); t.mock.timers.tick(4000); await tick(); assert.equal(attempts, 2)
})
test("open, insertion refresh, replacement and repeat preserve identity but reset appropriate scroll", async t => {
  const f = fixture(t), c = f.controller
  c.open("child"); await tick(); assert.deepEqual(f.pending[0]!.query, { type: "history", scope: "/project", root: "root" })
  f.pending.shift()!.resolve(selection); await tick(); c.scroll = 17
  f.commit(); f.pending.shift()!.resolve({ ...selection, total: 2 }); await tick()
  assert.equal(c.scroll, 17); assert.equal(c.state.selection?.entry, entry)
  f.commit(); f.pending.shift()!.resolve({ ...selection, record: { ...selection.record!, outcome: "auto" } }); await tick()
  assert.equal(c.scroll, 17)
  f.commit(); f.pending.shift()!.resolve({ ...selection, order: { ...selection.order!, tie: "new" } }); await tick()
  assert.equal(c.scroll, 0)
  c.scroll = 20; c.open("child"); await tick(); assert.equal(c.scroll, 0); assert.equal((f.pending[0]!.query as any).entry, undefined)
})
test("close, route change, deletion and disposal invalidate pending snapshots", async t => {
  for (const action of ["close", "route", "deleted", "dispose"] as const) {
    const f = fixture(t), c = f.controller
    c.open("root"); assert.equal(c.isCurrent("root"), true); assert.equal(c.isCurrent("child"), false); await tick()
    if (action === "route") c.route("child")
    else if (action === "deleted") c.deleted("root")
    else c[action]()
    f.pending[0]!.resolve(selection); await tick(); assert.equal(c.state.open, false)
    assert.equal(c.isCurrent("root"), false)
  }
})

for (const action of ["close", "route", "root-deleted", "session-deleted", "durable-deleted", "dispose"] as const)
  test(`${action} releases a loaded report from current and published state despite late reads`, async t => {
    const f = fixture(t), c = f.controller
    c.open("child"); await tick(); f.pending.shift()!.resolve(selection); await tick()
    assert.equal(c.state.selection?.record?.payload.desc, "report")
    assert.equal(f.published?.selection?.record?.payload.desc, "report")
    c.recordScroll(17)
    f.commit(); const late = f.pending.shift()!
    if (action === "route") c.route("other")
    else if (action === "root-deleted") c.deleted("root")
    else if (action === "session-deleted") c.deleted("child")
    else if (action === "durable-deleted") { late.resolve({ revision: 2, total: 0, rank: 0, deleted: true }); await tick() }
    else c[action]()
    const released = () => {
      assert.equal(c.state.open, false)
      assert.equal(c.state.selection, undefined, "the controller must release the selected report, not merely hide it")
      assert.equal(f.published?.selection, undefined, "the latest publication must also release the report")
      assert.equal(Reflect.get(c, "target"), undefined, "no pending notification target may remain")
      assert.equal(Reflect.get(c, "refresh"), undefined, "the terminal controller must detach its refresh owner")
    }
    released()
    if (action !== "durable-deleted") { late.resolve(selection); await tick(); released() }
  })

test("temporary read failure preserves scroll and requests layout restoration for the same report", async t => {
  const f = fixture(t), c = f.controller
  c.open("root"); await tick(); f.pending.shift()!.resolve(selection); await tick()
  c.scroll = 17
  const reset = c.state.reset
  f.commit(); f.pending.shift()!.reject(); await tick()
  assert.equal(c.state.status, "error")
  assert.equal(c.state.selection?.record?.payload, selection.record!.payload)
  c.recordScroll(0) // The temporary message's measured scroll extent collapses.
  assert.equal(c.scroll, 17)
  f.commit(); f.pending.shift()!.resolve(selection); await tick()
  assert.equal(c.scroll, 17)
  assert.ok(c.state.reset > reset, "the remounted Markdown must restore its saved offset after layout")
  c.recordScroll(23); assert.equal(c.scroll, 23)
})
test("temporary maintenance loading retains the same report and restores its scroll after layout", async t => {
  const f = fixture(t), c = f.controller
  c.open("root"); await tick(); f.pending.shift()!.resolve(selection); await tick()
  c.recordScroll(17); const reset = c.state.reset
  f.maintenance(true)
  assert.equal(c.state.status, "loading")
  assert.equal(f.published?.selection?.record?.payload, selection.record!.payload)
  c.recordScroll(0); assert.equal(c.scroll, 17)
  f.pending.shift()!.resolve(selection); await tick()
  assert.equal(c.state.status, "loading")
  f.maintenance(false); f.pending.shift()!.resolve(selection); await tick()
  assert.equal(c.state.status, "ready"); assert.equal(c.scroll, 17)
  assert.ok(c.state.reset > reset)
})
test("late ancestry cannot reopen, invalid roots show error and never query a guessed scope", async t => {
  let resolve!: (root: string) => void
  const f = fixture(t, () => new Promise(r => { resolve = r }))
  f.controller.open("missing"); f.controller.close(); resolve("root"); await tick()
  assert.equal(f.pending.length, 0)
  const invalid = fixture(t, async () => { throw Error("cycle/depth/missing") })
  invalid.controller.open("invalid"); await tick()
  assert.equal(invalid.controller.state.status, "error"); assert.equal(invalid.pending.length, 0)
})
test("selection races discard old reads and navigation ends do not issue queries", async t => {
  const f = fixture(t), c = f.controller
  c.open("root"); await tick(); f.pending.shift()!.resolve(selection); await tick()
  c.navigate("older"); c.navigate("newer"); assert.equal(f.pending.length, 0)
  f.commit(); c.open("other"); await tick()
  f.pending[0]!.resolve({ ...selection, total: 99 }); await tick()
  assert.equal(c.state.selection, undefined)
  f.pending[1]!.resolve({ revision: 0, total: 0, rank: 0 }); await tick()
  assert.equal((c.state.selection as HistorySelection | undefined)?.total, 0)
})
test("live deletion suppresses precommit snapshots and durable root deletion closes", async t => {
  const f = fixture(t), c = f.controller
  c.open("root"); await tick()
  const child = { ...selection, record: { ...selection.record!, context: { ...selection.record!.context, session: "child" } } }
  f.pending.shift()!.resolve(child); await tick()
  c.deleted("child"); assert.equal(c.state.status, "loading")
  assert.equal(c.state.selection?.record, undefined)
  assert.equal(f.published?.selection?.record, undefined)
  f.pending.shift()!.resolve(child); await tick(); assert.equal(c.state.status, "loading")
  assert.equal(c.state.selection?.record, undefined)
  f.commit(); f.pending.shift()!.resolve({ ...child, record: undefined, unreadable: true }); await tick()
  assert.equal(c.state.status, "loading", "a corrupt precommit payload cannot resurrect a deleted selection")
  f.commit(); f.pending.shift()!.resolve({ revision: 2, rank: 0, total: 0 }); await tick()
  assert.equal(c.state.status, "ready"); assert.equal(c.state.selection?.entry, undefined)
  f.commit(); f.pending.shift()!.resolve({ revision: 3, rank: 0, total: 0, deleted: true }); await tick()
  assert.equal(c.state.open, false)
})

for (const indexedSession of [false, true]) test(`selected-child deletion releases plaintext and retains adjacent navigation (indexed session: ${indexedSession})`, async t => {
  const f = fixture(t), c = f.controller
  const child: HistorySelection = { ...selection, ...(indexedSession ? { session: "child" } : {}), older: "b".repeat(64), newer: "c".repeat(64),
    record: { ...selection.record!, context: { ...selection.record!.context, session: "child" },
      payload: { ...selection.record!.payload, desc: "deleted child plaintext" } } }
  c.open("root"); await tick(); f.pending.shift()!.resolve(child); await tick()
  assert.equal(f.published?.selection?.record?.payload.desc, "deleted child plaintext")
  c.recordScroll(23); const reset = c.state.reset
  f.commit(); const stale = f.pending.shift()!
  c.deleted("child")
  const released = () => {
    assert.equal(c.state.open, true)
    assert.equal(c.state.selection?.record, undefined)
    assert.equal(f.published?.selection?.record, undefined)
    assert.equal(c.state.selection?.entry, child.entry)
    assert.deepEqual(c.state.selection?.order, child.order)
    assert.equal(Reflect.get(c, "target"), undefined)
  }
  released()
  stale.resolve(child); await tick(); released()
  assert.deepEqual(f.pending[0]!.query, { type: "history", scope: "/project", root: "root", entry: child.entry, order: child.order })
  f.pending.shift()!.reject(); await tick(); released()
  assert.equal(c.state.status, "error", "failed deletion refresh cannot restore known-deleted plaintext")
  f.commit(); f.pending.shift()!.resolve(child); await tick(); released()
  const adjacent: HistorySelection = { ...selection, entry: child.newer, order: { completed: 2, tie: "next", id: child.newer! }, older: child.older }
  f.commit(); f.pending.shift()!.resolve(adjacent); await tick()
  assert.equal(c.state.selection, adjacent); assert.equal(c.state.status, "ready")
  assert.equal(c.scroll, 0); assert.ok(c.state.reset > reset)
  c.navigate("older")
  assert.deepEqual(f.pending[0]!.query, { type: "history", scope: "/project", root: "root", entry: adjacent.entry, order: adjacent.order, direction: "older" })
})

const target = { session: "root", permission: "p" }
const targeted: HistorySelection = { ...selection, entry: opaque("/project", "p"),
  order: { ...selection.order!, id: opaque("/project", "p") } }

test("notification selection waits for its exact committed entry, then retains it and permits browsing", async t => {
  const f = fixture(t), c = f.controller
  let ready = 0
  c.openPermission("root", target, () => ready++)
  await tick()
  assert.equal(c.state.open, false)
  assert.deepEqual(f.pending[0]!.query, { type: "history", scope: "/project", root: "root", permission: target })
  f.pending.shift()!.resolve({ revision: 1, total: 2, rank: 0 }); await tick()
  assert.equal(c.state.open, false)
  f.commit(); f.pending.shift()!.resolve({ ...targeted, total: 3, rank: 1, newer: "b".repeat(64) }); await tick()
  assert.equal(c.state.open, true); assert.equal(c.state.selection?.entry, targeted.entry); assert.equal(ready, 1)
  c.scroll = 10
  f.commit(); f.pending.shift()!.resolve({ ...targeted, total: 4, rank: 1, newer: "b".repeat(64) }); await tick()
  assert.equal(c.scroll, 10); assert.equal(ready, 1)
  c.navigate("newer")
  assert.equal((f.pending[0]!.query as Extract<HistoryQuery, { type: "history" }>).direction, "newer")
})

test("missing, unreadable, wrong-scope or wrong-permission targets never show another saved report", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  for (const value of [{ revision: 1, total: 4, rank: 0 }, { ...targeted, record: undefined, unreadable: true },
    ...["scope", "root", "session", "permission"].map(field => ({ ...targeted,
      record: { ...targeted.record!, context: { ...targeted.record!.context, [field]: "wrong" } } }))]) {
    const f = fixture(t); let ready = 0
    f.controller.openPermission("root", target, () => ready++); await tick()
    f.pending.shift()!.resolve(value); await tick()
    assert.equal(f.controller.state.open, false)
    t.mock.timers.tick(5000); await tick()
    f.commit()
    for (const read of f.pending) read.resolve(targeted)
    await tick(); assert.equal(f.controller.state.open, false); assert.equal(ready, 0)
  }
})

test("targeted open cancellation defeats late reads and never overrides a newer history command", async t => {
  for (const action of ["close", "route", "root-deleted", "target-deleted", "dispose", "open", "cancelPendingPermission"] as const) {
    const f = fixture(t); let ready = 0
    f.controller.open("root"); await tick(); f.pending.shift()!.resolve(selection); await tick()
    assert.equal(f.published?.selection?.record?.payload.desc, "report")
    const childTarget = { ...target, session: "child" }
    f.controller.openPermission("root", childTarget, () => ready++); await tick()
    assert.equal(f.published?.selection, undefined)
    assert.equal(Reflect.get(f.controller, "target")?.session, "child")
    const read = f.pending.shift()!
    if (action === "route") f.controller.route("other")
    else if (action === "root-deleted") f.controller.deleted("root")
    else if (action === "target-deleted") f.controller.deleted("child")
    else if (action === "open") f.controller.open("root")
    else f.controller[action]()
    assert.equal(Reflect.get(f.controller, "target"), undefined, "cancellation releases the target and its ready callback")
    assert.equal(f.published?.selection, undefined)
    await tick(); read.resolve({ ...targeted, record: { ...targeted.record!, context: { ...targeted.record!.context, session: "child" } } }); await tick()
    assert.equal(ready, 0); assert.equal(f.controller.state.selection, undefined)
    assert.equal(f.published?.selection, undefined)
    assert.equal(f.controller.state.open, action === "open")
  }
})

test("targeted history waits through maintenance and retains actual read cleanup ownership", async t => {
  let dirty = true, onMaintenance = () => {}, commit = () => {}, finish!: (value: HistorySelection) => void, settleRead!: () => void
  let reads = 0, ready = 0
  const read = Object.assign(new Promise<HistorySelection>(resolve => { finish = resolve }),
    { settled: new Promise<void>(resolve => { settleRead = resolve }) })
  const c = new HistoryController("/project", {
    get maintenanceDirty() { return dirty }, onMaintenance: cb => { onMaintenance = cb; return () => {} },
    onCommit: cb => { commit = cb; return () => {} }, onWriteFailure: () => () => {},
    query: () => { reads++; return read },
  }, async () => "root", () => {})
  t.after(() => c.dispose())
  c.openPermission("root", target, () => ready++); await tick()
  finish(targeted); await tick()
  assert.equal(c.state.open, false)
  dirty = false; onMaintenance(); commit(); await tick(); assert.equal(reads, 1)
  settleRead(); await tick()
  assert.equal(reads, 2); assert.equal(c.state.open, true); assert.equal(ready, 1)
})

test("production ancestry composition coalesces history reopen storms until the actual read settles", async t => {
  const pending: { id: string; resolve: (v: { id: string }) => void }[] = []
  const ancestry = new SessionAncestry(id => new Promise(resolve => pending.push({ id, resolve })))
  const h = new HistoryCoordinator("/project", { admit: () => true, query: async () => ({}), onCommit: () => () => {} }, (id, signal) => ancestry.root(id, signal))
  const f = fixture(t, (id, signal) => h.root(id, signal))
  try {
    f.controller.open("old"); await settle()
    for (let n = 0; n < 25; n++) { f.controller.open(`new-${n}`); await settle() }
    assert.equal(pending.length, 1, "caller abort must not release physical ancestry ownership")
    pending[0]!.resolve({ id: "old" }); await settle()
    assert.deepEqual(pending.map(p => p.id), ["old", "new-24"])
    pending[1]!.resolve({ id: "new-24" }); await settle()
    assert.equal((f.pending[0]!.query as any).root, "new-24")
  } finally {
    f.controller.dispose(); h.dispose()
    for (const p of pending) p.resolve({ id: p.id })
    await settle()
  }
})

for (const outcome of ["resolve", "reject"] as const) test(`production history deadline retries retain ancestry cleanup through late ${outcome} and close`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let release!: (v: { id: string }) => void, reject!: (e: Error) => void, cleanup!: () => void, calls = 0
  const actual = new Promise<{ id: string }>((yes, no) => { release = yes; reject = no })
  const cleaning = new Promise<void>(yes => { cleanup = yes })
  const ancestry = new SessionAncestry(async () => {
    calls++; try { return await actual } finally { await cleaning }
  })
  const h = new HistoryCoordinator("/project", { admit: () => true, query: async () => ({}), onCommit: () => () => {} }, (id, signal) => ancestry.root(id, signal))
  const f = fixture(t, (id, signal) => h.root(id, signal))
  try {
    f.controller.open("old"); await settle(); t.mock.timers.tick(5000); await settle()
    assert.equal(f.controller.state.status, "error")
    for (let n = 0; n < 10; n++) { t.mock.timers.tick(2000); await settle() }
    assert.equal(calls, 1)
    if (outcome === "resolve") release({ id: "old" }); else reject(Error("late failure"))
    await settle(); assert.equal(calls, 1)
    f.controller.close(); cleanup(); await settle()
    t.mock.timers.tick(10000); await settle()
    assert.equal(calls, 1); assert.equal(f.pending.length, 0); assert.equal(f.controller.state.open, false)
  } finally { f.controller.dispose(); h.dispose(); release({ id: "old" }); cleanup(); await settle() }
})
