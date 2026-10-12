import type { HostRequest } from "./host-types.js"
import { conversationRoot, type SessionLocation } from "./route-approval.js"

export interface HostQueueReader {
  session(id: string): SessionLocation | undefined
  family(root: string): readonly string[]
  permissions(id: string): readonly Pick<HostRequest, "id" | "sessionID">[] | undefined
}

/** Exactly stock V2's root-first family order, including disabled and deep calls.
 * Missing/conflicting ancestry or an unreadable earlier cache cannot yield ownership. */
export function hostQueueFront(root: string, reader: HostQueueReader): Pick<HostRequest, "id" | "sessionID"> | undefined {
  if (conversationRoot(root, reader.session) !== root) return
  const ids = [root, ...reader.family(root).filter(id => id !== root)]
  if (ids.length > 16384 || new Set(ids).size !== ids.length) return
  for (const id of ids) {
    if (conversationRoot(id, reader.session) !== root) return
    const requests = reader.permissions(id)
    if (!requests) return
    if (requests.length) {
      const first = requests[0]
      return first?.sessionID === id ? first : undefined
    }
  }
}
