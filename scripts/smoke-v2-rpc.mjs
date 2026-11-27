import assert from "node:assert/strict"
import { createServer } from "node:net"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { reviewerRpc } from "./smoke-v2-headless-support.mjs"

/** One service owns the location. The terminal discovers its private registration. */
export async function managedReviewer({ runtime, env, directory, host }) {
  const reservation = createServer()
  await new Promise((resolve, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolve)
  })
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const state = env.XDG_STATE_HOME ?? path.join(env.HOME, ".local/state")
  const file = path.join(state, "opencode/service.json")
  const environment = env.XDG_STATE_HOME ? ["XDG_STATE_HOME=" + state] : ["-u", "XDG_STATE_HOME", "HOME=" + env.HOME]
  await runtime.start("-d", "-s", "reviewer-service", "-c", directory, "env", ...environment,
    host, "serve", "--service", "--hostname", "127.0.0.1", "--port", String(port))
  const deadline = performance.now() + 15000
  do {
    const endpoint = await Service.discover({ file }).catch(() => undefined)
    if (endpoint?.url === `http://127.0.0.1:${port}`) {
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
      const rpc = client.rpc(reviewerRpc)
      const options = (at = directory) => ({ location: { directory: at }, signal: AbortSignal.timeout(5000) })
      return { client, endpoint, snapshot: at => rpc.snapshot({}, options(at)), identity: () => rpc.identity({}, options()) }
    }
    await sleep(50)
  } while (performance.now() < deadline)
  throw Error("Timed out waiting for the fixture service registration")
}

export async function verifiedSnapshot(service, directory, review = { enabled: true }) {
  const deadline = performance.now() + 15000
  let last
  do {
    try {
      last = await service.snapshot(directory)
      if (last.hosting.status === "verified" && last.review.enabled === review.enabled && last.review.reason === review.reason) {
        assert.deepEqual(last.review, review)
        assert.equal(last.location.directory, directory)
        return last
      }
    } catch (error) {
      if (error.type !== "rpc.unavailable") throw error
    }
    await sleep(50)
  } while (performance.now() < deadline)
  throw Error(`No verified reviewer snapshot: ${JSON.stringify(last)}`)
}
