import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { setTimeout } from "node:timers/promises"
import { expectedArtifact, loadReleaseArtifact } from "./release-artifact.mjs"
import { publicationTag, validatePublicationPackage } from "./release-version.mjs"
import { archiveIntegrity, Pending, registryReader, verifyPublication } from "./npm-publication.mjs"
import { prepareProvenance, releaseStatement } from "./release-provenance.mjs"

// Publish the same verified bytes attached to GitHub. Existing versions are immutable:
// reruns (or the authenticated first-publication bootstrap) must match exactly.
export async function publishRelease(tarball, pkg, bytes, {
  fetcher = fetch, run = execFileSync, now = () => performance.now(), sleep = setTimeout,
  readTimeoutMs = 30000, intervalMs = 1000, provenance,
} = {}) {
  validatePublicationPackage(pkg)
  const integrity = archiveIntegrity(bytes)
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`
  const end = now() + readTimeoutMs
  const get = registryReader({ fetcher, now, end, requestTimeoutMs: 30000 })
  let tag, reason = "registry state unavailable"
  while (now() < end) {
    try {
      const existing = await get.json(url, { missing: true })
      if (existing !== undefined) {
        assert.equal(existing.dist?.integrity, integrity, "Published version differs from this archive; publish a new version")
        console.log(`${pkg.name}@${pkg.version} already published with identical archive integrity`)
        return { status: "existing" }
      }
      // The workflow holds a package-wide lock while reading and advancing channels.
      // Historical uploads get a non-primary tag; no separate dist-tag write needs a token.
      const tags = await get.json(`https://registry.npmjs.org/-/package/${encodeURIComponent(pkg.name)}/dist-tags`, { missing: true })
      const candidate = publicationTag(pkg.version, tags === undefined ? {} : tags)
      if (now() >= end) throw new Pending("registry deadline elapsed")
      tag = candidate
      break
    } catch (error) {
      if (!(error instanceof Pending)) throw error
      reason = error.message
    }
    const remaining = end - now()
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining))
  }
  assert.ok(tag !== undefined, `Registry lookup could not be verified within ${readTimeoutMs / 1000}s: ${reason}; no upload was attempted`)
  assert.equal(typeof provenance, "function", "New uploads require explicit verified provenance")
  const signed = await provenance()
  try {
    assert.ok(signed?.file && typeof signed.dispose === "function", "Missing signed provenance file")
    try {
      run("npm", ["publish", tarball, "--ignore-scripts", "--access", "public",
        "--provenance-file", signed.file, "--tag", tag, "--registry", "https://registry.npmjs.org/", "--fetch-retries=0"], { stdio: "inherit" })
    } catch {
      // A failed PUT can already be committed. Continue with reads, never a
      // second upload or a dist-tag write, and require the identical archive.
      console.warn("npm upload outcome is uncertain; checking registry availability without retrying the upload")
      return { status: "uncertain", tag }
    }
  } finally { await signed?.dispose?.() }
  return { status: "submitted", tag }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const directory = process.argv[2]
  assert.ok(directory && process.argv.length === 3, "Expected one verified artifact directory")
  const { manifest, tarball, pkg, bytes } = await loadReleaseArtifact(directory, expectedArtifact())
  const statement = releaseStatement(manifest, bytes)
  const result = await publishRelease(tarball, pkg, bytes, { provenance: () => prepareProvenance(statement) })
  await verifyPublication(pkg, bytes, result.tag === "archive" ? undefined : result.tag)
}
