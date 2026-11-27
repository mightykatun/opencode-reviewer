// Inventory owner: human-reply-race/same-step-steering/root-blocker-child-progress/policy-edit-pending/restart-shared-stats/server-state-upgrade scenarios, no flags; linux/git/tmux/npm-pack/tar/bundle/node-sqlite.
// Headless server decision lifecycle: native reply arbitration, same-step steering siblings, per-session
// head ordering under a manual root blocker, policy edits while pending and service restart with shared
// v2 statistics. One managed service at a time, driven only through the public HTTP API.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { headlessFixture, reviewerModel } from "./smoke-v2-headless-support.mjs"

const { scenario } = runtimeArguments("smoke-v2-headless-lifecycle.mjs")
const systemPrompts = []
const unsafe = (steering) => ({ safe: false, reason: "Blocker command not needed.", desc: "The command adds nothing to the task.", ...(steering ? { steering: "Skip the blocker command." } : {}) })
const safe = { safe: true, reason: "Decisive reason.", desc: "Prints a fixed marker. No side effects." }
const limitations = [
  "One isolated managed service and the installed archive, driven only through the public HTTP API. No terminal, viewer, desktop delivery or live-provider judgment.",
  {
    "human-reply-race": "The human reply lands during an armed countdown, before dispatch. The exact dispatch-instant race is proved by the host's first-reply-wins behavior (Phase 1) and the controller's no-retry rule in source tests.",
    "same-step-steering": "Two shell calls in one assistant step. The sibling rejection is the host's own effect of the one steering write.",
    "root-blocker-child-progress": "Parent and child sessions share one location. Cross-location descendants are covered by the worktree fixtures.",
    "policy-edit-pending": "Policy edits replace the file atomically. Prompt directory changes and invalid JSON are source-tested.",
    "restart-shared-stats": "The service is stopped through its supervised tmux session and started again on the same state root. Pending permissions do not survive a host restart, so recovery of a pending request is source-tested.",
    "server-state-upgrade": "Synthetic 2.8 files stand in for a real v1 database. Their bytes and metadata are compared, never their contents.",
  }[scenario],
]
const fixture = await headlessFixture({ fixture: "v2-headless-lifecycle", scenario, limitations,
  review: (evidence, body) => {
    assert.ok([reviewerModel, `${reviewerModel}-b`].includes(body.model), body.model)
    assert.equal(evidence.kind, "shell")
    systemPrompts.push(body.messages[0].content)
    if (/BLOCKER/.test(evidence.command)) return unsafe(scenario === "same-step-steering")
    return safe
  },
  agent: (_body, { lastRole, userText }) => {
    if (lastRole === "tool") return { text: "done" }
    // The host wakes a parent with a background-result message when its child finishes. The parent is done.
    if (/background-result/.test(userText)) return { text: "done" }
    if (scenario === "same-step-steering") return { toolCalls: [{ name: "shell", arguments: { command: "echo HEADLESS_BLOCKER" } }, { name: "shell", arguments: { command: "echo HEADLESS_SIBLING" } }] }
    if (scenario === "root-blocker-child-progress" && /parent/.test(userText))
      return { toolCalls: [{ name: "shell", arguments: { command: "echo HEADLESS_BLOCKER" } }, { name: "shell", arguments: { command: "echo PARENT_SECOND" } }] }
    return { toolCalls: [{ name: "shell", arguments: { command: "echo HEADLESS_MARKER" } }] }
  },
})
const { result, until, location, rpc, snapshot, replied, toolResult } = fixture
const viewOf = (value, id) => value.views.find(item => item.view.request.id === id)
const totals = async sessionID => { const value = await rpc().statistics(sessionID ? { sessionID } : {}, { location }); result.statistics = value; return value }
const ledgerRows = async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path.join(fixture.env.XDG_STATE_HOME, "opencode/opencode-reviewer/decisions-v1.sqlite"), { readOnly: true })
  try { return db.prepare("SELECT state FROM decisions").all().map(row => row.state) } finally { db.close() }
}

try {
  const policy = overrides => ({ server: fixture.serverPolicy({ autoApprove: true, autoApproveDelaySeconds: 1, ...overrides }) })
  if (scenario === "human-reply-race") {
    await fixture.writePolicy(policy({ autoApproveDelaySeconds: 20 }))
    await fixture.startService()
    const client = fixture.client()
    const session = await client.session.create({ title: "Headless race", location })
    await fixture.verified({ enabled: true })
    await client.session.prompt({ sessionID: session.id, text: "Run the headless marker command." })
    const asked = await until("native permission", () => fixture.asked(session.id)[0])
    const armed = await until("armed countdown", async () => { const view = viewOf(await snapshot(), asked.data.id); return view?.view.autoApproval?.status === "countdown" ? view : false })
    assert.ok(armed.view.autoApproval.seconds > 5, "The countdown is still far from dispatch")
    await client.permission.reply({ sessionID: session.id, requestID: asked.data.id, decision: "reject" })
    result.replies.push({ by: "fixture", decision: "reject" })
    await until("human reply observed", () => replied(asked.data.id).length === 1)
    await until("permission gone", async () => (await client.permission.list({ sessionID: session.id })).length === 0)
    await sleep(3000)
    assert.deepEqual(replied(asked.data.id).map(event => event.data.reply), ["reject"], "The human reply is the only native resolution")
    assert.equal(result.reviewPOSTs.length, 1, "No re-review after the human reply")
    assert.equal(viewOf(await snapshot(), asked.data.id), undefined, "A resolved permission leaves the pending views")
    // A bare native reject ends the agent run on this host: the session model is not called again.
    result.session = await client.session.get({ sessionID: session.id })
    assert.equal(result.modelCalls.length, 1, "The host stopped the run after the human rejection")
    const statistics = await until("recorded statistics", async () => { const value = await totals(session.id); return value.conversation?.totals.requests === 1 && value })
    assert.equal(statistics.conversation.totals.activity.rejected, 1, "The human rejection counts once as a manual rejection")
    assert.equal(statistics.conversation.totals.activity.autoApproved, 0)
    const history = await rpc().history({ sessionID: session.id }, { location })
    result.history = history
    assert.equal(history.total, 1)
    assert.equal(history.record.outcome, "rejected")
    assert.equal(history.record.steering, undefined)
    assert.ok(!(await ledgerRows()).includes("sent"), "No decision was ever dispatched")
  } else if (scenario === "same-step-steering") {
    await fixture.writePolicy({ server: fixture.serverPolicy({ autoRejectSteering: true, autoApproveDelaySeconds: 1 }) })
    await fixture.startService()
    const client = fixture.client()
    const session = await client.session.create({ title: "Headless same-step steering", location })
    await fixture.verified({ enabled: true })
    await client.session.prompt({ sessionID: session.id, text: "Run both headless commands." })
    const asked = await until("two same-step permissions", () => fixture.asked(session.id).length === 2 && fixture.asked(session.id))
    const blocker = asked.find(event => event.data.resources[0] === "echo HEADLESS_BLOCKER"), sibling = asked.find(event => event.data.resources[0] === "echo HEADLESS_SIBLING")
    assert.ok(blocker && sibling)
    await until("steering rejection", () => replied(blocker.data.id).length === 1, 30000)
    assert.equal(replied(blocker.data.id)[0].data.reply, "reject")
    await until("sibling resolved by the host", () => replied(sibling.data.id).length === 1, 30000)
    assert.equal(replied(sibling.data.id)[0].data.reply, "reject", "The host rejects the same-step sibling")
    await until("session idle", async () => (await client.session.get({ sessionID: session.id })).time.idle)
    await sleep(2000)
    assert.equal(replied(blocker.data.id).length, 1)
    assert.equal(replied(sibling.data.id).length, 1)
    assert.ok(result.reviewPOSTs.length <= 2, "At most one review per permission")
    assert.equal(result.reviewPOSTs.filter(post => post.assessment.safe === false).length, 1, "Exactly one Unsafe steering verdict")
    const blockerResult = await until("blocker tool result", () => toolResult(blocker.data.source.id))
    assert.match(blockerResult.content, /Rejected by opencode-reviewer: Blocker command not needed\. Skip the blocker command\./)
    assert.match((await until("sibling tool result", () => toolResult(sibling.data.source.id))).content, /permission\.rejected|rejected/i)
    // Both native rejections count once. Only the dispatched steering is an automatic rejection.
    const statistics = await until("recorded statistics", async () => { const value = await totals(session.id); return value.conversation?.totals.activity.autoRejected === 1 && value })
    assert.equal(statistics.conversation.totals.activity.rejected, 2, "Two native rejections, one per permission")
    assert.equal(statistics.totals.activity.autoRejected, 1, "One automatic steering rejection")
    const history = await rpc().history({ sessionID: session.id, permission: { session: session.id, permission: blocker.data.id } }, { location })
    result.history = history
    assert.equal(history.record.context.permission, blocker.data.id)
    assert.equal(history.record.outcome, "rejected")
    assert.match(history.record.steering ?? "", /Skip the blocker command/)
    result.ledger = await ledgerRows()
  } else if (scenario === "root-blocker-child-progress") {
    await fixture.writePolicy(policy())
    await fixture.startService()
    const client = fixture.client()
    const parent = await client.session.create({ title: "Headless parent", location })
    await fixture.verified({ enabled: true })
    await client.session.prompt({ sessionID: parent.id, text: "Run the parent commands." })
    const parentAsked = await until("two parent permissions", () => fixture.asked(parent.id).length === 2 && fixture.asked(parent.id))
    const blocker = parentAsked.find(event => event.data.resources[0] === "echo HEADLESS_BLOCKER"), second = parentAsked.find(event => event.data.resources[0] === "echo PARENT_SECOND")
    assert.ok(blocker && second)
    const child = await client.session.create({ title: "Headless child", location, parentID: parent.id })
    await client.session.prompt({ sessionID: child.id, text: "Run the child command." })
    const childAsked = await until("child permission", () => fixture.asked(child.id)[0])
    await until("child approved", () => replied(childAsked.data.id).length === 1, 30000)
    assert.equal(replied(childAsked.data.id)[0].data.reply, "once")
    await until("child idle", async () => (await client.session.get({ sessionID: child.id })).time.idle)
    assert.match((await until("child tool result", () => toolResult(childAsked.data.source.id))).content, /HEADLESS_MARKER/)
    // Both parent reviews complete, but the manual blocker heads the parent's queue and the Safe second request waits behind it.
    const settled = await until("parent reviews complete", async () => {
      const value = await snapshot()
      const views = [viewOf(value, blocker.data.id), viewOf(value, second.data.id)]
      return views.every(view => view?.view.status === "complete") ? { value, views } : false
    })
    await sleep(3000)
    assert.equal(replied(blocker.data.id).length, 0, "The manual blocker stays pending")
    assert.equal(replied(second.data.id).length, 0, "A Safe request cannot pass the manual head of its own session")
    assert.deepEqual((await client.permission.list({ sessionID: parent.id })).map(item => item.id).sort(), [blocker.data.id, second.data.id].sort())
    const current = await snapshot()
    const blockerView = viewOf(current, blocker.data.id), secondView = viewOf(current, second.data.id)
    assert.equal(blockerView.head, true)
    assert.equal(blockerView.view.assessment.safe, false)
    assert.equal(blockerView.view.autoApproval, undefined, "An Unsafe report without steering arms nothing")
    assert.equal(secondView.head, false)
    assert.equal(secondView.view.assessment.safe, true)
    assert.notEqual(secondView.view.autoApproval?.status, "approved")
    assert.equal(secondView.root, parent.id)
    result.parentViews = [blockerView, secondView]
    const statistics = await until("recorded statistics", async () => { const value = await totals(parent.id); return value.conversation?.totals.activity.autoApproved === 1 && value })
    assert.equal(statistics.totals.activity.autoApproved, 1, "Exactly one automatic approval, the child's")
    // Release the parent through its head. The host resolves the same-step sibling itself.
    await client.permission.reply({ sessionID: parent.id, requestID: blocker.data.id, decision: "reject" })
    await until("parent permissions gone", async () => (await client.permission.list({ sessionID: parent.id })).length === 0)
    await sleep(2000)
    assert.equal(result.reviewPOSTs.length, 3, "One review per permission, none repeated")
    assert.equal(replied(second.data.id).length, 1, "The sibling resolved once, by the host")
  } else if (scenario === "policy-edit-pending") {
    await fixture.writePolicy(policy({ autoApproveDelaySeconds: 30 }))
    await fixture.startService()
    const client = fixture.client()
    const session = await client.session.create({ title: "Headless policy edit", location })
    await fixture.verified({ enabled: true })
    await client.session.prompt({ sessionID: session.id, text: "Run the headless marker command." })
    const asked = await until("native permission", () => fixture.asked(session.id)[0])
    const first = await until("armed countdown", async () => { const view = viewOf(await snapshot(), asked.data.id); return view?.view.autoApproval?.status === "countdown" ? view : false })
    assert.equal(result.reviewPOSTs.length, 1)
    // A tui-only edit changes viewer settings and nothing else.
    await fixture.writePolicy({ ...policy({ autoApproveDelaySeconds: 30 }), tui: { notify: false } })
    const afterTui = await until("tui settings published", async () => { const value = await snapshot(); return value.tui?.notify === false && value })
    await sleep(2000)
    const sameAttempt = viewOf(await snapshot(), asked.data.id)
    assert.equal(sameAttempt.attempt, first.attempt, "A tui-only edit keeps the attempt")
    assert.equal(sameAttempt.view.autoApproval.status, "countdown")
    assert.ok(sameAttempt.view.autoApproval.seconds < first.view.autoApproval.seconds, "The countdown kept running")
    assert.equal(result.reviewPOSTs.length, 1, "A tui-only edit triggers no model call")
    assert.equal(afterTui.review.enabled, true)
    // A server edit (new model and delay) replaces the engine: a fresh review, a fresh countdown and a new attempt.
    await fixture.writePolicy({ ...policy({ autoApproveDelaySeconds: 6, model: `${reviewerModel}-b` }), tui: { notify: false } })
    await until("re-review POST", () => result.reviewPOSTs.length === 2)
    assert.equal(result.reviewPOSTs[1].model, `${reviewerModel}-b`)
    const second = await until("fresh countdown", async () => { const view = viewOf(await snapshot(), asked.data.id); return view?.view.autoApproval?.status === "countdown" && view.attempt !== first.attempt ? view : false })
    assert.ok(second.view.autoApproval.seconds <= 6)
    // A stale control naming the replaced attempt acts on nothing.
    const stale = await rpc().control({ sessionID: session.id, permissionID: asked.data.id, attempt: first.attempt, action: "cancel" }, { location })
    result.staleControl = stale
    assert.equal(stale.result, "late")
    await until("automatic native reply", () => replied(asked.data.id).length === 1, 30000)
    assert.equal(replied(asked.data.id)[0].data.reply, "once")
    await until("session idle", async () => (await client.session.get({ sessionID: session.id })).time.idle)
    assert.equal(result.reviewPOSTs.length, 2, "Exactly two reviews: the original and the policy-triggered re-review")
    const statistics = await until("recorded statistics", async () => { const value = await totals(session.id); return value.conversation?.totals.requests === 2 && value })
    assert.equal(statistics.conversation.totals.activity.autoApproved, 1)
    const history = await rpc().history({ sessionID: session.id }, { location })
    result.history = history
    assert.equal(history.total, 1, "One final report for the permission, the re-review superseded the first")
    assert.equal(history.record.outcome, "auto")
    assert.equal(history.record.context.permission, asked.data.id)
  } else if (scenario === "restart-shared-stats") {
    await fixture.writePolicy(policy())
    await fixture.startService()
    let client = fixture.client()
    const first = await client.session.create({ title: "Headless before restart", location })
    await fixture.verified({ enabled: true })
    await client.session.prompt({ sessionID: first.id, text: "Run the headless marker command." })
    const askedFirst = await until("first permission", () => fixture.asked(first.id)[0])
    await until("first approval", () => replied(askedFirst.data.id).length === 1, 30000)
    await until("first idle", async () => (await client.session.get({ sessionID: first.id })).time.idle)
    await until("first statistics", async () => (await totals()).totals.requests === 1)
    await fixture.stopService()
    await fixture.startService()
    client = fixture.client()
    const second = await client.session.create({ title: "Headless after restart", location })
    await fixture.verified({ enabled: true })
    await client.session.prompt({ sessionID: second.id, text: "Run the headless marker command." })
    const askedSecond = await until("second permission", () => fixture.asked(second.id)[0])
    await until("second approval", () => replied(askedSecond.data.id).length === 1, 30000)
    await until("second idle", async () => (await client.session.get({ sessionID: second.id })).time.idle)
    const statistics = await until("shared statistics", async () => { const value = await totals(second.id); return value.totals.requests === 2 && value })
    assert.equal(statistics.totals.activity.autoApproved, 2, "Both services contributed once to the shared lifetime totals")
    assert.equal(statistics.conversation.totals.requests, 1)
    const earlier = await rpc().history({ sessionID: first.id }, { location })
    result.history = earlier
    assert.equal(earlier.total, 1, "The earlier conversation stays readable after the restart")
    assert.equal(earlier.record.context.permission, askedFirst.data.id)
    assert.equal(result.reviewPOSTs.length, 2)
    result.ledger = await ledgerRows()
    assert.deepEqual(result.ledger, ["resolved", "resolved"], "Each dispatched decision resolved once")
  } else if (scenario === "server-state-upgrade") {
    // Synthetic 2.8 state: a v1 database with sidecars and a legacy usage directory. Opaque bytes only.
    const legacyDirectory = path.join(fixture.env.XDG_STATE_HOME, "opencode/opencode-reviewer")
    await mkdir(legacyDirectory, { recursive: true, mode: 0o700 })
    await mkdir(path.join(legacyDirectory, "usage-v4"), { mode: 0o700 })
    const legacy = {}
    for (const name of ["history-v1.sqlite", "history-v1.sqlite-wal", "history-v1.sqlite-shm", "usage-v4/totals.json"]) {
      const bytes = randomBytes(4096)
      await writeFile(path.join(legacyDirectory, name), bytes, { mode: 0o600 })
      const info = await stat(path.join(legacyDirectory, name))
      legacy[name] = { bytes, mtimeMs: info.mtimeMs, ino: info.ino, size: info.size }
    }
    await fixture.writePolicy(policy())
    await fixture.startService()
    const client = fixture.client()
    const session = await client.session.create({ title: "Headless upgrade", location })
    await fixture.verified({ enabled: true })
    const fresh = await totals()
    assert.equal(fresh.totals.requests, 0, "The first v2 open has zero statistics")
    assert.equal(fresh.totals.activity.reviews, 0)
    assert.equal((await rpc().history({ sessionID: session.id }, { location })).total, 0, "No reports are imported")
    // A local 2.8 disabled-mode record for this root still applies to the server engine.
    const modeDirectory = path.join(fixture.env.XDG_STATE_HOME, "opencode/session-mode-v2")
    await mkdir(modeDirectory, { recursive: true, mode: 0o700 })
    const modeFile = path.join(modeDirectory, createHash("sha256").update(JSON.stringify([JSON.stringify(location), session.id])).digest("hex") + ".json")
    await writeFile(modeFile, JSON.stringify({ version: 1, enabled: false }), { mode: 0o600 })
    const instructions = await rpc().instructions({ sessionID: session.id, set: "HEADLESS_INSTRUCTION prefer brevity." }, { location })
    assert.deepEqual(instructions, { root: session.id, text: "HEADLESS_INSTRUCTION prefer brevity.", limit: 131072 })
    await client.session.prompt({ sessionID: session.id, text: "Run the headless marker command." })
    const asked = await until("native permission", () => fixture.asked(session.id)[0])
    const suspended = await until("suspended review", async () => { const view = viewOf(await snapshot(), asked.data.id); return view?.view.status === "suspended" ? view : false })
    result.suspendedView = suspended
    await sleep(3000)
    assert.equal(result.reviewPOSTs.length, 0, "A disabled root never calls the reviewer model")
    assert.equal(replied(asked.data.id).length, 0)
    assert.deepEqual(await rpc().mode({ sessionID: session.id }, { location }), { root: session.id, enabled: false })
    // Re-enabling through the server control resumes review with the root's instructions.
    assert.deepEqual(await rpc().mode({ sessionID: session.id, set: true }, { location }), { root: session.id, enabled: true })
    await until("reviewer POST", () => result.reviewPOSTs.length === 1)
    assert.match(systemPrompts[0], /HEADLESS_INSTRUCTION prefer brevity\./, "Root instructions reach the verdict system prompt")
    await until("automatic native reply", () => replied(asked.data.id).length === 1, 30000)
    assert.equal(replied(asked.data.id)[0].data.reply, "once")
    await until("session idle", async () => (await client.session.get({ sessionID: session.id })).time.idle)
    const statistics = await until("recorded statistics", async () => { const value = await totals(session.id); return value.totals.requests === 1 && value })
    assert.equal(statistics.conversation.totals.activity.autoApproved, 1)
    assert.deepEqual(JSON.parse(await readFile(modeFile, "utf8")), { version: 1, enabled: true }, "The mode record keeps the 2.8 format")
    for (const [name, before] of Object.entries(legacy)) {
      const info = await stat(path.join(legacyDirectory, name))
      assert.ok((await readFile(path.join(legacyDirectory, name))).equals(before.bytes), `${name} bytes untouched`)
      assert.deepEqual({ mtimeMs: info.mtimeMs, ino: info.ino, size: info.size }, { mtimeMs: before.mtimeMs, ino: before.ino, size: before.size }, `${name} metadata untouched`)
    }
    await stat(path.join(legacyDirectory, "history-v2.sqlite"))
    result.legacy = Object.fromEntries(Object.entries(legacy).map(([name, value]) => [name, { size: value.size }]))
  } else throw new Error(`Unknown scenario ${scenario}`)
  await fixture.finish()
} catch (error) {
  await fixture.finish(error)
}
