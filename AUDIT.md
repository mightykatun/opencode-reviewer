# Codebase Audit and Fixing-Agent Plan

## Handoff status

- **Audit date:** 2026-10-10.
- **Audited source:** `2f2f863ca9ba6d1baa7b6f399c001e65315ae7ce`.
- **Target:** Linux OpenCode **1.18.35**, Node.js **24.21.0**, npm **12.2.0**.
- **Scope:** production source, prompts/contracts, persistence, notifications, UI,
  build/release tooling, dependencies, tests, fixtures, documentation and dead code.
- **Additional investigation:** automatic approval becoming cancelled or permanently
  manual without a human click, command or approval action.
- **User-reported addition:** an already-notified pending permission is covered by
  a newer request, then emits another notification when the covering request is
  approved. Requested fix direction: investigate vertical permission stacking,
  newest at the bottom, rather than a direct notification-suppression patch.
- **User-requested presentation change:** keep the reviewer side panel visible only
  in the top-level conversation. Navigating into its subagents should hide the
  panel while normal review countdowns and automatic approvals continue (F34).
- **Implementation status:** F01-F04, F06-F09, F12-F15, F23 and F25 have post-fix
  dispositions below. F05 is now complete; F32 has a measured compatibility disposition.
  F33 was dropped and F34 deferred by the user; remaining findings are open. Historical audit
  reproductions assert the original failure; only implementation-disposition
  results describe verification of fixes.
- **Repository changes by this review:** this document only. `AUDIT.md` was already
  empty when this handoff was requested. No production fixes have been applied.

Read `AGENTS.md` before implementing. Source references below describe the audited
commit; verify them after edits. Preserve user work and do not infer that historical
audit findings are still present merely because an older document calls them open.

### Executive assessment

The highest-risk defects positively supply the wrong source file as reviewer
evidence. Under opt-in automatic approval, a benign decoy can influence assessment
of a different executable target. Wrong-file collection was reproduced; no live-model
unsafe judgment or end-to-end malicious approval is claimed.

The strongest availability defects are unbounded legacy-baseline work inside a
three-second transaction budget, slow scope-wide deletion reconciliation, and
commit-driven refresh starvation. Bounded memory is not bounded execution time.

The no-input approval investigation confirmed two independent controller problems:
read-only verification failure becomes permanently manual despite no write, and
fast-mode preview rejection is mistaken for permanent visibility loss. Two further
presentation problems are reproduced at the helper/lifecycle level and need exact
real-TUI timing verification before their UI fixes are accepted.

The codebase has substantial strengths: narrow once-only writes, fresh dispatch
guards, physical operation ownership, strict assessment parsing, transactional
accounting replay, literal notification argv, and verified artifact publication.
Fix the defects without weakening those boundaries.

F34 is an explicitly requested change to the current normal-mode presentation
contract, not a claim that general hidden approval is already supported. References
elsewhere to physical visibility describe the audited baseline and controls outside
this proposed same-conversation subagent-navigation exception. Specify that exception
before implementing related presentation changes; do not silently bypass guards.

## Severity and evidence conventions

- **P1 / High:** misleading evidence at an automatic-execution trust boundary.
- **P2 / Medium:** functional failures, significant privacy/availability concerns,
  workload amplification, or unreliable active verification infrastructure.
- **P3 / Low:** conditional hardening, smaller correctness/retention problems,
  flakiness, interface cleanup or documentation maintenance.
- **Confirmed:** directly reproduced, or established by deterministic control flow.
- **Conditional:** the defect requires the stated environment or workload.
- **Validation-first:** source-supported concern without a measured production
  effect. Establish impact before implementing speculative changes.

### Finding inventory

| ID | Priority | Finding | Evidence / scope |
| --- | --- | --- | --- |
| F01 | P1 | ANSI-C byte escapes select a different source file | Full evaluator and Bash reproduction |
| F02 | P1 | Shell negation hides directory-changing builtins | Full evaluator and Bash reproduction |
| F03 | P2 | Skill scanner captures concatenated-argument fragments | Full skill collector reproduction |
| F04 | P2 | Symlinked launch cwd makes later `cd` inference unsound | Bash/evaluator reproduction; host PWD condition unverified |
| F05 | P2 | Deleted report plaintext remains in SQLite pages | Node adapter reproduction; Bun default unmeasured |
| F06 | P2 | Legacy baseline exceeds watchdog and blocks FIFO | Source worker reproduction with large legacy root |
| F07 | P2 | Deletion reconciliation suppresses history for minutes | Deterministic scheduler and source trace |
| F08 | P2 | Single history selection repeatedly scans whole root | Node SQLite timings and query plans |
| F09 | P2 | Commits invalidate every readable backlog snapshot | Store/refresh reproduction |
| F10 | P2 | Reviewer work has no overall admission limit | 64 simultaneous evaluators reproduced |
| F11 | P2 | Repeated Enable aborts/restarts unchanged-mode reviews | Registered command handler reproduction |
| F12 | P2 | Pre-dispatch verification failure is permanently manual | SDK GET, timeout, unrelated-event and read-slot reproductions |
| F13 | P2 | Fast preview rejection creates permanent cancellation | Real reviewer SSE retry plus controller reproduction |
| F14 | P2 | Pending renewed paint is treated as visibility loss | Geometry/controller reproduction; host timing follow-up |
| F15 | P2 | Same-session sidebar replacement cancels live review | Solid lifecycle reproduction and pinned-host source |
| F16 | P2 | Terminal SSE refusal/filter/tool-call loses later usage | Injected, well-framed response reproductions |
| F17 | P2 | Fresh permission alerts bypass unknown startup baseline | Host bridge/policy reproduction |
| F18 | P2 | Question reconciliation loses completed-turn alert | Event clock and host bridge reproduction |
| F19 | P2 | Early wrapper exit delays descendant cleanup | Ordinary child-process reproduction |
| F20 | P2 | Permission notification fixture expects disabled audio | Actual pinned-host fixture failure |
| F21 | P2 | Cancelled scroll fixture expects successful approval | Actual pinned-host fixture failure |
| F22 | P2 | Desktop fixture confuses playback attempts with cases | Source-confirmed; desktop execution not performed |
| F33 | P2 | Covered pending permission re-notifies when covering request resolves | Controller/host-bridge reproduced; pinned native ordering/rendering traced; stack needs host support |
| F34 | P2 | Subagent routes should hide the reviewer panel without stopping normal automation | Requested behavior change; current opposite behavior and related history fixes verified |
| F32 | P2 | Mouse-disabled host cannot satisfy hit-grid readiness | Validation-first compatibility concern |
| F23 | P3 | SQLite pathname open is not anchored to private checks | Conditional ancestor-swap reproduction |
| F24 | P3 | Nested deadlines reconstruct an extended absolute end | Controlled monotonic-clock reproduction |
| F25 | P3 | Closed/deleted history retains report-bearing state | Controller reproduction |
| F26 | P3 | Retry timing test does not control production sleep | Node 24 timer reproduction |
| F27 | P3 | Cleanup test has contradictory startup/timeout budgets | Source-confirmed timing dependency |
| F28 | P3 | Lifecycle fixture assumes temporary files live in `/tmp` | Extraction expression reproduction |
| F29 | P3 | Unused export modifiers/bindings and unreachable branch | Symbol/consumer analysis and unused checks |
| F30 | P3 | Historical notification handoff misstates current status | Historical/current source comparison |
| F31 | P3 | Retired syntax styles wait for global renderer idle | Validation-first resource-lifetime concern |

F31 and F32 are follow-up investigations, not demonstrated leaks or live-host failures.
They must not be reported as fixed by merely adding a test that mirrors assumptions.

## Automatic approval without human input: traced behavior

### The label does not identify the cause

`cancelAutoApproval()` at `src/controller.ts:191-200` accepts `explicit` or
`visibility`, stops the reservation/timer, and writes a durable `cancelled`
tombstone. The same visible label can follow a click or an entirely automatic
presentation/eligibility failure. A GET/acknowledgement error instead generally
produces `failed`, displayed as unavailable. Both can leave a Safe permission manual.

### Complete stop and tombstone map

| Path | Source | Effect / intended interpretation |
| --- | --- | --- |
| Cancel button | `live-review-panel.tsx:130-131`; `tui.tsx:318` | Explicit durable cancellation |
| Presented request ID changes/disappears | `controller.ts:166-171` | Automatic durable cancellation of prior request |
| Live panel cleanup | `live-review-panel.tsx:253-258` | Publishes missing presentation; valid for disappearance, faulty for F15 handoff |
| Countdown eligibility fails | `controller.ts:278-281` | Automatic cancellation, including between frames |
| Approval boundary eligibility fails | `controller.ts:310,328,332,340,353,393` | Automatic cancellation; F13 conflates rating loss with visibility loss |
| Mode suspension | `controller.ts:133-162` | Existing automation becomes cancelled/failed; dispatched fast review retained |
| Actual write invocation | `controller.ts:361-372` | Correctly creates one-shot uncertainty protection before invoking `once()` |
| Generic approval catch | `controller.ts:406-425` | Creates `failed` even when `dispatched=false`; F12 |
| Native resolution/healthy absence/deletion | `controller.ts:502-561` | Removes ordinary view and clears request tombstone, not necessarily a cancelled label |
| Controller disposal | `controller.ts:572-583` | Ends lifecycle, aborts owned work and clears state |
| Three stale verification reads | `controller.ts:397-404,545-549` | Waits for fresh reconciliation without a manual tombstone |

### Genuine automatic cancellations that should remain

Human input is not required for these safeguards:

- An earlier native blocker arrives from another tool/subagent in the same queue.
  Disabled/unsupported kinds still own native priority.
- The host creates a covering dialog, navigates away, removes the sidebar, or
  physically covers/clips the report or approval controls.
- Presentation actually disappears after countdown start. Genuine loss must remain
  durable across remounts and re-enable; do not revive it because it later returns.
- Public state can no longer establish the selected request's scope/ancestry.

**Requested exception, F34:** intentionally suppressing the normal review panel
while browsing a descendant of the same root should not itself become visibility
cancellation. This exception is not implemented in the audited source. It must be
specified separately from actual native-priority loss, uncertain scope, user Cancel,
mode disable, deletion, disposal or an already invoked uncertain write.

Do not "fix spontaneous cancellation" by dropping native-order, visibility,
geometry, scope or write-boundary checks.

### Counterexamples and paths ruled out

- Unrelated-conversation ask/reply/delete events during a normal Safe countdown did
  not directly cancel it; the control approved once. Such events do increment a
  global revision and can exhaust a verification budget as in F12.
- Three stale reads recover through ordinary `PendingRefresh` and a subsequent
  eligible frame. Normal mode restarts its configured countdown, including grace;
  fast mode starts fresh checking. Repeated frames alone cannot replenish the loop.
- A noncooperative pending refresh can hold recovery until actual settlement. This
  is bounded ownership protection, not evidence of a permanent manual tombstone.
- Transient ancestry and saved-mode gate failures recovered after fresh polling
  without a tombstone. Deletion invalidates ancestry caches, not an already-gated
  countdown directly.
- Same-request countdown publications preserve the request-ID mount and assessment
  identity. Ordinary second updates do not inherently remount Markdown.
- No constant-viewport cancellation defect was confirmed in ordinary history
  polling, scroll restoration, report scrolling or newly exposed highlighting.
  Initial highlighting readiness is latched, so scrolling does not re-run it.
- Terminal evaluator failures stay `unidentified`/`unavailable` until another review
  lifecycle. That is terminal analysis behavior, not approval cancellation. Do not
  indiscriminately retry provider refusals, malformed output or all evidence errors.

### Physical presentation checks

`src/live-review-panel.tsx:202-224` and `src/review-geometry.ts:19-55` require a
presentation session, on-screen regions matching painted proof, exact native-first
request selection, and physical heading/lower-padding hit ownership. Normal mode
also requires final assessment identity and initial completed Markdown highlighting.
Only production history can substitute its actual cover proof; fast mode has no
history-cover exception.

`src/tui.tsx:289-304` requires a session route and no public native dialog. Root
presentation depends on the observed native sidebar; direct-child fallback needs
parent metadata and enough width. `Controller.eligible()` at `263-270` additionally
requires an active unresolved request, enabled mode, Safe final/fast preview, and
both stored and freshly recomputed presentation identity.

The fixes must distinguish **visible**, **proven lost**, **temporarily unproven
paint/handoff**, and **provisional rating no longer eligible**. These are different
states, not interchangeable reasons to create a permanent manual tombstone.

## Detailed findings and acceptance criteria

### F01. ANSI-C byte escapes select the wrong source file

**Priority:** P1. **Where:** `src/shell-discovery.ts:405-417`; consumed by
`src/evidence.ts:95,136`.

`python $'\xc3\xa9.py'` names `é.py` in Bash, but pinned `shell-quote` decodes byte
escapes into JavaScript characters and discovery captures `Ã©.py`. With both files
present, the unrelated file was `captured` and discovery reported no limitations.
Project-controlled decoys can therefore mislead an automatic reviewer.

**Fix direction:** reject unsupported ANSI-C syntax with a factual limitation, or
implement byte-faithful operand decoding with explicit locale/filename constraints.
Do not trust tokenizer strings as Bash byte identity.

**Acceptance:** differential harmless Bash argument tests for hex/octal multibyte
sequences and invalid UTF-8; never positively capture a different file. Preserve
literal-only discovery and exact command text. No shell execution in production.

### F02. Negation hides in-process working-directory changes

**Priority:** P1. **Where:** `src/shell-discovery.ts:362-394`, especially `380`;
operator transitions at `158-167`.

`! cd sub; python job.py` changes Bash cwd to `sub`; negation changes status, not
the builtin's effect. Discovery treats `!` as a command and captures parent
`job.py`. The only relevant notice is the generic preceding-statement snapshot
notice, not unresolved cwd. Negated sourcing/eval/state changes expose the same
dispatch gap, though those extensions were source-traced rather than all executed.

**Fix direction:** recognize command-position `!` before dispatch, or invalidate
cwd and omit unsupported negated discovery as a whole.

**Acceptance:** actual harmless cwd/argument differential tests for negated `cd`
and representative state-changing builtins, plus external-command controls. Unknown
syntax must not silently preserve falsely known state.

### F03. Skill command regex captures argument fragments

**Priority:** P2. **Where:** `src/skill-evidence.ts:79-86,152`.

`Run \`python "scripts/"check.py\`.` names `scripts/check.py`. The regex extracts
`scripts/` and `check.py`, discards the directory fragment and captures root-level
`check.py`, reporting `partial: false`. The comment claiming literal tokens is
stronger than the parser. Catalog instructions remain intact but supporting
evidence positively misidentifies their target.

**Fix direction:** a bounded quote-aware literal tokenizer for recognized command
spans; omit unsupported constructs whole with a limitation rather than suffix paths.

**Acceptance:** concatenated quotes, escaped quotes, normal quoted operands and
unsupported syntax; preserve the direct-reference and skill-directory boundaries.

### F04. Symlinked launch cwd does not prove shell logical cwd

**Priority:** P2, conditional. **Where:** `src/context.ts:113-130`;
`src/evidence.ts:95`; `src/shell-discovery.ts:261-264`.

For `/project/launch-link -> /outside/deep`, `cd .. && python job.py` with a
mismatching inherited PWD runs `/outside/job.py`. Discovery lexically resolves from
the declared path and captures `/project/job.py`, despite recorded `canonicalCwd`.
Reproduced using Bash and the evaluator; exact pinned-host launch environment is
not yet verified.

**Fix direction:** represent declared/physical launch ambiguity. Do not infer
post-cd relative targets when logical cwd cannot be established. Blindly replacing
declared cwd with canonical cwd is also incorrect for valid logical PWD.

**Acceptance:** matching and mismatching inherited PWD, symlink launch workdir and
post-cd operands, plus an exact pinned-host check. Keep missing invocation location
unknown and relative workdir rooted in invocation `path.cwd`.

### F05. Logical deletion leaves recoverable report bytes

**Priority:** P2 privacy. **Where:** `src/history-schema.ts:56,191-201`;
`README.md:223-229`.

A unique report marker remained in a closed Node SQLite database after payload
row deletion, WAL checkpoint/TRUNCATE and close. `secure_delete` was zero. Private
permissions limit exposure, but row deletion does not meet physical plaintext
removal expectations. Bun defaults were not measured.

**Fix direction:** explicit secure-deletion policy/configuration and owned
checkpoint/compaction behavior. Handle compatibility internally; do not add storage
upgrade or migration warnings. Backups/filesystem copies are a separate boundary.

**Acceptance:** prove logical rows are absent and marker bytes are absent from
the relevant active SQLite files after owned cleanup, on Node and Bun adapters.
Preserve lifetime/conversation aggregates, replay and deletion tombstones.

### F06. Legacy bootstrap can make the storage FIFO unable to progress

**Priority:** P2. **Where:** `src/history-schema.ts:119-174,186-190`;
`src/history-store.ts:169-197`.

Baseline arrays are paged, but the entire legacy root is processed in one operation.
Every first event calls `ensureConversation()` inside the transaction. The
three-second watchdog kills the worker, rolls back baseline/event, and retries the
same head. A 50,000-review baseline took 4.23-4.94 seconds on Node. An 80,000-review
actual source-worker case timed out twice, committed nothing, and blocked an
unrelated root behind it. Bun threshold remains unmeasured.

**Fix direction:** bounded resumable baseline work and atomic final materialization,
with consistent snapshot/replay semantics. Separate bootstrap from ordinary event
application. Raising the watchdog alone does not bound work.

**Acceptance:** large retained-v1 root progresses across watchdog-sized work slices;
unrelated roots can eventually commit; interruption/replay does not duplicate
contributions; baseline deletion cannot deadlock. Never reconstruct lifetime from
detail rows. Test slow-worker conditions, not only a fast small fixture.

### F07. Scope-wide deletion recovery is too slow

**Priority:** P2. **Where:** `src/history-coordinator.ts:217-237`;
`src/history-maintenance.ts:43-84,97-100`; `src/history-store.ts:177-181`.

Every live deletion marks the store dirty. All its history reads are gated until
a healthy pass. One row per two-second turn means 1,000 healthy sessions required
1,001 turns: about 33 minutes of delays before host latency. Further invalidations
restart the pass; unhealthy presence prevents gate release. Exact notification
history selection's five-second save wait expires behind the gate.

**Fix direction:** bounded batches/time-budgeted throughput during dirty recovery,
retaining one actual owned read and the revisioned complete-healthy-pass requirement.

**Acceptance:** deterministic wall-clock availability test with many sessions;
root-first cascading, unknown/bare-404 preservation, concurrent invalidation and
interruption negative controls. Do not restore the old cursor-restart defect.

### F08. Indexed history selection still has linear steady-state work

**Priority:** P2 workload. **Where:** `src/history-schema.ts:337-360`;
`src/history-refresh.ts:25-30`.

Every read scans scalar validity and ownership, counts the root and counts rank.
On healthy data, `LIMIT 1` still scans to prove no invalid row exists. Timings for
1k/10k/100k entries were 5-12 / 47-59 / 773-813 ms on Node. Two-second polling and
shared windows repeatedly consume worker capacity on unchanged history.

**Fix direction:** stronger schema/write invariant enforcement and revision-aware
validation/count caching; selected-record checks remain mandatory. Avoid unnecessary
whole-root work while preserving payload repair polling.

**Acceptance:** query-plan/work-scaling check and shared-read/write fixture with a
large valid root, corrupt selected row and repaired payload. Do not justify bounded
work solely by a bounded returned record size.

### F09. Commit notifications starve otherwise successful refreshes

**Priority:** P2. **Where:** `src/history-refresh.ts:19,35-50`;
`src/history-store.ts:149-188`.

Each commit increments refresh generation, so a read queued behind a write is
invalidated before execution. Forty queued writes produced 39 completed reads and
zero published snapshots until the backlog drained. History/statistics can remain
loading/stale and notification selection can miss an already committed entry.

**Fix direction:** separate selection invalidation from dirty/coalesced follow-up.
Publish healthy same-selection snapshots and schedule newer data; maintain strict
guards for navigation, deletion/maintenance, disposal and accounting outages.

**Acceptance:** continuous/bursty writes yield useful snapshots before draining;
stale navigation/deleted reports never publish; actual-read ownership and existing
slow-poll protection stay intact.

### F10. Same-root review fanout bypasses overall admission limits

**Priority:** P2 workload. **Where:** `src/controller.ts:428-470,121-124`;
`src/tui.tsx:151-175`.

Sixty-four same-root requests launched 64 simultaneous evaluators and 128
publications before completion. Metadata gates coalesce, then all reviewer work
dispatches. Hidden queued permissions can amplify evidence/model concurrency and
40 ms streaming publications copying the full collection. Actual production
provider exhaustion was not measured.

**Fix direction:** bounded review admission prioritizing native front-of-queue,
with fair queued work and cancellation-aware admission. Preserve synchronous
visibility/cancellation publications and disabled native blockers.

**Acceptance:** large same-root/child fanout proves concurrency and progress bounds,
front-request latency, queue handoff and cancellation of waiting work. No delayed
publication may weaken dispatch eligibility.

### F11. Enable is destructive when already enabled

**Priority:** P2. **Where:** `src/session-mode-commands.ts:24-34`;
`src/controller.ts:133-162,555-561`; `src/session-mode.ts:199-203`.

Repeated Enable calls `changed(root)` even when mode is unchanged. Suspension aborts
work/discards reports and can create a cancellation tombstone. Registered-handler
reproduction yielded two evaluations, cancelled approval, zero writes. Palette
coverage independently cancels countdowns; direct command dispatch isolates the
additional bug. This is a human-command path, not the new no-input explanation.

**Fix direction:** distinguish mode transition from unchanged request. If persistence
needs retry, retry storage independently of review invalidation.

**Acceptance:** repeated Enable during evaluation, after completion and during an
uncovered countdown has no extra model call, report loss or new tombstone. Actual
disable/re-enable and failed saved-mode read safeguards still work.

### F12. A read-only verification failure permanently disables automation

**Priority:** P2, confirmed no-input behavior. **Where:**
`src/controller.ts:293-303,323-336,406-425,545-553`.

The generic catch writes `manual.set(id, "failed")` even when `dispatched=false`.
Observer facts correctly report `settled/not-sent`, but healthy recovery only sets
`approvalPendingConfirmed`; it never clears the failed automation state.

Four deterministic no-input triggers were reproduced:

1. Verification GET returns 503; recovery GET and periodic poll succeed.
2. GET exceeds five seconds; late settlement and healthy polling follow.
3. Unrelated reply arrives during a four-second GET; revision invalidation requires
   another read which exceeds the remaining one-second budget.
4. An old resolved request still owns a noncooperative verification read; a new
   request times out waiting for the slot before invoking its own GET.

All remain failed after fresh reconciliation/frames with zero approval writes.
The SDK-boundary 503 case used only GET requests and emitted `settled/not-sent`.

**Fix direction:** classify pre-dispatch recoverable GET/admission/time-budget
failure separately from dispatched uncertainty. Retain physical read ownership,
enter bounded reconciliation-wait, and rearm only after actual settlement and a
fresh identical pending request. Do not loop verification on every frame, or
automatically reuse an assessment for changed same-ID scope/arguments.

**Acceptance:** all four cases recover autonomously once eligible with exactly one
eventual `once()`. Controls: explicit Cancel, real visibility loss, same-ID changes,
mode disable, synchronous `once()` throw and acknowledgement timeout remain manual
as appropriate. Every actually invoked write stays single-shot even if native
resolution arrives before HTTP acknowledgement. No model retry/deadline changes.

**Existing tests to distinguish:** `test/approval.test.ts:637-694` correctly tests
read ownership and the shared budget, but also retains failed state after late
settlement. Extend it with fresh-reconciliation recovery. The pre-dispatch error
expectation at `918-929` needs classification rather than blanket permanent failure.
Do not weaken the genuinely dispatched uncertainty controls at `850-873,888-915`.

### F13. Fast preview invalidation becomes false visibility cancellation

**Priority:** P2, confirmed no-input behavior. **Where:**
`src/controller.ts:222-237,263-269,328-332,191-199`;
`src/reviewer.ts:235,277-279,340-343`.

Safe preview starts checking. Retry/rejection clears the preview. If the GET then
settles, `eligible()` is false for rating reasons and the controller records
`visibility` cancellation. A final validated Safe retry cannot rearm. The same
sequence succeeds if final Safe arrives before GET settlement.

Real reviewer SSE parser/retry reproduction: two POSTs, complete final Safe report,
cancelled automation, one verification GET, zero approval writes. The report stayed
selected/visible in the injected presentation control; no human action occurred.

**Fix direction:** provisional rating eligibility loss must invalidate/pause the
pre-dispatch reservation, not create a manual visibility tombstone. Rearm from the
current attempt's new Safe rating or validated report after prior verification
settles. Keep progress generation and actual physical/native-priority checks.

**Acceptance:** both orderings, cleared/Unsafe replacement preview, final Unsafe,
format correction, transport retry and nonstream fast mode. No write from the
rejected preview; exactly one later write only if currently Safe and physically
eligible. Real hide/preemption still permanently cancels and dispatched retained
reports continue to follow existing semantics.

**Existing coverage gap:** `test/fast-mode.test.ts:190-201` checks zero writes after
retry/Unsafe while verification is held, which is necessary. It does not follow
the later replacement Safe rating/final report. Extend both timing orderings rather
than removing the initial no-write assertion.

### F14. Benign resize before renewed paint can permanently cancel

**Priority:** P2, pure-confirmed; real-TUI timing verification required.
**Where:** `src/review-geometry.ts:45-55`; `src/live-review-panel.tsx:202-205,226-247`;
`src/controller.ts:263-281,310,328-353`.

After valid paint/countdown at width 160, changing only viewport width to 161 leaves
all regions fitting, but saved proof exact equality becomes false. A countdown
callback before FRAME creates a durable cancelled tombstone; renewed valid paint
cannot revive it. OpenTUI updates dimensions/emits RESIZE before requesting the
next render, so this interval is available. A layout event can be programmatic;
the reproduction issues no human Cancel/approval command.

**Fix direction:** distinguish pending renewed paint from proven physical loss.
Block dispatch while unproven, keep the original countdown deadline, and cancel
only for established hiding, clipping, cover or queue loss. Do not ignore geometry
changes or use a grace window to approve through actual coverage.

**Acceptance:** deterministic timer/post-list callback between RESIZE and renewed
FRAME, with same-branch enlargement control. Verify in the real pinned host.
Actual narrow/short clipping, hidden sidebar, dialogs/fullscreen and earlier native
blockers must still cancel immediately when proven. Never restart the countdown
merely to hide the race.

**Existing proof control:** `test/review-geometry.test.ts:49-64` correctly rejects
stale geometry/owner proof. Keep that rejection at the dispatch boundary; fix the
downstream conversion of temporary missing proof into permanent cancellation.

### F15. Same-session sidebar owner handoff unmounts the live review

**Priority:** P2, pure-confirmed; physical continuity requires host verification.
**Where:** `src/tui.tsx:244-251,289-305,310-323`;
`src/live-review-panel.tsx:253-258`; `src/controller.ts:166-171,191-200`.

Pinned host `v1.18.35` (`53d1eabb61e21162157817bf677da0a4ad3332e3`) uses distinct
Sidebar owners across its `width > 120` breakpoint in
`packages/tui/src/routes/session/index.tsx:270-275,1338-1357`. An explicitly opened
sidebar stays logically visible, but old slot cleanup clears the plugin signal
before the replacement effect restores the same session. Pure Solid lifecycle:
`sidebar cleanup -> live cleanup -> sidebar effect -> live mount`. Same permission
and Safe report remount with an already permanent manual tombstone.

**Fix direction:** stable live owner and explicit same-session observer handoff.
Gate dispatch pending renewed proof without treating every observer cleanup as
physical loss. Do not blanket-delay genuine navigation/hide cleanup or retain a
stale getter that can approve.

**Acceptance:** explicitly opened root sidebar crossing wide/overlay breakpoint,
same-branch control, no missing-report frame and unchanged native-first request.
Default auto-narrow is a genuine hide control, not this case. Test history sibling
handoff too, and revalidate in real TUI after build.

### F16. Terminal assessment rejection discards subsequent SSE usage

**Priority:** P2. **Where:** `src/reviewer.ts:105-108,124,152-180,333-338`;
`README.md:239-242`.

Refusal/filter/tool-call paths throw ordinary terminal errors. Only
`AssessmentStreamError` drains subsequent usage. Validly framed terminal usage
later in the same network chunk or a later chunk is discarded. Reproductions
supplied 12 input, 4 output and $0.03; review failed once, but `onUsage` received
nothing. The README's failed-review accounting description overstates this path.

**Fix direction:** retain non-retryable assessment rejection while draining
accounting under unchanged framing/deadline/resource bounds. Clear previews, never
retry refusal/tool calls, and terminate immediately for corruption/cancellation.

**Acceptance:** same/separate-chunk terminal usage after all three rejection types,
one POST, no accepted report, correct usage finalizer. Keep malformed framing,
invalid UTF-8, resource limits and abort controls.

### F17. Permission attention outruns unknown startup ordering

**Priority:** P2. **Where:** `src/notification-host.ts:136-150,258-269`.

Healthy-baseline protection applies to questions but not fresh event-born permission
views. With older unseen baseline permission and newer unavailable/disabled request,
`permissionHealthy=false` still emitted attention for the queued newer request.
Later withdrawal cannot undo an already delivered sound/banner.

**Fix direction:** authoritative permission baseline/ancestry before attention
selection, while snapshots establish ordering but never notification births.

**Acceptance:** stalled/failed initial list plus fresh permission, later healthy
baseline and blocker resolution; queued request stays silent until actionable.
Retain startup-no-replay and silent auto-awaiting-render/countdown policies.

### F18. Missed question resolution can suppress Session ended forever

**Priority:** P2. **Where:** `src/notification-host.ts:119-127,285-295,316-340`.

Final message/idle arrives while a stale event-born question remains. Idle check
returns; healthy list reconciliation removes the question but schedules no new
completion check. Reproduction emitted only question, not ended, absent another
idle event.

**Fix direction:** recheck affected tracked roots when reconciliation removes
blockers, with existing final-message/idle/cancellation/deduplication guards.

**Acceptance:** missed reply event, final message before reconciliation, one ended
alert after healthy removal; unresolved question, cancellation, busy state and
repeated polls never manufacture/replay completion.

### F19. Wrapper exit leaves descendants until the full case timeout

**Priority:** P2 tooling. **Where:** `scripts/runtime-runner.mjs:9-35`.

Cleanup listens to `close`, which waits for inherited pipes. A wrapper exiting 7
with an interval child holding its output pipes survived until timeout; an 800 ms
probe returned about 815 ms later with `timedOut: true`. Inventory budgets reach
minutes. The early-exit cleanup comment does not match its event choice.

**Fix direction:** initiate owned process-group cleanup on `exit`, retain pipe and
result ownership through `close`, preserve bounded escalation and isolation.

**Acceptance:** early wrapper exit with inherited-pipe descendants, spawn failure,
abort/timeout, and unrelated survivor. Correct original exit classification and
no surviving owned processes; never kill shared tmux/default servers.

### F20. Automatic permission fixture requires disabled approval audio

**Priority:** P2 tooling. **Where:** `scripts/smoke-permissions.mjs:179-181,375-385`;
default at `src/notification-config.ts:38-46`.

`mcp --auto --notifications` leaves approved sound false but asserts a sound at
line 384. Real pinned-host run failed there after correct once-only completion.

**Fix direction:** explicit sound-enabled dedicated case plus silent-default case.
Do not change production defaults merely to satisfy an obsolete fixture.

**Acceptance:** both cases and relevant auto/cancel/unsafe/error flags, using isolated
notification recorder rather than desktop playback. Update inventory/profile only
if adding supported scenarios/flags.

### F21. Scroll cancellation fixture expects successful auto notifications

**Priority:** P2 tooling. **Where:** `scripts/smoke.mjs:541-597,1022-1036`;
`scripts/smoke-scenarios.mjs:25`.

`auto-scroll --notifications` intentionally clicks Cancel, proves permanent
cancellation and resolves natively, but notification logic groups it with successful
automatic cases. Real run proved cancellation then timed out at line 1023; requiring
an approved banner is also impossible for this scenario.

**Fix direction:** cancellation-specific expectations. Add a distinct successful
scrolling-countdown case if successful scroll behavior needs coverage. Preserve
negative-observation windows rather than loosening assertions to arbitrary alerts.

**Acceptance:** cancelled case has no automatic approval banner/sound; successful
case proves scrolling itself does not cancel and exactly one once-only execution.

### F22. Desktop sound fixture counts attempts, not successful cases

**Priority:** P2 tooling, source-confirmed. **Where:**
`scripts/smoke-notification-desktop.ts:27-46,69-92`;
fallback at `src/notification-audio.ts:154-159`.

One measurement/promise is recorded per player attempt. `--all` demands one attempt
and checks the first exit; `--sounds` demands six measurements. Supported paplay
failure followed by successful pw-play fallback therefore fails a correct case.
Desktop playback was not exercised during this audit.

**Fix direction:** case-level completion/success plus separate attempt diagnostics.

**Acceptance:** mocked fallback boundaries in a pure helper and actual desktop
check where available; all-player failure must not count as successful playback.
Do not claim synthetic process fixtures prove audible output or desktop focus.

### F33. Covered pending permission emits a second initial notification

**Disposition:** dropped from implementation scope by the user after Phase 2.
The historical diagnosis below is retained as evidence, not an active work item.

**Priority:** P2. **Historical status:** reported by the user and reproduced through
the audited Controller, NotificationHost and NotificationPolicy with injected native state and
transport. Pinned native ordering/rendering was separately source-traced. No new
real-TUI or actual desktop playback run is claimed for this finding.

**Where:** `src/notification-policy.ts:59-69,86-101,193-205,219-224`;
`src/notification-order.ts:5-20`; `src/notification-host.ts:132-150,258-283`;
`src/tui.tsx:299-324`; `src/controller.ts:588-612`.

**Reported sequence:**

1. Permission A is pending and emits its attention/Unsafe notification.
2. Before A is automatically or manually approved, a newer permission B covers or
   replaces A in the permission UI.
3. B is approved and removed.
4. A becomes exposed/actionable again and emits another notification, although A
   never resolved and its relevant outcome did not change.

**Impact:** redundant banners/sounds for the same unresolved request, distracting
queue churn, and older pending work disappearing behind newly presented requests.
Related priority/visibility loss can also affect a countdown as traced above, but
do not assume every reported repeat is an approval-cancellation bug.

**Diagnosis: two cooperating mechanisms.**

1. **Host preemption:** OpenCode 1.18.35 sorts the root/direct-child sessions by
   session ID, concatenates their pending permission arrays, and renders only
   `permissions()[0]`. Each session's permissions are request-ID sorted. This is
   session-first priority, not global permission-arrival FIFO. Session IDs are
   normally generated descending, so a newly created child commonly sorts before
   its older root or sibling. A later request B in that child can replace A even
   when B's permission ID sorts after A's. After B resolves, A is selected again.
2. **Plugin episode reset:** losing native blocker ownership makes A's `update()`
   call `wait()`. That stops reminders, withdraws delivery and clears A's message
   and phase to waiting. When A regains ownership, `attention()` sees a new attention
   episode and dispatches another initial title. `seen` deduplicates request birth,
   not already-delivered attention across preemption. No new ask, changed assessment
   or elapsed reminder interval is needed.

Thus the report is explained by a native A -> B -> A selection change plus the
plugin's current re-entry policy. The cause is not simply duplicate host events or
desktop delivery. The existing documented handoff behavior intentionally treats
re-entry as a new episode; the user's desired persistent presentation conflicts
with this sequence and needs a presentation/selection-level resolution.

**Deterministic reproduction:** A is in `ses_900_root`; B arrives afterward in its
direct child `ses_100_newer_child`. A's permission ID is `per_100_A`, B's is
`per_200_B`. Reminder interval is zero. The native-order selector and controller
select B while both remain pending, then A after B resolves.

| Case | Observed actionable notifications | Invariants checked |
| --- | --- | --- |
| Advisory Safe A; B manually resolved | Attention(A), Attention(B), Attention(A) | Exactly two asks, only B replied, A still pending, same A assessment object |
| Unsafe A; Safe B automatically approved | Unsafe(A) twice; B emits its separate approval banner | Exactly one automatic `once()` for B, no reply/re-review of A, no reminder titles |
| A and later B in the same session | Attention(A) once; A remains selected | Normal ascending request IDs do not produce preemption |
| Unchanged blocker with repeated view/frame publications | Attention(A) once | Ordinary publications alone do not cause replay |

The probe backend records both repeated A alerts with `sound: true`. This proves
sound eligibility is repeated, not that physical audio played. B's routine approval
banner can interleave with actionable A delivery; do not infer reply identity from
the native selection at the later time an approval banner is delivered.

A clean final Safe request awaiting automatic rendering, countdown or queue position
is silent by design. If the user's first A alert was for a Safe report with automation
enabled, capture whether A was cancelled, confirmed failed, disabled/unavailable or
otherwise manual. That selects the attention branch; ordinary queued Safe auto work
is not meant to send an initial alert. Purely visual coverage without a native
blocker/outcome transition did not reproduce this mechanism.

**Pinned-host evidence:** host tag `v1.18.35` resolves to
`53d1eabb61e21162157817bf677da0a4ad3332e3`:

- [`packages/tui/src/routes/session/index.tsx:206-241`](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/tui/src/routes/session/index.tsx#L206-L241):
  sorted root/direct-child aggregation. Child routes have no native permission input.
- [`packages/tui/src/context/sync.tsx:181-224`](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/tui/src/context/sync.tsx#L181-L224):
  request-ID insertion and removal on reply.
- [`packages/tui/src/routes/session/index.tsx:1296-1333`](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/tui/src/routes/session/index.tsx#L1296-L1333):
  one `PermissionPrompt` for `permissions()[0]`, no loop over pending prompts.
- `packages/opencode/src/session/session.ts:499-520`,
  `packages/schema/src/session-id.ts:5-12`, and
  `packages/schema/src/identifier.ts:6-29`: descending session generation.
- `packages/opencode/src/permission/index.ts:86-100,109-119,169-172` and
  `packages/schema/src/v1/permission.ts:10-13,61-65`: ascending permission IDs,
  reply events and pending listing. List iteration order is not native input order.

Code-unit ordering is the contract for this host. Generated-ID chronology explains
the common trigger, but arbitrary/supplied IDs and equal-time creation need separate
controls. The user environment's actual root/child arrangement remains unrecorded;
the reproduction establishes a concrete supported route to the same symptom.

**Fix direction requested by the user:** actual pending permission requests and
their available controls should remain in a persistent vertical stack, **oldest at
the top and newest at the bottom**. Preserve per-request identity across arrivals
and resolutions. Do not directly patch notification deduplication or silence A's
return as a substitute.

**Feasibility diagnosis:** the public plugin API in the pinned host supports
plugin-owned report stacks through `app`, `app_bottom` or sidebar slots, but exposes
no native permission-stack mount or active-permission ordering control. Specifically:

- Installed `@opencode-ai/plugin/dist/tui.d.ts:355-386,459-495` inventories slots and
  UI APIs; `api.ui.Prompt` is the ordinary conversation editor, not `PermissionPrompt`.
- At `session/index.tsx:1296-1333`, `session_prompt` and `session_prompt_right` belong
  to that editor and are absent while permissions/questions exist. They cannot wrap
  or replace the native permission branch.
- Pinned `packages/tui/src/plugin/adapters.tsx:41-55,242-255` reserves native
  home/session routes and adapts ordinary Prompt. Public route registration does
  not replace the built-in permission UI.
- Public `permission.reply()` resolves an exact request; it does not control which
  native prompts are mounted or selected.

**Consequently, the requested stack of actual native interactive permission prompts
requires an upstream host change or a new supported permission-presentation hook.**
A reviewer-only stack can improve visual continuity, but will not alone eliminate
the unchanged native A -> B -> A ownership cycle and its notification replay.
Stacking without stabilizing the actionable selection can leave F33 unfixed.

Do not import/patch private native prompt components, recreate native Always/reject
controls, or mutate permission rules. Do not instantiate multiple unchanged
`LiveReviewPanel`s: each currently uses absolute full-height positioning and can
register the shared approval getter. A stack would need stable report owners and a
single native-priority physical approval owner. Chronological display order must
not imply that its top card is the target of native Enter.

**Fixing-agent action:** record the host-support dependency, identify the required
public hook/upstream stacked presentation and stable selection semantics, and verify
compatibility before claiming a plugin-level solution. If host ordering changes,
update the reviewer and notification selectors against the newly verified host
contract together. Do not independently invent arrival-order priority in this
plugin. No notification-only workaround is authorized by this report.

**Acceptance / regression plan:**

- Port the four reproduced cases into regression coverage with desired post-fix
  behavior; retain `staleReminderSeconds: 0` for initial-replay isolation. Test B
  manual native Allow once and real automatic approval separately in the pinned
  TUI when the supported stack exists.
- Test root/newer child, older/later-created siblings, same-session controls,
  silent/disabled requests, failed/cancelled Safe A, Unsafe A and countdowns.
- With stacking implemented, adding B leaves A visibly represented above B;
  resolving B leaves A's stable panel/control owner in place. A gets no additional
  initial banner/sound solely because B was added or removed.
- Confirm that stacking changes the causal native/policy transition rather than
  merely hiding the extra notification. Keep legitimate first alerts, reminders,
  and genuine assessment-kind transitions covered by independent controls.
- Exercise overflow/scrolling, narrow/short terminals, history and native dialogs.
  No hidden/covered/non-first request may approve just because its card exists in
  the stack. Capture actual native presentation in the pinned real TUI.

**Existing test gap:** `test/notification-order.test.ts:5-24` covers static ordering;
`test/notification-policy.test.ts:300-320,405-459` covers new-owner handoff and
pre-dispatch withdrawal, not already-delivered A preempted by later B then restored.
`test/notification-host.test.ts:231-255` even describes returning question attention
as a new episode. `test/notification-controller.test.ts:27-73` uses child IDs that
preserve A-first order. `scripts/smoke-notification-queue.mjs:65-73,143-191` waits
for overlapping reports and tests sequential handoff; it does not introduce B
after A's initial notification. Green existing tests therefore do not cover this
reported cycle.

**Verification:** four temporary reproduction/control tests passed, and 98 existing
notification order/policy/host/controller tests passed. Sources and logs:
`/tmp/opencode/f33-notification-replay-audit.test.mts`,
`/tmp/opencode/f33-notification-replay-audit.log`, and
`/tmp/opencode/f33-existing-notification-tests.log`. These are machine-local audit
probes, not tracked implementation tests or a claim of native pixel/audio proof.

**Additional host observation to verify:** the single native prompt is not keyed by
request ID. `permission.tsx:383` snapshots `info()` for some displayed content,
while `426-430` reads the current request ID when replying. Compare displayed
command/session and actual reply identity during preemption; stale native content
is a source-supported concern, not a newly confirmed wrong-approval finding here.

### F34. Root-only side panel with continuing hidden normal countdowns

**Priority:** P2. **Status:** explicit user-requested behavior change. Current
presentation and hidden-cancellation behavior are source-confirmed and covered by
passing focused tests. Relevant prior fixes were inspected in local Git history;
no general hide-with-continuing-normal-approval fix was established.

**Where:** `src/tui.tsx:289-324`; `src/live-review-panel.tsx:202-224,246-258`;
`src/controller.ts:165-200,263-289,306-425,588-612`;
`test/approval.test.ts:379-409`; `scripts/smoke-skills.mjs:135-178`;
`README.md:134-136,155-164,186-192`; the presentation invariants in `AGENTS.md`.

**Requested behavior:** when the reviewer side panel is open in a top-level
conversation and the user navigates into that conversation's subagents, the panel
should disappear. It should be shown only on the top-level conversation route.
That intentional UI suppression must not freeze, reset or cancel normal review
countdowns or prevent their automatic approval. Returning to the root should show
the current remaining time/report if still pending, not start a new delay.

**Current diagnosis:**

1. At widths >=120, `presentationSession()` deliberately returns a child session
   even without a native sidebar. `visibleReview()` maps direct-child routes back
   to the root queue. The app therefore renders the same right-hand review panel
   on a wide subagent route, contrary to the requested root-only display.
2. Panel lifetime owns the presentation getter and FRAME publications. Cleanup
   releases that getter and calls `onPresented()` with no request ID. The controller
   treats this as visibility loss and writes a durable cancellation tombstone.
3. Every countdown wake and approval read/write boundary also calls `eligible()`,
   requiring stored and fresh physical presentation IDs. Merely deleting the child
   fallback, hiding the box, or avoiding one cleanup callback is insufficient:
   the next eligibility check can still permanently cancel instead of approving.
4. An initially hidden completed report cannot start its normal countdown without
   matching presentation. This is different from a running timer freezing: current
   behavior is either never-started automation or permanent cancellation after
   presentation loss, not a reversible pause with the old deadline preserved.

**Impact:** the user cannot browse subagents with a clean root-only layout while
normal automatic reviews proceed. A cosmetic visibility change alone would regress
automation and can turn an otherwise Safe request into manual attention.

**Check of the remembered previous fix:**

- Commit `c8cb4b3849415cb235abcaeb1f4548702cafd9e6`, **preserve safe review
  countdowns behind report history**, added `HistoryCover` and a stable live/history
  slot root. That is the existing normal-mode history-cover exception. It did not
  permit generic hidden or descendant-route countdowns.
- Commit `2434045cfc1baaa897090f54a864a491c082795a`, **v1.0.1 notification and
  subagent approval fixes**, added the wide child-route fallback and root queue
  mapping. It enabled approval while browsing a child by rendering the panel there,
  not by allowing approval with the panel absent. The current README describes
  precisely that visible-child behavior.
- Already-dispatched fast-mode reviews also continue after hiding/navigation, as
  tested at `test/fast-mode.test.ts:135-147`. This finishes an approval/report that
  has already been dispatched; it is not a hidden normal-countdown fix.
- Focused current tests explicitly confirm that a hidden countdown becomes
  `cancelled`, remains cancelled after redisplay, and performs zero verification
  reads/writes. Both notified and freshly recomputed loss paths passed. The related
  fixes are present, but the requested general behavior is not.

**Fix direction:** separate root-only visual presentation from conversation-scoped
normal automation. Model an intentional same-root subagent-route suppression reason
distinct from user cancellation, uncertain ancestry/native ordering, a genuinely
lost actionable request, or ordinary stale paint. Keep evaluation, countdown state,
monotonic deadline, and approval ownership outside the disposable visual panel.
Resolve the route's root and pending queue independently of whether a sidebar/card
is mounted. Preserve the original deadline while changing routes; do not re-review
or restart the countdown on return.

Specify readiness for a validated Safe report that completes while the user is
already on a subagent route: it must not wait indefinitely for a root-only panel
to paint solely because that panel is intentionally hidden. Introduce the explicit
normal-mode hidden-automation contract rather than synthesizing visible IDs, fake
FRAME events, hit-test results or a production-history cover. This change is feasible
within plugin-owned presentation/controller logic and does not depend on the native
permission-stacking hook required by F33.

**Scope and contract reconciliation:** this request establishes continued normal
automation during navigation within the same root conversation, including hiding
the panel on descendant routes. Do not silently extend it to unrelated conversations,
native dialogs/fullscreen covers, explicit sidebar hiding, disabled mode, unknown
ancestry or all hidden fast-mode previews. Record the treatment of those distinct
conditions in the updated specification and negative controls. Fast mode has no
countdown; existing pre-dispatch fast physical-visibility rules and retained-report
semantics remain separate unless explicitly changed by a subsequent requirement.

Update the conflicting `AGENTS.md`/README presentation contract and relevant tests
as part of a future implementation, before describing root-only hiding as an existing
exception. F14/F15 fixes must follow that explicit contract; genuine loss outside
the F34 exception must not be confused with intentional route suppression.

**Acceptance / regression plan:**

- Start a positive normal countdown at the root, navigate into a direct child,
  remain there past the original deadline: panel absent, countdown not restarted,
  exactly one automatic `once()` and no attention caused solely by hiding.
- Return before expiry: root panel shows elapsed remaining time. Repeated
  root/child and sibling navigation must not remount/re-evaluate the request,
  reset the deadline, add another grace period or create a manual tombstone.
- Complete a normal review while on a child route: validated Safe work starts its
  defined countdown and approves without requiring return to root. Check both
  streaming and nonstreaming, positive and zero delay.
- No reviewer side panel on direct or nested subagent routes at any terminal width.
  Continue same-root work while a nested route is selected without inventing native
  approval ownership for deep-only requests that the host does not present at root.
- Keep exact pending identity/scope, Safe validation, native-first queue ordering,
  disabled/silent blockers, mode gates, one-shot writes and actual read ownership.
  Earlier native blockers must still prevent dispatch until legitimately actionable.
- Explicit Cancel, deletion/disposal, same-ID argument changes and uncertain
  dispatched acknowledgement still prevent unsafe rearm or duplicate writes.
  Unrelated-root navigation, unknown ancestry and other covering conditions have
  documented negative controls under the reconciled policy.
- History/notification clicks and retained fast reports must respect root-only
  display. Returning after completion must not resurrect a live report/countdown;
  saved history stays scoped and notifications retain exact identities.
- Replace the current `smoke-skills.mjs` subagent-view expectation of a physically
  painted child panel with a registered real-TUI case that proves root-only display
  and continuing hidden normal automation. Preserve independent fast-mode controls.

**Verification performed:**

```sh
node --import tsx --test --test-name-pattern='hidden countdown cancels|display follows root/direct-child|fast approval survives hidden UI' test/approval.test.ts test/controller.test.ts test/fast-mode.test.ts
```

Four focused tests passed. Log:
`/tmp/opencode/f34-hidden-panel-contract-tests.log`. Git diffs for the two named
historical commits were inspected. No new native-host run or implementation change
was made for this entry; the tests prove the current contract, not compliance with
the user's newly requested behavior.

### F23. Private pathname checks do not anchor SQLite open

**Priority:** P3 conditional security. **Where:**
`src/history-storage-worker.ts:12-26,40-53`.

Checked descriptors close before SQLite opens the pathname. Under a non-sticky
group/world-writable ancestor, another process can replace the tree. A controlled
database-constructor swap redirected a report to replacement storage mode 0644.
Normal protected home ancestry limits this; cross-user/Bun exploit not exercised.

**Fix direction:** trusted non-replaceable ancestor chain or descriptor-anchored
strategy protecting SQLite sidecars. Repeating a pathname check does not close race.

**Acceptance:** controlled ancestor swap at open, ordinary private state directory,
symlink/hardlink/public-mode/wrong-owner and sidecar controls. No chmod of another
owner's files or writes into replacement storage.

### F24. Nested deadline can be constructed beyond parent end

**Priority:** P3. **Where:** `src/deadline.ts:23-32,35-42`.

Child end equals a later clock reading plus earlier remaining duration. A pause
between readings extends it beyond parent absolute end and can admit work before
the parent timer is delivered. Controlled clock: parent end 20, later time 100,
child starts reporting 20 ms remaining; outer call eventually rejects. The
"never extend" comment is not strictly true; large real pauses are rare.

**Fix direction:** minimum of parent's stored absolute end and requested child end;
reject elapsed deadlines before invoking work.

**Acceptance:** controlled-clock nested construction, zero/expired parent and
ordinary shortening; no operation starts beyond parent end or survives parent abort.

### F25. Closed history keeps its private selected payload reachable

**Priority:** P3. **Where:** `src/history-controller.ts:117-134`.

`close()` updates only `open:false`; selection still includes report text after
close, root deletion and disposal. No UI resurrection was demonstrated.

**Fix direction:** clear report-bearing terminal state, retaining scroll/selection
only for intentional temporary loading/error recovery.

**Acceptance:** close/delete/dispose release selection and pending targets; loading
recovery and navigation retain correct intended scroll behavior.

### F26. Retry fake-clock assertions do not control production backoff

**Priority:** P3 tests. **Where:** `test/transport-retry.test.ts:16-30`;
`src/transport-retry.ts:1,62`.

Production captured a named timers/promises sleep before mocks were enabled. On
Node 24.21.0, ticking 10,000 virtual ms did not settle it; real wait was about
251 ms with jitter zero. The test awaits the real timer and its early-boundary
assertions give misleading confidence. No production backoff defect was shown.

**Fix direction:** genuinely controllable sleep/clock or explicit bounded real-time
verification. Keep useful retry-budget/error-redaction assertions.

**Acceptance:** a deliberately shortened test backoff fails the regression;
virtual boundaries really determine settlement. Check both supported Node floors.

### F27. Runner timeout test can fail before fixture readiness

**Priority:** P3 tests. **Where:** `test/runtime-runner.test.mjs:21-38`.

The timeout starts at spawn and grants only 400 ms for two-process startup, while
readiness polling permits three seconds. Loaded CI can correctly time out then fail
the PID assertion, unrelated to isolation/cleanup. Failure frequency unmeasured.

**Fix direction:** controllable deadline after readiness handshake, or consistent
startup and timeout budgets. Do not drop survivor/owned-process assertions.

**Acceptance:** delayed startup control proves cleanup semantics without a false
readiness failure; abort and timeout remain distinct.

### F28. History lifecycle wrapper hardcodes `/tmp`

**Priority:** P3 portability. **Where:** `scripts/smoke-history-lifecycle.mjs:14-20`;
producer `scripts/smoke.mjs:106,669`.

Producer uses `os.tmpdir()`; extraction accepts only `/tmp/opencode-reviewer-*`.
Valid `TMPDIR=/var/tmp` makes successful underlying execution fail verification.

**Fix direction:** structured observation, or parse complete absolute path value
without hardcoded temporary prefix or whitespace truncation.

**Acceptance:** alternate temp directory and spaces, normal temp and explicit
existing-state argument. Keep isolated-state identity checks.

### F29. Small internal interface and unreachable-code cleanup

**Priority:** P3. **Where / verified consumers:**

- `nativeTools`, `src/classification.ts:8`: same-file consumers at `33,36` only.
- `findUserPrompt`, `src/context.ts:68`: same-file consumers at `57,80` only.
- `reportedModel`, `src/usage.ts:14`: same-file consumer at `81` only.
- Unused `id`, `src/session-mode.ts:205`: method remains used; whole-cache
  invalidation is intentional. Adjust the binding/interface without changing it.
- Unused mock `q`, `test/history-maintenance.test.ts:170`.
- `scripts/smoke-notification-desktop.ts:112`: final usage-error branch unreachable
  after `runtimeArguments` enforces exactly one accepted mode.

**Fix direction:** remove unused export modifiers/bindings/redundant fallback, not
the required implementations. No confidently dead source module was identified.

**Acceptance:** symbol/reference and generated-wrapper consumer review; normal
typecheck plus optional noUnused checks. Preserve explicitly used embedding seams.

### F30. Historical notification audit status is misleading

**Priority:** P3 docs. **Where:** `NOTIFICATION-AUDIT.md:15,21-28`.

The older audit says all its findings are open. Current source has corrected its
deferred-write guard and several recovery/notification ownership defects. New F12
is a distinct pre-dispatch error/budget variant; stale-read exhaustion itself now
recovers. Do not use the historical list as current fixing instructions.

**Fix direction:** archival-status pointer to this current handoff and explicit
historical provenance; preserve original observations without claiming these new
findings are implemented. Update status/disposition only with verified fixes.

**Acceptance:** every current issue has one stable disposition in this document;
old NA claims are neither silently reopened nor deleted as useless text.

### F31. Syntax-style retirement depends on global renderer idle

**Priority:** P3, validation-first performance concern. **Where:**
`src/review-description.tsx:8-10`.

Each retired SyntaxStyle is retained until `renderer.idle()`, which waits for global
scheduler inactivity, not simply a completed owner frame. Repeated teardown/theme
changes during continuous rendering may accumulate styles/promises until idle.
No real-TUI allocation growth or permanent leak was measured.

**Next step:** measure retirement across repeated teardown while renderer stays
live. If material, retire after owning renderable/highlighting settlement rather
than global idle. Do not destroy a style still referenced by asynchronous work.

**Acceptance:** evidence of prompt safe resource release and no use-after-destroy;
close as non-actionable with measurements if existing lifetime is acceptable.

### F32. Mouse-disabled hosts lack the hit grid needed for approval

**Priority:** P2, validation-first compatibility. **Where:**
`src/live-review-panel.tsx:173-175,202-224` and installed OpenTUI 0.4.5 hit-grid
population/hitTest paths. Pinned host `packages/tui/src/app.tsx` initializes mouse
from configuration and `OPENCODE_DISABLE_MOUSE`.

OpenTUI skips hit-grid population with `useMouse=false`, but the plugin requires
hit ownership in normal and fast mode. This source-supported incompatibility
normally prevents countdown startup; it does not prove already-started spontaneous
cancellation. Runtime mouse changes and exact host behavior are untested.

**Next step:** pinned-host fixture with mouse disabled before launch, normal and
fast modes, physically visible report and covering-dialog/fullscreen controls.
Determine whether a supported public physical-presentation proof can work without
mouse tracking. Do not bypass occlusion checks based on logical visibility.

**Acceptance:** either a validated compatible proof with all negative controls, or
a documented, evidence-based disposition. No unverified readiness override.

## Structural work: patterns rather than isolated nits

1. **Shared literal parsing boundary (F01-F04).** Shell state handling and skill regex
   have unequal semantics. Centralize only the supported bounded literal rules;
   use differential probes in tests, never shell evaluation in production.
2. **Bound work separately from memory and ownership (F06-F10).** Specify maximum
   rows/work per transaction, total admitted evaluators and publication cost. Paging
   arrays, LIMIT 1, and bounded actual I/O slots are insufficient proofs by themselves.
3. **Explicit approval state reasons (F11-F15).** `View`/`Entry` at
   `src/controller.ts:17-42` allow many optional combinations. Model provisional
   safety, physical proof, recoverable read reservation, dispatched uncertainty and
   durable human/visibility cancellation as distinct transitions. Refactor
   incrementally with transition tests, not a wholesale state-machine rewrite.
   F34 adds an intentional same-root route-suppression reason: distinguish visual
   mount lifetime from continuing normal automation instead of faking visibility.
4. **Separate storage responsibilities.** `HistorySQL` combines initialization,
   legacy bootstrap, contribution accounting, deletion, attribution, corruption
   validation and browsing. Extract bounded migration/browsing responsibilities
   while retaining transactional replay and exact ownership validation.
5. **Test cross-feature sequences.** The suite is substantial and useful. Its gaps
   are interaction orderings and scale, not a lack of simple happy-path tests.
   Prefer the cases in acceptance criteria over implementation-mirroring assertions.
6. **Comments must name the actual guarantee.** Fix token claims (F03), deadline
   inheritance (F24), early-wrapper cleanup (F19), and accounting description (F16)
   alongside behavior. Do not describe bounded allocation as bounded execution.

## Dependency, dead-code and release assessment

- `npm audit --json`: **zero known vulnerabilities** at review time. This is not a
  proof of semantic safety; F01 concerns a vulnerable use of otherwise unflagged
  `shell-quote` behavior.
- No removal candidate among the 14 direct development dependencies. Build tools,
  decoder, tokenizer, types and test tools have consumers. `@opentui/keymap` is
  consumed through the pinned plugin API/peer relationship.
- Some latest versions are newer: Babel, TypeScript, Solid and OpenTUI. Version lag
  alone is not a defect. Keep OpenTUI/plugin updates tied to verified host
  compatibility; do not indiscriminately upgrade during unrelated fixes.
- All nine prompt/contract Markdown files are inventoried and consumed. Preserve
  fixed contracts and `{{validationError}}`.
- Generated-wrapper consumers exist for all six `with*` exports and the worker
  probes/store/refresh exports. Static import-only searches can misclassify them.
  Preserve these intentional fixture/embedding seams, not config options.
- Historical usage replay and history aliases have registered current consumers.
  No whole production module was confidently established as dead.
- Release separation, immutable artifact IDs, exact five-file archive inspection,
  canonical SemVer, pinned actions, private npm cache, provenance binding and
  no-upload-retry behavior passed review and actual offline npm CLI checks. No new
  high/medium publication defect was confirmed. Keep this area stable.

## Fixing order and work packages

Use separate small changes with issue IDs and exact verification in their summaries.
The ordering is by risk and dependencies, not an instruction to combine all work
into one large patch. Resolve validation-first items with evidence before coding.

| Order | Work package | Issues | Dependencies / completion gate |
| --- | --- | --- | --- |
| 1 | Evidence identity and supported syntax | F01-F04 | Reproduce wrong-file cases; differential controls; evidence/skill real-host cases |
| 2 | Pre-dispatch approval recovery | F12-F13 | Separate temporary ineligibility from durable tombstones; all no-input controls |
| 3 | Root-only presentation and continuing hidden normal automation | F34 | Reconcile the requested normal-mode contract; decouple same-root route suppression from timers/approval |
| 4 | Painted proof and observer handoff | F14-F15; validate F32 | Follow the reconciled presentation contract; F33 dropped from scope |
| 5 | Persistence progress and refresh availability | F06-F09 | Migration/replay and dirty-generation design before optimizing read queries |
| 6 | Storage privacy and payload release | F05,F23,F25 | Node/Bun deletion/open verification; preserve aggregates and tombstones |
| 7 | Review admission and mode idempotency | F10-F11 | Queue fairness and unchanged-mode controls; no new model calls from commands |
| 8 | Transport accounting and absolute time | F16,F24,F26 | Fix controllable timing tests; preserve terminal/retry/deadline contracts |
| 9 | Notification baseline and completed-turn recovery | F17-F18 | Queue/no-replay and idle/cancellation negative controls |
| 10 | Fixture reliability and supervisor cleanup | F19-F22,F27-F28 | Fix assertions before claiming matrix coverage; owned-process isolation |
| 11 | Measured resource cleanup and documentation | F29-F31 | Validate resource effect; close/archive findings with proof, not assumptions |

F20-F22 can be fixed earlier independently to restore useful verification. Do not
change production notification behavior to make those obsolete expectations pass.

F33 is no longer an implementation requirement. Its historical requested
presentation-first approach had the following dependency: the pinned public
surface does not expose a native permission stack; establish supported upstream
presentation/selection changes before implementing it. A notification-only replay
or deduplication change is not the requested fix and must not be substituted without
further direction. A report-only stack does not close this finding by itself.

### Cross-cutting implementation constraints

- No `always`/reject, permission-rule writes, tool execution or edit application.
- Only identical fresh pending permission, correct invocation host scope, physical
  visibility/native priority and current valid Safe state can reach `once()` under
  the current contract. F34 proposes a specified normal-mode same-root route-hidden
  exception to physical presentation, not to identity, native priority or Safe checks.
- Never retry an invoked approval write, including synchronous throw or late native
  resolution. Recoverable pre-dispatch reads are a separate state.
- Genuine Cancel/visibility loss after countdown start remains durable through
  remount/re-enable. Scrolling must not cancel; history is the sole normal-mode
  physical-cover exception in current code. Future F34 intentional descendant-route
  hiding must be classified separately and keep normal countdowns running; other
  visibility-loss and fast-mode rules require the explicitly reconciled contract.
- Keep one budget across evidence/HTTP/corrections, exact correction history,
  identical transport retries and output limit. Fixes must not add model notices
  or automation metadata, extend review deadline, or increase token limits.
- Retain actual I/O/read/process ownership through settlement. Don't fix stalls
  by pretending timeout ended a physical transaction.
- History/detail deletion never subtracts accumulated totals; lifetime is not
  reconstructed from details; root-first deletion and exact 404 proof stay intact.
- Observer/accounting/storage failures remain off review/approval critical paths.
- For F33, preserve older pending requests in the requested vertical presentation
  if the public host surface supports it; keep native priority and physical
  eligibility independent of whether a request is represented in that stack.
- Use public host APIs/slots. No private native approval/dialog patches. Fixed UI
  text belongs in `src/ui-text.ts`. Never use em dashes.

## Verification plan for the fixing agent

### Per-change checks

1. Add meaningful regression for each confirmed bug, asserting the corrected
   behavior and the relevant negative controls. Audit scripts are failure probes,
   not already-correct acceptance tests.
2. Run focused source/helper tests. Inspect the exact touched fixtures and valid
   flags; do not claim all combinations from an inventory listing.
3. Run `npm run check` after a coherent production change.
4. For runtime/UI/host integration: build first, then use the serial runtime runner
   for relevant real-TUI cases. Register new cases/flags in runtime inventory.
   Limit concurrent hosts to two and do not run another host alongside the runner.
5. Keep helper inventory and active release-policy sparse-checkout closure complete
   when adding pure `.mjs` checks/transitive files.

### Approval-specific regression matrix

- Normal/fast, streaming/nonstreaming, positive/zero delay.
- Initial verification 503, timeout then late settlement, old read-slot ownership,
  unrelated revision event during read, three stale reads then healthy recovery.
- Safe preview rejected while GET is held; GET before/after replacement Safe;
  final Unsafe, corrected/truncated stream, format failure and terminal failure.
- No human key/mouse/command after countdown or preview begins in the no-input
  success cases. Fixture-owned event/transport/resize control is allowed.
- Fixed-size long Markdown/fenced code and multiple history refreshes; history
  loading/error/recovery; scroll/new highlighting without losing countdown.
- Benign same-branch viewport enlargement between proof and next frame; explicit
  sidebar wide/overlay replacement; real hidden/narrow/short/fullscreen/dialog
  controls; new earlier native blocker and later removal.
- Pending same-ID argument/scope change, mode disable/re-enable, deleted session,
  disposal, native reply before HTTP acknowledgement, uncertain acknowledgement.
- F33: already-notified A, newer covering B, B automatic/manual approval, A return;
  reminders disabled for replay isolation; stable oldest-top/newest-bottom native
  presentation if supported, including root/direct-child and overflow controls.
- F34: root countdown -> same-root child/nested navigation with panel absent ->
  approval at original deadline; return-before-expiry and review-completes-hidden
  controls. No freeze, re-review, deadline reset, grace restart or manual tombstone.
- Exactly zero writes while unproven/Unsafe/covered; exactly one when recovered and
  eligible under the reconciled contract, including F34's explicit normal-mode
  route-hidden exception; no retries after invocation or premature attention alerts.

### Presentation investigation instrumentation

Existing opt-in `withHistoryObservations`/render probes are appropriate synthetic
fixture seams, not config options or readiness overrides. Capture decisions before
`onPresented` can synchronously publish and clean up:

- Monotonic time/frame ID and trigger: FRAME, timer, post-list, pre-dispatch, cleanup.
- Fixed verdict reasons: route/sidebar/dialog, native selection, geometry fit,
  pending painted proof, assessment identity, initial highlight, hit/cover ownership.
- Numeric renderer/region bounds and numeric renderable/hit identities; sidebar
  and live-owner mount/cleanup counts.
- Original deadline, automatic state, and whether synthetic target remains pending
  and first. Do not add real prompts, credentials, paths, IDs or model output to
  production diagnostics; fixture synthetic observations remain isolated.

Current booleans alone cannot show which earlier guard caused a cancelled state.
Do not attribute fixed-size spontaneous cancellation to highlighting/history
polling without capturing that exact causal transition.

### Relevant existing host cases (build first)

```sh
node scripts/test-runtime.mjs --profile ci
node scripts/test-runtime.mjs smoke-evidence.mjs capture
node scripts/test-runtime.mjs smoke-skills.mjs root
node scripts/test-runtime.mjs smoke-skills.mjs subagent
node scripts/test-runtime.mjs smoke-fast-mode.mjs complete
node scripts/test-runtime.mjs smoke-fast-mode.mjs retry
node scripts/test-runtime.mjs smoke-approval-geometry.mjs resize
node scripts/test-runtime.mjs smoke-history-auto.mjs covered
node scripts/test-runtime.mjs smoke-history-auto.mjs dialog
node scripts/test-runtime.mjs smoke-history-auto.mjs notification
node scripts/test-runtime.mjs smoke-history-maintenance.mjs
node scripts/test-runtime.mjs smoke-statistics.mjs
node scripts/test-runtime.mjs smoke-session-mode.mjs
node scripts/test-runtime.mjs smoke-streaming.mjs truncated --static --stats
```

These cases are supporting controls. Existing fast retry primarily covers
already-dispatched retained work; it does not replace the new pre-dispatch F13
ordering case. Existing default-auto narrow tests do not cover F15 explicit-open
sidebar handoff. Add registered deterministic cases where acceptance requires them.

After fixture repairs, rerun the exact previously failing combinations:

```sh
node scripts/test-runtime.mjs smoke-permissions.mjs mcp --auto --notifications
node scripts/test-runtime.mjs smoke.mjs auto-scroll --notifications
```

For release-related helper/build changes, also run the package and offline CLI
checks below. None publishes or requests real signing/OIDC/log writes.

## Evidence collected in this review

### Main verification results

| Check | Result |
| --- | --- |
| `npm run check` | Typecheck, **983 source tests**, **111 helper tests**, build passed |
| `npm run check:package` | Two deterministic builds and exact five-file archive passed |
| `node --test test/release-artifact-smoke.test.mjs test/npm-cli-smoke.test.mjs` | **9 passed**, offline boundaries |
| `node scripts/test-runtime.mjs --profile ci` | All **7** exact profile cases passed |
| `node scripts/test-runtime.mjs smoke-statistics.mjs` | Passed both scopes, Tab/click, ancestry, restart and recovery |
| `npm run test:runtime-cleanup` | **6 passed**, isolated supervisor/cleanup cases |
| `npm audit --json` | Zero reported known vulnerabilities |
| `npx --no-install tsc --noEmit --noUnusedLocals --noUnusedParameters` | Only two unused bindings listed in F29 |
| Additional permission notification fixture | Failed F20 assertion at line 384 |
| Additional scroll notification fixture | Proved cancellation, then failed F21 expectation |
| No-input approval audit | **16 pure reproductions/controls passed**, including real SSE retry |
| Presentation cancellation audit | Two pure helper/lifecycle reproductions confirmed |
| F33 preemption/re-entry audit | **4 pure reproductions/controls passed**; exact host source and public API traced |
| F33 existing notification suites | **98 passed**; missing already-delivered A -> later B -> A-return cycle identified |
| F34 current/historical hidden-panel contract | **4 focused tests passed**; history-cover and visible-child prior fixes inspected; requested root-only hidden automation not implemented |

Subagents additionally ran focused suites and local scale/ownership probes; many
overlap the complete source run, so their counts are not summed as unique coverage.
No actual desktop audio/focus, live-model unsafe approval, newer-host compatibility
or complete runtime flag matrix is claimed.

### Local evidence locations

Logs are temporary machine-local aids, not requirements for reproducing the findings:

- `/tmp/opencode/codebase-review-check.log`
- `/tmp/opencode/codebase-review-package.log`
- `/tmp/opencode/codebase-review-release-smoke.log`
- `/tmp/opencode/codebase-review-runtime-ci.log`
- `/tmp/opencode/codebase-review-statistics.log`
- `/tmp/opencode/codebase-review-runtime-cleanup.log`
- `/tmp/opencode/codebase-review-permission-notifications.log`
- `/tmp/opencode/codebase-review-scroll-notifications.log`
- `/tmp/opencode/codebase-review-evidence-repros.log`
- `/tmp/opencode/codebase-review-no-input-approval.log`
- `/tmp/opencode/codebase-review-presentation-cancellation.log`
- `/tmp/opencode/f33-notification-replay-audit.log`
- `/tmp/opencode/f33-existing-notification-tests.log`
- `/tmp/opencode/f34-hidden-panel-contract-tests.log`

Temporary reproduction sources:

```sh
npx --no-install tsx /tmp/opencode/reviewer-audit-current-20261010.mts
node --import tsx --test /tmp/opencode/approval-no-input-audit-20261010.test.mts
node --import tsx /tmp/opencode/auto-cancel-pure-audit.mts
node --import tsx --test /tmp/opencode/f33-notification-replay-audit.test.mts
```

These use absolute local imports and may need reconstruction on another machine.
The trigger/acceptance descriptions above are authoritative. Large temporary
databases were removed after the scale/privacy probes.

Exact runtime result directories from the main audit:

- `.runtime/runtime-run-gcleRr/results.json`: seven CI-profile passes.
- `.runtime/runtime-run-ISpnxi/results.json`: F20 permission notification failure.
- `.runtime/runtime-run-vcVlZ4/results.json`: F21 scroll notification failure.
- `.runtime/runtime-run-mQ5Xlx/results.json`: statistics pass.

## Fix completion and disposition procedure

### Implementation checklist (2026-10-10)

The implementation request authorizes incremental commits. The historical audit
results above are not post-fix verification. Checkboxes below require new evidence.

- [x] Read the full plan and referenced implementation, tests and fixture contracts.
- [x] Derive work packages and identify public-host and presentation-contract gates.
- [x] Phase 1: evidence identity and supported syntax (F01-F04).
  - [x] Reject or faithfully decode ANSI-C byte operands; test Bash byte identity.
  - [x] Handle negation without preserving falsely known cwd; test state changes.
  - [x] Parse whole literal skill-command operands, including concatenated quotes.
  - [x] Preserve declared/physical launch ambiguity after cd; test PWD controls.
  - [x] Run focused regressions, source checks and pinned evidence/skill host cases.
  - [x] Record exact results and commit the verified phase (`5e2584f`).
- [x] Phase 2: pre-dispatch approval recovery (F12-F13).
  - [x] Separate recoverable verification failures from invoked-write uncertainty.
  - [x] Separate rejected Safe previews from actual presentation/priority loss.
  - [x] Verify all four no-input recovery triggers and both replacement-Safe orders.
  - [x] Preserve Cancel, real hide, changed identity and single-shot write controls.
  - [x] Run source/host verification, record results and commit (`ac5505c`).
- Phase 3: root-only presentation (F34), **deferred by user direction**.
  - [ ] Reconcile hidden-normal-approval request with governing physical-visibility contract.
  - [ ] Define descendant route readiness, original deadline and negative controls.
  - [ ] Implement only after that contract gate is resolved; verify source and real TUI.
- [x] Phase 4: painted proof and host presentation (F14-F15,F32).
  - [x] Separate pending renewed paint from proven physical loss.
  - [x] Preserve a stable live owner across same-session sidebar handoff.
  - [x] Validate mouse-disabled readiness and real coverage controls.
  - F33 cancelled by user direction; native stacking is out of scope.
  - [x] Verify exact resize/handoff/preemption cases and commit supported changes (`b4da5a4`).
- [x] Phase 5: persistence progress (F06-F09).
  - [x] Design resumable bounded legacy baseline transactions and replay ownership.
  - [x] Batch dirty recovery with complete healthy-pass and deletion commit fences.
  - [x] Separate refresh invalidation from coalesced freshness requests.
  - [x] Bound steady-state browsing work while retaining selected-row repair checks.
  - [x] Verify slow/large/shared-worker cases and relevant host fixtures; commit (`7fe0a6b`).
- [x] Phase 6: storage privacy (F05,F23,F25).
  - [x] Define secure deletion and owned cleanup on both SQLite adapters for current-policy deletion.
  - [x] Resolve complete erasure of pre-policy fragments in still-live SQLite pages (automatic bounded rebuild).
  - [x] Protect pathname opening and sidecars against replaceable ancestors.
  - [x] Release report-bearing close/delete/dispose state.
  - [x] Verify active-file markers, ownership controls, aggregate retention and host behavior; commit.
- [x] Phase 7: review admission and mode idempotency (F10-F11).
  - [x] Bound evaluator admission with native-front priority and cancellation-aware fairness.
  - [x] Make unchanged Enable non-destructive, including persistence retry.
  - [x] Verify fanout, handoff, mode commands and relevant host cases; commit.
- [x] Phase 8: transport and time (F16,F24,F26).
  - [x] Drain valid terminal-rejection usage without retrying rejected assessments.
  - [x] Inherit absolute deadline ends and control actual backoff sleep in tests.
  - [x] Verify framing/abort/resource limits and both supported Node floors; commit.
- [ ] Phase 9: notification reconciliation (F17-F18).
  - [ ] Require authoritative permission ordering before fresh attention.
  - [ ] Recheck completed turns after healthy blocker removal.
  - [ ] Verify no replay, cancellation and idle controls plus host cases; commit.
- [ ] Phase 10: fixtures and cleanup (F19-F22,F27-F28).
  - [ ] Clean owned descendants on wrapper exit while retaining pipe ownership.
  - [ ] Repair silent/sound-enabled and cancelled/successful scroll assertions.
  - [ ] Measure desktop playback success per case, retaining attempt diagnostics.
  - [ ] Make startup budgets consistent and lifecycle paths portable.
  - [ ] Verify helpers, exact failed runtime combinations and available desktop checks; commit.
- [ ] Phase 11: measured cleanup and documentation (F29-F31).
  - [ ] Remove only verified unused interfaces/bindings.
  - [ ] Archive historical notification findings with verified current dispositions.
  - [ ] Measure syntax-style retirement before deciding whether a change is needed.
  - [ ] Record remaining limits, final verification and commits.

For every implemented or investigated finding, append a concise disposition here:

1. ID and actual status: fixed, validated non-actionable, deferred with reason, or open.
2. Changed files and the behavioral guarantee, not just a refactor description.
3. Regression cases, exact commands/results and real-host proof when required.
4. Remaining conditions/coverage limits. Do not convert source-supported concerns
   into confirmed defects or imply full-matrix verification.

Do not mark a finding complete on intent, a green failure-reproduction script, or
the broad suite alone. Preserve the severity-ordered inventory and historical
provenance. Keep README user-focused and update its behavioral claims only where
the implemented behavior changes. Do not commit or publish without a separate
explicit request.

### Phase 1 disposition: F01-F04 fixed (2026-10-10)

- `src/shell-discovery.ts` rejects ANSI-C quoting before tokenizer byte conversion
  and conservatively omits negated statements while invalidating subsequent cwd.
  Declared/canonical launch identity now controls post-cd inference, including nested
  shells. `src/context.ts` records the logical-PWD limitation; `src/evidence.ts`
  supplies the existing context probe or a bounded standalone probe. Direct source
  operands still traverse the declared filesystem path.
- `src/skill-evidence.ts` parses complete literal command operands with adjacent
  quoted segments and escaped quotes. Unsupported syntax omits the entire command.
  Catalog instructions and skill-directory confinement remain intact.
- `test/shell-evidence.test.ts` differentially checks harmless Bash hex/octal and
  invalid-UTF-8 operands, negated state changes, matching/mismatching inherited PWD,
  full evaluator decoys and unchanged exact commands. `test/file-access.test.ts`
  checks launch-probe timeout/abort ownership. `test/skill-evidence.test.ts` checks
  whole target identity, unsupported constructs, budgets, cancellation and confinement.
- Focused checks: `npx tsx --test test/shell-evidence.test.ts test/evidence.test.ts
  test/context.test.ts test/file-access.test.ts test/files.test.ts`: **122 passed**;
  `npx tsx --test test/skill-evidence.test.ts`: **23 passed**.
- `npm run check`: typecheck, **996 source tests**, **111 helper tests**, build passed.
- `node scripts/test-runtime.mjs smoke-evidence.mjs capture`: passed extended actual
  native ANSI-C, negation, symlink-launch/PWD and concatenated skill-reference cases.
  Result: `.runtime/runtime-run-dABHG4/results.json`; observations:
  `.runtime/evidence-identity/results.json`. Bash rejected inherited project PWD
  when launched in the symlinked workdir, executed the physical parent's marker,
  and the reviewer supplied no guessed post-cd source.
- `node scripts/test-runtime.mjs smoke-skills.mjs root`: passed, result
  `.runtime/runtime-run-s7Ey2r/results.json`.
- `node scripts/test-runtime.mjs smoke-skills.mjs subagent`: passed, result
  `.runtime/runtime-run-HGxTZM/results.json`.
- Node **24.21.0**, npm **12.2.0**, OpenCode **1.18.35**. No live-model judgment or
  full runtime matrix is claimed. Unsupported syntax is intentionally omitted with
  factual limitations, not evaluated by the production collector.

### Phase 2 disposition: F12-F13 fixed (2026-10-10)

- `src/controller.ts` separates armed automation lifetime, revoked rating
  reservations, reconciliation waits, durable manual state and actual dispatch.
  Recoverable pre-dispatch failures retain the physical GET slot until settlement,
  then use bounded fresh reconciliation. Rearming requires an identical pending
  request. Repeated frames do not replenish reads; invoked writes never retry.
- Rejected previews revoke their reservation even when replacement Safe arrives
  before the old GET settles. Rating/settlement callbacks do not manufacture a
  hide observation from their own unpainted layout changes. Fresh physical checks
  remain at verification and write boundaries; actual frame-observed hide, priority
  loss, Cancel and mode disable remain durable.
- Final Unsafe/unavailable results clear obsolete checking display immediately,
  allowing their proper manual notification while retaining unsettled read ownership.
  Late settlement cannot resurrect automation or replay attention.
- Regressions in `test/approval.test.ts`, `test/fast-mode.test.ts`,
  `test/controller.test.ts`, `test/notification-controller.test.ts` and new
  `test/phase2-reviewer.test.ts` cover all four F12 triggers, both F13 ordering cases,
  actual SSE retries/corrections, nonstream controls, final Unsafe, uncertainty and
  notification behavior. The old failed-verification tombstone test now creates an
  actually invoked uncertain write, preserving its intended no-retry control.
- New `scripts/smoke-approval-recovery.mjs` uses real native permissions, actual
  panel proof, SDK result gates, real HTTP/SSE and isolated notification recording.
  All six cases require zero writes from rejected work, one eventual native once,
  one execution, zero user input and no false attention. Registered in runtime
  inventory and the release active-policy sparse checkout.
- The first real `correction-after` run failed at
  `.runtime/runtime-run-5HEwev/results.json`: repeated rating clears sampled stale
  layout between publication and FRAME. This was fixed in the controller, with
  source regression and successful real-host rerun; fixture assertions were retained.
- Final `npm run check`: typecheck, **1,058 source tests**, **111 helper tests**,
  and build passed. Focused eight-file controller/presentation run: **328 passed**.
- Executed recovery commands (each prefixed by
  `node scripts/test-runtime.mjs smoke-approval-recovery.mjs`):

  | Scenario | Passing runner result |
  | --- | --- |
  | `read-error` | `.runtime/runtime-run-DFG525/results.json` |
  | `read-timeout` | `.runtime/runtime-run-IqregF/results.json` |
  | `correction-after` | `.runtime/runtime-run-ahspgy/results.json` |
  | `correction-before` | `.runtime/runtime-run-FfIBSA/results.json` |
  | `transport-after` | `.runtime/runtime-run-RSpGu0/results.json` |
  | `transport-before` | `.runtime/runtime-run-pc5vAW/results.json` |

- `node scripts/test-runtime.mjs smoke-fast-mode.mjs hidden` and `dialog`: passed,
  results `.runtime/runtime-run-vDZ3G7/results.json` and
  `.runtime/runtime-run-n056nH/results.json`.
- `node scripts/test-runtime.mjs smoke-session-mode.mjs`: passed,
  `.runtime/runtime-run-FnrpZj/results.json`.
- `node scripts/test-runtime.mjs --profile ci`: all **7 exact cases passed**,
  `.runtime/runtime-run-PRXt2g/results.json`.
- `npm run check:package`: two reproducible builds and exact five-file archive
  passed, SHA-256 `8e4ad5b592d7e2e2034698d30418ee76b51c137365ecddda0e660d8c24eaedf8`.
- `node --test test/release-artifact-smoke.test.mjs test/npm-cli-smoke.test.mjs`:
  **9 passed**, offline boundaries. No publication performed.
- Environment: Node **24.21.0**, npm **12.2.0**, OpenCode **1.18.35**. SDK errors and
  model responses are synthetic; no live-provider judgment or physical audio claim.

### Phase 3 gate: F34 awaiting governing-contract reconciliation

- **Expected:** F34 authorizes normal countdowns and approval with the root-only
  panel intentionally absent on same-root descendant routes, including reports
  completing while already hidden.
- **Found:** the active session's governing maintainer instructions require final
  highlighting and a matching painted frame for normal approval, make genuine
  visibility loss durable, and name production history as the sole normal-mode
  physical-cover exception. The source, README and tests implement that contract.
- **Impact:** implementing F34 as written would change a governing approval guard.
  Editing the repository's `AGENTS.md` does not itself replace instructions already
  supplied to this execution session. No hidden-approval bypass was implemented.
- **Options:** resume F34 in a session whose governing presentation instructions
  explicitly incorporate the requested same-root exception, or explicitly defer
  F34 and continue the independent remaining work packages under the current rule.
  Phase 3 remains unchecked; implementation has stopped at this ordered gate.
- **Separate Phase 4 dependency:** installed `@opencode-ai/plugin` **1.18.35**
  `dist/tui.d.ts` exposes neither native permission-stack mounting nor actionable
  selection control. F33 additionally requires supported upstream host work, not
  a report-only stack or notification-suppression substitute. No host changes or
  compatibility claims were made.

### Scope update after Phase 2

- **F33: dropped by user direction.** No implementation or upstream host work is
  required. Historical findings and probes remain documented; dropping scope is
  not a claim that notification replay or native stacking was fixed.
- **F34: user approval confirmed; active instruction conflict remains.** The user
  explicitly authorized the hidden-normal-approval exception and requested that
  only the conflicting instruction be replaced. That establishes product intent,
  but cannot supersede the higher-priority instructions already active in this
  session. Resume implementation after the governing session instructions are
  updated to include F34, or obtain direction to continue independent packages
  while F34 stays blocked. Existing verified commits are unchanged.

### Continuation scope

The user subsequently deferred F34 and instructed continuation of the remaining
fixes. Phase 4 and later packages proceed under the existing physical-presentation
contract. F33 remains dropped. Neither disposition claims an implemented fix.

### Phase 4 disposition: F14/F15 fixed; F32 measured compatibility limitation

- Controller, geometry and live-panel proof distinguish visible, pending renewed
  paint and proven loss. Pending paint cannot dispatch or reset the countdown end.
  `src/review-presentation.ts` tracks public sidebar ownership and keeps review
  publications out of the Solid ownership observer. Live/history trees survive
  native wide/overlay owner replacement; no replacement at the real frame proves loss.
- Deterministic geometry/controller tests cover timer, post-list and deferred-write
  boundaries, fresh verification after renewed paint, original deadlines, and real
  loss controls. Client-Solid integration exercises nine actual reactive/SSE cases.
- A first recovery regression run caught a view-dependent ownership effect treating
  a retry publication as a frame. It was fixed with ownership-only tracking and
  untracked callback reads, then passed unchanged real recovery assertions.
- `npm run check`: **1,081 source checks**, **111 helper tests**, typecheck and build
  passed. The source count includes one wrapper verifying nine client-Solid tests.
- Commands below use `node scripts/test-runtime.mjs`; all passed on OpenCode
  **1.18.35**, Node **24.21.0**, npm **12.2.0**:

  | Arguments | Result under `.runtime/` |
  | --- | --- |
  | `smoke-approval-geometry.mjs benign-width` | `runtime-run-JN4cLS/results.json` |
  | `smoke-approval-geometry.mjs sidebar-handoff-live` | `runtime-run-vsRpgc/results.json` |
  | `smoke-approval-geometry.mjs sidebar-handoff-history` | `runtime-run-HSS3Uv/results.json` |
  | `smoke-approval-geometry.mjs resize` | `runtime-run-cVtB3S/results.json` |
  | `smoke-approval-recovery.mjs correction-after` | `runtime-run-ZuDVUt/results.json` |
  | `smoke-history-auto.mjs hide` | `runtime-run-8U2iqH/results.json` |
  | `smoke-history-auto.mjs narrow` | `runtime-run-qz7SY4/results.json` |
  | `smoke-history-auto.mjs dialog` | `runtime-run-v8yosp/results.json` |
  | `smoke-history-auto.mjs fullscreen` | `runtime-run-VNpUqi/results.json` |
  | `smoke-mouse-proof.mjs normal` | `runtime-run-uSWV7h/results.json` |
  | `smoke-mouse-proof.mjs fast` | `runtime-run-4ehpH3/results.json` |

- Benign-width uses a bounded public frame-callback gate: actual RESIZE, actual
  countdown callback with pending proof and zero writes, then released real FRAME.
  Handoff cases retain one live/Markdown/history owner and no missing-report frame,
  with exactly one once at the original deadline. These are exact cases, not a full matrix.
- **F32 disposition:** confirmed pinned-host limitation, production change deferred
  for supported upstream painted-ownership support independent of mouse input.
  OpenTUI 0.4.5 skips hit-grid population with mouse disabled. Normal final reports
  and fast previews/finals were visible, but had no owned hits and made zero replies
  or executions beyond the configured delay. Public dialogs and native fullscreen
  controls were independently exercised. No geometry-only approval override or
  forced mouse enablement was introduced.

### Phase 5 disposition: F06-F09 fixed

- `history-migration.ts` persists per-root review/attempt/approval cursors and
  accumulators in transactions of at most 128 steps with a 40 ms cooperative
  budget. All current writers gate root mutation/deletion on completed bootstrap;
  cursor progress never advances writer replay or reconstructs lifetime totals.
  Worker/store bootstrap operations yield independently of the original event.
  Actual slice ownership survives read timeout and worker termination.
- `history-browsing.ts` uses trigger-maintained structural generations covering
  same/foreign-connection SQL changes, bounded 32-root/128-rank caches, and a
  visible-history partial index. Selected context/payload is validated every poll.
  Cold validation and uncached rank remain linear; unchanged polling avoids them.
- Maintenance dirty recovery yields after 100 rows or 50 ms with 10 ms gaps,
  preserving one actual read, root-first exact-404 proof, revision restarts and
  complete healthy confirmation. Refresh commits coalesce follow-up freshness;
  navigation/deletion/maintenance and accounting failures still invalidate results.
- New bootstrap/browsing/progress tests include an 80,000-review, 10,000-attempt
  slowed source worker with forced watchdog restart; rollback/cross-client replay;
  deletion followed by unrelated-root progress; 100k-row browsing and repair;
  continuous write backlog publication and notification-target selection.
- Focused worker measurement: 1,954 committed slices, maximum successful slice
  45.7 ms, 49.2 s total including watchdog/retry. The time budget is cooperative,
  not a claim that SQLite I/O cannot stall. Unchanged 1k/10k/100k selections used
  eight SQL reads with zero validation/count/rank row visits. Cold 100k selection
  measured 438.9 ms; warm average 0.134 ms in the focused run.
- Deterministic 1,000-session/10-deletion scheduler controls: 210 ms with immediate
  responses, 2,400 ms with 1 ms replies, 4,390 ms including an existing idle timer;
  1,990 host reads, maximum concurrency one. These are synthetic scheduler timings.
- `npm run check`: **1,101 source checks**, **111 helper tests**, typecheck and build passed.
- After build, these `node scripts/test-runtime.mjs` invocations passed:

  | Arguments | Result under `.runtime/` |
  | --- | --- |
  | `smoke-history-storage.mjs` | `runtime-run-u0d6fS/results.json` |
  | `smoke-history-maintenance.mjs` | `runtime-run-qUnUoR/results.json` |
  | `smoke-history.mjs shared` | `runtime-run-dg1pb5/results.json` |
  | `smoke-statistics.mjs` | `runtime-run-50bmO0/results.json` |
  | `smoke-history-auto.mjs notification` | `runtime-run-WUQwWK/results.json` |

- Actual packed Bun adapter and shared host behavior passed. Large slow-worker
  measurements use Node SQLite; no equivalent Bun scale timing is claimed.

### Phase 6 initial disposition: F23/F25 fixed; F05 initially partial

- **F23:** `history-private-path.ts` validates a nonreplaceable cross-UID namespace,
  including every ancestor and database/sidecar ownership, mode, link count and
  no-follow opening. Root-owned sticky temporary directories are supported. Existing
  objects are never chmodded. Privileged and same-effective-UID namespace mutation
  remain outside this boundary. Controlled unsafe-ancestor constructor tests reject
  before SQLite opens or writes the replacement.
- **F25:** terminal browser close/dispose/root deletion releases selected payload and
  scroll state. Selected-child deletion retains only payload-free navigation metadata;
  transient read/loading recovery preserves intended scroll behavior. Eight new
  regressions failed before the fix; focused browser/controller tests: **38 passed**.
- **F05 implemented portion:** verified `secure_delete=ON`, durable cleanup generations,
  owned non-waiting WAL checkpoint/retries, and crash-resumable deletion slices of
  at most 128 steps/40 ms cooperative work. Busy readers retain cleanup obligations.
  Current-policy deletion removes marker bytes from active DB/WAL/SHM files on both
  Node and packed Bun adapters while preserving totals/tombstones/replay.
- Cross-client history, rank, neighbor and resolution queries hide tombstoned child
  detail from the first committed slice, before final physical deletion. Large hidden
  gaps are skipped through per-live-session indexed seeks and bounded neighbor caches.
- Automatic legacy freelist cleanup uses SQLite-owned zero-filled reservations,
  at most eight 64 KiB records/40 ms cooperative work per slice, retained until the
  freelist is exhausted and then securely released. Rollback, restart and two-worker
  ownership tests passed. A focused 6,949-free-page case completed in 108 slices,
  maximum direct slice 22.42 ms, with 8 KiB file growth; interrupted-store recovery
  took 6.72 s including watchdog/retry and retained exact live data.
- **Remaining F05 issue:** pre-policy fragments in still-live b-tree pages survive
  freelist cleanup, no-op updates and incremental vacuum. The durable legacy flag
  deliberately stays set. Explicit offline `compactLegacy()` removes the test marker,
  but is an embedding/fixture operation, not automatic production compatibility.
  No automatic unbounded VACUUM or UI migration warning was added. Full legacy
  erasure needs an owned exclusive compaction policy or a resumable rebuild with
  cross-client publication. This initial blocker is resolved by the continuation below.
- A first packed Bun run correctly rejected host-created 0775 state ancestors under
  inherited umask 0002. `smoke-runtime.mjs` now creates newly owned isolated state
  roots as 0700; existing public/symlinked state is rejected without modification.
  **8 runtime-cleanup tests passed**, including the actual umask and unchanged-object
  controls. This is fixture initialization, not a production privacy bypass.
- `npm run check`: **1,148 source checks**, **111 helper tests**, typecheck and build
  passed before the final fixture-only initialization change.
- Actual pinned-host commands, each prefixed with `node scripts/test-runtime.mjs`:

  | Arguments | Result under `.runtime/` |
  | --- | --- |
  | `smoke-history-storage.mjs` | `runtime-run-aaGBIp/results.json` |
  | `smoke-history-maintenance.mjs` | `runtime-run-v9wW8J/results.json` |
  | `smoke-history.mjs shared` | `runtime-run-B9uLc6/results.json` |
  | `smoke-history.mjs delete` | `runtime-run-RWPwqu/results.json` |

- Packed Bun proof includes busy-reader cleanup, automatic freelist scrub, the
  residual legacy marker, explicit compaction, two clients, retained totals,
  tombstones, reopen and disposal. No whole-disk/backups erasure is claimed.
- Final fixture-only changes: `npm run test:helpers` **111 passed**;
  `npm run check:package` reproduced SHA-256
  `6c8334c4315f830857df0afc12b5b5fae240b456388ed7f856bd3ae39b6f04a7`
  and exactly five package files; `node --test test/release-artifact-smoke.test.mjs
  test/npm-cli-smoke.test.mjs` **9 passed** with offline boundaries.

### Phase 6 completion: automatic legacy live-page erasure

- `history-legacy-rebuild.ts` incrementally rebuilds plugin tables and indexes,
  mirrors concurrent mutations with transactional triggers, atomically switches
  the live table, then securely retires its old rows and empty b-trees. Durable
  cursors and finite copy ceilings survive interruption without blocking appends.
  No raw page writes or automatic unbounded VACUUM are used.
- Each slice handles at most eight rows with a 40 ms cooperative budget. Individual
  SQLite operations remain indivisible and owned by the existing worker watchdog.
  Total work scales with database size; space can grow by the largest table and
  indexes. Pinned readers delay WAL erasure until they release their snapshots.
- Tests cover zero-freelist live-page/index markers, concurrent update/delete,
  rollback/reopen, bounded slow slices and watchdog interruption during cutover.
  `npm run check`: **1,152 source checks**, **111 helper tests**, typecheck and build.
- Pinned-host commands through `scripts/test-runtime.mjs` passed:
  `smoke-history-storage.mjs` (`.runtime/runtime-run-tj26Nu/results.json`) and
  `smoke-history.mjs shared` (`.runtime/runtime-run-rqXqa1/results.json`). Packed
  Bun now automatically erases both old free-page and live-page/index markers.
- PATH now supplies OpenCode V2. Verification explicitly used isolated npm
  `opencode-linux-x64@1.18.35` via `OPENCODE_BIN`; no V2 compatibility is claimed.

### Phase 7 disposition: F10/F11 fixed

- Four evaluators per controller cover evidence collection and model transport;
  queued work uses native-front priority and round-robin root service. Abort and
  deadline-visible completion retain leases through actual evaluator settlement.
  Waiting work is removed on disable/deletion/disposal; retained fast reports keep
  their existing lifecycle. Tests cover 64-way fanout and noncooperative settlement.
- Unchanged Enable retries persistence without invalidating the controller. Actual
  registered command tests preserve reports, original countdown deadlines and
  cancelled/uncertain tombstones, including failed persistence and competing commands.
- `npm run check`: **1,177 source checks**, **111 helper tests**, typecheck and build.
- Pinned-host `scripts/test-runtime.mjs` runs passed: `smoke-review-admission.mjs
  fanout64` (`runtime-run-SlS34e`), `smoke-fast-mode.mjs complete`
  (`runtime-run-gQohKp`), `smoke-session-mode.mjs` (`runtime-run-tuUt4i`), each with
  `results.json` under `.runtime/`. Fanout observed at most four concurrent reviewer
  HTTP requests, one-slot handoff, disable/re-enable and zero command executions.
- Initial fixture failures exposed startup observation absence and a native update
  dialog. Startup absence is optional only until first publication; these fixtures
  now explicitly disable host auto-update. No approval assertion was weakened.

### Phase 8 disposition: F16/F24/F26 fixed

- Terminal SSE refusal/filter/tool-call clears previews, drains well-framed usage,
  finalizes once and remains non-retriable. Framing/UTF-8/resource errors, abort and
  the original deadline stop draining. Fourteen source integration cases include
  byte splits, real HTTP and malformed tails.
- Nested stages inherit the exact parent deadline end. Tests control production
  sleep plus monotonic time, asserting precise jitter/Retry-After boundaries and
  zero extra POSTs after cancellation or exhausted budgets. Mutation checks rejected
  the old deadline calculation and a one-millisecond-shortened backoff.
- `npm run check`: **1,208 source checks**, **111 helper tests**, typecheck and build.
  The deadline/retry/admission/file-access/reviewer subset passed **233 tests on each
  development floor**, Node **22.22.2** and **24.15.0**, with child executable checks.
  A first full run exposed uncontrolled monotonic time in an admission timer test;
  it now advances performance time and timers together without changing assertions.
- Pinned-host `smoke-streaming.mjs complete --stats` passed in
  `.runtime/runtime-run-U8MXhy/results.json`; `truncated --static --stats` passed in
  `.runtime/runtime-run-Xu4zKa/results.json`. The fixture now disables auto-update
  after an initial run correctly failed on a covering native update dialog.
