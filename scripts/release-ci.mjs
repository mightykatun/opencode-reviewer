import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { setTimeout } from "node:timers/promises"

export async function requireReleaseCI({ repository, commit, branch, token }, {
  fetcher = fetch, sleep = setTimeout, now = () => performance.now(), timeoutMs = 40 * 60 * 1000,
} = {}) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
  assert.match(commit, /^[a-f0-9]{40}$/)
  assert.ok(typeof branch === "string" && branch.length)
  assert.ok(typeof token === "string" && token.length)
  const deadline = now() + timeoutMs
  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`)
  url.search = new URLSearchParams({ head_sha: commit, branch, event: "push", per_page: "100" })
  while (now() < deadline) {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } })
    if (!response.ok) throw new Error(`CI lookup failed: HTTP ${response.status}`)
    const data = await response.json()
    assert.ok(Array.isArray(data.workflow_runs), "Invalid CI run response")
    const runs = data.workflow_runs.filter(run => run.head_sha === commit && run.head_branch === branch && run.event === "push")
      .sort((a, b) => b.id - a.id)
    const run = runs[0]
    if (now() >= deadline) break
    if (run) assert.ok(Number.isSafeInteger(run.id) && run.id > 0, "Invalid CI run identity")
    if (run?.status === "completed") {
      assert.equal(run.conclusion, "success", "Release requires successful CI for the exact tagged commit on the default branch")
      return run.id
    }
    await sleep(Math.min(15000, deadline - now()))
  }
  throw new Error("Timed out waiting for default-branch CI for the exact tagged commit")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = await requireReleaseCI({ repository: process.env.GITHUB_REPOSITORY, commit: process.env.RELEASE_COMMIT,
    branch: process.env.RELEASE_DEFAULT_BRANCH, token: process.env.GH_TOKEN })
  console.log(`Verified successful CI run ${id}`)
}
