import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { uiText } from "./ui-text.js"
import type { Message, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { ApprovalFact, View } from "./controller.js"
import type { NotificationPolicy } from "./notification-policy.js"
import { notificationClock, type NotificationClock, type NotificationClickLease } from "./notification-types.js"
import { notificationBlockers, type PendingInteraction } from "./notification-order.js"
import { withDeadline } from "./deadline.js"
import type { HistoryTarget } from "./history-records.js"
import type { AncestryRead, AncestryReader } from "./session-mode.js"

type Target = { root: string; sessionID: string; title: string }
interface Request {
  sessionID: string
  received: number
  target?: Target
  root?: string
  resolving?: boolean
  retryAt?: number
}
interface Root {
  since: number
  baselineUsers: Set<string>
  user?: string
  assistant?: Extract<Message, { role: "assistant" }>
  error?: { id: string; name: string }
  cancelled: boolean
  idle?: () => void
}
type HostApi = Pick<TuiPluginApi, "state" | "event" | "route" | "ui" | "lifecycle">

/** Public host bridge. Event births, not snapshots, establish new-request eligibility. */
export class NotificationHost {
  private roots = new Map<string, Root>()
  private visiting = new Map<string, number>()
  private permissions = new Map<string, Request>()
  private questions = new Map<string, Request>()
  private dispatched = new Map<string, { target: Target; session: string; automatic: boolean }>()
  private closed = new Set<string>()
  private views: readonly View[] = []
  private subscriptions: (() => void)[] = []
  private stopped = false
  private lookups = 0
  private ancestry = new Map<string, Promise<string>>()
  private sequence = 0
  private recentMessages = new Map<string, { message: Message; received: number }>()
  private created = new Map<string, number>()
  private deletedSessions = new Set<string>()
  private questionSnapshot: readonly Pick<QuestionRequest, "id" | "sessionID">[] = []
  private questionsReady = false
  private permissionsReady = false
  private admissionQueued = false
  private questionRevision = 0
  private questionRead = false
  private questionPoll?: () => void
  private abort = new AbortController()
  private pendingClick?: { sessionID: string; history?: HistoryTarget; route: string; lease: NotificationClickLease }
  private clickOwner?: { sessionID: string; history?: HistoryTarget; route: string; lease: NotificationClickLease }
  private clickWait?: () => void
  constructor(private api: HostApi, private policy: NotificationPolicy,
    private resolveRoot: AncestryReader,
    private readQuestions: (signal: AbortSignal) => Promise<readonly QuestionRequest[]>,
    private clock: NotificationClock = notificationClock,
    private openHistory?: (sessionID: string, target: HistoryTarget, lease: NotificationClickLease) => void) {
    const on = api.event.on
    this.subscriptions.push(
      on("permission.asked", e => this.asked("permission", e.properties)),
      on("question.asked", e => this.asked("question", e.properties)),
      on("permission.replied", e => this.resolved("permission", e.properties.requestID)),
      on("question.replied", e => this.resolved("question", e.properties.requestID)),
      on("question.rejected", e => this.resolved("question", e.properties.requestID)),
      on("session.deleted", e => this.deleted(e.properties.info.id)),
      on("message.updated", e => this.message(e.properties.info)),
      on("session.error", e => {
        const id = e.properties.sessionID
        if (!id) return
        const root = this.roots.get(id)
        if (!root) return // Recoverable child failures are not root failures.
        root.error = { id: e.id, name: e.properties.error?.name ?? "UnknownError" }
        if (root.error.name === "MessageAbortedError") root.cancelled = true
        this.idle(id)
      }),
      on("session.status", e => {
        const root = this.roots.get(e.properties.sessionID)
        if (!root) return
        root.idle?.(); root.idle = undefined
        if (e.properties.status.type === "idle") this.idle(e.properties.sessionID)
      }),
      on("session.idle", e => this.idle(e.properties.sessionID)),
      on("session.created", e => {
        if (this.created.size >= 1024) this.created.delete(this.created.keys().next().value!)
        this.created.set(e.properties.info.id, ++this.sequence)
        for (const [id, request] of this.permissions) this.admit("permission", id, request)
        for (const [id, request] of this.questions) this.admit("question", id, request)
        this.selectBlockers()
      }),
      on("session.updated", () => { this.admissions(); this.selectBlockers() }),
    )
    this.pollQuestions()
  }
  private pollQuestions() {
    if (this.stopped) return
    void this.refreshQuestions()
    this.questionPoll = this.clock.after(2000, () => this.pollQuestions())
  }
  private async refreshQuestions() {
    if (this.stopped || this.questionRead) return
    this.questionRead = true
    const revision = this.questionRevision
    let worker: Promise<readonly QuestionRequest[]> | undefined
    try {
      const requests = await withDeadline(AbortSignal.any([this.abort.signal, this.api.lifecycle.signal]), 5000, signal => {
        worker = Promise.resolve().then(() => { signal.throwIfAborted(); return this.readQuestions(signal) })
        // Retain actual read ownership after a bounded timeout, including late
        // settlement. Never issue overlapping replacement reads.
        void worker.then(() => { this.questionRead = false }, () => { this.questionRead = false })
        return worker
      })
      if (this.stopped || revision !== this.questionRevision) return
      if (!Array.isArray(requests) || requests.length > 1024
        || requests.some(r => !r || typeof r.id !== "string" || typeof r.sessionID !== "string")) throw new Error("Invalid pending questions")
      this.questionSnapshot = requests.map(({ id, sessionID }) => ({ id, sessionID }))
      this.questionsReady = true
      const ids = new Set(requests.map(r => r.id))
      for (const id of this.questions.keys()) if (!ids.has(id)) this.resolved("question", id)
      this.admissions()
      this.selectBlockers()
      this.recheckIdle()
    } catch {
      if (!this.stopped) { this.questionsReady = false; this.selectBlockers() }
    } finally { if (!worker) this.questionRead = false }
  }
  private selectBlockers() {
    if (this.stopped) return
    this.policy.pending(this.blockers())
  }
  private interactions() {
    const pending = new Map<string, PendingInteraction>()
    const add = (kind: "permission" | "question", id: string, sessionID: string) => {
      if (!this.closed.has(`${kind}:${id}`) && !this.deletedSessions.has(sessionID)) pending.set(`${kind}:${id}`, { kind, id, sessionID })
    }
    for (const view of this.views) add("permission", view.request.id, view.request.sessionID)
    for (const [id, request] of this.permissions) add("permission", id, request.sessionID)
    for (const request of this.questionSnapshot) add("question", request.id, request.sessionID)
    for (const [id, request] of this.questions) add("question", id, request.sessionID)
    return [...pending.values()]
  }
  private blockers() {
    // Public list snapshots establish ordering and reconciliation, never births.
    // An unseen permission or one with unresolved ancestry can precede any fresh
    // request. Retain event eligibility while withdrawing all attention delivery.
    const pending = this.interactions()
    if (!this.permissionsReady || pending.some(value => value.kind === "permission" && !this.rootOf(value.sessionID))) return new Map()
    return notificationBlockers(new Set(this.roots.keys()), pending.filter(value => value.kind === "permission" || this.questionsReady),
      id => this.api.state.session.get(id))
  }
  private rootOf(id: string): string | undefined {
    const seen = new Set<string>()
    for (let edge = 0; edge <= 16; edge++) {
      if (seen.has(id)) return
      seen.add(id)
      const session = this.api.state.session.get(id)
      if (!session) return
      if (!session.parentID) return id
      id = session.parentID
    }
  }
  private lookup(id: string) {
    const pending = this.ancestry.get(id)
    if (pending) return pending
    if (this.lookups >= 2 || this.stopped) return
    this.lookups++
    let read: AncestryRead | undefined
    const worker = Promise.resolve().then(() => read = this.resolveRoot(id, AbortSignal.any([this.abort.signal, this.api.lifecycle.signal])))
    const release = async () => {
      await read?.settled?.catch(() => {})
      if (this.ancestry.get(id) === worker) this.ancestry.delete(id)
      this.lookups--
      this.admissions()
    }
    void worker.then(release, release)
    this.ancestry.set(id, worker)
    return worker
  }
  visit(id?: string) {
    if (!id || this.stopped || this.visiting.has(id)) return
    const since = ++this.sequence
    const root = this.rootOf(id)
    if (root) { this.track(root, since); return }
    const lookup = this.lookup(id)
    if (!lookup) return
    this.visiting.set(id, since)
    void lookup.then(root => {
      if (!this.stopped) this.track(root, since)
    }).catch(() => {}).finally(() => { this.visiting.delete(id) })
  }
  private track(id: string, since: number) {
    if (this.deletedSessions.has(id) || this.roots.has(id) || this.roots.size >= 256) return
    const messages = this.api.state.session.messages(id)
    const root: Root = { since, baselineUsers: new Set(messages.filter(m => m.role === "user").slice(-4096).map(m => m.id)), cancelled: false }
    this.roots.set(id, root)
    for (const { message, received } of this.recentMessages.values()) {
      if (message.sessionID !== id || received < (this.created.get(id) ?? since)) continue
      if (message.role === "user") root.baselineUsers.delete(message.id)
      this.message(message)
    }
    for (const [key, request] of this.permissions) this.admit("permission", key, request)
    for (const [key, request] of this.questions) this.admit("question", key, request)
    this.selectBlockers()
  }
  private asked(kind: "permission" | "question", value: PermissionRequest | QuestionRequest) {
    if (this.stopped || this.closed.has(`${kind}:${value.id}`)) return
    const entries = kind === "permission" ? this.permissions : this.questions
    if (entries.has(value.id) || entries.size >= 1024) return
    const request: Request = { sessionID: value.sessionID, received: ++this.sequence }
    entries.set(value.id, request)
    if (kind === "question") this.questionRevision++
    this.selectBlockers()
    this.admit(kind, value.id, request)
    // State may already contain a new event's value, but only its event birth
    // authorizes a notification. Startup snapshot-only requests never enter here.
  }
  private admit(kind: "permission" | "question", id: string, request: Request) {
    if (request.target || this.stopped || this.deletedSessions.has(request.sessionID)) return
    const rootID = request.root ?? this.rootOf(request.sessionID)
    if (!rootID) {
      if (request.resolving || (request.retryAt ?? 0) > this.clock.now()) return
      const lookup = this.lookup(request.sessionID)
      if (!lookup) return
      request.resolving = true
      void lookup.then(root => {
        const entries = kind === "permission" ? this.permissions : this.questions
        if (this.stopped || entries.get(id) !== request) return
        request.root = root
        this.admit(kind, id, request)
      }).catch(() => { request.retryAt = this.clock.now() + 2000 }).finally(() => { request.resolving = false; this.selectBlockers() })
      return
    }
    const root = this.roots.get(rootID)
    if (!root || request.received < root.since) return
    const target = { root: rootID, sessionID: rootID, title: this.api.state.session.get(rootID)?.title ?? uiText.notifications.fallbackSession }
    request.target = target
    if (kind === "question") this.policy.question(id, target, true)
    else {
      const view = this.views.find(v => v.request.id === id)
      // permission event precedes controller publication in the TUI bridge.
      const value = view?.request ?? this.api.state.session.permission(request.sessionID).find(p => p.id === id)
      if (value) this.policy.permission(value, target, true)
      else request.target = undefined
    }
  }
  private admissions() {
    if (this.stopped || this.admissionQueued) return
    this.admissionQueued = true
    queueMicrotask(() => {
      this.admissionQueued = false
      if (this.stopped) return
      for (const [id, request] of this.permissions) this.admit("permission", id, request)
      for (const [id, request] of this.questions) this.admit("question", id, request)
      this.selectBlockers()
    })
  }
  snapshot(views: readonly View[], permissionHealthy?: boolean) {
    if (this.stopped) return
    if (permissionHealthy !== undefined) this.permissionsReady = permissionHealthy
    this.views = views
    for (const request of this.permissions.values()) if (request.target) {
      request.target.title = this.api.state.session.get(request.target.root)?.title ?? uiText.notifications.fallbackSession
    }
    this.policy.snapshot(views, this.blockers(), this.permissionsReady)
    for (const [id, request] of this.permissions) this.admit("permission", id, request)
    const pending = new Set(views.map(v => v.request.id))
    if (this.permissionsReady) for (const [id] of this.permissions) if (!pending.has(id)) this.resolved("permission", id)
    this.selectBlockers()
    if (permissionHealthy === true) this.recheckIdle()
  }
  fact(fact: ApprovalFact) {
    if (this.stopped) return
    if (fact.type === "dispatched") {
      const target = this.permissions.get(fact.request.id)?.target
      if (target && this.dispatched.size < 1024) this.dispatched.set(fact.request.id, { target, session: fact.request.sessionID, automatic: fact.automatic })
    } else if (fact.type === "confirmed") {
      const dispatched = this.dispatched.get(fact.request.id)
      this.dispatched.delete(fact.request.id)
      if (dispatched?.automatic) {
        dispatched.target.title = this.api.state.session.get(dispatched.target.root)?.title ?? uiText.notifications.fallbackSession
        this.policy.approved(fact.request, dispatched.target)
      }
    } else this.dispatched.delete(fact.request.id)
  }
  private resolved(kind: "permission" | "question", id: string) {
    if (kind === "question") {
      this.questionRevision++
      this.questionSnapshot = this.questionSnapshot.filter(request => request.id !== id)
    }
    ;(kind === "permission" ? this.permissions : this.questions).delete(id)
    const key = `${kind}:${id}`
    if (this.closed.size >= 4096) this.closed.delete(this.closed.values().next().value!)
    this.closed.add(key)
    this.policy.resolved(kind, id)
    this.selectBlockers()
    this.recheckIdle()
  }
  private message(message: Message) {
    if (this.stopped) return
    if (!this.recentMessages.has(message.id)) {
      if (this.recentMessages.size >= 1024) this.recentMessages.delete(this.recentMessages.keys().next().value!)
      this.recentMessages.set(message.id, { message, received: ++this.sequence })
    } else this.recentMessages.get(message.id)!.message = message
    const root = this.roots.get(message.sessionID)
    if (!root || this.stopped) return
    if (message.role === "user") {
      if (root.baselineUsers.has(message.id) || root.user === message.id) return
      root.baselineUsers.add(message.id)
      if (root.baselineUsers.size > 4096) root.baselineUsers.delete(root.baselineUsers.values().next().value!)
      root.user = message.id; root.assistant = undefined; root.error = undefined; root.cancelled = false
      root.idle?.(); root.idle = undefined
    } else if (!message.summary && message.parentID === root.user) {
      if (!root.assistant || message.id >= root.assistant.id) root.assistant = message
      if (message.error?.name === "MessageAbortedError") root.cancelled = true
    }
  }
  private recheckIdle() {
    // Healthy reconciliation can be the only observation of a missed reply.
    // Reuse final-message, cancellation and turn-dedup guards, never synthesize a
    // completed turn from disappearance. Include baseline-only child blockers.
    for (const id of this.roots.keys()) this.idle(id)
  }
  private idle(id: string) {
    const root = this.roots.get(id)
    if (!root || this.stopped) return
    root.idle?.()
    // Host failure can publish idle before assistant cleanup. Defer to public
    // final message state; repeated idle/status events coalesce into one check.
    root.idle = this.clock.after(100, () => {
      root.idle = undefined
      if (this.stopped || this.api.lifecycle.signal.aborted || this.roots.get(id) !== root || this.api.state.session.status(id)?.type !== "idle") return
      if (root.cancelled) return
      if (!this.permissionsReady || !this.questionsReady) return
      const messages = this.api.state.session.messages(id)
      const assistant = messages.findLast(m => m.role === "assistant" && !m.summary && m.parentID === root.user)
      if (assistant?.role === "assistant") root.assistant = assistant
      if (root.assistant?.error?.name === "MessageAbortedError" || root.error?.name === "MessageAbortedError") return
      if (this.interactions().some(value => { const root = this.rootOf(value.sessionID); return !root || root === id })
        || this.api.state.session.question(id).length || this.api.state.session.permission(id).length) return
      const target = { root: id, sessionID: id, title: this.api.state.session.get(id)?.title ?? uiText.notifications.fallbackSession }
      const message = root.assistant
      if (message?.error || (root.error && (!message?.time.completed || !message.finish || message.finish === "error"))) {
        this.policy.turn("error", root.user ?? root.error!.id, target)
      } else if (root.user && message?.time.completed && message.finish && !["tool-calls", "unknown", "error"].includes(message.finish)) {
        this.policy.turn("ended", root.user, target)
      }
    })
  }
  click(sessionID: string, history?: HistoryTarget) {
    this.beginClick(sessionID, history).commit()
  }
  beginClick(sessionID: string, history?: HistoryTarget): NotificationClickLease {
    this.clearClick()
    const abort = new AbortController()
    const target = { sessionID, history: history ? { ...history } : undefined, route: this.clickRoute(), lease: undefined as unknown as NotificationClickLease }
    let committed = false
    const lease: NotificationClickLease = {
      signal: abort.signal,
      current: () => !abort.signal.aborted && !this.stopped && !this.api.lifecycle.signal.aborted
        && this.clickOwner === target && this.clickRoute() === target.route && !this.deletedSessions.has(sessionID)
        && (!target.history || !this.deletedSessions.has(target.history.session)) && !!this.api.state.session.get(sessionID),
      cancel: () => { abort.abort(); if (this.clickOwner === target) { this.clickWait?.(); this.clickWait = undefined; this.pendingClick = undefined; this.clickOwner = undefined } },
      commit: () => {
        if (committed || !lease.current()) return
        committed = true
        if (target.history && this.openHistory) { this.pendingClick = target; this.activateClick(); return }
        if (this.api.ui.dialog.open) return
        target.route = JSON.stringify(["session", sessionID])
        this.api.route.navigate("session", { sessionID })
      },
    }
    target.lease = lease; this.clickOwner = target
    return lease
  }
  routeChanged() { if (this.clickOwner && this.clickRoute() !== this.clickOwner.route) this.clearClick() }
  private clearClick() { this.clickOwner?.lease.cancel(); this.clickWait?.(); this.clickWait = undefined; this.pendingClick = undefined }
  private clickRoute() {
    const route = this.api.route.current
    return JSON.stringify([route?.name, route?.name === "session" ? route.params?.sessionID : undefined])
  }
  private activateClick() {
    const target = this.pendingClick
    if (!target) return
    if (!target.lease.current()) { this.clearClick(); return }
    if (this.api.ui.dialog.open) {
      // Only the latest click waits; keep the user's dialog intact.
      this.clickWait = this.clock.after(100, () => {
        if (this.pendingClick !== target) return
        this.clickWait = undefined; this.activateClick()
      })
      return
    }
    this.clickWait?.(); this.clickWait = undefined; this.pendingClick = undefined
    try {
      target.route = JSON.stringify(["session", target.sessionID])
      this.api.route.navigate("session", { sessionID: target.sessionID })
      if (target.history && target.lease.current()) this.openHistory?.(target.sessionID, target.history, target.lease)
    } catch { /* Navigation cannot affect review/approval. */ }
  }
  private deleted(id: string) {
    if (this.clickOwner?.sessionID === id || this.clickOwner?.history?.session === id) this.clearClick()
    this.questionRevision++
    if (this.deletedSessions.size >= 4096) this.deletedSessions.delete(this.deletedSessions.values().next().value!)
    this.deletedSessions.add(id)
    this.roots.get(id)?.idle?.(); this.roots.delete(id)
    this.created.delete(id)
    for (const [key, request] of this.permissions) if (request.sessionID === id || request.target?.root === id) this.resolved("permission", key)
    for (const [key, request] of this.questions) if (request.sessionID === id || request.target?.root === id) this.resolved("question", key)
    for (const [key, dispatch] of this.dispatched) if (dispatch.target.root === id || dispatch.session === id) this.dispatched.delete(key)
    this.policy.deleted(id)
    this.selectBlockers()
  }
  dispose() {
    this.stopped = true
    this.clearClick()
    this.abort.abort(); this.questionPoll?.()
    for (const stop of this.subscriptions) stop()
    for (const root of this.roots.values()) root.idle?.()
    this.roots.clear(); this.permissions.clear(); this.questions.clear(); this.dispatched.clear(); this.closed.clear(); this.recentMessages.clear(); this.created.clear()
    this.deletedSessions.clear()
    this.questionSnapshot = []
    return this.policy.dispose()
  }
}
