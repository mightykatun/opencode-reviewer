import type { Plugin } from "@opencode/plugin/tui"
import { sameLocation, type CompanionHandshake } from "./companion-protocol.js"
import { conversationRoot } from "./route-approval.js"

/** Exactly the fields a companion handshake binds a composition to. */
export type ReviewLocation = CompanionHandshake["location"]

/** A conversation is reviewed by the composition at its root's location, its
 * home. A subagent can live elsewhere, for example after moving into a git
 * worktree, and its permissions belong to that location's companion. Members are
 * those other locations, so the home reads their permissions too. */
export interface ReviewHome {
  location: ReviewLocation
  members: ReviewLocation[]
}

/** Every home and member costs a companion handshake and a pending poll.
 * Locations past this bound stay manual. */
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

/** Whether a public location value normalizes to exactly this location. */
export function atLocation(value: unknown, location: ReviewLocation): boolean {
  const normalized = reviewLocation(value)
  return !!normalized && sameLocation(normalized, location)
}

/** The host's current location follows the focused conversation. Before its
 * first location sync the host reports none, so its default applies. */
export function hostLocation(context: Plugin.Context): ReviewLocation {
  const current = context.location ?? context.data.location.default()
  return { directory: current.directory, ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}) }
}

/** The current host location first, then the home of the routed conversation and
 * of every open tab in tab order, each with the member locations of that
 * conversation's native family. Deduplicated and bounded. A session that is not
 * cached yet joins on a later read. */
export function reviewHomes(context: Plugin.Context): ReviewHome[] {
  const homes = new Map<string, ReviewHome>()
  const members = new Set<string>()
  let scopes = 0
  const session = (id: string) => context.data.session.get(id)
  const home = (location: ReviewLocation | undefined) => {
    if (!location) return
    let value = homes.get(locationKey(location))
    if (!value && scopes < MAX_REVIEW_LOCATIONS) {
      homes.set(locationKey(location), value = { location, members: [] })
      scopes++
    }
    return value
  }
  const conversation = (root: string | undefined) => {
    if (!root) return
    try {
      const value = home(reviewLocation(session(root)?.location))
      if (!value) return
      for (const id of context.data.session.family(root)) {
        const location = reviewLocation(session(id)?.location)
        const key = location && JSON.stringify([locationKey(value.location), locationKey(location)])
        if (!location || !key || sameLocation(location, value.location) || members.has(key) || scopes >= MAX_REVIEW_LOCATIONS) continue
        members.add(key)
        value.members.push(location)
        scopes++
      }
    } catch { /* An unreadable family keeps only the locations already read. */ }
  }
  home(hostLocation(context))
  try {
    const route = context.ui.router.current()
    if (route.type === "session") conversation(conversationRoot(route.sessionID, session))
  } catch { /* Without a readable route only tabs add homes. */ }
  try {
    if (context.ui.tabs.enabled()) for (const tab of context.ui.tabs.list()) conversation(tab.sessionID)
  } catch { /* Without readable tabs only the current location is reviewed. */ }
  return [...homes.values()]
}

/** A session belongs to a location only when its cached metadata says so. */
export function sessionAtLocation(context: Plugin.Context, sessionID: string, location: ReviewLocation): boolean {
  const session = context.data.session.get(sessionID)
  return !!session && atLocation(session.location, location)
}

/** Exactly one location presents the current route: the home of the routed
 * conversation (its own location while its root is unknown), otherwise the
 * current host location. */
export function routeAtLocation(context: Plugin.Context, location: ReviewLocation): boolean {
  const route = context.ui.router.current()
  if (route.type !== "session") return sameLocation(hostLocation(context), location)
  const root = conversationRoot(route.sessionID, id => context.data.session.get(id))
  return sessionAtLocation(context, root ?? route.sessionID, location)
}
