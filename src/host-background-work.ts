import type { LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode/client"

/** Public activity that can invalidate an in-flight completion observation. */
export function notificationWorkEvent(event: OpenCodeEvent) {
  return event.type.startsWith("session.execution.") || event.type.startsWith("session.shell.")
    || event.type.startsWith("shell.") || event.type.startsWith("persistent-pty.")
    || event.type === "session.created" || event.type === "session.moved"
    || event.type === "experimental.job.updated"
}

export function notificationEvent(event: OpenCodeEvent) {
  return notificationWorkEvent(event) || event.type === "permission.asked" || event.type === "permission.replied"
    || event.type === "session.deleted" || event.type.startsWith("form.")
    || (event.type === "session.step.failed" && event.data.error.type === "aborted")
}

/** Only public ownership fields, never event timing or a shell's working directory. */
export function notificationSession(event: OpenCodeEvent): string | undefined {
  if (event.type === "form.created") return event.data.form.sessionID
  if (event.type === "experimental.job.updated") return event.data.info.sessionID
  if (event.type === "shell.created") {
    const id = event.data.info.metadata?.sessionID
    return typeof id === "string" ? id : undefined
  }
  if ("sessionID" in event.data && typeof event.data.sessionID === "string") return event.data.sessionID
}

/** Notification-only reads. Tool completion is not process completion after V2
 * backgrounds a blocking tool. Shell ownership is native metadata.sessionID;
 * persistent terminals have an explicit sessionID. Never use cwd or titles.
 * Shells are listed per location, so every location the family lives in is read. */
export async function hostBackgroundIdle(client: OpenCodeClient, locations: readonly LocationRef[],
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
  if (!locations.length) return false
  for (const location of locations) {
    const shells = await client.shell.list({ location }, { signal })
    signal.throwIfAborted()
    if (shells.location?.directory !== location.directory || !Array.isArray(shells.data) || shells.data.length > 16384) return false
    for (const shell of shells.data) {
      if (!shell.id || !["running", "exited", "timeout", "killed"].includes(shell.status)) return false
      if (shell.status === "running" && members.has(shell.metadata?.sessionID as string)) return false
    }
  }
  // Background shell, subagent and image jobs outlive the foreground turn. The
  // native list holds active and unconsumed jobs, whose result will wake the
  // session again, so any listed family job means the session has not ended.
  const jobs = await client.experimental.job.list({ sessionID: family[0], descendants: true }, { signal })
  signal.throwIfAborted()
  if (!Array.isArray(jobs) || jobs.length > 16384) return false
  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || !job.id || typeof job.sessionID !== "string") return false
    if (members.has(job.sessionID)) return false
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
