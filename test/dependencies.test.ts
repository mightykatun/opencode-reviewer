import assert from "node:assert/strict"
import { test } from "node:test"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import path from "node:path"

test("the actual Solid dependency graph resolves patched Seroval after installation", async () => {
  const require = createRequire(import.meta.url)
  const solid = createRequire(require.resolve("solid-js"))
  let directory = path.dirname(solid.resolve("seroval"))
  for (let depth = 0; depth < 6; depth++, directory = path.dirname(directory)) {
    let manifest
    try { manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error }
    if (manifest.name !== "seroval") continue
    assert.equal(manifest.version, "1.6.3", "Known deserialization fixes must be installed, not merely declared in overrides")
    return
  }
  assert.fail("Installed Seroval package metadata unavailable")
})
