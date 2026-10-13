import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function runtimeSummary(results) {
  const minutes = results.reduce((sum, item) => sum + item.durationMs, 0) / 60000
  return ["## Runtime fixture durations", "", `${results.length} completed cases; ${minutes.toFixed(1)} minutes of fixture execution.`, "",
    "| Case | Result | Seconds |", "| --- | --- | ---: |",
    ...[...results].sort((a, b) => b.durationMs - a.durationMs).map(item =>
      `| ${item.id} | ${item.status} | ${(item.durationMs / 1000).toFixed(1)} |`), ""].join("\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directories = await readdir(".runtime", { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of directories.filter(entry => entry.isDirectory() && entry.name.startsWith("runtime-run-"))) {
    const data = await readFile(path.join(".runtime", entry.name, "results.json"), "utf8").catch(error => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (data) console.log(runtimeSummary(JSON.parse(data).results))
  }
}
