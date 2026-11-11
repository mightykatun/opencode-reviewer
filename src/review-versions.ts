import manifest from "../package.json" with { type: "json" }
import { HISTORY_VERSION_BYTES, type HistoryVersions } from "./history-records.js"

/** Bundled from this package, never inferred from the host or installed cache. */
export const reviewerVersion = manifest.version

export function reviewVersions(opencode: unknown): HistoryVersions {
  return { reviewer: reviewerVersion, opencode: typeof opencode === "string" && opencode.trim()
    && !opencode.includes("\0") && Buffer.byteLength(opencode) <= HISTORY_VERSION_BYTES ? opencode : null }
}
