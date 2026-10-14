import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { compareVersions, npmReleaseVersion } from "./release-version.mjs"

export const archiveIntegrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

// npm processing can outlast ten minutes after an accepted upload. Keep the
// publish job timeout longer than this read-only verification budget.
export const PUBLICATION_TIMEOUT_MS = 60 * 60 * 1000

// Cache-Control alone did not bypass cached 404s during the first automated release.
export function freshRegistryURL(url) {
  const fresh = new URL(url)
  assert.equal(fresh.origin, "https://registry.npmjs.org", "Expected the npm registry")
  fresh.searchParams.set("release_check", randomUUID())
  return fresh.href
}

export class Pending extends Error {}

/** Headers and body share one request timeout and the caller's fixed read deadline. */
export function registryReader({ fetcher = fetch, now = () => performance.now(), end, requestTimeoutMs = 15000 }) {
  const cancel = (body) => { try { void body?.cancel().catch(() => {}) } catch { /* Best-effort cleanup must not hold the deadline. */ } }
  async function read(url, { missing = false, limit = 16 * 1024 * 1024 } = {}) {
    if (now() >= end) throw new Pending("registry deadline elapsed")
    const fresh = freshRegistryURL(url)
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(requestTimeoutMs, end - now()))))
    let response
    try {
      response = await fetcher(fresh, { headers: { "cache-control": "no-cache" }, signal, redirect: "error" })
    } catch { throw new Pending("registry request failed") }
    if (!response.ok) {
      cancel(response.body)
      if (missing && response.status === 404) return undefined
      if ([404, 408, 429].includes(response.status) || response.status >= 500) throw new Pending(`registry HTTP ${response.status}`)
      throw new Error(`Registry verification failed: HTTP ${response.status}`)
    }
    if (!response.body) return Buffer.alloc(0)
    const reader = response.body.getReader(), chunks = []
    let length = 0
    try {
      while (true) {
        let result
        try {
          signal.throwIfAborted()
          result = await new Promise((resolve, reject) => {
            const aborted = () => reject(signal.reason)
            signal.addEventListener("abort", aborted, { once: true })
            reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted)).catch(() => {})
          })
        } catch { throw new Pending("registry response body failed or timed out") }
        if (result.done) break
        length += result.value.byteLength
        assert.ok(length <= limit, "Registry response exceeds expected byte bounds")
        chunks.push(Buffer.from(result.value))
      }
      if (now() >= end) throw new Pending("registry deadline elapsed")
      return Buffer.concat(chunks, length)
    } finally {
      cancel(reader)
      reader.releaseLock()
    }
  }
  return {
    async json(url, options) {
      const bytes = await read(url, { limit: 1024 * 1024, ...options })
      // Parsing a complete malformed response is a terminal error, not a transport retry.
      return bytes === undefined ? undefined : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    },
    archive: (url, size) => read(url, { limit: size }),
  }
}

/** npm may accept an upload before its version, dist-tag and archive are available.
 * Channel verification is optional: historical archives and reruns need no channel ownership.
 * Retry reads only. Never retry the publication itself.
 */
export async function verifyPublication(pkg, bytes, tag, {
  fetcher = fetch, sleep = setTimeout, now = () => performance.now(),
  timeoutMs = PUBLICATION_TIMEOUT_MS, intervalMs = 10000, requestTimeoutMs = 15000, log = console.log,
} = {}) {
  npmReleaseVersion(pkg.version)
  assert.ok(tag === undefined || tag === "latest" || tag === "next", "Expected a primary npm channel or archive-only verification")
  const end = now() + timeoutMs
  const integrity = archiveIntegrity(bytes)
  const root = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`
  let reason = "version metadata unavailable"
  const get = registryReader({ fetcher, now, end, requestTimeoutMs })
  while (now() < end) {
    try {
      const metadata = await get.json(`${root}/${encodeURIComponent(pkg.version)}`)
      assert.equal(metadata.version, pkg.version, "Registry returned a different version")
      assert.equal(metadata.dist?.integrity, integrity, "Published archive integrity differs from the verified build")
      let owner
      if (tag !== undefined) {
        const tags = await get.json(`https://registry.npmjs.org/-/package/${encodeURIComponent(pkg.name)}/dist-tags`)
        assert.ok(tags && typeof tags === "object" && !Array.isArray(tags), "Registry returned invalid dist-tags")
        owner = tags[tag]
        if (owner !== undefined) npmReleaseVersion(owner)
        // Another publisher may have legitimately advanced the channel during propagation.
        if (owner !== pkg.version && !(owner !== undefined && compareVersions(owner, pkg.version) > 0)) {
          throw new Pending(`${tag} has not reached ${pkg.version}`)
        }
      }
      assert.equal(typeof metadata.dist.tarball, "string", "Registry returned no archive URL")
      const archive = await get.archive(metadata.dist.tarball, bytes.length)
      assert.equal(archive.length, bytes.length, "Published archive size differs from the verified build")
      assert.equal(archiveIntegrity(archive), integrity, "Downloaded npm archive differs from the verified build")
      assert.ok(now() < end, "npm publication verification exceeded its deadline")
      log(`Verified ${pkg.name}@${pkg.version} on npm${tag === undefined ? "" : `; ${tag} is ${owner}`}; archive integrity matches`)
      return
    } catch (error) {
      if (!(error instanceof Pending)) throw error
      reason = error.message
    }
    const remaining = end - now()
    if (remaining <= 0) break
    log(`Waiting for npm: ${reason}. Checking again in ${Math.min(intervalMs, remaining) / 1000}s.`)
    await sleep(Math.min(intervalMs, remaining))
  }
  throw new Error(`npm publication could not be verified within ${timeoutMs / 1000}s: ${reason}. Check npm before retrying; do not republish or change the version just to bypass processing.`)
}
