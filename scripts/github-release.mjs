import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { expectedArtifact, loadReleaseArtifact } from "./release-artifact.mjs"
import { canAdvanceChannel, isPrerelease, npmReleaseVersion } from "./release-version.mjs"
import { archiveIntegrity, registryReader, verifyPublication } from "./npm-publication.mjs"

/** Attach the CI-verified archive independently of npm's upload/processing outcome,
 * inside the workflow's package-wide publication lock. */
export async function githubRelease(tarball, pkg, tag, {
  repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN,
  fetcher = fetch, run = execFileSync, bytes, commit,
} = {}) {
  npmReleaseVersion(pkg.version)
  assert.equal(tag, `v${pkg.version}`, "Release tag must match v<package.json version>")
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "Expected the validated release commit")
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0, "Expected the validated archive bytes")
  assert.equal(path.basename(tarball), `${pkg.name}-${pkg.version}.tgz`, "Unexpected archive filename")
  const prerelease = isPrerelease(pkg.version)
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected a GitHub repository")
  const registry = registryReader({ fetcher, end: performance.now() + 30000 })
  const published = await registry.json(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, { missing: true })
  if (published !== undefined) {
    assert.equal(published.version, pkg.version, "Registry returned a different version")
    assert.equal(published.dist?.integrity, archiveIntegrity(bytes), "Published archive differs from the validated archive")
    await verifyPublication(pkg, bytes, undefined, { fetcher, timeoutMs: 30000 })
  }
  async function get(endpoint, missing = false) {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${endpoint}`, {
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000), redirect: "error",
    })
    if (missing && response.status === 404) return undefined
    assert.ok(response.ok, `GitHub release lookup failed: HTTP ${response.status}`)
    return response.json()
  }
  async function verifyTag() {
    const ref = await get(`git/ref/tags/${encodeURIComponent(tag)}`)
    assert.equal(ref.ref, `refs/tags/${tag}`, "GitHub returned a different tag ref")
    let object = ref.object
    const seen = new Set()
    while (object?.type === "tag") {
      assert.match(object.sha ?? "", /^[a-f0-9]{40}$/, "Invalid annotated tag identity")
      assert.ok(seen.size < 8 && !seen.has(object.sha), "Unresolved annotated tag chain")
      seen.add(object.sha)
      const annotated = await get(`git/tags/${object.sha}`)
      assert.equal(annotated.sha, object.sha, "GitHub returned a different tag object")
      object = annotated.object
    }
    assert.equal(object?.type, "commit", "Release tag must resolve to a commit")
    assert.equal(object.sha, commit, "Remote tag differs from the validated commit")
  }
  let latest = false
  if (!prerelease) {
    const current = await get("releases/latest", true)
    if (current !== undefined) {
      assert.equal(typeof current.tag_name, "string", "GitHub latest returned no version tag")
      assert.ok(current.tag_name.startsWith("v"), "GitHub latest must use a v<version> tag")
      npmReleaseVersion(current.tag_name.slice(1))
      assert.equal(isPrerelease(current.tag_name.slice(1)), false, "GitHub latest must be a stable version")
    }
    latest = canAdvanceChannel(pkg.version, current?.tag_name.slice(1))
  }
  const existing = await get(`releases/tags/${encodeURIComponent(tag)}`, true)
  const repo = ["--repo", repository]
  const options = { stdio: "inherit" }
  if (existing !== undefined) {
    assert.equal(existing.tag_name, tag, "GitHub returned a different release tag")
    assert.ok(Number.isSafeInteger(existing.id) && existing.id > 0, "Invalid release identity")
    const matches = [], seen = new Set()
    for (let page = 1; ; page++) {
      assert.ok(page <= 10, "Release asset inventory exceeds verification bounds")
      const assets = await get(`releases/${existing.id}/assets?per_page=100&page=${page}`)
      assert.ok(Array.isArray(assets) && assets.length <= 100, "Invalid release asset inventory")
      for (const asset of assets) {
        assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && !seen.has(asset.id), "Invalid or repeated release asset")
        assert.equal(typeof asset.name, "string", "Invalid release asset name")
        seen.add(asset.id)
        if (asset.name === path.basename(tarball)) matches.push(asset)
      }
      if (assets.length < 100) break
    }
    assert.ok(matches.length <= 1, "Ambiguous release archive assets")
    if (matches.length) {
      const asset = matches[0]
      assert.equal(asset.state, "uploaded", "Existing release archive is incomplete")
      assert.equal(asset.size, bytes.length, "Existing release archive size differs")
      const downloaded = run("gh", ["api", `repos/${repository}/releases/assets/${asset.id}`,
        "--header", "Accept: application/octet-stream"], {
        stdio: ["ignore", "pipe", "pipe"], maxBuffer: bytes.length + 1, timeout: 30000,
      })
      assert.ok(Buffer.isBuffer(downloaded) && downloaded.equals(bytes), "Existing release archive bytes differ")
    } else {
      await verifyTag()
      run("gh", ["release", "upload", tag, tarball, ...repo], options)
    }
    await verifyTag()
    run("gh", ["release", "edit", tag, "--draft=false", `--prerelease=${prerelease}`, `--latest=${latest}`, ...repo], options)
  } else {
    await verifyTag()
    run("gh", ["release", "create", tag, tarball, "--verify-tag", "--generate-notes", "--title", `${pkg.name} ${tag}`,
      ...(prerelease ? ["--prerelease"] : []), `--latest=${latest}`, ...repo], options)
  }
  return { prerelease, latest, existing: existing !== undefined }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const directory = process.argv[2]
  assert.ok(directory && process.argv.length === 3, "Expected one verified artifact directory")
  const { manifest, tarball, pkg, bytes } = await loadReleaseArtifact(directory, expectedArtifact())
  await githubRelease(tarball, pkg, manifest.tag, { bytes, commit: manifest.commit })
}
