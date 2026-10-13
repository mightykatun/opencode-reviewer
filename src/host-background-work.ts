import type { LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode/client"

/** Public activity that can invalidate an in-flight completion observation. */
export function notificationWorkEvent(event: OpenCodeEvent) {
  return event.type.startsWith("session.execution.") || event.type.startsWith("session.shell.")
    || event.type.startsWith("shell.") || event.type.startsWith("persistent-pty.")
    || event.type === "session.created" || event.type === "session.moved"
}

/** Notification-only reads. Tool completion is not process completion after V2
 * backgrounds a blocking tool. Shell ownership is native metadata.sessionID;
 * persistent terminals have an explicit sessionID. Never use cwd or titles. */
export async function hostBackgroundIdle(client: OpenCodeClient, location: LocationRef,
  family: readonly string[], signal: AbortSignal) {
  signal.throwIfAborted()
  if (!family.length || family.length > 16384 || family.some(id => !id) || new Set(family).size !== family.length) return false
  const members = new Set(family)
  const active = await client.session.active({ signal })
  signal.throwIfAborted()
  if (!active || typeof active !== "object" || Array.isArray(active) || Object.keys(active).length > 16384) return false
  for (const [id, value] of Object.entries(active)) {
    if (!id || value?.type !== "running") return false
    if (members.has(id)) return false
  }
  const shells = await client.shell.list({ location }, { signal })
  signal.throwIfAborted()
  if (shells.location?.directory !== location.directory || !Array.isArray(shells.data) || shells.data.length > 16384) return false
  for (const shell of shells.data) {
    if (!shell.id || !["running", "exited", "timeout", "killed"].includes(shell.status)) return false
    if (shell.status === "running" && members.has(shell.metadata?.sessionID as string)) return false
  }
  let count = 0
  for (const sessionID of family) {
    signal.throwIfAborted()
    const terminals = await client.experimental.persistentPty.list({ sessionID }, { signal })
    signal.throwIfAborted()
    if (!Array.isArray(terminals) || (count += terminals.length) > 16384) return false
    for (const terminal of terminals) {
      if (!terminal.id || terminal.sessionID !== sessionID || !["running", "exited"].includes(terminal.status)) return false
      if (terminal.status === "running") return false
    }
  }
  return true
}
