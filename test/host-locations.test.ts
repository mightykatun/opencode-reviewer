import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import { MAX_REVIEW_LOCATIONS, hostLocation, locationKey, reviewLocation, reviewLocations, routeAtLocation,
  sessionAtLocation } from "../src/host-locations.js"

type Location = { directory: string; workspaceID?: string }
function context(options: { current?: Location; fallback?: Location; tabs?: string[] | "unreadable"; enabled?: boolean;
  sessions?: Record<string, Location>; route?: { type: "home" } | { type: "session"; sessionID: string } }) {
  return {
    location: options.current,
    data: { location: { default: () => options.fallback ?? { directory: "/default" } },
      session: { get: (id: string) => options.sessions?.[id] ? { id, location: options.sessions[id] } : undefined } },
    ui: { router: { current: () => options.route ?? { type: "home" } },
      tabs: { enabled: () => options.enabled ?? true, list: () => {
        if (options.tabs === "unreadable") throw Error("Tabs unavailable")
        return (options.tabs ?? []).map((sessionID, index) => ({ sessionID, active: index === 0 }))
      } } },
  } as unknown as Plugin.Context
}

test("locations normalize to exactly the handshake fields and key by value", () => {
  assert.deepEqual(reviewLocation({ directory: "/a", workspaceID: "w", project: { id: "p" } }), { directory: "/a", workspaceID: "w" })
  assert.deepEqual(reviewLocation({ directory: "/a", workspaceID: "" }), { directory: "/a" })
  for (const invalid of [undefined, null, "/a", {}, { directory: "" }, { directory: 1 }]) assert.equal(reviewLocation(invalid), undefined)
  assert.equal(locationKey({ directory: "/a", workspaceID: "w" }), locationKey({ workspaceID: "w", directory: "/a" }))
  assert.notEqual(locationKey({ directory: "/a" }), locationKey({ directory: "/a", workspaceID: "w" }))
})

test("the host location falls back to the default before its first sync", () => {
  assert.deepEqual(hostLocation(context({ fallback: { directory: "/default" } })), { directory: "/default" })
  assert.deepEqual(hostLocation(context({ current: { directory: "/current", workspaceID: "w" } })), { directory: "/current", workspaceID: "w" })
})

test("the current location leads, then each open tab's location in tab order without duplicates", () => {
  const sessions = { a: { directory: "/a" }, b: { directory: "/b" }, c: { directory: "/a" }, d: { directory: "/current" } }
  assert.deepEqual(reviewLocations(context({ current: { directory: "/current" }, tabs: ["b", "a", "c", "d", "uncached"], sessions })),
    [{ directory: "/current" }, { directory: "/b" }, { directory: "/a" }])
})

test("disabled or unreadable tabs review only the current location", () => {
  const sessions = { a: { directory: "/a" } }
  for (const options of [{ enabled: false, tabs: ["a"] }, { tabs: "unreadable" as const }])
    assert.deepEqual(reviewLocations(context({ current: { directory: "/current" }, sessions, ...options })), [{ directory: "/current" }])
})

test("open tabs past the bound stay manual", () => {
  const sessions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`s${index}`, { directory: `/d${index}` }]))
  const locations = reviewLocations(context({ current: { directory: "/current" }, tabs: Object.keys(sessions), sessions }))
  assert.equal(locations.length, MAX_REVIEW_LOCATIONS)
  assert.deepEqual(locations[0], { directory: "/current" })
  assert.deepEqual(locations.at(-1), { directory: `/d${MAX_REVIEW_LOCATIONS - 2}` })
})

test("exactly one location presents a route", () => {
  const sessions = { here: { directory: "/here" }, away: { directory: "/away" } }
  const here = { directory: "/here" }, away = { directory: "/away" }
  const at = (route: Parameters<typeof context>[0]["route"]) => context({ current: here, sessions, route })
  assert.equal(sessionAtLocation(at(undefined), "away", away), true)
  assert.equal(sessionAtLocation(at(undefined), "away", here), false)
  assert.equal(sessionAtLocation(at(undefined), "uncached", here), false, "Unknown sessions belong nowhere")
  assert.deepEqual([here, away].map(value => routeAtLocation(at({ type: "session", sessionID: "away" }), value)), [false, true])
  assert.deepEqual([here, away].map(value => routeAtLocation(at({ type: "home" }), value)), [true, false])
  assert.deepEqual([here, away].map(value => routeAtLocation(at({ type: "session", sessionID: "uncached" }), value)), [false, false])
})
