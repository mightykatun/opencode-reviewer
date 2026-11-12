import type { Plugin } from "@opencode/plugin/tui"
import { sameLocation, type CompanionHandshake } from "./companion-protocol.js"

/** Exactly the fields a companion handshake binds a composition to. */
export type ReviewLocation = CompanionHandshake["location"]

/** Each reviewed location owns a companion handshake, a two-second pending poll
 * and a history worker. Open tabs past this bound stay manual. */
export const MAX_REVIEW_LOCATIONS = 8

/** Normalize a public location value. Anything without a directory is unknown. */
export function reviewLocation(value: unknown): ReviewLocation | undefined {
  if (!value || typeof value !== "object") return
  const { directory, workspaceID } = value as Record<string, unknown>
  if (typeof directory !== "string" || !directory) return
  return typeof workspaceID === "string" && workspaceID ? { directory, workspaceID } : { directory }
}

/** Stable identity for maps keyed by location. */
export function locationKey(location: ReviewLocation): string {
  return JSON.stringify([location.directory, location.workspaceID ?? null])
}

/** The host's current location follows the focused conversation. Before its
 * first location sync the host reports none, so its default applies. */
export function hostLocation(context: Plugin.Context): ReviewLocation {
  const current = context.location ?? context.data.location.default()
  return { directory: current.directory, ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}) }
}

/** The current host location first, then the location of every open session
 * tab in tab order, deduplicated and bounded. A tab is a root conversation, so
 * its own session location owns the permissions of its whole family. A tab
 * whose session is not cached yet joins on a later read. */
export function reviewLocations(context: Plugin.Context): ReviewLocation[] {
  const locations = new Map<string, ReviewLocation>()
  const add = (location: ReviewLocation | undefined) => {
    if (location && locations.size < MAX_REVIEW_LOCATIONS) locations.set(locationKey(location), location)
  }
  add(hostLocation(context))
  try {
    if (context.ui.tabs.enabled())
      for (const tab of context.ui.tabs.list()) add(reviewLocation(context.data.session.get(tab.sessionID)?.location))
  } catch { /* Without readable tabs only the current location is reviewed. */ }
  return [...locations.values()]
}

/** A session belongs to a location only when its cached metadata says so. */
export function sessionAtLocation(context: Plugin.Context, sessionID: string, location: ReviewLocation): boolean {
  const session = context.data.session.get(sessionID)
  return !!session && sameLocation(reviewLocation(session.location), location)
}

/** Exactly one location presents the current route: a session route's own
 * location, otherwise the current host location. */
export function routeAtLocation(context: Plugin.Context, location: ReviewLocation): boolean {
  const route = context.ui.router.current()
  return route.type === "session" ? sessionAtLocation(context, route.sessionID, location)
    : sameLocation(hostLocation(context), location)
}
