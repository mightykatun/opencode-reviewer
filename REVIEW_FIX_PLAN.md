# Review fixes

Implement the concrete defects from the codebase review without changing accepted
installation assumptions, approval policy, resource budgets or release policy.
Optional evidence-egress policy and live-model evaluation are not part of this work.
Use targeted extractions, not a controller/transport rewrite. Preserve aggregate
inventory bounds and add capacity coverage rather than removing safety limits.

## Execution checklist

- [x] 1. Read the complete plan and identify existing completion state.
- [x] 2. Read relevant source and tests before each phase's edits.
- [x] 3. Derive the ordered implementation and verification tasks below.
- [x] 4. Implement phases sequentially and commit verified phases.
- [x] 5. Verify each phase and fix failures before proceeding.
- [x] 6. Update this checklist and evidence as work completes.
- [x] 7. Resolve mismatches explicitly; escalate only genuinely blocking decisions.

## Implementation

- [x] Phase 1: Preserve fast approval resolution provenance.
  - [x] Distinguish read-only disappearance from exact native resolution in retained controller entries.
  - [x] Preserve uncertain-write tombstones across disappearance/reappearance.
  - [x] Test uncertain/rejected acknowledgement, confirmation timeout and exact-event contrasts.
  - [x] Verify controller/fast-mode/native transport tests and typecheck; commit.
- [x] Phase 2: Recover temporary companion contention.
  - [x] Distinguish capacity exhaustion from invalid/missing evidence.
  - [x] Bound waiting/recovery within the original deadline and physical ownership.
  - [x] Test four-request real-companion fanout, shared contention, cancellation and invalid data.
  - [x] Add aggregate permission-inventory capacity regression coverage without raising limits.
  - [x] Verify companion/evidence/admission/permission tests and typecheck; commit.
- [x] Phase 3: Fix fallback connection handling and question deduplication.
  - [x] Preserve observed startup marker independently of companion success.
  - [x] Share exact initial-echo versus reconnect fencing across runtime compositions.
  - [x] Preserve dispatched question initials across queue/health loss.
  - [x] Test composed failed startup, initial/distinct echoes and dispatched/undispatched question recovery.
  - [x] Verify lifecycle/fallback/notification tests and typecheck; commit.
- [x] Phase 4: Repair fixture isolation and database-startup polling.
  - [x] Isolate every fixture Git initialization and bound its subprocess lifetime.
  - [x] Treat an uninitialized history database as pending, not corruption.
  - [x] Test hostile Git environment and absent/uninitialized/initialized/corrupt databases.
  - [x] Verify helper checks; commit.
- [x] Phase 5: Fix history cache invalidation and attribution clocks.
  - [x] Avoid invalidating browsing for unreferenced unsaved reviews; preserve ownership/corruption invalidation.
  - [x] Separate wall-clock event timestamps from monotonic retention/backoff.
  - [x] Test same-root unsaved activity, referenced mutations and clock jumps.
  - [x] Verify history/accounting tests and typecheck; commit.
- [x] Phase 6: Remove obsolete machinery and refresh tests/docs/dependencies.
  - [x] Retire unused diagnostic trace helpers and orphaned fixture measurements after checking all consumers.
  - [x] Replace exhaustive metadata-matrix real sleeps with controlled clocks; retain real-timer controls.
  - [x] Refresh OpenCode V2 dependencies to newest stable and correct theme attribution.
  - [x] Put evidence-disclosure guidance near installation without adding UI notices or policy options.
  - [x] Verify affected tests, helper inventory, typecheck and audit; commit.
- [x] Phase 7: Final verification.
  - [x] Run complete source/helper/typecheck/build checks.
  - [x] Verify reproducible five-file package and built release smoke checks.
  - [x] Run the complete 38-case `ci` real-TUI profile on latest stable OpenCode V2, serially.
  - [x] Record exact results, inspect diff/status and commit final checklist.

## Evidence

Record commands, test counts and exact runtime fixture results here after each phase.

- Initial state: clean working tree; no pre-existing plan file. `todowrite` and
  an Edit tool are unavailable, so this file is the task list and `patch` updates it.
- Source/test context is read before each phase, including by narrowly scoped
  implementation agents. Phase verification remains serial with two test workers.
- Phase 1: three new regressions failed before the fix. Core source selection:
  105 passed; expanded controller/approval/history/notification/statistics selection:
  276 passed, both with `--test-concurrency=2`. Typecheck, build and diff check passed.
  Real TUI `smoke-v2-review.mjs fast` passed on OpenCode 2.0.29 in 8,454 ms;
  `.runtime/runtime-run-8SDqhL/results.json` records exit 0.
  Fresh advisory reviews after read-only disappearance remain allowed; tombstones
  prevent additional approval preparation/writes, not advisory reporting.
- Phase 1 core command: `npx tsx --test --test-concurrency=2 test/controller-native-approval.test.ts test/fast-mode.test.ts test/approval-transaction.test.ts test/host-permissions.test.ts`.
- Phase 1 expanded command: `npx tsx --test --test-concurrency=2 test/controller-native-approval.test.ts test/fast-mode.test.ts test/approval-transaction.test.ts test/host-permissions.test.ts test/approval.test.ts test/controller.test.ts test/history-controller.test.ts test/controller-background-approval.test.ts test/notification-controller.test.ts test/statistics-controller.test.ts test/streaming-controller.test.ts test/controller-host-types.test.ts`.
- Phase 2: `capacity_busy` is a declared read-only RPC error. Only that rejection
  retries, sequentially, at bounded 50 ms boundaries within the original budget.
  Missing/invalid evidence stays terminal, and both physical server slots remain owned.
  Focused source selection passed 92 tests after deterministic timing refinements;
  expanded selection passed 396 tests. Typecheck, build and diff check passed.
  Commands/results are in `.runtime/phase2-timing-focused-tests.log`,
  `.runtime/phase2-expanded-tests.log`, `.runtime/phase2-timing-typecheck.log`
  and `.runtime/phase2-timing-build.log`.
  Focused command: `npx tsx --test --test-concurrency=2 test/companion*.test.ts test/host-reader.test.ts test/host-evidence-reader.test.ts test/host-evaluate.test.ts test/host-permissions.test.ts test/review-admission.test.ts`.
  Real TUI `smoke-v2-review.mjs normal-tool` passed on OpenCode 2.0.29 in 15,134 ms;
  `.runtime/runtime-run-oOju7h/results.json` records exit 0.
- Phase 2 expanded command: `npx tsx --test --test-concurrency=2 test/companion*.test.ts test/host-reader.test.ts test/host-evidence-reader.test.ts test/host-evaluate.test.ts test/host-permissions.test.ts test/review-admission.test.ts test/deadline.test.ts test/reviewer-ownership.test.ts test/review-context-ownership.test.ts test/file-access.test.ts test/invocation-capture.test.ts test/host-invocation.test.ts test/host-request.test.ts test/host-evidence.test.ts test/controller.test.ts test/controller-host-types.test.ts test/controller-native-approval.test.ts test/controller-background-approval.test.ts test/approval.test.ts test/approval-transaction.test.ts test/fast-mode.test.ts`.
- Final runtime preflight: `node scripts/test-runtime.mjs --plan --profile ci`
  selects exactly 38 existing production/foundation cases. This is planning only,
  not runtime acceptance; the actual profile remains unchecked until executed.
- Phase 3: shared exact-marker comparisons preserve only verified initial echoes;
  marker-free/conflicting startup and distinct reconnects remain fenced. Question
  initials are remembered only after channel dispatch, not queue admission.
  `npx tsx --test --test-concurrency=2 test/cli-plugin.test.ts test/plugin-lifecycle.test.ts test/host-runtime.test.ts test/host-history-runtime.test.ts test/host-notification-runtime.test.ts test/notification-policy.test.ts test/notification-scheduling.test.ts`: 180 passed.
  `npm test`: 1,385 passed after rerunning the interrupted first invocation with a
  sufficient harness budget; `.runtime/phase3-source-tests-rerun.log` records zero
  failures/cancellations. Typecheck, build and diff check passed.
  Real TUI `smoke-v2-notifications.mjs unavailable-review` passed in 56,949 ms
  (`.runtime/runtime-run-HJjkgs/results.json`); `forms` passed in 24,451 ms
  (`.runtime/runtime-run-dN07EZ/results.json`), serially on OpenCode 2.0.29.
- Phase 4: all 15 inventoried Git fixtures use one isolated 10-second initialization
  helper. A real child Node/Git test with hostile Git directory/config/template
  variables proves the unrelated directory remains untouched. SQL probes return
  pending for empty/uncommitted schemas and transient SQLite busy locks, but reject
  committed partial schemas and corrupt bytes without mutating the database.
  `node --test test/smoke-helpers.test.mjs test/smoke-v2-review-support.test.mjs test/runtime-inventory.test.mjs`: 28 passed.
  `npm run test:helpers`: 147 passed (`.runtime/phase4-helpers.log`); diff check passed.
  Real TUI `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-history`
  passed on OpenCode 2.0.29 (`.runtime/runtime-run-bY9EgG/results.json`).
- Phase 5: indexed review-reference triggers invalidate actual referencing roots,
  including raw corruption/repair and cross-root identity moves, but not unsaved
  activity. Measured warm browsing work remains zero scans at 1k/10k/100k entries.
  Attribution uses monotonic expiry/backoff independently of wall-clock event times,
  including late events before timer delivery; actual read cleanup remains owned.
  `npx tsx --test --test-concurrency=2 test/history-browsing.test.ts test/history-coordinator.test.ts test/history-native-types.test.ts`: 42 passed.
  `npx tsx --test --test-concurrency=2 test/history-*.test.ts test/conversation-statistics.test.ts test/lifetime*.test.ts test/local-state.test.ts test/statistics-controller.test.ts test/fast-mode.test.ts test/host-history-runtime.test.ts test/host-history-view.test.ts`: 287 passed.
  Logs: `.runtime/phase5/regressions-rerun.log` and `.runtime/phase5/history-source-checks.log`.
  Typecheck, build and diff check passed. Real TUI `normal-history` passed in
  29,705 ms on OpenCode 2.0.29 (`.runtime/runtime-run-hkl4SX/results.json`).
  Saved rows, totals, format/version and existing resource budgets are unchanged.
- Phase 6: removed test-only trace and orphaned measurement helpers after checking
  every consumer. Actual transport diagnostic/privacy/error-isolation checks remain.
  SSE retry matrices now control production timers and monotonic time together;
  exact boundary and identical retry-body assertions replace real backoff sleeps.
  `npx tsx --test --test-concurrency=2 test/diagnostics.test.ts test/reviewer.test.ts test/reviewer-retry-timing.test.ts`: 188 passed in 15.53 seconds
  (`.runtime/phase6-source-targeted.log`). Typecheck and build passed.
  `npm run test:helpers`: 139 passed (`.runtime/phase6-helpers.log`);
  after generalizing the retired test-name assertion, `node --test test/ci-workflow.test.mjs`: 3 passed.
  Client/plugin/theme resolve to latest stable 2.0.29; theme fingerprints still pass.
  `npm audit --ignore-scripts --json`: zero vulnerabilities (`.runtime/phase6-audit.json`).
  npm reports the existing OpenTUI Node-engine warning; its pinned 0.5.17 version
  matches the Bun host and remains unchanged. No development floor was weakened.
  README now explains pre-approval disclosure and out-of-project symlink evidence
  near installation. No UI notice or new policy option was added. Diff check passed.
- Phase 7 source/package verification: `npm run check` passed 1,404 source tests,
  139 helper tests, typecheck and build (`.runtime/final-check.log`). Strict unused
  locals/parameters typecheck passed (`.runtime/final-unused-check.log`).
  `npm run check:package` verified exactly five files, 1,366,340 unpacked bytes and
  reproducible SHA-256 `b40043504b6d4f4964dd4a28d7184c50c1dd22b3c74d8d92306f19d98a2fddc8`
  (`.runtime/final-package.log`).
  `node --test test/release-artifact-smoke.test.mjs test/npm-cli-smoke.test.mjs`:
  11 passed, offline signing/publication boundaries only (`.runtime/final-release-smoke.log`).
  Registry metadata confirms latest stable V2 is 2.0.29. Initial full-runtime run
  stopped at lifecycle/default because its recovery assertion dereferenced an
  absent companion (`.runtime/runtime-run-yzNfDO/results.json`). Runtime coverage
  remains unchecked while the mismatch is diagnosed and corrected.
- Independent final approval/evidence patch audit found no introduced defect in
  the inspected changes. Its focused source selection passed 136 tests with two
  workers (`.runtime/final-admission-audit.log`); this is not real-host acceptance.
- Runtime mismatch resolved: lifecycle's independent RPC schema lacked Phase 2's
  declared `capacity_busy` read errors, so its wrapper threw before any handshake.
  Updated the fixture schema, added an AST-based schema-parity regression, and
  made expected companion admission explicit. No production checks or budgets changed.
  `node --test test/smoke-monitor.test.mjs`: 8 passed.
  Lifecycle/default passed in 47,072 ms (`.runtime/runtime-run-vMyCZ8/results.json`);
  cold-startup passed in 48,050 ms (`.runtime/runtime-run-UURzfp/results.json`),
  serially on OpenCode 2.0.29. The complete profile still requires a successful run.
- Second runtime mismatch resolved: startup reload aborted a consumed prompt-free
  native create/remove control after the server could commit it, losing its actual
  reply. Four deterministic monitor regressions failed before the repair. The
  fixture now drains that dispatched transaction within its existing 15-second
  RPC cap, preserving the reply without replay; the original 60-second admission
  deadline covers control waits, and exact native birth/deletion remain mandatory.
  No production code, palette/cache behavior or timeout cap changed.
  Targeted helper checks: 20 passed; full helper suite: 145 passed. Build/diff check
  passed. Fast passed twice (12,134 and 12,295 ms), normal-edit passed (21,241 ms),
  forms passed (24,522 ms), serially on OpenCode 2.0.29. Exact commands, actual
  event observations and results paths: `.runtime/final-fast-probe-evidence.log`.
  The interrupted profile's six successful cases remain evidence, not a full pass.
- Final runtime acceptance: `node scripts/test-runtime.mjs --profile ci` passed all
  38 cases serially on stock OpenCode 2.0.29 and Node 24.21.0. Total measured case
  duration: 978,742 ms. `.runtime/runtime-run-6P9GLn/results.json` contains every
  exact invocation, duration and log; all exit codes are zero, with no timeout or
  interruption. Independently compared its full ordered case/argument selection
  against `profilePlan("ci")`, asserting exactly 38 passing cases.
  Latest complete helper run passed 145 tests. Production source remained unchanged
  after the 1,404-test full check and 11-test package smoke run. The rebuilt bundle
  still hashes to `b40043504b6d4f4964dd4a28d7184c50c1dd22b3c74d8d92306f19d98a2fddc8`.
  Diff/status review found no unrelated or uncommitted implementation changes.
  Actual desktop/audio, Node 22 and live-provider safety judgment were not exercised;
  synthetic/runtime fixture acceptance does not establish those outcomes.
