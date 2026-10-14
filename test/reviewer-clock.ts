import type { TestContext } from "node:test"
import timers from "node:timers/promises"

/** Control production timers and monotonic budget together, without replacing waits. */
export function reviewerClock(t: TestContext) {
  let now = 0
  t.mock.method(performance, "now", () => now)
  t.mock.method(Math, "random", () => 0)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 8, 12) })
  const sleep = t.mock.method(timers, "setTimeout")
  return {
    sleep,
    advance(ms: number) { now += ms; t.mock.timers.tick(ms) },
    pause(ms: number) { now += ms }, // Spend monotonic budget without delivering timers.
  }
}
