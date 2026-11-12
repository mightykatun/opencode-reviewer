import type { NotificationConfig } from "./notification-config.js"
import { NotificationAudio } from "./notification-audio.js"
import { OwnedNotificationProcesses, NotificationProcessPool, type NotificationProcesses } from "./notification-process.js"
import { activateGnomeTerminal, gnomeTerminalIdentity, type TerminalIdentity } from "./notification-terminal.js"
import { notificationMarkup, notificationText, type NotificationBackend, type NotificationMessage, type NotificationClick, type NotificationClickLease } from "./notification-types.js"
import { actionable } from "./notification-queue.js"
import type { NotificationProcess } from "./notification-process.js"
import { NotificationIcon } from "./notification-icon.js"
import { uiText } from "./ui-text.js"
import { withDeadline } from "./deadline.js"

/** freedesktop/libnotify adapter. Action ownership is bounded to the banner lifetime. */
export class LinuxNotifications implements NotificationBackend {
  private stopped = false
  private abort = new AbortController()
  private audio: NotificationAudio
  private closers = new Set<() => void>()
  private closing = new Set<Promise<unknown>>()
  private icon = new NotificationIcon()
  private activation?: AbortController
  private start(...args: Parameters<NotificationProcesses["start"]>): NotificationProcess | undefined {
    try { return this.processes.start(...args) } catch { return undefined }
  }
  constructor(config: Pick<NotificationConfig, "notificationSoundDirectory" | "notify" | "notifySound">, private click: NotificationClick,
    private processes: NotificationProcesses = new OwnedNotificationProcesses(),
    private identity: TerminalIdentity | null = gnomeTerminalIdentity() ?? null,
    private platform: string = process.platform) {
    if (!(processes instanceof NotificationProcessPool)) this.processes = new NotificationProcessPool(processes)
    this.audio = new NotificationAudio(this.processes, config.notificationSoundDirectory)
  }
  async show(message: NotificationMessage, parent: AbortSignal) {
    if (this.stopped || parent.aborted || this.platform !== "linux") return
    const sessionID = message.sessionID
    const history = (message.kind === "approved" || message.kind === "steered") && message.history ? { ...message.history } : undefined
    const preparation = AbortSignal.any([parent, this.abort.signal])
    if (!message.banner) {
      if (!message.sound) return
      const local = new AbortController()
      const signal = AbortSignal.any([preparation, local.signal])
      let dispatch!: () => void
      const dispatched = new Promise<void>(resolve => { dispatch = resolve })
      const closed = this.audio.play(message.kind, signal, sessionID, dispatch).finally(dispatch)
      return { close: () => local.abort(), closed, dispatched }
    }
    const [icon, soundReady] = await Promise.all([
      this.icon.file(preparation, message.kind),
      message.sound ? this.audio.ready(message.kind, preparation) : false,
    ])
    if (this.stopped || parent.aborted) return
    const local = new AbortController()
    const signal = AbortSignal.any([parent, local.signal, this.abort.signal])
    let id: string | undefined, closed = false, delivered = false, clicked = false, token: string | undefined
    let ended = false, playback: Promise<void> | undefined, lease: NotificationClickLease | undefined, activation: AbortController | undefined
    let withdrawal: Promise<unknown> | undefined
    let lateClose: ReturnType<typeof setTimeout> | undefined
    let withdrawn = false
    const withdraw = () => {
      if (!id || withdrawn || ended) return
      withdrawn = true; clearTimeout(lateClose); local.abort()
      const process = this.start("gdbus", ["call", "--session", "--dest", "org.freedesktop.Notifications",
        "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.CloseNotification", id],
        1500, new AbortController().signal)
      if (process) {
        withdrawal = process.result
        this.closing.add(process.result)
        void process.result.then(() => this.closing.delete(process.result), () => this.closing.delete(process.result))
      }
    }
    const close = () => {
      if (closed) return
      closed = true
      activation?.abort(); lease?.cancel()
      if (ended) local.abort()
      this.closers.delete(close)
      if (id) withdraw()
      else lateClose = setTimeout(() => local.abort(), 1500)
    }
    this.closers.add(close)
    parent.addEventListener("abort", close, { once: true })
    const process = this.start("notify-send", [`--app-name=${uiText.notifications.application}`, ...(icon ? [`--icon=${icon}`] : []),
      // GNOME uses the desktop-entry's source icon, ignoring --icon there.
      // image-path supplies the separate image beside the notification heading.
      ...(icon ? [`--hint=string:image-path:${icon}`] : []),
      "--urgency=normal", "--expire-time=-1", "--transient", "--hint=boolean:suppress-sound:true", "--print-id",
      // GNOME emits an activation token only for a recognized application.
      ...(this.identity ? ["--hint=string:desktop-entry:org.gnome.Terminal"] : []),
      ...(this.identity ? [`--action=default=${history ? uiText.notifications.openReview : uiText.notifications.openSession}`] : []), "--wait", "--",
      // Summaries are plain text; only the body supports desktop markup.
      uiText.notifications.heading(notificationText(message.body)).replaceAll("\\", "\\\\"),
      uiText.notifications.body(notificationMarkup(message.title)).replaceAll("\\", "\\\\")],
      120000, AbortSignal.any([local.signal, this.abort.signal]), line => {
        if (/^[1-9][0-9]{0,9}$/.test(line)) {
          id = line
          if (closed || signal.aborted) { withdraw(); return }
          if (!delivered) {
            delivered = true
            if (soundReady) playback = this.audio.play(message.kind, signal, sessionID)
          }
        } else if (line === "default" && !clicked && !closed && !signal.aborted) {
          clicked = true
          this.activation?.abort()
          activation = this.activation = new AbortController()
          lease = this.click.begin?.(sessionID, history)
        } else {
          const match = /^(?:\*\* )?\(notify-send:\d+\): (?:libnotify-)?DEBUG: [\d:.]+: Activation Token: ([\x21-\x7e]{1,4096})$/.exec(line)
          if (match) token = match[1]
        }
      }, { lane: "banner", root: sessionID, attention: actionable(message.kind) })
    if (!process) { close(); parent.removeEventListener("abort", close); return }
    const settled = process.result.then(async () => {
      clearTimeout(lateClose)
      // notify-send normally exits when the banner is dismissed. Do not send a
      // second CloseNotification for an already-expired ID (it could be reused).
      ended = true
      // libnotify writes the token after the action name and closes its own
      // notification. Wait for EOF so token parsing is independent of chunking.
      const current = () => !closed && !signal.aborted && !activation?.signal.aborted && (!lease || lease.current())
      if (clicked && current()) {
        const signal = AbortSignal.any([this.abort.signal, parent, activation!.signal, ...(lease ? [lease.signal] : [])])
        const ok = await activateGnomeTerminal(this.processes, this.identity, signal, token).catch(() => false)
        if (ok && current()) { try { if (lease) lease.commit(); else this.click(sessionID, history) } catch {} }
      }
      await playback
      await withdrawal
    }).finally(() => {
      parent.removeEventListener("abort", close)
      this.closers.delete(close)
    })
    return { close, closed: settled, dispatched: process.started?.then(() => {}) }
  }
  async dispose() {
    this.stopped = true
    for (const close of [...this.closers]) close()
    this.abort.abort()
    const cleanup = Promise.allSettled([...this.closing, this.audio.dispose(), this.icon.dispose()])
    await withDeadline(new AbortController().signal, 2500, async () => { await cleanup }).catch(() => {})
    this.processes.dispose()
  }
}
