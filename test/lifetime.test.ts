import { test } from "node:test"
import assert from "node:assert/strict"
import { add, empty, validate, lifetimeCost, lifetimeReport } from "../src/lifetime.js"

test("pure aggregate helpers retain weighted means and exact compact presentation", () => {
  let totals = empty()
  for (const [safe, full, rating] of [[true, 1000, 200], [false, 3000, 600], [true, 2000, 400], [false, 10000, 1000]] as const) {
    totals = add(totals, { ...empty(), safe: safe ? 1 : 0, unsafe: safe ? 0 : 1, ratingsSince: 1,
      activity: { ...empty().activity, reviews: 1, timedReviews: 1, meanFullReportMs: full, meanRatingMs: rating, since: 1 } })
  }
  totals = add(totals, { ...empty(), requests: 2, tokenRequests: 1, input: 100, output: 20, priced: 2, cost: 0.15, since: 2,
    activity: { ...empty().activity, usageRequests: 2, retries: 2, autoApproved: 1, since: 2 } })
  assert.equal(totals.activity.timedReviews, 4)
  assert.equal(lifetimeReport(totals), [
    "Reviews: 4", "Retries: 2", "Tokens: 100 in 20 out (partial coverage)", "Cost: $0.1500", "",
    "Safe: 2 (50.0%)", "Unsafe: 2 (50.0%)", "Auto-approved: 1 (25.0%)", "",
    "Average time to full report: 4.00s", "Average time to rating: 0.55s",
  ].join("\n"))
  assert.equal(totals.since, 2); assert.equal(totals.ratingsSince, 1)
})

test("empty, unpriced, zero cost and independent coverage keep their exact meanings", () => {
  assert.equal(lifetimeCost(empty()), "lifetime: no recorded usage")
  assert.equal(lifetimeReport(empty()), ["Reviews: 0", "Retries: 0", "Tokens: unavailable", "Cost: unavailable", "",
    "Safe: 0 (n/a)", "Unsafe: 0 (n/a)", "Auto-approved: 0 (n/a)", "",
    "Average time to full report: unavailable", "Average time to rating: unavailable"].join("\n"))
  const unpriced = { ...empty(), requests: 1, tokenRequests: 1, input: 10, output: 2, since: 1 }
  assert.equal(lifetimeCost(unpriced), "lifetime: cost unavailable")
  const zero = { ...empty(), requests: 1, priced: 1, since: 1 }
  assert.equal(lifetimeCost(zero), "lifetime: $0.0000")
  assert.match(lifetimeReport(zero), /Tokens: unavailable/)
  const mixed = add(unpriced, zero)
  assert.equal(lifetimeCost(mixed), "lifetime: $0.0000 (partial pricing)")
  assert.match(lifetimeReport(mixed), /Tokens: 10 in 2 out \(partial coverage\)/)
})

test("invalid aggregate components and overflow fail explicitly", () => {
  const original = { ...empty(), safe: 1, ratingsSince: 1,
    activity: { ...empty().activity, reviews: 1, timedReviews: 1, meanFullReportMs: 1000, meanRatingMs: 100, since: 1 } }
  for (const change of [{ safe: -1 }, { unsafe: 0.5 }, { ratingsSince: null }, { ratingsSince: 9e15 },
    { safe: Number.MAX_SAFE_INTEGER, unsafe: 1 }, { requests: 1 }, { cost: Infinity }, { input: 1 }]) {
    assert.throws(() => validate({ ...original, ...change }))
  }
  for (const change of [{ retries: -1 }, { autoApproved: 0.5 }, { timedReviews: 2 }, { meanRatingMs: 1001 },
    { meanFullReportMs: Infinity }, { since: null }, { timedReviews: 0 }, { usageRequests: 1 }]) {
    assert.throws(() => validate({ ...original, activity: { ...original.activity, ...change } }))
  }
  assert.throws(() => add({ ...original, safe: Number.MAX_SAFE_INTEGER }, original))
  assert.equal(validate(original), original)
})

test("statistics abbreviate token counts without rounding up or changing recorded totals", () => {
  for (const [input, output, expected] of [
    [544897, 111913, "544k in 111k out"],
    [2300, 999, "2.3k in 999 out"],
    [1000, 0, "1k in 0 out"],
    [999999, 1000000, "999k in 1M out"],
    [2300000, 12999, "2.3M in 12.9k out"],
    [2300000000, 2300000000000, "2.3B in 2.3T out"],
    [Number.MAX_SAFE_INTEGER, 1000000000000000, "9Q in 1Q out"],
  ] as const) {
    const totals = { ...empty(), requests: 1, tokenRequests: 1, input, output, since: 1 }
    assert.ok(lifetimeReport(totals).split("\n").includes(`Tokens: ${expected}`))
    assert.equal(totals.input, input); assert.equal(totals.output, output)
  }
})
