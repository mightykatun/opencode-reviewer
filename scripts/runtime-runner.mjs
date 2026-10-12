import { spawn } from "node:child_process"

/** Own the whole fixture process group, including wrappers with child drivers.
 * smokeRuntime's detached supervisor separately owns its private tmux server.
 */
export async function executeFixture(command, args, { cwd, env = process.env, signal, timeoutMs, graceMs = 10000,
  ready, startupTimeoutMs = timeoutMs, output = () => {} }) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let timedOut = false, escalation, settled = false, failure, timer
    const kill = signal => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== "ESRCH") throw error }
    }
    const stop = () => {
      if (settled || escalation) return
      clearTimeout(timer)
      kill("SIGTERM")
      escalation = setTimeout(() => kill("SIGKILL"), graceMs)
    }
    const deadline = ms => setTimeout(() => { timedOut = true; stop() }, ms)
    // Optional fixture handshake separates bounded startup from its run budget.
    // Ordinary inventory runs still start their single deadline at spawn.
    timer = deadline(ready ? startupTimeoutMs : timeoutMs)
    if (ready) Promise.resolve(ready).then(() => {
      if (settled || escalation) return
      clearTimeout(timer)
      timer = deadline(timeoutMs)
    }, error => { if (!settled) { failure = error; stop() } })
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) stop()
    for (const [stream, channel] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) stream.on("data", chunk => output(chunk, channel))
    const cleanup = () => {
      settled = true
      clearTimeout(timer); clearTimeout(escalation)
      signal?.removeEventListener("abort", stop)
    }
    child.once("error", error => { failure = error; stop() })
    // exit precedes close when descendants still hold inherited output pipes.
    // Stop the owned group immediately, but retain streams and result until close.
    child.once("exit", stop)
    child.once("close", (code, exitSignal) => {
      kill("SIGKILL")
      cleanup()
      if (failure) reject(failure)
      else resolve({ code, signal: exitSignal, timedOut, interrupted: signal?.aborted === true })
    })
  })
}
