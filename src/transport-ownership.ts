/** Physical operations outlive abortable waits. Keep their admission lease until
 * settlement, including cleanup started by a late response. */
export class TransportOwnership {
  private pending = new Set<Promise<unknown>>()

  constructor(private parent?: TransportOwnership) {}

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    this.parent?.track(operation)
    const release = () => { this.pending.delete(operation) }
    void operation.then(release, release)
    return operation
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}

// Carry ownership through ordinary async evaluator wrappers without relying on
// custom properties surviving promise assimilation. The bounded review signal is
// the shared scope for evidence collection and transport.
const scopes = new WeakMap<AbortSignal, TransportOwnership>()
export function bindTransportOwnership(signal: AbortSignal, scope: TransportOwnership): void { scopes.set(signal, scope) }
export function transportOwnership(signal: AbortSignal): TransportOwnership | undefined { return scopes.get(signal) }
