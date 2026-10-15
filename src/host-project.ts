import path from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import { boundedHostJSON } from "./host-request.js"
import { transportOwnership } from "./transport-ownership.js"
import type { HostInvocation } from "./host-types.js"

type Project = HostInvocation["project"]
const absolute = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value)
  && !value.includes("\0") && path.normalize(value) === value
const contains = (root: string, directory: string) => {
  const relative = path.relative(root, directory)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith("../"))
}

/** Registered metadata only, on the already connected server. Never discover a
 * location, inspect the filesystem, initialize a project, or use tool.workdir.
 * A session can acquire a Git project ID while its plugin location remains global.
 * Keep this current attribution separate from the immutable captured invocation. */
export async function registeredInvocationProject(client: OpenCodeClient, invocation: HostInvocation,
  projectID: string, signal: AbortSignal): Promise<Project> {
  const unavailable = () => new Error("Registered invocation project metadata unavailable or ambiguous")
  const owned = <T>(work: Promise<T>) => transportOwnership(signal)?.track(work) ?? work
  signal.throwIfAborted()
  const projects = boundedHostJSON(await owned(client.project.list({ archived: true }, { signal })))
  signal.throwIfAborted()
  if (!Array.isArray(projects)) throw unavailable()
  const matches = projects.filter(value => value && typeof value === "object" && !Array.isArray(value) && value.id === projectID)
  if (matches.length !== 1) throw unavailable()
  const project = matches[0] as { canonical?: unknown }
  if (!absolute(project.canonical)) throw unavailable()
  const entries = boundedHostJSON(await owned(client.worktree.list({ projectID }, { signal })))
  signal.throwIfAborted()
  if (!Array.isArray(entries)) throw unavailable()
  const directories = new Set([project.canonical])
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !absolute(entry.directory)) throw unavailable()
    directories.add(entry.directory)
  }
  const roots = [...directories].filter(root => contains(root, invocation.location.directory))
  if (roots.length !== 1) throw unavailable()
  return Object.freeze({ id: projectID, directory: roots[0]!, canonical: project.canonical })
}
