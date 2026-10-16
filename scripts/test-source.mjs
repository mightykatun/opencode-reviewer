import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

export function sourceTestPlan(names) {
  const files = names.filter(name => name.endsWith(".test.ts")).sort().map(name => `test/${name}`)
  const watchdog = "test/history-bootstrap.test.ts"
  assert.ok(files.includes(watchdog), "Missing real history watchdog regression")
  assert.equal(new Set(files).size, files.length, "Duplicate source tests")
  // Its deliberate 3s worker timeout and <2s successful-slice assertion measure
  // production budgets. Keep competing large SQLite fixtures out of that window.
  return [[watchdog], files.filter(file => file !== watchdog)]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("../", import.meta.url))
  for (const files of sourceTestPlan(readdirSync(new URL("../test/", import.meta.url)))) {
    if (files.length) execFileSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=2", ...files],
      { cwd: root, stdio: "inherit" })
  }
}
