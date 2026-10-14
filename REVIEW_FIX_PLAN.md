# Review fixes

Implement the concrete defects from the codebase review without changing accepted
installation assumptions, approval policy, resource budgets or release policy.
Optional evidence-egress policy and live-model evaluation are not part of this work.
Use targeted extractions, not a controller/transport rewrite. Preserve aggregate
inventory bounds and add capacity coverage rather than removing safety limits.

## Execution checklist

- [x] 1. Read the complete plan and identify existing completion state.
- [ ] 2. Read relevant source and tests before each phase's edits.
- [x] 3. Derive the ordered implementation and verification tasks below.
- [ ] 4. Implement phases sequentially and commit verified phases.
- [ ] 5. Verify each phase and fix failures before proceeding.
- [ ] 6. Update this checklist and evidence as work completes.
- [ ] 7. Resolve mismatches explicitly; escalate only genuinely blocking decisions.

## Implementation

- [x] Phase 1: Preserve fast approval resolution provenance.
  - [x] Distinguish read-only disappearance from exact native resolution in retained controller entries.
  - [x] Preserve uncertain-write tombstones across disappearance/reappearance.
  - [x] Test uncertain/rejected acknowledgement, confirmation timeout and exact-event contrasts.
  - [x] Verify controller/fast-mode/native transport tests and typecheck; commit.
- [ ] Phase 2: Recover temporary companion contention.
  - [ ] Distinguish capacity exhaustion from invalid/missing evidence.
  - [ ] Bound waiting/recovery within the original deadline and physical ownership.
  - [ ] Test four-request real-companion fanout, shared contention, cancellation and invalid data.
  - [ ] Add aggregate permission-inventory capacity regression coverage without raising limits.
  - [ ] Verify companion/evidence/admission/permission tests and typecheck; commit.
- [ ] Phase 3: Fix fallback connection handling and question deduplication.
  - [ ] Preserve observed startup marker independently of companion success.
  - [ ] Share exact initial-echo versus reconnect fencing across runtime compositions.
  - [ ] Preserve dispatched question initials across queue/health loss.
  - [ ] Test composed failed startup, initial/distinct echoes and dispatched/undispatched question recovery.
  - [ ] Verify lifecycle/fallback/notification tests and typecheck; commit.
- [ ] Phase 4: Repair fixture isolation and database-startup polling.
  - [ ] Isolate every fixture Git initialization and bound its subprocess lifetime.
  - [ ] Treat an uninitialized history database as pending, not corruption.
  - [ ] Test hostile Git environment and absent/uninitialized/initialized/corrupt databases.
  - [ ] Verify helper checks; commit.
- [ ] Phase 5: Fix history cache invalidation and attribution clocks.
  - [ ] Avoid invalidating browsing for unreferenced unsaved reviews; preserve ownership/corruption invalidation.
  - [ ] Separate wall-clock event timestamps from monotonic retention/backoff.
  - [ ] Test same-root unsaved activity, referenced mutations and clock jumps.
  - [ ] Verify history/accounting tests and typecheck; commit.
- [ ] Phase 6: Remove obsolete machinery and refresh tests/docs/dependencies.
  - [ ] Retire unused diagnostic trace helpers and orphaned fixture measurements after checking all consumers.
  - [ ] Replace exhaustive metadata-matrix real sleeps with controlled clocks; retain real-timer controls.
  - [ ] Refresh OpenCode V2 dependencies to newest stable and correct theme attribution.
  - [ ] Put evidence-disclosure guidance near installation without adding UI notices or policy options.
  - [ ] Verify affected tests, helper inventory, typecheck and audit; commit.
- [ ] Phase 7: Final verification.
  - [ ] Run complete source/helper/typecheck/build checks.
  - [ ] Verify reproducible five-file package and built release smoke checks.
  - [ ] Run relevant real-TUI fixtures on latest stable OpenCode V2, serially.
  - [ ] Record exact results, inspect diff/status and commit final checklist.

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
