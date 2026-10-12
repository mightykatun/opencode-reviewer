import type { FileIO } from "./file-access.js"
import type { DiagnosticObserver } from "./diagnostics.js"
import type { HistoryRenderProbe, NotificationBackendFactory } from "./tui.js"

/** Explicit embedding dependencies; these are never plugin configuration keys. */
export interface PluginDependencies {
  fileIO?: FileIO
  observer?: DiagnosticObserver
  historyProbe?: HistoryRenderProbe
  notifications?: NotificationBackendFactory
}
