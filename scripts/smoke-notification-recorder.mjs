import { copyFile, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** Record fixed desktop/audio process effects while exercising the actual bundle. */
export async function notificationRecorder(plugin, directory, { dismissAfterMs, holdFirstActionable = false } = {}) {
  const base = path.join(directory, "notification-reviewer-base.mjs")
  const records = path.join(directory, "notifications.jsonl")
  await copyFile(plugin, base)
  await writeFile(records, "")
  await writeFile(plugin, `
import plugin, { withNotificationProcesses, withNotifications } from ${JSON.stringify(pathToFileURL(base).href)}
import { appendFile, readFile } from "node:fs/promises"
let writes = Promise.resolve(), sequence = 1
const children = new Map()
const dismissals = new Set()
const record = data => { writes = writes.then(() => appendFile(${JSON.stringify(records)}, JSON.stringify({ at: Date.now(), ...data }) + "\\n")); writes.catch(() => {}) }
const processTui = withNotificationProcesses(() => ({
  start(command, args, ms, signal, line) {
    if (signal.aborted) return
    let finish
    const result = new Promise(resolve => { finish = resolve })
    let id
    signal.addEventListener("abort", () => finish({ code: null, stdout: "" }), { once: true })
    if (command === "notify-send") {
      id = String(sequence++)
      children.set(id, finish)
      const summary = args.at(-2)
      if (!summary.startsWith("Opencode (") || !summary.endsWith(")")) throw new Error("Unexpected notification heading")
      const title = args.at(-1), body = summary.slice("Opencode (".length, -1)
      record({ event: "notification", id, summary: args.at(-2), title, body, args })
      queueMicrotask(() => line?.(id))
      const dismissAfterMs = ${JSON.stringify(dismissAfterMs) ?? "undefined"}
      if (dismissAfterMs !== undefined) {
        const timer = setTimeout(() => {
          dismissals.delete(timer)
          if (!signal.aborted && children.has(id)) {
            record({ event: "dismiss", id }); children.delete(id); finish({ code: 0, stdout: "" })
          }
        }, dismissAfterMs)
        dismissals.add(timer)
      }
    } else if (command === "gdbus") {
      const id = args.at(-1)
      record({ event: "withdraw", id })
      children.get(id)?.({ code: 0, stdout: "" }); children.delete(id)
      finish({ code: 0, stdout: "()" })
    } else if (command === "paplay" || command === "pw-play") {
      readFile(args.at(-1)).then(bytes => {
        let peak = 0, squares = 0
        for (let i = 44; i < bytes.length; i += 2) {
          const value = bytes.readInt16LE(i) / 32768
          squares += value * value; peak = Math.max(peak, Math.abs(value))
        }
        record({ event: "sound", kind: args.at(-1).split("/").at(-1).replace(".wav", ""),
          bytes: bytes.length, rms: Math.sqrt(squares / ((bytes.length - 44) / 2)), peak })
        finish({ code: 0, stdout: "" })
      }, () => finish({ code: 1, stdout: "" }))
    } else finish({ code: 1, stdout: "" })
    return { result, cancel: () => finish({ code: null, stdout: "" }) }
  },
  dispose() {
    for (const timer of dismissals) clearTimeout(timer)
    dismissals.clear()
    for (const finish of children.values()) finish({ code: null, stdout: "" }); children.clear()
  },
}))
// A controlled backend, rather than Linux process I/O, for the pre-dispatch
// cancellation case. The held ticket has not dispatched either channel.
let held = false
const controlledTui = withNotifications(() => ({
  async show(message, signal) {
    if (signal.aborted) return
    if (!held && ['attention', 'unsafe'].includes(message.kind)) {
      held = true
      record({ event: 'backend-held', kind: message.kind })
      let close
      const closed = new Promise(resolve => { close = resolve })
      signal.addEventListener('abort', () => { record({ event: 'backend-cancelled', kind: message.kind }); close() }, { once: true })
      return { dispatched: new Promise(() => {}), closed, close }
    }
    record({ event: 'backend-dispatched', kind: message.kind, sound: message.sound, banner: message.banner })
    if (message.banner) record({ event: 'notification', title: message.title, body: message.body })
    if (message.sound) record({ event: 'sound', kind: message.kind, controlled: true })
    return { dispatched: Promise.resolve(), closed: Promise.resolve(), close() {} }
  }, dispose() {}
}))
const tui = ${holdFirstActionable} ? controlledTui : processTui
export default { id: plugin.id, tui: async (api, options) => {
  for (const type of ["permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected", "session.idle", "session.error"])
    api.event.on(type, event => record({ event: type, request: event.properties.requestID ?? event.properties.id,
      session: event.properties.sessionID, reply: event.properties.reply, error: event.properties.error?.name }))
  api.lifecycle.onDispose(() => writes)
  return tui(api, options)
} }
`)
  return async () => (await readFile(records, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
}

export function assertNotificationAudio(assert, records) {
  for (const sound of records.filter(record => record.event === "sound")) {
    assert.ok(sound.bytes > 44)
    assert.ok(sound.rms > 0 && sound.rms <= 0.1001)
    assert.ok(sound.peak <= 10 ** (-3 / 20) + 1 / 32768)
  }
}
