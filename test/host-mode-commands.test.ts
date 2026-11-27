import assert from "node:assert/strict"
import { test } from "node:test"
import { viewerFixture } from "./viewer-fixture.js"

test("mode commands send the captured session only while the server is available", async t => {
  const f = viewerFixture()
  t.after(() => f.life.stop())
  const enable = f.command("reviewer.enable"), disable = f.command("reviewer.disable")
  assert.deepEqual([enable, disable].map(c => [c.title, c.group, c.palette, c.slash]), [
    ["Reviewer: Enable for conversation", "Reviewer", true, { name: "reviewer-enable" }],
    ["Reviewer: Disable for conversation", "Reviewer", true, { name: "reviewer-disable" }],
  ])
  f.route({ type: "home" })
  await enable.run()
  f.route({ type: "session", sessionID: "child" })
  await disable.run()
  f.route({ type: "session", sessionID: "root" })
  await enable.run()
  f.available(false)
  await disable.run()
  assert.deepEqual(f.calls.filter(call => call.method === "mode"), [
    { method: "mode", input: { sessionID: "child", set: false }, location: f.home.feed.location },
    { method: "mode", input: { sessionID: "root", set: true }, location: f.home.feed.location },
  ])
})
