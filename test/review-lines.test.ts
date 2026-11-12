import assert from "node:assert/strict"
import { test } from "node:test"
import { automaticCopy, reasonLine, steeringLine } from "../src/review-lines.js"
import { uiText } from "../src/ui-text.js"

test("the reason line uses the fixed label of the rating and skips older reports without a reason", () => {
  assert.deepEqual(reasonLine({ status: "complete", assessment: { safe: true, reason: " Reads only. ", desc: "d" } }),
    { approved: true, label: "Reason for approval:", text: "Reads only." })
  assert.deepEqual(reasonLine({ status: "complete", assessment: { safe: false, reason: "Deletes data.", desc: "d" } }),
    { approved: false, label: "Reason for rejection:", text: "Deletes data." })
  assert.equal(reasonLine({ status: "complete", assessment: { safe: true, desc: "legacy report" } }), undefined)
  assert.deepEqual(reasonLine({ status: "analyzing", progress: { preview: { safe: false, reason: "Dele" } } }),
    { approved: false, label: "Reason for rejection:", text: "Dele" }, "streams with the preview")
  assert.equal(reasonLine({ status: "analyzing", progress: { preview: { reason: "no rating yet" } } }), undefined)
  assert.equal(reasonLine({ status: "complete", progress: { preview: { safe: true, reason: "stale preview" } } }), undefined)
})

test("steering shows only while a rejection is armed or sent, and the footer copy mirrors auto-approval", () => {
  const armed = { autoDecision: "reject" as const, steering: " Please narrow it. " }
  for (const status of ["countdown", "checking", "waiting", "allowing", "approved", "failed"])
    assert.equal(steeringLine({ ...armed, autoApproval: { status } }), "Please narrow it.", status)
  assert.equal(steeringLine({ ...armed, autoApproval: { status: "cancelled" } }), undefined)
  assert.equal(steeringLine(armed), undefined, "not armed")
  assert.equal(steeringLine({ autoDecision: "once", steering: "x", autoApproval: { status: "countdown" } }), undefined)
  assert.equal(automaticCopy({ autoDecision: "reject" }), uiText.autoRejection)
  assert.equal(automaticCopy({ autoDecision: "once" }), uiText.autoApproval)
  assert.equal(automaticCopy({}), uiText.autoApproval)
  assert.deepEqual(Object.keys(uiText.autoRejection), Object.keys(uiText.autoApproval))
  assert.equal(uiText.autoRejection.countdown(12), "Rejected in 12s")
})
