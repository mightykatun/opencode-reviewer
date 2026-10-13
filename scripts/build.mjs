import { build } from "esbuild"
import { transformAsync } from "@babel/core"
import { readFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import inventory from "../src/prompt-files.json" with { type: "json" }
import { soundBanner } from "./bundled-sounds.mjs"
import { historyWorkerBanner } from "./bundled-history-worker.mjs"
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

const define = {
  __REVIEW_PROMPTS__: JSON.stringify(prompts), __REVIEW_SOUNDS__: "__REVIEWER_BUNDLED_SOUNDS__",
  __HISTORY_WORKER__: "__REVIEWER_HISTORY_WORKER__",
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
      // Both distributed bundles embed every prompt. Keep filesystem discovery
      // only in direct source tests, never in the terminal CJS payload.
      return { contents: source.replace(fallback, 'throw Error("Embedded prompts unavailable")'), loader: "ts" }
    })
  },
}

// A separate fixed CJS payload prevents esbuild hoisting terminal imports into
// the shared ESM entrypoint. Theme helpers and non-host dependencies are bundled;
// these four public imports are supplied lazily by the CLI loader.
const hostModules = ["solid-js", "@opentui/core", "@opentui/solid", "@opencode/plugin/rpc"]
const hostRuntime = await build({
  entryPoints: ["src/host-runtime.tsx"], bundle: true, write: false, metafile: true,
  platform: "node", format: "cjs", target: "es2023", external: hostModules,
  define, plugins: [decoderPlugin, themeSyntaxOnlyPlugin, jsxPlugin, embeddedPromptsPlugin],
})
verifyThemeSyntaxBuild(hostRuntime.metafile)
for (const output of Object.values(hostRuntime.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !hostModules.includes(dependency.path) && !isBuiltin(dependency.path)) {
      throw new Error(`Unmapped host runtime dependency: ${dependency.path}`)
    }
  }
}

const entrypoint = await build({
  stdin: {
    contents: 'export { default } from "./src/plugin.ts"; export * from "./src/plugin.ts"; export { historyWorkerProbeSource } from "./src/history-worker-probe.ts"; export { HistoryStore, historyWorkerSource } from "./src/history-store.ts"; export { HistoryRefresh } from "./src/history-refresh.ts"',
    resolveDir: process.cwd(),
    sourcefile: "reviewer-entry.ts",
    loader: "ts",
  },
  outfile: "dist/tui.js",
  bundle: true,
  metafile: true,
  platform: "node",
  format: "esm",
  target: "es2023",
  banner: { js: `${soundBanner(sounds)}\n${historyWorkerBanner(historyWorker.outputFiles[0].text)}` },
  define: { ...define, __HOST_RUNTIME__: JSON.stringify(Buffer.from(hostRuntime.outputFiles[0].text).toString("base64")) },
  external: ["solid-js", "solid-js/*", "@opentui/*", "@opencode/*"],
  plugins: [decoderPlugin, jsxPlugin, embeddedPromptsPlugin],
})
for (const output of Object.values(entrypoint.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.kind !== "dynamic-import" && /^(?:solid-js(?:\/|$)|@opentui\/|@opencode\/theme(?:\/|$))/.test(dependency.path)) {
      throw new Error(`Eager terminal dependency in shared entrypoint: ${dependency.path}`)
    }
  }
}
