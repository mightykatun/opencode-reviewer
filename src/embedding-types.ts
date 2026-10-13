import type { NotificationConfig } from "./notification-config.js"
import type { NotificationBackend, NotificationClick } from "./notification-types.js"

/** Opt-in observations of real renderables, never an approval override. */
export interface HistoryRenderEvent {
  stage: "frame"
  at: number
  panel: number
  final: boolean
  streaming: boolean
  contentMatches: boolean
  children: number
  codeBlocks: number
  highlighting: boolean
  painted: boolean
  covered: boolean
  physical: boolean
  eligible: boolean
  presentation: "visible" | "pending" | "lost"
  auto?: string
}

export interface HistoryRenderProbe {
  observe: (event: Readonly<HistoryRenderEvent>) => void | Promise<void>
}

export type NotificationBackendFactory = (click: NotificationClick, config: NotificationConfig) => NotificationBackend
