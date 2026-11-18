import type { RGBA } from "@opentui/core"
import type { HostRequest } from "./host-types.js"
import { conversationRoot, type SessionLocation } from "./route-approval.js"

export interface NativeDecisionNode {
  id: string
  visible: boolean
  isDestroyed: boolean
  backgroundColor?: RGBA
  getChildren(): NativeDecisionNode[]
}

/** Stock native permission choices publish their selection through public Box
 * colors, not the public dialog mode. Inspect only their fixed renderable IDs,
 * never native component state, text, private imports or keyboard interception.
 * Missing/ambiguous choice styling and bounded traversal failures wait closed. */
export function nativeDecisionPending(tree: NativeDecisionNode, selected: RGBA): boolean {
  let remaining = 8192
  const visit = (node: NativeDecisionNode): boolean => {
    if (--remaining < 0) return true
    if (!node.visible || node.isDestroyed) return false
    if (node.id === "session.permission.reject") return true
    if (node.id === "session.permission.actions") {
      const children = node.getChildren()
      if (children.length < 2 || children.length > 3) return true
      const choices = children.filter(child => child.visible && !child.isDestroyed)
      const ids = choices.map(child => child.id)
      if (choices.length !== children.length || new Set(ids).size !== ids.length
        || !ids.includes("session.permission.action.reject")
        || ids.some(id => !["session.permission.action.once", "session.permission.action.always", "session.permission.action.reject"].includes(id))) return true
      const once = choices.find(child => child.id === "session.permission.action.once")
      // A partially mounted or indistinguishable choice cannot prove no human
      // decision is in progress. Default once selection does not block review.
      if (!once?.backgroundColor || !once.backgroundColor.equals(selected)) return true
      return choices.some(child => child.id !== once.id && (!child.backgroundColor || child.backgroundColor.equals(selected)))
    }
    return node.getChildren().some(visit)
  }
  try { return visit(tree) } catch { return true }
}

/** A proven open conversation tab is independent of the active route. Native
 * decision controls belong only to the routed conversation, never another tab. */
export function hostApprovalReady(request: Pick<HostRequest, "sessionID">, root: string | undefined,
  route: { type: string; sessionID?: string }, session: (id: string) => SessionLocation | undefined,
  decisionPending: () => boolean, tabs: readonly { sessionID: string; active: boolean }[] = []): boolean {
  if (!root || conversationRoot(request.sessionID, session) !== root) return false
  const active = route.type === "session" ? conversationRoot(route.sessionID, session) : undefined
  if (active === root) return !decisionPending()
  return tabs.some(tab => conversationRoot(tab.sessionID, session) === root)
}
