import { test } from "node:test"
import assert from "node:assert/strict"
import { DeadlineError, remainingTime, reviewStage, withDeadline } from "../src/deadline.js"

const signal = () => new AbortController().signal

test("a separate abort owner inherits the original absolute deadline across a handoff pause", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0, handing = false, reads = 0, launched = false
  t.mock.method(performance, "now", () => {
    if (handing && ++reads === 2) now = 100
    return now
  })
  await assert.rejects(withDeadline(signal(), 20, async source => {
    handing = true
    const remaining = remainingTime(source)
    await assert.rejects(withDeadline(signal(), remaining, async () => { launched = true }, "Acknowledgement", source), DeadlineError)
  }), DeadlineError)
  assert.equal(launched, false, "A new abort owner cannot reconstruct a later deadline after a scheduling pause")
})

test("nested construction inherits the absolute parent end across a clock pause", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let constructing = false, reads = 0, now = 0, launched = false
  t.mock.method(performance, "now", () => {
    if (constructing && ++reads >= 2) now = 100
    return now
  })
  await assert.rejects(withDeadline(signal(), 20, async parent => {
    constructing = true
    await assert.rejects(withDeadline(parent, 20, async () => { launched = true }), DeadlineError)
  }), DeadlineError)
  assert.equal(launched, false, "a delayed parent timer must not admit child work beyond its absolute end")
})

test("nested local budgets shorten but never extend any ancestor deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0
  t.mock.method(performance, "now", () => now)
  await withDeadline(signal(), 100, async parent => {
    now = 30
    await withDeadline(parent, 100, async inherited => {
      assert.equal(remainingTime(inherited), 70)
      now = 40
      await withDeadline(inherited, 10, async shortened => {
        assert.equal(remainingTime(shortened), 10)
        now = 45
        await withDeadline(shortened, 100, async grandchild => {
          assert.equal(remainingTime(grandchild), 5)
        })
      })
      assert.equal(remainingTime(inherited), 55)
    })
    assert.equal(remainingTime(parent), 55)
  })
})

test("zero, negative and elapsed parent budgets never invoke work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0, launched = 0
  t.mock.method(performance, "now", () => now)
  const run = async () => { launched++ }
  for (const ms of [0, -1]) await assert.rejects(withDeadline(signal(), ms, run), DeadlineError)
  for (const elapsed of [20, 100]) {
    now = 0
    await assert.rejects(withDeadline(signal(), 20, async parent => {
      now = elapsed // The parent timer has not been delivered.
      assert.equal(parent.aborted, false)
      assert.equal(remainingTime(parent), 0)
      await assert.rejects(withDeadline(parent, 100, run), DeadlineError)
    }), DeadlineError)
  }
  assert.equal(launched, 0)
})

test("deadline checks reject late results even before timer delivery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0
  t.mock.method(performance, "now", () => now)
  await assert.rejects(withDeadline(signal(), 20, async bounded => {
    reviewStage(bounded, "File read")
    now = 20
    return "late result"
  }), { name: "DeadlineError", message: "File read timed out" })
})

test("nested cancellation preserves the parent reason and does not settle physical work", async () => {
  const parent = new AbortController(), reason = new Error("canceled")
  let enter!: () => void, release!: () => void, child!: AbortSignal, settled = false
  const entered = new Promise<void>(resolve => { enter = resolve })
  const physical = new Promise<void>(resolve => { release = resolve }).then(() => { settled = true })
  const pending = withDeadline(parent.signal, 10000, outer => withDeadline(outer, 10000, bounded => {
    child = bounded
    enter()
    return physical
  }))
  const rejected = assert.rejects(pending, error => error === reason)
  await entered
  parent.abort(reason)
  await rejected
  assert.equal(child.aborted, true)
  assert.equal(child.reason, reason)
  assert.equal(settled, false)
  release()
  await physical
  assert.equal(settled, true)
  let launched = false
  await assert.rejects(withDeadline(parent.signal, 100, async () => { launched = true }), error => error === reason)
  assert.equal(launched, false)
})

test("local timer expiry aborts the child at its own budget and leaves the parent live", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let now = 0
  t.mock.method(performance, "now", () => now)
  await withDeadline(signal(), 100, async parent => {
    let enter!: () => void, child!: AbortSignal
    const entered = new Promise<void>(resolve => { enter = resolve })
    const pending = withDeadline(parent, 10, async bounded => {
      child = bounded
      reviewStage(bounded, "Local read")
      enter()
      return new Promise(() => {})
    })
    const rejected = assert.rejects(pending, { name: "DeadlineError", message: "Local read timed out" })
    await entered
    now = 9; t.mock.timers.tick(9)
    assert.equal(child.aborted, false)
    now = 10; t.mock.timers.tick(1)
    await rejected
    assert.equal(child.aborted, true)
    assert.equal(parent.aborted, false)
    assert.equal(remainingTime(parent), 90)
  })
})
