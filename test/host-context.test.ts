import assert from "node:assert/strict"
import { test } from "node:test"
import type { MessageListInput, SessionInfo, SessionMessageInfo, SessionMessagesResponse } from "@opencode/client"
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
function fixture(sessions: SessionInfo[], pages: SessionMessagesResponse[]) {
  const gets: string[] = [], lists: MessageListInput[] = []
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
      lists.push(input)
      const page = pages[lists.length - 1]
      assert.ok(page, "unexpected message read")
      return page
    } },
  }
  return { reader, gets, lists }
}
const page = (...data: SessionMessageInfo[]): SessionMessagesResponse => ({ data, cursor: { next: null, previous: null } })

test("V2 root reads delivered projection in durable order, not timestamp or ID order", async () => {
  const f = fixture([session()], [page(user("msg_a", "latest", 1))])
  const result = await loadHostConversationContext(scope, f.reader, signal())
  assert.equal(result.userPrompt, "latest")
  assert.equal(result.rootMessageID, "msg_a")
  assert.equal(result.delegation, undefined)
  assert.deepEqual(result.limitations, [])
  assert.deepEqual(f.gets, ["ses_root"])
  assert.deepEqual(f.lists, [{ sessionID: "ses_root", type: "user", limit: 1, order: "desc" }])
  assert.deepEqual(result.current, { id: "ses_root", projectID: "project", location: { directory: "/project" } })
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

test("the latest filtered user does not traverse older users", async () => {
  const f = fixture([session()], [{ data: [user("root-request", "task")], cursor: { next: "older:opaque" } }])
  assert.equal((await loadHostConversationContext(scope, f.reader, signal())).userPrompt, "task")
  assert.equal(f.lists.length, 1)
})

test("malformed and unfiltered responses fail without falling back to older intent", async () => {
  for (const response of [null, { data: [user("a", "latest"), user("b", "older")], cursor: {} },
    { data: [], cursor: null }, { data: [], cursor: [] }, { data: [{}], cursor: {} },
    { data: [{ id: "latest", type: "user" }], cursor: {} }]) {
    const f = fixture([session()], [response as SessionMessagesResponse])
    f.reader.message.list = async input => { f.lists.push(input); return response as SessionMessagesResponse }
    await assert.rejects(loadHostConversationContext(scope, f.reader, signal()), /history response|message invalid/)
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
