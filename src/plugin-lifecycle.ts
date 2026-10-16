type Cleanup = () => void | Promise<void>

/** Reviewer-owned resources for public plugin setup and unload. */
export class PluginLifecycle {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly cleanups: { run: Cleanup; critical: boolean }[] = []
  private readonly pending = new Set<Promise<void>>()
  private readonly critical = new Set<Promise<void>>()
  private startup?: Promise<void>
  private stopping?: Promise<void>
  private disposing = false

  /** Register as soon as a resource is acquired, including after an awaited call. */
  addCleanup(cleanup: Cleanup, critical = true): void {
    if (this.disposing) this.dispose(cleanup, critical)
    else this.cleanups.push({ run: cleanup, critical })
  }

  /** Own setup through actual settlement; a failure also disposes partial setup. */
  start(setup: () => void | Promise<void>): Promise<void> {
    if (this.startup) return this.startup
    const work = Promise.resolve().then(() => {
      this.signal.throwIfAborted()
      return setup()
    })
    this.track(work)
    this.startup = work.catch(async error => {
      await this.stop()
      throw error
    })
    // Keep the original rejection available to setup's caller, even if it detaches.
    void this.startup.catch(() => {})
    return this.startup
  }

  /** Abort first, invoke disposals in reverse order, then drain for at most 3.5 s.
   * Returning only ends the caller's wait. Use settled() for physical completion.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const end = performance.now() + 3500
    let done!: () => void
    this.stopping = new Promise<void>(resolve => { done = resolve })
    // Publish stopping before abort: listeners and disposals may reenter stop().
    this.controller.abort()
    this.disposing = true
    let cleanup: { run: Cleanup; critical: boolean } | undefined
    while ((cleanup = this.cleanups.pop())) this.dispose(cleanup.run, cleanup.critical)
    void this.drain(end).then(done, done)
    return this.stopping
  }

  /** Wait for all currently owned work, including cleanups acquired by late setup.
   * There is no timeout and rejected work still counts as settled.
   */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  /** Recovery fences writes, mandatory native-cache reads and mode writes first.
   * Optional observers remain owned by settled(), but cannot block a new reviewer. */
  async criticalSettled(): Promise<void> {
    while (this.critical.size) await Promise.allSettled([...this.critical])
  }

  private track(work: Promise<void>, critical = true): void {
    this.pending.add(work)
    if (critical) this.critical.add(work)
    const release = () => { this.pending.delete(work); this.critical.delete(work) }
    void work.then(release, release)
  }

  private dispose(cleanup: Cleanup, critical = true): void {
    try { this.track(Promise.resolve(cleanup()), critical) }
    catch { /* One failed disposal must not strand other resources. */ }
  }

  private async drain(end: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.settled(), new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.max(0, end - performance.now()))
      })])
    } finally { clearTimeout(timer) }
  }
}
