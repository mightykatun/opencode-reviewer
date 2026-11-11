import { readFileSync } from "node:fs"
import { HISTORY_VERSION_BYTES, type HistoryVersions } from "./history-records.js"

// The build injects only the version string, never the rest of the manifest.
declare const __REVIEWER_VERSION__: string | undefined

/** Bundled from this package, never inferred from the host or installed cache. */
export const reviewerVersion: string = typeof __REVIEWER_VERSION__ !== "undefined" ? __REVIEWER_VERSION__
  : JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

export function reviewVersions(opencode: unknown): HistoryVersions {
  return { reviewer: reviewerVersion, opencode: typeof opencode === "string" && opencode.trim()
    && !opencode.includes("\0") && Buffer.byteLength(opencode) <= HISTORY_VERSION_BYTES ? opencode : null }
}
