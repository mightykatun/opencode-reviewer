import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

// Reviewed upstream source fingerprints, not an OpenCode version allowlist.
// Review all three files when newer upstream source changes these inputs.
const fingerprints = {
  "index.js": "70f5649897f56c66ab0cbf095915c68f6ac7a1e2089ff215504d0d77a347e317",
  "schema.js": "36bbc83a5f0dc13013aea26463a11accfbaff84b0e2fbaea22fea8099b703c19",
  "syntax.js": "bcac1cbfad2dcf80c1010c5ae8befc386ec48a931c4fc8cfef348284a6b6957f",
}

export function verifyThemeSyntaxInputs(manifest, digests) {
  if (manifest?.name !== "@opencode/theme" || !/^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
    || manifest.exports?.["./tui"]?.import !== "./dist/tui/index.js"
    || manifest.dependencies?.["@opentui/core"] !== "0.5.17"
    || manifest.dependencies?.effect !== "4.0.1") {
    throw new Error("Pinned theme package identity or public barrel changed")
  }
  if (!digests || Object.keys(digests).length !== Object.keys(fingerprints).length) {
    throw new Error("Pinned theme build inputs changed")
  }
  for (const [file, digest] of Object.entries(fingerprints)) {
    if (digests[file] !== digest) throw new Error(`Pinned theme build input changed: ${file}`)
  }
}

export function adaptThemeSyntax(source) {
  const signature = "export function generateSyntax(theme) {"
  const close = "\n    ]);\n}"
  if (typeof source !== "string" || source.split(signature).length !== 2 || source.split(close).length !== 2) {
    throw new Error("Pinned theme syntax source changed")
  }
  return source
    .replace(signature, "export function generateSyntax(theme, owner) {")
    .replace(close, "\n    ], owner);\n}")
}

export const themeSyntaxOnlyPlugin = {
  name: "theme-syntax-only",
  setup(builder) {
    builder.onLoad({ filter: /node_modules\/@opencode\/theme\/dist\/tui\/(?:index|syntax)\.js$/ }, async ({ path: target }) => {
      const directory = path.dirname(target)
      const manifest = JSON.parse(await readFile(path.join(directory, "../../package.json"), "utf8"))
      const sources = Object.fromEntries(await Promise.all(Object.keys(fingerprints).map(async file => [
        file, await readFile(path.join(directory, file), "utf8"),
      ])))
      const digests = Object.fromEntries(Object.entries(sources).map(([file, source]) => [
        file, createHash("sha256").update(source).digest("hex"),
      ]))
      verifyThemeSyntaxInputs(manifest, digests)
      if (path.basename(target) === "syntax.js") {
        return { contents: adaptThemeSyntax(sources["syntax.js"]), loader: "js" }
      }
      // The public barrel eagerly initializes Effect schemas and theme parsers.
      // Replace only that barrel; adapt syntax.js to forward the SyntaxStyle owner.
      return { contents: 'export { generateSyntax } from "./syntax.js";', loader: "js" }
    })
  },
}

export function verifyThemeSyntaxBuild(metafile) {
  const expected = new Set(["dist/tui/index.js", "dist/tui/syntax.js"])
  for (const input of Object.keys(metafile.inputs)) {
    if (/(?:^|\/)node_modules\/effect(?:\/|$)/.test(input)) {
      throw new Error(`Unused Effect dependency entered terminal payload: ${input}`)
    }
    const theme = input.match(/(?:^|\/)node_modules\/@opencode\/theme\/(.+)$/)
    if (!theme) continue
    if (!expected.delete(theme[1])) throw new Error(`Unexpected bundled theme input: ${input}`)
  }
  if (expected.size) throw new Error("Pinned theme syntax adapter was not used")
}
