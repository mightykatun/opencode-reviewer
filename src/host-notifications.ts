import type { LocationRef, OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { CliPluginState } from "./cli-plugin.js"
import type { ApprovalFact, View } from "./controller.js"
import type { HostRequest } from "./host-types.js"
import { hostPermissionIdentities, type HostQueueSnapshot } from "./host-queue.js"
import type { HistoryTarget } from "./history-records.js"
import type { AncestryRead, AncestryReader } from "./session-ancestry.js"
import { conversationRoot } from "./route-approval.js"
import { withDeadline } from "./deadline.js"
import { LinuxNotifications } from "./notification-linux.js"
import { NotificationPolicy } from "./notification-policy.js"
import { notificationClock, type NotificationClock, type NotificationClick, type NotificationClickLease,
  type NotificationInteraction } from "./notification-types.js"
import { uiText } from "./ui-text.js"

type Target = { root: string; sessionID: string; title: string }
type Birth = { sessionID: string; received: number; target?: Target }
type Execution = { id: string; seq: number; terminal?: "ended" | "error"; done?: boolean }
type ClickOwner = { sessionID: string; history?: HistoryTarget; route?: string; lease: NotificationClickLease }

export interface HostNotificationOptions {
  resolveRoot: AncestryReader
  /** Actual public native ownership, including disabled/unsupported permissions. */
  nativeQueue(root: string): HostQueueSnapshot
  signal: AbortSignal
  openHistory?(sessionID: string, target: HistoryTarget, lease: NotificationClickLease): void | Promise<void>
  clock?: NotificationClock
}

/** Scope filtering, native cache synchronization and route observation belong to
 * the runtime. This bridge subscribes to nothing and never starts a host/read poll.
 * `visit`, `event`, `snapshot` and `routeChanged` are its publication seams. */
export class HostNotifications {
  readonly policy: NotificationPolicy<HostRequest>
  private clock: NotificationClock
  private location: LocationRef
  private abort = new AbortController()
  private stopped = false
  private disposal?: Promise<void>
  private sequence = 0
  private roots = new Map<string, number>()
  private visits = new Map<string, number>()
  private ancestry = new Map<string, string>()
  private reads = new Map<string, { value: Promise<string>; settled: Promise<void> }>()
  private retryAt = new Map<string, number>()
  private permissions = new Map<string, Birth>()
  private forms = new Map<string, Birth>()
  private closed = new Set<string>()
  private deletedSessions = new Set<string>()
  private dispatches = new Map<string, { request: HostRequest; target: Target; approval?: string; automatic: boolean }>()
  private executions = new Map<string, Execution>()
  private views: readonly View<HostRequest>[] = []
  private healthy = false
  private clickOwner?: ClickOwner
  private clickWait?: () => void
  private onAbort = () => { void this.dispose() }

  constructor(private context: Plugin.Context, state: CliPluginState, private options: HostNotificationOptions) {
    const config = state.notificationConfig ?? state.config
    if (!config) throw new Error("Notification configuration unavailable")
    this.clock = options.clock ?? notificationClock
    this.location = state.companion?.location ?? context.location ?? context.data.location.default()
    const click: NotificationClick = (sessionID, target) => this.beginClick(sessionID, target).commit()
    click.begin = (sessionID, target) => this.beginClick(sessionID, target)
    const backend = state.dependencies.notifications?.(click, config)
      ?? new LinuxNotifications(config, click, state.dependencies.notificationProcesses?.())
    this.policy = new NotificationPolicy<HostRequest>(config, state.config?.autoApprove === true, backend, this.clock)
    options.signal.addEventListener("abort", this.onAbort, { once: true })
    if (options.signal.aborted) this.onAbort()
  }

  private guard(work: () => void) {
    if (this.stopped || this.options.signal.aborted) return
    try { work() } catch { /* Observers must not change review or approval. */ }
  }
  private rootOf(id: string) {
    return conversationRoot(id, value => this.context.data.session.get(value)) ?? this.ancestry.get(id)
  }
  private target(root: string): Target {
    let title: string = uiText.notifications.fallbackSession
    try { title = this.context.data.session.get(root)?.title ?? title } catch {}
    return { root, sessionID: root, title }
  }
  private remember(set: Set<string>, key: string) {
    if (set.size >= 4096) set.delete(set.values().next().value!)
    set.add(key)
  }
  private lookup(id: string) {
    const pending = this.reads.get(id)
    if (pending) return pending.value
    if (this.stopped || this.reads.size >= 2 || (this.retryAt.get(id) ?? 0) > this.clock.now()) return
    let read: AncestryRead | undefined
    let worker: Promise<string> | undefined
    const value = withDeadline(AbortSignal.any([this.abort.signal, this.options.signal]), 5000, signal => {
      worker = Promise.resolve().then(() => {
        signal.throwIfAborted()
        read = this.options.resolveRoot(id, signal)
        return read
      })
      return worker
    }).then(root => {
      if (!root || this.stopped || this.deletedSessions.has(id) || this.deletedSessions.has(root)) throw new Error("Session ancestry unavailable")
      if (this.ancestry.size < 4096) this.ancestry.set(id, root)
      return root
    })
    // A deadline only ends the caller's wait. Retain both actual transaction and
    // the reader's cleanup lease before freeing either of the two lookup slots.
    const settled = value.then(() => {}, () => {
      if (this.retryAt.size >= 4096) this.retryAt.delete(this.retryAt.keys().next().value!)
      this.retryAt.set(id, this.clock.now() + 2000)
    }).then(async () => {
      await worker?.catch(() => {})
      await read?.settled?.catch(() => {})
      if (this.reads.get(id)?.value === value) this.reads.delete(id)
      this.guard(() => this.publish())
    })
    this.reads.set(id, { value, settled })
    return value
  }

  visit(sessionID?: string) {
    this.guard(() => {
      if (!sessionID || this.deletedSessions.has(sessionID)) return
      if (!this.visits.has(sessionID) && this.visits.size >= 256) return
      // Reserve the actual first visit before attempting a read. Failure or
      // saturated physical slots must not replace it with a later retry boundary.
      const since = this.visits.get(sessionID) ?? ++this.sequence
      this.visits.set(sessionID, since)
      this.registerVisit(sessionID, since, true)
      this.publish()
    })
  }
  private registerVisit(sessionID: string, since: number, read: boolean) {
    const root = this.rootOf(sessionID)
    if (root) {
      if (this.deletedSessions.has(root) || this.track(root, since)) this.visits.delete(sessionID)
      return
    }
    // lookup owns both physical slots and failure backoff. An existing read's
    // settlement republishes, so never attach repeated callbacks while it waits.
    if (!read || this.reads.has(sessionID)) return
    const lookup = this.lookup(sessionID)
    if (lookup) void lookup.then(root => this.guard(() => {
      if (this.visits.get(sessionID) !== since) return
      if (this.track(root, since)) this.visits.delete(sessionID)
      this.publish()
    })).catch(() => {})
  }
  private track(root: string, since: number) {
    const existing = this.roots.get(root)
    if (!this.deletedSessions.has(root) && (existing !== undefined || this.roots.size < 256)) {
      // A repeated route observation can see native metadata before an earlier
      // asynchronous visit settles. Preserve the earliest actual visit boundary.
      this.roots.set(root, Math.min(existing ?? since, since))
      return true
    }
    return false
  }
  private admit(kind: "permission" | "question", id: string, birth: Birth) {
    if (birth.target || this.deletedSessions.has(birth.sessionID)) return
    const root = this.rootOf(birth.sessionID)
    if (!root) {
      const lookup = this.lookup(birth.sessionID)
      if (lookup) void lookup.then(() => this.guard(() => this.publish())).catch(() => {})
      return
    }
    const since = this.roots.get(root)
    if (since === undefined || birth.received < since || this.deletedSessions.has(root)) return
    const request = kind === "permission" ? this.views.find(view => view.request.id === id && view.request.sessionID === birth.sessionID)?.request : undefined
    if (kind === "permission" && !request) return
    birth.target = this.target(root)
    if (request) this.policy.permission(request, birth.target, true)
    else this.policy.question(id, birth.target, true)
  }

  private blocker(root: string): NotificationInteraction | undefined {
    if (!this.healthy) return
    const queue = this.options.nativeQueue(root)
    if (queue.state === "unknown") return
    if (queue.state === "front") return { kind: "permission", id: queue.request.id }
    return this.formFront(queue.family)
  }
  private formFront(family: readonly string[]): NotificationInteraction | undefined {
    // Pinned stock V2: family forms in public root-first order, then global forms.
    // Global forms block delivery but have no proven conversation notification target.
    for (const sessionID of [...family, "global"]) {
      const forms = this.context.data.session.form.list(sessionID, sessionID === "global" ? this.location : undefined)
      const values = hostPermissionIdentities(sessionID, forms)
      if (!values) throw Error("Native forms unavailable")
      if (values.length) return { kind: "question", id: values[0]!.id }
    }
  }
  private blockers() {
    const blockers = new Map<string, NotificationInteraction>()
    for (const root of this.roots.keys()) {
      try { const value = this.blocker(root); if (value) blockers.set(root, value) } catch {}
    }
    return blockers
  }
  private clearQueue(root: string) {
    if (!this.healthy) return false
    const queue = this.options.nativeQueue(root)
    return queue.state === "empty" && !this.formFront(queue.family)
  }
  private publish() {
    // Registration changes only maps, never publishes recursively. Healthy
    // publications retry unresolved visits using their original event boundary.
    for (const [sessionID, since] of this.visits) {
      try { this.registerVisit(sessionID, since, this.healthy) } catch {}
    }
    const blockers = this.blockers()
    for (const birth of [...this.permissions.values(), ...this.forms.values()]) {
      if (birth.target) birth.target.title = this.target(birth.target.root).title
    }
    this.policy.snapshot(this.views, blockers, this.healthy)
    for (const [id, birth] of this.permissions) { try { this.admit("permission", id, birth) } catch {} }
    for (const [id, birth] of this.forms) { try { this.admit("question", id, birth) } catch {} }
    this.policy.pending(blockers)
    for (const [root, execution] of this.executions) {
      try {
        if (!execution.done && execution.terminal && this.clearQueue(root)) {
          execution.done = true
          this.policy.turn(execution.terminal, execution.id, this.target(root))
        }
      } catch {}
    }
  }
  snapshot(views: readonly View<HostRequest>[], healthy?: boolean) {
    this.guard(() => {
      this.routeChanged()
      if (healthy !== undefined) this.healthy = healthy
      this.views = views.filter(view => !view.resolved && !view.retained)
      if (this.healthy) {
        const pending = new Set(this.views.map(view => view.request.id))
        for (const [id, birth] of this.permissions) if (birth.target && !pending.has(id)) this.resolve("permission", id, birth.sessionID)
      }
      this.publish()
    })
  }
  approval(fact: ApprovalFact<HostRequest>) {
    this.guard(() => {
      const id = fact.request.id
      if (fact.type === "dispatched") {
        const root = this.rootOf(fact.request.sessionID)
        if (root && this.roots.has(root) && this.dispatches.size < 1024) this.dispatches.set(id, {
          request: fact.request, target: this.target(root), approval: fact.approval, automatic: fact.automatic,
        })
      } else {
        const dispatch = this.dispatches.get(id)
        if (!dispatch || dispatch.request.sessionID !== fact.request.sessionID || dispatch.approval !== fact.approval) return
        this.dispatches.delete(id)
        if (fact.type === "confirmed" && fact.automatic && dispatch.automatic
          && !this.deletedSessions.has(fact.request.sessionID) && !this.deletedSessions.has(dispatch.target.root)) {
          // Policy delivery is microtask-queued, never process work on the write path.
          this.policy.approved(dispatch.request, this.target(dispatch.target.root))
        }
      }
    })
  }
  private resolve(kind: "permission" | "question", id: string, sessionID: string) {
    const entries = kind === "permission" ? this.permissions : this.forms
    const birth = entries.get(id)
    if (birth && birth.sessionID !== sessionID) return
    entries.delete(id)
    this.remember(this.closed, `${kind}:${id}`)
    this.policy.resolved(kind, id)
  }
  event(event: OpenCodeEvent) {
    this.guard(() => {
      if (event.type === "permission.asked" || event.type === "form.created") {
        const kind = event.type === "permission.asked" ? "permission" : "question"
        const value = event.type === "permission.asked" ? event.data : event.data.form
        const entries = kind === "permission" ? this.permissions : this.forms
        if (value.sessionID === "global" || this.deletedSessions.has(value.sessionID)
          || entries.has(value.id) || this.closed.has(`${kind}:${value.id}`) || entries.size >= 1024) return
        entries.set(value.id, { sessionID: value.sessionID, received: ++this.sequence })
      } else if (event.type === "permission.replied") this.resolve("permission", event.data.requestID, event.data.sessionID)
      else if (event.type === "form.replied" || event.type === "form.cancelled") this.resolve("question", event.data.id, event.data.sessionID)
      else if (event.type === "session.deleted") { this.deleted(event.data.sessionID); return }
      else if (event.type === "session.execution.started" || event.type === "session.execution.succeeded"
        || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
        const root = event.data.sessionID
        // Child failures may be recovered by the root. Never promote them.
        if (!this.roots.has(root) || conversationRoot(root, id => this.context.data.session.get(id)) !== root
          || event.durable.aggregateID !== root) return
        const previous = this.executions.get(root)
        if (previous && event.durable.seq <= previous.seq) return
        if (event.type === "session.execution.started") this.executions.set(root, { id: event.id, seq: event.durable.seq })
        else if (previous && !previous.done && !previous.terminal) {
          previous.seq = event.durable.seq
          if (event.type === "session.execution.interrupted" || (event.type === "session.execution.failed" && event.data.error.type === "aborted")) previous.done = true
          else previous.terminal = event.type === "session.execution.failed" ? "error" : "ended"
        }
      }
      this.publish()
    })
  }

  click(sessionID: string, history?: HistoryTarget) { this.beginClick(sessionID, history).commit() }
  beginClick(sessionID: string, history?: HistoryTarget): NotificationClickLease {
    this.clearClick()
    const abort = new AbortController()
    const owner: ClickOwner = { sessionID, history: history ? { ...history } : undefined, route: this.route(), lease: undefined! }
    let committed = false
    const lease: NotificationClickLease = {
      signal: abort.signal,
      current: () => {
        try { return !abort.signal.aborted && !this.stopped && !this.options.signal.aborted && this.clickOwner === owner
          && owner.route !== undefined && this.route() === owner.route && !this.deletedSessions.has(sessionID) && !!this.context.data.session.get(sessionID)
          && (!owner.history || !this.deletedSessions.has(owner.history.session)) } catch { return false }
      },
      cancel: () => { abort.abort(); if (this.clickOwner === owner) { this.clickWait?.(); this.clickWait = undefined; this.clickOwner = undefined } },
      commit: () => { if (!committed && lease.current()) { committed = true; this.activateClick(owner) } },
    }
    owner.lease = lease; this.clickOwner = owner
    return lease
  }
  private route() {
    try { return JSON.stringify(this.context.ui.router.current()) } catch { return }
  }
  routeChanged() { if (this.clickOwner && this.route() !== this.clickOwner.route) this.clearClick() }
  private clearClick() { this.clickOwner?.lease.cancel(); this.clickWait?.(); this.clickWait = undefined }
  private activateClick(owner: ClickOwner) {
    this.guard(() => {
      if (!owner.lease.current()) { if (this.clickOwner === owner) this.clearClick(); return }
      // Public keymap mode, not a fabricated dialog depth/open property. Never
      // close native UI; only the latest click waits for base input ownership.
      if (this.context.keymap.mode.current() !== "base") {
        this.clickWait = this.clock.after(100, () => {
          if (this.clickOwner !== owner) return
          this.clickWait = undefined; this.activateClick(owner)
        })
        return
      }
      owner.route = JSON.stringify({ type: "session", sessionID: owner.sessionID })
      this.context.ui.router.navigate({ type: "session", sessionID: owner.sessionID })
      // Stock exposes session.sidebar.toggle, not an idempotent reveal or public
      // visibility state. Do not toggle blindly, even on an explicit click.
      if (owner.history && owner.lease.current()) {
        try { void Promise.resolve(this.options.openHistory?.(owner.sessionID, owner.history, owner.lease)).catch(() => {}) } catch {}
      }
    })
  }
  deleted(sessionID: string) {
    this.guard(() => {
      this.remember(this.deletedSessions, sessionID)
      if (this.clickOwner?.sessionID === sessionID || this.clickOwner?.history?.session === sessionID) this.clearClick()
      this.roots.delete(sessionID); this.executions.delete(sessionID)
      this.visits.delete(sessionID)
      for (const [id, root] of this.ancestry) if (id === sessionID || root === sessionID) this.ancestry.delete(id)
      for (const [id, birth] of this.permissions) if (birth.sessionID === sessionID || birth.target?.root === sessionID) this.resolve("permission", id, birth.sessionID)
      for (const [id, birth] of this.forms) if (birth.sessionID === sessionID || birth.target?.root === sessionID) this.resolve("question", id, birth.sessionID)
      for (const [id, dispatch] of this.dispatches) if (dispatch.request.sessionID === sessionID || dispatch.target.root === sessionID) this.dispatches.delete(id)
      this.policy.deleted(sessionID)
      this.publish()
    })
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.stopped = true
    this.clearClick(); this.abort.abort()
    this.options.signal.removeEventListener("abort", this.onAbort)
    this.roots.clear(); this.permissions.clear(); this.forms.clear(); this.dispatches.clear(); this.executions.clear()
    this.visits.clear(); this.ancestry.clear(); this.retryAt.clear(); this.closed.clear(); this.deletedSessions.clear(); this.views = []
    this.disposal = Promise.allSettled([this.policy.dispose(), ...[...this.reads.values()].map(read => read.settled)]).then(() => {})
    return this.disposal
  }
}

/** Optional observers/backend failures cannot prevent runtime setup. */
export function setupHostNotifications(context: Plugin.Context, state: CliPluginState, options: HostNotificationOptions) {
  if (!(state.notificationConfig ?? state.config)?.notify || options.signal.aborted) return
  try { return new HostNotifications(context, state, options) } catch { return }
}
