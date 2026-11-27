import type { HistoryReader } from "./history-refresh.js"
import type { HistoryResult } from "./history-schema.js"
import type { ViewerFeed } from "./viewer-feed.js"

export function viewerHistory(feed: ViewerFeed, available: () => boolean) {
  const listeners = new Set<() => void>()
  const reader: HistoryReader = {
    async query(query, parent) {
      const signal = AbortSignal.any([feed.signal, AbortSignal.timeout(3000), ...(parent ? [parent] : [])])
      const options = { location: feed.location, signal }
      signal.throwIfAborted()
      if (!available()) throw Error("Reviewer unavailable")
      if (query.type === "history") {
        const { root: sessionID, entry, order, direction, permission } = query
        return await feed.rpc.history({ sessionID, ...(entry && { entry }), ...(order && { order }),
          ...(direction && { direction }), ...(permission && { permission }) }, options) as HistoryResult
      }
      if (query.type !== "totals") throw Error("Unsupported viewer query")
      const sessionID = query.conversation?.root
      return await feed.rpc.statistics(sessionID ? { sessionID } : {}, options) as HistoryResult
    },
    onCommit(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return { reader, changed() { for (const listener of listeners) listener() } }
}
