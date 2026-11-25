import assert from "node:assert/strict"

const kinds = ["attention", "unsafe", "question", "approved", "error", "ended"]
const prefix = "const __REVIEWER_BUNDLED_SOUNDS__ = "

// This is the production value referenced by esbuild's __REVIEW_SOUNDS__ definition,
// not a second informational copy. A JSON-only banner survives bundling verbatim.
export const soundBanner = sounds => `${prefix}${JSON.stringify(sounds)};`

export const assertNoBundledSounds = bundle => assert.doesNotMatch(bundle, /__REVIEWER_BUNDLED_SOUNDS__/)

/** Inspect package bytes as data. Never import/evaluate the bundle to inspect its assets. */
export function verifyBundledSounds(bundle, expected) {
  assert.ok(bundle.startsWith(prefix), "Missing production sound mapping")
  const lines = bundle.split("\n").filter(line => line.startsWith(prefix))
  assert.equal(lines.length, 1, "Expected exactly one production sound mapping")
  assert.ok(lines[0].endsWith(";"), "Invalid production sound declaration")
  const text = lines[0].slice(prefix.length, -1)
  const sounds = JSON.parse(text)
  assert.equal(JSON.stringify(sounds), text, "Sound mapping must be canonical JSON without duplicate fields")
  assert.deepEqual(Object.keys(sounds).sort(), [...kinds].sort(), "Expected all six sound categories")
  assert.deepEqual(Object.keys(expected).sort(), [...kinds].sort(), "Expected all six original assets")
  for (const kind of kinds) {
    const sound = sounds[kind]
    assert.deepEqual(Object.keys(sound).sort(), ["data", "format"], `Invalid ${kind} sound fields`)
    assert.equal(sound.format, "mp3", `Invalid ${kind} sound format`)
    assert.equal(typeof sound.data, "string", `Missing ${kind} sound bytes`)
    const bytes = Buffer.from(sound.data, "base64")
    assert.equal(bytes.toString("base64"), sound.data, `Invalid ${kind} base64`)
    assert.ok(bytes.length > 0 && bytes.equals(expected[kind]), `Bundled ${kind} mapping differs from the supplied asset`)
  }
  return sounds
}
