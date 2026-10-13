export type SessionLocation = { id: string; parentID?: string }

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
