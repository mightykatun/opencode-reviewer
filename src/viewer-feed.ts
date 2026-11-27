import type { Plugin } from "@opencode/plugin/tui"
import type { View } from "./controller.js"
import type { HostPendingRequest } from "./host-types.js"
import { atLocation, type ReviewLocation } from "./host-locations.js"
import { readIdentity, reviewerRpc, type ReviewerSnapshot, type ReviewerViewProjection } from "./reviewer-protocol.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import { emitDiagnostic, type DiagnosticObserver } from "./diagnostics.js"

export interface ViewerRow extends ReviewerViewProjection {
  view: View<HostPendingRequest>
}
export interface ViewerSnapshot extends ReviewerSnapshot {
  views: readonly ViewerRow[]
}

/** A present assessment must carry a boolean rating and string texts, or the panel could misreport. */
function validAssessment(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== "object") return false
  const { safe, reason, desc } = value as Record<string, unknown>
  return typeof safe === "boolean" && typeof reason === "string" && typeof desc === "string"
}

function snapshot(value: unknown, location: ReviewLocation): ViewerSnapshot {
  const data = value as ViewerSnapshot | null
  if (!data || !atLocation(data.location, location) || !Number.isSafeInteger(data.revision) || data.revision < 0
    || typeof data.review?.enabled !== "boolean" || !Array.isArray(data.views)
    || !data.views.every(row => typeof row?.attempt === "string" && typeof row.head === "boolean"
      && typeof row.view?.request?.sessionID === "string" && typeof row.view.request.id === "string" && validAssessment(row.view.assessment))
    || (data.recent !== undefined && (!Array.isArray(data.recent) || !data.recent.every(entry => typeof entry?.sessionID === "string"
      && typeof entry.permissionID === "string" && typeof entry.attempt === "string" && (entry.decision === "once" || entry.decision === "reject"))))) {
    throw Error("Invalid reviewer snapshot")
  }
  return data.recent ? data : { ...data, recent: [] }
}

/** One live subscription on one client. A new connection installs a new feed. */
export function viewerFeed(client: Plugin.Context["client"], location: ReviewLocation, life: PluginLifecycle,
  publish: (value: ViewerSnapshot | undefined) => void, observe?: DiagnosticObserver) {
  const rpc = client.rpc(reviewerRpc)
  let nonce: string | undefined
  let revision = -1
  let pending: Promise<void> | undefined
  let subscription: Promise<void> | undefined
  let again = false
  let available = false
  const refresh = () => {
    if (life.signal.aborted) return
    if (pending) {
      again = true
      return pending
    }
    pending = (async () => {
      do {
        again = false
        const signal = AbortSignal.any([life.signal, AbortSignal.timeout(5000)])
        try {
          const identity = readIdentity(await rpc.identity({}, { location, signal }))
          if (!identity) throw Error("Reviewer unavailable")
          const start = performance.now()
          const data = snapshot(await rpc.snapshot({}, { location, signal }), location)
          signal.throwIfAborted()
          if (observe) {
            const at = performance.now()
            emitDiagnostic(observe, { phase: "viewer-snapshot", at, duration: at - start })
          }
          if (nonce !== identity.nonce || data.revision >= revision) {
            const changed = !available || nonce !== identity.nonce || data.revision !== revision
            nonce = identity.nonce
            revision = data.revision
            available = true
            if (changed) publish(data)
          }
        } catch {
          available = false
          if (!life.signal.aborted) publish(undefined)
        }
      } while (again && !life.signal.aborted)
    })().finally(() => { pending = undefined })
    return pending
  }
  const sync = () => {
    if (life.signal.aborted) return
    if (!subscription) {
      subscription = (async () => {
        for await (const event of rpc.events.subscribe("changed", { signal: life.signal })) {
          if (atLocation(event.location, location)) void refresh()
        }
      })().catch(() => {}).finally(() => {
        subscription = undefined
        void refresh()
      })
    }
    return refresh()
  }
  life.addCleanup(async () => { await Promise.allSettled([pending, subscription]) })
  void sync()
  return { rpc, location, refresh: sync, signal: life.signal }
}
export type ViewerFeed = ReturnType<typeof viewerFeed>
