import assert from "node:assert/strict"
import { test } from "node:test"
import { readHandshake } from "../src/companion-protocol.js"
import { localStateRoot } from "../src/local-state.js"

test("companion handshake rejects another host protocol/location/workspace and retains an owned copy", () => {
  const location = { directory: "/server/project", workspaceID: "workspace-a" }
  const value = { protocol: 1, hostVersion: "2.0.26", epoch: "10000000-1000-4000-8000-100000000000", location: { ...location },
    project: { id: "project", directory: "/server", canonical: "/canonical" } }
  const snapshot = readHandshake(value, location)
  assert.deepEqual(snapshot, value)
  for (const invalid of [null, {}, { ...value, protocol: 2 }, { ...value, hostVersion: "2.0.27" }, { ...value, epoch: "same-location" },
    { ...value, location: { directory: "/terminal/project", workspaceID: "workspace-a" } },
    { ...value, location: { directory: location.directory } }, { ...value, project: { ...value.project, canonical: "" } },
    { ...value, project: { ...value.project, directory: "relative" } },
    { ...value, project: { ...value.project, canonical: "/path\0bad" } },
    { ...value, project: { ...value.project, id: "x".repeat(16385) } }]) assert.equal(readHandshake(invalid, location), undefined)
  value.project.directory = "/changed"
  value.location.directory = "/changed"
  location.directory = "/changed"
  assert.equal(snapshot?.project.directory, "/server")
  assert.equal(snapshot?.location.directory, "/server/project")
})

test("local state preserves literal XDG paths and never derives a scope from terminal cwd", () => {
  assert.equal(localStateRoot({ XDG_STATE_HOME: "/state/$literal" }, "/home/test"), "/state/$literal/opencode")
  assert.equal(localStateRoot({ XDG_STATE_HOME: "relative" }, "/home/test"), "/home/test/.local/state/opencode")
  assert.equal(localStateRoot({}, "/home/test"), "/home/test/.local/state/opencode")
  assert.throws(() => localStateRoot({}, "relative"), /unavailable/)
})
