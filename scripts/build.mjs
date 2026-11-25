import { build } from "esbuild"
import { transformAsync } from "@babel/core"
import { readFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { fileURLToPath } from "node:url"
import inventory from "../src/prompt-files.json" with { type: "json" }
import { soundBanner, assertNoBundledSounds } from "./bundled-sounds.mjs"
import { historyWorkerBanner, assertNoBundledHistoryWorker } from "./bundled-history-worker.mjs"
import { themeSyntaxOnlyPlugin, verifyThemeSyntaxBuild } from "./theme-syntax-adapter.mjs"

const prompts = Object.fromEntries(await Promise.all(
  Object.entries(inventory).map(async ([name, file]) => [
    name, (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).trim(),
  ]),
))
const sounds = Object.fromEntries(await Promise.all(
  ["attention", "unsafe", "question", "approved", "error", "ended"].map(async name => [name, {
    format: "mp3", data: (await readFile(new URL(`../sounds/${name}.mp3`, import.meta.url))).toString("base64"),
  }]),
))

const historyWorker = await build({
  entryPoints: ["src/history-storage-worker.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", target: "es2023", external: ["bun:sqlite", "node:sqlite"],
})

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const define = {
  __REVIEWER_VERSION__: JSON.stringify(version),
  __REVIEW_PROMPTS__: JSON.stringify(prompts), __REVIEW_SOUNDS__: "__REVIEWER_BUNDLED_SOUNDS__",
  __HISTORY_WORKER__: "__REVIEWER_HISTORY_WORKER__",
}
// Source tests read the manifest; bundles carry only the injected version string.
const versionPlugin = {
  name: "reviewer-version-only",
  setup(builder) {
    builder.onLoad({ filter: /src\/review-versions\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8")
      const fallback = 'JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version'
      if (source.split(fallback).length !== 2) throw Error("Source-only version fallback changed")
      return { contents: source.replace(fallback, '""'), loader: "ts" }
    })
  },
}
const decoderPlugin = {
  name: "notification-decoder-only",
  setup(builder) {
    // Pinned decoder entrypoints import unused worker adapters with native
    // CommonJS initialization. Bundle only the public synchronous API used by
    // notifications; decoder implementation/WASM remain unchanged.
    builder.onLoad({ filter: /node_modules\/mpg123-decoder\/index\.js$/ }, () => ({
      contents: 'export { default as MPEGDecoder } from "./src/MPEGDecoder.js"', loader: "js",
    }))
    builder.onLoad({ filter: /node_modules\/@wasm-audio-decoders\/common\/index\.js$/ }, () => ({
      contents: 'export { default as WASMAudioDecoderCommon } from "./src/WASMAudioDecoderCommon.js"', loader: "js",
    }))
  },
}
const jsxPlugin = {
  name: "opentui-solid",
  setup(builder) {
    builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await readFile(path, "utf8"), {
        filename: path,
        babelrc: false,
        configFile: false,
        presets: [
          ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
          ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
        ],
      })
      return { contents: result.code, loader: "js" }
    })
  },
}
const embeddedPromptsPlugin = {
  name: "embedded-prompts-only",
  setup(builder) {
    builder.onLoad({ filter: /\/src\/prompts\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8")
      const fallback = 'return readFileSync(new URL(`../${inventory[name]}`, import.meta.url), "utf8").trim()'
      if (source.split(fallback).length !== 2) throw Error("Source-only prompt fallback changed")
      // Only direct source tests read prompt files from the checkout.
      return { contents: source.replace(fallback, 'throw Error("Embedded prompts unavailable")'), loader: "ts" }
    })
  },
}

const common = { bundle: true, metafile: true, platform: "node", format: "esm", target: "es2023" }
const server = await build({
  ...common, entryPoints: ["src/server.ts"], outfile: "dist/server.js", external: ["@opencode/*"],
})
const forbidden = /solid-js|@opentui\/|@opencode\/theme|mpeg_frame_decoder_create|mpg123-decoder/
for (const input of Object.keys(server.metafile.inputs)) {
  if (forbidden.test(input)) throw new Error(`Terminal dependency in server inputs: ${input}`)
}
for (const dependency of server.metafile.outputs["dist/server.js"].imports) {
  if (forbidden.test(dependency.path) || (!isBuiltin(dependency.path) && !dependency.path.startsWith("@opencode/"))) {
    throw new Error(`Unexpected server import: ${dependency.path}`)
  }
}
const source = await readFile("dist/server.js", "utf8")
if (forbidden.test(source)) throw new Error("Terminal dependency in server bundle")
assertNoBundledSounds(source)
assertNoBundledHistoryWorker(source)

const terminal = await build({
  ...common, entryPoints: ["src/tui.ts"], outfile: "dist/tui.js",
  banner: { js: `${soundBanner(sounds)}\n${historyWorkerBanner(historyWorker.outputFiles[0].text)}` },
  define,
  alias: { "@opencode/theme/tui": fileURLToPath(import.meta.resolve("@opencode/theme/tui")) },
  external: ["solid-js", "solid-js/*", "@opentui/*", "@opencode/*"],
  plugins: [versionPlugin, decoderPlugin, themeSyntaxOnlyPlugin, jsxPlugin, embeddedPromptsPlugin],
})
verifyThemeSyntaxBuild(terminal.metafile)
