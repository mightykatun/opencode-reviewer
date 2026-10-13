import type { HostRequest } from "./host-types.js"
import { uiText } from "./ui-text.js"
import type { RequestIdentity, View } from "./controller.js"
import type { NotificationConfig } from "./notification-config.js"
import { notificationClock, notificationText, type NotificationBackend, type NotificationClock,
  type NotificationHandle, type NotificationKind, type NotificationMessage, type NotificationInteraction } from "./notification-types.js"
import { withDeadline } from "./deadline.js"
import type { HistoryTarget } from "./history-records.js"
import { actionable, NotificationQueue } from "./notification-queue.js"

interface Target { root: string; sessionID: string; title: string }
interface Banner {
  abort: AbortController; handle?: NotificationHandle; target: Target; expire?: () => void
  root: string; attention: boolean; message: NotificationMessage; attempted?: () => void
  current?: () => boolean
}
interface Pending {
  identity: NotificationInteraction
  target: Target
  phase: "waiting" | "attention"
  banner?: Banner
  message?: NotificationMessage
  blocking?: boolean
  reminder?: () => void
  /** Initial permission attempts survive queue loss; undispatched work does not. */
  announced?: Set<"attention" | "unsafe">
}

/** Absence of a countdown is not evidence of manual-only approval. A completed
 * Safe request can still be waiting for its native queue position or conversation. */
function permissionAttention(view: View<RequestIdentity>, auto: boolean): "attention" | "unsafe" | undefined {
  if (view.status === "identifying" || view.status === "analyzing") return
  const state = view.autoApproval?.status
  if (state === "countdown" || state === "waiting" || state === "checking" || state === "allowing") return
  if (state === "failed" && !view.approvalPendingConfirmed) return
  if (view.status === "complete") {
    if (!view.assessment) return
    if (!view.assessment.safe) return "unsafe"
    if (!auto || state === "cancelled" || state === "failed") return "attention"
    return
  }
  // These are terminal no-report states, not an evaluation in progress.
  if (["unrelated", "unidentified", "unavailable", "suspended"].includes(view.status)) return "attention"
}

/** Event policy owns no host reads, desktop processes, permission writes or models. */
export class NotificationPolicy<R extends RequestIdentity = HostRequest> {
  private permissions = new Map<string, Pending>()
  private questions = new Map<string, Pending>()
  private seen = new Set<string>()
  private views = new Map<string, View<R>>()
  private blockers = new Map<string, NotificationInteraction>()
  private banners = new Set<Banner>()
  private active = new Set<Banner>()
  private queue = new NotificationQueue<Banner>(256, 128)
  private draining = false
  private stopped = false
  private lastApprovalSound = -Infinity
  constructor(private config: NotificationConfig, private auto: boolean,
    private backend: NotificationBackend, private clock: NotificationClock = notificationClock) {}

  private remember(key: string) {
    if (this.seen.has(key)) return false
    if (this.seen.size >= 4096) this.seen.delete(this.seen.values().next().value!)
    this.seen.add(key)
    return true
  }
  permission(request: R, target: Target, fresh: boolean) {
    if (this.stopped || !this.config.notify || !this.remember(`permission:${request.id}`) || !fresh) return
    if (this.permissions.size >= 1024) return
    const entry: Pending = { identity: { kind: "permission", id: request.id }, target, phase: "waiting" }
    this.permissions.set(request.id, entry)
    this.select(entry)
  }
  question(id: string, target: Target, fresh: boolean) {
    if (this.stopped || !this.config.notify || !this.remember(`question:${id}`) || !fresh) return
    if (this.questions.size >= 1024) return
    const entry: Pending = { identity: { kind: "question", id }, target, phase: "waiting" }
    this.questions.set(id, entry)
    this.select(entry)
  }
  /** Native queue identity, independent of route visibility and notification eligibility. */
  pending(blockers: ReadonlyMap<string, NotificationInteraction>) {
    if (this.stopped) return
    this.blockers = new Map(blockers)
    for (const entry of this.permissions.values()) this.select(entry)
    for (const entry of this.questions.values()) this.select(entry)
  }
  private select(entry: Pending) {
    const next = this.blockers.get(entry.target.root)
    const blocking = next?.kind === entry.identity.kind && next.id === entry.identity.id
    entry.blocking = blocking
    if (entry.identity.kind === "permission") {
      // Re-evaluate the latest outcome even on queue-only publications. Never
      // replay an assessment captured when this request first became pending.
      const view = this.views.get(entry.identity.id)
      if (view) this.update(view)
      else this.wait(entry)
      return
    }
    // Questions use the same gate for initial delivery and reminders. Withdrawing
    // also aborts audio preparation or deferred delivery after queue preemption.
    if (blocking) this.attention(entry, "question")
    else this.wait(entry)
  }
  private stopReminder(entry: Pending) { entry.reminder?.(); entry.reminder = undefined }
  private remind(entry: Pending) {
    const message = entry.message
    if (!entry.blocking || entry.phase !== "attention" || !message || !this.config.staleReminderSeconds || this.stopped) return
    let stopped = false, cancel: (() => void) | undefined
    // Seconds remain representable even for MAX_SAFE_INTEGER. Chunk long waits
    // below Node/Bun's signed 32-bit timer limit instead of overflowing to 1 ms.
    let remaining = this.config.staleReminderSeconds, at = this.clock.now()
    const schedule = () => { cancel = this.clock.after(Math.min(remaining * 1000, 2147483647), tick) }
    const tick = () => {
      if (stopped || this.stopped || !entry.blocking || entry.message !== message || entry.phase !== "attention") return
      const now = this.clock.now()
      remaining -= Math.max(0, now - at) / 1000; at = now
      if (remaining > 0) { schedule(); return }
      this.withdraw(entry.banner)
      entry.reminder = undefined
      entry.banner = this.dispatch({ ...message, title: uiText.notifications.reminder(message.title) }, entry.target,
        () => { if (entry.message === message) this.remind(entry) })
    }
    entry.reminder = () => { stopped = true; cancel?.() }
    schedule()
  }
  private withdraw(banner?: Banner) {
    if (!banner) return
    banner.expire?.()
    banner.abort.abort()
    if (banner.handle) { try { void Promise.resolve(banner.handle.close()).catch(() => {}) } catch {} }
    if (!this.active.has(banner)) this.release(banner)
    else if (banner.handle && !banner.handle.closed) this.release(banner)
  }
  private show(kind: NotificationKind, title: string, target: Target, history?: HistoryTarget): Banner | undefined {
    const message = this.message(kind, title, target)
    return message ? this.dispatch(history ? { ...message, history: { ...history } } : message, target) : undefined
  }
  private message(kind: NotificationKind, title: string, target: Target): NotificationMessage | undefined {
    if (this.stopped || !this.config.notify) return
    const controls = this.config.notifications[kind]
    let sound = this.config.notifySound && controls.sound
    if (kind === "approved" && sound) {
      sound = this.clock.now() - this.lastApprovalSound >= 2000
      if (sound) this.lastApprovalSound = this.clock.now()
    }
    if (!controls.banner && !sound) return
    return { kind, title, body: notificationText(target.title), sessionID: target.sessionID, banner: controls.banner, sound }
  }
  private dispatch(message: NotificationMessage, target: Target, attempted?: () => void, current?: () => boolean): Banner | undefined {
    if (this.stopped) return
    const banner: Banner = { abort: new AbortController(), target, root: target.root, attention: actionable(message.kind), message, attempted, current }
    // Routine overflow is an explicit terminal drop. Actionable intents have one
    // current episode per tracked root, independent of the 64 active tickets.
    if (!this.queue.add(banner)) return
    this.banners.add(banner)
    this.drain()
    return banner
  }
  private release(banner: Banner) {
    banner.expire?.(); this.queue.remove(banner); this.active.delete(banner); this.banners.delete(banner); this.drain()
  }
  private drain() {
    if (this.stopped || this.draining) return
    this.draining = true
    queueMicrotask(() => {
      this.draining = false
      if (this.stopped) return
      let banner: Banner | undefined
      while (this.active.size < 64 && (banner = this.queue.take(value => value.attention || [...this.active].filter(v => !v.attention).length < 48))) {
        this.active.add(banner); void this.deliver(banner)
      }
    })
  }
  private async deliver(banner: Banner) {
    let attempted = false
    const attempt = () => {
      if (attempted || this.stopped || banner.abort.signal.aborted) return
      attempted = true
      banner.current = undefined // Delivered turns are never replayed or retracted by later activity.
      banner.expire = this.clock.after(120000, () => this.withdraw(banner))
      banner.attempted?.()
    }
    try {
      if (banner.abort.signal.aborted || this.stopped) { this.release(banner); return }
      if (banner.current && !banner.current()) { this.withdraw(banner); return }
      const handle = await this.backend.show(banner.message, banner.abort.signal)
      banner.handle = handle
      if (banner.abort.signal.aborted || this.stopped) this.withdraw(banner)
      if (handle?.dispatched) void handle.dispatched.then(attempt, attempt)
      else attempt()
      if (handle?.closed) await handle.closed
      else if (handle && !banner.abort.signal.aborted) return // embedding owns close/expiry
    } catch { attempt(); this.withdraw(banner) }
    this.release(banner)
  }
  private attention(entry: Pending, kind: "attention" | "unsafe" | "question" = "attention") {
    if (entry.phase === "attention" && entry.message?.kind === kind) return
    this.stopReminder(entry)
    this.withdraw(entry.banner)
    entry.phase = "attention"
    entry.message = this.message(kind, uiText.notifications[kind], entry.target)
    const message = entry.message
    if (entry.identity.kind === "permission" && kind !== "question" && entry.announced?.has(kind)) {
      entry.banner = undefined
      // Re-entry is not a new initial alert. Reminders restart from a full
      // interval, and only while this permission actually owns the queue.
      this.remind(entry)
      return
    }
    entry.banner = message ? this.dispatch(message, entry.target, () => {
      if (entry.message !== message) return
      if (entry.identity.kind === "permission" && kind !== "question") (entry.announced ??= new Set()).add(kind)
      this.remind(entry)
    }) : undefined
  }
  private wait(entry: Pending) {
    this.stopReminder(entry)
    this.withdraw(entry.banner)
    entry.banner = undefined; entry.message = undefined; entry.phase = "waiting"
  }
  snapshot(views: readonly View<R>[], blockers: ReadonlyMap<string, NotificationInteraction> = this.blockers, healthy = true) {
    if (this.stopped) return
    // Completion may still be preparing audio or waiting for backend capacity.
    // New activity must abort that work before its banner/sound is dispatched.
    for (const banner of this.banners) if (banner.current && !banner.current()) this.withdraw(banner)
    // Queue identity and outcomes must change together. Otherwise handing off
    // the queue could briefly notify from an older completed/manual snapshot.
    this.views = new Map(views.map((view) => [view.request.id, view]))
    this.blockers = new Map(blockers)
    for (const [id, entry] of this.permissions) {
      if (this.views.has(id)) this.select(entry)
      else if (healthy) this.resolved("permission", id)
      else this.wait(entry) // Incomplete snapshots cannot retire fresh eligibility.
    }
    for (const entry of this.questions.values()) this.select(entry)
  }
  private update(view: View<R>) {
    const entry = this.permissions.get(view.request.id)
    if (!entry) return
    const kind = entry.blocking ? permissionAttention(view, this.auto) : undefined
    if (kind) this.attention(entry, kind)
    else this.wait(entry)
  }
  approved(request: R, target?: Target) {
    if (!this.remember(`approved:${request.id}`)) return
    const current = this.permissions.get(request.id)
    if (current || target) this.show("approved", uiText.notifications.approved, current?.target ?? target!,
      { session: request.sessionID, permission: request.id })
  }
  resolved(kind: "permission" | "question", id: string) {
    const entries = kind === "permission" ? this.permissions : this.questions
    const entry = entries.get(id)
    if (entry) this.stopReminder(entry)
    this.withdraw(entry?.banner)
    entries.delete(id)
    this.remember(`${kind}:${id}`)
  }
  turn(kind: "error" | "ended", id: string, target: Target, current?: () => boolean) {
    const key = `turn:${target.root}:${id}`
    if (!this.remember(key)) return
    const message = this.message(kind, uiText.notifications[kind], target)
    if (message) this.dispatch(message, target, undefined, current ? () => {
      if (current()) return true
      this.seen.delete(key) // Undispatched completion may be observed again once idle.
      return false
    } : undefined)
  }
  deleted(sessionID: string) {
    for (const banner of this.banners) if (banner.target.root === sessionID || banner.target.sessionID === sessionID
      || banner.message.history?.session === sessionID) this.withdraw(banner)
    for (const [id, entry] of this.permissions) if (entry.target.root === sessionID || entry.target.sessionID === sessionID) this.resolved("permission", id)
    for (const [id, entry] of this.questions) if (entry.target.root === sessionID || entry.target.sessionID === sessionID) this.resolved("question", id)
  }
  dispose() {
    this.stopped = true
    for (const entry of [...this.permissions.values(), ...this.questions.values()]) this.stopReminder(entry)
    for (const banner of this.banners) this.withdraw(banner)
    this.permissions.clear(); this.questions.clear(); this.views.clear(); this.seen.clear(); this.blockers.clear()
    return withDeadline(new AbortController().signal, 5000, async () => { await this.backend.dispose() }).catch(() => {})
  }
}
