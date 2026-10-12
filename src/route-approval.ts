import type { ReviewPresentation } from "./review-presentation.js"

export type SessionLocation = { id: string; parentID?: string }
export type ApprovalPresentation = ReviewPresentation | { state: "route-hidden"; id: string; root: string }
export type ApprovalPresentationState = ApprovalPresentation["state"]

/** The native route cache may omit newly created descendants until first visit.
 * Public session events provide exact edges during that gap, never guessed roots.
 * Conflicting snapshots and deletion tombstones remain unavailable. */
export class RouteSessions {
  private events = new Map<string, SessionLocation | null>()
  constructor(private current: (id: string) => SessionLocation | undefined) {}
  get(id: string): SessionLocation | undefined {
    const event = this.events.get(id), current = this.current(id)
    if (event === null || (current && current.id !== id)) return
    if (event && current && event.parentID !== current.parentID) return
    return current ?? event
  }
  remember(value: SessionLocation) {
    const old = this.events.get(value.id)
    if (old === null || (old && old.parentID === value.parentID)) return false
    this.set(value.id, { id: value.id, ...(value.parentID === undefined ? {} : { parentID: value.parentID }) })
    return true
  }
  deleted(id: string) { this.set(id, null) }
  private set(id: string, value: SessionLocation | null) {
    this.events.delete(id)
    this.events.set(id, value)
    if (this.events.size > 4096) this.events.delete(this.events.keys().next().value!)
  }
}

/** Fresh public metadata only. Match the conversation mode's 16-edge bound. */
export function conversationRoot(id: string | undefined, session: (id: string) => SessionLocation | undefined): string | undefined {
  const visited = new Set<string>()
  for (let depth = 0; id && depth <= 16; depth++) {
    if (visited.has(id)) return
    visited.add(id)
    const value = session(id)
    if (value?.id !== id) return
    if (value.parentID === undefined) return id
    if (typeof value.parentID !== "string" || !value.parentID) return
    id = value.parentID
  }
}

/** Returning to the root can precede its native sidebar mount in the same turn.
 * This revokes dispatch until actual paint; it never grants hidden approval there. */
export class RouteHandoff {
  private session?: string
  private root?: string
  private returning?: string
  observe(session: string | undefined, root: string | undefined) {
    if (this.session === session && this.root === root) return
    this.returning = root && session === root && this.root === root && this.session !== root ? root : undefined
    this.session = session
    this.root = root
  }
  pending(root: string) { return this.returning === root }
  frame() { this.returning = undefined }
}

export interface RouteRegion {
  x: number; y: number; width: number; height: number; visible: boolean; isDestroyed: boolean
  getChildren(): RouteRegion[]
}

/** Native permission fullscreen is not a public dialog. Its expanded surface
 * escapes the bottom permission container and covers the viewport interior.
 * Inspect public layout, without native imports, labels, or an invisible panel.
 * Ordinary full-height route ancestors do not escape their parent bounds. */
export function routeCovered(root: RouteRegion, width: number, height: number): boolean {
  let remaining = 8192
  const visit = (node: RouteRegion, parent?: RouteRegion): boolean => {
    if (--remaining < 0) return true
    if (!node.visible || node.isDestroyed) return false
    if (parent && node.x <= 2 && node.y <= 1 && node.x + node.width >= width - 2
      && node.y + node.height >= height - 2 && (node.y < parent.y || node.y + node.height > parent.y + parent.height)) return true
    return node.getChildren().some(child => visit(child, node))
  }
  return width < 5 || height < 4 || visit(root)
}
