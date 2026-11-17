import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { hostBackgroundIdle } from "../src/host-background-work.js"

test("a family's running shell at a member location keeps the conversation from ending", async () => {
  const home = { directory: "/server/project" }, worktree = { directory: "/server/project-worktree" }
  const shells: Record<string, unknown[]> = {
    [home.directory]: [{ id: "home-shell", status: "exited", metadata: { sessionID: "root" } }],
    [worktree.directory]: [{ id: "tree-shell", status: "running", metadata: { sessionID: "child" } }],
  }
  const listed: string[] = []
  const client = {
    session: { active: async () => ({}) },
    shell: { list: async ({ location }: { location: { directory: string } }) => {
      listed.push(location.directory)
      return { location, data: shells[location.directory] }
    } },
    experimental: { job: { list: async () => [] }, persistentPty: { list: async () => [] } },
  } as unknown as OpenCodeClient
  const signal = new AbortController().signal
  assert.equal(await hostBackgroundIdle(client, [home], ["root", "child"], signal), true, "The home alone cannot see the member's shell")
  assert.equal(await hostBackgroundIdle(client, [home, worktree], ["root", "child"], signal), false)
  assert.deepEqual(listed, [home.directory, home.directory, worktree.directory])
  assert.equal(await hostBackgroundIdle(client, [], ["root"], signal), false, "No readable location proves nothing")
})
