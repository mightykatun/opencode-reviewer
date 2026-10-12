import { build } from "esbuild"
import { transformAsync } from "@babel/core"
import { readFile } from "node:fs/promises"
import inventory from "../src/prompt-files.json" with { type: "json" }
import { soundBanner } from "./bundled-sounds.mjs"

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

await build({
  stdin: {
    contents: 'export { default } from "./src/plugin.ts"; export * from "./src/plugin.ts"; export { historyWorkerProbeSource } from "./src/history-worker-probe.ts"; export { HistoryStore, historyWorkerSource } from "./src/history-store.ts"; export { HistoryRefresh } from "./src/history-refresh.ts"',
    resolveDir: process.cwd(),
    sourcefile: "reviewer-entry.ts",
    loader: "ts",
  },
  outfile: "dist/tui.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2023",
  banner: { js: soundBanner(sounds) },
  define: { __REVIEW_PROMPTS__: JSON.stringify(prompts), __REVIEW_SOUNDS__: "__REVIEWER_BUNDLED_SOUNDS__", __HISTORY_WORKER__: JSON.stringify(historyWorker.outputFiles[0].text) },
  external: ["solid-js", "solid-js/*", "@opentui/*", "@opencode/*", "@opencode-ai/*"],
  plugins: [{
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
  }, {
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
  }],
})
