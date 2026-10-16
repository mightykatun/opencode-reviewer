import { hostFamilyIDs, nativeObservationLimit } from "./host-queue.js"
import { conversationRoot, type SessionLocation } from "./route-approval.js"
import type { AncestryReader } from "./session-ancestry.js"

export interface NativeFamilyReader {
  resolveRoot: AncestryReader
  session(id: string): SessionLocation | undefined
  family(root: string): readonly string[] | undefined
  sync(id: string): Promise<void>
  owned<T>(work: Promise<T>): Promise<T>
}

/** Metadata only. Permission and optional-form callers retain separate refresh
 * transactions, budgets and health, including ownership of their actual I/O. */
export async function refreshNativeFamily(seeds: Iterable<string>, reader: NativeFamilyReader,
  signal: AbortSignal): Promise<readonly string[]> {
  const { owned } = reader
  signal.throwIfAborted()
  const unique = new Set<string>()
  for (const id of seeds) {
    if (typeof id !== "string" || !id) throw Error("Native seeds unavailable")
    unique.add(id)
    if (unique.size > nativeObservationLimit) throw Error("Native seeds unavailable")
  }
  const roots = new Set<string>(), seedRoots = new Map<string, string>()
  for (const id of unique) {
    signal.throwIfAborted()
    const read = reader.resolveRoot(id, signal)
    // The owned transaction includes cleanup even when the logical read rejects
    // or its caller aborts. Promise assimilation must not discard this lease.
    const root = await owned((async () => {
      try {
        const root = await read
        signal.throwIfAborted()
        return root
      } finally { await read.settled?.catch(() => {}) }
    })())
    signal.throwIfAborted()
    if (typeof root !== "string" || !root) throw Error("Native ancestry unavailable")
    roots.add(root)
    seedRoots.set(id, root)
    if (roots.size > nativeObservationLimit) throw Error("Native ancestry unavailable")
  }
  for (const root of roots) {
    signal.throwIfAborted()
    await owned(reader.sync(root))
    signal.throwIfAborted()
    if (conversationRoot(root, id => reader.session(id)) !== root) throw Error("Native root scope unavailable")
  }
  // Fresh pending HTTP sessions may not have native parent edges yet. Refresh
  // their metadata before asking the native cache for its public family roster.
  for (const id of unique) {
    signal.throwIfAborted()
    if (!roots.has(id)) await owned(reader.sync(id))
    signal.throwIfAborted()
  }
  const families = new Map<string, readonly string[]>(), members = new Set<string>()
  for (const root of roots) {
    signal.throwIfAborted()
    const family = hostFamilyIDs(root, reader.family(root))
    if (!family) throw Error("Native family unavailable")
    families.set(root, family)
    for (const id of family) {
      members.add(id)
      if (members.size > nativeObservationLimit) throw Error("Native family unavailable")
    }
  }
  // Seeds remain refresh targets even if their native roster has not caught up.
  // This set is cache coverage, never inferred native queue ownership or order.
  for (const id of unique) {
    members.add(id)
    if (members.size > nativeObservationLimit) throw Error("Native family unavailable")
  }
  // Deep members may precede their parents in the exact public family order.
  for (const id of members) {
    signal.throwIfAborted()
    if (!roots.has(id) && !unique.has(id)) await owned(reader.sync(id))
    signal.throwIfAborted()
  }
  for (const [root, family] of families) {
    for (const id of family) {
      signal.throwIfAborted()
      if (conversationRoot(id, value => reader.session(value)) !== root) throw Error("Native family scope unavailable")
    }
  }
  for (const [id, root] of seedRoots) {
    signal.throwIfAborted()
    if (conversationRoot(id, value => reader.session(value)) !== root) throw Error("Native seed scope unavailable")
  }
  return [...members]
}

/** Settled failures belong to their own conversation, not every pending request
 * at this location. Each successful group still passes the complete strict family
 * refresh above. Abort/deadline failures always escape; physical reads stay owned. */
export async function refreshNativeFamilies(seeds: Iterable<string>, reader: NativeFamilyReader,
  signal: AbortSignal, refresh: (id: string) => Promise<void>): Promise<ReadonlySet<string>> {
  const unique = new Set<string>(), groups = new Map<string, Set<string>>()
  for (const id of seeds) {
    if (typeof id !== "string" || !id) throw Error("Native seeds unavailable")
    unique.add(id)
    if (unique.size > nativeObservationLimit) throw Error("Native seeds unavailable")
  }
  for (const id of unique) {
    signal.throwIfAborted()
    try {
      const read = reader.resolveRoot(id, signal)
      const root = await reader.owned((async () => {
        try { return await read } finally { await read.settled?.catch(() => {}) }
      })())
      signal.throwIfAborted()
      if (typeof root !== "string" || !root) continue
      const group = groups.get(root) ?? new Set<string>()
      group.add(id); groups.set(root, group)
    } catch { signal.throwIfAborted() }
  }
  const healthy = new Set<string>(), observed = new Set<string>()
  for (const [root, group] of groups) {
    signal.throwIfAborted()
    try {
      const members = await refreshNativeFamily(group, reader, signal)
      if (members.some(id => conversationRoot(id, value => reader.session(value)) !== root))
        throw Error("Native family scope changed")
      for (const id of members) {
        observed.add(id)
        if (observed.size > nativeObservationLimit) throw Error("Native family limit reached")
        signal.throwIfAborted()
        await reader.owned(refresh(id))
      }
      signal.throwIfAborted()
      healthy.add(root)
    } catch {
      signal.throwIfAborted()
      if (observed.size > nativeObservationLimit) throw Error("Native family limit reached")
    }
  }
  return healthy
}
