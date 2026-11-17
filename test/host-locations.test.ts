import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import { MAX_REVIEW_LOCATIONS, atLocation, hostLocation, locationKey, reviewHomes, reviewLocation, routeAtLocation,
  sessionAtLocation } from "../src/host-locations.js"

type Location = { directory: string; workspaceID?: string }
type Session = Location & { parentID?: string }
function context(options: { current?: Location; fallback?: Location; tabs?: string[] | "unreadable"; enabled?: boolean;
  sessions?: Record<string, Session>; route?: { type: "home" } | { type: "session"; sessionID: string } }) {
  const sessions = options.sessions ?? {}
  const get = (id: string) => {
    const value = sessions[id]
    if (!value) return
    const { parentID, ...location } = value
    return { id, location, ...(parentID ? { parentID } : {}) }
  }
  return {
    location: options.current,
    data: { location: { default: () => options.fallback ?? { directory: "/default" } },
      session: { get, family: (root: string) => {
        if (root === "unreadable-family") throw Error("Family unavailable")
        // Like the native roster: every cached session whose parent chain reaches the root.
        const rootOf = (id: string): string => sessions[id]?.parentID ? rootOf(sessions[id].parentID!) : id
        return Object.keys(sessions).filter(id => rootOf(id) === root)
      } } },
    ui: { router: { current: () => options.route ?? { type: "home" } },
      tabs: { enabled: () => options.enabled ?? true, list: () => {
        if (options.tabs === "unreadable") throw Error("Tabs unavailable")
        return (options.tabs ?? []).map((sessionID, index) => ({ sessionID, active: index === 0 }))
      } } },
  } as unknown as Plugin.Context
}
const directories = (homes: ReturnType<typeof reviewHomes>) =>
  homes.map(home => [home.location.directory, ...home.members.map(member => member.directory)])

test("locations normalize to exactly the handshake fields and key by value", () => {
  assert.deepEqual(reviewLocation({ directory: "/a", workspaceID: "w", project: { id: "p" } }), { directory: "/a", workspaceID: "w" })
  assert.deepEqual(reviewLocation({ directory: "/a", workspaceID: "" }), { directory: "/a" })
  for (const invalid of [undefined, null, "/a", {}, { directory: "" }, { directory: 1 }]) assert.equal(reviewLocation(invalid), undefined)
  assert.equal(locationKey({ directory: "/a", workspaceID: "w" }), locationKey({ workspaceID: "w", directory: "/a" }))
  assert.notEqual(locationKey({ directory: "/a" }), locationKey({ directory: "/a", workspaceID: "w" }))
  assert.equal(atLocation({ directory: "/a", workspaceID: "", project: {} }, { directory: "/a" }), true)
  assert.equal(atLocation({ directory: "/a" }, { directory: "/a", workspaceID: "w" }), false)
  assert.equal(atLocation(undefined, { directory: "/a" }), false)
})

test("the host location falls back to the default before its first sync", () => {
  assert.deepEqual(hostLocation(context({ fallback: { directory: "/default" } })), { directory: "/default" })
  assert.deepEqual(hostLocation(context({ current: { directory: "/current", workspaceID: "w" } })), { directory: "/current", workspaceID: "w" })
})

test("the current location leads, then each open tab's home in tab order without duplicates", () => {
  const sessions = { a: { directory: "/a" }, b: { directory: "/b" }, c: { directory: "/a" }, d: { directory: "/current" } }
  assert.deepEqual(directories(reviewHomes(context({ current: { directory: "/current" }, tabs: ["b", "a", "c", "d", "uncached"], sessions }))),
    [["/current"], ["/b"], ["/a"]])
})

test("disabled or unreadable tabs review only the current location", () => {
  const sessions = { a: { directory: "/a" } }
  for (const options of [{ enabled: false, tabs: ["a"] }, { tabs: "unreadable" as const }])
    assert.deepEqual(directories(reviewHomes(context({ current: { directory: "/current" }, sessions, ...options }))), [["/current"]])
})

test("a conversation's subagents in other locations become members of its home", () => {
  const sessions = { root: { directory: "/project" }, here: { directory: "/project", parentID: "root" },
    tree: { directory: "/worktree-a", parentID: "root" }, deep: { directory: "/worktree-b", parentID: "tree" },
    again: { directory: "/worktree-a", parentID: "root" }, other: { directory: "/other" }, away: { directory: "/project", parentID: "other" } }
  assert.deepEqual(directories(reviewHomes(context({ current: { directory: "/project" }, tabs: ["root", "other"], sessions }))),
    [["/project", "/worktree-a", "/worktree-b"], ["/other", "/project"]],
    "Members are per home, deduplicated, and may be another conversation's home")
})

test("the routed conversation is a home even while the host follows a subagent elsewhere", () => {
  const sessions = { root: { directory: "/project" }, tree: { directory: "/worktree", parentID: "root" } }
  const homes = reviewHomes(context({ current: { directory: "/worktree" }, route: { type: "session", sessionID: "tree" }, sessions, enabled: false }))
  assert.deepEqual(directories(homes), [["/worktree"], ["/project", "/worktree"]])
})

test("an unreadable family keeps its home and the locations already read", () => {
  const sessions = { "unreadable-family": { directory: "/a" } }
  assert.deepEqual(directories(reviewHomes(context({ current: { directory: "/current" }, tabs: ["unreadable-family"], sessions }))),
    [["/current"], ["/a"]])
})

test("homes and members past the bound stay manual", () => {
  const sessions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`s${index}`, { directory: `/d${index}` }]))
  const homes = reviewHomes(context({ current: { directory: "/current" }, tabs: Object.keys(sessions), sessions }))
  assert.equal(homes.length, MAX_REVIEW_LOCATIONS)
  assert.deepEqual(homes[0]!.location, { directory: "/current" })
  assert.deepEqual(homes.at(-1)!.location, { directory: `/d${MAX_REVIEW_LOCATIONS - 2}` })
  const family = { root: { directory: "/root" }, ...Object.fromEntries(Array.from({ length: 20 }, (_, index) =>
    [`c${index}`, { directory: `/w${index}`, parentID: "root" }])) }
  const members = reviewHomes(context({ current: { directory: "/root" }, tabs: ["root"], sessions: family }))
  assert.equal(members.reduce((count, home) => count + 1 + home.members.length, 0), MAX_REVIEW_LOCATIONS)
})

test("exactly one location presents a route: its conversation's home", () => {
  const sessions = { here: { directory: "/here" }, away: { directory: "/away" }, child: { directory: "/away", parentID: "here" } }
  const here = { directory: "/here" }, away = { directory: "/away" }
  const at = (route: Parameters<typeof context>[0]["route"]) => context({ current: here, sessions, route })
  assert.equal(sessionAtLocation(at(undefined), "away", away), true)
  assert.equal(sessionAtLocation(at(undefined), "away", here), false)
  assert.equal(sessionAtLocation(at(undefined), "uncached", here), false, "Unknown sessions belong nowhere")
  assert.deepEqual([here, away].map(value => routeAtLocation(at({ type: "session", sessionID: "away" }), value)), [false, true])
  assert.deepEqual([here, away].map(value => routeAtLocation(at({ type: "session", sessionID: "child" }), value)), [true, false],
    "A subagent elsewhere is presented by its conversation's home")
  assert.deepEqual([here, away].map(value => routeAtLocation(at({ type: "home" }), value)), [true, false])
  assert.deepEqual([here, away].map(value => routeAtLocation(at({ type: "session", sessionID: "uncached" }), value)), [false, false])
})
