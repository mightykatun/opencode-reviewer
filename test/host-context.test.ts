import assert from "node:assert/strict"
import { test } from "node:test"
import type { MessageListInput, SessionInfo, SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo, SessionMessagesResponse } from "@opencode/client"
import { loadHostConversationContext, type HostContextReader } from "../src/host-context.js"
import { bindTransportOwnership, TransportOwnership } from "../src/transport-ownership.js"
import { withDeadline } from "../src/deadline.js"

const scope = { sessionID: "ses_root", location: { directory: "/project" } }
const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function session(id = "ses_root", parentID?: string, directory = "/project"): SessionInfo {
  return { id, ...(parentID === undefined ? {} : { parentID }), projectID: "project", location: { directory },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }
}
function user(id: string, text: string, created = 1): SessionMessageInfo {
  return { id, type: "user", text, time: { created } }
}
const page = (...data: SessionMessageInfo[]): SessionMessagesResponse => ({ data, cursor: { next: null, previous: null } })
/** Delivered user pages and assistant pages are served from separate queues, as the host filters by type. */
function fixture(sessions: SessionInfo[], pages: SessionMessagesResponse[], assistantPages: SessionMessagesResponse[] = [page()]) {
  const gets: string[] = [], lists: MessageListInput[] = [], questionLists: MessageListInput[] = []
  const reader: HostContextReader = {
    session: { get: async ({ sessionID }, options) => {
      assert.ok(options?.signal)
      gets.push(sessionID)
      const found = sessions.find((item) => item.id === sessionID)
      if (!found) throw new Error("Session unavailable")
      return found
    } },
    message: { list: async (input, options) => {
      assert.ok(options?.signal)
      const [reads, queue] = input.type === "assistant" ? [questionLists, assistantPages] : [lists, pages]
      reads.push(input)
      const next = queue[reads.length - 1]
      assert.ok(next, "unexpected message read")
      return next
    } },
  }
  return { reader, gets, lists, questionLists }
}

test("V2 root reads delivered projection in durable order, not timestamp or ID order", async () => {
  const f = fixture([session()], [page(user("msg_a", "latest", 1))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.userPrompt, "latest")
  assert.equal(result.rootMessageID, "msg_a")
  assert.equal(result.delegation, undefined)
  assert.deepEqual(result.limitations, [])
  assert.deepEqual(f.gets, ["ses_root"])
  assert.deepEqual(f.lists, [{ sessionID: "ses_root", type: "user", limit: 100, order: "desc" }])
  assert.deepEqual(result.current, { id: "ses_root", projectID: "project", location: { directory: "/project" } })
  assert.deepEqual(result.userHistory, [{ type: "latest-prompt" }])
})

test("earlier root prompts follow cursor.next and arrive oldest first, separate from the latest", async () => {
  const f = fixture([session()], [
    { data: [user("u4", "latest ask"), user("u3", "  third  ")], cursor: { next: "c1" } },
    { data: [user("u2", ""), user("u1", "first ask")], cursor: { next: null } },
  ])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.userPrompt, "latest ask")
  assert.equal(result.rootMessageID, "u4")
  assert.deepEqual(result.userHistory, [{ type: "prompt", text: "first ask" },
    { type: "prompt", text: null, reason: "No nonempty text (empty or attachment-only message)." }, { type: "prompt", text: "third" },
    { type: "latest-prompt" }])
  assert.deepEqual(result.limitations, [])
  assert.deepEqual(f.lists, [{ sessionID: "ses_root", type: "user", limit: 100, order: "desc" },
    { sessionID: "ses_root", type: "user", limit: 100, cursor: "c1" }])
})

test("an empty latest message keeps earlier prompts as history, never as the latest request", async () => {
  const f = fixture([session()], [page(user("latest", ""), user("older", "older task"))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.userPrompt, null)
  assert.deepEqual(result.userHistory, [{ type: "prompt", text: "older task" }, { type: "latest-prompt" }])
  assert.match(result.limitations[0]!, /no nonempty text; no older prompt was substituted/)
})

test("earlier prompts keep exact leading lines per prompt and drop the oldest past the total budget", async () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n")
  const f = fixture([session()], [page(user("latest", "now"), user("long", long), user("single", "y".repeat(9000)),
    ...Array.from({ length: 12 }, (_, i) => user(`filler${i}`, "z".repeat(6000))), user("oldest", "original task"))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  const prompts = result.userHistory.filter(entry => entry.type === "prompt")
  const newest = prompts.at(-1)!
  assert.ok(newest.truncated && newest.text && Buffer.byteLength(newest.text) <= 8192)
  assert.ok(long.startsWith(newest.text))
  assert.equal(newest.truncated.includedLines + newest.truncated.omittedLines, 200)
  assert.deepEqual(prompts.at(-2), { type: "prompt", text: null, reason: "Omitted whole: its first line exceeds the 8 KiB per-prompt limit." })
  assert.ok(!prompts.some(prompt => prompt.text === "original task"))
  const kept = prompts.reduce((sum, prompt) => sum + Buffer.byteLength(prompt.text ?? ""), 0)
  assert.ok(kept <= 65536)
  assert.ok(result.limitations.some(note => /keep exact leading lines/.test(note)))
  assert.ok(result.limitations.some(note => /oldest earlier root user prompts that were read are omitted/.test(note)))
})

test("history reads stop after four pages and state that older messages exist", async () => {
  const pages = Array.from({ length: 5 }, (_, n) => ({ data: [user(`m${n}`, `ask ${n}`)], cursor: { next: `c${n}` } }))
  const f = fixture([session()], pages)
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(f.lists.length, 4)
  assert.equal(result.userPrompt, "ask 0")
  assert.deepEqual(result.userHistory.map(entry => entry.type === "prompt" ? entry.text : entry.type), ["ask 3", "ask 2", "ask 1", "latest-prompt"])
  assert.deepEqual(result.limitations, ["Only the latest 4 delivered root user messages were read; older ones exist and are not included."])
})

test("a failed earlier page is a factual omission, while invalid or repeated history fails", async () => {
  const failing = fixture([session()], [{ data: [user("latest", "now"), user("b", "before")], cursor: { next: "c1" } }])
  const list = failing.reader.message.list
  failing.reader.message.list = async (input, options) => {
    if (input.cursor) { failing.lists.push(input); throw new Error("transport reset") }
    return list(input, options)
  }
  const result = await loadHostConversationContext(scope, failing.reader, signal())
  assert.deepEqual(result.userHistory, [{ type: "prompt", text: "before" }, { type: "latest-prompt" }])
  assert.deepEqual(result.limitations, ["Older root user messages beyond the latest 2 could not be read and are not included."])
  for (const second of [{ data: [{ id: "x", type: "synthetic", text: "bg", time: { created: 1 } }], cursor: {} },
    { data: [user("latest", "again")], cursor: {} }, { data: [], cursor: { next: 7 } }]) {
    const f = fixture([session()], [{ data: [user("latest", "now")], cursor: { next: "c1" } }, second as SessionMessagesResponse])
    await assert.rejects(loadHostConversationContext(scope, f.reader, signal()), /history (message|cursor) invalid|repeats a message/)
  }
})

test("a stalled earlier page is omitted within its share of the context deadline", async () => {
  const f = fixture([session()], [{ data: [user("latest", "now")], cursor: { next: "c1" } }])
  const list = f.reader.message.list
  f.reader.message.list = (input, options) => input.cursor ? new Promise(() => {}) : list(input, options)
  const result = await withDeadline(signal(), 300, (bounded) => loadHostConversationContext(scope, f.reader, bounded))
  assert.equal(result.userPrompt, "now")
  assert.deepEqual(result.limitations, ["Older root user messages beyond the latest 1 could not be read and are not included."])
})

test("a parent abort during an earlier page rejects instead of omitting", async () => {
  const controller = new AbortController(), started = deferred<void>(), reason = new Error("stop")
  const f = fixture([session()], [{ data: [user("latest", "now")], cursor: { next: "c1" } }])
  const list = f.reader.message.list
  f.reader.message.list = (input, options) => {
    if (!input.cursor) return list(input, options)
    started.resolve()
    return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason)))
  }
  const pending = loadHostConversationContext(scope, f.reader, controller.signal)
  await started.promise
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
})

for (const text of ["", "   "]) test(`latest empty/attachment user blocks older text: ${JSON.stringify(text)}`, async () => {
  const latest: SessionMessageInfo = { id: "latest", type: "user", text,
    files: [{ data: "", source: { type: "uri", uri: "file:///project/image.png" }, mime: "image/png" }], time: { created: 2 } }
  const f = fixture([session()], [page(latest)])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.userPrompt, null)
  assert.equal(result.rootMessageID, "latest")
  assert.match(result.limitations[0]!, /no nonempty text/)
})

test("synthetic, system and skill instructions are never genuine user intent", async () => {
  for (const message of [
    { id: "synthetic", type: "synthetic", text: "background", time: { created: 9 } },
    { id: "system", type: "system", text: "system", time: { created: 8 } },
    { id: "skill", type: "skill", text: "instructions", skill: "skill", name: "Skill", time: { created: 7 } },
  ] as SessionMessageInfo[]) {
    const f = fixture([session()], [page(message)])
    await assert.rejects(loadHostConversationContext(scope, f.reader, signal()), /message invalid/)
  }
})

test("a delivered empty user message without attachments also blocks older intent", async () => {
  const f = fixture([session()], [page(user("empty", ""))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.rootMessageID, "empty")
  assert.equal(result.userPrompt, null)
})

test("nested sessions read root intent across legitimate parent locations and omit unlinked delegation", async () => {
  const f = fixture([session("child", "parent"), session("parent", "root", "/parent"), session("root", undefined, "/root")],
    [page(user("root-request", "root task"))])
  const result = await loadHostConversationContext({ ...scope, sessionID: "child" }, f.reader, signal())
  assert.deepEqual(f.gets, ["child", "parent", "root"])
  assert.equal(f.lists[0]?.sessionID, "root")
  assert.equal(result.root.location.directory, "/root")
  assert.equal(result.current.id, "child")
  assert.deepEqual(result.delegation, { sessionID: "child", parentSessionID: "parent", messageID: null, prompt: null })
  assert.deepEqual(result.limitations, ["Exact immediate subagent delegation is unavailable from the public V2 invocation linkage; delegation text is omitted."])
})

test("wrong requested-session identity and changed captured location reject before messages", async () => {
  for (const info of [session("wrong"), session("ses_root", undefined, "/changed")]) {
    const f = fixture([], [])
    f.reader.session.get = async () => info
    await assert.rejects(loadHostConversationContext(scope, f.reader, signal()), /mismatched|captured invocation scope/)
    assert.deepEqual(f.lists, [])
  }
})

test("scope is copied before asynchronous reads", async () => {
  const input = { sessionID: "ses_root", location: { directory: "/project" } }
  const f = fixture([session()], [page(user("intent", "task"))])
  const pending = loadHostConversationContext(input, f.reader, signal())
  input.sessionID = "other"
  input.location.directory = "/other"
  assert.equal((await pending).current.id, "ses_root")
})

test("cycles, missing and mismatched parents never yield a guessed root", async () => {
  for (const sessions of [[session("ses_root", "ses_root")], [session("ses_root", "missing")],
    [session("ses_root", "parent"), session("parent", "ses_root")]]) {
    const f = fixture(sessions, [])
    await assert.rejects(loadHostConversationContext(scope, f.reader, signal()), /ancestry incomplete|unavailable/)
    assert.deepEqual(f.lists, [])
  }
  const f = fixture([], [])
  f.reader.session.get = async ({ sessionID }) => sessionID === "ses_root" ? session("ses_root", "parent") : session("sibling")
  await assert.rejects(loadHostConversationContext(scope, f.reader, signal()), /mismatched/)
})

test("16 ancestry edges are accepted and a seventeenth is rejected", async () => {
  for (const edges of [16, 17]) {
    const sessions = Array.from({ length: edges + 1 }, (_, i) => session(`s${i}`, i < edges ? `s${i + 1}` : undefined))
    const f = fixture(sessions, [page(user("intent", "task"))])
    const pending = loadHostConversationContext({ ...scope, sessionID: "s0" }, f.reader, signal())
    if (edges === 16) assert.equal((await pending).root.id, "s16")
    else await assert.rejects(pending, /16-edge limit/)
    assert.equal(f.gets.length, 17)
  }
})

test("malformed and unfiltered responses fail without falling back to older intent", async () => {
  const oversized = { data: Array.from({ length: 101 }, (_, i) => user(`m${i}`, "x")), cursor: {} }
  for (const response of [null, oversized, { data: [user("a", "latest"), user("a", "repeat")], cursor: {} },
    { data: [], cursor: null }, { data: [], cursor: [] }, { data: [{}], cursor: {} },
    { data: [{ id: "latest", type: "user" }], cursor: {} }]) {
    const f = fixture([session()], [response as SessionMessagesResponse])
    f.reader.message.list = async input => { f.lists.push(input); return response as SessionMessagesResponse }
    await assert.rejects(loadHostConversationContext(scope, f.reader, signal()), /history response|message invalid|repeats a message/)
    assert.equal(f.lists.length, 1)
  }
})

test("exhausted delivered history reports absence", async () => {
  const f = fixture([session()], [page()])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.rootMessageID, undefined)
  assert.equal(result.userPrompt, null)
  assert.deepEqual(result.limitations, ["No delivered root user message is available."])
})

test("64 KiB UTF-8 prompt boundary preserves exact identity and omits whole oversized text", async () => {
  for (const text of ["x".repeat(65536), "é".repeat(32768), "é".repeat(32769), "x".repeat(65537)]) {
    const f = fixture([session()], [page(user("latest", text))])
    const result = await loadHostConversationContext(scope, f.reader, signal())
    assert.equal(result.rootMessageID, "latest")
    if (Buffer.byteLength(text) <= 65536) assert.equal(result.userPrompt, text)
    else {
      assert.equal(result.userPrompt, null)
      assert.deepEqual(result.limitations, ["Latest delivered root user prompt omitted because it exceeds the 64 KiB context limit; no older prompt was substituted."])
    }
  }
})

test("already aborted calls dispatch nothing", async () => {
  const controller = new AbortController()
  const reason = new Error("stop")
  controller.abort(reason)
  const f = fixture([], [])
  await assert.rejects(loadHostConversationContext(scope, f.reader, controller.signal), (error) => error === reason)
  assert.deepEqual(f.gets, [])
})

test("mid-read abort propagates while late unresolved transport retains physical ownership", async () => {
  const controller = new AbortController()
  const ownership = new TransportOwnership()
  bindTransportOwnership(controller.signal, ownership)
  const started = deferred<void>()
  const late = deferred<SessionMessagesResponse>()
  let readSignal: AbortSignal | undefined
  const f = fixture([session()], [])
  f.reader.message.list = (_input, options) => {
    readSignal = options?.signal
    started.resolve()
    return late.promise
  }
  const pending = loadHostConversationContext(scope, f.reader, controller.signal)
  await started.promise
  const reason = new Error("parent canceled")
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  assert.equal(readSignal?.aborted, true)
  let settled = false
  const drained = ownership.settled().then(() => { settled = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  late.resolve(page(user("too-late", "must not be accepted")))
  await drained
  assert.equal(settled, true)
})

test("enclosing deadline keeps a rejected late session read owned through settlement", async () => {
  const controller = new AbortController()
  const ownership = new TransportOwnership()
  bindTransportOwnership(controller.signal, ownership)
  const late = deferred<SessionInfo>()
  const started = deferred<void>()
  const f = fixture([], [])
  f.reader.session.get = () => { started.resolve(); return late.promise }
  const pending = withDeadline(controller.signal, 60,
    (bounded) => loadHostConversationContext(scope, f.reader, bounded))
  await started.promise
  await assert.rejects(pending, /timed out/)
  let settled = false
  const drained = ownership.settled().then(() => { settled = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  late.reject(new Error("late transport failure"))
  await drained
  assert.deepEqual(f.lists, [])
})

type Asked = Array<[header: string, question: string, labels: string[]]>
const askedInput = (asked: Asked) => ({ questions: asked.map(([header, question, labels]) =>
  ({ header, question, options: labels.map(label => ({ label, description: `${label} described` })) })) })
type ToolState = SessionMessageAssistantTool["state"]
function questionCall(id: string, settledAt: number, state: ToolState): SessionMessageAssistantTool {
  return { type: "tool", id, name: "question", state, time: { created: settledAt - 1, completed: settledAt } }
}
const answered = (id: string, settledAt: number, asked: Asked, answers: string[][]) => questionCall(id, settledAt,
  { status: "completed", input: askedInput(asked), content: [{ type: "text", text: "answered" }], metadata: { answers } })
const failed = (id: string, settledAt: number, asked: Asked, type: string, message: string) => questionCall(id, settledAt,
  { status: "error", input: askedInput(asked), error: { type, message } })
function assistant(id: string, created: number, ...content: SessionMessageAssistant["content"]): SessionMessageInfo {
  return { id, type: "assistant", agent: "build", model: { id: "model", providerID: "provider" }, content, time: { created } }
}
const scopeQuestion: Asked = [["Scope", "Touch staging too?", ["Yes", "No"]]]

test("settled questions interleave with prompts by settlement time, including after the latest prompt", async () => {
  const f = fixture([session()], [page(user("u3", "deploy it", 30), user("u2", "now fix the tests", 20), user("u1", "refactor the parser", 10))], [page(
    assistant("a4", 31, answered("q4", 35, [["Target", "Which environment?", ["staging", "production"]]], [["staging"]])),
    assistant("a3", 25, { type: "text", text: "thinking" }, answered("q3", 27, scopeQuestion, [["No"]])),
    assistant("a2", 12, answered("q2", 15, [["Style", "Keep the old API?", ["Yes", "No"]], ["Depth", "How deep?", ["Shallow"]]],
      [["Yes"], ["Only the lexer, leave the grammar alone"]])),
  )])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.userPrompt, "deploy it")
  assert.deepEqual(result.userHistory, [
    { type: "prompt", text: "refactor the parser" },
    { type: "questions", questions: [{ header: "Style", question: "Keep the old API?", options: ["Yes", "No"], answer: ["Yes"] },
      { header: "Depth", question: "How deep?", options: ["Shallow"], answer: ["Only the lexer, leave the grammar alone"] }] },
    { type: "prompt", text: "now fix the tests" },
    { type: "questions", questions: [{ header: "Scope", question: "Touch staging too?", options: ["Yes", "No"], answer: ["No"] }] },
    { type: "latest-prompt" },
    { type: "questions", questions: [{ header: "Target", question: "Which environment?", options: ["staging", "production"], answer: ["staging"] }] },
  ])
  assert.deepEqual(result.limitations, [])
  assert.deepEqual(f.questionLists, [{ sessionID: "ses_root", type: "assistant", order: "desc", limit: 100 }])
})

test("typed dismissals are kept while plain dismissals, denials, invalid and unsettled calls are ignored", async () => {
  const f = fixture([session()], [page(user("u1", "clean up", 1))], [page(assistant("a1", 2,
    failed("typed", 10, scopeQuestion, "tool.execution", "  Do not touch staging at all  "),
    failed("plain", 11, scopeQuestion, "aborted", "The user dismissed this question"),
    failed("denied", 12, scopeQuestion, "permission.rejected", "Permission denied: question"),
    questionCall("invalid", 13, { status: "error", input: { questions: [] }, error: { type: "tool.execution", message: "Invalid tool input" } }),
    questionCall("running", 14, { status: "running", input: askedInput(scopeQuestion), metadata: {} }),
    { type: "tool", id: "other", name: "shell", state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] }, time: { created: 15 } },
    answered("blank", 16, scopeQuestion, [[]]),
  ))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.deepEqual(result.userHistory, [{ type: "latest-prompt" },
    { type: "questions", questions: [{ header: "Scope", question: "Touch staging too?", options: ["Yes", "No"] }], dismissedWithMessage: "Do not touch staging at all" },
    { type: "questions", questions: [{ header: "Scope", question: "Touch staging too?", options: ["Yes", "No"], answer: [] }] }])
  assert.deepEqual(result.limitations, [])
})

test("inconsistent settled question records are counted and omitted", async () => {
  const missingTime = answered("untimed", 10, scopeQuestion, [["Yes"]])
  delete missingTime.time.completed
  const f = fixture([session()], [page(user("u1", "task", 1))], [page(assistant("a1", 2,
    answered("mismatch", 10, scopeQuestion, [["Yes"], ["No"]]), missingTime,
    failed("empty", 11, scopeQuestion, "tool.execution", "   "), answered("good", 12, scopeQuestion, [["No"]])))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.userHistory.length, 2)
  assert.deepEqual(result.limitations, ["3 settled question records were inconsistent and are not included."])
})

test("question entries drop option labels, then omit whole, within the 4 KiB entry and 32 KiB total budgets", async () => {
  const labels = Array.from({ length: 40 }, (_, i) => `option ${i} ${"l".repeat(100)}`)
  const calls = [
    answered("whole", 10, [["Huge", "Answer?", []]], [["a".repeat(5000)]]),
    ...Array.from({ length: 12 }, (_, i) => answered(`filler${i}`, 20 + i, [["Fill", "q".repeat(3000), []]], [["ok"]])),
    answered("labels", 40, [["Pick", "Which one?", labels]], [["option 1"]]),
  ]
  const f = fixture([session()], [page(user("u1", "task", 1))], [page(assistant("a1", 2, ...calls.reverse()))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  const entries = result.userHistory.filter(entry => entry.type === "questions")
  assert.deepEqual(entries.at(-1), { type: "questions", optionsOmitted: true,
    questions: [{ header: "Pick", question: "Which one?", options: [], answer: ["option 1"] }] })
  assert.ok(entries.length < 14)
  assert.ok(!entries.some(entry => "omitted" in entry), "the oversized oldest call falls outside the total budget")
  const total = entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0)
  assert.ok(total <= 32768)
  assert.ok(result.limitations.includes("Some settled question entries exceed the 4 KiB per-entry limit and omit their option labels."))
  assert.ok(result.limitations.some(note => /oldest settled question calls that were read are omitted because questions exceed the 32 KiB total limit/.test(note)))

  const single = fixture([session()], [page(user("u1", "task", 1))], [page(assistant("a1", 2, calls.at(-1)!))])
  assert.deepEqual((await loadHostConversationContext(scope, single.reader, signal())).userHistory.at(-1),
    { type: "questions", omitted: "Omitted whole: its questions and answers exceed the 4 KiB per-entry limit." })
})

test("question reads stop at the oldest read prompt and skip calls settled before it", async () => {
  const f = fixture([session()], [page(user("u2", "latest", 50), user("u1", "oldest read", 40))], [
    { data: [assistant("a2", 45, answered("inside", 46, scopeQuestion, [["Yes"]])),
      assistant("a1", 30, answered("before", 35, scopeQuestion, [["No"]]))], cursor: { next: "older" } }])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(f.questionLists.length, 1)
  assert.deepEqual(result.userHistory.map(entry => entry.type), ["prompt", "questions", "latest-prompt"])
})

test("question reads follow cursor.next up to four pages and state the omission", async () => {
  const pages = Array.from({ length: 5 }, (_, n) => ({ data: [assistant(`a${n}`, 100 - n)], cursor: { next: `c${n}` } }))
  const f = fixture([session()], [page(user("u1", "task", 1))], pages)
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.deepEqual(f.questionLists.map(input => input.cursor), [undefined, "c0", "c1", "c2"])
  assert.deepEqual(result.limitations, ["Questions were read only from the latest 400 root assistant messages. Older questions are not included."])
})

test("failed, invalid or stalled question reads are factual omissions, never review failures", async () => {
  const note = "Questions the agent asked in the root conversation could not be read and are not included."
  for (const assistantPage of [page(user("wrong", "not an assistant")), { data: [], cursor: null }] as SessionMessagesResponse[]) {
    const f = fixture([session()], [page(user("u1", "task", 1))], [assistantPage])
    const result = await loadHostConversationContext(scope, f.reader, signal())
    assert.equal(result.userPrompt, "task")
    assert.deepEqual(result.limitations, [note])
  }
  const stalled = fixture([session()], [page(user("u1", "task", 1))])
  const list = stalled.reader.message.list
  stalled.reader.message.list = (input, options) => input.type === "assistant" ? new Promise(() => {}) : list(input, options)
  const result = await withDeadline(signal(), 300, (bounded) => loadHostConversationContext(scope, stalled.reader, bounded))
  assert.deepEqual(result.userHistory, [{ type: "latest-prompt" }])
  assert.deepEqual(result.limitations, [note])
})

test("a parent abort during the question read rejects instead of omitting", async () => {
  const controller = new AbortController(), started = deferred<void>(), reason = new Error("stop")
  const f = fixture([session()], [page(user("u1", "task", 1))])
  const list = f.reader.message.list
  f.reader.message.list = (input, options) => {
    if (input.type !== "assistant") return list(input, options)
    started.resolve()
    return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason)))
  }
  const pending = loadHostConversationContext(scope, f.reader, controller.signal)
  await started.promise
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
})

test("questions are not placed when a root user message lacks a creation time", async () => {
  const untimed = { id: "u1", type: "user", text: "task" } as SessionMessageInfo
  const f = fixture([session()], [page(untimed)], [page(assistant("a1", 2, answered("q", 3, scopeQuestion, [["Yes"]])))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.deepEqual(result.userHistory, [{ type: "latest-prompt" }])
  assert.deepEqual(result.limitations, ["Settled questions are not included because some root user messages lack a creation time to order them by."])
})
