import assert from "node:assert/strict"
import { test } from "node:test"
import type { HostReviewEvidence } from "../src/host-evidence.js"
import type { HostRequest } from "../src/host-types.js"
import { boundAgentOutput, followUpCategory, readSteeringFollowUp, rejectedOperation, SteeringFollowUps,
  type AgentOutputItem, type FollowUpReader, type SteeringRecord } from "../src/steering-follow-up.js"
import { trailingLines } from "../src/truncate.js"

const request = (id: string, assistantID: string | undefined, action = "shell", sessionID = "session", callID = `call-${id}`): HostRequest =>
  ({ id, sessionID, action, resources: [], ...(assistantID ? { source: { assistantID, id: callID } } : {}) })

function evidence(kind: HostReviewEvidence["kind"], options: { session?: string; root?: string; rootMessageID?: string } = {}): HostReviewEvidence {
  const current = { id: options.session ?? "session", projectID: "p", location: { directory: "/p" } }
  const root = { ...current, id: options.root ?? current.id }
  const base = { permission: { id: "x", sessionID: current.id, action: kind, resources: ["/outside"], metadataStatus: "" }, location: { directory: "/p" },
    project: { id: "p", directory: "/p", canonical: "/p" }, limitations: [], userPrompt: null, earlierUserPrompts: [],
    conversation: { current, root, ...(options.rootMessageID ? { rootMessageID: options.rootMessageID } : {}) } }
  if (kind === "shell") return { ...base, kind, tool: "shell", operation: { input: { command: "rm -rf build" }, inputStatus: "" }, command: "rm -rf build", cwd: "/p",
    execution: { tool: "shell", requestedWorkdir: null, canonicalCwd: "/p", cwdSource: "invocation.location.directory" } } as HostReviewEvidence
  if (kind === "edit") return { ...base, kind, tool: "edit", operation: { input: { path: "a.txt" }, inputStatus: "" }, changes: [{ file: "a.txt", status: "included", patch: "secret diff" }], partial: false } as HostReviewEvidence
  if (kind === "external-directory") return { ...base, kind, tool: "read", operation: { input: { path: "/outside/a" }, inputStatus: "" }, partial: false } as HostReviewEvidence
  return { ...base, kind, tool: "mcp_tool", operation: { input: { query: "x" }, inputStatus: "" }, definition: { id: "mcp_tool", description: "long description" } } as HostReviewEvidence
}

/** Record a confirmed steering for request A, reviewed with evidence of its kind. */
function steer(tracker: SteeringFollowUps, value: HostRequest, kind: HostReviewEvidence["kind"] = "shell", options: Parameters<typeof evidence>[1] = {}) {
  tracker.asked(value)
  tracker.observe(`review-${value.id}`, evidence(kind, { session: value.sessionID, ...options }))
  tracker.steered(value, `review-${value.id}`, `message-${value.id}`)
}

test("native actions map to review categories, and unreviewed native actions have none", () => {
  assert.deepEqual(["shell", "edit", "external_directory", "skill", "my_mcp_tool", "read", "execute"].map(followUpCategory),
    ["shell", "edit", "external-directory", "skill", "tool", undefined, undefined])
})

test("rejected operation summaries keep the category, tool and main input, never diffs or definitions", () => {
  assert.deepEqual(rejectedOperation(evidence("shell")), { category: "shell", tool: "shell", input: { command: "rm -rf build", cwd: "/p" } })
  assert.deepEqual(rejectedOperation(evidence("edit")), { category: "edit", tool: "edit", input: { path: "a.txt" } })
  assert.deepEqual(rejectedOperation(evidence("external-directory")),
    { category: "external-directory", tool: "read", input: { path: "/outside/a", directories: ["/outside"] } })
  assert.deepEqual(rejectedOperation(evidence("tool")), { category: "tool", tool: "mcp_tool", input: { query: "x" } })
  const huge = evidence("shell") as Extract<HostReviewEvidence, { kind: "shell" }>
  assert.deepEqual(rejectedOperation({ ...huge, command: "x".repeat(9000) }).input, { omitted: "Input exceeds the 8 KiB summary limit." })
})

test("requests queued in the steered step never pair, and the first later-step request of the category takes the steering once", () => {
  const tracker = new SteeringFollowUps(), a = request("a", "step-1")
  tracker.asked(request("queued-before", "step-1"))
  steer(tracker, a)
  tracker.asked(request("queued-after", "step-1"))
  assert.equal(tracker.paired("queued-before"), undefined)
  assert.equal(tracker.paired("queued-after"), undefined, "a sibling call from the steered step was queued, not a reaction")
  tracker.asked(request("x", "step-2"))
  assert.equal(tracker.paired("x")?.message, "message-a")
  assert.equal(tracker.paired("x")?.callID, "call-a")
  tracker.asked(request("y", "step-2"))
  assert.equal(tracker.paired("y"), undefined, "the steering is consumed when assigned")
  assert.deepEqual(tracker.pending("session"), [])
})

test("several open steerings pair oldest first, one per later tool call, in arrival order", () => {
  const tracker = new SteeringFollowUps()
  steer(tracker, request("a", "step-1")); steer(tracker, request("b", "step-1"))
  tracker.asked(request("c", "step-2")); tracker.asked(request("d", "step-2")); tracker.asked(request("e", "step-2"))
  assert.equal(tracker.paired("c")?.message, "message-a")
  assert.equal(tracker.paired("d")?.message, "message-b")
  assert.equal(tracker.paired("e"), undefined)
})

test("every permission request of one tool call shares its steering across categories", () => {
  const tracker = new SteeringFollowUps()
  steer(tracker, request("a", "step-1", "external_directory"), "external-directory"); steer(tracker, request("b", "step-1", "external_directory"), "external-directory")
  tracker.asked(request("dir", "step-2", "external_directory", "session", "retry"))
  tracker.asked(request("shell", "step-2", "shell", "session", "retry"))
  assert.equal(tracker.paired("dir")?.message, "message-a")
  assert.equal(tracker.paired("shell")?.message, "message-a", "the same call keeps A instead of consuming B")
  assert.deepEqual(tracker.pending("session").map(record => record.message), ["message-b"])
})

test("other categories, sourceless requests, sessions and subagents never consume a steering", () => {
  const tracker = new SteeringFollowUps()
  steer(tracker, request("a", "step-1"))
  tracker.asked(request("edit", "step-2", "edit"))
  tracker.asked(request("sourceless", undefined))
  tracker.asked(request("child", "child-step", "shell", "child"))
  tracker.asked(request("native-read", "step-2", "read"))
  for (const id of ["edit", "sourceless", "child", "native-read"]) assert.equal(tracker.paired(id), undefined)
  tracker.replied("session", "edit", "once")
  tracker.replied("session", "sourceless", "once")
  assert.equal(tracker.pending("session").length, 1, "other-category and sourceless approvals keep it open")
  tracker.asked(request("x", "step-3"))
  assert.equal(tracker.paired("x")?.message, "message-a")
})

test("only an unpaired approval from a later step drops open steerings, paired and same-step approvals keep them", () => {
  const tracker = new SteeringFollowUps()
  tracker.asked(request("sibling", "step-1"))
  steer(tracker, request("a", "step-1")); steer(tracker, request("b", "step-1"))
  tracker.replied("session", "sibling", "once")
  assert.equal(tracker.pending("session").length, 2, "approving a queued sibling from the steered step keeps them")
  tracker.asked(request("c", "step-2"))
  tracker.replied("session", "c", "always")
  assert.equal(tracker.pending("session").length, 1, "approving the paired request keeps the rest")
  // An unpaired later-step shell request can only exist when it arrived before the steering was recorded.
  const late = new SteeringFollowUps()
  late.asked(request("early", "step-2"))
  steer(late, request("a", "step-1"))
  late.replied("session", "early", "once")
  assert.deepEqual(late.pending("session"), [])
})

test("deletion and clearing drop records, and a newer root user message ends older root-session steerings", () => {
  const tracker = new SteeringFollowUps()
  steer(tracker, request("a", "step-1"), "shell", { rootMessageID: "user-1" })
  steer(tracker, request("child-a", "c-1", "shell", "child"), "shell", { root: "session", rootMessageID: "user-1" })
  steer(tracker, request("b", "step-2"), "shell", { rootMessageID: "user-2" })
  assert.deepEqual(tracker.pending("session").map(record => record.message), ["message-b"])
  assert.equal(tracker.pending("child")[0]?.root, false, "subagent steerings are not root-session steerings")
  tracker.deleted("session")
  assert.deepEqual(tracker.pending("session"), [])
  assert.equal(tracker.pending("child").length, 1)
  tracker.clear()
  assert.deepEqual(tracker.pending("child"), [])
  tracker.steered(request("z", "s"), "missing-review", "m")
  assert.deepEqual(tracker.pending("session"), [], "a steering without its reviewed summary opens nothing")
})

test("agent output keeps the newest items within 16 KiB and cuts one older item to its last lines", () => {
  const small: AgentOutputItem[] = [{ type: "text", text: "first" }, { type: "tool", tool: "read", input: { path: "a" } }]
  assert.deepEqual(boundAgentOutput(small), { agentOutput: small })
  const long = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n")
  const bounded = boundAgentOutput([{ type: "text", text: "dropped" }, { type: "reasoning", text: long }, { type: "text", text: "newest" }])
  assert.equal(bounded.omittedOlderItems, 1)
  assert.equal(bounded.agentOutput.length, 2)
  const cut = bounded.agentOutput[0]!
  assert.ok(cut.type === "reasoning" && cut.truncated && cut.text.endsWith("line 2999"))
  assert.equal(cut.type === "reasoning" && cut.truncated!.includedLines + cut.truncated!.omittedLines, 3000)
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.agentOutput)) <= 16384 + 8)
  const tool = boundAgentOutput([{ type: "tool", tool: "write", input: { content: "x".repeat(20000) } }])
  assert.deepEqual(tool, { agentOutput: [{ type: "tool", tool: "write", input: null, inputOmitted: "Input exceeds the remaining 16 KiB output limit." }] })
  const quoted = boundAgentOutput([{ type: "text", text: Array.from({ length: 4000 }, () => '"\\"').join("\n") }])
  assert.ok(Buffer.byteLength(JSON.stringify(quoted.agentOutput[0])) <= 16384, "JSON escaping is counted")
  assert.deepEqual(trailingLines("\nabc", 3), { text: "abc", lines: 1, bytes: 3 })
})

const record: SteeringRecord = { sessionID: "session", assistantID: "a-1", callID: "rejected", message: "Rejected by opencode-reviewer: x.",
  rejected: { category: "shell", tool: "shell", input: { command: "rm -rf build" } }, root: true, rootMessageID: "u" }
const tool = (id: string, name = "shell", input: unknown = { command: id }) => ({ type: "tool", id, name, state: { status: "completed", input } })

function reader(pages: unknown[][], seen: unknown[] = []): FollowUpReader {
  return { message: { list: (async (query: unknown) => {
    seen.push(query)
    const index = seen.length - 1
    return { data: pages[index] ?? [], cursor: index + 1 < pages.length ? { next: `page-${index + 1}` } : {} }
  }) as unknown as FollowUpReader["message"]["list"] } }
}

test("the follow-up span runs from just after the rejected call to just before this call, across pages", async () => {
  const seen: unknown[] = []
  const pages = [
    [{ id: "a-3", type: "assistant", content: [{ type: "reasoning", text: "Use the narrower path." }, { type: "text", text: "Retrying." }, tool("x"), tool("later")] },
      { id: "a-2", type: "assistant", content: [{ type: "text", text: "  " }, tool("inspect", "read", { path: "build" })] }],
    [{ id: "a-1", type: "assistant", content: [{ type: "text", text: "before" }, tool("rejected"), tool("queued")] }],
  ]
  const result = await readSteeringFollowUp(reader(pages, seen), record, request("x", "a-3", "shell", "session", "x"), new AbortController().signal)
  assert.deepEqual(result, { steeringMessage: record.message, rejectedOperation: record.rejected, agentOutput: [
    { type: "tool", tool: "shell", input: { command: "queued" } }, { type: "tool", tool: "read", input: { path: "build" } },
    { type: "reasoning", text: "Use the narrower path." }, { type: "text", text: "Retrying." }] })
  assert.deepEqual(seen, [{ sessionID: "session", type: "assistant", order: "desc", limit: 100 },
    { sessionID: "session", type: "assistant", cursor: "page-1", limit: 100 }])
})

test("a missing message or call, malformed data or a failed read yields no follow-up, but cancellation propagates", async () => {
  const signal = new AbortController().signal, x = request("x", "a-3", "shell", "session", "x")
  const ok = [{ id: "a-3", type: "assistant", content: [tool("x")] }, { id: "a-1", type: "assistant", content: [tool("rejected")] }]
  assert.ok(await readSteeringFollowUp(reader([ok]), record, x, signal))
  assert.equal(await readSteeringFollowUp(reader([[ok[0]]]), record, x, signal), undefined, "steered message not found")
  assert.equal(await readSteeringFollowUp(reader([[ok[0], { id: "a-1", type: "assistant", content: [] }]]), record, x, signal), undefined)
  assert.equal(await readSteeringFollowUp(reader([[{ id: "a-3", type: "assistant", content: [] }, ok[1]]]), record, x, signal), undefined)
  assert.equal(await readSteeringFollowUp(reader([[{ id: "a-3", type: "assistant", content: [{ type: "text" }] }, ok[1]]]), record, x, signal), undefined)
  assert.equal(await readSteeringFollowUp(reader([[{ ...ok[0], id: "a-1", content: [tool("x"), tool("rejected")] }]]), record,
    request("x", "a-1", "shell", "session", "x"), signal), undefined, "same step never yields a span")
  assert.equal(await readSteeringFollowUp(reader(Array.from({ length: 5 }, () => [{ id: "a-9", type: "assistant", content: [] }])), record, x, signal), undefined)
  const failing: FollowUpReader = { message: { list: (async () => { throw Error("offline") }) as unknown as FollowUpReader["message"]["list"] } }
  assert.equal(await readSteeringFollowUp(failing, record, x, signal), undefined)
  const abort = new AbortController()
  const cancelled: FollowUpReader = { message: { list: (async () => { abort.abort(); throw Error("aborted") }) as unknown as FollowUpReader["message"]["list"] } }
  await assert.rejects(readSteeringFollowUp(cancelled, record, x, abort.signal))
})
