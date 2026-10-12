import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { NotificationAudio } from "../src/notification-audio.js"
import { LinuxNotifications } from "../src/notification-linux.js"
import { OwnedNotificationProcesses, type NotificationProcesses } from "../src/notification-process.js"
import { gnomeTerminalIdentity } from "../src/notification-terminal.js"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { desktopPlaybackCase } from "./smoke-desktop-playback.mjs"

runtimeArguments("smoke-notification-desktop.ts")

const owned = new OwnedNotificationProcesses()
let playback: ReturnType<typeof desktopPlaybackCase> | undefined
const completed: unknown[] = []
let deliveredAt: number | undefined
let notificationStartedAt: number | undefined
const processes: NotificationProcesses = {
  start(command, args, ms, signal, line) {
    if (command === "notify-send") notificationStartedAt = performance.now()
    if (command === "notify-send" && process.argv.includes("--critical")) {
      args = args.map(value => value === "--urgency=normal" ? "--urgency=critical" : value)
    }
    const player = command === "paplay" || command === "pw-play"
    let measurement: Promise<void> | undefined
    if (player) {
      assert.ok(playback, "player attempt must belong to an active logical case")
      assert.equal(args.at(-1)!.split("/").at(-1), `${playback.report().kind}.wav`, "player must match the current sound case")
      const deliveryToPlayerMs = deliveredAt === undefined ? undefined : performance.now() - deliveredAt
      const dispatchToPlayerMs = notificationStartedAt === undefined ? undefined : performance.now() - notificationStartedAt
      console.log(JSON.stringify({ player: command, deliveryToPlayerMs, dispatchToPlayerMs }))
      measurement = readFile(args.at(-1)!).then(bytes => {
        let square = 0, peak = 0
        for (let i = 44; i < bytes.length; i += 2) {
          const sample = bytes.readInt16LE(i) / 32768
          square += sample * sample; peak = Math.max(peak, Math.abs(sample))
        }
        const rms = Math.sqrt(square / ((bytes.length - 44) / 2))
        assert.ok(rms > 0 && rms <= 0.1001); assert.ok(peak <= 10 ** (-3 / 20) + 1 / 32768)
        console.log(JSON.stringify({ sound: args.at(-1)!.split("/").at(-1), rms, peak, normalizedBytes: bytes.length }))
      })
    }
    const task = owned.start(command, args, ms, signal, value => {
      if (command === "notify-send" && /^[1-9][0-9]*$/.test(value)) {
        deliveredAt = performance.now()
        console.log(JSON.stringify({ dispatchToDeliveryMs: notificationStartedAt === undefined ? undefined : deliveredAt - notificationStartedAt }))
      }
      if (process.argv.includes("--click")) console.log(`${command} event: ${JSON.stringify(value.replace(/Activation Token: .*/, "Activation Token: <redacted>"))}`)
      line?.(value)
    })
    if (player) playback!.observe(command, task?.result, measurement)
    if (task && process.argv.includes("--click")) void task.result.then(result => console.log(`${command}: exit ${result.code}; ${JSON.stringify(result.stdout.replace(/Activation Token: [^\n]*/g, "Activation Token: <redacted>"))}`))
    return task
  }, dispose: () => owned.dispose(),
}
if (process.argv.includes("--all")) {
  const backend = new LinuxNotifications({ notify: true, notifySound: true,
    notificationSoundDirectory: new URL("../sounds/", import.meta.url).pathname }, () => {
    console.log("Notification click activated the originating terminal.")
  }, processes)
  const cases = [
    { kind: "attention", title: "Session needs attention" },
    { kind: "unsafe", title: "Unsafe permission needs human approval" },
    { kind: "question", title: "Agent has a question" },
    { kind: "approved", title: "Reviewer approved a permission" },
    { kind: "error", title: "Session error" },
    { kind: "ended", title: "Session ended" },
  ] as const
  try {
    console.log("All notification/sound tests start in ten seconds.")
    await sleep(10000)
    for (const item of cases) {
      console.log(`SHOW ${item.title}; SOUND ${item.kind}`)
      playback = desktopPlaybackCase(item.kind)
      deliveredAt = notificationStartedAt = undefined
      const handle = await backend.show({ ...item, body: "Reviewer desktop sound test", sessionID: "desktop-fixture", banner: true, sound: true }, new AbortController().signal)
      assert.ok(handle, `${item.title} must reach the notification backend`)
      const result = await playback.wait()
      assert.notEqual(deliveredAt, undefined, `${item.title} banner must be delivered`)
      completed.push(result)
      console.log(JSON.stringify(result))
      // Give each banner time to be read before the following test.
      await sleep(1500)
      handle.close()
      await handle.closed
      playback = undefined
    }
    assert.equal(completed.length, cases.length)
    console.log("PASS: all six banners were delivered and each normalized sound had a successful player exit; attempts are reported per case.")
  } finally { if (playback) console.log(JSON.stringify(playback.report())); await backend.dispose() }
} else if (process.argv.includes("--sounds")) {
  const audio = new NotificationAudio(processes, new URL("../sounds/", import.meta.url).pathname)
  try {
    for (const kind of ["attention", "unsafe", "question", "approved", "error", "ended"] as const) {
      console.log(`PLAY ${kind}`)
      playback = desktopPlaybackCase(kind)
      await audio.play(kind, new AbortController().signal)
      const result = await playback.complete()
      completed.push(result)
      console.log(JSON.stringify(result))
      playback = undefined
      await sleep(300)
    }
    assert.equal(completed.length, 6, "all six logical sound cases must complete successful desktop playback")
    console.log("PASS: all six normalized sounds had a successful player exit; attempts are reported per case.")
  } finally { if (playback) console.log(JSON.stringify(playback.report())); await audio.dispose(); owned.dispose() }
} else if (process.argv.includes("--click")) {
  assert.ok(gnomeTerminalIdentity(), "run directly inside GNOME Terminal, outside tmux/SSH")
  let clicked = false
  const backend = new LinuxNotifications({ notify: true, notifySound: false }, () => {
    clicked = true
    console.log("PASS: actual notification click received; originating GNOME screen activation completed. Confirm visual window/tab focus separately.")
  }, processes)
  try {
    console.log("Switch to another terminal window/tab. Click the test banner when it appears.")
    await sleep(10000)
    for (let attempt = 0; attempt < (process.argv.includes("--critical") ? 1 : 3) && !clicked; attempt++) {
      const handle = await backend.show({ kind: "attention", title: "Session needs attention", body: "Reviewer activation test",
        sessionID: "desktop-fixture", banner: true, sound: false }, new AbortController().signal)
      for (let poll = 0; poll < (process.argv.includes("--critical") ? 150 : 60) && !clicked; poll++) await sleep(100)
      handle?.close()
    }
    assert.ok(clicked, "no real click/activation was observed during the transient banner tests")
  } finally { await backend.dispose() }
}
