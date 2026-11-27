// Inventory owner: advisory/once/steering/unconfigured scenarios, no flags; linux/git/tmux/npm-pack/tar/bundle.
// Headless server review: one managed OpenCode service with the installed package listed only in the
// project's opencode.json, a server-user reviewer policy file, a synthetic session model and a loopback
// reviewer. No terminal is ever attached. Proves the server engine's scoped model request and outcome.
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { headlessFixture, reviewerModel } from "./smoke-v2-headless-support.mjs"

const { scenario } = runtimeArguments("smoke-v2-headless.mjs")
const automatic = scenario === "once", steering = scenario === "steering", configured = scenario !== "unconfigured"
const marker = "HEADLESS_MARKER"
const prompt = "Run the headless marker command."
const assessment = steering ? { safe: false, reason: "Marker command not needed.", desc: "The marker command adds nothing to the task.", steering: "Skip the marker command." }
  : { safe: true, reason: "Decisive reason.", desc: "Prints a fixed marker. No side effects." }
const limitations = [
  "One isolated managed service and the installed archive, driven only through the public HTTP API. No terminal, viewer, desktop delivery, history browsing, live-provider judgment, standalone or foreground server acceptance.",
  configured ? "The policy file is written before the service starts. Live policy edits are source-tested." : "Without a policy file the server identifies itself and reviews nothing; this does not test a later policy arrival.",
]

const fixture = await headlessFixture({ fixture: "v2-headless", scenario, limitations,
  review: (evidence, body) => {
    assert.equal(body.model, reviewerModel)
    assert.equal(evidence.kind, "shell")
    assert.equal(evidence.command, `echo ${marker}`)
    assert.equal(evidence.userPrompt, prompt)
    return assessment
  },
  agent: (_body, { lastRole }) => lastRole === "tool" ? { text: "done" } : { toolCalls: [{ name: "shell", arguments: { command: `echo ${marker}` } }] },
})
const { result, until, location, rpc, snapshot, replied, toolResult } = fixture

try {
  if (configured) await fixture.writePolicy({ server: fixture.serverPolicy({ autoApprove: automatic, autoRejectSteering: steering, autoApproveDelaySeconds: 1 }) })
  await fixture.startService()
  const client = fixture.client()
  // Boot the location: the server plugin registers its RPC during activation.
  const session = await client.session.create({ title: "Headless review fixture", location })
  await fixture.verified(configured ? { enabled: true } : { enabled: false, reason: "no-policy" })
  await client.session.prompt({ sessionID: session.id, text: prompt })
  const asked = await until("native permission", () => fixture.asked(session.id)[0])
  assert.equal(asked.data.action, "shell")
  assert.deepEqual(asked.data.resources, [`echo ${marker}`])
  if (!configured) {
    await sleep(3000)
    assert.equal(result.reviewPOSTs.length, 0, "An unconfigured server never calls a reviewer model")
    assert.equal(replied(asked.data.id).length, 0, "An unconfigured server never replies")
    assert.deepEqual((await client.permission.list({ sessionID: session.id })).map(item => item.id), [asked.data.id])
  } else {
    await until("reviewer POST", () => result.reviewPOSTs.length === 1)
    const reviewed = await until("completed server review", async () => {
      const value = await snapshot()
      const view = value.views.find(item => item.view.request.id === asked.data.id)
      return view && (view.view.status === "complete" || view.view.resolved) ? view : false
    })
    assert.equal(reviewed.head, true)
    assert.equal(reviewed.root, session.id, "The server resolved the conversation root")
    if (!automatic && !steering) {
      assert.equal(reviewed.view.assessment.safe, true)
      assert.equal(reviewed.view.assessment.reason, assessment.reason)
      assert.equal(reviewed.view.autoApproval, undefined, "Advisory reviews arm nothing")
      await sleep(3000)
      assert.equal(replied(asked.data.id).length, 0, "Advisory never writes")
      assert.deepEqual((await client.permission.list({ sessionID: session.id })).map(item => item.id), [asked.data.id])
    }
  }
  if (automatic || steering) {
    await until("automatic native reply", () => replied(asked.data.id).length === 1, 30000)
    assert.equal(replied(asked.data.id)[0].data.reply, steering ? "reject" : "once")
  } else {
    await client.permission.reply({ sessionID: session.id, requestID: asked.data.id, decision: "once" })
    result.replies.push({ by: "fixture", decision: "once" })
    await until("manual reply observed", () => replied(asked.data.id).length === 1)
  }
  await until("session idle", async () => (await client.session.get({ sessionID: session.id })).time.idle)
  const output = await until("tool result delivered to the session model", () => toolResult("headless-call-1"))
  if (steering) {
    assert.match(output.content, /permission\.rejected/)
    assert.match(output.content, /Rejected by opencode-reviewer: Marker command not needed\. Skip the marker command\./)
  } else assert.match(output.content, new RegExp(marker))
  assert.equal(replied(asked.data.id).length, 1, "Exactly one native resolution")
  assert.equal(result.reviewPOSTs.length, configured ? 1 : 0, "Exactly one reviewer POST per reviewed permission")
  // The server records the review and its outcome once in the shared v2 store.
  const statistics = await until("recorded statistics", async () => {
    const value = await rpc().statistics({ sessionID: session.id }, { location })
    return value.conversation?.totals.requests === (configured ? 1 : 0) && value.totals.requests === (configured ? 1 : 0) ? value : false
  })
  result.statistics = statistics
  if (configured) {
    assert.equal(statistics.conversation.totals.safe + statistics.conversation.totals.unsafe, 1)
    const history = await rpc().history({ sessionID: session.id }, { location })
    result.history = history
    assert.equal(history.total, 1, "One saved review for the conversation")
    assert.equal(history.record?.context.permission, asked.data.id)
    // A confirmed steering rejection is saved as rejected with its steering text.
    assert.equal(history.record.outcome, steering ? "rejected" : automatic ? "auto" : "approved")
    if (steering) assert.match(history.record.steering ?? "", /Skip the marker command/)
    else assert.equal(history.record.steering, undefined)
  }
  await fixture.finish()
} catch (error) {
  await fixture.finish(error)
}
