import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import type { OpenCodeClient } from "@opencode/client"
import { registeredInvocationProject } from "../src/host-project.js"
import { TransportOwnership, bindTransportOwnership } from "../src/transport-ownership.js"
import { withDeadline } from "../src/deadline.js"

const invocation = { sessionID: "session", assistantID: "assistant", callID: "call", tool: "shell",
  input: { command: "pwd", workdir: "/command-target" }, location: { directory: "/checkout/nested" },
  project: { id: "global", directory: "/checkout", canonical: "/checkout" }, epoch: "epoch" }
function fixture() {
  const state = { projects: [{ id: "git", canonical: "/checkout" }] as unknown,
    worktrees: [{ directory: "/checkout" }] as unknown }
  const calls: string[] = []
  const client = {
    project: { list: async (input: unknown, options: { signal: AbortSignal }) => {
      assert.deepEqual(input, { archived: true }); assert.equal(options.signal.aborted, false)
      calls.push("projects"); return state.projects
    } },
    worktree: { list: async (input: unknown, options: { signal: AbortSignal }) => {
      assert.deepEqual(input, { projectID: "git" }); assert.equal(options.signal.aborted, false)
      calls.push("worktrees"); return state.worktrees
    } },
  }
  const read = (signal = new AbortController().signal) => registeredInvocationProject(client as unknown as OpenCodeClient, invocation, "git", signal)
  return { state, calls, client, read }
}

test("registered attribution uses exact ID and saved checkout inventory, never command workdir", async () => {
  const f = fixture()
  f.state.projects = [{ id: "other", canonical: "/command-target" }, { id: "git", canonical: "/preferred" }]
  f.state.worktrees = [{ directory: "/checkout" }, { directory: "/different-clone" }]
  assert.deepEqual(await f.read(), { id: "git", directory: "/checkout", canonical: "/preferred" })
  assert.deepEqual(f.calls, ["projects", "worktrees"])
  assert.equal(invocation.project.id, "global", "Historical captured project remains unchanged")
})

for (const failure of ["missing", "duplicate", "relative", "nul", "normalized", "prefix", "ambiguous", "invalid-checkout", "missing-checkout", "canonical-only", "oversized"] as const)
  test(`registered attribution rejects ${failure} metadata`, async () => {
    const f = fixture()
    if (failure === "missing") f.state.projects = []
    if (failure === "duplicate") f.state.projects = [{ id: "git", canonical: "/checkout" }, { id: "git", canonical: "/checkout" }]
    if (failure === "relative") f.state.projects = [{ id: "git", canonical: "checkout" }]
    if (failure === "nul") f.state.projects = [{ id: "git", canonical: "/checkout\0" }]
    if (failure === "normalized") f.state.projects = [{ id: "git", canonical: "/checkout/../checkout" }]
    if (failure === "prefix") f.state.worktrees = [{ directory: "/check" }]
    if (failure === "ambiguous") f.state.worktrees = [{ directory: "/checkout" }, { directory: "/checkout/nested" }]
    if (failure === "invalid-checkout") f.state.worktrees = [{ directory: "relative" }]
    if (failure === "missing-checkout") f.state.worktrees = []
    if (failure === "canonical-only") {
      f.state.projects = [{ id: "git", canonical: "/" }]
      f.state.worktrees = [{ directory: "/different-clone" }]
    }
    if (failure === "oversized") f.state.projects = Array.from({ length: 16385 }, () => ({ id: "git", canonical: "/checkout" }))
    await assert.rejects(f.read(), /metadata unavailable or ambiguous/)
  })

test("registry read errors and parent aborts are not treated as optional metadata", async () => {
  const f = fixture(), abort = new AbortController()
  f.client.project.list = async () => { throw Error("Inventory offline") }
  await assert.rejects(f.read(), /Inventory offline/)
  abort.abort(Error("Stop metadata lookup"))
  await assert.rejects(f.read(abort.signal), /Stop metadata lookup/)
  assert.deepEqual(f.calls, [])
})

for (const stage of ["projects", "worktrees"] as const)
  test(`timed-out ${stage} read retains physical ownership and cannot dispatch later inventory work`, async () => {
    const f = fixture(), abort = new AbortController(), ownership = new TransportOwnership()
    bindTransportOwnership(abort.signal, ownership)
    let release!: (value: any) => void
    const held = new Promise<any>(resolve => { release = resolve })
    if (stage === "projects") f.client.project.list = async () => { f.calls.push("held-projects"); return held }
    else f.client.worktree.list = async () => { f.calls.push("held-worktrees"); return held }
    await assert.rejects(withDeadline(abort.signal, 10, signal => f.read(signal)), /timed out/)
    let settled = false
    const drain = ownership.settled().then(() => { settled = true })
    await tick(); assert.equal(settled, false)
    release(stage === "projects" ? f.state.projects : f.state.worktrees)
    await drain
    assert.deepEqual(f.calls, stage === "projects" ? ["held-projects"] : ["projects", "held-worktrees"])
  })
