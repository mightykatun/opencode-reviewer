import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { packFixtureArchive, verifyFixturePackage } from "../scripts/smoke-package.mjs"

test("fixture packing skips lifecycle scripts and rejects changed, extra and symlinked installed files", async t => {
  const temp = await mkdtemp("/tmp/opencode/fixture-package-"), root = path.join(temp, "source")
  t.after(() => rm(temp, { recursive: true, force: true }))
  await mkdir(root)
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-archive", version: "1.0.0",
    scripts: { prepack: "exit 99" }, files: ["README.md"] }))
  await writeFile(path.join(root, "README.md"), "exact fixture bytes")
  const expectedFiles = ["README.md", "package.json"]
  const { installed, packed } = await packFixtureArchive({ root, temp, env: process.env, expectedFiles })
  assert.equal(packed[0].name, "fixture-archive")
  const target = path.join(installed, "README.md"), saved = await readFile(target)
  await writeFile(target, "changed")
  await assert.rejects(verifyFixturePackage(root, installed, expectedFiles))
  await writeFile(target, saved)
  await writeFile(path.join(installed, "extra"), "extra")
  await assert.rejects(verifyFixturePackage(root, installed, expectedFiles))
  await rm(path.join(installed, "extra"))
  await rm(target)
  await symlink(path.join(root, "README.md"), target)
  await assert.rejects(verifyFixturePackage(root, installed, expectedFiles), /source symlinks/)
})
