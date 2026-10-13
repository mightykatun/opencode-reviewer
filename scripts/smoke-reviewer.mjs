import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"

const kinds = ["shell", "edit", "skill", "external-directory"]
const bytes = (text) => Buffer.byteLength(text, "utf8")
const count = (value) => Number.isSafeInteger(value) && value >= 0

/** Keep comparison data in memory only. Reports contain ordinals, sizes and numeric usage. */
export function reviewerAudit({ stream = false, maxOutputTokens = 4096 } = {}) {
  const permissions = new Map(), systems = new Map(), rows = []
  let verified = false
  return {
    request(method, text) {
      assert.equal(method, "POST", "reviewer traffic must consist only of attempt POSTs")
      const body = JSON.parse(text), messages = body.messages
      assert.ok(text === JSON.stringify(body), "request envelope must already be compact JSON")
      assert.equal(body.stream, stream)
      assert.equal(body.max_tokens, maxOutputTokens)
      assert.deepEqual(Object.keys(body).sort(), ["model", "messages", "max_tokens", "stream", ...(stream ? ["stream_options"] : [])].sort())
      if (stream) assert.deepEqual(body.stream_options, { include_usage: true })
      assert.ok(Array.isArray(messages) && messages.length >= 2)
      assert.ok(messages[0].role === "system" && typeof messages[0].content === "string" && messages[0].content.length > 0)
      assert.ok(messages[1].role === "user" && typeof messages[1].content === "string")
      const evidence = JSON.parse(messages[1].content)
      assert.ok(messages[1].content === JSON.stringify(evidence), "evidence must already be compact JSON")
      assert.ok(kinds.includes(evidence.kind) && typeof evidence.permission?.id === "string")
      const system = systems.get(evidence.kind)
      if (system) assert.ok(system.text === messages[0].content, "system prefix must be byte-identical for a review category")
      else systems.set(evidence.kind, { id: systems.size + 1, text: messages[0].content })
      let permission = permissions.get(evidence.permission.id)
      if (!permission) {
        assert.equal(messages.length, 2, "first attempt contains exactly system and original evidence")
        permission = { id: permissions.size + 1, kind: evidence.kind, attempts: 0 }
        permissions.set(evidence.permission.id, permission)
      } else if (permission.transportRetryExpected) {
        assert.ok(text === permission.request, "transport retry preserves the entire POST byte-for-byte")
      } else {
        assert.ok(permission.retryExpected, "unexpected duplicate/speculative POST without an invalid fixture assessment")
        assert.ok(evidence.kind === permission.kind)
        assert.ok(body.model === permission.model, "corrections retain the configured model")
        assert.equal(messages.length, permission.messageCount + 2, "one correction adds exactly two messages")
        assert.ok(JSON.stringify(messages.slice(0, -2)) === permission.history, "correction preserves the entire prior history and original evidence byte-for-byte")
        assert.ok(messages.at(-2).role === "assistant" && messages.at(-2).content === permission.response,
          "correction carries the exact failed assessment")
        assert.ok(messages.at(-1).role === "user" && /Format validation failed/.test(messages.at(-1).content))
      }
      permission.attempts++
      permission.retryExpected = false
      permission.transportRetryExpected = false
      permission.request = text
      permission.model = body.model
      permission.history = JSON.stringify(messages)
      permission.messageCount = messages.length
      const row = { permission: permission.id, kind: permission.kind, attempt: permission.attempts,
        systemGroup: systems.get(evidence.kind).id, messageCount: messages.length, requestBytes: bytes(text),
        systemBytes: bytes(messages[0].content), evidenceBytes: bytes(messages[1].content),
        evidenceStringWireBytes: bytes(JSON.stringify(messages[1].content)),
        correctionMessagesBytes: messages.length === 2 ? 0 : bytes(JSON.stringify(messages.slice(2))),
        compactEnvelope: true, compactEvidence: true, stableSystem: true, preservedHistory: true,
        fixtureUsageFrames: 0 }
      rows.push(row)
      return {
        usage(usage) {
          if (!usage) return
          row.fixtureUsageFrames++
          const numeric = {}
          for (const [key, value] of Object.entries({ input: usage.prompt_tokens, output: usage.completion_tokens,
            cacheRead: usage.prompt_tokens_details?.cached_tokens, cacheWrite: usage.prompt_tokens_details?.cache_write_tokens })) {
            if (count(value)) numeric[key] = value
          }
          if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) numeric.reportedCost = usage.cost
          // Cumulative frames replace the prior snapshot; they are not extra attempts.
          row.fixtureUsage = numeric
        },
        response(content, retryExpected = false) { permission.response = content; permission.retryExpected = retryExpected },
        transportRetry() { permission.transportRetryExpected = true },
      }
    },
    verify(expectedKinds, attemptsPerPermission) {
      assert.deepEqual([...permissions.values()].map((item) => item.kind), expectedKinds, "exact permission review order/count")
      for (const permission of permissions.values()) assert.equal(permission.attempts, attemptsPerPermission, "exactly one POST per planned attempt")
      assert.equal(rows.length, expectedKinds.length * attemptsPerPermission)
      verified = true
    },
    snapshot() {
      return { verified, usageScope: "fixture-supplied cumulative usage, not client accounting or live-provider cache measurements",
        permissions: permissions.size, posts: rows.length, systemGroups: systems.size, attempts: structuredClone(rows) }
    },
  }
}

/** Require a genuinely new reviewer-only origin, then a second request on that connection. */
export function assertReviewerReuse(measurement) {
  const reviews = measurement.requests.filter((item) => item.role === "reviewer")
  assert.equal(reviews.length, 2)
  assert.ok(reviews.every((item) => item.origin === "reviewer"))
  assert.equal(reviews[0].socketRequest, 1, "first reviewer POST must be first on its connection")
  assert.equal(reviews[0].reusedRoleSocket, false)
  assert.equal(reviews[1].socket, reviews[0].socket, "warm reviewer request reuses the first TCP connection")
  assert.equal(reviews[1].socketRequest, 2)
  assert.equal(reviews[1].reusedRoleSocket, true)
  assert.ok(reviews[1].receivedAtMs >= reviews[0].finishedAtMs)
  assert.ok(measurement.requests.filter((item) => item.role !== "reviewer").every((item) => item.socket !== reviews[0].socket))
  assert.equal(measurement.connections.filter((item) => item.origin === "reviewer").length, 1, "no reviewer warm-up connections")
}

/** Deterministic SSE pacing tests protocol compatibility, not provider performance. */
export async function sendReviewStream(res, { content, usage, observation, beforeTerminal = async () => {}, phase = () => {} }) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
  res.flushHeaders()
  res.write(": fixture keepalive\r\n\r\n")
  const frame = async (value) => {
    const json = JSON.stringify(value)
    // Exercise multiline data at a JSON member boundary, never inside a string.
    const payload = Buffer.from(`data: ${json.replace(',"choices":', ',\r\ndata: "choices":')}\r\n\r\n`)
    const multibyte = payload.findIndex((byte) => byte >= 0xc0)
    const cut = multibyte >= 0 ? multibyte + 1 : Math.floor(payload.length / 2)
    for (const part of [payload.subarray(0, 1), payload.subarray(1, cut), payload.subarray(cut)]) {
      assert.ok(!res.destroyed, "review stream must remain connected")
      res.write(part)
      await sleep(2)
    }
  }
  const chunk = (delta, finish_reason = null) => ({ id: "review-fixture", object: "chat.completion.chunk", created: 1, model: "review",
    choices: [{ index: 0, delta, finish_reason }] })
  await frame(chunk({ role: "assistant", content: "" }))
  // Split boolean tokens, JSON strings/escapes and prose across successive deltas.
  for (let offset = 0; offset < content.length; offset += 11) {
    await frame(chunk({ content: content.slice(offset, offset + 11) }))
    if (offset === 0) phase("sse-first-content-written")
    await sleep(15)
  }
  await frame(chunk({}, "stop"))
  await frame(chunk({}, "stop"))
  if (usage) {
    for (let i = 0; i < 2; i++) {
      await frame({ id: "review-fixture", model: "review", choices: [], usage })
      observation.usage(usage)
    }
  }
  phase("sse-stop-and-usage-written")
  await sleep(100) // Full JSON/stop/usage still cannot authorize without DONE and EOF.
  await beforeTerminal()
  assert.ok(!res.destroyed, "review stream must remain connected until terminal completion")
  res.end("data: [DONE]\r\n\r\n")
  phase("sse-terminal-written")
}
