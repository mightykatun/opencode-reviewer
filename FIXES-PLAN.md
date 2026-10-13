# Review fixes implementation plan

## Execution checklist

- [x] 1. Read the complete plan and identify completed work.
- [x] 2. Read the files required by each phase before editing them.
- [x] 3. Derive concrete ordered implementation tasks and success criteria.
- [x] 4. Implement phases sequentially and commit verified work.
- [x] 5. Run each phase's checks and resolve failures before proceeding.
- [x] 6. Update this plan as each item is verified.
- [x] 7. Record and escalate only unresolved mismatches.

## Scope and constraints

Implement the confirmed review findings and close the identified production
coverage gaps. Investigate the notification ordering risk before deciding its
disposition. Preserve approval guards, once-only writes, uncertain-write
tombstones, physical presentation, independent test expectations and actual
I/O ownership. Never chmod existing user directories or weaken SQLite ancestry
checks. Preserve committed history and lifetime totals. Keep historical V1
implementation and fixtures as migration inputs. Keep exactly five package files.

## Phase 1: history and statistics storage

- [x] Read state selection, history initialization/worker/store and their tests.
- [x] Select a private plugin-owned state root without relying on a writable host directory.
- [x] Preserve safely accessible existing databases, totals and mode records.
- [x] Distinguish initialization failures from invalid admitted transactions.
- [x] Add default-HOME/0775, ownership, restart and recovery regression tests.
- [x] Verify focused source tests, build and installed V2 history/statistics.
- [x] Commit verified phase and record evidence.

## Phase 2: dependency and distribution hygiene

- [x] Repair the resolved Seroval override and assert clean-install resolution.
- [x] Narrow unnecessary theme dependency bundling where the public API permits it.
- [x] Include all notices required by retained bundled dependencies.
- [x] Verify clean installation, dependency audit, helpers and reproducible five-file package.
- [x] Commit verified phase and record evidence.

## Phase 3: approval, history input and statistics recovery

- [x] Preserve Cancel through native preparation and publish Allowing only after dispatch.
- [x] Separate mouse-independent keyboard browsing from strict approval-cover proof.
- [x] Retry transient Conversation ancestry failures with bounded coalesced ownership.
- [x] Correct the live-panel mount/scroll comment.
- [x] Add independent regression tests for each behavior.
- [x] Verify focused tests, build and relevant installed V2 fixtures.
- [x] Commit verified phase and record evidence.

## Phase 4: evidence completeness and large-record boundaries

- [x] Represent missing declared edit previews as incomplete evidence at both boundaries.
- [x] Bound RPC envelopes separately from independently owned components.
- [x] Reduce repeated normalization/canonicalization of validated immutable records.
- [x] Add missing-preview, aggregate-boundary, exact-linkage and cancellation regressions.
- [x] Verify focused tests, build and production invocation/evidence fixture.
- [x] Commit verified phase and record evidence.

## Phase 5: notification coherence and approval transaction ownership

- [x] Reproduce or resolve stale notification health during scoped event invalidation.
- [x] Prune only safely resolved and physically settled approval reservations.
- [x] Extract explicit approval transaction ownership without changing dispatch invariants.
- [x] Add delayed-delivery, churn, successful cleanup and uncertain-retention tests.
- [x] Verify focused approval/notification tests, build and relevant V2 fixtures.
- [x] Commit verified phase and record evidence.

## Phase 6: production coverage and fixture structure

- [x] Split reusable V2 review driving/observation code from scenario assertions where useful.
- [x] Add automatic native edit and directory-to-edit continuation cases.
- [x] Verify exact replies, applied changes, saved history and statistics for both cases.
- [x] Add manual attention handoff, form lifecycle and reminder cancellation cases.
- [x] Add execution terminal distinctions and unavailable-review notification-only coverage.
- [x] Register cases, preserve classifications and include active-policy helper dependencies.
- [x] Verify helper inventory and run each new stock-V2 production case.
- [x] Commit verified phase and record evidence.

## Phase 7: final verification

- [x] Run npm run check.
- [x] Run npm run check:package and built archive/provenance smoke tests.
- [x] Run the current V2 CI profile including registered new acceptance cases.
- [x] Review documentation, notices, plan evidence and git diff.
- [x] Commit the final verified plan and report exact acceptance limits.

## Evidence and dispositions

Record commands, results and any justified scope adaptations below each phase as
work completes. A coverage gap is complete only after its stock-host fixture runs.

### Phase 1 disposition

Safely accessible existing databases will stay in place rather than be copied
while another terminal may write them. An unsafe host directory selects a private
plugin-owned sibling. An existing safe sibling wins on restart, keeping selection
stable. Existing mode records remain in their original location. Unsafe legacy
databases remain untouched; their namespace cannot authorize migration reads.

- `npm run typecheck`: passed.

- Focused state/storage/history/protocol tests: 57 passed, 0 failed.
- `npm run test:helpers`: 123 passed, 0 failed.
- `npm run build`: passed.
- Stock OpenCode 2.0.27 `normal-history-default-home`: passed, including actual
  saved report, lifetime/conversation statistics, private fallback and unchanged
  host permissions. Artifacts: `.runtime/v2-review-normal-history-default-home-WHXwqz`;
  invocation/results: `.runtime/runtime-run-5B1gxZ/results.json`.
- Commit: `fix: recover history storage under writable host state directories`.

### Phase 2 evidence

- Replaced the nested serializer override with an explicit Seroval override;
  regenerated lockfile changes only Seroval version, URL and integrity.
- `npm ci --ignore-scripts`: clean installation passed; actual Solid resolution
  regression passed with Seroval 1.6.3.
- `npm audit --json`: 0 vulnerabilities, including development dependencies.
- `npm run typecheck`: passed.
- `npm run test:helpers`: 126 passed, 0 failed, including sparse-policy closure.
- `npm run check:package`: reproducible SHA-256
  `677978c9fbeb105fe560d8aa4665a46c7658647e096eea44b7f1ec14f3708c35`;
  exactly five files, 1,535,994 unpacked bytes.
- Built archive/provenance tests: 10 passed, 0 failed. The actual terminal payload
  contains no Effect or theme parsers, preserves public mappings, and matches
  upstream syntax semantics. Existing theme MIT notice covers retained code.
- Stock OpenCode 2.0.27 `normal-history`: passed with the narrowed payload.
  Artifacts: `.runtime/v2-review-normal-history-bQQXMw`;
  results: `.runtime/runtime-run-YCBiLX/results.json`.
- Commit: `e75c7e5`, `fix: resolve patched serializer and bundle only theme syntax`.

### Phase 3 source verification

- Native preparation retains Checking/Cancel; Allowing is published only after
  the dispatch callback and native invocation. Historical V1 reservation behavior
  remains unchanged.
- Focused native/legacy approval and panel tests: 180 passed, 0 failed.
- Statistics recovery tests: 20 passed, 0 failed, including delayed physical
  settlement, dequeued callbacks, close/disposal and latest-root ownership.
- Combined source verification: 215 passed, 0 failed; log
  `.runtime/phase3-source-tests.log`. Typecheck and build passed.
- Mouse-enabled keyboard browsing still requires strict hit ownership; only
  mouse-disabled browsing uses independent real-frame geometry. Automatic cover
  never accepts that keyboard proof.
- Helpers: 126 passed, 0 failed (`.runtime/phase3-helper-tests.log`).
- Stock OpenCode 2.0.27 `normal-history-keyboard-mouse-off`: passed, including two
  real saved entries, exact Left/Right selection, all four scrolling keys and
  rejected approval-cover queries. Artifacts:
  `.runtime/v2-review-normal-history-keyboard-mouse-off-pxXiL0`;
  results: `.runtime/runtime-run-udQTei/results.json`.
- Stock `normal-cancel` and `fast-notifications`: passed; results respectively
  `.runtime/runtime-run-a2rE77/results.json` and
  `.runtime/runtime-run-uCH7RG/results.json`.
- Commit: `23f135d`, `fix: preserve cancellation and keyboard history ownership`.

### Phase 4 evidence

- Missing previews now produce exact omitted target entries, with neither invented
  host status nor fabricated diffs/counts. Permission resources and declared
  operation/move targets are retained verbatim; unavailable targets consume the
  file allowance. Independent CLI validation rejects incomplete claims labeled
  complete or missing omitted entries.
- Initial missing-preview/source regressions: 17 passed, 0 failed.
  Final edit/large-command regressions: 18 passed, 0 failed
  (`.runtime/phase4-edit-tests.log`).
- Combined RPC/evidence boundary tests: 52 passed, 0 failed
  (`.runtime/phase4-source-tests.log`); shared tool/evidence tests: 17 passed,
  0 failed (`.runtime/phase4-tool-tests.log`). Typecheck and build passed.
- Copy measurements are captured during the original bounded traversal, not a
  second large-string scan. Only privately issued, recursively frozen objects
  reuse bounds and canonical forms; arbitrary frozen caller inputs are rechecked.
- Local 8 MiB probe: issued-copy reuse 0.009 ms; ten exact owned comparisons
  88 ms. This is a local measurement, not a portable performance assertion.
- Stock OpenCode 2.0.27 invocation `default` and `review`: passed. Artifacts:
  `.runtime/v2-invocation-gP7q5x`, `.runtime/v2-invocation-6TIYS7`; results:
  `.runtime/runtime-run-4MB8K5/results.json`,
  `.runtime/runtime-run-kxTYqA/results.json`.
- Commit: `4f9c10d`, `fix: retain complete target coverage and bound RPC components independently`.

### Phase 5 evidence

- The stale-notification risk was reproduced: deferred delivery's signal remained
  active immediately after a scoped interruption while native synchronization was
  held (`.runtime/phase5-notification-red.log`, one expected failing regression).
- Full runtime now withdraws stale observer health before publishing scoped queue,
  execution, form and interruption events. Interruption refreshes native caches.
  This health gate does not participate in approval admission.
- ApprovalTransaction owns explicit preparation, dispatch, acknowledgement,
  confirmation and uncertain/not-sent states. Controller retains presentation,
  countdown, verification and recovery policy; transport-specific nesting and
  parallel acknowledgement/native-reply maps were removed.
- Successful transport reservations prune only after physical non-aborted ACK
  plus caller-admitted exact once resolution. Original snapshots stay weakly spent;
  uncertain/unresolved/non-once reservations remain protected. 200 success cycles
  return retained reservations to zero.
- Combined transaction/approval/transport/notification tests: 308 passed, 0 failed
  (`.runtime/phase5-source-tests.log`). Typecheck and build passed.
- Stock OpenCode 2.0.27 `normal`, `fast-notifications`, `normal-cancel`: passed.
  Results: `.runtime/runtime-run-lQrC7f/results.json`,
  `.runtime/runtime-run-NZ8iek/results.json`,
  `.runtime/runtime-run-3IuBwy/results.json`.
- Commit: `21e4269`, `fix: own approval transactions and invalidate stale notifications`.
- Full source suite after the five implementation phases: 1,581 passed, 0 failed,
  0 cancelled (`.runtime/implementation-source-tests-complete.log`, 156 seconds).
  The first invocation was interrupted by the shell's 120-second command limit;
  the completed rerun changed no source-test budgets or concurrency.
- Focused independent verification found an ACK-first edge case: a confirmation
  timeout followed by a late once event could prune an uncertain reservation.
  Controller tombstones still prevented repeat writes, but transport retention
  violated the planned contract. Reservation abort ownership now lasts through
  confirmation; successful/unsent paths release listeners. Integrated real-deadline
  regression and focused transport/transaction/controller tests: 64 passed.
  Typecheck and build passed; rebuilt stock `normal` and `fast-notifications`
  passed (`.runtime/runtime-run-qaqXkZ/results.json`,
  `.runtime/runtime-run-g0Fg9p/results.json`).

### Phase 6 verification scope

- Production additions must use actual native permissions, operations and forms,
  not synthetic event injection or replacement executors. Only the desktop
  delivery backend is substituted; actual audio/focus remain outside acceptance.
- Exact new inventory: `normal-edit`, `normal-directory-edit`;
  notifications `manual-handoff`, `forms`, `execution`, `unavailable-review`.
  Final CI/acceptance enrollment is contingent on stock-host completion.
- Runtime supervisor/isolation tests: 8 passed, 0 failed
  (`.runtime/phase6-runtime-isolation-tests.log`).
- Built archive/provenance tests against the extracted-transaction build:
  10 passed, 0 failed (`.runtime/phase6-built-archive-tests.log`).
- Foreground fixture implementations completed after cancelled background agents;
  no unverified agent output was marked complete.
- Reusable read-only SQL and independent stage assertions moved into
  `scripts/smoke-v2-review-support.mjs`; pure tests verify rejection of corrupted
  attribution, categories, usage and snapshots, and read-only byte preservation.
- Helpers: 129 passed, 0 failed, including inventory discovery and active-policy
  sparse closure (`.runtime/phase6-helper-tests.log`).
- All six new cases passed on stock OpenCode 2.0.27:
  - `normal-edit`: `.runtime/runtime-run-51dRvZ/results.json`.
  - `normal-directory-edit`: `.runtime/runtime-run-aknjVj/results.json`.
  - `manual-handoff`: `.runtime/runtime-run-QeerMU/results.json`.
  - `forms`: `.runtime/runtime-run-tf1QyZ/results.json`.
  - `execution`: `.runtime/runtime-run-ozADan/results.json`.
  - `unavailable-review`: `.runtime/runtime-run-CH9VGG/results.json`.
- Corrected fixture assumptions from actual failures, not relaxed safety gates:
  directory review needs explicit opt-in; execution births precede received
  assistant-step output. Manual replies use the actual public decision field.
- These additions exercise genuine native events/operations with real held
  responses and sustained negative windows. They do not prove native edit/patch
  variants, desktop/audio playback, multi-terminal races or live-provider judgment.
- Commit: `fe8af6c`, `test: cover native write continuation and production notification lifecycles`.

### Phase 7 evidence

- `npm run check`: typecheck, 1,583 source tests, 129 helper tests and build passed;
  zero failures/cancellations (`.runtime/final-check.log`).
- `npm run check:package`: reproducible bundle SHA-256
  `a5b2883107b9d3545b433b6b69e416bb55b7473a2454917efd24d4d55b4c9329`;
  exactly five archive files, 1,554,907 unpacked bytes. An interrupted network-error
  invocation was rerun to completion; no verification was bypassed.
- Built archive/provenance/npm CLI checks: 10 passed, 0 failed. These are offline
  boundary tests and dry runs, not package publication or real OIDC signing.
- `node scripts/test-runtime.mjs --profile ci`: all 30 cases passed on stock
  OpenCode 2.0.27, serially, in 11.39 minutes. Exact classification: 27 production
  host cases and 3 synthetic host probes. Logs, invocations and results:
  `.runtime/runtime-run-PpYgvL/results.json` and its adjacent numbered logs.
  Every new acceptance case ran again against the final rebuilt archive.
- README now documents keyboard-only history and cancellable native preparation;
  storage behavior, theme notices, fixture inventory and active-policy sparse
  dependencies match the implementation. `git diff --check e8c3cfa` passed.
- All implementation and fixture changes are committed. No unresolved mismatch
  remains. No publication, version bump, tag, push or live-install mutation was
  performed; generated build and fixture artifacts remain ignored.

### Exact acceptance limits

This run verifies the current 30-case V2 selection on stock OpenCode 2.0.27 with
Node 24.21.0 and npm 12.2.0. It does not verify the full historical V1 matrix, a
local run of the 2.0.26 CI lane, native edit/patch variants beyond the write cases,
all family/fullscreen/multi-terminal permutations, actual desktop/audio/focus,
live-provider judgment or real package publication/provenance signing. Safely
accessible existing storage remains in place; unsafe legacy namespaces stay
untouched rather than being read, chmodded or guessed into a migration.
