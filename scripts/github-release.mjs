import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { expectedArtifact, loadReleaseArtifact } from "./release-artifact.mjs"
import { canAdvanceChannel, isPrerelease, npmReleaseVersion } from "./release-version.mjs"

/** Attach the CI-verified archive independently of npm's upload/processing outcome,
 * inside the workflow's package-wide publication lock. */
export async function githubRelease(tarball, pkg, tag, {
  repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN,
  fetcher = fetch, run = execFileSync,
} = {}) {
  npmReleaseVersion(pkg.version)
  assert.equal(tag, `v${pkg.version}`, "Release tag must match v<package.json version>")
  const prerelease = isPrerelease(pkg.version)
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected a GitHub repository")
  async function get(endpoint) {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases/${endpoint}`, {
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000), redirect: "error",
    })
    if (response.status === 404) return undefined
    assert.ok(response.ok, `GitHub release lookup failed: HTTP ${response.status}`)
    return response.json()
  }
  let latest = false
  if (!prerelease) {
    const current = await get("latest")
    if (current !== undefined) {
      assert.equal(typeof current.tag_name, "string", "GitHub latest returned no version tag")
      assert.ok(current.tag_name.startsWith("v"), "GitHub latest must use a v<version> tag")
      npmReleaseVersion(current.tag_name.slice(1))
      assert.equal(isPrerelease(current.tag_name.slice(1)), false, "GitHub latest must be a stable version")
    }
    latest = canAdvanceChannel(pkg.version, current?.tag_name.slice(1))
  }
  const existing = await get(`tags/${encodeURIComponent(tag)}`)
  const repo = ["--repo", repository]
  const options = { stdio: "inherit" }
  if (existing !== undefined) {
    assert.equal(existing.tag_name, tag, "GitHub returned a different release tag")
    run("gh", ["release", "upload", tag, tarball, ...repo, "--clobber"], options)
    run("gh", ["release", "edit", tag, "--draft=false", `--prerelease=${prerelease}`, `--latest=${latest}`, ...repo], options)
  } else {
    run("gh", ["release", "create", tag, tarball, "--verify-tag", "--generate-notes", "--title", `${pkg.name} ${tag}`,
      ...(prerelease ? ["--prerelease"] : []), `--latest=${latest}`, ...repo], options)
  }
  return { prerelease, latest, existing: existing !== undefined }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const directory = process.argv[2]
  assert.ok(directory && process.argv.length === 3, "Expected one verified artifact directory")
  const { tarball, pkg } = await loadReleaseArtifact(directory, expectedArtifact())
  await githubRelease(tarball, pkg, process.env.RELEASE_TAG)
}
