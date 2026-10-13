import { deflateSync } from "node:zlib"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { withDeadline } from "./deadline.js"
import type { NotificationKind } from "./notification-types.js"

function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name: string, bytes: Buffer) {
  const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12)
  result.writeUInt32BE(bytes.length); type.copy(result, 4); bytes.copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([type, bytes])), bytes.length + 8)
  return result
}

type Stroke = readonly [number, number, number, number]
const icons: Record<NotificationKind, { strokes: readonly Stroke[]; rgb: readonly number[] }> = {
  approved: { strokes: [[16.5, 24, 22, 29], [22, 29, 31.5, 19]], rgb: [46, 204, 113] },
  attention: { strokes: [[24, 17, 24, 25], [24, 31, 24, 31]], rgb: [245, 158, 11] },
  unsafe: { strokes: [[24, 17, 24, 25], [24, 31, 24, 31]], rgb: [239, 68, 68] },
  // Purple accent #9d7cd8 distinguishes questions from permission attention.
  question: { strokes: [[19, 20, 19, 19], [19, 19, 21, 17], [21, 17, 27, 17], [27, 17, 29, 19],
    [29, 19, 29, 22], [29, 22, 24, 26], [24, 26, 24, 27], [24, 31, 24, 31]], rgb: [157, 124, 216] },
  error: { strokes: [[18, 18, 30, 30], [30, 18, 18, 30]], rgb: [239, 68, 68] },
  ended: { strokes: [[18, 18, 30, 18], [30, 18, 30, 30], [30, 30, 18, 30], [18, 30, 18, 18]], rgb: [160, 160, 160] },
}

function insideStroke(x: number, y: number, [x1, y1, x2, y2]: Stroke): boolean {
  const dx = x2 - x1, dy = y2 - y1, length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0
  return (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2 <= 1.5 ** 2
}

/** Centered, rounded status marks beside the whole text block, not its first line. */
export function smallNotificationIcon(kind: NotificationKind = "ended"): Buffer {
  const { strokes, rgb } = icons[kind]
  const pixels = Buffer.alloc(48 * (1 + 48 * 4))
  // Four-by-four coverage sampling smooths diagonal edges without native image
  // libraries, fonts, runtime downloads or platform-dependent rasterization.
  for (let y = 14; y < 34; y++) for (let x = 14; x < 34; x++) {
    let coverage = 0
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      if (strokes.some(stroke => insideStroke(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4, stroke))) coverage++
    }
    if (!coverage) continue
    const offset = y * (1 + 48 * 4) + 1 + x * 4
    pixels.set([...rgb, Math.round(coverage * 255 / 16)], offset)
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(48); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))])
}

export class NotificationIcon {
  constructor(private io = { mkdtemp, writeFile, rm }) {}
  private stopped = false
  private directory?: Promise<string>
  private workers = new Map<NotificationKind, Promise<string | undefined>>()
  file(signal: AbortSignal, kind: NotificationKind = "ended") {
    if (this.stopped || signal.aborted) return Promise.resolve(undefined)
    let worker = this.workers.get(kind)
    if (!worker) {
      worker = (async () => {
        this.directory ??= this.io.mkdtemp(path.join(tmpdir(), "opencode-reviewer-icon-"))
        const directory = await this.directory
        if (this.stopped) return
        const file = path.join(directory, `${kind}.png`)
        await this.io.writeFile(file, smallNotificationIcon(kind), { flag: "wx", mode: 0o600 })
        return this.stopped ? undefined : file
      })()
      // The caller's deadline callback may never run. Own rejection immediately,
      // independently of that wait, while retaining the worker for cleanup.
      void worker.catch(() => {})
      this.workers.set(kind, worker)
    }
    return withDeadline(signal, 1500, () => worker!).catch(() => undefined)
  }
  async dispose() {
    this.stopped = true
    const worker = (async () => {
      await Promise.allSettled([...this.workers.values()])
      const directory = await this.directory?.catch(() => undefined)
      if (directory) await this.io.rm(directory, { recursive: true, force: true }).catch(() => {})
    })()
    await withDeadline(new AbortController().signal, 2000, () => worker).catch(() => {})
  }
}
