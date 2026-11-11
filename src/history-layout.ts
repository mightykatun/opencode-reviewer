import { displayText } from "./controller.js"
import type { HistorySelection } from "./history-schema.js"
import { usageText } from "./usage.js"
import { uiText } from "./ui-text.js"

export function historyMetadata(record: NonNullable<HistorySelection["record"]>): string {
  const timing = record.payload.timing
  return displayText([
    usageText(record.payload.usage ?? {}, record.payload.toolCalls),
    uiText.history.model(record.payload.reportedModel ?? record.context.configuredModel),
    uiText.history.provider(record.context.provider),
    ...(timing ? [uiText.history.timeToRating((timing.ratingMs / 1000).toFixed(2)),
      uiText.history.timeToReport((timing.fullReportMs / 1000).toFixed(2))] : []),
  ].filter(Boolean).join("\n"))
}

/** Button padding is two cells. The exact index never shortens. */
export function historyLayout(label: string | undefined, index: string, width = 38) {
  const navigation = index.length + 8
  if (!label) return { label, rows: navigation <= width ? 1 : 3 }
  const available = width - navigation - 3
  if (label.length <= available) return { label, rows: 1 }
  if (available >= 8) {
    const marker = uiText.truncation, retained = available - marker.length
    return { label: label.slice(0, Math.ceil(retained / 2)) + marker + label.slice(-Math.floor(retained / 2)), rows: 1 }
  }
  return { label, rows: navigation <= width ? 2 : 3 }
}
