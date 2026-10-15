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

- Focus a source test with `npx tsx --test test/host-context.test.ts`; filter with
  `npx tsx --test --test-name-pattern='latest empty/attachment user' test/host-context.test.ts`.
  `npm test` covers only `test/*.test.ts`. Add pure `.mjs` tests to
  `scripts/helper-tests.json`; host and built-package checks stay separate.
- Runtime/UI and host-integration changes need a relevant real-TUI fixture after
  `npm run build`. `node scripts/test-runtime.mjs --profile ci` runs the current V2
  41-case production/foundation selection available in manual extended checks,
  including history, statistics, approval notifications and explicitly classified
  synthetic probes.
  `npm run test:runtime` selects `--profile v2-acceptance`, which currently selects
  the same cases. These profiles do not prove real desktop/audio acceptance.
  `npm run test:runtime-permissions` selects `--profile v2-permissions` for V2
  invocation/evidence and native edit/outside-directory continuation cases.
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
  `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-history`.
  The runner executes serially and reserves a repository-local runner lock;
  some fixtures themselves use two hosts. Do not run another host alongside it.
  An interrupted runner removes its lock; after SIGKILL, verify the recorded owner
  and its supervised hosts have exited before removing a stale runner lock.
- `scripts/runtime-inventory.mjs` is the authoritative CLI inventory. New fixture
  entrypoints/scenarios/flags must be registered and consume `runtimeArguments`.
  Normal helper checks enforce discovery and flag completeness. Profiles select
  exact combinations, not the Cartesian product of flags. Synthetic host probes,
  interactive desktop checks and helpers are separately classified.
- Use `smoke-observations.mjs` for fixture snapshot/control JSON: one serialized,
  coalesced atomic publisher per destination, explicit final flush/close, and
  `readObservation` for useful cross-process errors. Give concurrent hosts distinct
  observation destinations. Use `smoke-ui.mjs` for palette activation: selected
  result rendition must be painted and the caller must supply a postcondition.
  Preserve negative-observation windows that prove no execution or notification.
- Pure-helper additions are covered automatically by the release workflow's full
  active-policy checkout. Keep privileged publication's policy checkout restricted.
  Runtime results and exact invocation logs are under `.runtime/runtime-run-*/`;
  fixture captures stay in their documented `.runtime/` locations. Manual extended
  checks upload those synthetic artifacts.

- Source tests use two concurrent files. Keep this bound: timing-sensitive shell
  discovery and history-watchdog tests should not compete with dozens of workers.
  Preserve their actual budgets and assertions rather than increasing time limits.

### Focused V2 host checks (build first)

Always develop and verify against the latest stable OpenCode V2 (`2.x`) release.
Do not pin OpenCode to a particular patch/minor release or add a host-version
allowlist. CI resolves the newest stable V2 once per run, verifies npm archive
integrity, and records the exact resolved version. Set `OPENCODE_BIN` to that
stock release for local checks. Keep lockfiles for reproducible dependency installs,
but refresh OpenCode dependencies to the latest stable V2 when doing development.
All commands below use the installed five-file archive and production runtime.

| Area | Command |
| --- | --- |
| Initial connection / delayed native marker echo | `node scripts/test-runtime.mjs smoke-v2-lifecycle.mjs cold-startup` |
| Native skill loading / fast skill approval | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-skill` / `fast-skill` |
| Shared registered-tool review / fast approval (local MCP) | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-tool` / `fast-tool` |
| Advisory / normal / fast review | `node scripts/test-runtime.mjs smoke-v2-review.mjs advisory` / `normal` / `fast` |
| Saved history and statistics | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-history` |
| Unsafe history after native Once / Always / reject | `node scripts/test-runtime.mjs smoke-v2-review.mjs advisory-history-once` / `advisory-history-always` / `advisory-history-reject` |
| Default HOME with writable host state | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-history-default-home` |
| Keyboard history with mouse disabled | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-history-keyboard-mouse-off` |
| Automatic native write / outside-directory continuation | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-edit` / `normal-directory-edit` |
| Manual attention handoff and reminders | `node scripts/test-runtime.mjs smoke-v2-notifications.mjs manual-handoff` |
| Native question form / terminal execution distinctions | `node scripts/test-runtime.mjs smoke-v2-notifications.mjs forms` / `execution` |
| Invalid review and unavailable companion notification-only fallback | `node scripts/test-runtime.mjs smoke-v2-notifications.mjs unavailable-review` |
| Normal/fast approval behind history | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-history-cover` / `fast-history-cover` |
| Approval notification and exact history click | `node scripts/test-runtime.mjs smoke-v2-review.mjs fast-notifications` |
| Descendant background approval | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-descendant` / `fast-descendant` |
| Mouse-disabled approval / explicit Cancel | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-mouse-off` / `normal-cancel` |
| Home/dashboard/unrelated route waiting | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-route-wait` |
| Native decision waiting without cancellation | `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-decision` / `fast-decision` |

Notification fixtures isolate process I/O and inject the desktop backend. They do
not prove actual audio playback, GNOME focus, live-provider judgment or provider
latency. Behavioral review/notification fixtures activate through public CLI
configuration after observing an owned prompt-free probe's exact native birth and
deletion on the connected event stream. They do not prove pre-connection startup;
the separate lifecycle fixture checks startup using an independently observed
public connection marker. Native echoes may precede observer registration; any
delivered echo must match that actual admitted marker. Reconnect still revokes an active
generation, including notification-only fallback. Fixture-owned public memory
retains actual observations and consumed controls across CLI plugin reloads; it
cannot supply events or override production behavior.
Connection barriers may retire missed prompt-free startup probes and create fresh
owned probes within the same 60-second budget. Admission still requires the exact
chosen probe's real native birth and deletion; snapshots or sibling events never
substitute for either observation.
`npx tsx scripts/smoke-notification-desktop.ts --sounds` is an actual local
playback check. Report exact fixture runs rather than full-matrix coverage.
History fixtures use a new private state directory under sticky `/tmp` because
`/tmp/opencode` can be group writable; never weaken SQLite ancestor checks or chmod
existing user directories.

## Host and build boundaries

- The shared V2 lifecycle entrypoint targets local Linux OpenCode V2.
  On 2026-10-13 the user explicitly rejected a runtime host-version allowlist.
  Do not gate activation, companion admission or evidence reads on version numbers.
  Preserve protocol/location/epoch, mandatory evidence and approval eligibility checks;
  incompatible public API data stays manual rather than being guessed. Development
  and CI target the latest stable V2, not a fixed host release. Development uses V2
  ranges for `@opencode/plugin`, `@opencode/client` and
  `@opencode/theme`. OpenTUI is 0.5.17 and Solid is 1.9.15, matching the host.
  Use public APIs/slots, never private UI imports or native approval-dialog patches.
- Package and plugin ID are `opencode-reviewer`. The build starts at `src/plugin.ts`;
  its shared V2 setup selects companion/CLI lifecycle without eager terminal runtime imports.
  Package exports `.`, `./server` and `./tui` all point to `dist/tui.js`.
  V2 setup uses server `opencode.json` plus global `cli.json`, with permission rules
  only in `opencode.json`. Source/built-in prompt changes require build plus host
  restart; config/custom prompt changes require restart.
- `scripts/build.mjs` uses Solid's **universal OpenTUI** JSX transform, not React or
  Solid DOM. TypeScript only checks types. The ESM bundle leaves Solid/OpenTUI/OpenCode
  external and embeds prompts, sounds, the MP3 decoder, the reviewed theme helper
  and a CJS history worker. Terminal code is an opaque base64 CJS payload loaded
  only in the CLI role, with fixed public-module mappings. Sounds and worker source
  are single fixed outer mappings injected into the payload; the Linux/audio backend
  is bundled only there. The notification-process embedding factory is forwarded
  as a dependency and constructed only by that CLI backend, never by the server.
  `bundled-history-worker.mjs` inspects AST/data to prove both actual worker
  consumers and the fixed loader reference the same source. Its helper tests and
  dependencies must remain in active release-policy validation's sparse checkout.
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

### Same-conversation automation

- On 2026-10-13 the user replaced V2 visible-root approval with same-conversation
  automation, without an additional opt-in. Panel display remains root-only, but
  normal and fast approval need no report paint, hit ownership, mouse or sidebar.
  Known same-root descendants, selectors/dialogs, session panels and history do not
  gate approval. Home/dashboard/unrelated or unknown routes wait, never cancel.
- Stock V2's root native queue includes the full descendant family, root first and
  then public family order. Use actual native ownership, not event-arrival order.
  Reconcile native permission caches after interruption; fresh server reads alone
  do not refresh a stale native prompt.
- Started normal countdowns retain their original monotonic deadline through UI,
  native-priority and pre-write read/cache waits. Expired waits resume without a
  fresh delay. Never-armed requests start a full countdown when their conversation
  first becomes eligible, including while the report is hidden. Only explicit
  Cancel/disable/native stop actions cancel; remount/re-enable cannot erase those
  tombstones. Changed evidence and uncertain writes stay failed/manual, never retried.
- Hold approval while native Always/reject choices or rejection editing are active.
  Observe bounded public renderable IDs and choice colors, not private host state,
  dialog patches or text matching. Partial/ambiguous decision observations wait
  closed. Recheck same-conversation ancestry, native priority and decision state
  synchronously immediately before the once write. Ordinary modal mode is not a hold.
- Preserve fast preview/full-response behavior, no countdown, fresh identity/native
  priority checks and once-only writes. Retained responses may finish while hidden.
  Hidden reports save through ordinary qualifying history resolution, with no UI
  dependency. Browsing production history does not gate approval.
  Do not force mouse/sidebar visibility or fabricate presentation proof. Additional
  native fullscreen/family/multi-terminal permutations remain separate acceptance.

### Evidence admission

- The user selected native Code Mode on 2026-10-12. Do not ship the investigated
  direct-tool transform or remove native Code Mode search. Exact direct-call
  linkage is usable; ambiguous nested calls stay manual. Never recover their
  identity by arrival order, JavaScript parsing or forced serialization.
- The user accepted a trusted native-tool installation: installed plugins preserve
  native tool meanings, do not replace/alias native executors, and do not rewrite
  commands after evidence capture. This is an installation assumption, not public
  host provenance or an enforceable registry seal. Preserve exact scope, source,
  native-priority, same-conversation eligibility and once-only write checks. Do not
  extend this native-tool assumption to unavailable skill/MCP/custom origin or
  catalog evidence; registered tools use the separate accepted assumption below.
- On 2026-10-14 the user explicitly selected automatic native skill review using
  the current scoped registered main instructions, accepting that the selected
  definition stays unchanged while its permission is pending. This bounded
  installation assumption is not global catalog immutability or an API snapshot
  guarantee. Retain exact ID/source/scope/epoch and once-only approval checks;
  missing, ambiguous or oversized complete main instructions stay manual. Read the
  registry only through the scoped server companion, never fresh SKILL.md files.
  Supporting files are optional and currently omitted factually. Do not add a
  speculative revision-guard subsystem. MCP/custom tools use their separately
  accepted registered-definition assumption, not this native skill assumption.
- The user approved the shared server companion plus global CLI setup, factual
  omission of unavailable optional immediate delegation, and retention of history
  when offline deletion ownership is unproven. Preserve root intent and mandatory
  operation evidence. Exact live deletion events require proven connection/scope;
  a random storage token, pathname or bare 404 is never deletion authority.

### Current V2 runtime

- Start at `src/plugin.ts`: the server companion captures exact direct invocation
  evidence; `cli-plugin.ts` validates options and the companion handshake;
  `host-runtime.tsx` connects the generic controller to native queues and slots.
  `host-evaluate.ts` uses `host-evidence-reader.ts` and `host-reader.ts` to bind exact
  requests/invocations, `host-evidence.ts` for server-only operation collection and
  `host-context.ts` for public conversation context.
  Full evidence reads prepare and bind before collection, then finalize native
  identity/companion epoch once after validation; standalone invocation reads also
  finalize. Strict host JSON copying shares bounded traversal with collector copies
  while retaining its descriptor/proxy policy and independent RPC component caps.
  A session can acquire a Git project ID while the companion's captured setup
  project stays `global`. `host-project.ts` resolves mismatched attribution using
  only the connected server's registered project/checkout inventory. Keep that
  attribution separate from the immutable invocation; never discover a tool-target
  location or change its source, arguments, workspace, epoch or captured directory.
  Missing/ambiguous/foreign inventory stays manual, and finalization rechecks the
  exact session project after collection. Thrown evidence failures remain visible
  as Analysis unavailable without model calls or permission writes.
- `controller.ts` owns V2 request lifecycle, evaluation, cancellation and approval;
  `session-ancestry.ts` owns bounded metadata traversal and actual read settlement;
  review and history share a scope-pinned instance without sharing saved-mode admission.
  `session-mode.ts` gates work before enrichment, and `host-mode-commands.ts`
  registers local native palette/slash commands. `reviewer.ts` owns model transport.
  Defaults/validation live in `config.ts`; `host-types.ts` defines native requests,
  invocation snapshots and scope, and `types.ts` defines shared review data.
  `embedding-types.ts` defines opt-in UI observations and notification backend seams,
  never approval overrides or configuration options.
- `host-permissions.ts` allows only scoped native `once` replies. Dispatch,
  acknowledgement and matching native resolution are distinct facts. Confirmation
  requires both the native acknowledgement and exact scoped resolution, not a keypress,
  vanished prompt or successful submission alone. Uncertain writes stay manual and
  are never retried. Reconnect closes the old controller;
  restart/reload is required rather than mixing old clients with new caches.
- CLI startup consumes the public client's current `server.connected` marker before
  dispatching the first companion RPC, including when setup begins after connection.
  Ignore the native data bridge's delayed echo only for that exact public event ID;
  a distinct marker still fences startup and permanently revokes an active generation.
  Own subscriber abort/return settlement; it never substitutes for scope/protocol/epoch
  checks or replays business events. Connection waiting and startup handshakes recover
  within one 10-second budget: 1.5-second
  attempts, 250 ms backoff, timeout/`rpc.unavailable` only. Own physical settlement
  before retry; fence pre-admission connection changes. Invalid replies stay manual.
  Choose runtime/fallback once, never promote fallback or revive an active generation.
- `host-history-runtime.tsx` owns the indexed worker, history, totals and shutdown.
  History/statistics also initialize when review configuration or the companion is
  unavailable. The absolute V2 namespace is an index, not deletion authority.
  Known live deletions invalidate volatile facts only; persistent deletion is not
  enabled. Keep old rows/totals untouched; offline absence without ownership proof
  never authorizes deletion.
- `host-notifications.ts` uses the generic policy and Linux backend. Event births,
  native family/form ordering and confirmed automatic success govern delivery.
  Snapshot reconciliation is silent. Clicks carry the original request identity,
  suppress history while its fast report remains unfinished and select only its
  exact saved entry. Only an explicit click may reveal an actually absent sidebar.
  `host-notification-runtime.ts` keeps manual attention active when review configuration
  or the companion is unavailable, without a second UI surface, model calls or replies.
  Optional form reads must stay outside permission admission; own their complete
  transactions through abort/settlement, and fail notification health closed on errors.
- `host-native-observations.ts` refreshes roots/seeds before reading native family
  rosters, then all member metadata before ancestry validation. Permission and form
  callers retain separate budgets and health. `host-queue.ts` keeps early native
  priority separate from complete unknown/empty/front notification observations.
  Native reactive caches supply public identities, never mandatory operation evidence.
- `host-sidebar.tsx` measures native FRAME geometry; `host-review-panel.tsx` and
  `host-history-view.tsx` prove actual hit ownership for UI/fixture observations,
  not V2 approval eligibility. `host-approval-ready.ts` owns the public native
  decision/same-conversation gates. One stable app surface contains live/history siblings.

### Review lifecycle and UI

- The plugin is advisory unless `autoApprove` is enabled. Approval exposes only
  native `once` in the captured invocation host scope, never the tool workdir. Do not add
  `always`/`reject`, permission-rule writes, command execution or edit application.
- Deduplicate by permission-request ID, not tool call. Directory and operation
  permissions are separate reviews; directory approval can resume an operation
  without another prompt. Native-looking permission names do not prove origin:
  custom tools can request native-looking actions, and MCP identity must not be
  guessed by splitting names. Disabled kinds still block native ordering while
  skipping review work.
- The live request follows the root's native front-of-queue permission, including
  its full descendant family, unless an already-approved fast report is still
  finishing. Conversation mode covers **all** descendants within the host scope.
  Unknown ancestry/unreadable saved mode suspends work. Local enable/disable commands
  must not create messages or model calls. Re-enable uses a fresh pending snapshot
  and must preserve canceled/uncertain-approval tombstones until native resolution.
- Normal auto-approval needs a completed, validated Safe assessment. Final Markdown
  highlighting and painted frames are UI observations only. Only opt-in `fastMode`
  with `autoApprove` may approve a parsed Safe preview. Fast mode retains native queue
  priority, no countdown and respects `stream: false`. Recheck fresh permission
  identity/scope, native priority, same-conversation ancestry and native decision
  state before the single-flight write. Positive normal countdowns include one
  200 ms initial grace; zero skips the delay without skipping approval checks.
  Never retry approval writes; uncertain outcomes remain manual.
- Explicit cancellation permanently makes that request manual for the running
  controller, including across remounts/re-enable. UI visibility, scrolling and
  navigation do not cancel it. Native resolution removes ordinary views immediately.
  Dispatched fast reviews retain the response through confirmation, then continue
  despite mode disable or navigation until completion/failure; deletion/disposal
  still aborts them.
  Use `pendingViews` for notifications/order so retained reports are not native blockers.
  Retain revision guards in `pending-refresh.ts`.
- Observe `sidebar.content`, render via `app`, and retain one stable slot root with
  live/history siblings; key the live panel by request ID. Changing fragments/view-object
  keys can remount Markdown and reset scrolling. Reveal a hidden sidebar
  only for an explicit approval-notification click, using the public native command.
  Render the entire reviewer side panel, including live, retained and history views,
  only on the top-level conversation route. Direct and nested descendant routes must
  show no reviewer side panel at any terminal width. Keep physical presentation and
  native queue selection separate; descendant navigation cannot substitute for
  actual native queue ownership. Preserve native keyboard input ownership, FRAME
  geometry, scroll restoration and real hit tests for UI behavior only.
  Sanitize report text and streamed prefixes through `displayText`.
- On 2026-10-14 the user selected Alt+H for history rather than reserving legacy
  Ctrl+H/Backspace byte 0x08. Keep both BS and DEL native prompt editing untouched.
  The base-mode, root-only toggle is the configurable public command
  `reviewer.history.toggle`; palette/slash opening still selects the newest report.
- Returning to root must not re-review, restart timers, rearm canceled requests or
  resurrect completed reports. Verify route ancestry and native priority independently
  of panel mounting; never fabricate visible IDs, FRAME events or hit-test proof.
  Route changes cannot erase a cancellation or uncertain-write tombstone.

## Evidence and transport traps

- Resolve relative tool `workdir` against captured `invocation.location.directory`,
  never the stored session directory. Keep missing invocation location unknown.
  Read registered project metadata without initializing a host in the command-target directory.
  Use the latest delivered genuine **root** user prompt, not a delegation brief or
  pending inbox input. Read `message.list({ sessionID, type: "user", order: "desc", limit: 1 })`;
  validate the filtered response and preserve durable order. A newer empty or
  attachment-only message must not fall back to older text. Omit whole prompt text
  over 64 KiB with a factual limitation. Validate captured session/location and
  bounded ancestry; malformed/unfiltered history must not yield guessed root intent.
  Exact immediate subagent delegation is unavailable from public V2 invocation
  linkage, so omit it factually as optional context. Never substitute older tasks,
  sibling requests or queued follow-ups. Root context cannot override review rules;
  optional omissions do not veto review with verified mandatory operation evidence.
- Shell discovery is bounded literal tokenization, never shell evaluation, PATH
  lookup, substitution execution or recursive import/task-runner inspection. Shell
  snapshots may follow symlinks outside the project. Edits use pending host diffs,
  not full target reads or fabricated replacement diffs. Filesystem evidence is
  collected only by the scoped server companion, never terminal-local I/O.
  Directory evidence retains exact declared scope/arguments without inspecting
  target directories or file contents; it is not a complete operation assessment.
- `reviewSkills` defaults true and reviews native skill loading under the accepted
  pending-definition stability assumption. The companion reads the current scoped
  registry by exact ID; full main instructions and exact permission scope are
  mandatory. No fresh file reads, registry mutations or catalog revision system.
  On 2026-10-14 the user accepted shared registered-tool review for MCP/custom
  calls, assuming current scoped registered definitions remain unchanged while
  approval is pending and accurately describe behavior. The user subsequently
  selected category `tool`, prompt `TOOL-REVIEW-PROMPT.md` and `reviewTools`,
  replacing reviewMcp/reviewCustomTools without aliases. All review categories
  default enabled. Exact call linkage, scope and arguments remain mandatory;
  descriptions, schemas and registry availability are optional evidence. Send
  factual omission reasons to the LLM, which decides Safe/Unsafe. Never infer
  origin, import/invoke executors or call MCP servers for evidence.
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
  report text stays in memory. Save every completed validated review tied to a
  permission when it is approved manually, approved automatically or rejected,
  including Unsafe reports and distinct re-reviews of the same permission. Native
  `once` proves approval but lacks submitting-client identity: save as `approved`
  without guessing manual/automatic attribution, then refine on exact confirmation.
  Cancellation, interruption and prompt disappearance alone do not save reports.
  Fast approval records identity/confirmation before final assessment; only final
  validated text is saved. Keep retries/deadline unchanged and close the retained
  panel on completion, allowing saves to finish in the background. Failed remainders
  produce no report entry; received usage and confirmed approvals still count.
  Review-specific history IDs are separate from permission-level approval identities.
  Preserve legacy entry IDs and totals internally; notification targets select only
  the exact permission's newest saved review, never the conversation's newest entry.
- `history-v1.sqlite` uses the embedded worker with Bun SQLite in the host and Node
  SQLite in tests. Lifetime reads use precomputed totals only; leave `usage-v1/`
  through `usage-v4/` untouched. `history-statistics.ts` applies deduplicated deltas
  to lifetime/conversation totals transactionally. Conversation baselines may use
  attributable old rows; lifetime must never be reconstructed from detail rows.
  Deleting details must not reduce accumulated totals.
- Preserve private ownership and nonreplaceable paths for saved modes and history.
  `local-state.ts` keeps safely accessible history in place, or uses a private
  plugin-owned sibling without chmod of host/user directories. An existing safe
  sibling database stays selected across restarts. Mode files stay in the original
  state root; unsafe/unreadable modes suspend review rather than enabling by default.
  Storage failures show unavailable, never zero, and must not gate review/approval.
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
- The V2 runtime does not enable persistent deletion. Any persistent deletion would
  require proven server connection/location ownership for the exact live deletion
  event and scoped history. List omissions, bare 404s, read failures, random storage
  tokens and pathnames are not deletion authority. Keep offline history when
  ownership is unproven; invalidating volatile session/ancestry facts must not delete
  saved rows or totals.
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
  Safe auto-enabled requests awaiting conversation/native priority/countdown stay silent;
  elapsed time is not proof they need manual attention. Countdowns are silent and
  approval sounds require confirmed automatic success. Keep delivery off approval
  critical paths and use owned fixed-purpose processes, never a shell.
- Observer, accounting and persistence failures must not change review/approval.
  `withDiagnostics` and other `with*` exports are fixture/embedding seams, not config
  options. Diagnostics contain fixed phase labels, timings and local numeric
  correlations only, never prompts, IDs, paths, credentials or model output.

## Releases

- On 2026-10-14 the user replaced the separate branch-CI/release gate with a simple
  tag-triggered verification/publication workflow, following Speedometer. The
  read-only validation job runs workflow lint, source/helper tests, reproducible
  builds and archive checks for the exact tag before publication can run. There
  is no branch-CI lookup, automatic main/PR workflow or real-TUI release prerequisite.
  The manual extended workflow retains Node 22/24 and newest-stable-V2 host checks;
  its failures cannot authorize or veto publication. Node major ranges select
  maintained patches, and Ubuntu 24.04 avoids surprise runner-image migrations.
  Runtime job summaries expose measured case durations without changing fixture
  budgets or host concurrency.
  Run `bash scripts/lint-workflows.sh` after workflow edits. Its sole syntax
  exception is actionlint 1.7.12's missing support for GitHub's `queue: max`, which
  the release-policy helper tests enforce independently.
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
  npm's certificate checks require the actual workflow-policy source as the first
  resolved dependency; keep the independently validated release tag/commit as the
  separately named release-source input. Test both tag pushes and manual dispatch.
  Never substitute GitHub trigger identity or fall back to unsigned publication.
  Keep signing bundles outside the artifact directory and TUF's `XDG_DATA_HOME`
  inside the private job cache. Offline tests replace signing/crypto/network
  boundaries; they must never request real OIDC tokens or transparency-log writes.
  Uploads never retry. Existing versions verify immutable bytes without retagging;
  channel advancement follows SemVer in `scripts/npm-publication.mjs`.
- npm can accept an upload long before registry availability. Read-only publication
  verification waits up to 60 minutes; keep the publish job's 75-minute timeout
  above that budget. Never bypass archive verification or republish to fix a delay.
- GitHub release creation attaches the CI-verified archive before npm publication,
  independently of npm upload/processing outcomes. Only npm's completed structured
  HTTP 422 provenance rejection fails promptly without a processing wait. Other
  failed uploads remain uncertain: verify the exact bytes read-only within the
  existing budget, never retry the PUT or mutate dist-tags. Unverified npm
  availability still fails the workflow.
- Release policy tests are in `npm run test:helpers`. After a build, run
  `node --test test/release-artifact-smoke.test.mjs`; with npm 12.2.0, also run
  `node --test test/npm-cli-smoke.test.mjs`. Neither publishes. Keep workflow actions
  pinned to verified commit SHAs. Validation uses a complete active-policy checkout
  so helper additions need no path-list maintenance; publication keeps only its
  fixed policy helpers.
