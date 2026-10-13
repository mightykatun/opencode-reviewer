import assert from "node:assert/strict"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { compareVersions } from "./release-version.mjs"

const packageName = "@opencode/cli-linux-x64"
export function latestV2Host(metadata) {
  assert.equal(metadata.name, packageName)
  const version = Object.keys(metadata.versions).filter(value => /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    .sort(compareVersions).at(-1)
  assert.ok(version, "No stable OpenCode V2 release available")
  const entry = metadata.versions[version]
  assert.equal(entry.version, version)
  assert.equal(entry.name, packageName)
  assert.match(entry.dist.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/)
  assert.equal(new URL(entry.dist.tarball).origin, "https://registry.npmjs.org")
  return { version, integrity: entry.dist.integrity, tarball: entry.dist.tarball }
}

export function verifyInstalledHost(lock, selected) {
  const installed = lock.packages?.[`node_modules/${packageName}`]
  assert.equal(installed?.version, selected.version, "Installed host version differs from resolved latest V2")
  assert.equal(installed?.integrity, selected.integrity, "Installed host integrity differs from resolved registry metadata")
  assert.equal(installed?.resolved, selected.tarball, "Installed host archive differs from resolved registry metadata")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "resolve") {
    const response = await fetch("https://registry.npmjs.org/@opencode%2fcli-linux-x64", {
      redirect: "error", signal: AbortSignal.timeout(30000),
    })
    assert.ok(response.ok, `OpenCode registry lookup failed: HTTP ${response.status}`)
    const selected = latestV2Host(await response.json())
    await mkdir(".runtime", { recursive: true })
    await writeFile(".runtime/ci-host.json", JSON.stringify(selected))
    await appendFile(process.env.GITHUB_ENV, `OPENCODE_HOST_VERSION=${selected.version}\n`)
    console.log(`Resolved latest stable OpenCode V2: ${selected.version} (${selected.integrity})`)
  } else {
    assert.equal(process.argv[2], "verify")
    const selected = JSON.parse(await readFile(".runtime/ci-host.json", "utf8"))
    verifyInstalledHost(JSON.parse(await readFile(path.join(process.argv[3], "package-lock.json"), "utf8")), selected)
    console.log(`Verified installed OpenCode ${selected.version} archive integrity`)
  }
}
