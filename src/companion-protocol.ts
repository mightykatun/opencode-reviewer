import path from "node:path"

export const pluginID = "opencode-reviewer"
export const companionProtocol = 2
/** Model-chosen read-only operations the companion executes for retrieval. */
export const retrievalToolNames = ["read", "list", "glob", "grep"] as const

/** Transport identity only. An epoch is never durable history/deletion authority. */
export interface CompanionHandshake {
  protocol: 2
  hostVersion: string
  epoch: string
  location: { directory: string; workspaceID?: string }
  project: { id: string; directory: string; canonical: string }
}

export function sameLocation(value: unknown, expected: CompanionHandshake["location"]): boolean {
  if (!value || typeof value !== "object") return false
  const location = value as Record<string, unknown>
  return location.directory === expected.directory && location.workspaceID === expected.workspaceID
}

/** Validate even injected/late responses before making their scope available. */
export function readHandshake(value: unknown, expected: CompanionHandshake["location"]): CompanionHandshake | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  // Host version is descriptive metadata, never evidence or admission authority.
  // The companion protocol and actual scoped public API contracts govern access.
  const validText = (item: unknown): item is string => typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 16384 && !item.includes("\0")
  if (record.protocol !== companionProtocol || !validText(record.hostVersion)
    || typeof record.epoch !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(record.epoch)
    || !sameLocation(record.location, expected) || !record.project || typeof record.project !== "object") return
  const project = record.project as Record<string, unknown>
  if (![expected.directory, project.id, project.directory, project.canonical].every(validText)
    || (expected.workspaceID !== undefined && !validText(expected.workspaceID))
    || ![expected.directory, project.directory, project.canonical].every(item => path.isAbsolute(item as string))) return
  return { protocol: companionProtocol, hostVersion: record.hostVersion, epoch: record.epoch,
    location: { ...expected }, project: { id: project.id as string, directory: project.directory as string, canonical: project.canonical as string } }
}
