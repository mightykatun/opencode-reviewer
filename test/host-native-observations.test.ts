import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as settle } from "node:timers/promises"
import { refreshNativeFamily, type NativeFamilyReader } from "../src/host-native-observations.js"
import { TransportOwnership } from "../src/transport-ownership.js"
import type { SessionLocation } from "../src/route-approval.js"

function fixture() {
  const source = new Map<string, SessionLocation>([
    ["root", { id: "root" }], ["child", { id: "child", parentID: "root" }],
    ["deep", { id: "deep", parentID: "child" }], ["other", { id: "other" }],
  ])
  const cache = new Map<string, SessionLocation>()
  const calls: string[] = [], owner = new TransportOwnership(), abort = new AbortController()
  let seeds: Iterable<string> = ["deep"]
  const reader: NativeFamilyReader = {
    owned: work => owner.track(work),
    resolveRoot: async id => { calls.push(`root:${id}`); return id === "other" ? "other" : "root" },
    session: id => cache.get(id),
    family: root => { assert.ok(cache.has(root), "root metadata must precede family reads"); calls.push(`family:${root}`); return root === "root" ? ["deep", "root", "child"] : [] },
    sync: async id => { calls.push(`sync:${id}`); const value = source.get(id); if (value) cache.set(id, value) },
  }
  return { source, cache, calls, owner, abort, reader, seeds: (value: Iterable<string>) => { seeds = value },
    refresh: () => refreshNativeFamily(seeds, reader, abort.signal) }
}

test("family refresh synchronizes root before family and every member before deep ancestry validation", async () => {
  const f = fixture()
  assert.deepEqual(await f.refresh(), ["root", "deep", "child"])
  assert.deepEqual(f.calls, ["root:deep", "sync:root", "sync:deep", "family:root", "sync:child"])
})

test("family refresh deduplicates roots and members without sorting public family order", async () => {
  const f = fixture(); f.seeds(["deep", "root", "deep", "other"])
  assert.deepEqual(await f.refresh(), ["root", "deep", "child", "other"])
  assert.deepEqual(f.calls, ["root:deep", "root:root", "root:other", "sync:root", "sync:other", "sync:deep", "family:root", "family:other", "sync:child"])
})

test("seed metadata refresh fills missing native family edges before reading its public roster", async () => {
  const f = fixture()
  f.reader.family = root => {
    f.calls.push(`family:${root}`)
    return f.cache.has("deep") ? ["deep", "child"] : []
  }
  assert.deepEqual(await f.refresh(), ["root", "deep", "child"])
  assert.deepEqual(f.calls, ["root:deep", "sync:root", "sync:deep", "family:root", "sync:child"])
})

test("a seed absent from a stale roster remains a refresh target with independently validated ancestry", async () => {
  const f = fixture(); f.seeds(["child"])
  f.reader.family = () => []
  assert.deepEqual(await f.refresh(), ["root", "child"])
  assert.deepEqual(f.calls, ["root:child", "sync:root", "sync:child"])
})

test("unknown or unrelated seeds omitted from the native family fail closed", async () => {
  for (const change of ["unknown", "unrelated"] as const) {
    const f = fixture(); f.seeds(["child"])
    f.reader.family = () => []
    if (change === "unknown") f.source.delete("child")
    else f.source.set("child", { id: "child" })
    await assert.rejects(f.refresh(), /Native seed scope unavailable/, change)
  }
})

test("family refresh owns failed root values and actual settled leases independently", async () => {
  const f = fixture()
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  f.reader.resolveRoot = () => Object.assign(Promise.reject(Error("Root wait failed")), { settled })
  const refresh = f.refresh()
  let completed = false
  const result = assert.rejects(refresh, /Root wait failed/).then(() => { completed = true })
  let drained = false
  const drain = f.owner.settled().then(() => { drained = true })
  await settle(); assert.equal(drained, false); assert.equal(completed, false)
  release(); await result; await drain; assert.equal(drained, true)
  assert.deepEqual(f.calls, [])
})

test("a successful root wait also retains later physical cleanup ownership", async () => {
  const f = fixture()
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  f.reader.resolveRoot = () => Object.assign(Promise.resolve("root"), { settled })
  const refresh = f.refresh()
  let drained = false
  const drain = f.owner.settled().then(() => { drained = true })
  await settle(); assert.equal(drained, false)
  assert.deepEqual(f.calls, [], "metadata refresh waits for the root transaction's cleanup")
  release(); await refresh; await drain
})

test("an aborted root wait stops cache work but retains the physical root read until settlement", async () => {
  const f = fixture()
  let release!: (root: string) => void
  const read = new Promise<string>(resolve => { release = resolve })
  f.reader.resolveRoot = () => read
  const refresh = f.refresh()
  f.abort.abort()
  let drained = false
  const drain = f.owner.settled().then(() => { drained = true })
  await settle(); assert.equal(drained, false)
  release("root")
  await assert.rejects(refresh, { name: "AbortError" })
  await drain
  assert.deepEqual(f.calls, [])
})

test("abort during root cleanup cannot start metadata refresh after cleanup settles", async () => {
  const f = fixture()
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  f.reader.resolveRoot = () => Object.assign(Promise.resolve("root"), { settled })
  const refresh = f.refresh()
  const result = assert.rejects(refresh, { name: "AbortError" })
  await settle(); f.abort.abort()
  assert.deepEqual(f.calls, [])
  release(); await result; await f.owner.settled()
  assert.deepEqual(f.calls, [])
})

test("failed cleanup cannot replace the root read error or discard its transaction", async () => {
  const f = fixture()
  f.reader.resolveRoot = () => Object.assign(Promise.reject(Error("Original root failure")), {
    settled: Promise.resolve().then(() => { throw Error("Cleanup failure") }),
  })
  await assert.rejects(f.refresh(), /Original root failure/)
  await f.owner.settled()
  assert.deepEqual(f.calls, [])
})

test("abort is checked immediately after root reads and every metadata synchronization", async () => {
  for (const phase of ["before", "root", "sync:root", "sync:deep", "sync:child"] as const) {
    const f = fixture()
    const sync = f.reader.sync
    f.reader.sync = async id => { await sync(id); if (phase === `sync:${id}`) f.abort.abort() }
    const root = f.reader.resolveRoot
    f.reader.resolveRoot = async (id, signal) => { const value = await root(id, signal); if (phase === "root") f.abort.abort(); return value }
    if (phase === "before") f.abort.abort()
    await assert.rejects(f.refresh(), { name: "AbortError" })
    if (phase === "before") assert.deepEqual(f.calls, [])
    if (phase === "root") assert.deepEqual(f.calls, ["root:deep"])
    if (phase === "sync:root") assert.deepEqual(f.calls, ["root:deep", "sync:root"])
    if (phase === "sync:deep") assert.deepEqual(f.calls, ["root:deep", "sync:root", "sync:deep"])
  }
})

test("invalid roots, duplicate family IDs, missing metadata, foreign owners and cycles fail closed", async () => {
  for (const change of ["root", "root-owner", "duplicate", "missing", "foreign", "cycle", "overlap"] as const) {
    const f = fixture()
    if (change === "root") f.reader.resolveRoot = async () => ""
    if (change === "root-owner") f.source.set("root", { id: "other" })
    if (change === "duplicate") f.reader.family = () => ["deep", "deep"]
    if (change === "missing") f.source.delete("child")
    if (change === "foreign") f.source.set("deep", { id: "deep", parentID: "other" })
    if (change === "cycle") f.source.set("child", { id: "child", parentID: "deep" })
    if (change === "overlap") { f.seeds(["root", "other"]); f.reader.family = () => ["deep", "child"] }
    await assert.rejects(f.refresh(), /Native .* unavailable/, change)
  }
})

test("family refresh bounds unique seeds and the combined family before refreshing member metadata", async () => {
  const f = fixture()
  f.seeds(Array.from({ length: 16385 }, (_, index) => `seed-${index}`))
  await assert.rejects(f.refresh(), /Native seeds unavailable/)
  assert.deepEqual(f.calls, [])
  f.seeds(["root", "other"])
  f.reader.family = root => Array.from({ length: 8192 }, (_, index) => `${root}-${index}`)
  await assert.rejects(f.refresh(), /Native family unavailable/)
  assert.deepEqual(f.calls, ["root:root", "root:other", "sync:root", "sync:other"])
})
