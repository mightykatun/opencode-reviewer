import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"

// A monitor can be installed before the native stream is connected. Retire owned
// prompt-free probes whose births were missed, never invent or replay an event.
export async function connectionProbe({ create, remove, observe, directory }, {
  now = () => performance.now(), pause = setTimeout, timeoutMs = 60000,
} = {}) {
  const deadline = now() + timeoutMs, attempts = []
  let current, removed = false, bornAt
  const start = async () => {
    const value = await create()
    assert.ok(typeof value?.id === "string" && value.id.length, "Native probe requires an exact session identity")
    current = value
    removed = false
    bornAt = now()
    attempts.push(current.id)
  }
  const retire = async () => { removed = true; await remove(current.id) }
  try {
    await start()
    while (now() < deadline) {
      const record = await observe()
      if (now() >= deadline) break
      const birth = record?.connectionBirths?.find(event => event.data.sessionID === current.id)
      if (birth) {
        assert.equal(birth.data.location.directory, directory)
        assert.equal(birth.durable.aggregateID, current.id)
        await retire()
        while (now() < deadline) {
          const record = await observe()
          const deletion = record?.connectionDeletes?.find(event => event.data.sessionID === current.id)
          if (deletion && now() < deadline) return { sessionID: current.id, birth, deletion, attempts, prompted: false }
          await pause(Math.min(40, Math.max(0, deadline - now())))
        }
        break
      }
      if (now() - bornAt >= 1000 && attempts.length < 8) {
        await retire()
        if (now() >= deadline) break
        await start()
      } else await pause(Math.min(40, Math.max(0, deadline - now())))
    }
    throw new Error("Timed out waiting for exact native connection probe birth and deletion before reviewer activation")
  } finally {
    if (current && !removed) await retire()
  }
}
