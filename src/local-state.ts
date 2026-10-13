import path from "node:path"
import os from "node:os"
import { privateDatabase } from "./history-private-path.js"

/** Terminal-owned history/mode state only. Never an invocation evidence directory. */
export function localStateRoot(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = environment.XDG_STATE_HOME
  if (configured && path.isAbsolute(configured) && !configured.includes("\0")) return path.join(configured, "opencode")
  if (!path.isAbsolute(home) || home.includes("\0")) throw new Error("Local reviewer state directory unavailable")
  return path.join(home, ".local", "state", "opencode")
}

/** Keep safely accessible history in place, including concurrent terminal writes.
 * An unsuitable host-owned directory gets a plugin-owned sibling instead. Once
 * that sibling contains history it wins on restart, even if host modes change.
 * Mode records deliberately continue using localStateRoot, not this selection.
 */
export function historyStateRoot(stateDirectory: string): string {
  const sibling = path.join(path.dirname(stateDirectory), "opencode-reviewer-state")
  const database = (root: string) => path.join(root, "opencode-reviewer/history-v1.sqlite")
  try { if (privateDatabase(database(sibling), false)) return sibling } catch { /* Never read an unsafe existing sibling. */ }
  try {
    privateDatabase(database(stateDirectory), false)
    return stateDirectory
  } catch {
    // The worker validates the entire sibling namespace again before creation.
    // If its parent is unsuitable too, storage stays unavailable rather than
    // relaxing permissions or interfering with review and approval.
    return sibling
  }
}
