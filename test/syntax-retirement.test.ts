import { test } from "node:test"
import assert from "node:assert/strict"
import { retireDefaultMarkdownStyle } from "../src/syntax-retirement.js"

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("default Markdown retirement conservatively waits supplied latest highlights, including rejection", async () => {
  const first = deferred(), second = deferred(), last = deferred()
  let destroys = 0
  const retired = retireDefaultMarkdownStyle({ destroy: () => { destroys++ } }, [first.promise, second.promise, last.promise])
  second.reject(new Error("highlight failed"))
  last.resolve()
  await Promise.resolve()
  assert.equal(destroys, 0, "a supplied unfinished promise remains owned")
  first.resolve()
  await retired
  assert.equal(destroys, 1)
})

test("unrelated pending highlights do not retain a detached default Markdown style", async () => {
  const old = deferred(), current = deferred()
  const released: string[] = []
  const previous = retireDefaultMarkdownStyle({ destroy: () => released.push("old") }, [old.promise])
  const next = retireDefaultMarkdownStyle({ destroy: () => released.push("current") }, [current.promise])
  old.resolve()
  await previous
  assert.deepEqual(released, ["old"])
  current.resolve()
  await next
  assert.deepEqual(released, ["old", "current"])
})
