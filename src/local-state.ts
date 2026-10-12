import path from "node:path"
import os from "node:os"

/** Terminal-owned history/mode state only. Never an invocation evidence directory. */
export function localStateRoot(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = environment.XDG_STATE_HOME
  if (configured && path.isAbsolute(configured) && !configured.includes("\0")) return path.join(configured, "opencode")
  if (!path.isAbsolute(home) || home.includes("\0")) throw new Error("Local reviewer state directory unavailable")
  return path.join(home, ".local", "state", "opencode")
}
