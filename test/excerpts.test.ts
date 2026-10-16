import assert from "node:assert/strict"
import { test } from "node:test"
import { ExcerptLines, LineExcerpt, diffExcerpt, validExcerpt } from "../src/excerpts.js"

test("diff excerpts prefer distant changed lines and retain exact original numbering/counts", () => {
  const source = ["--- a", "+++ b", "@@ -1,102 +1,102 @@", ...Array(50).fill(" unchanged"),
    "-old behavior", "+new behavior", ...Array(50).fill(" unchanged")]
  const result = diffExcerpt(source.join("\n") + "\n", 340, new AbortController().signal)!
  assert.match(result.contents, /L3: @@ -1,102 \+1,102 @@/)
  assert.match(result.contents, /L54: -old behavior\nL55: \+new behavior/)
  assert.equal(result.excerpt.totalLines, 105)
  const provided = result.contents.split("\n").slice(0, -1)
  for (const line of provided) {
    const [, number, text] = /^L(\d+): (.*)$/.exec(line)!
    assert.equal(text, source[Number(number) - 1])
  }
  assert.equal(result.contents.split("\n").at(-1), `missing ${105 - provided.length} more lines`)
  assert.ok(Buffer.byteLength(result.contents) <= 340)
  assert.ok(validExcerpt(result.excerpt, result.contents))
  assert.equal(validExcerpt({ ...result.excerpt, includedLines: provided.length + 1 }, result.contents), false)
  assert.equal(validExcerpt(result.excerpt, result.contents.replace("L55:", "L54:")), false)
  assert.equal(validExcerpt({ ...result.excerpt, totalLines: 104 }, result.contents), false)
})

test("streamed excerpts count CRLF, empty lines and unterminated EOF without inventing scan-limit counts", () => {
  const text = "# header\r\n\r\n" + "# filler 🍐\r\n".repeat(50) + "def selected():\r\n    return 'café'"
  const lines = new ExcerptLines(new LineExcerpt(400, "source"))
  // Include boundaries inside CRLF and surrogate pairs as a decoded stream would
  // deliver them (the file decoder never splits a Unicode scalar).
  for (const char of text) lines.push(char)
  const result = lines.finish(true)!
  assert.equal(result.excerpt.totalLines, 54)
  assert.match(result.contents, /L53: def selected\(\):\r\nL54:     return 'café'/)
  assert.ok(Buffer.byteLength(result.contents) <= 400)
  assert.ok(validExcerpt(result.excerpt, result.contents))

  const partial = new ExcerptLines(new LineExcerpt(200, "source"))
  partial.push("#! /bin/sh\n# read\nunfinished")
  const unknown = partial.finish(false)!
  assert.equal(unknown.excerpt.totalLines, undefined)
  assert.doesNotMatch(unknown.contents, /unfinished/)
  assert.match(unknown.contents, /missing more lines \(count unavailable: scan limit reached\)$/)
  assert.ok(validExcerpt(unknown.excerpt, unknown.contents))
})

test("oversized individual lines do not hide later useful source or fabricate partial lines", () => {
  const lines = new ExcerptLines(new LineExcerpt(200, "source"))
  for (let index = 0; index < 100; index++) lines.push("x".repeat(1000))
  lines.push("\ndef entry():\n    return 1\n")
  const result = lines.finish(true)!
  assert.equal(result.excerpt.totalLines, 3)
  assert.equal(result.excerpt.includedLines, 2)
  assert.equal(result.contents, "L2: def entry():\nL3:     return 1\nmissing 1 more lines")
})
