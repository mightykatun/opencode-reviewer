import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { transform } from "esbuild"
import { displayText } from "../src/controller.js"
import { metadataText } from "../src/metadata-text.js"

const require = createRequire(import.meta.url)
const solid: typeof import("solid-js") = require("solid-js/dist/solid.cjs")
const { transformAsync } = require("@babel/core")
const universal = await transformAsync(await readFile(new URL("../src/host-review-metadata.tsx", import.meta.url), "utf8"), {
  filename: "src/host-review-metadata.tsx", babelrc: false, configFile: false,
  presets: [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ["@babel/preset-typescript", { allExtensions: true, isTSX: true }]],
})
const compiled = await transform(universal.code, { loader: "js", format: "cjs" })

test("live and history metadata use measured width, never wrap, and restore text on resize", () => {
  for (const id of ["reviewer.review.metadata", "reviewer.history.metadata", "reviewer.review.lifetime"]) {
    const node = { width: 20 } as Record<string, any>
    const container = { width: 20 } as Record<string, any>
    const dependencies: Record<string, unknown> = {
      "solid-js": solid,
      "@opentui/solid": {
        createElement(type: string) { assert.ok(type === "box" || type === "text"); return type === "box" ? container : node },
        use(ref: (value: unknown) => void, value: unknown) { ref(value) },
        setProp(value: Record<string, unknown>, key: string, content: unknown) { value[key] = content; return content },
        effect: solid.createRenderEffect,
        insert(value: Record<string, unknown>, content: () => string) { solid.createRenderEffect(() => { value.content = content() }) },
        insertNode(parent: unknown, child: unknown) { assert.equal(parent, container); assert.equal(child, node) },
      },
      "./controller.js": { displayText }, "./metadata-text.js": { metadataText },
    }
    const module = { exports: {} as { HostReviewMetadata(props: unknown): unknown } }
    new Function("require", "module", "exports", compiled.code)((name: string) => {
      assert.ok(name in dependencies, `unexpected dependency ${name}`)
      return dependencies[name]
    }, module, module.exports)
    const [text, setText] = solid.createSignal("token: 1933 in 755 out\ncost: $0.0020")
    const [theme, setTheme] = solid.createSignal({ text: { muted: "muted" } })
    let dispose!: () => void
    solid.createRoot(stop => {
      dispose = stop
      module.exports.HostReviewMetadata({ context: { get theme() { return theme() } }, id, marginTop: 1, get text() { return text() } })
    })
    assert.equal(node.id, id)
    assert.equal(node.content, "token: 1933 in 755..\ncost: $0.0020")
    assert.equal(node.height, 2)
    assert.equal(node.wrapMode, "none")
    assert.equal(node.minWidth, 0)
    assert.equal(node.flexShrink, 0)
    assert.equal(container.marginTop, 1)
    assert.equal(node.width, "100%")
    assert.equal(node.onSizeChange, undefined, "Text nodes do not invoke size callbacks in the real renderer")
    container.width = 40; container.onSizeChange.call(container)
    assert.equal(node.content, text(), "Widening restores the original without changing the stored value")
    container.width = 12; container.onSizeChange.call(container)
    assert.equal(node.content, "token: 193..\ncost: $0.0..", "Scrollbar and sidebar changes use the actual padding-free content width")
    setText("model: x\u001b[31m\nprovider: long.example.com")
    assert.equal(node.content, "model: x\\u..\nprovider: ..", "Controls are escaped before measuring")
    assert.equal(node.height, 2)
    setText("cost: $0.01")
    assert.equal(node.content, "cost: $0.01")
    assert.equal(node.height, 1, "Optional metadata rows can disappear without leaving wrapped or blank rows")
    setTheme({ text: { muted: "new-muted" } })
    assert.equal(node.fg, "new-muted")
    dispose()
  }
})
