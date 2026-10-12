import assert from "node:assert/strict"

/** One logical sound, with separate diagnostics for every owned player attempt. */
export function desktopPlaybackCase(kind) {
  const attempts = [], pending = []
  let finished
  const terminal = new Promise(resolve => { finished = resolve })
  const report = () => ({ kind, success: attempts.some(attempt => attempt.code === 0) && attempts.every(attempt => attempt.measured),
    attempts: attempts.map(attempt => ({ ...attempt })) })
  const complete = async () => {
    await Promise.all(pending)
    const result = report()
    assert.ok(result.success, `Desktop playback failed: ${JSON.stringify(result)}`)
    return result
  }
  return {
    report,
    observe(player, result, measurement) {
      const attempt = { player, code: null, measured: false }
      attempts.push(attempt)
      // Attach both handlers immediately: measurement rejection must not escape
      // while a slow player still owns its process and normalized file.
      pending.push(Promise.all([
        Promise.resolve(result).then(value => { attempt.code = value?.code ?? null }, error => { attempt.processError = String(error) }),
        Promise.resolve(measurement).then(() => { attempt.measured = true }, error => { attempt.measurementError = String(error) }),
      ]).then(() => {
        if (attempt.code === 0 || player === "pw-play" || !result) finished()
      }))
    },
    complete,
    async wait(timeoutMs = 30000) {
      let timer
      try {
        return await Promise.race([terminal.then(complete), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Desktop playback timed out: ${JSON.stringify(report())}`)), timeoutMs)
        })])
      } finally { clearTimeout(timer) }
    },
  }
}
