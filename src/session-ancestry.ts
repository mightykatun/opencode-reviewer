import { reviewStage, withDeadline } from "./deadline.js"

type SessionLocation = { directory: string; workspaceID?: string }
type Session = { id: string; parentID?: string; location?: SessionLocation }
const MAX_ANCESTRY_READS = 2
/** Caller completion is deadline bounded. settled owns the actual metadata
 * traversal through cleanup; forwarding functions must preserve this handle. */
export type AncestryRead = Promise<string> & { settled?: Promise<void> }
export type AncestryReader = (session: string, signal: AbortSignal) => AncestryRead
interface Ancestry { root: string; visited: Set<string>; edges: number; location?: SessionLocation }

/** Bounded metadata traversal independent of saved review modes. Sessions are
 * addressed by ID, so a parent may live in another location. The getter owns
 * host scope policy. Its promise must include actual read cleanup. */
export class SessionAncestry {
  private roots = new Map<string, { root: string; edges: number }>()
  /** Each resolved root's location, from the same read that proved it a root. */
  private homes = new Map<string, SessionLocation>()
  private ancestry = new Map<string, AncestryRead>()
  private ancestryRevision = 0
  constructor(private session: (id: string, signal: AbortSignal) => Promise<Session | undefined>) {}
  private remember(visited: ReadonlySet<string>, root: string, edges: number, location?: SessionLocation) {
    if (this.roots.size + visited.size > 4096) { this.roots.clear(); this.homes.clear() }
    for (const child of visited) this.roots.set(child, { root, edges: edges-- })
    if (location) this.homes.set(root, location)
    return root
  }
  /** The location a resolved root was read at, while its ancestry stays cached. */
  location(root: string): SessionLocation | undefined {
    return this.roots.get(root)?.root === root ? this.homes.get(root) : undefined
  }
  root(sessionID: string, parent: AbortSignal): AncestryRead {
    if (parent.aborted) return Promise.reject(parent.reason)
    const cached = this.roots.get(sessionID)
    if (cached) return withDeadline(parent, 5000, async () => {
      if (this.roots.get(sessionID) !== cached) throw new Error("Session ancestry changed")
      return cached.root
    }, "Session ancestry")
    const pending = this.ancestry.get(sessionID)
    if (pending) {
      // A joiner's cancellation only ends its own wait, never the owner's read.
      return Object.assign(withDeadline(parent, 5000, () => pending, "Session ancestry"), { settled: pending.settled })
    }
    if (this.ancestry.size >= MAX_ANCESTRY_READS) return Promise.reject(new Error("Session ancestry read capacity unavailable"))
    const revision = this.ancestryRevision
    let worker: Promise<Ancestry> | undefined
    let finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    const release = () => {
      if (this.ancestry.get(sessionID) === read) this.ancestry.delete(sessionID)
      finish()
    }
    const read: AncestryRead = withDeadline(parent, 5000, signal => {
      worker = this.resolveRoot(sessionID, signal, revision)
      void worker.then(release, release)
      return worker
    }, "Session ancestry").then(value => {
      reviewStage(parent, "Session ancestry")
      if (revision !== this.ancestryRevision) throw new Error("Session ancestry changed")
      return this.remember(value.visited, value.root, value.edges, value.location)
    })
    this.ancestry.set(sessionID, read)
    read.settled = settled
    const undispatched = () => { if (!worker) release() }
    void read.then(undispatched, undispatched)
    return read
  }
  private async resolveRoot(sessionID: string, signal: AbortSignal, revision: number): Promise<Ancestry> {
    const current = () => {
      reviewStage(signal, "Session ancestry")
      if (revision !== this.ancestryRevision) throw new Error("Session ancestry changed")
    }
    const visited = new Set<string>()
    let id = sessionID
    for (let depth = 0; depth <= 16; depth++) {
      current()
      if (!id || visited.has(id)) throw new Error("Session ancestry unavailable")
      const cached = this.roots.get(id)
      if (cached) {
        // A cached suffix saves metadata reads, not parent edges in the limit.
        if (depth + cached.edges > 16) throw new Error("Session ancestry limit reached")
        return { visited, root: cached.root, edges: depth + cached.edges, location: this.homes.get(cached.root) }
      }
      visited.add(id)
      const value = await this.session(id, signal)
      current()
      if (value?.id !== id || (value.parentID !== undefined && (typeof value.parentID !== "string" || !value.parentID))) {
        throw new Error("Session ancestry unavailable")
      }
      if (!value.parentID) return { visited, root: id, edges: depth, location: value.location }
      id = value.parentID
    }
    throw new Error("Session ancestry limit reached")
  }
  deleted(_id: string) {
    this.ancestryRevision++
    // Cached distances do not retain every intermediate edge. An intermediate
    // deletion therefore invalidates all bounded suffixes, not just root matches.
    // A move reaches here too, because it changes a cached root's location.
    this.roots.clear()
    this.homes.clear()
  }
}
