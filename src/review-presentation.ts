import { createEffect, createMemo, untrack } from "solid-js"

/** Pending is a revoked paint proof, never permission to dispatch or a new delay. */
export type PresentationState = "visible" | "pending" | "lost"
export type ReviewPresentation = { state: "visible" | "pending"; id: string } | { state: "lost" }
export type PresentationCheck = "eligibility" | "timer" | "verification"

export interface PresentationOwnership { session?: string; owner?: symbol; state: PresentationState }

/** Only route/sidebar ownership changes are observations here. Review publications
 * can temporarily replace hit owners before paint, and must never turn into hide
 * observations via either the getter's or the controller's reactive reads. FRAME
 * and the synchronous write boundary independently recheck the current proof. */
export function observePresentationOwnership(ownership: () => PresentationOwnership,
  presentation: () => ReviewPresentation, presented: (proof: ReviewPresentation) => void) {
  const current = createMemo(ownership, undefined, { equals: (a, b) =>
    a.session === b.session && a.owner === b.owner && a.state === b.state })
  createEffect(() => {
    current()
    untrack(() => presented(presentation()))
  })
}

/** Observe only public sidebar slot ownership. The pinned host replaces owners at
 * width > 120. Its private explicit-open flag is deliberately not inferred from
 * KV: both auto and explicit-open use "auto". A missing replacement is proved at
 * the next real frame, while ordinary hide/navigation cleanup is immediate. */
export class SidebarPresentation {
  private owner?: { session: string; token: symbol; wide: boolean }
  private handoff?: { session: string }
  mount(session: string, width: number) {
    const token = Symbol()
    this.owner = { session, token, wide: width > 120 }
    this.handoff = undefined
    return token
  }
  unmount(token: symbol, session: string | undefined, width: number, hidden: boolean) {
    const owner = this.owner
    if (!owner || owner.token !== token) return
    this.owner = undefined
    this.handoff = !hidden && owner.session === session && owner.wide !== (width > 120) ? { session } : undefined
  }
  state(session: string): PresentationState {
    return this.owner?.session === session ? "visible" : this.handoff?.session === session ? "pending" : "lost"
  }
  frame() { this.handoff = undefined }
}
