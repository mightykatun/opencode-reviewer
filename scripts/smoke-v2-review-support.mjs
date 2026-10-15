// Independent fixture assertions and read-only SQL. No production imports or writes.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"

export async function readProductionHistory(file) {
  const stat = await lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error })
  if (!stat) return undefined
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Actual isolated production database")
  // Reopen each poll to observe settled worker commits without checkpointing.
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    db.exec("BEGIN")
    // File creation precedes the atomic schema commit. Only a genuinely empty
    // schema is pending; a partial or damaged committed schema must still fail.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    if (!tables.length) return undefined
    const rows = db.prepare(`SELECT h.*,r.context,r.accepted,p.body FROM history h
      JOIN reviews r ON r.id=h.review JOIN payloads p ON p.id=h.id ORDER BY h.completed,h.tie,h.id`).all()
    const reviews = db.prepare("SELECT id,root,session,context,accepted FROM reviews ORDER BY id").all()
    const attempts = db.prepare("SELECT id,review,dispatched,finalized FROM attempts ORDER BY id").all()
    const approvals = db.prepare("SELECT * FROM approvals ORDER BY id").all()
    const meta = db.prepare("SELECT version,revision,totals FROM meta WHERE id=1").get()
    const conversations = db.prepare("SELECT id,totals,partial FROM conversation_totals ORDER BY id").all()
    const payloadCount = db.prepare("SELECT count(*) AS n FROM payloads").get().n
    db.exec("COMMIT")
    return { file, rows, reviews, attempts, approvals, meta, conversations, payloadCount }
  } catch (error) {
    // Initial journal setup may briefly hold an exclusive lock. Let the caller's
    // existing polling deadline own retries, never hide corruption/SQL errors.
    if (error.code === "ERR_SQLITE_ERROR" && (error.errcode & 255) === 5) return undefined
    throw error
  } finally { db?.close() }
}

export function assertWriteInspection(inspection, request, call, sessionID, handshake) {
  assert.deepEqual(inspection.request, request)
  assert.equal(request.sessionID, sessionID)
  assert.equal(request.source.type, "tool")
  assert.equal(request.source.id, call.id)
  assert.equal(inspection.session.id, sessionID)
  assert.equal(inspection.session.parentID, undefined)
  assert.deepEqual(inspection.session.location, handshake.location)
  assert.equal(inspection.session.projectID, handshake.project.id)
  assert.equal(inspection.message.id, request.source.messageID)
  const native = inspection.message.content.filter(item => item.type === "tool" && item.id === call.id)
  assert.equal(native.length, 1)
  assert.equal(native[0].name, "write")
  assert.equal(native[0].state.status, "running")
  assert.deepEqual(native[0].state.input, call.input)
  assert.deepEqual(inspection.captured.request, request)
  assert.deepEqual(inspection.captured.invocation, { sessionID, assistantID: request.source.messageID, callID: call.id,
    tool: "write", input: call.input, location: handshake.location, project: handshake.project, epoch: handshake.epoch })
  assert.equal(inspection.native.root, sessionID)
  assert.deepEqual(inspection.native.route, { type: "session", sessionID })
  assert.ok(inspection.native.permissions.some(item => item.id === request.id))
}

export function assertWriteEvidence(evidence, { action, target, prompt, initial, project }) {
  assert.equal(evidence.kind, action === "edit" ? "edit" : "external-directory")
  assert.equal(evidence.tool, "write")
  assert.equal(evidence.permission.action, action)
  assert.equal(evidence.permission.type, undefined, "No alternate permission projection")
  assert.deepEqual(evidence.operation.input, { path: target }, "Exact target retained; write body is deliberately omitted")
  assert.equal(evidence.userPrompt, prompt)
  assert.deepEqual(evidence.location, { directory: initial })
  assert.equal(evidence.project.directory, project)
  assert.equal(evidence.files, undefined, "No full target-file snapshots")
  if (action === "edit") {
    assert.equal(evidence.partial, false)
    assert.equal(evidence.permission.metadata, undefined, "Raw preview is normalized, not duplicated")
    assert.equal(evidence.changes.length, 1, "Exactly one host-declared target and diff")
    assert.equal(evidence.changes[0].file, target)
    assert.equal(evidence.changes[0].status, "included")
    assert.equal(evidence.changes[0].hostStatus, "modified")
    assert.match(evidence.changes[0].patch, /-V2_EDIT_BEFORE\n\+V2_EDIT_AFTER/)
  } else {
    assert.equal(evidence.partial, true, "Directory review does not certify omitted write contents")
    assert.equal(evidence.changes, undefined)
    assert.equal(evidence.permission.metadata?.files, undefined, "Directory authorization precedes preview construction")
  }
}

export function assertEvidenceRequest(evidence, request, sessionID, initial, projectID) {
  const { metadataStatus, metadata, source, ...permission } = evidence.permission
  assert.ok(metadataStatus)
  const { metadata: nativeMetadata, ...nativePermission } = request
  assert.deepEqual({ ...permission, source: { type: "tool", messageID: source.assistantID, id: source.id } }, nativePermission)
  if (metadata !== undefined) assert.deepEqual(metadata, nativeMetadata)
  assert.equal(evidence.conversation.current.id, sessionID)
  assert.equal(evidence.conversation.root.id, sessionID)
  assert.equal(evidence.conversation.current.location.directory, initial)
  assert.equal(evidence.conversation.current.projectID, projectID)
  if (request.action === "edit") {
    assert.equal(request.metadata.files.length, 1)
    const preview = request.metadata.files[0]
    assert.deepEqual(request.resources, [preview.file])
    assert.equal(preview.status, "modified")
    assert.equal(preview.additions, 1)
    assert.equal(preview.deletions, 1)
    assert.equal(evidence.changes[0].patch, preview.patch, "Exact pending native diff, not a reconstructed proposal")
  }
}

// Return undefined only while asynchronous worker commits are still incomplete.
// Every expectation is fixture-owned, never derived from production totals.
export function savedStageHistory(value, expected, sessionID) {
  const count = expected.length
  if (!value || value.rows.length < count || !value.meta || !value.conversations.length) return undefined
  const rows = expected.map(stage => value.rows.find(row => JSON.parse(row.context).permission === stage.request.id))
  if (rows.some(row => !row)) return undefined
  const reviews = rows.map(row => value.reviews.find(review => review.id === row.review))
  if (reviews.some(review => !review?.accepted)) return undefined
  const totals = [JSON.parse(value.meta.totals), ...value.conversations.map(row => JSON.parse(row.totals))]
  if (totals.some(total => total.activity.reviews !== count || total.activity.autoApproved !== count
    || total.activity.usageRequests !== count)) return undefined
  assert.equal(value.meta.version, 1)
  assert.equal(value.rows.length, count)
  assert.equal(value.payloadCount, count, "Only qualifying native resolutions save report bodies")
  assert.equal(value.conversations.length, 1)
  const opaque = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
  const scope = JSON.parse(rows[0].context).scope
  for (const [index, row] of rows.entries()) {
    const stage = expected[index], context = JSON.parse(row.context), payload = JSON.parse(row.body)
    assert.equal(context.scope, scope)
    assert.equal(context.root, sessionID)
    assert.equal(context.session, sessionID)
    assert.equal(context.permission, stage.request.id)
    assert.equal(context.category, stage.action, "Directory and edit have separate saved categories")
    assert.equal(context.configuredModel, "v2-production-reviewer")
    assert.equal(row.id, opaque(scope, context.review))
    assert.equal(row.entry, opaque(scope, stage.request.id))
    assert.equal(row.root, opaque(scope, sessionID))
    assert.equal(row.session, opaque(scope, sessionID))
    assert.equal(row.outcome, "auto")
    assert.equal(row.resolution, "auto")
    assert.equal(row.approving, row.review)
    assert.equal(payload.safe, true)
    assert.equal(payload.desc, stage.description)
    assert.deepEqual(payload.usage, { input: 23, output: 11 })
    assert.equal(JSON.parse(row.accepted).safe, true)
    const review = reviews[index]
    assert.equal(review.root, row.root)
    assert.equal(review.session, row.session)
    assert.deepEqual(JSON.parse(review.context), context)
    const attempts = value.attempts.filter(attempt => attempt.review === row.review)
    assert.equal(attempts.length, 1, "One reviewer POST per accepted stage")
    if (!attempts[0].finalized) return undefined
    assert.equal(JSON.parse(attempts[0].dispatched).retry, "initial")
    assert.deepEqual(JSON.parse(attempts[0].finalized).usage, { input: 23, output: 11 })
    const approvals = value.approvals.filter(approval => approval.review === row.review)
    assert.equal(approvals.length, 1)
    if (approvals[0].state !== "confirmed") return undefined
    assert.equal(approvals[0].entry, row.entry)
    assert.equal(approvals[0].automatic, 1)
    assert.equal(value.conversations[0].id, row.root)
  }
  assert.equal(value.conversations[0].partial, 0)
  for (const total of totals) {
    assert.equal(total.requests, count)
    assert.equal(total.tokenRequests, count)
    assert.equal(total.input, count === 1 ? 23 : 46)
    assert.equal(total.output, count === 1 ? 11 : 22)
    assert.equal(total.safe, count)
    assert.equal(total.unsafe, 0)
    assert.equal(total.priced, 0, "Loopback model has no price coverage")
    assert.equal(total.cost, 0)
    assert.equal(total.activity.retries, 0)
    assert.equal(total.activity.timedReviews, count)
  }
  return { ...value, totals }
}
