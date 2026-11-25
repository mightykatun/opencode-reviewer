import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { lstat, mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"

/** Expected members belong to each fixture, independently of release policy. */
export async function verifyFixturePackage(root, directory, expectedFiles) {
  const walk = async (at, prefix = "") => {
    const files = []
    for (const name of await readdir(at)) {
      const file = path.join(at, name), stat = await lstat(file)
      assert.equal(stat.isSymbolicLink(), false, "Archive install must not use source symlinks")
      if (stat.isDirectory()) files.push(...await walk(file, prefix + name + "/"))
      else { assert.ok(stat.isFile()); files.push(prefix + name) }
    }
    return files.sort()
  }
  assert.deepEqual(await walk(directory), expectedFiles)
  for (const file of expectedFiles) assert.deepEqual(await readFile(path.join(directory, file)), await readFile(path.join(root, file)))
}

/** Packs the built repository unchanged. Lifecycle keeps its separate npm installation. */
export async function packFixtureArchive({ root, temp, env, expectedFiles, extract = true }) {
  const npmOptions = { env: { ...env, npm_config_cache: path.join(temp, "npm-cache"), npm_config_ignore_scripts: "true" },
    encoding: "utf8", timeout: 60000 }
  const output = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", temp],
    { ...npmOptions, cwd: root }))
  const packed = Array.isArray(output) ? output : Object.values(output)
  assert.equal(packed.length, 1)
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), expectedFiles)
  assert.equal(path.basename(packed[0].filename), packed[0].filename)
  const archive = path.join(temp, packed[0].filename)
  assert.deepEqual(execFileSync("tar", ["-tzf", archive], { env, encoding: "utf8", timeout: 10000 }).trim().split("\n").sort(),
    expectedFiles.map(file => "package/" + file).sort())
  const install = path.join(temp, "installed"), installed = path.join(install, "package")
  if (extract) {
    await mkdir(install)
    execFileSync("tar", ["-xzf", archive, "-C", install], { env, timeout: 10000 })
    await verifyFixturePackage(root, installed, expectedFiles)
  }
  return { archive, packed, npmOptions, installed }
}
