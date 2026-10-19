import assert from "node:assert/strict"
import { test } from "node:test"
import stringWidth from "string-width"
import { metadataText } from "../src/metadata-text.js"

test("metadata preserves short and exactly fitting lines, trimming long rows with two trailing dots", () => {
  const text = ["tokens: 1933 in 755 out", "cost: $0.0020", "model: deepseek/deepseek-v4.1-flash-1017",
    "provider: https://openrouter.ai/api/v1", "Time to first rating: 16.61s", "Time to full report: 19.09s"].join("\n")
  assert.equal(metadataText(text, 30), ["tokens: 1933 in 755 out", "cost: $0.0020", "model: deepseek/deepseek-v4...",
    "provider: https://openrouter..", "Time to first rating: 16.61s", "Time to full report: 19.09s"].join("\n"))
  assert.equal(metadataText("exact fit", 9), "exact fit")
  assert.equal(metadataText("exact fits", 9), "exact f..")
  assert.equal(metadataText(text, 12), ["tokens: 19..", "cost: $0.0..", "model: dee..", "provider: ..",
    "Time to fi..", "Time to fu.."].join("\n"), "Every field truncates independently, including counts, cost and timings")
  assert.equal(metadataText(text, 100), text, "Widening restores the full original text")
  assert.equal(text.split("\n")[2], "model: deepseek/deepseek-v4.1-flash-1017", "Source values stay intact")
})

test("metadata truncation counts terminal cells and keeps grapheme clusters intact", () => {
  assert.equal(metadataText("model: 界界界界", 13), "model: 界界..")
  assert.equal(metadataText("e\u0301e\u0301e\u0301abcdef", 5), "e\u0301e\u0301e\u0301..")
  assert.equal(metadataText("👩‍💻👩‍💻abcdef", 6), "👩‍💻👩‍💻..")
  assert.equal(metadataText("🇬🇧🇬🇧abcdef", 6), "🇬🇧🇬🇧..")
  for (const width of [0, 1, 2, 3, 4, 10, 20]) {
    const text = metadataText("model: 界👩‍💻e\u0301abcdefgh\nprovider: example", width)
    assert.equal(text.split("\n").length, 2)
    for (const row of text.split("\n")) assert.ok(stringWidth(row) <= width)
  }
})

test("metadata handles narrow, fractional and unknown widths without wrapping or adding rows", () => {
  for (const width of [0, -1, NaN, Infinity]) assert.equal(metadataText("abcdef", width), "")
  assert.equal(metadataText("abcdef", 1), ".")
  assert.equal(metadataText("abcdef", 2), "..")
  assert.equal(metadataText("abcdef", 3.9), "a..")
  assert.equal(metadataText("a\tb", 3), "a b")
  assert.equal(metadataText("\na\n", 10), "\na\n")
})
