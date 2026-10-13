import type { FileIO } from "./file-access.js"
import type { DiagnosticObserver } from "./diagnostics.js"
import type { HistoryRenderProbe, NotificationBackendFactory } from "./embedding-types.js"
import type { NotificationProcesses } from "./notification-process.js"

/** Explicit embedding dependencies; these are never plugin configuration keys. */
export interface PluginDependencies {
  /** Adapter-only fixture seam. Not read from user configuration. */
  adapterOnly?: true
  fileIO?: FileIO
  observer?: DiagnosticObserver
  historyProbe?: HistoryRenderProbe
  notifications?: NotificationBackendFactory
  /** Constructed only by the lazy CLI notification backend, never the server. */
  notificationProcesses?: () => NotificationProcesses
}
