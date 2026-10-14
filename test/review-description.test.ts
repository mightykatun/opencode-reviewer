import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { transform } from "esbuild"
import { displayText } from "../src/controller.js"
import { retireDefaultMarkdownStyle } from "../src/syntax-retirement.js"

const require = createRequire(import.meta.url)
const solid: typeof import("solid-js") = require("solid-js/dist/solid.cjs")
const { transformAsync } = require("@babel/core")
const source = await readFile(new URL("../src/review-description.tsx", import.meta.url), "utf8")
// Exercise the production universal JSX transform, not React or Solid DOM.
const universal = await transformAsync(source, {
  filename: "src/review-description.tsx", babelrc: false, configFile: false,
  presets: [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ["@babel/preset-typescript", { allExtensions: true, isTSX: true }]],
})
const compiled = await transform(universal.code, { loader: "js", format: "cjs" })

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  class Code {
    constructor(readonly highlightingDone: Promise<void>) {}
    getChildren() { return [] }
  }
  const styles: { theme: unknown; owner: unknown; destroys: number; destroy(): void }[] = []
  const operations: string[] = []
  const nativeScene = Symbol("nativeScene")
  const markdown = {
    isDestroyed: false, content: "", streaming: false, syntaxStyle: undefined as unknown, fg: undefined as unknown,
    conceal: false, tableOptions: undefined as unknown, width: undefined as unknown, flexShrink: undefined as unknown,
    children: [] as { getChildren(): unknown[] }[],
    getChildren() { return this.children },
    refreshStyles() { operations.push("refresh") },
    destroyRecursively() { this.isDestroyed = true; operations.push("destroy-markdown") },
  }
  const dependencies: Record<string, unknown> = {
    "solid-js": solid,
    "@opentui/core": { CodeRenderable: Code },
    "@opentui/solid": {
      createElement(type: string) { assert.equal(type, "markdown"); return markdown },
      use(ref: (node: unknown) => void, node: unknown) { ref(node) },
      setProp(node: Record<string, unknown>, name: string, value: unknown) { node[name] = value; return value },
      effect: solid.createRenderEffect,
    },
    "@opencode/theme/tui": {
      generateSyntax(theme: unknown, owner: unknown) {
        const style = { theme, owner, destroys: 0, destroy() { this.destroys++; operations.push("destroy-style") } }
        styles.push(style)
        return style
      },
    },
    "./controller.js": { displayText },
    "./syntax-retirement.js": { retireDefaultMarkdownStyle },
  }
  const module = { exports: {} as { HostReviewDescription(props: unknown): typeof markdown } }
  new Function("require", "module", "exports", compiled.code)((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`)
    return dependencies[name]
  }, module, module.exports)
  const firstTheme = { text: { base: { color: "first" } } }
  const [theme, setTheme] = solid.createSignal(firstTheme)
  const [text, setText] = solid.createSignal("Initial")
  const [streaming, setStreaming] = solid.createSignal(true)
  let dispose!: () => void, referenced: unknown
  solid.createRoot(stop => {
    dispose = stop
    const result = module.exports.HostReviewDescription({ context: { renderer: { nativeScene }, get theme() { return theme() } },
      get text() { return text() }, get streaming() { return streaming() }, ref: (node: unknown) => { referenced = node } })
    assert.equal(result, markdown)
  })
  return { markdown, styles, operations, referenced, firstTheme, nativeScene, Code, setTheme, setText, setStreaming, dispose }
}

test("host Markdown uses semantic theme syntax, sanitizes reactive report text and preserves default rendering", async () => {
  const host = fixture()
  assert.equal(host.referenced, host.markdown)
  assert.equal(host.styles.length, 1)
  assert.equal(host.styles[0]!.theme, host.firstTheme, "pass the public host theme directly to generateSyntax")
  assert.equal(host.styles[0]!.owner, host.nativeScene, "pass the renderer nativeScene owner to generateSyntax")
  assert.equal(host.markdown.syntaxStyle, host.styles[0])
  assert.equal(host.markdown.fg, host.firstTheme.text.base)
  assert.equal(host.markdown.content, "Initial")
  assert.equal(host.markdown.streaming, true)
  host.setText("Report\u001b[31mred\u001b[0m\u0000")
  host.setStreaming(false)
  assert.equal(host.markdown.content, "Report\\u001b[31mred\\u001b[0m\\u0000")
  assert.equal(host.markdown.streaming, false)
  assert.equal(host.markdown.conceal, true)
  assert.deepEqual(host.markdown.tableOptions, { style: "grid" })
  assert.equal(host.markdown.width, "100%")
  assert.equal(host.markdown.flexShrink, 0)
  host.dispose()
  await Promise.resolve()
})

test("theme handoff refreshes hidden nested Markdown before retiring the old style and owns latest highlights", async () => {
  const host = fixture(), first = deferred(), second = deferred()
  host.markdown.children = [{ getChildren: () => [new host.Code(first.promise), new host.Code(second.promise)] }]
  host.setTheme({ text: { base: { color: "replacement" } } })
  assert.equal(host.styles.length, 2)
  assert.equal(host.markdown.syntaxStyle, host.styles[1])
  assert.deepEqual(host.operations, ["refresh"], "synchronous public refresh happens before style release")
  second.reject(new Error("highlight failed"))
  await Promise.resolve()
  assert.equal(host.styles[0]!.destroys, 0, "another latest highlight remains owned")
  first.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(host.styles[0]!.destroys, 1)
  assert.equal(host.styles[1]!.destroys, 0)
  host.dispose()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(host.styles[1]!.destroys, 1)
})

test("Markdown cleanup ends future readers before releasing the final style after highlight settlement", async () => {
  const host = fixture(), pending = deferred()
  host.markdown.children = [new host.Code(pending.promise)]
  host.dispose()
  assert.equal(host.markdown.isDestroyed, true)
  assert.deepEqual(host.operations, ["destroy-markdown"])
  await Promise.resolve()
  assert.equal(host.styles[0]!.destroys, 0)
  pending.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(host.operations, ["destroy-markdown", "destroy-style"])
  assert.equal(host.styles[0]!.destroys, 1)
})
