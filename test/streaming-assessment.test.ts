import { test } from "node:test"
import assert from "node:assert/strict"
import { AssessmentFormatError, MAX_ASSESSMENT_BYTES, StreamingAssessment } from "../src/streaming-assessment.js"
import { parseAssessment } from "../src/reviewer.js"

test("incremental assessment matches the final contract across every character split and field order", () => {
  const inputs = [
    '{"safe":true,"reason":"Why.","desc":"Text 🍐 café\\n\\t\\b\\f\\r\\/\\\\\\\" \\uD83C\\uDF50."}',
    ' \r\n{ "d\\u0065sc" : "**Effects**\\n\\n- Writes `note`." , "re\\u0061son" : "Writes." , "saf\\u0065": false } \t',
    '{"desc":"x","reason":"y","safe":false}',
  ]
  for (const text of inputs) {
    const expected = JSON.parse(text)
    for (let split = 0; split <= text.length; split++) {
      const parser = new StreamingAssessment()
      parser.push(text.slice(0, split))
      parser.push(text.slice(split))
      assert.deepEqual(parser.finish(), expected)
      assert.equal(parser.content, text)
    }
    const parser = new StreamingAssessment()
    for (let i = 0; i < text.length; i++) {
      parser.push(text[i]!)
      const preview = parser.preview()
      if (preview?.desc !== undefined) {
        assert.ok(expected.desc.startsWith(preview.desc))
        assert.doesNotMatch(preview.desc, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "prefix must never expose an isolated surrogate")
      }
    }
    assert.deepEqual(parser.finish(), expected)
  }
})

test("boolean preview waits for a complete token boundary, including false and invalid suffixes", () => {
  for (const literal of ["true", "false"]) for (const boundary of [",", " ", "\r", "\n", "\t", "}"]) {
    const parser = new StreamingAssessment()
    parser.push('{"safe":')
    for (const char of literal) { parser.push(char); assert.equal(parser.preview()?.safe, undefined) }
    parser.push(boundary)
    assert.equal(parser.preview()?.safe, literal === "true")
  }
  for (const text of ["truex", "false0", "truE", "true:", "true\u00a0"]) {
    const parser = new StreamingAssessment()
    for (const char of '{"safe":' + text) {
      parser.push(char)
      assert.equal(parser.preview()?.safe, undefined)
    }
    assert.throws(() => parser.finish(), AssessmentFormatError)
  }
})

test("unfinished escapes and surrogate pairs are held until a complete decoded character exists", () => {
  const parser = new StreamingAssessment()
  parser.push('{"safe":true,"reason":"Why.","desc":"a\\')
  assert.deepEqual(parser.preview(), { safe: true, reason: "Why.", reasonComplete: true, desc: "a" })
  for (const char of "uD83C") { parser.push(char); assert.equal(parser.preview()?.desc, "a") }
  for (const char of "\\uDF5") { parser.push(char); assert.equal(parser.preview()?.desc, "a") }
  parser.push("0")
  assert.equal(parser.preview()?.desc, "a🍐")
  parser.push('"}')
  assert.deepEqual(parser.finish(), { safe: true, reason: "Why.", desc: "a🍐" })
  const copy = parser.preview()!
  copy.safe = false
  assert.equal(parser.finish().safe, true)
})

test("duplicate fields including escaped spellings are rejected by both full and incremental paths", () => {
  for (const text of [
    '{"safe":true,"safe":false,"reason":"r","desc":"x"}',
    '{"safe":true,"s\\u0061fe":true,"reason":"r","desc":"x"}',
    '{"desc":"a","safe":true,"reason":"r","d\\u0065sc":"b"}',
    '{"\\u0073afe":true,"reason":"r","desc":"x","safe":true}',
    '{"safe":true,"reason":"r","reason":"s","desc":"x"}',
  ]) {
    for (let split = 0; split <= text.length; split++) {
      const parser = new StreamingAssessment()
      parser.push(text.slice(0, split))
      parser.push(text.slice(split))
      assert.equal(parser.preview(), undefined)
      assert.throws(() => parser.finish(), /Duplicate assessment field/)
    }
    assert.throws(() => parseAssessment(text), /Duplicate assessment field/)
  }
})

test("invalid JSON/schema and unpaired surrogates fail only at final validation; valid strings preserve Markdown", () => {
  for (const text of ["", "[]", "null", "true", "{}", '{"safe":true}', '{"desc":"x"}', '{"safe":true,"desc":"x"}',
    '{"safe":true,"reason":" ","desc":"x"}', '{"safe":true,"reason":null,"desc":"x"}', '{"safe":true,"reason":1,"desc":"x"}',
    '{"safe":false,"reason":"r","steering":"s","desc":"x"}',
    '{"safe":true,"desc":" "}', '{"safe":true,"desc":null}', '{"safe":1,"desc":"x"}',
    '{"safe":true,"desc":"x",}', '{"safe":true,"desc":"x"} trailing',
    '{"safe":true,"desc":"x","other":0}', '{"safe":true,"desc":"x"}{"safe":false,"desc":"y"}',
    '{"safe":true,"desc":"\\q"}', '{"safe":true,"desc":"\\u00X0"}', '{"safe":true,"desc":"raw\nnewline"}',
    '{"safe":true,"desc":"\\uD800"}', '{"safe":true,"desc":"\\uDC00"}', '{"safe":true,"desc":"\\uD800x"}',
    '{"safe":true,"desc":"\ud800"}', '{"safe":true,"desc":"\udc00"}', '{"safe":true,"desc":"x\\',
  ]) {
    const parser = new StreamingAssessment()
    assert.doesNotThrow(() => { for (const char of text) parser.push(char) })
    assert.throws(() => parser.finish(), AssessmentFormatError, text)
    assert.throws(() => parseAssessment(text), AssessmentFormatError, text)
  }
  assert.deepEqual(parseAssessment('{"safe":true,"reason":" Why. ","desc":"  **Safe**\\n\\n`cat file`  "}'), { safe: true, reason: "Why.", desc: "**Safe**\n\n`cat file`" })
})

test("assessment byte bounds are UTF-8 accurate across literal surrogate splits and apply after syntax errors", () => {
  const prefix = '{"safe":true,"reason":"r","desc":"', suffix = '"}'
  const text = prefix + "x".repeat(MAX_ASSESSMENT_BYTES - prefix.length - suffix.length - 4) + "🍐" + suffix
  assert.equal(Buffer.byteLength(text), MAX_ASSESSMENT_BYTES)
  const parser = new StreamingAssessment()
  for (let i = 0; i < text.length; i++) parser.push(text[i]!)
  assert.equal(parser.finish().desc.endsWith("🍐"), true)
  assert.throws(() => parser.push(" "), /assessment exceeds 64 KiB/)
  const bad = new StreamingAssessment()
  bad.push("x".repeat(MAX_ASSESSMENT_BYTES))
  assert.throws(() => bad.push("x"), /assessment exceeds 64 KiB/)
})

test("Unsafe requires nonempty steering only in steering mode, Safe ignores it", () => {
  const steer = (text: string) => parseAssessment(text, true)
  assert.deepEqual(steer('{"safe":false,"reason":"r","steering":"  Please split it.  ","desc":"d"}'), { safe: false, reason: "r", steering: "Please split it.", desc: "d" })
  for (const value of ['', ',"steering":null', ',"steering":""', ',"steering":"  \\n "']) {
    assert.throws(() => steer(`{"safe":false,"reason":"r"${value},"desc":"d"}`), /require nonempty steering/)
    assert.deepEqual(steer(`{"safe":true,"reason":"r"${value},"desc":"d"}`), { safe: true, reason: "r", desc: "d" })
  }
  assert.deepEqual(parseAssessment('{"safe":false,"reason":"r","desc":"d"}'), { safe: false, reason: "r", desc: "d" })
  assert.deepEqual(steer('{"safe":true,"reason":"r","steering":"Please stop.","desc":"d"}'), { safe: true, reason: "r", desc: "d" })
  for (const value of ['1', 'true', '{}', '[]', 'nul', 'nullx'])
    assert.throws(() => steer(`{"safe":false,"reason":"r","steering":${value},"desc":"d"}`), AssessmentFormatError, value)
  assert.throws(() => steer('{"safe":false,"reason":"r","steering":"a","steering":"b","desc":"d"}'), /Duplicate assessment field/)
  assert.throws(() => steer('{"safe":true,"reason":"r","desc":"d","safe":false}'), /Duplicate assessment field/)
  assert.throws(() => steer('{"safe":true,"reason":null,"desc":"d"}'), AssessmentFormatError, "only steering accepts null")
})

test("steering previews mark reason and steering complete only after their closing tokens", () => {
  const text = '{"safe":false,"reason":"Too broad.","steering":"Please narrow it.","desc":"Long report"}'
  const seen: string[] = []
  const parser = new StreamingAssessment({ steering: true })
  for (const char of text) {
    parser.push(char)
    const preview = parser.preview()!
    if (preview.reasonComplete) assert.equal(preview.reason, "Too broad.")
    if (preview.steeringComplete) assert.equal(preview.steering, "Please narrow it.")
    if (preview.steering !== undefined && !preview.steeringComplete) assert.ok("Please narrow it.".startsWith(preview.steering))
    const state = `${preview.reasonComplete ? "R" : ""}${preview.steeringComplete ? "S" : ""}`
    if (seen.at(-1) !== state) seen.push(state)
  }
  assert.deepEqual(seen, ["", "R", "RS"])
  const nulled = new StreamingAssessment({ steering: true })
  nulled.push('{"safe":false,"reason":"r","steering":null')
  assert.equal(nulled.preview()?.steeringComplete, undefined, "null needs a token boundary")
  nulled.push(",")
  assert.equal(nulled.preview()?.steeringComplete, true)
  assert.equal(nulled.preview()?.steering, undefined)
  const base = new StreamingAssessment()
  base.push('{"safe":false,"reason":"r","steering":"Please stop."')
  assert.equal(base.preview(), undefined, "steering is an unknown field without the steering schema")
})
