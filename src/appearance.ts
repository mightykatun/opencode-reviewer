export const SCANNER_INTERVAL_MS = 40
export const SCANNER_FRAME_COUNT = 54

/** Eight-cell block scanner: forward, end hold, backward, start hold. */
export function scannerFrame(frame: number) {
  const phase = frame % SCANNER_FRAME_COUNT
  const forward = phase < 17
  const holding = (phase >= 8 && phase < 17) || phase >= 24
  const position = phase < 8 ? phase : phase < 17 ? 7 : phase < 24 ? 23 - phase : 0
  const progress = phase < 8 ? phase : phase < 17 ? phase - 8 : phase < 24 ? phase - 17 : phase - 24
  const duration = holding ? forward ? 9 : 30 : forward ? 7 : 6
  const inactiveAlpha = 0.6 * (holding ? 1 - progress / duration * 0.7 : 0.3 + progress / duration * 0.7)
  return Array.from({ length: 8 }, (_, column) => {
    const distance = forward ? position - column : column - position
    const trail = holding ? distance + progress : distance
    const active = trail >= 0 && trail < 6
    return {
      character: active ? "■" : "⬝",
      alpha: !active ? inactiveAlpha : trail === 0 ? 1 : trail === 1 ? 0.9 : Math.pow(0.65, trail - 1),
      brightness: active && trail === 1 ? 1.15 : 1,
    }
  })
}
