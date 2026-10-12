import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import { CliRenderEvents } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { parseConfig, type Config } from "./config.js"
import { loadRootMessages, type ContextReader } from "./context.js"
import { Controller, visibleReview, type View } from "./controller.js"
import { ownedReview } from "./review-admission.js"
import { evaluateEvidence } from "./evaluate.js"
import { FileAccess, type FileIO } from "./file-access.js"
import { review, withDeadline } from "./reviewer.js"
import { BUILTIN_PROMPTS, loadPrompts } from "./prompts.js"
import { approvalTransport } from "./approval.js"
import { PendingRefresh } from "./pending-refresh.js"
import { modelPricing } from "./usage.js"
import { lifetimeTracker } from "./lifetime-view.js"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { SessionModes, SessionModeStore } from "./session-mode.js"
import { sessionModeCommands } from "./session-mode-commands.js"
import { DiagnosticTrace, measured, type DiagnosticObserver } from "./diagnostics.js"
import { parseNotificationConfig } from "./notification-config.js"
import { NotificationPolicy } from "./notification-policy.js"
import { NotificationHost } from "./notification-host.js"
import type { NotificationBackend, NotificationClick } from "./notification-types.js"
import { LinuxNotifications } from "./notification-linux.js"
import type { NotificationConfig } from "./notification-config.js"
import type { NotificationProcesses } from "./notification-process.js"
import { uiText } from "./ui-text.js"
import { HistoryStore } from "./history-store.js"
import { HistoryCoordinator, drainHistory } from "./history-coordinator.js"
import { HistoryMaintenance } from "./history-maintenance.js"
import { HistoryController, type HistoryViewState } from "./history-controller.js"
import { HistoryView, type HistoryInput } from "./history-view.js"
import { HistoryCover } from "./history-cover.js"
import type { HistoryTarget } from "./history-records.js"
import { historyCommands } from "./history-commands.js"
import { LiveReviewPanel, type HistoryRenderProbe } from "./live-review-panel.js"
import { observePresentationOwnership, SidebarPresentation, type PresentationCheck, type ReviewPresentation, type PresentationState } from "./review-presentation.js"
import { conversationRoot, RouteHandoff, RouteSessions, routeCovered, type ApprovalPresentation } from "./route-approval.js"
export type { HistoryRenderProbe, HistoryRenderProbeEvent } from "./live-review-panel.js"
export type { DiagnosticEvent, DiagnosticObserver } from "./diagnostics.js"

function contextReader(api: TuiPluginApi, trace?: DiagnosticTrace): ContextReader {
  const location = () => ({ directory: api.state.path.directory })
  return {
    projects: async (signal) => {
      // Read already registered metadata, rather than initializing an OpenCode
      // instance (and its plugins) in an arbitrary command target directory.
      const result = await measured(trace, "context.projects", () => api.client.project.list(location(), { signal }))
      if (!result.data) throw new Error("Project metadata unavailable")
      return result.data
    },
    session: async (sessionID, signal) => {
      const result = await measured(trace, "context.session", () => api.client.session.get({ sessionID, ...location() }, { signal }))
      return result.data
    },
    message: async (sessionID, messageID, signal) => {
      const result = await measured(trace, "context.message", () => api.client.session.message({ sessionID, messageID, ...location() }, { signal }))
      return result.data
    },
    // History duration includes the bounded public pagination traversal.
    messages: (sessionID, signal) => measured(trace, "context.messages", () => loadRootMessages(api.client, sessionID, location().directory, signal)),
    toolIDs: async (signal) => {
      const result = await measured(trace, "context.tool-ids", () => api.client.tool.ids(location(), { signal }))
      if (!result.data) throw new Error("Tool registry unavailable")
      return result.data
    },
    definition: async (info, tool, signal) => {
      if (typeof info.providerID !== "string" || typeof info.modelID !== "string") return
      const result = await measured(trace, "context.definition", () => api.client.tool.list({ ...location(), provider: info.providerID, model: info.modelID }, { signal }))
      const matches = result.data?.filter((item) => item.id === tool)
      return matches?.length === 1 ? matches[0] : undefined
    },
    mcpServers: () => api.state.mcp(),
    skills: async signal => {
      const result = await measured(trace, "context.skills", () => api.client.app.skills(location(), { signal, throwOnError: true }))
      if (!Array.isArray(result.data) || result.data.length > 16384) throw new Error("Skill catalog unavailable or oversized")
      return result.data
    },
  }
}

export type NotificationBackendFactory = (click: NotificationClick, config: NotificationConfig) => NotificationBackend

async function reviewTui(api: TuiPluginApi, options: Parameters<TuiPlugin>[1], fileIO?: FileIO, observer?: DiagnosticObserver,
  notificationBackend?: NotificationBackendFactory, historyProbe?: HistoryRenderProbe) {
  let lifecycleAbortAt: number | undefined
  api.lifecycle.signal.addEventListener("abort", () => { lifecycleAbortAt = performance.now() }, { once: true })
  let config: Config | undefined
  let reviewOptions: Config | undefined
  let prompts = BUILTIN_PROMPTS
  let configError = ""
  let notificationConfig: ReturnType<typeof parseNotificationConfig> | undefined
  try { notificationConfig = parseNotificationConfig(options) } catch { /* Invalid desktop options disable only notifications. */ }
  try {
    const parsed = parseConfig(notificationConfig ? options : { ...options, notify: false, notifySound: false,
      notificationSoundDirectory: undefined, staleReminderSeconds: 0, notifications: undefined })
    reviewOptions = parsed
    prompts = await withDeadline(api.lifecycle.signal, parsed.timeoutMs, (signal) => loadPrompts(parsed.instructions, signal), "Prompt loading")
    config = parsed
  } catch (error) { configError = error instanceof Error ? error.message : uiText.review.invalidConfiguration }
  api.lifecycle.signal.throwIfAborted()
  const historyStore = new HistoryStore(api.state.path.state)
  const [views, setViews] = createSignal<View[]>([])
  const [sidebar, setSidebar] = createSignal<{ sessionID: string; token: symbol }>()
  const sidebarProof = new SidebarPresentation()
  const routeSessions = new RouteSessions(id => api.state.session.get(id))
  const [sessionRevision, setSessionRevision] = createSignal(0)
  const session = (id: string) => { sessionRevision(); return routeSessions.get(id) }
  for (const type of ["session.created", "session.updated"] as const) api.event.on(type, event => {
    if (routeSessions.remember(event.properties.info)) setSessionRevision(value => value + 1)
  })
  const hostTrace = observer ? new DiagnosticTrace(observer, 0) : undefined
  const traces = observer ? new WeakMap<object, DiagnosticTrace>() : undefined
  let reviewSequence = 0
  const reader = contextReader(api, hostTrace)
  const modes = new SessionModes(new SessionModeStore(path.join(api.state.path.state, "opencode-reviewer", "session-mode-v1"),
    api.state.path.directory), async (id, signal) => session(id) ?? reader.session(id, signal))
  const history = new HistoryCoordinator(api.state.path.directory, historyStore, (id, signal) => modes.root(id, signal))
  const lifetime = lifetimeTracker(api, historyStore, (id, signal) => history.root(id, signal))
  const [historyState, setHistoryState] = createSignal<HistoryViewState>({ open: false, status: "loading", reset: 0 })
  const [revealHistory, setRevealHistory] = createSignal<{ session: string; live?: HistoryTarget }>()
  const browser = new HistoryController(api.state.path.directory, historyStore, (id, signal) => history.root(id, signal), setHistoryState)
  const maintenance = new HistoryMaintenance(api.state.path.directory, historyStore,
    (sessionID, signal) => api.client.session.get({ sessionID, directory: history.scope }, { signal, throwOnError: false }),
    id => { history.invalidateSession(id); browser.deleted(id) })
  maintenance.start()
  const historyInput: HistoryInput = { interactive: () => false, scroll: () => {} }
  const historyCover = new HistoryCover()
  const unregisterHistory = historyCommands(api, browser, () => historyInput.interactive(), (amount, page) => historyInput.scroll(amount, page))
  let notifications: NotificationHost | undefined
  if (notificationConfig?.notify) {
    try {
      const click: NotificationClick = (id, target) => { click.begin?.(id, target).commit() }
      click.begin = (id, target) => {
        // A newer approval click supersedes an older save wait or deferred reveal,
        // even when its navigation must wait for the current native dialog.
        setRevealHistory(undefined)
        if (target) browser.close()
        else browser.cancelPendingPermission()
        const lease = notifications!.beginClick(id, target)
        lease.signal.addEventListener("abort", () => { setRevealHistory(undefined); browser.cancelPendingPermission() }, { once: true })
        return lease
      }
      const backend = notificationBackend ? notificationBackend(click, notificationConfig) : new LinuxNotifications(notificationConfig, click)
      notifications = new NotificationHost(api,
        new NotificationPolicy(notificationConfig, reviewOptions?.autoApprove === true, backend),
        (id, signal) => modes.root(id, signal), async signal => {
          const result = await api.client.question.list({ directory: api.state.path.directory }, { signal, throwOnError: true })
          if (!result.data) throw new Error("Pending questions unavailable")
          return result.data
        }, undefined, (id, target, lease) => {
          if (controller.retained(id, target)) setRevealHistory({ session: id, live: target })
          else browser.openPermission(id, target, () => { if (lease.current()) setRevealHistory({ session: id }) })
        })
    } catch { /* Desktop initialization cannot change review behavior. */ }
  }
  const files = new FileAccess(fileIO)
  const approval = approvalTransport(api.client, api.state.path.directory)
  let visibleApproval: (check?: PresentationCheck) => ReviewPresentation = () => ({ state: "lost" })
  let approvalPresentation: (check?: PresentationCheck) => ApprovalPresentation = () => ({ state: "lost" })
  const controller: Controller = new Controller((request, parent, onIdentified, onProgress, execution = { review: randomUUID() }) => {
    const trace = observer ? new DiagnosticTrace(observer, ++reviewSequence) : undefined
    if (trace) traces!.set(request, trace)
    const reviewReader = trace ? contextReader(api, trace) : reader
    return ownedReview(parent, config?.timeoutMs ?? 30000, async (signal) => {
      const evidence = await evaluateEvidence(request, reviewReader, reviewOptions ?? { reviewBash: true, reviewEdits: true }, config, configError, signal, onIdentified, files)
      if (!evidence) return null
      signal.throwIfAborted()
      return review(evidence, config!, signal, { prompts,
        pricing: (model) => modelPricing(api.state.provider, config!.baseURL, model), onProgress, onDiagnostics: trace?.forward,
        observation: history.observation(request, evidence.kind, config!, execution) })
    })
  }, (views) => {
    setViews(views)
    // Solid cleanup can synchronously cancel an older countdown during this
    // publication. Read current controller state rather than replaying its input.
    if (!controller.reconciling) notifications?.snapshot(controller.pendingViews)
  }, { reviewOptions, approval: { ...(observer ? {
    list: (signal: AbortSignal) => {
      const pending = controller.views
      const view = pending.some((view) => view.autoApproval?.status === "failed") ? undefined
        : pending.find((view) => view.autoApproval?.status === "checking")
      // The public list call has no request argument. Recovery or overlapping
      // verification/recovery stays instance-wide rather than guessing ownership.
      return measured(view ? traces?.get(view.request) : hostTrace,
        view ? "approval-verification" : "approval-read", () => approval.list(signal))
    },
    once: (request, signal) => measured(traces?.get(request), "approval-reply", () => approval.once(request, signal)),
  } : approval), visibleID: () => { const proof = visibleApproval(); return proof.state === "visible" ? proof.id : undefined },
    presentation: check => approvalPresentation(check) }, modes, session, onApproval: fact => {
    history.approval(fact)
    notifications?.fact(fact)
  }, onLifecycle: history.lifecycle })

  api.event.on("permission.asked", (event) => controller.asked(event.properties))
  api.event.on("permission.replied", (event) => {
    history.reply(event.properties)
    controller.replied(event.properties.requestID)
  })
  api.event.on("message.updated", (event) => history.message(event.properties.info))
  api.event.on("session.deleted", (event) => {
    const info = event.properties.info
    routeSessions.deleted(info.id)
    setSessionRevision(value => value + 1)
    browser.deleted(info.id)
    // Roots are explicit in the event; unknown children use bounded stored ownership.
    const deletion = history.sessionDeleted(info)
    controller.deleted(info.id)
    void deletion.catch(() => {}).finally(() => modes.deleted(info.id))
  })

  // Startup recovery and bounded reconciliation cover attachment to an existing
  // request and cancellation paths that do not emit permission.replied.
  const pendingRefresh = new PendingRefresh(controller,
    (signal) => measured(hostTrace, "pending-refresh", () => approval.list(signal)), api.lifecycle.signal,
    healthy => notifications?.snapshot(controller.pendingViews, healthy))
  const refresh = () => pendingRefresh.refresh()
  const unregisterMode = sessionModeCommands(api, modes, (root) => { controller.modeChanged(root); void refresh() })
  void refresh()
  const interval = setInterval(() => void refresh(), 2000)
  api.event.on("session.idle", () => void refresh())
  api.event.on("session.error", () => void refresh())
  let cleanup: Promise<void> | undefined
  const stop = () => cleanup ??= (async () => {
    const abortAt = lifecycleAbortAt ?? performance.now()
    maintenance.dispose()
    history.dispose()
    browser.dispose()
    unregisterHistory()
    const notificationCleanup = notifications?.dispose()
    pendingRefresh.dispose()
    clearInterval(interval)
    unregisterMode()
    const reviewCleanup = controller.dispose()
    setSidebar(undefined)
    const cleanupTasks = Promise.allSettled([notificationCleanup, modes.flush(), reviewCleanup])
    const storage = drainHistory(historyStore, reviewCleanup, abortAt)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.all([storage, Promise.race([cleanupTasks, new Promise(resolve => {
      timer = setTimeout(resolve, Math.max(0, abortAt + 3500 - performance.now()))
    })])])
    clearTimeout(timer)
  })()
  api.lifecycle.signal.addEventListener("abort", () => { void stop() }, { once: true })
  api.lifecycle.onDispose(stop)

  api.slots.register({
    slots: {
      sidebar_content: (_ctx, props) => {
        // Observe the native sidebar's lifetime without changing its contents or
        // visibility settings. A token protects a new mount from stale cleanup.
        createEffect(() => {
          const token = sidebarProof.mount(props.session_id, api.renderer.width)
          setSidebar({ sessionID: props.session_id, token })
          onCleanup(() => {
            const route = api.route.current
            sidebarProof.unmount(token, route.name === "session" ? route.params?.sessionID as string : undefined,
              api.renderer.width, api.ui.dialog.open || api.kv.get("sidebar") === "hide")
            setSidebar((current) => current?.token === token ? undefined : current)
          })
        })
        return null
      },
      app: () => {
        const handoff = new RouteHandoff()
        createEffect(() => {
          const route = api.route.current
          notifications?.routeChanged()
          browser.route(route.name === "session" ? route.params?.sessionID as string | undefined : undefined)
        })
        createEffect(() => {
          const requested = revealHistory()
          if (!requested) return
          const route = api.route.current
          if (route.name !== "session" || route.params?.sessionID !== requested.session) {
            setRevealHistory(undefined); return
          }
          if (api.ui.dialog.open) return
          if (requested.live) {
            views()
            if (!controller.retained(requested.session, requested.live)) {
              setRevealHistory(undefined)
              browser.openPermission(requested.session, requested.live, () => setRevealHistory({ session: requested.session }))
              return
            }
          } else if (!historyState().open) { setRevealHistory(undefined); return }
          setRevealHistory(undefined)
          // The explicit approval click is the sole history path that reveals a
          // hidden sidebar, using the pinned host's public native command.
          if (sidebar()?.sessionID !== requested.session) api.keymap.dispatchCommand("session.sidebar.toggle")
        })
        if (notifications) createEffect(() => {
          const route = api.route.current
          notifications?.visit(route.name === "session" ? route.params?.sessionID as string | undefined : undefined)
        })
        const routeSession = () => {
          const route = api.route.current
          if (api.ui.dialog.open || route.name !== "session") return
          const id = route.params?.sessionID
          return typeof id === "string" ? id : undefined
        }
        const rootSession = () => {
          const id = routeSession()
          return id && conversationRoot(id, session) === id ? id : undefined
        }
        const sidebarState = (): PresentationState => {
          const id = rootSession()
          if (!id) return "lost"
          sidebar() // reactive ownership; the synchronous getter reads fresh proof too
          return sidebarProof.state(id)
        }
        const presentationSession = () => sidebarState() === "visible" ? routeSession() : undefined
        const select = () => {
          const route = api.route.current
          if (api.ui.dialog.open || route.name !== "session") return
          const id = route.params?.sessionID
          return visibleReview(controller.views, typeof id === "string" ? id : undefined, session)
        }
        const presentation = (check?: PresentationCheck, painted?: ReviewPresentation): ApprovalPresentation => {
          const route = routeSession()
          const root = conversationRoot(route, session)
          handoff.observe(route, root)
          if (!route || !root || api.kv.get("sidebar") === "hide") return { state: "lost" }
          const selected = select()
          if (!selected) return { state: "lost" }
          if (route !== root) return routeCovered(api.renderer.root, api.renderer.width, api.renderer.height)
            ? { state: "lost" } : { state: "route-hidden", id: selected.request.id, root }
          const proof = painted ?? visibleApproval(check)
          // A report first completed while hidden has no measured root layout,
          // even if the new native sidebar owner mounted earlier in this turn.
          // Wait for its first real frame without canceling the original timer.
          if (proof.state === "lost" && handoff.pending(root))
            return { state: "pending", id: selected.request.id }
          return proof
        }
        approvalPresentation = presentation
        const sidebarFrame = () => {
          sidebarProof.frame()
          handoff.frame()
          // Route suppression owns no report FRAME. Observe it from the stable
          // app lifetime, including native fullscreen while the panel is absent.
          const route = routeSession()
          if (!route || conversationRoot(route, session) !== route || !select())
            controller.presented(presentation())
        }
        api.renderer.on(CliRenderEvents.FRAME, sidebarFrame)
        onCleanup(() => {
          api.renderer.off(CliRenderEvents.FRAME, sidebarFrame)
          if (approvalPresentation === presentation) approvalPresentation = () => ({ state: "lost" })
          controller.presented()
        })
        // Native sidebar owners are observers, not owners of either report tree.
        // A synchronous wide/overlay slot gap must not dispose Markdown/scroll.
        const current = createMemo(() => { views(); return select() })
        observePresentationOwnership(() => {
          const route = routeSession(), root = conversationRoot(route, session)
          return { session: route, root, owner: sidebar()?.token, state: sidebarState(),
            suppressed: !!root && root !== route && api.kv.get("sidebar") !== "hide" }
        }, () => presentation(), proof => controller.presented(proof))
        createEffect(() => {
          const route = routeSession(), root = conversationRoot(route, session)
          if (!root || root === route) return
          views()
          // Only route-hidden work can start from a publication without a report
          // frame. Root publications must not become physical-loss observations.
          untrack(() => controller.presented(presentation()))
        })
        // A stable slot root keeps the host's array normalization from replacing
        // the live sibling when the optional history sibling appears/disappears.
        return (<box position="absolute" top={0} right={0} bottom={0} width={42} zIndex={1}
          visible={!!presentationSession() && (!!current() || (!!sidebar() && historyState().open))}>
          <Show when={current()?.request.id} keyed>
            {(id) => {
              // Countdown publications must not remount Markdown/reset its scroll.
              const initial = current()!
              const view = () => views().find((item) => item.request.id === id) ?? initial
              return <LiveReviewPanel api={api} id={id} view={view} select={select} config={config}
                sidebarSession={routeSession} sidebarState={sidebarState} sidebarOwner={() => sidebar()?.token}
                historyState={historyState} historyCover={historyCover} historyProbe={historyProbe}
                traceFor={traces ? view => traces.get(view.request) : undefined} lifetimeText={lifetime.text}
                onApprove={id => controller.approveNow(id)} onCancel={id => controller.cancelAutoApproval(id)}
                onPresented={proof => controller.presented(presentation(undefined, proof))} registerPresentation={visible => {
                  visibleApproval = visible
                  return () => { if (visibleApproval === visible) visibleApproval = () => ({ state: "lost" }) }
                }} />
            }}
          </Show>
          <Show when={historyState().open && rootSession()} keyed>
            {session => <HistoryView api={api} controller={browser} state={historyState()} input={historyInput} cover={historyCover} session={session} />}
          </Show>
        </box>)
      },
    },
  })
}

/** A read-only evidence adapter seam for isolated runtime fixtures/embedding. */
export function withFileAccess(io: FileIO): TuiPlugin {
  return (api, options) => reviewTui(api, options, io)
}

/** Opt-in embedding/fixture observations only; no configuration, storage or logging. */
export function withDiagnostics(observer: DiagnosticObserver): TuiPlugin {
  return (api, options) => reviewTui(api, options, undefined, observer)
}

/** Phase 0 fixture only. Explicit synthetic cover, never used by the normal plugin. */
export function withHistoryRenderProbe(probe: HistoryRenderProbe, observer?: DiagnosticObserver): TuiPlugin {
  return (api, options) => reviewTui(api, options, undefined, observer, undefined, probe)
}

/** Production history observations and notification I/O, without a cover override. */
export function withHistoryObservations(observe: HistoryRenderProbe["observe"], observer?: DiagnosticObserver,
  notifications?: NotificationBackendFactory): TuiPlugin {
  return (api, options) => reviewTui(api, options, undefined, observer, notifications, { observe })
}

/** Isolated notification backend for embedding and real-host fixtures. */
export function withNotifications(factory: NotificationBackendFactory): TuiPlugin {
  return (api, options) => reviewTui(api, options, undefined, undefined, factory)
}

/** Fixed-purpose process seam; exercises the bundled Linux/audio pipeline in fixtures. */
export function withNotificationProcesses(factory: () => NotificationProcesses): TuiPlugin {
  return (api, options) => reviewTui(api, options, undefined, undefined,
    (click, config) => new LinuxNotifications(config, click, factory()))
}

export default { id: "opencode-reviewer", tui: (api, options) => reviewTui(api, options) } satisfies TuiPluginModule
