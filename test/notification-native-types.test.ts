import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { NotificationPolicy } from "../src/notification-policy.js"
import { parseNotificationConfig } from "../src/notification-config.js"
import type { HostRequest } from "../src/host-types.js"
import type { View } from "../src/controller.js"
import type { NotificationMessage } from "../src/notification-types.js"

test("shared notification policy accepts exact native identities", async () => {
  const messages: NotificationMessage[] = []
  const policy = new NotificationPolicy<HostRequest>(parseNotificationConfig({ notifySound: false, staleReminderSeconds: 0 }), true, {
    async show(message) { messages.push(message); return { close() {} } }, dispose() {},
  })
  const request: HostRequest = { id: "request", sessionID: "child", action: "shell", resources: ["command"] }
  const target = { root: "root", sessionID: "root", title: "Native conversation" }
  const view: View<HostRequest> = { request, status: "complete", assessment: { safe: true, desc: "bounded" } }
  try {
    policy.pending(new Map([["root", { kind: "permission", id: "request" }]]))
    policy.snapshot([view])
    policy.permission(request, target, true)
    await setImmediate()
    assert.equal(messages.length, 0, "Safe awaiting eligibility/countdown is silent")
    policy.snapshot([{ ...view, autoApproval: { status: "cancelled" } }])
    await setImmediate()
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.title, "Session needs attention")
    assert.equal(Object.hasOwn(request, "permission"), false)
  } finally { await policy.dispose() }
})
