# Notification and Approval Ordering Audit (Archived)

## Archive status and current disposition

This is the **2026-10-09 snapshot**, not current fixing instructions. The original
observations, reproductions, severity table, recommendations and proposed checks
below describe commit `0aaf9d6184f7de5f705e46bbf1881987657d0fbe`. In particular, the
inline reproduction asserts historical buggy behavior and is not a current test.
Old source line links describe that commit; use the named symbols to navigate it.

[AUDIT.md](AUDIT.md) is the current issue/disposition ledger. Its finding text also
has historical context: consult the linked phase dispositions for implemented fixes.
The following source/test comparison was verified on 2026-10-12:

| Historical ID | Current disposition and evidence |
| --- | --- |
| NA-01 | Fixed at the actual write callback: `Controller.approveNow` rechecks eligibility, revision and exact request before invoking `once`; dispatch facts follow invocation. See [controller](src/controller.ts) and the microtask dispatch-reservation regressions in [approval tests](test/approval.test.ts) and [fast-mode tests](test/fast-mode.test.ts). |
| NA-02 | The original stale-revision failure now recovers through bounded fresh reads. The later pre-dispatch read-error/budget variant was tracked separately as F12 and is also fixed; see [Phase 2 disposition](AUDIT.md#phase-2-disposition-f12-f13-fixed-2026-10-10), [approval tests](test/approval.test.ts) and [notification/controller tests](test/notification-controller.test.ts). |
| NA-03 | Two occupied player slots now queue eligible audio rather than immediately dropping it. [Audio scheduling](src/notification-audio.ts) and the [8:1 actionable/routine queue](src/notification-queue.ts) retain abort ownership and root rotation. [Linux notification tests](test/notification-linux.test.ts) cover held players and policy/backend sound-only playback, resolution, preemption, deletion and disposal. |
| NA-04 | Event-born questions are readmitted on healthy polling and ancestry-capacity release, retaining birth/visit eligibility. See `refreshQuestions`, `lookup` and `admissions` in the [host bridge](src/notification-host.ts), plus failed-ancestry and third-question capacity regressions in [host tests](test/notification-host.test.ts). |
| NA-05 | Question delivery waits for the healthy permission baseline; baseline requests remain silent blockers. [Host tests](test/notification-host.test.ts) cover held, failed and event-raced reads for root and child permissions. The later permission-attention variant F17 and missed-question completion F18 are fixed separately; see [Phase 9 disposition](AUDIT.md#phase-9-disposition-f17f18-fixed). |
| NA-06 | Action receipt starts a click lease and aborts the previous activation before asynchronous desktop completion. See the [Linux backend](src/notification-linux.ts), [host bridge](src/notification-host.ts), and delayed-EOF/held-activation/route-invalidation regressions in [Linux](test/notification-linux.test.ts) and [host tests](test/notification-host.test.ts). |

### Remaining limits

- These dispositions cover the named source interleavings, not every possible cause
  of a Safe-but-manual report. Actual visibility/priority loss, explicit cancellation
  and uncertain dispatched writes retain durable manual state. Unsettled reads keep
  their physical slot; recovery requires fresh identical pending state and cannot
  guarantee progress during a continuing outage.
- Audio has two active slots and at most 64 queued jobs. A full queue can still
  reject new playback; missing players, decoding failures and desktop failures do
  not guarantee delivery. The NA-03 fix covers contention within those bounds.
- Admission remains bounded by visited-root/event ownership and available ancestry
  reads. Baseline/pre-visit requests do not become notification births, and unknown
  ordering deliberately withholds attention until healthy reconciliation.
- Mocked processes do not prove human-audible sound or actual GNOME window/tab focus.
  [Phase 10](AUDIT.md#phase-10-disposition-f19-f22f27-f28-fixed) records six successful
  normalized desktop playback cases and player exits, with human perception,
  click/focus and live desktop banners still untested there. No host or desktop
  session was run for this archive update.
- Other current limitations, including mouse-disabled presentation (F32) and the
  user-deferred root-only presentation scope (F34), retain their dispositions in
  [AUDIT.md](AUDIT.md); this archive does not close them.

## Historical handoff summary

- **Audited commit:** `0aaf9d6184f7de5f705e46bbf1881987657d0fbe` (`v1.0.0` manifests).
- **Audit date:** 2026-10-09.
- **Target host:** Linux OpenCode **1.18.35**, matching the pinned plugin/SDK target.
- **Audit runtime:** Node.js `v24.21.0`.
- **Requested scope:** notifications, approval ordering and precedence, sound emission,
  simultaneous commands from parallel subagents, and asynchronous races.
- **Additional user-observed symptom:** a Safe rating with auto-approval enabled can
  produce "Session needs attention" and remain unapproved.
- **Result:** six source-level issues reproduced with deterministic in-memory mocks.
  **NA-02 directly reproduces the user's additional symptom.**
- **Implementation status at the audited commit:** findings were open. This was a
  fixing-agent handoff; current dispositions are listed above.

P1 means high priority because an approval eligibility boundary can be crossed.
P2 means medium priority because automation, notification delivery, or navigation can
fail under the stated conditions. The table and detailed findings are severity ordered.

| ID | Severity | Finding | Primary consequence |
| --- | --- | --- | --- |
| NA-01 | P1 | Final approval guard precedes a deferred write callback | Approval can be written after visibility, queue priority, or fast-mode enablement is lost |
| NA-02 | P2 | Global revision changes permanently fail an otherwise eligible Safe approval | Parallel activity causes attention alerts and manual queue blockers without any attempted approval write |
| NA-03 | P2 | Shared audio capacity silently drops actionable sounds | An Unsafe/question/attention episode can have no alert in sound-only mode |
| NA-04 | P2 | Failed or capacity-limited question admission lacks a recovery path | A pending subagent question can stay silent indefinitely |
| NA-05 | P2 | Question delivery can precede the initial permission baseline | A question alerts while an existing permission still owns native input |
| NA-06 | P2 | Desktop activation completion reorders notification clicks | An older click can override a newer conversation/report selection |

## Evidence and limits of validation

The audit traced the controller, TUI integration, host bridge, notification policy,
native blocker selector, desktop adapter, process ownership, and audio playback.
It also inspected the corresponding source tests and relevant fixture behavior.

This existing test command was run successfully:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test test/notification-order.test.ts test/notification-policy.test.ts test/notification-host.test.ts test/notification-controller.test.ts
```

**Result: 80 tests passed, 0 failed.** Passing tests do not cover the interleavings
and delivery-capacity cases below. Some current approval tests explicitly expect
the fail-closed behavior implicated in NA-02.

The additional reproductions imported the actual source classes and used deferred
promises, controlled clocks, fake host state, and fake desktop processes. Audio
reproduction seeded an in-memory prepared-file cache and used fake player processes.
No actual permission was approved and no desktop process or sound was launched by
those reproductions. The inline reproductions were not added as regression-test files.

These results establish behavior at the source-module boundary. A real TUI/desktop
reproduction of each new interleaving was not performed. Runtime fixes still need
the focused real-host checks required by `AGENTS.md`; desktop-process fixtures alone
do not prove audible playback, GNOME focus, or the frequency of a race in production.

### Host contracts checked

The pinned host source was inspected at tag `v1.18.35`, commit
`53d1eabb61e21162157817bf677da0a4ad3332e3`:

- [Native session input selection](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/tui/src/routes/session/index.tsx)
- [Native pending-request state updates](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/tui/src/context/sync.tsx)
- [Permission service](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/opencode/src/permission/index.ts)
- [Permission HTTP handler](https://github.com/anomalyco/opencode/blob/53d1eabb61e21162157817bf677da0a4ad3332e3/packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts)

Native input presents permissions before questions. Selection covers a root and its
direct children, using code-unit session order and the pending request order within
each session. Deeper descendants do not have a native root-input prompt in this host.
The pinned permission service rejects missing requests; an older-host assumption
that replying to an already-removed request necessarily returns success was checked
and is not a finding in this report.

## Behavioral baseline to preserve

Read `AGENTS.md` before implementing. In particular:

1. **Rating is one gate, not the complete approval decision.** Normal approval also
   needs a completed validated assessment, final highlighting, a matching painted
   frame, correct queue ownership, enabled conversation mode, and the countdown.
2. **Fast mode remains opt-in.** It can use a parsed Safe preview when streaming,
   but still needs physical visibility and native priority. With `stream: false`,
   it waits for a complete validated response. History cover is not a fast-mode
   visibility exception.
3. **Cancellation is durable.** Explicit cancellation or visibility loss after a
   countdown starts makes the request manual for the controller lifetime. Do not
   fix NA-02 by indiscriminately clearing cancellation or uncertain-write state.
4. **Approval is once-only and single-flight.** Never retry a dispatched approval
   write. Read-side recovery must retain the original deadline and fresh identity,
   scope, mode, and visibility checks.
5. **Native priority includes silent requests.** Disabled, unsupported, baseline,
   identifying, and otherwise notification-ineligible requests still block later
   requests. Selection must not depend on which request finished its review first.
6. **Notification births come from events.** Startup/resume snapshots establish
   ordering and reconciliation, not permission to replay old alerts or reminders.
7. **Safe requests awaiting automation stay silent.** Waiting for queue position,
   rendering, or an unstarted countdown does not establish a need for human action.
   Countdowns and approval submission are silent. Success sounds require confirmed
   automatic success, not a preview, dispatch fact, or disappearance alone.
8. **Retained fast reports are not native blockers.** Use `pendingViews` for native
   notification ordering. Already-dispatched fast work retains its special lifecycle.
9. **Pending delivery belongs to its request.** Resolution, queue loss, deletion,
   and disposal must invalidate queued/deferred attention delivery and reminders.
   A newly actionable request gets its initial alert, then a full reminder interval.
10. **Notification work remains observational.** Desktop/audio failures must not
    affect reviews, approval timing, history attribution, or approval writes.

### Sound timing at the audited commit

The policy chooses whether a message requests sound. For a banner plus sound,
`LinuxNotifications.show` prepares the sound before starting `notify-send`, then
starts playback after receiving the notification ID. Sound-only delivery starts
audio without waiting for a desktop acknowledgement. All kinds currently share
the same playback-capacity limit, which causes NA-03.

Approval sounds are policy-rate-limited to one every two seconds. Attention,
Unsafe, and question eligibility follows the native blocker in each visited root;
there is no corresponding cross-kind audio-priority scheduler. Distinguish these
two layers when implementing and testing fixes.

## NA-01: Final approval guard precedes a deferred write callback

**Severity:** P1, high. **Evidence:** deterministic source-level reproductions.

### Code locations

- [`src/controller.ts:284-315`](src/controller.ts#L284-L315): `allowing` publication,
  last eligibility check, dispatch facts, fast retention, and deferred write.
- [`src/controller.ts:108-111`](src/controller.ts#L108-L111): suspension skips an
  entry with `fastApproval` set.
- [`src/controller.ts:157-166`](src/controller.ts#L157-L166): cancellation accepts
  only `countdown` or `checking`, not `allowing`.
- [`src/deadline.ts:35-39`](src/deadline.ts#L35-L39): `withDeadline` invokes its
  callback from a promise microtask.

Line references throughout this report refer to the audited commit. Use the named
symbols when surrounding code changes.

### Trigger and interleaving

1. A Safe request is visible and eligible. Its fresh permission-list read succeeds.
2. `approveNow` publishes `autoApproval.status = "allowing"`.
3. It synchronously rechecks eligibility, records the dispatch fact, and, in fast
   mode, sets `fastApproval = "pending"`.
4. It calls `withDeadline` to run the actual `approval.once` operation. The helper
   queues that callback for a later promise microtask.
5. Before that callback runs, eligibility changes: the panel hides, an earlier
   native blocker appears, or fast-mode conversation review is disabled.
6. The write callback still invokes `once` without another eligibility check.

`allowing` is treated as too late to cancel even though the transport has not yet
been invoked. Fast mode additionally treats the premature `fastApproval` marker as
proof that suspension must preserve the already-dispatched write.

### Observed result

For the normal-mode reproduction, a microtask queued by the `allowing` publication
cleared the visible ID and called `controller.presented()` before `once` ran:

```text
eligibility-lost: visible=undefined
permission-write: visible=undefined
confirmed: automatic=true
```

For the fast-mode reproduction, that microtask disabled the mode gate and called
`controller.modeChanged("root")`:

```text
eligibility-lost: enabled=false
permission-write: enabled=false
confirmed: automatic=true
```

A separate injected higher-priority-request reproduction likewise observed a write
for the Safe request while another request occupied the front of the pending set.
The reproduction controls scheduling to establish the gap; it does not establish
how frequently ordinary host/UI events hit that gap.

### Impact

The last checked state is not necessarily the state at the actual write boundary.
Approval can bypass the visibility, mode, or native-order condition the controller
intends to enforce. The resulting acknowledgement can then generate an automatic
approval notification and associated accounting facts.

### Recommended implementation direction

- Put the final eligibility check immediately before the actual `once` invocation,
  inside the callback that owns dispatch.
- Move dispatch facts and the state that means "a write has been dispatched" to
  that boundary. Keep any pre-dispatch reservation distinct from actual dispatch.
- Account for `eligible()` currently rejecting entries with `fastApproval` set;
  simply adding that call after the existing marker would reject all fast writes.
- Preserve single-flight ownership, the original verification/write deadline,
  and the bounded acknowledgement surviving native resolution.
- Preserve the existing lifecycle after a write really has been issued. Do not
  cancel an already-dispatched fast review merely because the user later navigates
  away or disables review.

### Required regression coverage

Add cases to `test/approval.test.ts` and `test/fast-mode.test.ts` that schedule
`queueMicrotask(...)` from the `allowing` publication. Existing synchronous
publication tests do not exercise this deferred-callback boundary.

- Hide before transport invocation: zero writes and no confirmation.
- Insert a higher-priority direct-child request before invocation: zero writes for
  the displaced request. Use session ordering that mirrors real child selection.
- Disable fast mode's conversation gate before invocation: zero writes and no
  retained-as-dispatched state.
- Resolve/delete/dispose before invocation: zero writes and no late resurrection.
- Unchanged eligibility: exactly one write.
- Change visibility/mode after real invocation: keep the already-dispatched
  acknowledgement and fast-report lifecycle working as specified.
- Observers and notifications must not record confirmation for a prevented write.

## NA-02: Global revision changes permanently fail an eligible Safe approval

**Severity:** P2, medium. **Evidence:** deterministic source-level reproduction with
an unchanged request and an unrelated conversation event. **User symptom match.**

### Code locations

- [`src/controller.ts:274-279`](src/controller.ts#L274-L279): capture and compare the
  instance-wide revision around the verification read.
- [`src/controller.ts:337-354`](src/controller.ts#L337-L354): convert the mismatch to
  permanent `failed` state, then perform read-only recovery.
- [`src/controller.ts:358-374`](src/controller.ts#L358-L374): every newly tracked
  permission increments that revision.
- [`src/controller.ts:432-435`](src/controller.ts#L432-L435): even an unknown reply
  increments the revision.
- [`src/notification-policy.ts:24-36`](src/notification-policy.ts#L24-L36): a Safe,
  failed approval notifies after pending state is confirmed.

### Trigger and interleaving

1. Request A has a completed Safe assessment and remains visible at the front.
2. Automatic approval starts its fresh `permission.list` verification.
3. While the read is outstanding, request B arrives. B may be a later request in
   the same root, a parallel subagent request, or a request in another conversation.
4. The revision changes even when B cannot affect A's queue priority or evidence.
5. A's read returns. The revision mismatch throws before any approval write.
6. The catch path sets A's manual tombstone and `autoApproval` to `failed`.
7. Recovery confirms that A is pending. `approvalPendingConfirmed` becomes true,
   and the policy emits "Session needs attention" with its configured sound.
8. Further presentation, clicks through `approveNow`, and ordinary reconciliation
   do not re-arm automatic approval of A.

### Observed result

| Condition | List reads | Approval writes | A's final state | Notification |
| --- | ---: | ---: | --- | --- |
| No concurrent event | 1 | 1 | Removed after approval | No attention |
| Unrelated-root request arrives during verification | 2 | 0 | Safe, `failed`, pending confirmed | `attention` |

The second case held A's visible ID constant throughout. No command scope changed,
no user cancellation occurred, and no write had an uncertain outcome.

### Impact

Unrelated concurrency turns an otherwise eligible Safe request into a permanent
manual blocker. The likelihood grows with permission activity from parallel agents
and with verification latency. Once A blocks the native queue, later requests in
that root can also stop progressing automatically.

### Recommended implementation direction

Keep stale-snapshot rejection, but separate these cases:

1. A read was invalidated before dispatch and the request may still be eligible.
2. The user canceled or actual visibility/priority/mode was lost.
3. A write was dispatched and its outcome is failed or uncertain.

For case 1, consider bounded fresh verification within the original deadline,
rechecking full request equality, native priority, mode, and presentation. Do not
reuse the stale list, remove the revision guard, extend the deadline, or retry a
write. Cases 2 and 3 retain their durable manual behavior.

**Existing tests to review deliberately:** `test/approval.test.ts` has the parameterized
test `new request / unknown reply / unknown deletion invalidates an outstanding
fresh snapshot by revision`. It currently asserts `failed`. Revise its expectations
only as part of the explicit pre-dispatch recovery design; retain proof that a stale
snapshot cannot erase newly observed requests.

### Required regression coverage

- Unrelated-root event during verification: A remains eligible and can approve once
  after valid fresh verification, without an attention episode.
- Later same-root request that does not take priority: same result.
- Actual earlier blocker: prevent dispatch and preserve the intended cancellation
  policy rather than treating it as harmless unrelated churn.
- Native resolution/deletion, changed same-ID arguments, explicit cancellation,
  mode changes, and visibility loss still defeat approval.
- Sustained event churn is deadline-bounded and does not produce an unbounded read
  loop or overlapping uncontrolled reads.
- Dispatched uncertain writes are never retried, including after re-enable.
- Test both the controller state and notification output. A controller-only test
  will miss the erroneous attention consequence.

## NA-03: Shared audio capacity silently drops actionable sounds

**Severity:** P2, medium. **Evidence:** deterministic playback-capacity reproduction.

### Code locations

- [`src/notification-audio.ts:88-102`](src/notification-audio.ts#L88-L102): `play`
  immediately returns when `active >= 2`.
- [`src/notification-linux.ts:32-37`](src/notification-linux.ts#L32-L37): sound-only
  delivery returns an audio-backed handle without another alert channel.
- [`src/notification-policy.ts:165-172`](src/notification-policy.ts#L165-L172): an
  unchanged attention episode does not dispatch another initial notification.

### Trigger and reproduction

1. Start two sounds and keep both player process results unsettled. The reproduction
   used `approved` and `ended`.
2. Request an `unsafe` sound while those players still own the two slots.
3. Allow both earlier players to settle.

The actual `NotificationAudio` class was used with prepared-cache entries resolving
to dummy paths and fake process ownership. This avoids file decoding and physical
audio while exercising the real slot logic.

```json
{"activeSounds":["cached-approved","cached-ended"],"unsafeWasPlayed":false}
```

No Unsafe playback is queued or retried when capacity becomes available. Any kind
can occupy the slots; there is no precedence for manual-action sounds. Approval's
two-second rate limit does not solve this, because sounds can be longer and other
notification types share the slots.

### Impact

With a banner, the sound is lost. With `banner: false, sound: true` and
`staleReminderSeconds: 0`, the entire actionable notification can disappear for
that episode. With reminders enabled, the user may hear nothing until a later
reminder, which can encounter the same contention.

This is especially relevant to independent visited conversations: one can finish
while another receives approval, filling both slots just as a third needs input.

### Recommended implementation direction

Use bounded, abortable playback scheduling instead of treating saturation as
successful completion. Establish explicit precedence for actionable attention,
Unsafe, and question sounds over routine approval/completion sounds. The exact
cross-root fairness and routine-sound coalescing policy is an implementation choice,
not an existing contract established by this audit.

Preserve request cancellation ownership. A queued sound must recheck its abort
signal and must never play after resolution, queue loss, deletion, or disposal.
Do not solve capacity pressure with unbounded processes or an unbounded queue.

### Required regression coverage

Extend `test/notification-linux.test.ts` with held player processes and a real
policy/backend path, including sound-only configuration.

- Two routine plays followed by actionable audio: eventual actionable playback
  while still eligible, without requiring a reminder.
- Queued request resolves or loses priority: no later sound.
- Multiple eligible roots: bounded capacity and a defined fairness policy.
- `notify: false`, `notifySound: false`, and per-kind sound disabling still dominate.
- Approval rate limiting and confirmed-success-only semantics remain intact.
- Disposal owns active players and pending work. Delivery stays off approval paths.

## NA-04: Question admission is not retried after metadata recovery

**Severity:** P2, medium. **Evidence:** deterministic failed-lookup/recovered-metadata
reproduction. Lookup-capacity exhaustion reaches the same missing-retry branch.

### Code locations

- [`src/notification-host.ts:155-163`](src/notification-host.ts#L155-L163): ancestry
  lookup capacity and shared lookup ownership.
- [`src/notification-host.ts:203-216`](src/notification-host.ts#L203-L216): admission
  exits on missing capacity or consumes lookup failure without scheduling recovery.
- [`src/notification-host.ts:116-120`](src/notification-host.ts#L116-L120): successful
  question reconciliation updates blockers but does not retry admission.
- [`src/notification-host.ts:232-242`](src/notification-host.ts#L232-L242): snapshots
  retry permission admission, not question admission.

### Trigger and reproduction

1. Visit a root conversation.
2. Receive a fresh question from a child whose metadata is temporarily absent.
3. Make the asynchronous root lookup reject once.
4. Populate the child's metadata with its correct `parentID`, as a native state
   update would do. The host bridge has no admission handler for `session.updated`.
5. Return the still-pending question in three successful two-second polls.

```json
{"lookups":1,"nativeQuestionPending":1,"knownParent":"root","notifications":[]}
```

The host retains the question request but never creates its policy entry/target.
Updating blocker selection cannot notify an entry that was never admitted.

### Impact

A recoverable metadata problem becomes a persistent silent wait for user input.
Parallel child requests can also encounter the two-lookup cap, making recovery
important even when the ancestry service itself is healthy.

### Recommended implementation direction

Retry unadmitted event-born questions on appropriate healthy reconciliation,
metadata updates, or bounded lookup-capacity release. Use the original request
object/birth sequence and existing visited-root eligibility rules.

Do not manufacture event births from poll results. Do not admit a question that
resolved, was deleted, or belonged to an unvisited/pre-visit context while a lookup
was outstanding. Bound concurrency and avoid a lookup retry storm.

### Required regression coverage

Use the existing fixture in `test/notification-host.test.ts`:

- Missing child metadata, one failed lookup, then recovered metadata and healthy
  polls: exactly one initial notification when the question is actionable.
- Three or more simultaneous unknown-child questions: first two lookups may own
  capacity, but a later eligible question must recover when capacity returns.
- Recovery while queued: admission is allowed, delivery still waits for native
  priority and starts a full reminder interval after handoff.
- Resolution/deletion/disposal before recovery: no delayed alert.
- Baseline-only and pre-visit questions remain silent after recovery.

## NA-05: Question delivery can outrun the initial permission baseline

**Severity:** P2, medium. **Evidence:** deterministic startup-state reproduction.

### Code locations

- [`src/notification-host.ts:129-141`](src/notification-host.ts#L129-L141): permission
  blockers come from controller views and observed events; only question baseline
  readiness has an explicit delivery gate.
- [`src/tui.tsx:247-256`](src/tui.tsx#L247-L256): notification host construction and
  independent question-list reads.
- [`src/tui.tsx:318-325`](src/tui.tsx#L318-L325): asynchronous initial permission
  refresh starts later in initialization.

### Trigger and reproduction

1. The native TUI already has a pending permission when the plugin activates.
2. The initial question baseline succeeds, but the controller's initial permission
   refresh has not completed.
3. Visit the root and receive a fresh question from ongoing parallel work.
4. The host's public permission state still contains the old permission, but the
   notification bridge has neither its controller view nor a fresh birth event.
5. The bridge selects the question and dispatches its alert.

```json
{"nativePermissionStillPending":"baseline-permission","notificationsBeforePermissionRefresh":["question"]}
```

A later permission snapshot can withdraw the question's delivery. If the backend
already delivered the banner or sound, that withdrawal cannot undo the interruption.
Cold audio preparation may mask a short window, but does not provide a correctness
guarantee for a delayed or failing permission refresh.

### Impact

Question notifications can claim user attention while permissions still own the
native input prompt. This violates the priority contract specifically during
attachment/activation recovery with concurrent agents.

### Recommended implementation direction

Establish trustworthy permission ordering before allowing question delivery.
Possible approaches include a permission-baseline readiness signal or complete
native pending-permission state for the relevant root/direct-child scope. Choose
an approach using the supported public host APIs and existing revision guards.

Baseline requests must participate as silent blockers, not gain notification birth
eligibility. Health/failure handling must not silently convert unknown permission
ordering into proof that a question owns the front.

### Required regression coverage

Add a host-bridge/controller integration case where the initial permission read is
held while a question birth arrives after a successful question baseline.

- Existing root permission: no question banner or sound during the held read.
- Existing direct-child permission, including a disabled/unreviewed kind: same.
- Initial permission read fails or races an event: preserve conservative ordering
  until a healthy current baseline is established.
- Healthy empty permission baseline: the fresh actionable question can notify.
- Silent baseline permission resolves: the fresh queued question gets one initial
  alert and then waits a full reminder interval.
- Baseline questions still do not become fresh notifications.

## NA-06: Desktop activation completion reorders notification clicks

**Severity:** P2, medium. **Evidence:** deterministic out-of-order process-result
reproduction with two approval banners.

### Code locations

- [`src/notification-linux.ts:95-105`](src/notification-linux.ts#L95-L105): each
  completed desktop action independently awaits terminal activation, then calls
  the host click handler.
- [`src/notification-terminal.ts:18-31`](src/notification-terminal.ts#L18-L31): the
  multi-step asynchronous activation sequence.
- [`src/notification-host.ts:315-347`](src/notification-host.ts#L315-L347): newer-click
  and route protection starts only when the delayed callback reaches this layer.

### Trigger and reproduction

1. Deliver approval banners for an old and a newer permission.
2. Click the old banner. Hold its first GNOME activation lookup result.
3. Click the newer banner. Let its activation chain complete immediately.
4. The newer report opens.
5. Release the old activation lookup and let that chain finish.
6. Its late callback opens the old report over the newer selection.

```json
{"beforeOldFinishes":["new-click"],"finalNavigationOrder":["new-click","old-click"]}
```

The reproduction used fake `notify-send` and `gdbus` processes and stubbed icon
preparation. Per-banner history identities remained correct; callback ordering was
the defect. The existing identity test does not hold overlapping activation chains
open in this way.

### Impact

The effective selection follows process completion order instead of the latest
user click. Late work can override a more recent conversation/report choice. A
resulting route change could also interrupt a countdown elsewhere; that downstream
effect was not separately exercised in the click reproduction.

### Recommended implementation direction

Establish ordering when the desktop action is received, before asynchronous
activation. Use generation/ownership checks or cancellation so an older activation
cannot subsequently navigate. Reconcile this with route-change, deletion,
withdrawal, and disposal invalidation across the backend/host boundary.

Keep exact permission/session history targets. Preserve dialog deferral, the live
fast-report check, bounded hidden save waiting, and the behavior for unavailable
reports. Do not substitute the newest saved report for the clicked report.

### Required regression coverage

Extend `test/notification-linux.test.ts`, then cover host interaction as needed:

- First click's activation held; second completes; first completes last: no old
  navigation after the second selection.
- An intervening ordinary notification click also supersedes an older approval
  click, and vice versa.
- Route changes, deletion, and disposal invalidate late navigation according to
  the existing lifecycle contract.
- Native dialogs still defer the surviving latest click.
- Activation failures remain isolated from approval and review work.
- Preserve the per-banner target under out-of-order completion, not merely a
  global "latest report" selection.

## Reproducing the Safe-but-manual symptom directly

The following standalone source-level reproduction can be run from the repository
root. It uses actual controller/policy code and a fake approval transport. It writes
no permissions and disables the `tsx` transform cache. The assertions describe the
audited buggy behavior, so they should be converted to the desired expectations
when adding a permanent regression test.

```sh
TSX_DISABLE_CACHE=1 node --import tsx --input-type=module <<'JS'
import assert from "node:assert/strict"
import { setImmediate as settle } from "node:timers/promises"
import { Controller } from "./src/controller.ts"
import { NotificationPolicy } from "./src/notification-policy.ts"
import { parseNotificationConfig } from "./src/notification-config.ts"

const request = (id, sessionID) => ({
  id, sessionID, permission: "bash", patterns: [], always: [], metadata: {},
})

for (const concurrent of [false, true]) {
  const a = request("a", "root")
  const b = request("b", "unrelated-root")
  const messages = []
  let release, reads = 0, writes = 0
  const policy = new NotificationPolicy(
    parseNotificationConfig({ staleReminderSeconds: 0 }), true,
    {
      async show(message) { messages.push(message.kind); return { close() {} } },
      dispose() {},
    },
  )
  const controller = new Controller(
    async () => ({ safe: true, desc: "Safe fixture" }),
    views => policy.snapshot(views, new Map([
      ["root", { kind: "permission", id: "a" }],
    ])),
    { reviewBash: true, reviewEdits: true, autoApprove: true },
    {
      visibleID: () => "a",
      list: () => ++reads === 1
        ? new Promise(resolve => { release = resolve })
        : Promise.resolve(concurrent ? [a, b] : [a]),
      once: async () => { writes++ },
    },
    { now: () => 0, after: () => () => {} },
  )
  try {
    policy.permission(a, { root: "root", sessionID: "root", title: "Root" }, true)
    controller.asked(a)
    await settle()
    controller.presented("a")
    const operation = controller.approveNow("a", true)
    await settle()
    if (concurrent) controller.asked(b)
    release([a])
    await operation
    await settle()
    controller.presented("a")
    await controller.approveNow("a", true)
    const view = controller.views.find(value => value.request.id === "a")
    assert.equal(writes, concurrent ? 0 : 1)
    assert.deepEqual(messages, concurrent ? ["attention"] : [])
    if (concurrent) {
      assert.equal(view.assessment.safe, true)
      assert.equal(view.autoApproval.status, "failed")
      assert.equal(view.approvalPendingConfirmed, true)
    }
    console.log(JSON.stringify({ concurrent, reads, writes, view, messages }))
  } finally {
    await controller.dispose()
    await policy.dispose()
  }
}
JS
```

## Triage guide for the reported Safe rating

Inspect the approval footer/state rather than inferring automation eligibility from
the Safe rating alone:

| Observed footer/state | Interpretation |
| --- | --- |
| `! Auto-approval unavailable. Use native controls.` / `failed` | Consistent with NA-02, but also with genuine verification/transport failures; not sufficient by itself to attribute the cause |
| `Auto-approval canceled` / `cancelled` | A durable cancellation occurred; a sibling taking priority after countdown start can cause visibility loss without an explicit Cancel click |
| Safe, no approval state yet | May legitimately be waiting for rendering or native queue position; this alone should not cause attention |
| `Checking…` or `Allowing…` | Verification/submission is in progress; attention should remain suppressed |
| `Auto-approved; finishing report…` | Confirmed retained fast report; it must not replay attention or block native notification ordering |

The audit reproduces one concrete cause of the user's symptom. It does not establish
that every previously observed instance had that cause. Preserve the intentionally
durable visibility/cancellation behavior unless a separate product decision changes
the documented contract.

## Suggested implementation sequence

1. Add deterministic regressions for NA-01 and NA-02 before changing dispatch or
   revision handling. Address them together conceptually: distinguish pre-dispatch
   preparation, actual dispatch, and uncertain/confirmed settlement.
2. Fix NA-01's actual write boundary and verify the already-dispatched fast lifecycle.
3. Fix NA-02's bounded pre-dispatch recovery without weakening cancellation,
   snapshot freshness, exact-request comparison, or no-write-retry guarantees.
4. Address audio scheduling (NA-03) with explicit bounded ownership and cancellation.
5. Address admission recovery and baseline ordering (NA-04/NA-05), testing the host
   bridge as well as the pure policy.
6. Address click ordering across asynchronous desktop activation (NA-06).
7. Run source checks, then the relevant real-TUI fixtures. Extend fixtures where
   the existing scenarios do not create the identified interleaving.

## Verification plan for the fixing agent

### Focused source checks

```sh
npx tsx --test test/approval.test.ts test/fast-mode.test.ts test/notification-controller.test.ts
npx tsx --test test/notification-host.test.ts test/notification-order.test.ts test/notification-policy.test.ts test/notification-linux.test.ts
npm run check
```

Unlike the audit's four-file read-only run, some broader tests exercise filesystem
or process fixtures. Run them under the repository's normal development conditions.
`npm run check` includes the build; rebuild if source changes afterward.

### Relevant host fixtures, after building

```sh
node scripts/smoke-notification-queue.mjs main --stream
node scripts/smoke-notification-queue.mjs children --stream
node scripts/smoke-notification-queue.mjs mixed --stream
node scripts/smoke-fast-mode.mjs complete
node scripts/smoke.mjs auto-shell
node scripts/smoke-session-mode.mjs
node scripts/smoke-history-auto.mjs notification
```

These are proposed post-fix runs, not fixtures executed during this audit. Read each
fixture's scenario parsing before extending it. Existing queue fixtures cover
overlapping requests, but the new verification-time churn, initial-baseline race,
and deferred-write interleavings need targeted coverage rather than assuming that
ordinary overlapping requests exercise them.

Respect the maximum of two concurrent hosts and use `smoke-runtime.mjs` supervision.
Keep captures under ignored `.runtime/`. Use isolated notification process I/O for
automated tests. If actual sound playback is being validated separately, the
maintainer-supported command is:

```sh
npx tsx scripts/smoke-notification-desktop.ts --sounds
```

### Completion criteria

- Each finding has a regression that fails against the audited behavior and passes
  with its fix, using explicit expected behavior rather than copying implementation.
- NA-02's unchanged eligible Safe request can progress automatically after unrelated
  pre-dispatch churn without a false attention episode.
- NA-01 cannot write after a pre-dispatch loss of required eligibility.
- No approval write is retried, no deadline is extended, and actual cancellation or
  uncertain-write tombstones remain durable.
- Actionable audio can survive capacity contention while still being canceled by
  resolution or queue loss.
- Question recovery never turns baseline/pre-visit requests into fresh alerts.
- Questions cannot overtake existing permission blockers during initialization.
- Late desktop activation cannot override the latest valid user click.
- Report exact test/fixture runs and distinguish process-level validation from
  physical sound/focus behavior.
