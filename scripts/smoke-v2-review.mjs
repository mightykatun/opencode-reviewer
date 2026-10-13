// Installed five-file production archive: actual controller, UI and reviewer.
// Scenarios: advisory (nonstream), normal (SSE), fast (held SSE preview/remainder),
// normal-mouse-off, normal-cancel, normal-descendant, fast-descendant,
// normal-hide, normal-dialog, normal-resize, fast-dialog, normal-hidden-complete,
// normal-route-wait, normal-decision, fast-decision,
// normal-history / normal-history-default-home (actual saved report, browsing and native statistics dialog),
// normal-history-cover / fast-history-cover (two genuine native requests in one root),
// normal-history-keyboard-mouse-off (two actual saved reports and real mouse-off keyboard browsing),
// fast-notifications (injected desktop boundary, retained/live and exact history clicks).
// normal-edit / normal-directory-edit (one native write; distinct directory/edit stages).
// Build first. Do not execute a host until the main session grants approval.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { chmod, mkdir, mkdtemp, readFile, lstat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeEnvironment, smokeRuntime } from "./smoke-runtime.mjs"
import { observationPublisher, readObservation } from "./smoke-observations.mjs"
import { activatePalette } from "./smoke-ui.mjs"
import { readProductionHistory, assertWriteInspection, assertWriteEvidence, assertEvidenceRequest,
  savedStageHistory } from "./smoke-v2-review-support.mjs"

// Independent public wire schema. No production imports in either observer.
function rpcDefinition() {
  const text = { type: "string", minLength: 1, maxLength: 16384 }
  const location = { type: "object", properties: { directory: text, workspaceID: text },
    required: ["directory"], additionalProperties: false }
  return { id: "opencode-reviewer", methods: {
    handshake: { input: location, output: { type: "object", properties: {
      protocol: { const: 1 }, hostVersion: text, epoch: { type: "string", format: "uuid" }, location,
      project: { type: "object", properties: { id: text, directory: text, canonical: text },
        required: ["id", "directory", "canonical"], additionalProperties: false },
    }, required: ["protocol", "hostVersion", "epoch", "location", "project"], additionalProperties: false },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } } },
    invocation: { input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text },
      required: ["location", "epoch", "sessionID", "requestID"], additionalProperties: false },
    output: { anyOf: [{ type: "null" }, { type: "object", properties: {
      request: { type: "object" }, invocation: { type: "object" },
    }, required: ["request", "invocation"], additionalProperties: false }] },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } } },
  }, events: {} }
}

// Title interception suppresses auxiliary model calls only. Native tools, inputs,
// context, executors, HTTP requests and permission decisions are never modified.
async function serverSetup(ctx) {
  const registration = await ctx.session.hook("title", event => { event.result = "V2 production review fixture" })
  return () => registration.dispose()
}

async function monitorSetup(ctx) {
  const { Rpc } = await import("@opencode/plugin/rpc")
  const { CliRenderEvents } = await import("@opentui/core")
  const rpc = ctx.client.rpc(Rpc.define(rpcDefinition()))
  const publisher = observationPublisher(fixture.monitor), abort = new AbortController()
  // Keep real observations and consumed controls across public CLI hot reloads.
  const [memory, update] = ctx.storage.memory("review-monitor", { initial: { sequence: 0,
    record: { version: ctx.app.version, ready: true, connectionBirths: [], connectionDeletes: [], errors: [], asked: [], replied: [], interrupted: [], replies: {}, cleaned: false } } })
  const record = JSON.parse(JSON.stringify(memory.record))
  record.cleaned = false
  const unregisterDashboard = ctx.ui.router.register({ name: "fixture.dashboard", render: () => null })
  const location = { directory: fixture.initial }
  const options = () => ({ location, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
  const save = () => {
    record.route = JSON.parse(JSON.stringify(ctx.ui.router.current()))
    record.mouse = ctx.renderer.useMouse
    record.mode = ctx.keymap.mode.current()
    record.choices = {}
    let budget = 8192
    const choices = node => {
      if (--budget < 0 || !node.visible || node.isDestroyed) return
      if (typeof node.id === "string" && node.id.startsWith("session.permission.action."))
        record.choices[node.id.slice("session.permission.action.".length)] = node.backgroundColor?.equals(ctx.theme.background.action.primary.focused)
      for (const child of node.getChildren()) choices(child)
    }
    choices(ctx.renderer.root)
    record.terminal = { width: ctx.renderer.width, height: ctx.renderer.height }
    const sidebar = ctx.keymap.commands().find(item => item.id === "session.sidebar.toggle")
    record.sidebarCommand = sidebar && { id: sidebar.id, title: sidebar.title }
    update(draft => { draft.record = JSON.parse(JSON.stringify(record)) })
    return publisher.publish(record)
  }
  // Read genuine native frames only. Never request, suppress or synthesize paint.
  const frame = () => {
    record.frame = { id: ctx.renderer.frameId, width: ctx.renderer.width, height: ctx.renderer.height,
      mode: ctx.keymap.mode.current(), route: JSON.parse(JSON.stringify(ctx.ui.router.current())) }
    void save()
  }
  ctx.renderer.on(CliRenderEvents.FRAME, frame)
  const off = ctx.data.listen(({ details }) => {
    if (details.type === "session.created") record.connectionBirths.push(JSON.parse(JSON.stringify(details)))
    if (details.type === "session.deleted") record.connectionDeletes.push(JSON.parse(JSON.stringify(details)))
    if (details.type === "permission.asked") record.asked.push(details.data)
    if (details.type === "permission.replied") record.replied.push(details.data)
    if (details.type === "session.step.failed" && details.data.error.type === "aborted") record.interrupted.push(details.data)
    void save()
  })
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const command = await readObservation(fixture.control, { optional: true })
      abort.signal.throwIfAborted()
      if (command && command.sequence > memory.sequence) {
        const sequence = command.sequence
        const readonly = ["status", "pending", "inspect", "message", "runtime-ready"].includes(command.type)
          || (command.type === "keymap" && !command.dispatch)
        if (!readonly) update(draft => { draft.sequence = sequence })
        let value
        if (command.type === "status") {
          value = { plugins: await ctx.client.plugin.list({ location }, options()) }
          try { value.handshake = await rpc.handshake(location, options()) }
          catch (error) { value.failure = JSON.parse(JSON.stringify(error)) }
        }
        else if (command.type === "connection-probe") {
          value = await ctx.client.session.create({ title: "Review connection probe", location,
            model: { providerID: "fixture", id: "fixture" } }, options())
        } else if (command.type === "remove-probe") {
          await ctx.client.session.remove({ sessionID: command.sessionID }, options())
        } else if (command.type === "start") {
          value = await ctx.client.session.create({ title: "V2 production review fixture", location,
            model: { providerID: "fixture", id: "fixture" } }, options())
          ctx.ui.router.navigate({ type: "session", sessionID: value.id })
          await ctx.client.session.prompt({ sessionID: value.id, text: command.text }, options())
         } else if (command.type === "child") {
           value = await ctx.client.session.create({ title: "V2 production review descendant", parentID: command.sessionID,
             location, model: { providerID: "fixture", id: "fixture" } }, options())
           await ctx.data.session.sync(value.id)
           assert.equal(ctx.data.session.root(value.id), command.sessionID)
           assert.ok(ctx.data.session.family(command.sessionID).includes(value.id))
          } else if (command.type === "navigate") {
           ctx.ui.router.navigate({ type: "session", sessionID: command.sessionID })
           value = { route: ctx.ui.router.current(), root: ctx.data.session.root(command.sessionID),
              session: ctx.data.session.get(command.sessionID) }
          } else if (command.type === "away") {
            assert.ok(["home", "dashboard", "other"].includes(command.destination))
            if (command.destination === "home") ctx.ui.router.navigate({ type: "home" })
            else if (command.destination === "dashboard") ctx.ui.router.navigate({ type: "plugin", name: "fixture.dashboard" })
            else {
              const other = await ctx.client.session.create({ title: "Unrelated fixture conversation", location,
                model: { providerID: "fixture", id: "fixture" } }, options())
              await ctx.data.session.sync(other.id)
              ctx.ui.router.navigate({ type: "session", sessionID: other.id })
            }
            value = ctx.ui.router.current()
         } else if (command.type === "pending") value = await ctx.client.permission.list({ sessionID: command.sessionID }, options())
        else if (command.type === "inspect") {
          const request = await ctx.client.permission.get({ sessionID: command.sessionID, requestID: command.requestID }, options())
          value = { request, session: await ctx.client.session.get({ sessionID: command.sessionID }, options()),
            message: await ctx.client.session.message.get({ sessionID: command.sessionID, messageID: request.source.messageID }, options()),
             captured: await rpc.invocation({ location, epoch: command.epoch, sessionID: command.sessionID,
               requestID: command.requestID }, options()),
             native: { root: ctx.data.session.root(command.sessionID), family: ctx.data.session.family(command.sessionID),
               session: ctx.data.session.get(command.sessionID), permissions: ctx.data.session.permission.list(command.sessionID),
               route: ctx.ui.router.current() } }
          } else if (command.type === "runtime-ready") {
            value = { registered: ctx.keymap.commands().some(item => item.id === "reviewer.disable") }
          } else if (command.type === "prompt") {
           value = await ctx.client.session.prompt({ sessionID: command.sessionID, text: command.text }, options())
         } else if (command.type === "message") value = await ctx.client.session.message.get({ sessionID: command.sessionID,
          messageID: command.messageID }, options())
         else if (command.type === "keymap") {
            // Native IDs checked against stock 2.0.26's session-frame.tsx,
            // config/keybind.ts and command-palette.tsx, plus the V2 keybind docs.
            assert.ok(["reviewer.history", "reviewer.lifetime", "session.sidebar.toggle", "command.palette.show"].includes(command.id),
              "Only public production browsing or native presentation commands")
           const registered = ctx.keymap.commands().find(item => item.id === command.id)
           const enabled = !!registered && (typeof registered.enabled === "function" ? registered.enabled() : registered.enabled !== false)
            value = { id: command.id, title: registered?.title, registered: !!registered, enabled, mode: ctx.keymap.mode.current() }
           if (command.dispatch && enabled) ctx.keymap.dispatch(command.id)
         }
         else if (command.type === "mouse") {
           assert.equal(fixture.keyboardMouseOff, true, "Mouse user control is restricted to the saved-history keyboard case")
           assert.equal(command.value, false, "The fixture may only disable mouse, never force it on")
           assert.equal(record.asked.length, 2)
           assert.equal(record.replied.length, 2, "Both actual automatic approvals precede mouse user control")
           assert.ok(record.asked.every(request => request.sessionID === command.sessionID))
           assert.deepEqual(ctx.ui.router.current(), { type: "session", sessionID: command.sessionID })
           assert.deepEqual(await ctx.client.permission.list({ sessionID: command.sessionID }, options()), [], "No pending request at mouse disable")
           ctx.renderer.useMouse = false // Public renderer setter, not production configuration or presentation proof.
           value = { mouse: ctx.renderer.useMouse }
         }
         else if (command.type === "interrupt") await ctx.client.session.interrupt({ sessionID: command.sessionID, continue: false }, options())
        else throw Error("Unknown V2 review fixture control: " + command.type)
        record.replies[sequence] = { value: value ?? null }
        update(draft => { draft.sequence = sequence })
         await save(); await publisher.flush()
       }
       // Observe native keyboard modal transitions as well as server events.
       await save()
       await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => { if (!abort.signal.aborted) { record.errors.push(error instanceof Error ? String(error.stack) : JSON.stringify(error)); void save() } })
  await save(); await publisher.flush()
  return async () => {
    off(); unregisterDashboard(); ctx.renderer.off(CliRenderEvents.FRAME, frame); abort.abort(); await loop
    record.cleaned = true
    await save(); await publisher.flush(); await publisher.close()
  }
}

async function observedReviewerSetup(ctx) {
  const panels = observationPublisher(reviewerPaths.presentation)
  const storage = observationPublisher(reviewerPaths.storage)
  const facts = { events: [], failures: 0 }
  const notifications = reviewerPaths.notifications ? observationPublisher(reviewerPaths.notifications) : undefined
  const abort = new AbortController(), handles = new Map()
  const attention = { events: [], errors: [], replies: {}, owned: 0, disposed: false, cleaned: false, historyCalls: [] }
  let injectionClick, records, notificationSequence = 0
  const saveNotifications = () => {
    if (records) {
      const state = records.state()
      attention.history = { open: state.open, status: state.status, entry: state.selection?.entry,
        context: state.selection?.record?.context }
    }
    return notifications?.publish(attention)
  }
  const saveStorage = () => {
    if (reviewerPaths.historyInput && records) {
      const state = records.state()
      facts.history = { open: state.open, status: state.status, entry: state.selection?.entry,
        rank: state.selection?.rank, total: state.selection?.total, context: state.selection?.record?.context }
      if (reviewerPaths.keyboardMouseOff) facts.history.scroll = records.browser.scroll
      // Read only the mounted production view's genuine FRAME/input proof.
      // No listener, hit owner, painted state or approval gate is installed here.
      facts.historyInput = { frame: ctx.renderer.frameId, mode: ctx.keymap.mode.current(), mouse: ctx.renderer.useMouse,
        session: state.selection?.record?.context.root, keyboard: records.historyInput.interactive() }
    }
    return storage.publish(facts)
  }
  // Only the exported embedding seam replaces desktop process work. The archived
  // default controller, event policy, approval path, stream and storage run intact.
  const backend = notifications ? (click, config) => {
    injectionClick = click
    attention.config = { notify: config.notify, notifySound: config.notifySound, notifications: config.notifications }
    void saveNotifications()
    return {
      async show(message, signal) {
        if (attention.disposed || signal.aborted) throw Error("Synthetic notification backend is unavailable")
        const id = attention.events.filter(event => event.event === "show").length + 1
        let resolveClosed, closed = false
        const settled = new Promise(resolve => { resolveClosed = resolve })
        const close = () => {
          if (closed) return
          closed = true; signal.removeEventListener("abort", close); handles.delete(id)
          attention.owned--; attention.events.push({ event: "close", id })
          resolveClosed(); void saveNotifications()
        }
        handles.set(id, { close, closed: settled })
        signal.addEventListener("abort", close, { once: true })
        attention.owned++
        attention.events.push({ event: "show", id, message: JSON.parse(JSON.stringify(message)) })
        await saveNotifications(); await notifications.flush()
        return { close, closed: settled, dispatched: Promise.resolve() }
      },
      async dispose() {
        if (attention.disposed) return
        attention.disposed = true
        const owned = [...handles.values()]
        for (const handle of owned) handle.close()
        await Promise.all(owned.map(handle => handle.closed))
        attention.events.push({ event: "disposed" })
        await saveNotifications(); await notifications.flush()
      },
    }
  } : undefined
  const cleanup = await production.withHistoryObservations(value => panels.publish(value), undefined, backend, ready => {
    if (ready.role !== "cli") return
    const runtime = ready.state.runtime?.records
    if (!runtime) return
    records = runtime
    if (reviewerPaths.historyInput && !runtime.historyInput) throw Error("Installed history input observation seam unavailable")
    if (notifications) {
      for (const method of ["open", "openPermission"]) {
        const original = runtime.browser[method].bind(runtime.browser)
        runtime.browser[method] = (...args) => {
          attention.historyCalls.push({ method, sessionID: args[0], ...(method === "openPermission" ? { target: { ...args[1] } } : {}) })
          void saveNotifications()
          return original(...args)
        }
      }
    }
    facts.stateRoot = ready.state.stateRoot
    facts.scope = runtime.scope
    facts.ready = !!ready.state.config && !!ready.state.companion
    const admit = runtime.store.admit.bind(runtime.store)
    runtime.store.admit = event => {
      const accepted = admit(event)
      facts.events.push({ type: event.type, accepted, ...(reviewerPaths.editCase ? {
        context: event.context, ...(event.type === "permissionResolved" ? { outcome: event.outcome } : {}) } : {}) })
      void storage.publish(facts)
      return accepted
    }
    runtime.store.onWriteFailure(() => { facts.failures++; void storage.publish(facts) })
    void storage.publish(facts)
  }).setup(ctx)
  // Independent monitor has no production imports. Clicks arrive only through
  // this separate explicit driver control, never from observation or approval.
   const loop = notifications || reviewerPaths.historyInput ? (async () => {
    while (!abort.signal.aborted) {
       const command = notifications ? await readObservation(reviewerPaths.notificationControl, { optional: true }) : undefined
      if (command && command.sequence > notificationSequence) {
        notificationSequence = command.sequence
        if (command.type !== "injectionClick") throw Error("Unknown notification fixture control")
        const shown = attention.events.find(event => event.event === "show" && event.id === command.id)
        if (!shown || !injectionClick?.begin) throw Error("No captured notification click lease")
        const lease = injectionClick.begin(shown.message.sessionID, shown.message.history)
        const current = lease.current()
        if (!current || lease.signal.aborted) { lease.cancel(); throw Error("Notification click lease is not current") }
        lease.commit()
        attention.events.push({ event: "click", id: command.id, current })
        attention.replies[notificationSequence] = { id: command.id, current }
      }
       if (notifications) { await saveNotifications(); await notifications.flush() }
       if (reviewerPaths.historyInput) { await saveStorage(); await storage.flush() }
      await sleep(40, undefined, { signal: abort.signal })
    }
  })().catch(error => {
     if (!abort.signal.aborted) {
       attention.errors.push(String(error.stack ?? error)); void saveNotifications()
       facts.error = String(error.stack ?? error); void saveStorage()
     }
  }) : Promise.resolve()
  return async () => {
    abort.abort(); await loop
    await cleanup()
    if (notifications) {
      attention.cleaned = true
      await saveNotifications(); await notifications.flush(); await notifications.close()
    }
    await panels.flush(); await storage.flush()
    await panels.close(); await storage.close()
  }
}

const { scenario } = runtimeArguments("smoke-v2-review.mjs")
const streaming = scenario !== "advisory", automatic = scenario !== "advisory", fast = scenario.startsWith("fast")
const defaultHomeCase = scenario === "normal-history-default-home"
const historyCase = scenario === "normal-history" || defaultHomeCase
const keyboardMouseOffCase = scenario === "normal-history-keyboard-mouse-off"
const coverCase = ["normal-history-cover", "fast-history-cover"].includes(scenario) || keyboardMouseOffCase
const dialogCase = ["normal-dialog", "fast-dialog"].includes(scenario)
const visibilityLoss = ["normal-hide", "normal-dialog", "normal-resize"].includes(scenario)
const hiddenComplete = scenario === "normal-hidden-complete"
const routeWait = scenario === "normal-route-wait", decisionCase = scenario.endsWith("-decision")
const editCase = ["normal-edit", "normal-directory-edit"].includes(scenario)
const directoryEditCase = scenario === "normal-directory-edit"
const notificationCase = scenario === "fast-notifications", savedCase = automatic && scenario !== "normal-cancel"
const requestCount = coverCase || directoryEditCase ? 2 : 1
const nativeCallCount = editCase ? 1 : requestCount
const negative = scenario === "normal-cancel"
const descendant = scenario.endsWith("-descendant")
const mouseOff = scenario === "normal-mouse-off", approvalDelaySeconds = fast ? 45 : visibilityLoss || hiddenComplete ? 5 : 8
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, `.runtime/v2-review-${scenario}-`))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-review-")
const env = smokeEnvironment(temp), runtime = await smokeRuntime(temp)
// /tmp/opencode and this checkout may be group-writable. SQLite correctly
// refuses that ancestry, so keep fixture history under a private sticky-/tmp child.
// Only the new default-home fixture's own host directory receives chmod.
if (defaultHomeCase) {
  env.HOME = await mkdtemp("/tmp/reviewer-v2-private-home-")
  delete env.XDG_STATE_HOME
  const stateBase = path.join(env.HOME, ".local/state")
  await mkdir(stateBase, { recursive: true, mode: 0o700 })
  const hostState = path.join(stateBase, "opencode")
  await mkdir(hostState, { mode: 0o775 })
  await chmod(hostState, 0o775) // Exact regression mode, independent of caller umask.
} else {
  env.XDG_STATE_HOME = await mkdtemp("/tmp/reviewer-v2-private-state-")
  await mkdir(path.join(env.XDG_STATE_HOME, "opencode"), { mode: 0o700 })
}
// Independent transcription of local-state.ts and HistoryStore's on-disk path,
// using this host's actual isolated environment, never a guessed project path.
const stateBase = defaultHomeCase ? path.join(env.HOME, ".local/state") : env.XDG_STATE_HOME
assert.ok(path.isAbsolute(stateBase))
const stateRoot = path.join(stateBase, "opencode")
const historyFile = path.join(defaultHomeCase ? path.join(stateBase, "opencode-reviewer-state") : stateRoot,
  "opencode-reviewer/history-v1.sqlite")
const oldHistoryFile = path.join(stateRoot, "opencode-reviewer/history-v1.sqlite")
const assertDefaultHomeStorage = async () => {
  if (!defaultHomeCase) return
  assert.equal(Object.hasOwn(env, "XDG_STATE_HOME"), false, "Default HOME state resolution has no XDG_STATE_HOME override")
  const hostState = await lstat(stateRoot)
  assert.ok(hostState.isDirectory() && !hostState.isSymbolicLink())
  assert.equal(hostState.mode & 0o7777, 0o775, "Production never changes the existing host directory's permissions")
  await assert.rejects(lstat(oldHistoryFile), { code: "ENOENT" }, "No database is created below the unsafe host directory")
}
await assertDefaultHomeStorage()
const project = path.join(temp, "project"), initial = path.join(project, "invocation"), inputs = path.join(initial, "inputs")
const monitorPath = path.join(artifacts, "monitor.json"), controlPath = path.join(artifacts, "control.json")
const presentationPath = path.join(artifacts, "presentation.json")
const notificationPath = path.join(artifacts, "notifications.json"), notificationControlPath = path.join(artifacts, "notifications-control.json")
const cliPath = path.join(temp, "config/opencode/cli.json")
const archiveFiles = ["dist/tui.js", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].sort()
const editTarget = directoryEditCase ? path.join(temp, "outside-project", "target.txt") : path.join(initial, "target.txt")
const writeTarget = directoryEditCase ? editTarget : "target.txt"
const beforeEdit = "V2_EDIT_BEFORE\n", afterEdit = "V2_EDIT_AFTER\n"
const editActions = directoryEditCase ? ["external_directory", "edit"] : ["edit"]
const editDescriptions = editActions.map(action => action === "edit"
  ? "V2 native edit report.\n\nThe proposed diff replaces one isolated marker."
  : "V2 directory access report.\n\nAllow access to the isolated outside-project target for the pending write; edit contents are assessed separately.")
const prompt = editCase ? `Use native write once to replace ${writeTarget} with exactly V2_EDIT_AFTER followed by a newline.`
  : "Run python3 fixture.py once in inputs. It appends the isolated V2_REVIEW_EXECUTED marker and prints it."
const script = 'from pathlib import Path\nwith Path("executed").open("a") as output:\n    output.write("V2_REVIEW_EXECUTED\\n")\nprint("V2_REVIEW_EXECUTED")\n'
const description = "V2 local marker report.\n\nThe script writes one isolated marker."
// Only the second keyboard-case response is long. The first genuine report keeps
// all existing saved-history text/metadata and selected-original assertions intact.
const keyboardDescription = description + "\n\n" + Array.from({ length: 80 }, (_, index) =>
  `Keyboard scroll line ${String(index + 1).padStart(2, "0")}: one isolated marker.`).join("\n\n")
const reportDescription = index => editCase ? editDescriptions[index - 1] : keyboardMouseOffCase && index === 2 ? keyboardDescription : description
const assessment = { safe: true, desc: editCase ? editDescriptions.at(-1) : description }
const reviewUsage = { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 }
const toolCall = editCase ? { id: "v2-production-review-write", name: "write", input: { path: writeTarget, content: afterEdit } }
  : { id: "v2-production-review-shell", name: "shell", input: { command: "python3 fixture.py", workdir: "inputs" } }
const publishers = new Map(), calls = [], errors = [], negativeWindows = []
let version, modelServer, mainResponse, reviewResponse, sessionID, childSession, request, inspection, handshake, sequence = 0
let reviewPOSTs = 0, reviewCompleted = false, allowWrites = false
let allowedReplies = 1, historyEvidence, coverEvidence, notificationEvidence, presentationEvidence, notificationSequence = 0
const requests = [], inspections = [], reviewerTransactions = []
const editStages = []
const markerLine = "V2_REVIEW_EXECUTED\n"
const publish = async (file, value) => {
  let publisher = publishers.get(file)
  if (!publisher) { publisher = observationPublisher(file); publishers.set(file, publisher) }
  await publisher.publish(value); await publisher.flush()
}
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "v2-review")
const saveCapture = async name => {
  await writeFile(path.join(artifacts, name + ".txt"), capture())
  await writeFile(path.join(artifacts, name + ".ansi.txt"), runtime.tmux("capture-pane", "-p", "-e", "-t", "v2-review"))
}
const executed = () => readFile(editCase ? editTarget : path.join(inputs, "executed"), "utf8").catch(error => {
  if (error.code === "ENOENT") return null
  throw error
})
const observations = async () => {
  const record = await readObservation(monitorPath, { optional: true })
  assert.deepEqual(errors, [])
   assert.ok(reviewPOSTs <= requestCount, "One production reviewer POST per native request, no correction or transport retry")
  if (record) {
    assert.deepEqual(record.errors, [])
      assert.ok(record.asked.length <= requestCount, "Only expected native operation permissions")
     assert.ok(record.replied.length <= (allowWrites ? allowedReplies : 0), "Only the production automatic path may reply once per eligible request")
    for (const reply of record.replied) {
      assert.equal(reply.reply, "once")
      assert.equal(reply.sessionID, sessionID)
       assert.ok(record.asked.some(asked => asked.id === reply.requestID), "Reply belongs to an actual observed native request")
        if (!coverCase && !directoryEditCase) assert.equal(reply.requestID, request.id)
        assert.equal(record.replied.filter(item => item.requestID === reply.requestID).length, 1, "Exact once-only native reply per permission")
    }
  }
  const marker = await executed()
  if (notificationCase) {
    const value = await readObservation(notificationPath, { optional: true })
    if (value) {
      assert.deepEqual(value.errors, [])
      const shows = value.events.filter(event => event.event === "show")
      assert.ok(shows.length <= 1, "Only one approved banner, never attention or replay")
      for (const shown of shows) {
        assert.equal(allowWrites, true, "No notification before automatic approval eligibility")
        assert.equal(shown.message.kind, "approved")
        assert.equal(shown.message.sessionID, sessionID)
        assert.deepEqual(shown.message.history, { session: sessionID, permission: request.id })
        assert.equal(shown.message.banner, true)
        assert.equal(shown.message.sound, false)
      }
    }
  }
  // Native Python can create the append target just before flushing its line.
  // Only an admitted automatic write may expose that transient empty file.
   if (editCase) assert.ok(marker === beforeEdit || allowWrites && allowedReplies === requestCount
     && [null, "", afterEdit].includes(marker), "Native write cannot change contents before final edit approval")
   else assert.ok(marker === null || allowWrites && Array.from({ length: allowedReplies + 1 }, (_, count) => markerLine.repeat(count)).includes(marker), "No unexpected or duplicate execution")
  return record
}
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    const record = await observations(), value = await predicate(record)
    if (value) return value
    await sleep(60)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${scenario}/${label}`)
}
const command = async input => {
  const id = ++sequence
  await publish(controlPath, { ...input, sequence: id })
  const reply = await until("monitor " + input.type, record => record?.replies[id])
  return reply.value
}
const negativeWindow = async (label, expectedPending, expectedReplies, expectedExecution, expectedReviewPOSTs,
  durationMs = 1500, check = () => {}) => {
  const start = performance.now(), end = start + durationMs
  let samples = 0
  do {
    const pending = await command({ type: "pending", sessionID })
    assert.deepEqual(pending, expectedPending, "Complete raw native pending data remains unchanged")
    const record = await observations()
    assert.deepEqual(record.replied, expectedReplies, "No new permission write in negative window")
    assert.equal(await executed(), expectedExecution, "No new native execution in negative window")
     assert.equal(reviewPOSTs, expectedReviewPOSTs, "No extra reviewer dispatch")
     await check(record, capture())
    samples++
    await sleep(75)
  } while (performance.now() < end)
  negativeWindows.push({ label, durationMs: performance.now() - start, samples, pending: expectedPending,
    replies: expectedReplies, execution: expectedExecution, reviewPOSTs: expectedReviewPOSTs })
}
const presentation = () => readObservation(presentationPath, { optional: true })
const notificationObservations = async () => {
  const value = await readObservation(notificationPath)
  assert.deepEqual(value.errors, [])
  return value
}
const noAttention = async () => {
  const value = await notificationObservations()
  assert.deepEqual(value.events.filter(event => event.event === "show"), [], "No attention before approval")
  assert.equal(value.owned, 0)
  await noSavedBody()
}
const clickNotification = async id => {
  const sequence = ++notificationSequence
  await publish(notificationControlPath, { type: "injectionClick", sequence, id })
  const result = await until("explicit simulated notification click lease", async () => (await notificationObservations()).replies[sequence])
  assert.deepEqual(result, { id, current: true })
}
const readHistory = async () => {
  await assertDefaultHomeStorage()
  return readProductionHistory(historyFile)
}
const noSavedBody = async () => {
  const value = await readHistory()
  if (value) assert.equal(value.payloadCount, 0, "Unresolved report text remains memory-only")
}
const savedHistory = async () => {
  const value = await readHistory()
  if (!value?.rows.length || !value.meta || !value.conversations.length
    || !value.attempts[0]?.finalized || !value.reviews[0]?.accepted
    || value.approvals[0]?.state !== "confirmed") return undefined
  const totals = [JSON.parse(value.meta.totals), ...value.conversations.map(row => JSON.parse(row.totals))]
  if (totals.some(total => total.activity.reviews !== 1 || total.activity.autoApproved !== 1 || total.activity.usageRequests !== 1)) return undefined
  assert.equal(value.meta.version, 1)
  assert.equal(value.rows.length, 1, "One saved report, not an injected fixture entry")
  assert.equal(value.payloadCount, 1)
  assert.equal(value.reviews.length, 1)
  assert.equal(value.attempts.length, 1, "One actually dispatched POST")
  assert.equal(value.approvals.length, 1)
  assert.equal(value.conversations.length, 1)
  const row = value.rows[0], context = JSON.parse(row.context), payload = JSON.parse(row.body)
  const opaque = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
  assert.equal(context.root, sessionID, "Saved root identity matches the real native root")
  assert.equal(context.session, sessionID)
  assert.equal(context.permission, request.id)
  assert.equal(context.configuredModel, "v2-production-reviewer")
  assert.equal(row.id, opaque(context.scope, request.id))
  assert.equal(row.root, opaque(context.scope, sessionID))
  assert.equal(row.session, opaque(context.scope, sessionID))
  assert.equal(row.review, value.reviews[0].id)
  assert.equal(row.outcome, "auto")
  assert.equal(row.resolution, "auto")
  assert.equal(row.approving, row.review)
  assert.equal(payload.desc, description, "Final validated description saved exactly")
  assert.equal(payload.safe, true)
  assert.deepEqual(payload.usage, { input: reviewUsage.prompt_tokens, output: reviewUsage.completion_tokens })
  assert.equal(JSON.parse(row.accepted).safe, true)
  assert.equal(value.attempts[0].review, row.review)
  assert.equal(JSON.parse(value.attempts[0].dispatched).retry, "initial")
  assert.deepEqual(JSON.parse(value.attempts[0].finalized).usage, payload.usage)
  assert.equal(value.approvals[0].review, row.review)
  assert.equal(value.approvals[0].entry, row.id)
  assert.equal(value.approvals[0].automatic, 1)
  assert.equal(value.conversations[0].id, row.root)
  assert.equal(value.conversations[0].partial, 0)
  for (const total of totals) {
    assert.equal(total.requests, 1)
    assert.equal(total.tokenRequests, 1)
    assert.equal(total.input, reviewUsage.prompt_tokens)
    assert.equal(total.output, reviewUsage.completion_tokens)
    assert.equal(total.safe, 1)
    assert.equal(total.unsafe, 0)
    assert.equal(total.activity.retries, 0)
    assert.equal(total.activity.timedReviews, 1)
  }
  return { ...value, context, payload, totals }
}
const historyScreen = (record, screen) => {
  assert.deepEqual(record.route, { type: "session", sessionID })
  assert.equal(record.mode, "base")
  assert.match(screen, /Analysis history/)
  assert.match(screen, /✓ Safe/)
  assert.match(screen, /V2 local marker report\./)
  assert.match(screen, /The script writes one isolated marker\./)
  assert.match(screen, /Auto approved/)
  assert.match(screen, /1\/1/)
  assert.match(screen, /model: v2-production-reviewer/)
  assert.match(screen, /token: 23 in 11 out/)
  assert.doesNotMatch(screen, /Permission analysis|Allowed in|Loading history|History could not be read/)
}
const coverState = async () => {
  const value = await readObservation(path.join(artifacts, "storage-observations.json"))
  assert.equal(value.error, undefined)
  assert.equal(value.failures, 0)
  return value
}
const selectedOriginal = async (record, screen, total = 1) => {
  if (total === 1) historyScreen(record, screen)
  else {
    assert.deepEqual(record.route, { type: "session", sessionID })
    assert.equal(record.mode, "base")
    assert.match(screen, /Analysis history/)
    assert.match(screen, /✓ Safe/)
    assert.match(screen, /Auto approved/)
    assert.match(screen, /V2 local marker report\./)
    assert.match(screen, /The script writes one isolated marker\./)
    // The first chronological row keeps rank 1 when the second row arrives.
    // Independently verified in failed.txt and the read-only SQL pair capture.
    assert.match(screen, /1\/2/)
    assert.match(screen, /model: v2-production-reviewer/)
    assert.match(screen, /token: 23 in 11 out/)
    assert.doesNotMatch(screen, /Permission analysis|Allowed in|Loading history|History could not be read/)
  }
  const facts = await coverState()
  assert.equal(facts.history.open, true)
  assert.equal(facts.history.status, "ready")
  assert.equal(facts.history.entry, coverEvidence.first.rows[0].id, "New arrivals preserve the original selected entry")
  assert.deepEqual(facts.history.context, coverEvidence.first.context)
  assert.equal(facts.history.rank, 1, "Original chronological entry remains selected at rank 1")
  assert.equal(facts.history.total, total)
  return facts
}
// Separate independent two-entry checks leave normal-history's one-entry SQL
// assertions unchanged. Match by permission identity, never SQL arrival order.
const savedPair = async () => {
  const value = await readHistory()
  if (!value || value.rows.length < 2 || !value.meta || !value.conversations.length
    || value.attempts.some(attempt => !attempt.finalized) || value.reviews.some(review => !review.accepted)
    || value.approvals.some(approval => approval.state !== "confirmed")) return undefined
  const totals = [JSON.parse(value.meta.totals), ...value.conversations.map(row => JSON.parse(row.totals))]
  if (totals.some(total => total.activity.reviews !== 2 || total.activity.autoApproved !== 2 || total.activity.usageRequests !== 2)) return undefined
  assert.equal(value.meta.version, 1)
  for (const name of ["rows", "reviews", "attempts", "approvals"]) assert.equal(value[name].length, 2, name)
  assert.equal(value.payloadCount, 2)
  assert.equal(value.conversations.length, 1)
  assert.equal(value.rows[0].id, coverEvidence.first.rows[0].id, "Independent chronological SQL order keeps the original entry at rank 1")
  const opaque = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
  for (const expected of requests) {
    const row = value.rows.find(row => JSON.parse(row.context).permission === expected.id)
    assert.ok(row, "Actual native permission has its own saved validated report")
    const context = JSON.parse(row.context), payload = JSON.parse(row.body)
    assert.equal(context.root, sessionID)
    assert.equal(context.session, sessionID)
    assert.equal(context.scope, coverEvidence.first.context.scope)
    assert.equal(context.configuredModel, "v2-production-reviewer")
    assert.equal(row.id, opaque(context.scope, expected.id))
    assert.equal(row.root, opaque(context.scope, sessionID))
    assert.equal(row.session, opaque(context.scope, sessionID))
    assert.equal(row.outcome, "auto")
    assert.equal(row.resolution, "auto")
    assert.equal(row.approving, row.review)
    assert.equal(payload.desc, reportDescription(requests.indexOf(expected) + 1))
    assert.equal(payload.safe, true)
    assert.deepEqual(payload.usage, { input: 23, output: 11 })
    const review = value.reviews.find(review => review.id === row.review)
    assert.ok(review)
    assert.equal(review.root, row.root)
    assert.equal(review.session, row.session)
    assert.deepEqual(JSON.parse(review.context), context)
    assert.equal(JSON.parse(review.accepted).safe, true)
    const attempts = value.attempts.filter(attempt => attempt.review === row.review)
    assert.equal(attempts.length, 1)
    assert.equal(JSON.parse(attempts[0].dispatched).retry, "initial")
    assert.deepEqual(JSON.parse(attempts[0].finalized).usage, payload.usage)
    const approvals = value.approvals.filter(approval => approval.review === row.review)
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].entry, row.id)
    assert.equal(approvals[0].automatic, 1)
    assert.equal(approvals[0].state, "confirmed")
    assert.equal(value.conversations[0].id, row.root)
  }
  assert.equal(value.conversations[0].partial, 0)
  for (const total of totals) {
    assert.equal(total.requests, 2)
    assert.equal(total.tokenRequests, 2)
    assert.equal(total.input, 46)
    assert.equal(total.output, 22)
    assert.equal(total.safe, 2)
    assert.equal(total.unsafe, 0)
    assert.equal(total.activity.retries, 0)
    assert.equal(total.activity.timedReviews, 2)
  }
  assert.deepEqual(value.rows.find(row => row.id === coverEvidence.first.rows[0].id), coverEvidence.first.rows[0], "Second save never rewrites the original row")
  return { ...value, totals }
}
const openHistory = async () => {
  const result = await command({ type: "keymap", id: "reviewer.history", dispatch: true })
  assert.equal(result.registered, true, "Actual production history command is registered")
  assert.equal(result.enabled, true)
  await until("rendered actual production history", record => {
    try { historyScreen(record, capture()); return true } catch { return false }
  }, 15000)
}
const rootPending = (record, screen) => {
  assert.deepEqual(record.route, { type: "session", sessionID })
  assert.equal(record.mouse, !mouseOff, "Production preserves explicit fixture mouse preference")
  assert.ok(screen.includes("Permission analysis"))
  assert.ok(screen.includes("✓ Safe"))
  assert.doesNotMatch(screen, /Allowed in/)
}
const cancelledRoot = (record, screen) => {
  rootPending(record, screen)
  assert.ok(screen.includes("Auto-approval canceled"), "Countdown cancellation tombstone remains visible")
}
const hiddenDescendant = (record, screen) => {
  assert.deepEqual(record.route, { type: "session", sessionID: childSession.id })
  assert.equal(record.mouse, true)
  assert.doesNotMatch(screen, /Permission analysis|V2 local marker report\.|Allowed in|Auto-approved; finishing report/,
    "The entire reviewer panel is absent on the real descendant route")
}
const nativePresentationCommand = async id => {
  const value = await command({ type: "keymap", id, dispatch: true })
  assert.equal(value.registered, true, "Actual stock native presentation command is registered")
  assert.equal(value.enabled, true)
  assert.equal(value.mode, "base", "Native presentation change starts from the real base input mode")
  return value
}
const hiddenSidebar = (record, screen) => {
  assert.deepEqual(record.route, { type: "session", sessionID })
  assert.equal(record.mouse, true)
  assert.equal(record.mode, "base")
  assert.equal(record.sidebarCommand?.title, "Show sidebar", "Native sidebar state, not a reviewer visibility override")
  assert.doesNotMatch(screen, /Permission analysis|V2 local marker report\.|Allowed in/)
}
const paletteCover = async (record, screen) => {
  assert.deepEqual(record.route, { type: "session", sessionID })
  assert.equal(record.mouse, true)
  assert.equal(record.mode, "modal", "Stock command palette owns the native modal input mode")
  assert.equal(record.frame?.mode, "modal", "Genuine native FRAME observes the modal owner")
  assert.match(screen, /Commands/)
  const value = await presentation()
  assert.equal(value?.stage, "frame")
  assert.equal(value.selected, request.id)
  assert.equal(value.root, sessionID)
  assert.equal(value.mode, "modal")
  assert.equal(value.physical, false, "Actual native cover revokes production physical proof")
  return value
}
const openPalette = async () => {
  const before = (await observations()).frame?.id
  assert.ok(Number.isInteger(before), "A genuine native frame precedes the public palette command")
  const native = await nativePresentationCommand("command.palette.show")
  const proof = await until("stock palette owns a painted native modal", async record => {
    if (!(record?.frame?.id > before)) return false
    try { return await paletteCover(record, capture()) } catch { return false }
  }, 3000)
  await saveCapture("native-palette-open")
  return { native, proof, frame: (await observations()).frame }
}
const resizeWindow = (height) => {
  runtime.tmux("resize-window", "-t", "v2-review:0", "-x", "160", "-y", String(height))
  assert.equal(runtime.tmux("display-message", "-p", "-t", "v2-review:0", "#{window_width}x#{window_height}").trim(), `160x${height}`,
    "Actual supervised tmux window dimensions, never substituted geometry")
}
const navigate = async target => {
  const value = await command({ type: "navigate", sessionID: target })
  assert.deepEqual(value.route, { type: "session", sessionID: target })
  assert.equal(value.root, sessionID)
  await until("native route " + target, record => record?.route.type === "session" && record.route.sessionID === target)
  return value
}
const interruptPending = async (check = () => {}) => {
  await command({ type: "interrupt", sessionID })
  await until("native permission cleared after interruption", async () => (await command({ type: "pending", sessionID })).length === 0)
  await until("reviewer cleared after negative-case interruption", () => !capture().includes("Permission analysis"))
  await negativeWindow("negative-case interruption has no approval or execution", [], [], null, 1, 1500, (record, screen) => {
    assert.doesNotMatch(screen, /Permission analysis/)
    check(record, screen)
  })
}
const sse = (res, content, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0,
  delta: content === undefined ? {} : { content }, finish_reason }] })}\n\n`)
const finishReview = () => {
  assert.ok(reviewResponse && !reviewCompleted)
  if (streaming) {
    sse(reviewResponse, fast ? '"}' : JSON.stringify({ safe: true, desc: reportDescription(reviewPOSTs) }))
    sse(reviewResponse, undefined, "stop")
    if (savedCase) reviewResponse.write(`data: ${JSON.stringify({ choices: [], usage: reviewUsage })}\n\n`)
    reviewResponse.end("data: [DONE]\n\n")
  } else {
    reviewResponse.writeHead(200, { "Content-Type": "application/json" })
    reviewResponse.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(assessment) }, finish_reason: "stop" }] }))
  }
  reviewCompleted = true
  reviewerTransactions.at(-1).completed = true
}
const releaseNativeCall = () => {
  const message = { role: "assistant", content: null, tool_calls: [{ index: 0, id: toolCall.id, type: "function",
    function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } }] }
  if (mainResponse.body.stream) {
    mainResponse.res.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const [delta, finish_reason] of [[message, null], [{}, "tool_calls"]])
      mainResponse.res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    mainResponse.res.end("data: [DONE]\n\n")
  } else {
    mainResponse.res.writeHead(200, { "Content-Type": "application/json" })
    mainResponse.res.end(JSON.stringify({ choices: [{ message, finish_reason: "tool_calls" }] }))
  }
}
const limits = [
   "Behavioral review activates through public CLI configuration only after an owned prompt-free session's exact genuine birth and deletion are observed on the native data stream. This is not pre-connection startup acceptance; the separate lifecycle fixture checks startup. No runtime reconnect policy is overridden.",
     "One installed default archive with separate server companion and global CLI configuration. The independent monitor never imports production code or replies to permissions.",
  `One standalone Linux OpenCode V2 verification host, ${nativeCallCount} direct native ${editCase ? "write" : "shell"} call(s), ${requestCount} genuine permission stage(s) and a loopback reviewer. No live-provider judgment, remote workspace, multi-terminal, disconnect or tab-switch acceptance.`,
  "Mouse capture is explicitly configured only by the isolated fixture, never forced by production. UI changes use real native commands/navigation, keyboard choices or actual tmux resize; no synthesized paint, modes, hits or geometry. Individual cases do not imply full UI-matrix acceptance.",
  "Descendant cases navigate a real child while a root request is pending; they do not exercise descendant-owned native queue ordering. No disabled kinds or uncertain writes.",
    editCase ? "One actual native write, exact direct source linkage and pending native diff. Outside-project access, when selected, automatically resumes that same write into a distinct edit permission. Each stage holds the real reviewer response, proves no mutation, paints a full normal countdown and receives one production once reply. Read-only SQLite proves per-stage accepted reports, qualifying resolutions, categories and both aggregate scopes. Production history opens through painted palette activation. No native edit/patch variant, formatter, descendant-owned queue, notification, multi-client or live-provider judgment acceptance."
      : routeWait ? "A started normal countdown survives native home, a public plugin dashboard and an unrelated session route, with no writes past its original deadline. Returning to its root resumes once without a new delay. Saved report and aggregates are verified."
      : decisionCase ? "Actual Right/Left native keyboard input selects Always then Once. Automatic approval waits without cancellation while Always is selected, then resumes with the original delay or fast preview semantics. No persistent native grant is submitted; saved automatic report is verified. Rejection editing is separately source-tested, not host-accepted here."
      : dialogCase ? "Stock command.palette.show owns a real native modal. Normal and fast automatic replies proceed underneath it without closing it; final report and usage are verified in SQLite. No other modal-family acceptance."
      : visibilityLoss ? "One actual normal countdown continues through native sidebar hide or a real 160x8 tmux window. A single native once reply and saved report occur without restoring presentation first. No other geometry-family acceptance."
      : hiddenComplete ? "A never-displayed normal report completes on a real child route and approves after its delay without returning to root. SQLite verifies the saved report and aggregates. No descendant-owned permission queue acceptance."
      : keyboardMouseOffCase ? "Two real automatic requests with configured mouse on, then disable mouse via its public setter only after both entries save and no request is pending. Real palette/history input, exact two-entry Left/Right selection and Up/Down/PageUp/PageDown scroll use the long second fixed reviewer response. The mounted production history view proves mouse-off keyboard ownership only after genuine native FRAME geometry. Input ownership is independent of approval. No synthesized paint/hits, statistics dialog or multi-client acceptance."
      : coverCase ? "Two real root-owned native shell permissions, two real reviewer POSTs and worker-saved validated automatic entries. Public production history stays selected on the first entry while normal or fast automatic approval proceeds. No descendant-owned queue, offline deletion, statistics dialog, notification or multi-client acceptance."
     : historyCase ? "History/statistics acceptance is one actual automatic saved entry and its real read-only SQLite aggregates, public command browsing and native dialog. Child history invocation is disabled; root return explicitly reopens the same saved entry. No approval while browsing history, offline deletion, multiple entries or multi-client acceptance."
    : notificationCase ? "Production host with an injected desktop boundary only: one actual fast native approval, retained SSE response, approved banner and lease-based simulated clicks, including revealing a deliberately hidden native sidebar for the retained report. No real GNOME activation, desktop processes, audio, live-provider latency, advisory/unsafe attention, reminders or multi-request queue acceptance. Exact-key history selection is observed without a competing newer entry; multi-entry not-latest behavior is not accepted by this single-entry fixture."
      : "No production history browsing, statistics UI or notification acceptance in this scenario. Advisory native interruption is not treated as exact manual attribution.",
]
try {
  version = execFileSync(host, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim()
  assertV2HostVersion(version)
  await Promise.all([inputs, path.dirname(cliPath)].map(directory => mkdir(directory, { recursive: true })))
  execFileSync("git", ["init", "--quiet", project], { env, timeout: 10000 })
  await writeFile(path.join(inputs, "fixture.py"), script)
  if (editCase) {
    await mkdir(path.dirname(editTarget), { recursive: true })
    await writeFile(editTarget, beforeEdit)
  }
  const packedOutput = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--pack-destination", temp],
    { cwd: root, env: { ...env, npm_config_cache: path.join(temp, "npm-cache"), npm_config_ignore_scripts: "true" }, encoding: "utf8", timeout: 60000 }))
  const packed = Array.isArray(packedOutput) ? packedOutput : Object.values(packedOutput)
  assert.equal(packed.length, 1)
  assert.deepEqual(packed[0].files.map(file => file.path).sort(), archiveFiles)
  const archive = path.join(temp, packed[0].filename), install = path.join(temp, "installed")
  await mkdir(install)
  assert.deepEqual(execFileSync("tar", ["-tzf", archive], { env, encoding: "utf8", timeout: 10000 }).trim().split("\n").sort(),
    archiveFiles.map(file => "package/" + file).sort())
  execFileSync("tar", ["-xzf", archive, "-C", install], { env, timeout: 10000 })
  const installed = path.join(install, "package")
  for (const file of archiveFiles) {
    assert.equal((await lstat(path.join(installed, file))).isSymbolicLink(), false)
    assert.deepEqual(await readFile(path.join(installed, file)), await readFile(path.join(root, file)))
  }
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"))
  assert.equal(manifest.name, "opencode-reviewer")
  assert.equal(manifest.engines.opencode, ">=2.0.0 <3")
  assert.deepEqual(manifest.exports, { ".": "./dist/tui.js", "./server": "./dist/tui.js", "./tui": "./dist/tui.js" })
  modelServer = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST")
      let text = ""
      for await (const chunk of req) { text += chunk; assert.ok(text.length < 8 * 1024 * 1024) }
      const body = JSON.parse(text)
      calls.push({ url: req.url, body })
      if (req.url === "/review/chat/completions") {
        reviewPOSTs++
         assert.ok(reviewPOSTs <= requestCount)
        assert.equal(body.model, "v2-production-reviewer")
        assert.equal(body.stream, streaming)
        assert.equal(body.messages.length, 2)
        assert.equal(body.messages[0].role, "system")
        assert.equal(body.messages[1].role, "user")
        const evidence = JSON.parse(body.messages[1].content)
        if (editCase) {
          const action = editActions[reviewPOSTs - 1]
          assert.match(body.messages[0].content, action === "edit" ? /permission\.action="edit"/ : /external-directory access/)
          assertWriteEvidence(evidence, { action, target: writeTarget, prompt, initial, project })
          assert.equal(evidence.permission.sessionID, sessionID)
          assert.equal(evidence.permission.source.id, toolCall.id)
          reviewCompleted = false
         } else {
          assert.match(body.messages[0].content, /permission\.action="shell"/)
          assert.equal(evidence.kind, "shell")
          assert.equal(evidence.tool, "shell")
          assert.equal(evidence.command, toolCall.input.command)
          assert.deepEqual(evidence.operation.input, toolCall.input)
          assert.equal(evidence.userPrompt, prompt)
          assert.equal(evidence.location.directory, initial)
          assert.equal(evidence.cwd, inputs)
          assert.deepEqual(evidence.execution, { tool: "shell", requestedWorkdir: "inputs", canonicalCwd: inputs,
            cwdSource: "tool.workdir relative to invocation.location.directory" })
          assert.equal(evidence.project.directory, project)
          assert.equal(evidence.permission.action, "shell")
          assert.deepEqual(evidence.permission.resources, [toolCall.input.command])
          assert.equal(evidence.permission.type, undefined, "No fabricated native permission type")
          assert.equal(evidence.files.length, 1)
          assert.equal(evidence.files[0].status, "captured")
          assert.equal(evidence.files[0].contents, script)
        }
         reviewResponse = res
         const transaction = { res, completed: false }
         reviewerTransactions.push(transaction)
         res.once("close", () => { if (!transaction.completed) errors.push("Reviewer response closed before its controlled terminal EOF") })
        if (streaming) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders() }
        return
      }
      assert.equal(req.url, "/v1/chat/completions")
      assert.ok(body.tools?.some(tool => tool.function.name === "execute"), "Native Code Mode search/execution remains installed")
      const mainCalls = calls.filter(call => call.url === req.url)
        assert.ok(mainCalls.length <= nativeCallCount * 2, "Only genuine prompts and tool-result continuations")
       if (mainCalls.length === 1 || coverCase && mainCalls.length === 3) {
          assert.ok(body.tools.some(tool => tool.function.name === toolCall.name), "Use the actually advertised direct native tool")
          if (editCase) {
            const definition = body.tools.find(tool => tool.function.name === "write").function
            assert.equal(definition.parameters.properties.path.type, "string")
            assert.equal(definition.parameters.properties.content.type, "string")
            assert.ok(definition.parameters.required.includes("path"))
            assert.ok(definition.parameters.required.includes("content"))
          }
         if (mainCalls.length === 3) {
           const oldResults = body.messages.filter(message => message.role === "tool")
           assert.equal(oldResults.length, 1)
           assert.equal(oldResults[0].tool_call_id, toolCall.id)
           assert.match(JSON.stringify(oldResults[0].content), /V2_REVIEW_EXECUTED/)
         }
        mainResponse = { res, body }
        return
      }
      assert.ok(allowWrites, "Advisory must not resume native execution")
      const toolResults = body.messages.filter(message => message.role === "tool")
       assert.equal(toolResults.length, coverCase ? mainCalls.length / 2 : 1)
       const latestResult = toolResults.at(-1)
       assert.equal(latestResult.tool_call_id, toolCall.id)
        if (editCase) {
          assert.equal(reviewPOSTs, requestCount, "Directory approval alone cannot finish native write")
          assert.equal(await executed(), afterEdit, "Actual native result follows the exact applied file contents")
          assert.ok(latestResult.content, "Actual native write response reaches the main model")
          assert.doesNotMatch(JSON.stringify(latestResult.content), /Tool execution failed|Permission denied/)
        } else assert.match(JSON.stringify(latestResult.content), /V2_REVIEW_EXECUTED/, "Exact latest actual native tool response reaches the main model")
      const message = { role: "assistant", content: "V2 fixture complete." }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`)
        sse(res, undefined, "stop"); res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }))
      }
    } catch (error) { errors.push(String(error)); res.destroy() }
  })
  await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${modelServer.address().port}`
  const fixture = { initial, monitor: monitorPath, control: controlPath, keyboardMouseOff: keyboardMouseOffCase }
  const observer = path.join(temp, "observer"), monitor = path.join(temp, "monitor")
  const reviewer = path.join(temp, "reviewer")
  await mkdir(reviewer)
  await publish(path.join(reviewer, "package.json"), { name: "v2-review-archive-entrypoints", type: "module",
    exports: { ".": "./index.mjs", "./tui": "./tui.mjs" } })
  const archived = `export {default} from ${JSON.stringify(pathToFileURL(path.join(installed, "dist/tui.js")).href)}\n`
  await writeFile(path.join(reviewer, "index.mjs"), archived)
  await writeFile(path.join(reviewer, "tui.mjs"), (automatic ? await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
    + '\nimport {setTimeout as sleep} from "node:timers/promises"\n'
    + `\nimport * as production from ${JSON.stringify(pathToFileURL(path.join(installed, "dist/tui.js")).href)}\n`
     + `\nconst reviewerPaths=${JSON.stringify({ presentation: presentationPath, storage: path.join(artifacts, "storage-observations.json"),
         ...(notificationCase ? { notifications: notificationPath, notificationControl: notificationControlPath } : {}), historyInput: coverCase,
          keyboardMouseOff: keyboardMouseOffCase, editCase })}\n`
     + observedReviewerSetup + '\nexport default {id:"opencode-reviewer",setup:observedReviewerSetup}\n'
    : archived))
  await Promise.all([observer, monitor].map(directory => mkdir(directory)))
  const helpers = await readFile(new URL("./smoke-observations.mjs", import.meta.url), "utf8")
  const prelude = helpers + '\nimport assert from "node:assert/strict"\n'
    + 'import {setTimeout as sleep} from "node:timers/promises"\nconst fixture=' + JSON.stringify(fixture) + "\n"
  await publish(path.join(observer, "package.json"), { name: "v2-review-title-observer", type: "module", exports: { ".": "./index.mjs" } })
  await writeFile(path.join(observer, "index.mjs"), serverSetup + '\nexport default {id:"fixture.review.title",setup:serverSetup}\n')
  await publish(path.join(monitor, "package.json"), { name: "v2-review-independent-monitor", type: "module", exports: { "./tui": "./tui.mjs" } })
  await writeFile(path.join(monitor, "tui.mjs"), prelude + rpcDefinition + "\n" + monitorSetup
    + '\nexport default {id:"fixture.review.monitor",setup:monitorSetup}\n')
  for (const file of [path.join(observer, "index.mjs"), path.join(monitor, "tui.mjs"), path.join(reviewer, "tui.mjs")])
    execFileSync(process.execPath, ["--check", file], { env, timeout: 10000 })
  const config = { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", update: "disable",
    plugins: [reviewer, observer], permissions: [{ action: "*", resource: "*", effect: "allow" },
      ...(editCase ? editActions.map(action => ({ action, resource: "*", effect: "ask" })) : [{ action: "shell", resource: "*", effect: "ask" }])],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: origin + "/v1", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 2000 } } } } } }
   // Approval cases explicitly configure mouse capture in the isolated fixture,
   // except the mouse-off approval case. Production never changes it;
   // advisory retains the host default.
  // Native autoaccept is explicitly disabled.
  const cli = { $schema: "https://opencode.ai/v2/cli.json", animations: false, attention: { notifications: false, sound: false },
     ...(automatic ? { mouse: !mouseOff } : {}),
    session: { permissions: "prompt" }, plugins: [{ package: reviewer, options: { baseURL: origin + "/review", model: "v2-production-reviewer",
       stream: streaming, autoApprove: automatic, fastMode: fast, autoApproveDelaySeconds: approvalDelaySeconds,
       ...(directoryEditCase ? { reviewExternalDirectories: true } : {}),
       timeoutMs: 120000, notify: notificationCase, notifySound: false, staleReminderSeconds: 0,
       ...(notificationCase ? { notifications: { ended: { banner: false, sound: false }, error: { banner: false, sound: false } } } : {}) } }, monitor] }
  const startupCli = { ...cli, plugins: ["-opencode-reviewer", monitor] }
  await publish(path.join(project, "opencode.json"), config); await publish(cliPath, startupCli)
  await publish(path.join(artifacts, "setup.json"), { version, scenario, temp, archive, packed, installed,
    moduleURL: pathToFileURL(path.join(installed, "dist/tui.js")).href, config, cli, startupCli, limits,
    environment: { HOME: env.HOME, XDG_STATE_HOME: env.XDG_STATE_HOME }, stateRoot, historyFile,
    ...(defaultHomeCase ? { oldHistoryFile, hostStateMode: "0775" } : {}),
    socket: runtime.socket, supervisorPID: runtime.supervisorPID })
  await runtime.start("-d", "-s", "v2-review", "-x", "160", "-y", "40", "-c", initial,
    "env", ...(defaultHomeCase ? ["-u", "XDG_STATE_HOME", "HOME=" + env.HOME] : ["XDG_STATE_HOME=" + env.XDG_STATE_HOME]),
    host, "--standalone", initial)
  const ready = await until("independent monitor", record => record?.ready && record)
  assert.equal(ready.version, version.slice("opencode v".length))
  const probe = await command({ type: "connection-probe" })
  assert.ok(probe.id)
  const birth = await until("actual native connection probe birth before reviewer activation", record =>
    record.connectionBirths.find(event => event.data.sessionID === probe.id))
  assert.equal(birth.data.location.directory, initial)
  assert.equal(birth.durable.aggregateID, probe.id)
  await command({ type: "remove-probe", sessionID: probe.id })
  const deletion = await until("actual native connection probe deletion before reviewer activation", record =>
    record.connectionDeletes.find(event => event.data.sessionID === probe.id))
  await publish(path.join(artifacts, "connection-probe.json"), { sessionID: probe.id, birth, deletion, prompted: false })
  await publish(cliPath, cli)
  await until("actual configured production CLI runtime", async () =>
    (await command({ type: "runtime-ready" })).registered)
  if (automatic) await until("actual production storage observer readiness", async () =>
    (await readObservation(path.join(artifacts, "storage-observations.json"), { optional: true }))?.ready)
   const status = await until("active production companion", async () => {
     const value = await command({ type: "status" })
     return value.handshake && value.plugins.data.find(item => item.id === "opencode-reviewer")?.state.status === "active" && value
   })
  assert.equal(status.plugins.data.find(item => item.id === "opencode-reviewer")?.state.status, "active")
  handshake = status.handshake
  assert.equal(handshake.protocol, 1)
  assert.equal(handshake.hostVersion, version.slice("opencode v".length))
  assert.deepEqual(handshake.location, { directory: initial })
  assert.equal(handshake.project.directory, project)
  assert.match(handshake.epoch, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
  const session = await command({ type: "start", text: prompt })
  sessionID = session.id
  await until("controlled initial native model request", () => mainResponse)
    releaseNativeCall()
   if (editCase) {
     // One direct native call remains running across both permission stages. The
     // monitor reads native data and the companion RPC; only production replies.
     for (const [index, action] of editActions.entries()) {
       allowedReplies = index
       request = await until(`native ${action} permission`, record => record?.asked[index])
       requests.push(request)
       assert.equal(request.action, action)
       assert.equal(request.sessionID, sessionID)
       assert.equal(request.source.type, "tool")
       assert.equal(request.source.id, toolCall.id)
       if (index) {
         assert.notEqual(request.id, requests[0].id, "Access and edit are distinct native requests")
         assert.deepEqual(request.source, requests[0].source, "Automatic continuation retains the exact source triple")
         assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 1,
           "Directory-to-edit continuation is native, not a second model tool invocation")
       }
       if (action === "external_directory") {
         assert.deepEqual(request.resources, [path.dirname(editTarget) + "/*"], "Exact outside-project directory boundary")
         assert.equal(request.metadata?.files, undefined, "Native access precedes edit preview construction")
       } else assert.deepEqual(request.resources, [writeTarget])
       inspection = await command({ type: "inspect", sessionID, requestID: request.id, epoch: handshake.epoch })
       inspections.push(inspection)
       assertWriteInspection(inspection, request, toolCall, sessionID, handshake)
       await publish(path.join(artifacts, `inspection-stage-${index + 1}.json`), inspection)
       await until(`production ${action} reviewer POST`, () => reviewPOSTs === index + 1 && reviewResponse)
       const evidence = JSON.parse(calls.filter(call => call.url === "/review/chat/completions")[index].body.messages[1].content)
       assertEvidenceRequest(evidence, request, sessionID, initial, handshake.project.id)
       assertWriteEvidence(evidence, { action, target: writeTarget, prompt, initial, project })
       const stage = { action, request, evidence, description: editDescriptions[index], countdown: undefined }
       editStages.push(stage)
       await until(`rendered evaluating ${action} panel`, () => capture().includes("Permission analysis"))
       await saveCapture(`stage-${index + 1}-evaluating`)
       const priorReplies = (await observations()).replied
       assert.deepEqual(priorReplies.map(reply => reply.requestID), requests.slice(0, index).map(item => item.id))
       const unresolved = async () => {
         const saved = await readHistory()
         if (saved) {
           assert.equal(saved.payloadCount, index, "Current unresolved report remains memory-only")
           assert.ok(saved.rows.every(row => JSON.parse(row.context).permission !== request.id))
         }
         const facts = await coverState()
         assert.deepEqual(facts.events.filter(event => event.type === "permissionResolved" && event.accepted)
           .map(event => event.context.permission), requests.slice(0, index).map(item => item.id))
         assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 1,
           "No native tool completion before the final edit stage releases")
       }
       await negativeWindow(`${action} review response held: unchanged file and native request`, [request], priorReplies,
         beforeEdit, index + 1, 1500, unresolved)
       assert.equal(reviewerTransactions[index].completed, false)
       finishReview()
       stage.countdown = await until(`physically painted normal ${action} countdown`, async () => {
         const proof = await presentation(), screen = capture()
         if (proof?.stage !== "frame" || proof.selected !== request.id || proof.root !== sessionID
           || !proof.final || !proof.finalReady || !proof.physical || proof.auto !== "countdown"
           || !screen.includes(stage.description.split("\n")[0]) || !/Allowed in \d+s/.test(screen)) return false
         assert.equal(proof.mouse, true)
         assert.equal(proof.mode, "base")
         const seconds = Number(screen.match(/Allowed in (\d+)s/)[1])
         assert.ok(seconds >= approvalDelaySeconds - 1, "Each stage gets its own fresh full normal countdown")
         return proof
       }, 15000)
       const accepted = await coverState()
       const acceptedEvents = accepted.events.filter(event => event.type === "reviewAccepted" && event.accepted
         && event.context.permission === request.id)
       assert.equal(acceptedEvents.length, 1, "One production accepted review for this exact permission stage")
       assert.equal(acceptedEvents[0].context.category, action)
       await saveCapture(`stage-${index + 1}-countdown`)
       await negativeWindow(`${action} countdown remains pending with no mutation`, [request], priorReplies,
         beforeEdit, index + 1, 1500, unresolved)
       // Admit only the impending production write after genuine physical proof.
       allowedReplies = index + 1
       allowWrites = true
       await until(`production exact once reply for ${action}`, record => record?.replied.length === index + 1)
       const replies = (await observations()).replied
       assert.deepEqual(replies.map(reply => reply.requestID), requests.map(item => item.id))
       assert.deepEqual(replies.map(reply => reply.reply), Array(index + 1).fill("once"))
       if (action === "external_directory") {
         assert.equal(await executed(), beforeEdit, "Access alone does not apply the native write")
         await until("automatic native continuation reaches the edit permission", record => record?.asked.length === 2)
         assert.equal((await observations()).asked[1].action, "edit")
         assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 1)
       } else await until("native write applies exact requested contents", async () => await executed() === afterEdit)
       const saved = await until(`actual saved ${action} report and both aggregate scopes`, async () =>
         savedStageHistory(await readHistory(), editStages, sessionID), 20000)
       const facts = await coverState()
       const resolutions = facts.events.filter(event => event.type === "permissionResolved" && event.accepted
         && event.context.permission === request.id)
       assert.equal(resolutions.length, 1, "Exactly one qualifying production resolution saves this stage")
       assert.equal(resolutions[0].outcome, "auto")
       assert.equal(resolutions[0].context.category, action)
       stage.savedEntry = saved.rows.find(row => JSON.parse(row.context).permission === request.id).id
       stage.savedRow = saved.rows.find(row => row.id === stage.savedEntry)
       await publish(path.join(artifacts, `history-saved-stage-${index + 1}.json`), saved)
     }
     await until("actual native write tool-result continuation", () => calls.filter(call => call.url === "/v1/chat/completions").length === 2)
     const completed = await command({ type: "message", sessionID, messageID: request.source.messageID })
     const native = completed.content.filter(item => item.type === "tool" && item.id === toolCall.id)
     assert.equal(native.length, 1)
     assert.equal(native[0].name, "write")
     assert.equal(native[0].state.status, "completed")
     assert.deepEqual(native[0].state.input, toolCall.input)
     assert.equal(await executed(), afterEdit)
     await until("native write resolution clears reviewer panel", () => !capture().includes("Permission analysis"))
     historyEvidence = await until("all native stage reports, attempts, confirmations and independent totals", async () =>
       savedStageHistory(await readHistory(), editStages, sessionID), 20000)
     for (const key of ["rows", "reviews", "attempts", "approvals"]) assert.equal(historyEvidence[key].length, requestCount)
     for (const stage of editStages) assert.deepEqual(historyEvidence.rows.find(row => row.id === stage.savedEntry), stage.savedRow,
       "Later native continuation never rewrites a previously saved report")
     const finalFacts = await coverState()
     for (const type of ["reviewAccepted", "permissionResolved", "approvalConfirmed", "attemptDispatched", "attemptFinalized"]) {
       const events = finalFacts.events.filter(event => event.type === type && event.accepted)
       assert.equal(events.length, requestCount, `Exact ${type} count across stages`)
       assert.deepEqual(events.map(event => event.context.permission), requests.map(item => item.id))
       assert.deepEqual(events.map(event => event.context.category), editActions)
     }
     const replies = (await observations()).replied
     const stable = async () => {
       assert.deepEqual(await savedStageHistory(await readHistory(), editStages, sessionID), historyEvidence)
       assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 2)
     }
     await negativeWindow("resolved native write stages stay once-only with exact contents", [], replies, afterEdit,
       requestCount, 1500, stable)
     // Real painted palette activation and a production history postcondition,
     // never a fixture-created history row or direct browser callback.
     const historyCommand = await command({ type: "keymap", id: "reviewer.history" })
     assert.equal(historyCommand.registered, true)
     assert.equal(historyCommand.enabled, true)
     await activatePalette({ send: (...keys) => runtime.tmux("send-keys", "-t", "v2-review", ...keys),
       capture: () => runtime.tmux("capture-pane", "-p", "-e", "-t", "v2-review") }, historyCommand.title, async screen => {
       const record = await observations()
       return record?.mode === "base" && screen.includes("Analysis history") && screen.includes("V2 native edit report.")
         && screen.includes("Auto approved") && screen.includes(`${requestCount}/${requestCount}`)
     })
     await saveCapture("edit-history-latest")
     await negativeWindow("production history browsing cannot repeat native writes or reviews", [], replies, afterEdit,
       requestCount, 1500, async (record, screen) => {
         assert.deepEqual(record.route, { type: "session", sessionID })
         assert.match(screen, /Analysis history/)
         assert.match(screen, /V2 native edit report\./)
         assert.match(screen, /token: 23 in 11 out/)
         await stable()
       })
     runtime.tmux("send-keys", "-t", "v2-review", "Escape")
     await until("production edit history closes via real Escape", record => record?.mode === "base" && !capture().includes("Analysis history"))
     await publish(path.join(artifacts, "native-write-stages.json"), { toolCall, target: editTarget,
       before: beforeEdit, after: afterEdit, stages: editStages, completed, historyEvidence, facts: finalFacts })
   } else {
    request = await until("native shell permission", record => record?.asked[0])
   requests.push(request)
  assert.equal(request.sessionID, sessionID)
  assert.equal(request.action, "shell")
  assert.deepEqual(request.resources, [toolCall.input.command])
  assert.equal(request.source.type, "tool")
  assert.equal(request.source.id, toolCall.id)
    inspection = await command({ type: "inspect", sessionID, requestID: request.id, epoch: handshake.epoch })
    inspections.push(inspection)
   await publish(path.join(artifacts, "inspection.json"), inspection)
  assert.deepEqual(inspection.request, request)
  assert.equal(inspection.session.id, sessionID)
  assert.equal(inspection.session.parentID, undefined)
  assert.equal(inspection.session.location.directory, initial)
  assert.equal(inspection.session.projectID, handshake.project.id)
  assert.equal(inspection.message.id, request.source.messageID)
  const nativeTool = inspection.message.content.filter(item => item.type === "tool" && item.id === toolCall.id)
  assert.equal(nativeTool.length, 1)
  assert.equal(nativeTool[0].name, "shell")
  assert.equal(nativeTool[0].state.status, "running")
  assert.deepEqual(nativeTool[0].state.input, toolCall.input)
  assert.deepEqual(inspection.captured.request, request)
  assert.deepEqual(inspection.captured.invocation, { sessionID, assistantID: request.source.messageID, callID: toolCall.id,
    tool: "shell", input: toolCall.input, location: handshake.location, project: handshake.project, epoch: handshake.epoch })
  await until("production reviewer POST", () => reviewResponse)
  const payload = JSON.parse(calls.find(call => call.url === "/review/chat/completions").body.messages[1].content)
  const { metadataStatus, source, ...permission } = payload.permission
  assert.ok(metadataStatus)
  assert.deepEqual({ ...permission, source: { type: "tool", messageID: source.assistantID, id: source.id } }, request)
  assert.equal(payload.conversation.current.id, sessionID)
  assert.equal(payload.conversation.root.id, sessionID)
  assert.equal(payload.conversation.current.location.directory, initial)
  assert.equal(payload.conversation.current.projectID, handshake.project.id)
  assert.deepEqual(payload.limitations, ["Optional effective native tool definition is not included; exact captured arguments and pending permission scope are retained.",
    "Only literal Python/shell source and supported cat/head file operands are collected. Files are full review-time snapshots, not command output. Imports, dependencies, other runtimes and calls inside source files are not recursively inspected."])
  await until("rendered production evaluating panel", () => capture().includes("Permission analysis"))
  await saveCapture("evaluating")
   await negativeWindow("review response held", [request], [], null, 1, 1500, notificationCase ? noAttention : savedCase ? noSavedBody : () => {})
   if (descendant || hiddenComplete) {
    childSession = await command({ type: "child", sessionID })
    assert.equal(childSession.parentID, sessionID)
    assert.equal(childSession.location.directory, initial)
    assert.equal(childSession.projectID, handshake.project.id)
    await publish(path.join(artifacts, "child.json"), childSession)
  }
   if (fast) {
    if (descendant) {
      await navigate(childSession.id)
      await until("reviewer absent before fast Safe preview", () => !capture().includes("Permission analysis"))
      await saveCapture("descendant-before-preview")
      await negativeWindow("descendant route before fast preview has no reply", [request], [], null, 1, 1500, hiddenDescendant)
     } else if (dialogCase) {
       presentationEvidence = { cover: await openPalette() }
       await negativeWindow("native modal owns input before fast preview is released", [request], [], null, 1, 1500, paletteCover)
     }
     if (decisionCase) {
       runtime.tmux("send-keys", "-t", "v2-review", "Right")
       await until("actual native Always selection before fast preview", record => record?.choices.always === true && record.choices.once === false)
     } else allowWrites = true
      sse(reviewResponse, '{"safe":true,"desc":' + JSON.stringify(description).slice(0, -1))
      if (decisionCase) {
        await negativeWindow("native Always selection holds fast Safe preview without a reply", [request], [], null, 1, 1500, async record => {
          assert.equal(record.choices.always, true)
          assert.equal(reviewCompleted, false)
          await noSavedBody()
        })
        allowWrites = true
        runtime.tmux("send-keys", "-t", "v2-review", "Left")
      }
       await until("production fast once reply and marker execution", async record => record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
       assert.equal(reviewCompleted, false, "Fast approval must precede terminal assessment/EOF")
       if (!descendant) await until("rendered retained fast report", () => {
        const screen = capture()
        return screen.includes("Permission analysis") && screen.includes("✓ Safe") && screen.includes("V2 local marker report.")
          && screen.includes("Auto-approved; finishing report") && !screen.includes("Allowed in")
      })
       await saveCapture("fast-retained")
       if (descendant) hiddenDescendant(await observations(), capture())
       if (dialogCase) {
         assert.equal((await observations()).mode, "modal")
         assert.match(capture(), /Commands/)
       }
      if (notificationCase) {
        await until("native tool continuation while reviewer response remains held", () => calls.filter(call => call.url === "/v1/chat/completions").length === 2)
        const value = await until("approved banner before retained stream EOF", async () => {
          const value = await notificationObservations()
          return value.events.some(event => event.event === "show") && value
        })
        assert.equal(reviewCompleted, false, "Approval banner arrives before SSE terminal framing and EOF")
        assert.equal(value.owned, 1, "The spy owns one live notification handle")
        assert.equal(value.disposed, false)
        assert.equal(value.config.notify, true)
        assert.equal(value.config.notifySound, false)
        assert.deepEqual(value.config.notifications.ended, { banner: false, sound: false })
        assert.deepEqual(value.config.notifications.error, { banner: false, sound: false })
        const shown = value.events.filter(event => event.event === "show")
        assert.equal(shown.length, 1)
        notificationEvidence = { beforeEOF: value, id: shown[0].id }
        await publish(path.join(artifacts, "notification-before-eof.json"), notificationEvidence)
        const hidden = await nativePresentationCommand("session.sidebar.toggle")
        assert.equal(hidden.title, "Hide sidebar")
        await until("native sidebar hides the retained report before its approval click", record =>
          record?.sidebarCommand?.title === "Show sidebar" && !capture().includes("Permission analysis"))
        await negativeWindow("hidden retained report does not reveal itself without an explicit click", [], (await observations()).replied,
          "V2_REVIEW_EXECUTED\n", 1, 500, async record => {
            assert.equal(record.sidebarCommand?.title, "Show sidebar")
            assert.equal(reviewCompleted, false)
          })
        await clickNotification(notificationEvidence.id)
        await until("retained approval click reveals the actual absent native sidebar", record =>
          record?.sidebarCommand?.title === "Hide sidebar" && capture().includes("Auto-approved; finishing report"))
      }
      await negativeWindow("fast retained response has no duplicate reply or execution", [], (await observations()).replied, "V2_REVIEW_EXECUTED\n", 1,
        1500, notificationCase ? async (record, screen) => {
          assert.equal(reviewCompleted, false)
          assert.deepEqual(record.route, { type: "session", sessionID })
          assert.match(screen, /Auto-approved; finishing report/)
          assert.doesNotMatch(screen, /Analysis history|Loading history/)
          const value = await notificationObservations()
          assert.equal(value.events.filter(event => event.event === "show").length, 1)
          assert.equal(value.events.filter(event => event.event === "click").length, 1)
          assert.deepEqual(value.historyCalls, [], "Retained click does not open production history")
          assert.equal(value.history.open, false)
          assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 2)
          await noSavedBody()
         } : savedCase ? noSavedBody : () => {})
       finishReview()
   } else {
     if (hiddenComplete) {
       await navigate(childSession.id)
       await until("normal report route-hidden before completion", () => !capture().includes("Permission analysis"))
       await negativeWindow("never-armed normal response is held on a native child route", [request], [], null, 1, 1500, hiddenDescendant)
       presentationEvidence = { lastRootProof: await presentation() }
     }
      if (scenario === "normal-cancel") {
        // Plugin setup and physical paint can precede native terminal startup.
        // Keep the model response held until that startup notice clears, so the
        // real mouse-input test does not race the host's input initialization.
        await until("native startup settled before the Cancel input test", record =>
          record?.frame && record.mouse && record.mode === "base" && !capture().includes("Finishing startup"))
        await saveCapture("cancel-input-ready")
      }
      if (hiddenComplete) allowWrites = true
      finishReview()
      if (hiddenComplete) {
       presentationEvidence.hiddenAccepted = await until("actual normal final acceptance while native child route hides reviewer", async () => {
         const facts = await coverState(), saved = await readHistory()
         if (!facts.events.some(event => event.type === "reviewAccepted" && event.accepted)
           || !saved?.reviews[0]?.accepted || !saved.attempts[0]?.finalized) return false
         assert.equal(saved.reviews.length, 1)
         assert.equal(saved.attempts.length, 1)
         assert.equal(JSON.parse(saved.reviews[0].context).permission, request.id)
         assert.equal(JSON.parse(saved.reviews[0].accepted).safe, true)
         assert.equal(saved.payloadCount, 0)
         return { facts, saved }
       }, 15000)
       await saveCapture("normal-hidden-completed")
        await until("never-displayed normal Safe report approves on the descendant route", async record =>
          record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
        hiddenDescendant(await observations(), capture())
        await navigate(sessionID)
      } else {
    await until("rendered validated Safe report", () => {
      const screen = capture()
      return screen.includes("Permission analysis") && screen.includes("✓ Safe") && screen.includes("V2 local marker report.")
        && screen.includes("The script writes one isolated marker.")
    })
    await saveCapture("safe-report")
    if (scenario === "advisory") {
      await negativeWindow("completed advisory report remains pending", [request], [], null, 1, 1500, noSavedBody)
      assert.doesNotMatch(capture(), /Allowed in/)
      await command({ type: "interrupt", sessionID })
      await negativeWindow("advisory interruption has no approval or execution", [], [], null, 1)
    } else if (mouseOff) {
      const proof = await until("completed mouse-off report observation", async () => {
        const value = await presentation()
        return value?.final && value.contentMatches && value.painted && !value.streaming && value
      })
      assert.equal(proof.mouse, false)
      assert.equal(proof.physical, false)
       assert.equal(proof.auto, "countdown")
       await publish(path.join(artifacts, "mouse-off-proof.json"), proof)
       allowWrites = true
       await until("Safe report approves without mouse tracking", async record => record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
       assert.equal((await observations()).mouse, false)
       await saveCapture("mouse-off-approved")
    } else {
      const proof = await until("painted normal countdown", async () => {
        const value = await presentation()
        return value?.stage === "frame" && value.auto === "countdown" && value.physical && value.final
          && value.root === sessionID && /Allowed in \d+s/.test(capture()) && value
      }, 15000)
       assert.equal(proof.mouse, true)
        if (visibilityLoss) {
         const seconds = Number(capture().match(/Allowed in (\d+)s/)?.[1])
         assert.ok(seconds >= approvalDelaySeconds - 1, "A freshly painted countdown, well before its approval threshold")
          presentationEvidence = { countdown: proof }
       }
      await publish(path.join(artifacts, "countdown-proof.json"), proof)
      await saveCapture("countdown")
       if (visibilityLoss) {
         const before = (await observations()).frame
         if (scenario === "normal-hide") {
           presentationEvidence.native = await nativePresentationCommand("session.sidebar.toggle")
           assert.equal(presentationEvidence.native.title, "Hide sidebar")
           await until("native sidebar actually hides during the countdown", record => {
             try { hiddenSidebar(record, capture()); return record.frame.id > before.id } catch { return false }
           }, 3000)
         } else if (dialogCase) presentationEvidence.cover = await openPalette()
         else {
           resizeWindow(8)
           await until("native host receives actual short tmux geometry", record => record?.terminal.height === 8
             && record.terminal.width === 160 && record.frame?.height === 8 && record.frame.id > before.id, 3000)
         }
         allowWrites = true
         await until("normal countdown approves without restoring native presentation", async record =>
           record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
         const record = await observations(), screen = capture()
         if (scenario === "normal-hide") hiddenSidebar(record, screen)
         else if (dialogCase) { assert.equal(record.mode, "modal"); assert.match(screen, /Commands/) }
         else assert.deepEqual(record.terminal, { width: 160, height: 8 })
         assert.doesNotMatch(screen, /Auto-approval canceled/)
         await saveCapture("native-presentation-background-approved")
         if (scenario === "normal-hide") {
           const native = await nativePresentationCommand("session.sidebar.toggle")
           assert.equal(native.title, "Show sidebar")
         } else if (dialogCase) runtime.tmux("send-keys", "-t", "v2-review", "Escape")
         else resizeWindow(40)
         await until("native UI restoration after background approval", record => record?.mode === "base" && record.terminal.height === 40)
         await publish(path.join(artifacts, "native-presentation-background-proof.json"), presentationEvidence)
       } else if (scenario === "normal-cancel") {
        const rows = capture().split("\n"), row = rows.findIndex(line => /Allowed in \d+s/.test(line) && line.includes("Cancel"))
        assert.ok(row >= 0, "Actual painted countdown and Cancel control share a row")
        const index = rows[row].indexOf("Cancel")
        assert.ok(index >= 0)
        const column = Array.from(rows[row].slice(0, index)).length
        // SGR coordinates are one-based. Click the painted label interior,
        // never invoke the callback or fabricate presentation readiness.
        const x = column + 2, y = row + 1
        await publish(path.join(artifacts, "cancel-click.json"), { x, y, row: rows[row], proof })
        runtime.tmux("send-keys", "-t", "v2-review", "-l", `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`)
        await until("real Cancel click tombstone", () => capture().includes("Auto-approval canceled"), 3000)
        await saveCapture("cancelled")
        await negativeWindow("Cancel remains manual past the original countdown", [request], [], null, 1,
          approvalDelaySeconds * 1000 + 1500, cancelledRoot)
        await interruptPending()
       } else if (descendant) {
        await navigate(childSession.id)
        await until("reviewer absent after countdown route loss", () => !capture().includes("Permission analysis"))
         await saveCapture("descendant-countdown-running")
         allowWrites = true
         await until("normal countdown approves while descendant-hidden", async record => record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
         hiddenDescendant(await observations(), capture())
         await navigate(sessionID)
       } else if (routeWait || decisionCase) {
         if (decisionCase) {
           runtime.tmux("send-keys", "-t", "v2-review", "Right")
           await until("native Always choice owns the pending decision", record => record?.choices.always === true && record.choices.once === false)
           await negativeWindow("Always selection waits past the original countdown without cancellation", [request], [], null, 1,
             approvalDelaySeconds * 1000 + 1500, record => { assert.equal(record.choices.always, true); assert.doesNotMatch(capture(), /Auto-approval canceled/) })
           assert.match(capture(), /Auto-approval waiting/)
         } else {
           for (const destination of ["home", "dashboard", "other"]) {
             const away = await command({ type: "away", destination })
             assert.notDeepEqual(away, { type: "session", sessionID })
             await negativeWindow(`${destination} waits without cancelling the Safe request`, [request], [], null, 1,
               approvalDelaySeconds * 1000 + 1500, record => assert.deepEqual(record.route, away))
           }
         }
         allowWrites = true
         const resumed = performance.now()
         if (decisionCase) runtime.tmux("send-keys", "-t", "v2-review", "Left")
         else await navigate(sessionID)
         await until("waiting request resumes with its expired original deadline", async record => record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
         assert.ok(performance.now() - resumed < approvalDelaySeconds * 1000, "Resume must not restart the full countdown")
      } else {
         await negativeWindow("normal countdown remains pending", [request], [], null, 1, 1500, savedCase ? noSavedBody : () => {})
        allowWrites = true
         await until("production normal once reply and marker execution", async record => record?.replied.length === 1 && await executed() === "V2_REVIEW_EXECUTED\n")
     }
     }
   }
  }
   if (allowWrites) {
    await until("actual native tool-result continuation", () => calls.filter(call => call.url === "/v1/chat/completions").length === 2)
    const completed = await command({ type: "message", sessionID, messageID: request.source.messageID })
    const result = completed.content.filter(item => item.type === "tool" && item.id === toolCall.id)
    assert.equal(result.length, 1)
    assert.equal(result[0].name, "shell")
    assert.equal(result[0].state.status, "completed")
    assert.deepEqual(result[0].state.input, toolCall.input)
    assert.match(JSON.stringify(result[0].state), /V2_REVIEW_EXECUTED/)
    await until("production report cleared after completion", () => !capture().includes("Permission analysis"))
    await negativeWindow("resolved automatic request stays once-only", [], (await observations()).replied, "V2_REVIEW_EXECUTED\n", 1)
  }
   if (coverCase) {
     historyEvidence = await until("first actual saved automatic report and aggregates", savedHistory, 20000)
     coverEvidence = { first: historyEvidence, phases: [] }
     const phase = async (name, detail = {}) => {
       const value = { name, ...detail }
       coverEvidence.phases.push(value)
       await publish(path.join(artifacts, "history-cover-phase.json"), value)
     }
     await publish(path.join(artifacts, "history-saved-first.json"), historyEvidence)
     await openHistory()
      const firstHistory = await until("history observer selects the first actual saved entry with real keyboard ownership", async record => {
        try {
          const facts = await selectedOriginal(record, capture())
          assert.equal(facts.historyInput.keyboard, true)
          assert.equal(facts.historyInput.session, sessionID)
          assert.equal(facts.historyInput.mode, "base")
          assert.equal(facts.historyInput.mouse, true)
          assert.ok(Number.isInteger(facts.historyInput.frame) && facts.historyInput.frame > 0)
          return facts
        } catch { return false }
      }, 15000)
     await saveCapture("history-cover-first-open")
     const firstReplies = (await observations()).replied
     await negativeWindow("first saved report is selected before the second prompt exists", [], firstReplies, markerLine, 1, 1500, selectedOriginal)
      await phase("first-saved-history-painted", { request: requests[0], entry: historyEvidence.rows[0].id,
        historyInput: firstHistory.historyInput })
     // Same genuine text, script and root. Reused tool-call IDs are disambiguated
     // by the actual new assistant message and native permission source triple.
     mainResponse = undefined; reviewResponse = undefined; reviewCompleted = false
     await command({ type: "prompt", sessionID, text: prompt })
     await until("second genuine prompt reaches the controlled main model", () => mainResponse && calls.filter(call => call.url === "/v1/chat/completions").length === 3)
     await selectedOriginal(await observations(), capture())
     releaseNativeCall()
     request = await until("second actual native shell permission in the same root", record => record?.asked[1])
     requests.push(request)
     assert.notEqual(request.id, requests[0].id)
     assert.equal(request.sessionID, sessionID)
     assert.equal(request.action, "shell")
     assert.deepEqual(request.resources, [toolCall.input.command])
     assert.equal(request.source.type, "tool")
     assert.equal(request.source.id, toolCall.id)
     assert.notEqual(request.source.messageID, requests[0].source.messageID)
     inspection = await command({ type: "inspect", sessionID, requestID: request.id, epoch: handshake.epoch })
     inspections.push(inspection)
     assert.deepEqual(inspection.request, request)
     assert.equal(inspection.session.id, sessionID)
     assert.equal(inspection.session.parentID, undefined)
     assert.equal(inspection.session.location.directory, initial)
     assert.equal(inspection.session.projectID, handshake.project.id)
     assert.equal(inspection.message.id, request.source.messageID)
     const secondNative = inspection.message.content.filter(item => item.type === "tool" && item.id === toolCall.id)
     assert.equal(secondNative.length, 1)
     assert.equal(secondNative[0].name, "shell")
     assert.equal(secondNative[0].state.status, "running")
     assert.deepEqual(secondNative[0].state.input, toolCall.input)
     assert.deepEqual(inspection.captured.request, request)
     assert.deepEqual(inspection.captured.invocation, { sessionID, assistantID: request.source.messageID, callID: toolCall.id,
       tool: "shell", input: toolCall.input, location: handshake.location, project: handshake.project, epoch: handshake.epoch })
     await publish(path.join(artifacts, "inspection-second.json"), inspection)
     await until("second production reviewer POST from actual captured native evidence", () => reviewPOSTs === 2 && reviewResponse)
     const secondPayload = JSON.parse(calls.filter(call => call.url === "/review/chat/completions")[1].body.messages[1].content)
     const { metadataStatus: secondMetadata, source: secondSource, ...secondPermission } = secondPayload.permission
     assert.ok(secondMetadata)
     assert.deepEqual({ ...secondPermission, source: { type: "tool", messageID: secondSource.assistantID, id: secondSource.id } }, request)
     assert.equal(secondPayload.conversation.current.id, sessionID)
     assert.equal(secondPayload.conversation.root.id, sessionID)
     assert.equal(secondPayload.conversation.current.location.directory, initial)
     assert.equal(secondPayload.conversation.current.projectID, handshake.project.id)
     assert.deepEqual(secondPayload.limitations, payload.limitations)
     await phase("second-native-review-held-behind-history", { request })
     const unchangedFirst = async (record, screen) => {
       await selectedOriginal(record, screen)
       const value = await readHistory()
       assert.equal(value.payloadCount, 1, "Second unresolved report is not persisted")
       assert.deepEqual(value.rows, coverEvidence.first.rows)
       assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 3)
     }
      await negativeWindow("second held review has no approval while saved history remains selected", [request], firstReplies, markerLine, 2, 1500, unchangedFirst)
      if (fast) {
        allowedReplies = 2
        sse(reviewResponse, '{"safe":true,"desc":' + JSON.stringify(description).slice(0, -1))
        await phase("second-fast-safe-preview-behind-history")
        await until("fast Safe preview approves underneath production history", async record => record?.replied.length === 2 && await executed() === markerLine.repeat(2))
        assert.equal(reviewCompleted, false, "Fast approval still precedes terminal report validation")
        await selectedOriginal(await observations(), capture())
        await negativeWindow("history-covered fast remainder cannot duplicate execution or save an unfinished body", [], (await observations()).replied,
          markerLine.repeat(2), 2, 1500, async (record, screen) => {
            await selectedOriginal(record, screen)
            assert.equal((await readHistory()).payloadCount, 1)
          })
        await saveCapture("history-cover-fast-preview")
        finishReview()
        await phase("second-fast-final-eof-behind-history")
        await saveCapture("history-cover-fast-final")
     } else {
       finishReview()
        coverEvidence.countdown = await until("completed normal countdown FRAME behind history with actual keyboard ownership", async record => {
          const value = await presentation(), facts = await selectedOriginal(record, capture())
          if (value?.stage !== "frame" || value.selected !== request.id || value.root !== sessionID
            || value.physical !== false || !value.final || !value.finalReady || value.auto !== "countdown"
            || facts.historyInput?.keyboard !== true) return false
          assert.equal(value.mouse, true)
          assert.equal(value.mode, "base")
          assert.equal(facts.historyInput.session, sessionID)
          assert.equal(facts.historyInput.mouse, true)
          assert.equal(facts.historyInput.mode, "base")
          assert.ok(Number.isInteger(facts.historyInput.frame) && facts.historyInput.frame > 0)
          return { frame: value, historyInput: facts.historyInput, history: facts.history }
        }, 15000)
        await phase("second-normal-countdown-behind-history-independent-of-input-ownership", { proof: coverEvidence.countdown })
       await saveCapture("history-cover-normal-countdown")
       await negativeWindow("normal second countdown stays pending under production history", [request], firstReplies, markerLine, 2, 1500, unchangedFirst)
       allowedReplies = 2
     }
     await until("second production once reply and exact second native execution", async record => record?.replied.length === 2 && await executed() === markerLine.repeat(2))
     assert.deepEqual((await observations()).replied.map(reply => reply.requestID), requests.map(request => request.id))
     await until("second actual native tool-result continuation", () => calls.filter(call => call.url === "/v1/chat/completions").length === 4)
     const secondCompleted = await command({ type: "message", sessionID, messageID: request.source.messageID })
     const secondResult = secondCompleted.content.filter(item => item.type === "tool" && item.id === toolCall.id)
     assert.equal(secondResult.length, 1)
     assert.equal(secondResult[0].name, "shell")
     assert.equal(secondResult[0].state.status, "completed")
     assert.deepEqual(secondResult[0].state.input, toolCall.input)
     assert.match(JSON.stringify(secondResult[0].state), /V2_REVIEW_EXECUTED/)
     coverEvidence.pair = await until("two actual worker-saved reports and exact aggregate counts", savedPair, 20000)
     await publish(path.join(artifacts, "history-saved-pair.json"), coverEvidence.pair)
     if (!fast) {
       await until("history refresh preserves first entry with second row present", async record => {
         try { return await selectedOriginal(record, capture(), 2) } catch { return false }
       }, 15000)
       await saveCapture("history-cover-normal-two-saved")
     }
     await phase("two-confirmed-once-writes-two-saved-reports", { entries: coverEvidence.pair.rows.map(row => row.id) })
      await negativeWindow("second resolution cannot replay either approval or execution", [], (await observations()).replied, markerLine.repeat(2), 2, 1500, async (record, screen) => {
        await selectedOriginal(record, screen, 2)
        assert.deepEqual(await savedPair(), coverEvidence.pair)
        assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 4)
       })
      if (fast) {
        runtime.tmux("send-keys", "-t", "v2-review", "Escape")
        await until("production history closes after fast background approval and save", record => record?.mode === "base" && !capture().includes("Analysis history"))
      }
      if (keyboardMouseOffCase) {
        const replies = (await observations()).replied, before = (await observations()).frame
        assert.equal((await observations()).mouse, true, "Actual approvals and saves occurred with configured mouse on")
        assert.deepEqual(await command({ type: "pending", sessionID }), [])
        assert.deepEqual(await command({ type: "mouse", value: false, sessionID }), { mouse: false })
        coverEvidence.keyboard = { beforeMouseDisable: before, selection: [], scrolling: [] }
         // A real native palette open/close invalidates input ownership, then
         // requires fresh root FRAME geometry without remounting history.
        await nativePresentationCommand("command.palette.show")
         const paletteFrame = await until("mouse-off native palette paints a real modal frame and revokes history input", async record => {
           if (record?.mouse !== false || record.mode !== "modal" || record.frame?.mode !== "modal"
             || !(record.frame?.id > before.id) || !capture().includes("Commands")) return false
           const facts = await coverState(), input = facts.historyInput
           if (!input || input.mode !== "modal" || input.frame <= before.id || input.keyboard !== false) return false
           assert.equal(input.mouse, false)
           return record.frame
         }, 15000)
        runtime.tmux("send-keys", "-t", "v2-review", "Escape")
         coverEvidence.keyboard.input = await until("actual mouse-off history keyboard ownership after a fresh native root FRAME", async record => {
           if (record?.mouse !== false || record.mode !== "base" || record.frame?.mode !== "base"
             || !(record.frame?.id > paletteFrame.id) || capture().includes("Commands")) return false
           const facts = await selectedOriginal(record, capture(), 2), proof = facts.historyInput
           if (!proof || proof.frame <= paletteFrame.id || proof.mode !== "base" || proof.keyboard !== true) return false
           assert.equal(proof.mouse, false)
           assert.equal(proof.session, sessionID)
           return proof
         }, 15000)
         await saveCapture("history-keyboard-mouse-off-input")
        const stableKeyboard = async (record, screen) => {
          assert.deepEqual(record.route, { type: "session", sessionID })
           assert.equal(record.mouse, false, "Production preserves the explicit mouse-off user control")
           assert.equal(record.mode, "base")
           assert.equal(record.frame?.mode, "base")
           assert.ok(record.frame?.id > paletteFrame.id, "A genuine restored native FRAME precedes keyboard browsing")
          assert.match(screen, /Analysis history/)
          assert.match(screen, /✓ Safe/)
          assert.match(screen, /Auto approved/)
          assert.doesNotMatch(screen, /Permission analysis|Allowed in|Loading history|History could not be read|Commands/)
          const facts = await coverState()
          assert.equal(facts.history.open, true)
          assert.equal(facts.history.status, "ready")
          assert.equal(facts.history.total, 2)
           assert.equal(facts.historyInput.mouse, false)
           assert.equal(facts.historyInput.mode, "base")
           assert.equal(facts.historyInput.session, sessionID)
           assert.equal(facts.historyInput.keyboard, true, "Actual production history owns keyboard input")
           assert.ok(facts.historyInput.frame > paletteFrame.id)
          assert.deepEqual(await savedPair(), coverEvidence.pair, "Keyboard browsing never rewrites either report or accounting")
          assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 4)
          return facts.history
        }
        const selected = async (rank, record, screen) => {
          const history = await stableKeyboard(record, screen), row = coverEvidence.pair.rows[rank - 1]
          assert.equal(history.entry, row.id, "Keyboard selects the exact independently verified saved entry")
          assert.equal(history.rank, rank)
          assert.deepEqual(history.context, JSON.parse(row.context))
          assert.match(screen, new RegExp(`${rank}/2`))
          return history
        }
        // The production palette command reopens history on the latest real row.
        // Its actual selected rendition and behavioral postcondition are required.
        const historyCommand = await command({ type: "keymap", id: "reviewer.history" })
        assert.equal(historyCommand.registered, true)
        assert.equal(historyCommand.enabled, true)
        await activatePalette({ send: (...keys) => runtime.tmux("send-keys", "-t", "v2-review", ...keys),
          capture: () => runtime.tmux("capture-pane", "-p", "-e", "-t", "v2-review") }, historyCommand.title, async screen => {
          try { return await selected(2, await observations(), screen) } catch { return false }
        })
        await until("fresh history paint exposes the long saved second report at scroll zero", async record => {
          try {
            const history = await selected(2, record, capture())
            assert.equal(history.scroll, 0)
            assert.match(capture(), /Keyboard scroll line 01/)
            return history
          } catch { return false }
        }, 15000)
        await saveCapture("history-keyboard-mouse-off-latest")
        // Legacy tmux C-h is byte 0x08, which native OpenTUI treats as Backspace.
        // Send the actual xterm modifyOtherKeys encoding for an unambiguous Ctrl+H.
        runtime.tmux("send-keys", "-t", "v2-review", "-l", "\x1b[27;5;104~")
        await until("Ctrl+H closes mouse-off history", async record => record?.mode === "base"
          && !capture().includes("Analysis history") && !(await coverState()).history.open)
        runtime.tmux("send-keys", "-t", "v2-review", "-l", "\x1b[27;5;104~")
        await until("Ctrl+H reopens the latest saved report with mouse off", async record => {
          try {
            const history = await selected(2, record, capture())
            assert.equal(history.scroll, 0)
            return history
          } catch { return false }
        }, 15000)
        for (const [key, rank] of [["Left", 1], ["Right", 2]]) {
          const prior = (await coverState()).history
          runtime.tmux("send-keys", "-t", "v2-review", key)
          const history = await until("mouse-off real " + key + " selects saved rank " + rank, async record => {
            try {
              const value = await selected(rank, record, capture())
              assert.notEqual(value.entry, prior.entry)
              assert.equal(value.scroll, 0)
              return value
            } catch { return false }
          }, 15000)
          coverEvidence.keyboard.selection.push({ key, before: prior, after: history })
          await saveCapture("history-keyboard-mouse-off-" + key.toLowerCase())
          await negativeWindow("mouse-off " + key + " selection has no approval or new work", [], replies, markerLine.repeat(2), 2,
            1500, (record, screen) => selected(rank, record, screen))
        }
        for (const [key, direction, page] of [["Down", 1, false], ["Up", -1, false], ["PageDown", 1, true], ["PageUp", -1, true]]) {
          const prior = await selected(2, await observations(), capture()), priorScreen = capture()
          runtime.tmux("send-keys", "-t", "v2-review", key)
          const history = await until("mouse-off real " + key + " changes production scroll", async record => {
            try {
              const value = await selected(2, record, capture()), delta = (value.scroll - prior.scroll) * direction
              assert.ok(delta >= (page ? 2 : 1), "Actual production scroll changes in the requested direction, with a larger page step")
              assert.notEqual(capture(), priorScreen, "Real terminal content changes, not just a stored offset")
              return value
            } catch { return false }
          }, 15000)
          coverEvidence.keyboard.scrolling.push({ key, before: prior.scroll, after: history.scroll, entry: history.entry })
          await saveCapture("history-keyboard-mouse-off-" + key.toLowerCase())
          await negativeWindow("mouse-off " + key + " scroll has no approval or new work", [], replies, markerLine.repeat(2), 2,
            1500, async (record, screen) => {
              const value = await selected(2, record, screen)
              assert.equal(value.scroll, history.scroll, "The painted scroll offset remains stable")
            })
        }
        await publish(path.join(artifacts, "history-keyboard-mouse-off-proof.json"), coverEvidence.keyboard)
        runtime.tmux("send-keys", "-t", "v2-review", "Escape")
        await until("mouse-off history closes through actual Escape", record => record?.mode === "base" && !capture().includes("Analysis history"))
        await negativeWindow("closed mouse-off history cannot replay either once reply or execution", [], replies, markerLine.repeat(2), 2,
          1500, async (record, screen) => {
             assert.equal(record.mouse, false)
             assert.doesNotMatch(screen, /Analysis history|Permission analysis/)
             assert.equal((await coverState()).historyInput.keyboard, false, "Closed history no longer owns keyboard input")
            assert.deepEqual(await savedPair(), coverEvidence.pair)
            assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 4)
          })
      }
    }
   if (savedCase && !coverCase && !historyCase && !notificationCase && !editCase) {
     historyEvidence = await until("background automatic report and aggregates save normally", savedHistory, 20000)
     await publish(path.join(artifacts, "background-saved-history.json"), historyEvidence)
   }
   if (scenario === "fast-dialog") {
     assert.equal((await observations()).mode, "modal", "The reviewer never closes the user's palette")
     runtime.tmux("send-keys", "-t", "v2-review", "Escape")
     await until("user closes palette after fast background report is saved", record => record?.mode === "base")
   }
   if (historyCase) {
    historyEvidence = await until("actual worker-saved history and aggregate commits", savedHistory, 20000)
    if (defaultHomeCase) {
      assert.equal(historyEvidence.file, path.join(env.HOME,
        ".local/state/opencode-reviewer-state/opencode-reviewer/history-v1.sqlite"), "Actual saved database uses the private plugin-owned sibling")
      const pluginState = await lstat(path.join(stateBase, "opencode-reviewer-state"))
      assert.ok(pluginState.isDirectory() && !pluginState.isSymbolicLink())
      assert.equal(pluginState.mode & 0o777, 0o700, "Fallback namespace is private")
      await assertDefaultHomeStorage()
    }
    await publish(path.join(artifacts, "history-saved.json"), historyEvidence)
    const replies = (await observations()).replied
    const stableHistory = async (record, screen) => {
      historyScreen(record, screen)
      assert.deepEqual(await savedHistory(), historyEvidence, "Browsing never rewrites history or accounting")
      assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 2)
    }
    await openHistory()
    await saveCapture("history-open")
    await negativeWindow("production history browsing has no additional work", [], replies, "V2_REVIEW_EXECUTED\n", 1, 1500, stableHistory)
    childSession = await command({ type: "child", sessionID })
    assert.equal(childSession.parentID, sessionID)
    await publish(path.join(artifacts, "child.json"), childSession)
    await navigate(childSession.id)
    await until("history absent on actual child route", () => !capture().includes("Analysis history"))
    const childCommand = await command({ type: "keymap", id: "reviewer.history", dispatch: true })
    assert.equal(childCommand.enabled, false, "History command cannot browse from a descendant route")
    await saveCapture("history-descendant-hidden")
    await negativeWindow("child route has no reviewer history or new work", [], replies, "V2_REVIEW_EXECUTED\n", 1, 1500, (record, screen) => {
      assert.deepEqual(record.route, { type: "session", sessionID: childSession.id })
      assert.doesNotMatch(screen, /Analysis history|Permission analysis|V2 local marker report\./)
      assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 2)
    })
    await navigate(sessionID)
    await openHistory()
    await saveCapture("history-root-reopened")
    await negativeWindow("root reopen selects the exact same single entry", [], replies, "V2_REVIEW_EXECUTED\n", 1, 1500, stableHistory)
    // Genuine base-mode Escape, not a fixture callback/controller close, before
    // opening the production native modal. History must not consume modal input.
    runtime.tmux("send-keys", "-t", "v2-review", "Escape")
    await until("history keyboard close", record => record?.mode === "base" && !capture().includes("Analysis history"))
    await saveCapture("history-keyboard-closed")
    const statisticsCommand = await command({ type: "keymap", id: "reviewer.lifetime", dispatch: true })
    assert.equal(statisticsCommand.registered, true)
    assert.equal(statisticsCommand.enabled, true)
    const statisticsScreen = (record, screen) => {
      assert.deepEqual(record.route, { type: "session", sessionID })
      assert.equal(record.mode, "modal", "Actual native statistics dialog owns the input mode")
      assert.match(screen, /Reviewer statistics/)
      assert.match(screen, /Conversation/)
      assert.match(screen, /Lifetime/)
      assert.match(screen, /Tab: switch view/)
      assert.match(screen, /Reviews: 1/)
      assert.match(screen, /Retries: 0/)
      assert.match(screen, /Tokens: 23 in 11 out/)
      assert.match(screen, /Safe: 1 \(100\.0%\)/)
      assert.match(screen, /Unsafe: 0 \(0\.0%\)/)
      assert.match(screen, /Auto-approved: 1 \(100\.0%\)/)
      assert.doesNotMatch(screen, /Analysis history|Permission analysis|Loading recorded usage|statistics unavailable/)
      assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 2)
    }
    await until("rendered native lifetime statistics dialog", record => {
      try { statisticsScreen(record, capture()); return true } catch { return false }
    }, 15000)
    await saveCapture("statistics-lifetime")
    await negativeWindow("native lifetime statistics has no additional work", [], replies, "V2_REVIEW_EXECUTED\n", 1, 1500, statisticsScreen)
    const tabRendition = () => {
      const row = runtime.tmux("capture-pane", "-p", "-e", "-t", "v2-review").split("\n")
        .find(line => line.includes("Conversation") && line.includes("Lifetime"))
      assert.ok(row, "Both native statistics scope tabs are physically painted")
      return row
    }
    const lifetimeTabs = tabRendition()
    runtime.tmux("send-keys", "-t", "v2-review", "Tab")
    await until("native Tab changes selected scope rendition", () => tabRendition() !== lifetimeTabs, 5000)
    await until("rendered native conversation statistics", record => {
      try { statisticsScreen(record, capture()); return true } catch { return false }
    }, 15000)
    await negativeWindow("native conversation statistics has no additional work", [], replies, "V2_REVIEW_EXECUTED\n", 1, 1500, statisticsScreen)
    await saveCapture("statistics-conversation")
    const conversationTabs = tabRendition()
    runtime.tmux("send-keys", "-t", "v2-review", "Tab")
    await until("second native Tab restores lifetime scope rendition", () => tabRendition() === lifetimeTabs, 5000)
    await publish(path.join(artifacts, "statistics-native-tabs.json"), { lifetimeTabs, conversationTabs, restoredTabs: tabRendition() })
    runtime.tmux("send-keys", "-t", "v2-review", "Escape")
    await until("native statistics keyboard close", record => record?.mode === "base" && !capture().includes("Reviewer statistics"))
    assert.deepEqual(await savedHistory(), historyEvidence, "All production browsing/statistics leaves saved truth unchanged")
    await negativeWindow("closed history and statistics cannot replay work", [], replies, "V2_REVIEW_EXECUTED\n", 1)
  }
  if (notificationCase) {
    historyEvidence = await until("fast final report saved by actual SQLite worker", savedHistory, 20000)
    await publish(path.join(artifacts, "history-saved.json"), historyEvidence)
    const beforeClick = await notificationObservations()
    assert.deepEqual(beforeClick.historyCalls, [], "Retained click cannot open history later after report completion")
    assert.equal(beforeClick.history.open, false)
    await clickNotification(notificationEvidence.id)
    await until("notification selects original saved permission", async record => {
      const value = await notificationObservations()
      if (!value.history.open || value.history.status !== "ready") return false
      assert.equal(value.history.entry, historyEvidence.rows[0].id)
      assert.deepEqual(value.history.context, historyEvidence.context)
      assert.deepEqual(value.historyCalls, [{ method: "openPermission", sessionID,
        target: { session: sessionID, permission: request.id } }], "Exact-target entrypoint only, never newest-history open")
      try { historyScreen(record, capture()); return value } catch { return false }
    }, 15000)
    await saveCapture("notification-history-open")
    await negativeWindow("same notification opens exact saved entry without work or replay", [], (await observations()).replied,
      "V2_REVIEW_EXECUTED\n", 1, 1500, async (record, screen) => {
        historyScreen(record, screen)
        const value = await notificationObservations()
        assert.equal(value.events.filter(event => event.event === "show").length, 1)
        assert.equal(value.events.filter(event => event.event === "click").length, 2)
        assert.equal(value.history.entry, historyEvidence.rows[0].id)
        assert.deepEqual(await savedHistory(), historyEvidence)
        assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, 2)
      })
    notificationEvidence.afterSavedClick = await notificationObservations()
  }
  if (scenario === "advisory") {
    const interrupted = (await observations()).interrupted
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0].sessionID, sessionID)
    assert.equal(interrupted[0].assistantMessageID, request.source.messageID,
      "Native interruption supplies exact ownership, not inferred manual approval")
    const saved = await until("exact linked advisory interruption saves only a cancelled report", async () => {
      const value = await readHistory()
      return value?.rows.length === 1 && value
    }, 15000)
    assert.equal(saved.payloadCount, 1)
    assert.equal(saved.approvals.length, 0, "Interruption is not approval")
    const row = saved.rows[0], context = JSON.parse(row.context), body = JSON.parse(row.body)
    assert.equal(context.root, sessionID)
    assert.equal(context.session, sessionID)
    assert.equal(context.permission, request.id)
    assert.equal(row.outcome, "cancelled")
    assert.equal(body.desc, description)
    assert.equal(body.safe, true)
    assert.equal(JSON.parse(saved.meta.totals).activity.autoApproved, 0)
    await publish(path.join(artifacts, "advisory-cancelled-history.json"), saved)
  }
   }
  assert.equal(reviewCompleted, true)
   assert.equal(reviewPOSTs, requestCount)
   assert.equal(calls.filter(call => call.url === "/v1/chat/completions").length, allowWrites ? nativeCallCount * 2 : 1)
  const final = await observations()
   assert.equal(final.asked.length, requestCount)
   assert.equal(final.replied.length, allowWrites ? requestCount : 0)
  assert.deepEqual(final.route, { type: "session", sessionID: fast && descendant ? childSession.id : sessionID })
  if (automatic) assert.equal(final.mouse, !mouseOff && !keyboardMouseOffCase)
  if (negative) assert.equal(await executed(), null)
  await saveCapture("final")
  // Notification acceptance also verifies production/backend teardown while the
  // host is alive. Other cases disable only the independent observer as before.
   await publish(cliPath, { ...cli, ...(keyboardMouseOffCase ? { mouse: false } : {}), plugins: notificationCase ? ["-opencode-reviewer", "-fixture.review.monitor"]
    : [cli.plugins[0], "-fixture.review.monitor"] })
  const cleaned = await until("monitor final flush/close", record => record?.cleaned && record)
  if (notificationCase) {
    notificationEvidence.cleaned = await until("production notification backend disposed and publisher closed", async () => {
      const value = await notificationObservations()
      return value.cleaned && value.disposed && value.owned === 0 && value
    })
    assert.equal(notificationEvidence.cleaned.events.filter(event => event.event === "disposed").length, 1)
    assert.equal(notificationEvidence.cleaned.events.filter(event => event.event === "close").length, 1)
  }
  await sleep(300)
  await assertDefaultHomeStorage()
  assert.deepEqual(await readObservation(monitorPath), cleaned, "No observer callback after final close")
  if (notificationCase) assert.deepEqual(await notificationObservations(), notificationEvidence.cleaned, "No backend publication after final close")
  await publish(path.join(artifacts, "results.json"), { outcome: "pass", version, scenario, temp, handshake, inspection,
        assessment, reviewCompleted, reviewPOSTs, calls, requests, inspections, childSession, historyEvidence, coverEvidence, notificationEvidence, presentationEvidence,
        ...(editCase ? { editStages, editTarget, beforeEdit, afterEdit } : {}), negativeWindows, observations: cleaned, execution: await executed(), limits })
  console.log(`PASS V2 installed production review ${scenario}: ${artifacts}`)
  console.log(`Isolated files: ${temp}`)
} catch (error) {
  await saveCapture("failed").catch(() => {})
  await publish(path.join(artifacts, "failure.json"), { version, scenario, temp, error: String(error), stack: error.stack,
       errors, handshake, inspection, request, requests, inspections, coverEvidence, presentationEvidence, calls, reviewPOSTs, reviewCompleted, negativeWindows, limits,
    ...(editCase ? { editStages, editTarget, beforeEdit, afterEdit } : {}),
    notifications: notificationCase ? await readObservation(notificationPath, { optional: true }).catch(() => null) : undefined,
    observations: await readObservation(monitorPath, { optional: true }).catch(() => null) })
  throw error
} finally {
  try { await runtime.dispose() }
  finally {
    if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)) }
    await Promise.all([...publishers.values()].map(publisher => publisher.close()))
  }
}
