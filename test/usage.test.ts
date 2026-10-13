import { test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { responseUsage, sumUsage, usageAttempt, usageText, type Pricing, type Usage } from "../src/usage.js"

const prices: Pricing = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
const response = (input = 1000, output = 100) => ({ model: "fixture", usage: { prompt_tokens: input, completion_tokens: output } })
const openRouter = "https://openrouter.ai/api/v1"

test("usage requires both actual endpoint counts; malformed or missing usage is never replaced with zeros", () => {
  for (const usage of [undefined, null, [], {}, { prompt_tokens: 1 }, { completion_tokens: 1 }, { prompt_tokens: "10", completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: 1, completion_tokens: Infinity }]) {
    assert.equal(responseUsage({ usage }, "fixture"), undefined)
  }
  assert.deepEqual(responseUsage(response(0, 0), "fixture"), { input: 0, output: 0 })
  assert.equal(usageText(responseUsage(response(), "fixture")!), "token: 1000 in 100 out")
})

test("cost uses per-million input/output, cached reads/writes and returns four decimal places", () => {
  const plain = responseUsage(response(), "fixture", () => prices)!
  assert.equal(plain.cost, 0.0045)
  assert.equal(usageText(plain), "token: 1000 in 100 out\ncost: $0.0045")
  const cached = responseUsage({ usage: { ...response().usage, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 } } }, "fixture", () => prices)!
  assert.ok(Math.abs(cached.cost! - 0.002955) < 1e-10)
  const free = responseUsage(response(), "fixture", () => ({ input: 0, output: 0, cache: { read: 0, write: 0 } }))!
  assert.equal(usageText(free), "token: 1000 in 100 out\ncost: $0.0000")
})

test("context-tier prices include cached input; exact thresholds use the preceding tier", () => {
  const expensive = { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } }
  const tiered = { ...prices, tiers: [{ ...expensive, tier: { type: "context" as const, size: 200000 } }] }
  assert.equal(responseUsage(response(200000, 0), "fixture", () => tiered)?.cost, 0.6)
  assert.equal(responseUsage(response(200001, 0), "fixture", () => tiered)?.cost, 1.200006)
  const cached = { usage: { prompt_tokens: 200001, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 200000 } } }
  assert.equal(responseUsage(cached, "fixture", () => tiered)?.cost, 0.120006)
})

test("unknown or malformed pricing/cache metadata retains token counts without an invented cost", () => {
  for (const details of [{ cached_tokens: 1001 }, { cached_tokens: -1 }, { cached_tokens: "100" }, { cached_tokens: 900, cache_write_tokens: 200 }]) {
    assert.deepEqual(responseUsage({ usage: { ...response().usage, prompt_tokens_details: details } }, "fixture", () => prices), { input: 1000, output: 100 })
  }
  for (const cost of [{ ...prices, input: -1 }, { ...prices, output: NaN }, { ...prices, output: Number.MAX_VALUE }]) {
    assert.deepEqual(responseUsage(response(), "fixture", () => cost), { input: 1000, output: 100 })
  }
  let lookedUp = ""
  responseUsage(response(), "alias", (model) => { lookedUp = model; return undefined })
  assert.equal(lookedUp, "fixture")
})

test("malformed cache containers discard estimates from the latest cumulative snapshot", () => {
  for (const details of [null, [], [0], false, 0, 1, "", "unavailable"]) {
    const observed: Usage[] = []
    const attempt = usageAttempt("https://generic.test/v1", "fixture", () => prices, (usage) => observed.push(usage))
    attempt.observe(response())
    assert.equal(attempt.current()?.cost, 0.0045)
    attempt.observe({ usage: { ...response().usage, prompt_tokens_details: details } })
    assert.deepEqual(attempt.finalize(), { input: 1000, output: 100 })
    assert.deepEqual(observed, [{ input: 1000, output: 100 }])
  }
  for (const details of [undefined, {}]) {
    assert.equal(responseUsage({ usage: { ...response().usage, prompt_tokens_details: details } }, "fixture", () => prices)?.cost, 0.0045)
  }
})

test("rejected asynchronous usage observers are consumed without delaying finalization", async () => {
  let calls = 0
  const attempt = usageAttempt(openRouter, "fixture", undefined, async () => {
    calls++
    await sleep(0)
    throw new Error("observer storage failure")
  })
  attempt.observe({ usage: { cost: 0.01 } })
  assert.deepEqual(attempt.finalize(), { cost: 0.01 })
  assert.deepEqual(attempt.finalize(), { cost: 0.01 })
  await sleep(10) // node:test fails this test if the observer rejection is unhandled.
  assert.equal(calls, 1)
})

test("correction totals include every request and never silently undercount partial data", () => {
  assert.deepEqual(sumUsage({ input: 10, output: 5, cost: 0.01 }, { input: 20, output: 10, cost: 0.02 }), { input: 30, output: 15, cost: 0.03 })
  assert.deepEqual(sumUsage({ input: 10, output: 5, cost: 0.01 }, { input: 20, output: 10 }), { input: 30, output: 15 })
  assert.equal(sumUsage(undefined, { input: 10, output: 5 }), undefined)
  assert.equal(sumUsage({ input: 10, output: 5 }, undefined), undefined)
  assert.equal(sumUsage({ input: Number.MAX_SAFE_INTEGER, output: 0 }, { input: 1, output: 0 }), undefined)
})

test("exact normalized OpenRouter uses reported cost independently of tokens and never consults catalog pricing", () => {
  const pricing = () => { assert.fail("OpenRouter must not use catalog pricing") }
  for (const baseURL of [openRouter, `${openRouter}///`, "https://OPENROUTER.ai:443/api/v1/"]) {
    for (const cost of [0, 0.0123]) {
      for (const tokens of [{}, { prompt_tokens: 10 }, { prompt_tokens: "10", completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 }]) {
        assert.deepEqual(responseUsage({ usage: { ...tokens, cost, cost_details: { upstream_inference_cost: 99 } } }, "fixture", pricing, baseURL), { cost })
      }
      assert.deepEqual(responseUsage({ usage: { ...response().usage, cost } }, "fixture", pricing, baseURL), { input: 1000, output: 100, cost })
    }
    for (const cost of [undefined, null, "0.01", -1, Infinity, NaN, {}, []]) {
      assert.equal(responseUsage({ usage: { cost, cost_details: { upstream_inference_cost: 0.01 } } }, "fixture", pricing, baseURL), undefined)
      assert.deepEqual(responseUsage({ usage: { ...response().usage, cost } }, "fixture", pricing, baseURL), { input: 1000, output: 100 })
    }
  }
  assert.equal(usageText({ cost: 0 }), "cost: $0.0000")
  assert.equal(usageText({ cost: 0.0123 }), "cost: $0.0123")
})

test("other endpoints ignore reported cost and retain catalog estimation, including lookalike OpenRouter URLs", () => {
  for (const baseURL of [undefined, "https://proxy.test/api/v1", "http://openrouter.ai/api/v1", "https://openrouter.ai/api/v2",
    "https://openrouter.ai.evil.test/api/v1", "https://openrouter.ai:444/api/v1", `${openRouter}?x=1`, `${openRouter}#fragment`]) {
    const envelope = { usage: { ...response().usage, cost: 99 } }
    assert.deepEqual(responseUsage(envelope, "fixture", () => prices, baseURL), { input: 1000, output: 100, cost: 0.0045 })
    assert.deepEqual(responseUsage(envelope, "fixture", undefined, baseURL), { input: 1000, output: 100 })
    assert.equal(responseUsage({ usage: { cost: 99 } }, "fixture", () => prices, baseURL), undefined)
  }
  assert.deepEqual(responseUsage(response(), "fixture", () => { throw new Error("catalog unavailable") }), { input: 1000, output: 100 })
})

test("attempts replace cumulative components independently, finalize once and isolate observer mutations", () => {
  const observed: Usage[] = []
  const attempt = usageAttempt(openRouter, "fixture", undefined, (usage) => {
    observed.push({ ...usage })
    usage.cost = 999
    throw new Error("storage failure")
  })
  attempt.observe({ usage: { prompt_tokens: 10, completion_tokens: 2 } })
  attempt.observe({ usage: { cost: 0.02 } })
  attempt.observe({ usage: { cost: 0.02 } })
  attempt.observe({ usage: { prompt_tokens: 30, completion_tokens: 5 } })
  attempt.observe({ usage: { cost: 0.01 } }) // Latest valid values can revise cost downward.
  attempt.observe({ usage: { prompt_tokens: 20, completion_tokens: 4, cost: -1 } })
  attempt.observe({ usage: { prompt_tokens: "invalid", completion_tokens: 99, cost: null } })
  attempt.observe({ choices: [] })
  assert.deepEqual(observed, [])
  assert.deepEqual(attempt.current(), { input: 20, output: 4, cost: 0.01 })
  attempt.current()!.input = 999
  assert.deepEqual(attempt.finalize(), { input: 20, output: 4, cost: 0.01 })
  attempt.observe({ usage: { cost: 100 } })
  assert.deepEqual(attempt.finalize(), { input: 20, output: 4, cost: 0.01 })
  assert.deepEqual(observed, [{ input: 20, output: 4, cost: 0.01 }])
})

test("attempt finalization retains received cost on cancellation/failure, but never invents usage", () => {
  for (const failure of [new Error("stream disconnected"), AbortSignal.abort().reason]) {
    const observed: Usage[] = []
    const attempt = usageAttempt(openRouter, "fixture", undefined, (usage) => observed.push(usage))
    assert.throws(() => {
      try {
        attempt.observe({ usage: { cost: 0 } })
        throw failure
      } finally { attempt.finalize() }
    }, (error) => error === failure)
    assert.deepEqual([...observed], [{ cost: 0 }])
    const empty = usageAttempt(openRouter, "fixture", undefined, (usage) => observed.push(usage))
    empty.observe({ usage: { cost: "bad", prompt_tokens: 10 } })
    assert.equal(empty.finalize(), undefined)
    assert.equal(observed.length, 1)
  }
})

test("report completeness and overflow are independent for tokens and cost across correction attempts", () => {
  assert.deepEqual(sumUsage({ cost: 0.01 }, { cost: 0.02, input: 10, output: 2 }), { cost: 0.03 })
  assert.deepEqual(sumUsage({ input: 10, output: 2 }, { input: 20, output: 3, cost: 0.01 }), { input: 30, output: 5 })
  assert.equal(sumUsage({ cost: 0.01 }, { input: 10, output: 2 }), undefined)
  assert.equal(sumUsage({ cost: 0.01 }, undefined), undefined)
  assert.equal(sumUsage(undefined, { cost: 0.01 }), undefined)
  assert.deepEqual(sumUsage({ input: Number.MAX_SAFE_INTEGER, output: 0, cost: 0 }, { input: 1, output: 0, cost: 0.01 }), { cost: 0.01 })
  assert.deepEqual(sumUsage({ input: 1, output: 2, cost: Number.MAX_VALUE }, { input: 2, output: 3, cost: Number.MAX_VALUE }), { input: 3, output: 5 })
})

test("generic attempts invalidate stale derived cost for newer unpriceable token snapshots, even unchanged counts", () => {
  for (const output of [1, 100]) for (const reason of ["cache", "missing pricing", "catalog failure"]) {
    const observed: Usage[] = []
    let unavailable = false
    const attempt = usageAttempt("https://generic.test/v1", "fixture", () => {
      if (unavailable && reason === "missing pricing") return undefined
      if (unavailable && reason === "catalog failure") throw new Error("catalog unavailable")
      return { input: 1, output: 2, cache: { read: 0, write: 0 } }
    }, (usage) => observed.push(usage))
    attempt.observe(response(100, 1))
    const priced = { input: 100, output: 1, cost: 0.000102 }
    assert.deepEqual(attempt.current(), priced)
    attempt.observe({ usage: { prompt_tokens: 100, completion_tokens: "invalid" } })
    assert.deepEqual(attempt.current(), priced, "invalid token pairs do not replace a valid snapshot")
    unavailable = true
    attempt.observe({ usage: { prompt_tokens: 100, completion_tokens: output,
      ...(reason === "cache" ? { prompt_tokens_details: { cached_tokens: 101 } } : {}) } })
    const expected = { input: 100, output }
    assert.deepEqual(attempt.current(), expected, reason)
    attempt.observe({ choices: [] })
    attempt.observe({ usage: { cost: 99 } })
    assert.deepEqual(attempt.finalize(), expected)
    assert.deepEqual(attempt.finalize(), expected)
    assert.deepEqual(observed, [expected])
  }
})

test("generic derived cost can recover from a later priceable snapshot, including a zero estimate", () => {
  const attempt = usageAttempt("https://generic.test/v1", "fixture", () => ({ input: 1, output: 2, cache: { read: 0, write: 0 } }))
  attempt.observe(response(100, 1))
  attempt.observe({ usage: { prompt_tokens: 100, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 101 } } })
  assert.deepEqual(attempt.current(), { input: 100, output: 100 })
  attempt.observe({ usage: { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 100 } } })
  assert.deepEqual(attempt.finalize(), { input: 100, output: 0, cost: 0 })
})

test("OpenRouter reported cost survives newer token snapshots with invalid cache metadata and absent cost", () => {
  for (const cost of [0, 0.000102]) {
    const observed: Usage[] = []
    const attempt = usageAttempt(`${openRouter}/`, "fixture", () => { assert.fail("reported cost must not use catalog pricing") },
      (usage) => observed.push(usage))
    attempt.observe({ usage: { prompt_tokens: 100, completion_tokens: 1, cost } })
    attempt.observe({ usage: { prompt_tokens: 100, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 101 } } })
    const expected = { input: 100, output: 100, cost }
    assert.deepEqual(attempt.current(), expected)
    assert.deepEqual(attempt.finalize(), expected)
    assert.deepEqual(observed, [expected])
  }
})
