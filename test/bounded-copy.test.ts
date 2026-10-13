import { test } from "node:test"
import assert from "node:assert/strict"
import { boundedCopy } from "../src/tool-evidence.js"

test("bounded JSON preserves exact values and independently measured encoded bytes", () => {
  const value = { tool: "shell", input: { command: "printf 'café🍐'" }, scope: ["/srv/private"] }
  const bytes = Buffer.byteLength(JSON.stringify(value))
  const copy = boundedCopy(value, bytes)
  assert.deepEqual(copy.value, value)
  assert.notEqual(copy.value, value)
  assert.notEqual(copy.value.input, value.input)
  assert.equal(copy.bytes, bytes)
  assert.throws(() => boundedCopy(value, bytes - 1), /byte budget/)
})

test("bounded JSON rejects deep, cyclic, oversized or non-JSON data without invoking accessors", () => {
  let deep: unknown = "leaf"
  for (let i = 0; i < 34; i++) deep = { next: deep }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  for (const value of [deep, cycle, undefined, NaN, new Date(), Array(16385).fill(0)]) assert.throws(() => boundedCopy(value, 1_000_000), /JSON|structure/)
  let touched = false
  assert.throws(() => boundedCopy({ get value() { touched = true; return 1 } }, 1000), /accessor/)
  assert.equal(touched, false)
  const array = Object.defineProperty([], "0", { get: () => { touched = true; return 1 } })
  assert.throws(() => boundedCopy(array, 1000), /accessor/)
  assert.equal(touched, false)
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal","text":"\\n\\\"é🍐"}')
  const copy = boundedCopy(hostile, 1000)
  assert.deepEqual(copy.value, hostile)
  assert.equal(copy.bytes, Buffer.byteLength(JSON.stringify(hostile)))
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  for (const value of ["\u0000\b\f\t\r\n", "\ud800", "\udfff", "é🍐\u2028\u2029", '"\\']) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    assert.equal(boundedCopy(value, bytes).bytes, bytes)
    assert.throws(() => boundedCopy(value, bytes - 1), /byte budget/)
  }
})

test("separate JSON components share the remaining value allowance", () => {
  const mandatory = boundedCopy({ values: Array(9000).fill(1) }, 1_000_000)
  assert.equal(mandatory.values, 9002)
  assert.throws(() => boundedCopy({ enum: Array(9000).fill("a") }, 1_000_000 - mandatory.bytes,
    16384 - mandatory.values), /structure limits/)
  assert.deepEqual(mandatory.value.values, Array(9000).fill(1))
})
