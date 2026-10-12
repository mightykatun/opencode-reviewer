/** One painted hit-grid handoff. Only the production HistoryView mounts owners. */
export class HistoryCover {
  private owner?: { session: string; owns: (hit: number) => boolean; frame?: () => void }
  private painted?: { session: string; hits: readonly [number, number] }
  mount(session: string, owns: (hit: number) => boolean, frame?: () => void) {
    const owner = { session, owns, frame }
    this.owner = owner
    return () => { if (this.owner === owner) this.owner = undefined }
  }
  covers(session: string, hits: readonly [number, number]): boolean {
    if (this.owner?.session === session && hits.every(this.owner.owns)) {
      this.painted = { session, hits }
      return true
    }
    // Closing or replacing children can precede the next hit-grid paint. Retain
    // only the exact previously proven hits, never a generic logical-open bypass.
    return this.painted?.session === session && hits.every((hit, i) => hit === this.painted!.hits[i])
  }
  frame() { this.painted = undefined }
  /** Called only by the persistent native FRAME listener, before live proof.
   * Visibility/resize expiry must use frame(), without granting new paint. */
  beginFrame() { this.frame(); this.owner?.frame?.() }
}
