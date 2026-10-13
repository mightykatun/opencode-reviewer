import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

// These are the published 2.0.26 bytes, not a runtime host-version gate.
// Review all three files before updating the adapter for another build pin.
const fingerprints = {
  "index.js": "70f5649897f56c66ab0cbf095915c68f6ac7a1e2089ff215504d0d77a347e317",
  "schema.js": "36bbc83a5f0dc13013aea26463a11accfbaff84b0e2fbaea22fea8099b703c19",
  "syntax.js": "bcac1cbfad2dcf80c1010c5ae8befc386ec48a931c4fc8cfef348284a6b6957f",
}

export function verifyThemeSyntaxInputs(manifest, digests) {
  if (manifest?.name !== "@opencode/theme" || manifest.version !== "2.0.26"
    || manifest.exports?.["./tui"]?.import !== "./dist/tui/index.js"
    || manifest.dependencies?.["@opentui/core"] !== "0.5.17"
    || manifest.dependencies?.effect !== "4.0.0-rc.112") {
    throw new Error("Pinned theme package identity or public barrel changed")
  }
  if (!digests || Object.keys(digests).length !== Object.keys(fingerprints).length) {
    throw new Error("Pinned theme build inputs changed")
  }
  for (const [file, digest] of Object.entries(fingerprints)) {
    if (digests[file] !== digest) throw new Error(`Pinned theme build input changed: ${file}`)
  }
}

export const themeSyntaxOnlyPlugin = {
  name: "theme-syntax-only",
  setup(builder) {
    builder.onLoad({ filter: /node_modules\/@opencode\/theme\/dist\/tui\/index\.js$/ }, async ({ path: barrel }) => {
      const directory = path.dirname(barrel)
      const manifest = JSON.parse(await readFile(path.join(directory, "../../package.json"), "utf8"))
      const digests = Object.fromEntries(await Promise.all(Object.keys(fingerprints).map(async file => [
        file, createHash("sha256").update(await readFile(path.join(directory, file))).digest("hex"),
      ])))
      verifyThemeSyntaxInputs(manifest, digests)
      // The public barrel eagerly initializes Effect schemas and theme parsers.
      // Replace only that barrel; bundle upstream syntax.js byte-for-byte as input.
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
