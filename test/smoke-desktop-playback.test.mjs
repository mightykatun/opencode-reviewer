import assert from "node:assert/strict"
import { test } from "node:test"
import { desktopPlaybackCase } from "../scripts/smoke-desktop-playback.mjs"

test("a failed first player followed by successful fallback is one successful logical case", async () => {
  const playback = desktopPlaybackCase("approved")
  const waiting = playback.wait()
  playback.observe("paplay", Promise.resolve({ code: 1 }), Promise.resolve())
  // A later fallback must belong to the same case, not be mistaken for the next sound.
  await Promise.resolve()
  playback.observe("pw-play", Promise.resolve({ code: 0 }), Promise.resolve())
  const result = await waiting
  assert.equal(result.kind, "approved")
  assert.equal(result.success, true)
  assert.deepEqual(result.attempts, [
    { player: "paplay", code: 1, measured: true }, { player: "pw-play", code: 0, measured: true },
  ])
})

test("all-player failure and a canceled or unstarted player never count as successful playback", async () => {
  for (const codes of [[1, 2], [null, null]]) {
    const playback = desktopPlaybackCase("attention")
    playback.observe("paplay", Promise.resolve({ code: codes[0] }), Promise.resolve())
    playback.observe("pw-play", Promise.resolve({ code: codes[1] }), Promise.resolve())
    await assert.rejects(playback.wait(), /Desktop playback failed:.*paplay.*pw-play/)
    assert.equal(playback.report().success, false)
  }
  const playback = desktopPlaybackCase("ended")
  playback.observe("paplay", undefined, Promise.resolve())
  await assert.rejects(playback.complete(), /Desktop playback failed/)
  const missing = desktopPlaybackCase("error")
  await assert.rejects(missing.complete(), /Desktop playback failed/)
  await assert.rejects(missing.wait(1), /Desktop playback timed out/)
})

test("case completion owns normalization measurement through settlement, including failure", async () => {
  const playback = desktopPlaybackCase("question")
  let rejectMeasurement
  const measurement = new Promise((_, reject) => { rejectMeasurement = reject })
  playback.observe("paplay", Promise.resolve({ code: 0 }), measurement)
  let complete = false
  const waiting = playback.complete().finally(() => { complete = true })
  await Promise.resolve()
  assert.equal(complete, false)
  rejectMeasurement(new Error("invalid normalized samples"))
  await assert.rejects(waiting, /Desktop playback failed:.*invalid normalized samples/)
  assert.equal(playback.report().success, false)
})

test("successful fallback cannot conceal a failed or stalled earlier measurement", async () => {
  const playback = desktopPlaybackCase("unsafe")
  let finishMeasurement
  playback.observe("paplay", Promise.resolve({ code: 1 }), new Promise(resolve => { finishMeasurement = resolve }))
  playback.observe("pw-play", Promise.resolve({ code: 0 }), Promise.resolve())
  await assert.rejects(playback.wait(1), /Desktop playback timed out/)
  finishMeasurement()
  assert.equal((await playback.complete()).success, true)

  const invalid = desktopPlaybackCase("unsafe")
  invalid.observe("paplay", Promise.resolve({ code: 1 }), Promise.reject(new Error("invalid samples")))
  invalid.observe("pw-play", Promise.resolve({ code: 0 }), Promise.resolve())
  await assert.rejects(invalid.complete(), /Desktop playback failed:.*invalid samples/)
})
