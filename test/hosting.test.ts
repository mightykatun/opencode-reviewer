import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer, type Server } from "node:http"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { HostingBinder, hostingReasons, registrationFile, verifyHostingService } from "../src/hosting.js"

const location = { directory: "/server/project" }
interface Fake { pid: number; nonce: string; password: string; requests: string[] }

/** A loopback stand-in for the hosting OpenCode server: registration, info and our RPC. */
async function fakeService(t: { after(fn: () => unknown): void }, fake: Fake) {
  const server: Server = createServer((req, res) => {
    fake.requests.push(`${req.method} ${req.url}`)
    const expected = "Basic " + Buffer.from(`opencode:${fake.password}`).toString("base64")
    if (req.headers.authorization !== expected) { res.writeHead(401); res.end(); return }
    if (req.method === "GET" && req.url === "/api/info") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ version: "2.4.1", pid: fake.pid, urls: [url], paths: { tmp: "/tmp" } }))
      return
    }
    if (req.method === "POST" && req.url?.startsWith("/api/rpc/opencode-reviewer/identity")) {
      let body = ""
      req.on("data", chunk => { body += chunk })
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ output: { nonce: fake.nonce, pid: fake.pid } }))
      })
      return
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ _tag: "NotFound", message: "no" }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}`
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-hosting-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "service.json")
  await writeFile(file, JSON.stringify({ id: randomUUID(), version: "2.4.1", url, pid: fake.pid, password: fake.password }), { mode: 0o600 })
  return { url, file, dir }
}

test("registration files follow the channel under the process state directory", () => {
  assert.equal(registrationFile("latest", { XDG_STATE_HOME: "/state" }, "/home/u"), "/state/opencode/service.json")
  assert.equal(registrationFile("dev", {}, "/home/u"), "/home/u/.local/state/opencode/service.json")
  assert.equal(registrationFile("my channel/x", {}, "/home/u"), "/home/u/.local/state/opencode/service-my-channel-x.json")
})

test("the managed service verifies only through pid equality and our own nonce round trip", async t => {
  const nonce = randomUUID()
  const fake: Fake = { pid: process.pid, nonce, password: "secret", requests: [] }
  const { url, file } = await fakeService(t, fake)
  const signal = new AbortController().signal
  const verified = await verifyHostingService(location, "latest", { registrationFile: file, identity: { nonce } }, signal)
  assert.equal(verified.status, "verified")
  assert.equal(verified.status === "verified" && verified.url, url)
  assert.ok(fake.requests.some(request => request === "GET /api/info"))
  assert.ok(fake.requests.some(request => request.startsWith("POST /api/rpc/opencode-reviewer/identity")))
  // Another instance answering with its own nonce is a foreign server, same pid or not.
  fake.nonce = randomUUID()
  const foreign = await verifyHostingService(location, "latest", { registrationFile: file, identity: { nonce } }, signal)
  assert.deepEqual(foreign, { status: "unavailable", reason: "foreign" })
  fake.nonce = nonce
  // A live service of another process, consistently registered, is foreign even with our nonce echoed.
  fake.pid = process.pid + 1
  await writeFile(file, JSON.stringify({ id: randomUUID(), version: "2.4.1", url, pid: fake.pid, password: fake.password }), { mode: 0o600 })
  const otherProcess = await verifyHostingService(location, "latest", { registrationFile: file, identity: { nonce } }, signal)
  assert.deepEqual(otherProcess, { status: "unavailable", reason: "foreign" })
})

test("a missing registration or a dead endpoint stays unavailable with a fixed reason", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewer-hosting-missing-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const signal = new AbortController().signal
  const missing = await verifyHostingService(location, "latest", { registrationFile: path.join(dir, "service.json"), identity: { nonce: randomUUID() } }, signal)
  assert.deepEqual(missing, { status: "unavailable", reason: "unregistered" })
  assert.match(hostingReasons[missing.status === "unavailable" ? missing.reason : "foreign"], /managed background service/)
  const stale = path.join(dir, "stale.json")
  await writeFile(stale, JSON.stringify({ id: randomUUID(), version: "2.4.1", url: "http://127.0.0.1:1", pid: 999999, password: "x" }), { mode: 0o600 })
  const dead = await verifyHostingService(location, "latest", { registrationFile: stale, identity: { nonce: randomUUID() } }, signal)
  assert.equal(dead.status, "unavailable")
})

test("the binder retries until the registration appears and then stays verified", async t => {
  const nonce = randomUUID()
  const fake: Fake = { pid: process.pid, nonce, password: "secret", requests: [] }
  const { file } = await fakeService(t, fake)
  const pending = file + ".pending"
  const controller = new AbortController()
  t.after(() => controller.abort())
  const states: string[] = []
  const binder = new HostingBinder(location, "latest", { registrationFile: pending, identity: { nonce } }, controller.signal, [30, 30])
  binder.onChange(state => states.push(state.status === "verified" ? "verified" : state.reason))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(binder.current.status, "unavailable")
  await writeFile(pending, await import("node:fs/promises").then(fs => fs.readFile(file)))
  await binder.settled
  assert.equal(binder.current.status, "verified")
  assert.deepEqual(states, ["unregistered", "verified"])
})

test("a verified binding is revoked when registration disappears and verified again after restoration", { timeout: 5000 }, async t => {
  const nonce = randomUUID()
  const fake: Fake = { pid: process.pid, nonce, password: "secret", requests: [] }
  const { file } = await fakeService(t, fake)
  const removed = file + ".removed"
  const controller = new AbortController()
  t.after(() => controller.abort())
  const binder = new HostingBinder(location, "latest", { registrationFile: file, identity: { nonce }, reverifyMs: 30 }, controller.signal, [20])
  const states: string[] = []
  binder.onChange(state => states.push(state.status === "verified" ? "verified" : state.reason))
  await binder.settled
  const nextState = () => new Promise<void>(resolve => {
    const stop = binder.onChange(() => {
      stop()
      resolve()
    })
  })
  const revoked = nextState()
  await rename(file, removed)
  await revoked
  assert.deepEqual(binder.current, { status: "unavailable", reason: "unregistered" })
  const restored = nextState()
  const priorRequests = fake.requests.length
  await rename(removed, file)
  await restored
  assert.equal(binder.current.status, "verified")
  assert.deepEqual(states, ["verified", "unregistered", "verified"])
  const requests = fake.requests.slice(priorRequests)
  assert.ok(requests.includes("GET /api/info"))
  assert.ok(requests.some(request => request.startsWith("POST /api/rpc/opencode-reviewer/identity")))
})
