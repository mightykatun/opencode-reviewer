/** Bound traversal before copying/serializing hostile nested JSON. Preserve values exactly. */
export function boundedCopy<T>(value: T, budget: number, valueBudget = 16384,
  measurements?: WeakMap<object, number>): { value: T; bytes: number; values: number } {
  let bytes = 0, nodes = 0
  const ancestors = new Set<object>()
  const add = (size: number) => { bytes += size; if (bytes > budget) throw new Error("Operation evidence exceeds configured byte budget") }
  const text = (value: string) => {
    add(2)
    // Count JSON escaping without allocating an oversized escaped intermediate.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2)
      else if (code < 32) add(6)
      else if (code < 128) add(1)
      else if (code < 2048) add(2)
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { add(4); i++ }
      else add(code >= 0xd800 && code <= 0xdfff ? 6 : 3)
    }
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > valueBudget || depth > 32) throw new Error("Operation evidence exceeds bounded JSON structure limits")
    if (value === null) { add(4); return null }
    if (typeof value === "string") { text(value); return value }
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) { add(String(value).length); return value }
    if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || ancestors.has(value)) throw new Error("Operation evidence is not a plain JSON record")
    ancestors.add(value)
    const start = bytes
    add(2)
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {}
    let count = 0
    if (Array.isArray(value)) {
      if (value.length > valueBudget - nodes) throw new Error("Operation evidence exceeds bounded JSON structure limits")
      const entries = result as unknown[]
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Operation evidence contains an array hole or accessor")
        if (count++) add(1)
        entries.push(visit(descriptor.value, depth + 1))
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!Object.hasOwn(descriptor, "value")) throw new Error("Operation evidence contains an accessor")
        if (count++) add(1)
        text(key); add(1)
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
      }
    }
    ancestors.delete(value)
    // Sizes describe only newly constructed copies. Consumers can issue frozen
    // components without scanning their large string values a second time.
    measurements?.set(result, bytes - start)
    return result
  }
  return { value: visit(value, 0) as T, bytes, values: nodes }
}
