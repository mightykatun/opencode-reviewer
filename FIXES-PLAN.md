# Review fixes implementation plan

## Execution checklist

- [x] 1. Read the complete plan and identify completed work.
- [ ] 2. Read the files required by each phase before editing them.
- [x] 3. Derive concrete ordered implementation tasks and success criteria.
- [ ] 4. Implement phases sequentially and commit verified work.
- [ ] 5. Run each phase's checks and resolve failures before proceeding.
- [ ] 6. Update this plan as each item is verified.
- [ ] 7. Record and escalate only unresolved mismatches.

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

- [ ] Repair the resolved Seroval override and assert clean-install resolution.
- [ ] Narrow unnecessary theme dependency bundling where the public API permits it.
- [ ] Include all notices required by retained bundled dependencies.
- [ ] Verify clean installation, dependency audit, helpers and reproducible five-file package.
- [ ] Commit verified phase and record evidence.

## Phase 3: approval, history input and statistics recovery

- [ ] Preserve Cancel through native preparation and publish Allowing only after dispatch.
- [ ] Separate mouse-independent keyboard browsing from strict approval-cover proof.
- [ ] Retry transient Conversation ancestry failures with bounded coalesced ownership.
- [ ] Correct the live-panel mount/scroll comment.
- [ ] Add independent regression tests for each behavior.
- [ ] Verify focused tests, build and relevant installed V2 fixtures.
- [ ] Commit verified phase and record evidence.

## Phase 4: evidence completeness and large-record boundaries

- [ ] Represent missing declared edit previews as incomplete evidence at both boundaries.
- [ ] Bound RPC envelopes separately from independently owned components.
- [ ] Reduce repeated normalization/canonicalization of validated immutable records.
- [ ] Add missing-preview, aggregate-boundary, exact-linkage and cancellation regressions.
- [ ] Verify focused tests, build and production invocation/evidence fixture.
- [ ] Commit verified phase and record evidence.

## Phase 5: notification coherence and approval transaction ownership

- [ ] Reproduce or resolve stale notification health during scoped event invalidation.
- [ ] Prune only safely resolved and physically settled approval reservations.
- [ ] Extract explicit approval transaction ownership without changing dispatch invariants.
- [ ] Add delayed-delivery, churn, successful cleanup and uncertain-retention tests.
- [ ] Verify focused approval/notification tests, build and relevant V2 fixtures.
- [ ] Commit verified phase and record evidence.

## Phase 6: production coverage and fixture structure

- [ ] Split reusable V2 review driving/observation code from scenario assertions where useful.
- [ ] Add automatic native edit and directory-to-edit continuation cases.
- [ ] Verify exact replies, applied changes, saved history and statistics for both cases.
- [ ] Add manual attention handoff, form lifecycle and reminder cancellation cases.
- [ ] Add execution terminal distinctions and unavailable-review notification-only coverage.
- [ ] Register cases, preserve classifications and include active-policy helper dependencies.
- [ ] Verify helper inventory and run each new stock-V2 production case.
- [ ] Commit verified phase and record evidence.

## Phase 7: final verification

- [ ] Run npm run check.
- [ ] Run npm run check:package and built archive/provenance smoke tests.
- [ ] Run the current V2 CI profile including registered new acceptance cases.
- [ ] Review documentation, notices, plan evidence and git diff.
- [ ] Commit the final verified plan and report exact acceptance limits.

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
