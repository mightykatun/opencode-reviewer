# Maintainer guide

## Setup and verification

- Use Node.js 24.15.0+ within 24.x (recommended), or 22.22.2+ within 22.x, and npm.
  These development floors differ from the distributed package's Node engine.
  Run commands from the repository root:

  ```sh
  npm ci --ignore-scripts
  npm run check          # typecheck -> TS tests -> pure .mjs helpers -> build
  npm run test:helpers   # no build, tmux or OpenCode
  npm run check:package  # two builds, reproducibility and actual archive checks
  ```

- Focus a source test with `npx tsx --test test/context.test.ts`; filter with
  `npx tsx --test --test-name-pattern='missing invocation path' test/context.test.ts`.
  `npm test` covers only `test/*.test.ts`. Add pure `.mjs` tests to
  `scripts/helper-tests.json`; host and built-package checks stay separate.
- Runtime/UI and host-integration changes need a relevant real-TUI fixture after
  `npm run build`. `node scripts/test-runtime.mjs --profile ci` runs the same
  representative pinned-host cases as PR CI. `npm run test:runtime` and
  `npm run test:runtime-permissions` retain their original family subsets.
  All runtime commands require a prior build; none implicitly rebuilds.
  Documentation-only changes need reference/format review, not runtime tests.
- Host fixtures require Linux, Git, Python 3, tmux and `opencode` on PATH;
  `OPENCODE_BIN` selects another binary. Limit concurrent hosts to two to avoid
  highlighting timeouts. Captures and requests go in ignored `.runtime/`.
- Fixtures use isolated HOME/XDG/project directories and local HTTP model servers.
  Create/restart tmux sessions through `scripts/smoke-runtime.mjs`'s supervisor;
  never kill shared/default tmux servers or clean up by broad process-name matching.
  `npm run test:runtime-cleanup` checks interruption/isolation without a build or model.
- `node scripts/test-runtime.mjs --list` lists all runtime entrypoints, scenarios,
  flags, valid-combination rules, prerequisites, and classifications.
  `node scripts/test-runtime.mjs --plan --profile ci` plans without OpenCode,
  tmux, a bundle, or fixture creation. Select one case with
  `node scripts/test-runtime.mjs smoke-streaming.mjs complete --stats`.
  The runner executes serially and reserves a repository-local runner lock;
  some fixtures themselves use two hosts. Do not run another host alongside it.
  An interrupted runner removes its lock; after SIGKILL, verify the recorded owner
  and its supervised hosts have exited before removing a stale runner lock.
- `scripts/runtime-inventory.mjs` is the authoritative CLI inventory. New fixture
  entrypoints/scenarios/flags must be registered and consume `runtimeArguments`.
  Normal helper checks enforce discovery and flag completeness. Profiles select
  exact combinations, not the Cartesian product of flags. Synthetic host probes,
  interactive desktop checks, historical replays, and helpers are separately
  classified. `audit-usage-history.mjs` requires the actual local `v0.7.0` tag.
- Use `smoke-observations.mjs` for fixture snapshot/control JSON: one serialized,
  coalesced atomic publisher per destination, explicit final flush/close, and
  `readObservation` for useful cross-process errors. Give concurrent hosts distinct
  observation destinations. Use `smoke-ui.mjs` for palette activation: selected
  result rendition must be painted and the caller must supply a postcondition.
  Preserve negative-observation windows that prove no execution or notification.
- Pure-helper additions must also be present with their transitive inputs in the
  release workflow's active-policy sparse checkout. Runtime results and exact
  invocation logs are under `.runtime/runtime-run-*/`; fixture captures stay in
  their documented `.runtime/` locations. PR CI uploads those synthetic artifacts.

### Focused host checks (build first)

| Area | Command |
| --- | --- |
| Basic review / automatic approval | `node scripts/smoke.mjs external` / `node scripts/smoke.mjs auto-shell` |
| Stream completion, usage and rendering | `node scripts/smoke-streaming.mjs complete --stats` |
| Truncation and exact-request retry | `node scripts/smoke-streaming.mjs truncated --static --stats` |
| MCP / directory-to-edit stages | `node scripts/smoke-permissions.mjs mcp --auto --correction --stream --stats` / `node scripts/smoke-permissions.mjs external-edit --auto --stream --stats` |
| Conversation enable/disable | `node scripts/smoke-session-mode.mjs` |
| Production history storage / browsing | `node scripts/smoke-history-storage.mjs` / `node scripts/smoke-history.mjs browse` |
| Approval behind production history | `node scripts/smoke-history-auto.mjs covered` |
| Approval-notification history selection | `node scripts/smoke-history-auto.mjs notification` |
| Fast approval, retained streams and live/history clicks | `node scripts/smoke-fast-mode.mjs complete` |
| Root-only display and normal/fast approval during subagent browsing | `node scripts/test-runtime.mjs --profile f34` |
| Native skills / resumed subagent context | `node scripts/smoke-skills.mjs root` / `node scripts/smoke-skills.mjs subagent` |
| Offline deletion reconciliation | `node scripts/smoke-history-maintenance.mjs` |
| Conversation/lifetime statistics | `node scripts/smoke-statistics.mjs` |
| Notification queue | `node scripts/smoke-notification-queue.mjs main --stream` |

- Read each fixture's scenario/flag parsing for other cases. `smoke.mjs` and
  `smoke-permissions.mjs` support `--plan` without a host or bundle. For
  `external-edit`, `--disabled` disables directory review, not edit review;
  `--held` applies to the first enabled stage.
- Generic fixtures disable notifications. Notification fixtures isolate process I/O;
  they do not prove audible playback, GNOME focus, live-model judgment or provider
  latency. `npx tsx scripts/smoke-notification-desktop.ts --sounds` is an actual
  local playback check. Report exact fixture runs rather than full-matrix coverage.

## Host and build boundaries

- Verified target: local Linux OpenCode **1.18.35**, pinned in the manifest and SDK.
  Newer host versions require separate compatibility verification.
  Use public `@opencode-ai/plugin/tui` APIs/slots, never private UI imports or native
  approval-dialog patches.
- Package and plugin ID are `opencode-reviewer`. `src/tui.tsx` exports the default
  `{ id, tui }` module; package `exports["./tui"]` points to `dist/tui.js`.
  Install/configure the npm package in `tui.json`; permission rules go in
  `opencode.json`. Source/built-in prompt changes require build plus host restart;
  config/custom prompt changes require restart.
- `scripts/build.mjs` uses Solid's **universal OpenTUI** JSX transform, not React or
  Solid DOM. TypeScript only checks types. The ESM bundle leaves Solid/OpenTUI/OpenCode
  external and embeds prompts, sounds, the MP3 decoder and a CJS history worker.
- Preserve exactly five package files: `dist/tui.js`, `package.json`, `README.md`,
  `LICENSE`, `THIRD_PARTY_NOTICES.md`. `dist/` is generated and ignored. `npm pack`
  rebuilds via `prepack`; verified CI packing uses `--ignore-scripts`.
- Never use em dashes. Fixed interface copy belongs in `src/ui-text.ts`, using named
  strings/typed formatters and labels that fit the 42-column sidebar. Behavioral
  tests keep independent expected wording. Model guidance belongs in `prompts/`;
  fixed contracts belong in `contracts/`, both inventoried by `src/prompt-files.json`.
  Preserve `{{validationError}}` in the correction contract. Keep README focused on
  npm installation, one full config example and user behavior, without release history.
- Never add UI warnings or disclaimers about version upgrades, history save-format
  changes, or missing pre-feature history, even after a breaking history-storage
  change. Handle migration and compatibility internally without such UI notices.

## Execution flow and invariants

- Start at `src/tui.tsx`: `controller.ts` owns lifecycle/visibility, `session-mode.ts`
  gates work before enrichment, `evaluate.ts` dispatches through `classification.ts`
  and `context.ts` to evidence collectors, and `reviewer.ts` owns model transport.
  Defaults/validation live in `config.ts`; shared evidence shapes live in `types.ts`.
- The plugin is advisory unless `autoApprove` is enabled. `approval.ts` exposes only
  `once` in the invocation host directory, never the tool workdir. Do not add
  `always`/`reject`, permission-rule writes, command execution or edit application.
- Deduplicate by permission-request ID, not tool call. Directory and operation
  permissions are separate reviews; directory approval can resume an operation
  without another prompt. Native-looking permission names do not prove origin:
  custom tools can request `bash`, and MCP identity must not be guessed by splitting
  names. Disabled kinds still block native ordering while skipping review work.
- The visible request is the root's first pending permission, including direct
  children, unless an already-approved fast report is still finishing. Conversation
  mode covers **all** descendants within the host scope.
  Unknown ancestry/unreadable saved mode suspends work. Local enable/disable commands
  must not create messages or model calls. Re-enable uses a fresh pending snapshot
  and must preserve canceled/uncertain-approval tombstones until native resolution.
- F34's root-only presentation and same-root route exception below govern both
  normal and fast mode. See `AUDIT.md`'s "F34 confirmed replacement contract" and
  implementation disposition for scope, acceptance checks and verification.
- Normal auto-approval needs a completed, validated Safe assessment. Final Markdown
  highlighting and a matching painted frame are required outside the F34 same-root
  descendant-route exception. Only opt-in `fastMode` with `autoApprove` may approve
  a parsed Safe preview; physical visibility is required outside that same exception.
  Fast mode retains native queue priority, no countdown and no history-cover exception,
  and respects `stream: false`. Recheck fresh permission identity/scope, native priority
  and presentation or the explicit route exception before the single-flight write.
  Never retry approval writes; uncertain outcomes remain manual.
- Cancel or genuine visibility loss outside the F34 route exception after countdown
  start permanently makes that request manual for the running controller, including
  across remounts/re-enable. Scrolling and same-root descendant navigation must not
  cancel it. Native resolution removes ordinary views immediately. Dispatched
  fast reviews retain the response through confirmation, then continue despite mode
  disable or navigation until completion/failure; deletion/disposal still aborts them.
  Use `pendingViews` for notifications/order so retained reports are not native blockers.
  Retain revision guards in `pending-refresh.ts`.
- Observe `sidebar_content`, render via `app`, and retain one stable slot root with
  live/history siblings; key the live panel by request ID. Changing fragments/view-object
  keys can remount Markdown and reset scrolling/countdowns. Reveal a hidden sidebar
  only for an explicit approval-notification click, using the public native command.
  Render the entire reviewer side panel, including live, retained and history views,
  only on the top-level conversation route. Direct and nested descendant routes must
  show no reviewer side panel at any terminal width. Keep physical presentation and
  native queue selection separate; descendant navigation does not grant approval
  ownership to deep-only requests absent from the root's native queue.
  Sanitize report text and streamed prefixes through `displayText`.
- F34 intentionally hides the panel on known same-root descendant routes while both
  normal and fast automation continue, including newly eligible reviews. Normal
  countdowns preserve their monotonic deadline and one-time grace; reports completing
  while route-hidden start the configured delay without waiting for a panel paint.
  Fast mode retains its configured preview/full-response behavior without a countdown
  or fallback to normal mode. Returning to root must not re-review, restart timers,
  rearm canceled requests or resurrect completed reports. Verify route ancestry and
  native priority independently of panel mounting; never fabricate visible IDs, FRAME
  events, hit-test proof or history cover to implement the exception.
- The F34 exception applies only to intentional same-root route suppression. Unknown
  or unrelated ancestry, explicit sidebar hiding, native dialogs/fullscreen covers,
  native-priority loss, mode gates, Cancel, deletion and disposal retain their existing
  blocking/cancellation semantics. Route changes cannot erase an earlier cancellation
  or uncertain-write tombstone.
- Production history remains the normal-mode physical-cover exception, separate from
  F34 route suppression. Preserve `history-cover.ts`'s actual heading/footer hit-test
  proof; logical open state is insufficient. Native palette/dialog coverage still
  cancels countdowns, and opening history afterward cannot revive them. Fast mode
  gains no history-cover exception. Native Always/reject forms are not public dialogs,
  so users must explicitly Cancel before using them.

## Evidence and transport traps

- Resolve relative tool `workdir` against the invocation's `path.cwd`, never the
  stored session directory. Keep missing invocation location unknown. Read registered
  project metadata without initializing a host in the command-target directory.
  Use the latest genuine **root** user prompt, not a delegation brief; a newer
  attachment-only message must not fall back to older text.
  For subagents, all evidence kinds additionally carry the immediate delegation
  from the invocation assistant's `parentID` user message, with exact session/message
  ownership. Keep it separate from root intent; no older, sibling or queued follow-up
  substitution. Omit whole delegation text over 64 KiB with a factual limitation.
- Shell discovery is bounded literal tokenization, never shell evaluation, PATH
  lookup, substitution execution or recursive import/task-runner inspection. Shell
  snapshots may follow symlinks outside the project. Edits use pending host diffs,
  not full target reads. MCP/custom/directory evidence uses the public host catalog,
  not direct MCP calls, module imports or target-file reads.
- `reviewSkills` defaults true. Native skill origin and exact name/scope must match
  before `app.skills` lookup. Main instructions come from the host catalog snapshot,
  not a fresh SKILL.md read, and are mandatory evidence. Supporting files are direct
  literal references only, confined to the skill directory, including opened-descriptor
  checks against ancestor-symlink swaps. Never recurse, execute, fetch URLs, or substitute
  the workdir for built-in skills' missing directory. Count the main skill in `maxFiles`.
  Skill Safe requires bounded risk **and** task relevance; custom tools asking for
  `skill` permissions retain custom-tool semantics.
- Preserve exact mandatory scope/arguments or fail analysis. Omit whole optional
  files/diffs/definitions with factual reasons; do not truncate commands, invent
  missing line counts or synthesize ratings. Partial evidence alone is not an
  automatic-approval veto. Proposed `always` patterns are not existing grants.
- `deadline.ts` shares one budget across context, files, HTTP and corrections.
  Timeouts do not prove I/O stopped: retain actual transaction ownership through
  settlement/cleanup in `file-access.ts`, mode/history reads and notification work.
  Parent aborts must not become optional evidence omissions.
- `streaming-assessment.ts` validates both transport modes against exactly
  `{ "safe": boolean, "desc": "nonempty text" }`, rejecting duplicate keys.
  SSE success requires `stop`, `[DONE]` and body EOF, not just a closing JSON brace.
  Preserve terminal usage even for rejected assessments where framing permits it.
- `transport-retry.ts` permits at most two extra POSTs across the review. Transport
  retries regenerate the identical request; format corrections retain exact prior
  history plus the failed response/feedback. Clear rejected previews, never merge
  streams, extend the deadline, shorten Retry-After or raise `maxOutputTokens`.
  Keep evidence as data, not instructions; do not add automation metadata/notices
  to either model's conversation.

## Persistence, accounting and notifications

- `history-coordinator.ts` joins reviewer attempts and controller facts. Unresolved
  report text stays in memory; only qualifying `permissionResolved` events persist
  it. Native `once` events lack submitting-client identity: absence of a local write
  or a keypress does not prove manual approval. Ambiguous attribution omits the body.
  Fast approval records identity/confirmation before final assessment; only final
  validated text is saved. Keep retries/deadline unchanged and close the retained
  panel on completion, allowing saves to finish in the background. Failed remainders
  produce no report entry; received usage and confirmed approvals still count.
- `history-v1.sqlite` uses the embedded worker with Bun SQLite in the host and Node
  SQLite in tests. Lifetime reads use precomputed totals only; leave `usage-v1/`
  through `usage-v4/` untouched. `history-statistics.ts` applies deduplicated deltas
  to lifetime/conversation totals transactionally. Conversation baselines may use
  attributable old rows; lifetime must never be reconstructed from detail rows.
  Deleting details must not reduce accumulated totals.
- History/statistics resolve ancestry through `HistoryCoordinator.root`, not the
  review-mode load gate, so disabled/invalid review can still browse. Use indexed
  selection and `HistoryRefresh`, retaining `HistoryRead.settled` ownership after
  caller timeout. Drain usage finalizers/storage within 3.5 seconds of lifecycle abort.
- Approval-notification clicks carry the original permission/session identity. Wait
  for native dialogs to close, then recheck for its unfinished fast report before
  selecting the exact scoped history entry, not newest. Confirmed approval notifies
  immediately, not after report completion; never replay attention for retained reports.
  Keep the five-second save wait hidden; missing/deleted reports leave only the
  conversation open. New clicks, route changes and disposal invalidate late work.
- Deletion maintenance must validate the exact pinned `session.get` 404 envelope
  and requested ID in `history-maintenance.ts`; list omissions, bare 404s and read
  failures are not absence. Preserve root-first cascading and the revisioned
  maintenance-dirty publication gate until a complete healthy reconciliation.
- Usage is per POST, including failed/interrupted attempts. Cumulative frames replace
  values rather than add them. Token and cost coverage are independent; unknown is
  not zero. Exact normalized OpenRouter endpoint costs use reported `usage.cost`
  only; other endpoints use matching host-catalog estimates, never billing requests.
  Count reviews on final controller acceptance and retries on actual dispatch.
- Notification eligibility comes from new events, not startup snapshots or history
  browsing. Follow native blocker ordering even for silent/disabled requests.
  Initial permission/question banners and sounds, as well as reminders, require
  front-of-queue ownership. Queue loss aborts pending delivery; queued resolution
  must never replay an alert. Handoff sends the eligible initial notification,
  then waits a full reminder interval.
  Safe auto-enabled requests awaiting queue position/rendering/countdown stay silent;
  elapsed time is not proof they need manual attention. Countdowns are silent and
  approval sounds require confirmed automatic success. Keep delivery off approval
  critical paths and use owned fixed-purpose processes, never a shell.
- Observer, accounting and persistence failures must not change review/approval.
  `withDiagnostics` and other `with*` exports are fixture/embedding seams, not config
  options. Diagnostics contain fixed phase labels, timings and local numeric
  correlations only, never prompts, IDs, paths, credentials or model output.

## Releases

- Update both manifests with `npm version X.Y.Z --no-git-tag-version`. The release
  workflow runs on pushed `v*` tags or manual dispatch from the default branch with
  an existing tag. Tag commit and canonical version must match the manifests;
  build metadata is rejected. Creating a GitHub release is not a trigger.
  Package-wide concurrency uses `queue: max` with cancellation disabled, retaining
  up to 100 pending runs. Overflow is canceled; channel safety still uses SemVer.
- Keep the read-only validation and privileged publication jobs separate. Publish
  the exact verified archive, using policy helpers from `github.workflow_sha`;
  never build/install project dependencies or run package code in the publish job.
  npm 12.2.0 uses OIDC with optional `NPM_TOKEN` fallback and a private job cache.
  Explicit provenance binds archive SHA-512 and tag source separately from policy
  commit and validation/signing attempts. Its pinned npm Sigstore toolchain signs
  in a 120-second child, then npm verifies `--provenance-file` before upload.
  Never substitute GitHub trigger identity or fall back to unsigned publication.
  Keep signing bundles outside the artifact directory and TUF's `XDG_DATA_HOME`
  inside the private job cache. Offline tests replace signing/crypto/network
  boundaries; they must never request real OIDC tokens or transparency-log writes.
  Uploads never retry. Existing versions verify immutable bytes without retagging;
  channel advancement follows SemVer in `scripts/npm-publication.mjs`.
- npm can accept an upload long before registry availability. Read-only publication
  verification waits up to 60 minutes; keep the publish job's 75-minute timeout
  above that budget. Never bypass archive verification or republish to fix a delay.
- Release policy tests are in `npm run test:helpers`. After a build, run
  `node --test test/release-artifact-smoke.test.mjs`; with npm 12.2.0, also run
  `node --test test/npm-cli-smoke.test.mjs`. Neither publishes. Keep workflow actions
  pinned to verified commit SHAs and the active-policy sparse checkout complete.
