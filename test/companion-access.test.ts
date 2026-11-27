import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle, setTimeout as sleep } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { directCompanionAccess } from "../src/companion-access.js"
import { createCompanionServer } from "../src/companion-reads.js"
import { PluginLifecycle } from "../src/plugin-lifecycle.js"

const collection = { reviewBash: true, reviewEdits: true, reviewExternalDirectories: true,
  reviewSkills: true, reviewTools: true, maxFiles: 6, maxEvidenceBytes: 131072 }

for (const outcome of ["released", "aborted", "expired"] as const) test(`a third direct read waits for capacity: ${outcome}`, async () => {
  const life = new PluginLifecycle()
  const location = { directory: "/project" }
  const reads: string[] = []
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const context = {
    app: { version: "development" },
    location: { ...location, project: { id: "project", directory: "/project", canonical: "/project" } },
    tool: { hook: async () => ({ dispose() {} }) },
    permission: { get: async ({ requestID }: { requestID: string }) => {
      reads.push(requestID)
      if (requestID !== "third") await hold
      return { id: requestID, sessionID: "session", action: "shell", resources: ["pwd"],
        source: { type: "tool", messageID: "assistant", id: "call" } }
    } },
    session: { get: async () => ({ id: "session", location }) },
  } as unknown as Plugin.Context
  const server = await createCompanionServer(context, life)
  server.captures.before({ sessionID: "session", messageID: "assistant", id: "call", tool: "shell", input: { command: "pwd" } })
  const access = directCompanionAccess(server)
  const first = access.invocation("session", "first", life.signal)
  const second = access.invocation("session", "second", life.signal)
  try {
    await settle()
    assert.deepEqual(reads, ["first", "second"])
    const parent = new AbortController()
    const third = outcome === "released" ? access.invocation("session", "third", parent.signal)
      : access.evidence("session", "third", collection, outcome === "expired" ? 75 : 5000, parent.signal)
    if (outcome === "released") {
      await settle()
      assert.deepEqual(reads, ["first", "second"])
      release()
      assert.ok(await third)
      assert.equal(reads.filter(id => id === "third").length, 2)
    } else {
      const failed = assert.rejects(third, outcome === "expired" ? /timed out/ : /caller cancelled/)
      await settle()
      if (outcome === "aborted") parent.abort(new Error("caller cancelled"))
      await failed
      release()
      await sleep(60)
      assert.equal(reads.includes("third"), false)
    }
  } finally {
    release()
    await Promise.all([first, second])
    await life.stop()
  }
})
