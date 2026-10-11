import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { withDeadline } from "./deadline.js"

/** Per-controller bound on evidence collection and reviewer transport together. */
export const MAX_REVIEW_EVALUATORS = 4

export type ReviewEvaluation<T> = Promise<T> & { settled?: Promise<unknown> }

/** Keep the ordinary deadline-visible result separate from actual callback
 * settlement. Evidence and transport/finalizers share the same admission lease. */
export function ownedReview<T>(parent: AbortSignal, ms: number, run: (signal: AbortSignal) => Promise<T>): ReviewEvaluation<T> {
  let worker: Promise<T> | undefined, finish!: () => void
  const settled = new Promise<void>(resolve => { finish = resolve })
  const result = withDeadline(parent, ms, signal => {
    worker = Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal) })
    void worker.then(finish, finish)
    return worker
  })
  const undispatched = () => { if (!worker) finish() }
  void result.then(undispatched, undispatched)
  return Object.assign(result, { settled })
}

interface Waiting {
  request: PermissionRequest
  start(): void
}

/** Round-robin roots, native session/request code-unit order within each root.
 * Only waiting work is reordered. An abort never frees a running evaluator's
 * slot: its actual promise (including finalizers) must settle first. */
export class ReviewAdmission {
  private roots = new Map<string, Waiting[]>()
  private running = 0
  private scheduled = false
  private workers = new Set<Promise<unknown>>()

  constructor(private front: (root: string) => string | undefined = () => undefined) {}

  run<T>(request: PermissionRequest, root: string, signal: AbortSignal, evaluate: () => ReviewEvaluation<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const cancel = () => {
        const queue = this.roots.get(root)
        const index = queue?.indexOf(waiting) ?? -1
        if (index < 0) return
        queue!.splice(index, 1)
        if (!queue!.length) this.roots.delete(root)
        signal.removeEventListener("abort", cancel)
        reject(signal.reason)
      }
      const waiting: Waiting = { request, start: () => {
        signal.removeEventListener("abort", cancel)
        this.running++
        // The callback rechecks controller generation and mode at dispatch.
        // This guard also covers cancellation after reservation, before invocation.
        const worker = Promise.resolve().then(() => {
          signal.throwIfAborted()
          const evaluation = evaluate()
          void evaluation.then(resolve, reject)
          return Promise.allSettled([evaluation, evaluation.settled])
        })
        this.workers.add(worker)
        const release = () => { this.workers.delete(worker); this.running--; this.schedule() }
        void worker.then(release, error => { release(); reject(error) })
      } }
      const queue = this.roots.get(root)
      if (queue) queue.push(waiting)
      else this.roots.set(root, [waiting])
      signal.addEventListener("abort", cancel, { once: true })
      this.schedule()
    })
  }

  /** Caller must first abort waiting work. Physical finalizers still own slots. */
  async settled() { await Promise.allSettled([...this.workers]) }

  private schedule() {
    if (this.scheduled || this.running >= MAX_REVIEW_EVALUATORS || !this.roots.size) return
    this.scheduled = true
    // Batch arrivals/gate completions in this turn, never UI/cancellation facts.
    queueMicrotask(() => {
      this.scheduled = false
      while (this.running < MAX_REVIEW_EVALUATORS && this.roots.size) {
        const [root, queue] = this.roots.entries().next().value!
        const front = this.front(root)
        let first = queue.findIndex(waiting => waiting.request.id === front)
        if (first < 0) {
          first = 0
          for (let i = 1; i < queue.length; i++) {
            const a = queue[i]!.request, b = queue[first]!.request
            if (a.sessionID < b.sessionID || (a.sessionID === b.sessionID && a.id < b.id)) first = i
          }
        }
        const [waiting] = queue.splice(first, 1)
        this.roots.delete(root)
        // Move the served root behind all other waiting roots, even when one
        // root supplied the entire initial fanout. New roots join the same ring.
        if (queue.length) this.roots.set(root, queue)
        waiting!.start()
      }
    })
  }
}
