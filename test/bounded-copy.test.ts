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

test("strict copying rejects discarded fields, array prototypes and proxies without traps", () => {
  let touched = 0
  const proxy = new Proxy({}, { getPrototypeOf() { touched++; throw Error("No trap") }, ownKeys() { touched++; throw Error("No trap") } })
  const revoked = Proxy.revocable([], {}); revoked.revoke()
  for (const value of [proxy, revoked.proxy,
    Object.defineProperty({}, "hidden", { value: 1 }), { [Symbol("field")]: 1 },
    Object.assign([], { extra: 1 }), Object.setPrototypeOf([1], null),
    Object.defineProperty([1], "0", { enumerable: false }),
    { get field() { touched++; return 1 } },
  ]) assert.throws(() => boundedCopy(value, 1000, 16384, undefined, true))
  assert.equal(touched, 0)
  const generic = Object.defineProperty({ visible: 1 }, "hidden", { value: 2 })
  assert.deepEqual(boundedCopy(generic, 1000).value, { visible: 1 }, "generic collector policy remains unchanged")
})

test("strict copying preserves measured bytes, aliases and exact value/depth limits", () => {
  const nested = Object.assign(Object.create(null), { value: "é🍐\ud800", zero: -0 })
  const raw = { a: nested, b: nested, values: [false, null, 1] }
  const measurements = new WeakMap<object, number>()
  const bytes = Buffer.byteLength(JSON.stringify(raw))
  const result = boundedCopy(raw, bytes, 11, measurements, true)
  assert.equal(result.bytes, bytes)
  assert.equal(result.values, 11)
  assert.deepEqual(result.value.a, { value: nested.value, zero: -0 })
  assert.notEqual(result.value.a, result.value.b)
  assert.equal(measurements.get(result.value.a), Buffer.byteLength(JSON.stringify(nested)))
  assert.throws(() => boundedCopy(raw, bytes - 1, 11, undefined, true), /byte budget/)
  assert.throws(() => boundedCopy(raw, bytes, 10, undefined, true), /structure/)
  let depth: unknown = null
  for (let i = 0; i < 32; i++) depth = { child: depth }
  assert.ok(boundedCopy(depth, 1000, 16384, undefined, true))
  assert.throws(() => boundedCopy({ child: depth }, 1000, 16384, undefined, true), /structure/)
})
