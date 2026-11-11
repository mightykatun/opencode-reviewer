# Maintainer guide

`opencode-reviewer` is an OpenCode V2 plugin for Linux. It reviews pending permission requests with a separate LLM. It can answer them with native Allow once. It keeps report history, statistics and desktop notifications.

## Setup and checks

Use Node.js 24.x with npm. This major version is recommended (>=24.15.0). Node.js 22.x also works (>=22.22.2). These floors apply to development. The published package declares `node >=22`. Run commands from the repository root:

```sh
npm ci --ignore-scripts
npm run check          # typecheck, source tests, helper tests, build
npm run test:helpers   # pure .mjs helpers, no build, tmux or OpenCode
npm run check:package  # two builds, reproducibility, archive and lockfile checks
```

- Focus one source test with `npx tsx --test test/host-context.test.ts`. Filter it with `--test-name-pattern='latest empty/attachment user'`.
- `npm test` runs `scripts/test-source.mjs`. It runs `test/history-bootstrap.test.ts` alone first. Then it runs the other `test/*.test.ts` files two at a time. Keep that split. Keep real budgets and assertions. Never raise time limits or retry failing tests until they pass.
- Add pure `.mjs` tests to `scripts/helper-tests.json`. Host and built-package tests stay out of it.
- Documentation-only changes need a reference and format review, not runtime tests.
- Runtime, UI and host-integration changes need a relevant runtime fixture after `npm run build`.

## Runtime fixtures

Fixtures drive real OpenCode terminals in tmux against local HTTP model servers. Each fixture uses isolated HOME, XDG and project directories.

- Prerequisites: Linux, Git, Python 3, tmux, `opencode` 2.x on PATH and a built `dist/tui.js`. `OPENCODE_BIN` selects another binary. Some fixtures also need npm, tar and `node:sqlite`. CI runs `mkdir -p /tmp/opencode` first. A fresh machine may need the same.
- Develop and test against the latest stable OpenCode 2.x. Never pin a host patch or minor release.
- `node scripts/test-runtime.mjs --list` shows every entrypoint, scenario, flag, prerequisite and classification. `--plan --profile <name>` plans without starting anything.
- Profiles are `ci`, `v2-acceptance` and `v2-permissions`. `v2-acceptance` is `ci` plus every `smoke-v2-review.mjs` scenario. `npm run test:runtime` runs `v2-acceptance`. The manual extended workflow runs the same profile. `npm run test:runtime-permissions` runs `v2-permissions`.
- Run one case with `node scripts/test-runtime.mjs smoke-v2-review.mjs normal-history`.
- The runner never rebuilds. It runs cases serially and stops at the first failure. It writes `results.json` and per-case logs to `.runtime/runtime-run-*/`. Review fixtures write captures to `.runtime/v2-review-<scenario>-*`.
- The runner holds `.runtime/runtime-runner.lock`, whose `owner.json` records the pid. It removes the lock on SIGINT or SIGTERM. After SIGKILL, check that the owner and its hosts have exited before removing it.
- Run at most two hosts at once. Only `normal-reconnect`, `normal-reconnect-visible` and `normal-stalled-stream` use two. Never run another host beside the runner.
- Create and restart tmux sessions only through the supervisor in `scripts/smoke-runtime.mjs`. Never kill shared or default tmux servers. Never clean up by process name. `npm run test:runtime-cleanup` checks interruption and isolation without a build or model.
- Register new entrypoints, scenarios and flags in `scripts/runtime-inventory.mjs` and read them from `runtimeArguments`. Helper tests enforce this. Profiles list exact combinations, not every flag product.
- Use `smoke-observations.mjs` for snapshot and control JSON. Each destination gets one atomic publisher with an explicit final flush. Read with `readObservation`. Concurrent hosts need distinct destinations.
- Use `smoke-ui.mjs` for palette activation. The selected row must be painted. The caller supplies a postcondition. Keep negative observation windows that prove nothing ran or notified.
- Review and notification fixtures start with `"-opencode-reviewer"` in `cli.json`. They wait for an owned probe session to be created and deleted on the connected event stream. Then they publish the real `cli.json`. They don't prove startup before connection. The lifecycle fixture covers startup.
- History fixtures use a fresh private state directory under `/tmp`. Never weaken SQLite ancestor checks or chmod existing user directories.
- Fixtures don't prove real audio, GNOME focus, live provider judgment or latency. The runner refuses interactive cases. Run `npx tsx scripts/smoke-notification-desktop.ts` with one of `--all`, `--sounds` or `--click` (optionally `--critical`) for a real desktop check.
- Report the exact fixture runs you did, never full-matrix coverage.

Focused checks are `smoke-v2-review.mjs` scenarios unless another file is named:

| Area | Scenarios |
| --- | --- |
| Startup connection | `smoke-v2-lifecycle.mjs cold-startup` |
| Reconnect and stalls | `normal-reconnect`, `normal-reconnect-visible`, `normal-stalled-stream` |
| Review modes | `advisory`, `normal`, `fast` |
| Retrieval | `normal-retrieval` (also the native `ask_context` clarification and Asking), `normal-large-source`, `normal-long-session` |
| Skills | `normal-skill`, `fast-skill` |
| Registered tools and Code Mode | `normal-tool`, `fast-tool`, `normal-code-mode-tool`, `fast-code-mode-tool` |
| Edits and directories | `normal-edit`, `normal-directory-edit` |
| History and statistics | `normal-history`, `normal-history-default-home`, `normal-history-keyboard-mouse-off`, `normal-history-cover`, `fast-history-cover` |
| Native replies in history | `advisory-history-once`, `advisory-history-always`, `advisory-history-reject` |
| Session instructions | `normal-instructions` |
| Subagents | `normal-descendant`, `fast-descendant` |
| Routes, dialogs and decisions | `normal-route-wait`, `normal-decision`, `fast-decision`, `normal-dialog`, `fast-dialog`, `normal-hide`, `normal-resize`, `normal-hidden-complete` |
| Mouse and Cancel | `normal-mouse-off`, `normal-cancel` |
| Project identity and evidence failure | `normal-project-transition`, `advisory-evidence-timeout` |
| Approval notification clicks | `fast-notifications` |
| Notifications | `smoke-v2-notifications.mjs` `manual-handoff`, `forms`, `execution`, `unavailable-review` |

## Configuration and package

- The package and plugin ID is `opencode-reviewer`. The exports `.`, `./server` and `./tui` all point to `dist/tui.js`. `src/plugin.ts` selects the role. The CLI role applies when the context has `ui`. Otherwise the role is the server companion.
- Users list the package in both global config files:
  - `opencode.json` loads the server companion. That entry takes no options and ignores any. Permission rules, providers and MCP servers also live in this file.
  - `cli.json` loads the terminal role. Every reviewer option and `keybinds` go in this entry. `cli-plugin.ts` parses `context.options` and rejects unknown keys.
  - Without the `cli.json` entry nothing is reviewed. Without the `opencode.json` entry the companion handshake fails.
- Defaults and validation live in `src/config.ts`. Notification options live in `notification-config.ts`. All `review*` categories and `retrievalClarification` default on. `retrievalKinds.edit`, `autoApprove`, `fastMode` and `stream` default off.
- Source or built-in prompt changes need a build and a host restart. Config or custom prompt changes need a restart.
- The archive holds exactly five files: `dist/tui.js`, `package.json`, `README.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md`. `files` lists three. npm adds the other two. `dist/` is generated and ignored. `npm pack` rebuilds through `prepack`. Verified CI packing uses `--ignore-scripts`.
- Development dependencies use V2 ranges for `@opencode/plugin`, `@opencode/client` and `@opencode/theme`. Pin OpenTUI and Solid to the host's exact versions. Keep the lockfile. Refresh OpenCode dependencies to the latest stable V2 when developing.
- Never gate activation, companion admission or evidence reads on host version numbers. Keep protocol, location, epoch, evidence and eligibility checks. Incompatible API data stays manual and is never guessed.
- Use only public APIs and slots. Never import private UI modules or patch the native approval dialog.

## Build

`scripts/build.mjs`:

- Uses Solid's universal OpenTUI JSX transform, not React or Solid DOM. TypeScript only checks types.
- Keeps Solid, OpenTUI and OpenCode external in the ESM bundle. The build fails if the shared entry eagerly imports `solid-js`, `@opentui/*` or `@opencode/theme`.
- Ships terminal code as an opaque base64 CJS payload. `host-runtime-loader.ts` loads it only in the CLI role. Its only externals are `solid-js`, `@opentui/core`, `@opentui/solid` and `@opencode/plugin/rpc`. Any other unmapped import fails the build.
- Embeds prompts and contracts, six sounds, the MP3 decoder, the theme syntax helper and the CJS history worker. Sounds and the worker are single fixed mappings injected into the payload. The Linux notification and audio backend exists only in the payload. The server never constructs it.
- `scripts/bundled-history-worker.mjs` proves from the AST that both worker consumers and the loader use the same source. Its tests run in `npm run test:helpers` and `check:package`.

## Module map

Roles and connection:

- `plugin.ts`: shared entry and role selection. Its `with*` exports are fixture and embedding seams, never options.
- `companion.ts`: server role. Captures invocations through hooks (`invocation-capture.ts`) and serves the handshake, invocation, evidence and `retrieve` RPCs. `companion-protocol.ts` defines the schema (protocol 2). `companion-read.ts` wraps reads.
- `cli-plugin.ts`: CLI setup. Parses options, loads prompts, waits for the connection marker and runs the first handshake (`companion-handshake.ts`).
- `cli-reconnect.ts`: owns the connection after startup. `setupHostRecovery` in `host-runtime.tsx` wraps it. `connection-marker.ts` handles the delayed echo of the startup marker.
- `host-runtime.tsx`: connects the controller to native queues, slots, polling and approval gates.

Review:

- `controller.ts`: request lifecycle, countdowns, cancellation tombstones and approval policy. `review-admission.ts` limits concurrent evaluators and orders them per root with native-front priority. `approval-transaction.ts` is the once-only write state machine. `host-permissions.ts` sends scoped `once` replies.
- `host-evaluate.ts`: runs one review. It reads evidence through `host-evidence-reader.ts`, runs retrieval through the companion and calls the reviewer.
- `host-reader.ts`, `host-invocation.ts` and `host-request.ts`: bind the pending permission to its captured invocation and copy host JSON within bounds.
- `host-evidence.ts`: operation evidence. `collectHostOperation` runs in the companion. Validation runs in the CLI. Category helpers are `host-skill.ts`, `host-tool.ts`, `host-catalog.ts`, `host-tool-kind.ts`, `host-code-mode.ts` and `tool-evidence.ts`.
- `host-context.ts`: latest and earlier root user prompts. `host-project.ts`: project attribution.
- `retrieval.ts`: CLI retrieval loop. `retrieval-tools.ts`: companion `read`, `list`, `glob` and `grep`. `clarification.ts`: the `ask_context` tool, its eligibility and native session generation.
- `reviewer.ts`: verdict stage. Transport is in `chat-transport.ts`, `sse.ts`, `transport-retry.ts`, `streaming-assessment.ts` and `transport-ownership.ts`. `deadline.ts` holds the budget.
- `session-ancestry.ts` and `route-approval.ts`: bounded ancestry and conversation roots. `session-mode.ts` and `host-mode-commands.ts`: per-conversation enable and disable. `session-instructions*.ts` and `host-session-instructions.tsx`: session instructions.
- `host-approval-ready.ts`: route and native decision gates. `host-native-observations.ts` and `host-queue.ts`: native family rosters and queue priority. `pending-refresh.ts`: revision guards for pending reads.

UI, history and notifications:

- `host-sidebar.tsx`, `host-review-panel.tsx`, `host-history-view.tsx` and `host-statistics-view.tsx`. Fixed copy is in `ui-text.ts`.
- `host-history-runtime.tsx`, `history-coordinator.ts`, `history-store.ts`, `history-storage-worker.ts`, `history-statistics.ts`, `local-state.ts`, `private-record.ts`, `usage.ts` and `host-pricing.ts`.
- `host-notifications.ts`, `host-notification-runtime.ts` and `notification-*.ts`.
- Types: `host-types.ts`, `types.ts` and `embedding-types.ts`. Embedding types are observation and backend seams, never approval overrides or options.

## Approval

- The plugin is advisory unless `autoApprove` is on. It only sends native `once` in the captured invocation's host scope, never the tool workdir. Never add `always`, `reject`, permission-rule writes, command execution or edit application.
- Normal approval needs a completed, validated Safe assessment. Then it starts a countdown. Positive countdowns add a 200 ms grace. Zero skips the delay, not the checks.
- Fast mode (`fastMode` with `autoApprove`) may approve on a parsed Safe preview with no countdown. With `stream: false` it waits for the full response. After confirmation, the report keeps running through hiding, navigation and mode disable. Deletion or disposal still aborts it. Use `pendingViews` for order and notifications so finishing reports don't block anything.
- Immediately before the single write, recheck synchronously: fresh permission identity and scope, native queue priority, same-conversation ancestry and native decision state.
- The active route must be the request's conversation or a descendant. With tabs, an open background tab of that conversation also qualifies. Home, dashboard, unknown and unrelated routes wait and never cancel. The root also needs fresh native family health (`permissionRoots`). Panel paint, hit tests, mouse and sidebar never gate approval.
- The root's native queue holds its whole descendant family, root first. Follow actual native ownership, not event order. Reconcile native permission caches after interruption. A fresh server read alone doesn't refresh a stale native prompt.
- Hold without cancelling while native Always or Reject is selected or a rejection is being edited. Observe public renderable IDs and choice colors only. Ambiguous observations hold. Ordinary modal mode is not a hold.
- A started countdown keeps its monotonic deadline through every wait, including reconnection. An expired countdown resumes without a new delay. A never-armed request starts a full countdown when it first becomes eligible, even with the report hidden.
- Only Cancel, mode disable and native stop actions cancel. Tombstones survive remount, route changes, re-enable and reconnection until native resolution. Disabling the mode cancels armed countdowns unless a fast approval was already dispatched.
- Dispatch, acknowledgement and native resolution are separate facts. Confirmation needs the native acknowledgement and the matching scoped resolution, not a keypress or a vanished prompt. Never retry an approval write. Uncertain writes stay manual.
- Deduplicate by permission-request ID. Directory and operation permissions are separate reviews. Disabled categories still block native ordering while skipping review work.
- Conversation mode covers every descendant in the host scope. Unknown ancestry or an unreadable saved mode suspends work. Enable and disable commands create no messages or model calls. Re-enable takes a fresh pending snapshot.

## Evidence

Mandatory evidence must be exact. Otherwise the review shows Analysis unavailable, with no model call and no reply. Optional evidence may be omitted with a factual reason sent to the model. Missing optional evidence never vetoes approval by itself.

- Shell: command, cwd and execution. Resolve a relative `workdir` against the captured `invocation.location.directory`, never the stored session directory. `~`, `~/` and NUL in `workdir` fail analysis. A missing invocation location stays unknown.
- Edits: pending host diffs only, never fabricated ones. Oversized diffs keep a leading prefix of complete lines and an exact omitted-line count.
- Directories: exact declared scope and arguments.
- Skills (`reviewSkills`): full main instructions, read by exact ID from the scoped registry through the companion. Never read SKILL.md from disk. Missing, ambiguous or oversized instructions stay manual. This assumes the definition doesn't change while pending. Don't add a revision-guard system.
- Registered tools, MCP and custom tools (category `tool`, `reviewTools`, `TOOL-REVIEW-PROMPT.md`, no legacy aliases): the exact direct call, or the exact outer Code Mode `execute` input, plus scope and arguments are mandatory. Descriptions and schemas are optional. This assumes registered definitions don't change while pending and describe behavior accurately. Never infer origin by splitting names, import or invoke executors, or call MCP servers.
- Code Mode: keep native Code Mode and its tool search. Don't add a direct-tool transform. When inner linkage is uncertain, `host-code-mode.ts` gives the judge bounded candidate calls, including completed siblings, and states the uncertainty. Safe may approve that exact once permission without a unique match. Never claim inner identity from arrival order, JavaScript parsing or forced serialization. `invocation-capture.ts` counts live executions per identity and releases a group only after every matching after-hook settles. Completed calls must not use up live capacity.
- Native tools: assume installed plugins keep native tool meanings and don't rewrite commands after capture. Don't extend this assumption to skills, MCP or custom tools.
- Root context: read delivered root user messages newest first with `message.list({ sessionID, type: "user", order: "desc", limit: 100 })`, then follow `cursor.next` with the same type and no `order`, up to four pages. The newest is `userPrompt`. Omit it over 64 KiB with a note. A newer empty or attachment-only message stays the latest request and must not fall back to older text. The others are `earlierUserPrompts`, oldest first, within 8 KiB each and 64 KiB in total, filled newest first. Oversized ones keep exact leading lines with omitted counts. Past the total budget the oldest are dropped with a count. Validate every page. Malformed or repeated history fails the review. A later page that stalls or fails is an optional omission with a note. A parent abort still fails. The contract tells the judge to extrapolate the user's direction across these prompts and keep a private, up-to-date list of standing boundaries, with the latest prompt winning conflicts. Only a clear breach of an explicitly stated boundary forces Unsafe. Inferred boundaries are weighed with actual risk. The immediate subagent task isn't available through public V2 linkage, so omit it factually. Never substitute older tasks, siblings or queued input. Context never overrides review rules.
- Project attribution: a session can gain a Git project ID while the companion's setup project stays `global`. `host-project.ts` resolves this only from the connected server's registered project and checkout inventory. Never change the invocation's location, source, arguments, workspace or epoch. Missing or ambiguous inventory stays manual.
- Evidence reads prepare and bind before collection. They finalize native identity and companion epoch once, after validation.

## Retrieval

Only the agentic retrieval loop chooses files. Never parse commands to pick files. Keep this code short and simple.

- `retrieval.ts` runs in the CLI before every enabled verdict. It uses non-streaming tool calls with fixed byte-stable definitions: `read`, `list`, `glob`, `grep` and `finish`, plus `ask_context` before `finish` when clarification is offered. It runs up to `maxRetrievalRounds` rounds. Calls past ten in one round get a `not-executed` error result. A forced `finish` turn (`tool_choice`) follows the last round or a round without tool calls. All of it runs within `retrievalTimeoutMs` and the shared deadline.
- Invalid individual calls return error results to the model. A malformed `tool_calls` envelope ends retrieval.
- Model-requested inspection reads default to 100 lines, and list/glob/grep to 50 entries or matches. Apply defaults at CLI dispatch, retaining original arguments in the trace. Explicit larger limits remain available within existing byte bounds and the 500-entry search/list bound. Backend reads without a limit retain whole-file semantics.
- `finish.items` mixes successful result IDs and file descriptors (`path`, optional positive `offset`/`limit`) in forwarding priority order. Validate the whole finish before reading attachments. Bind result references before allocating attachment IDs. Read attachments through the scoped companion within the existing retrieval deadline, with no further model turn or tool reply. Trace them with `delivery: "reviewer"`, including failures and unattempted reads. Attachments never enter the retriever conversation. Their notes cannot claim inspection of unseen contents.
- Without a valid finish, the verdict still runs with every successful result in call order and a factual limitation. This covers timeouts, rejected tools, provider errors, exhausted retries and malformed responses. The review deadline or an abort ends the whole review.
- A valid finish remains the selection when attachment collection is partial. Retain completed selected results and report attachment failures or timeouts factually. Share one forwarding-budget algorithm between attachment admission and evidence assembly. Skip attachment reads once file or byte capacity is exhausted. Selected inspections and attachments share maxFiles and maxEvidenceBytes, including notes. Count each dispatched attachment read once as a retrieval operation, but never count finish itself or unattempted reads. Settle physical work before the verdict.
- A retrieval RPC responds only after its own server-side physical work drains. Keep its HTTP wait separate from the caller's logical deadline/cancellation, with the sent server budget shortened on capacity retries. Cancellation still ends the visible review immediately while its evaluator owns the outstanding RPC. A lost RPC response cannot prove server completion and ends the review without a verdict. Only explicit pre-admission capacity/scope refusals establish that no retrieval work started.
- Retrieval never writes a verdict. The verdict request never declares tools.
- Clarification (`ask_context`, `clarification.ts`) is offered only when `retrievalClarification` is on, retrieval is enabled for the category and the review belongs to a root conversation. Subagent reviews never get the tool. One executed call per review holds every question. Invalid calls don't use the allowance, and later calls are `not-executed`. It uses OpenCode's public `session.generate`, the `/btw` backend, on the captured client and the root session. Never drive the TUI `/btw` command or rebuild session context. The request is the clarification prompt followed by JSON with `pendingOperation` (the evidence without conversation fields or limitations) and `questions`. Generation adds no history, doesn't see the in-flight tool call and doesn't execute tool calls. A tool-call answer arrives as empty text, which counts as no answer. Failures and empty answers are factual error results. Cancellation propagates. The answer is a `content` result capped at `maxEvidenceBytes`. The retriever selects it like any other result, and it never counts toward `maxFiles`. Its generation usage stays in OpenCode's session totals.
- Operations run only in the companion (`retrieve` RPC, `retrieval-tools.ts`), never in the terminal, at most two at once. The CLI computes the base: the shell launch cwd, otherwise the invocation directory. Paths may be absolute, `~/` (server HOME) or relative. Named paths follow symlinks. Traversal never enters symlinked directories and has no ignore list. Results echo requested, absolute and canonical paths and are capped at `maxEvidenceBytes`. Listings return at most 500 entries. Grep skips files over 16 MiB, binary files and invalid UTF-8. It runs in a worker that is terminated at the soft deadline.
- Content forwarded to the verdict is capped at `maxFiles` read items and `maxEvidenceBytes` including notes. It is cut to exact leading lines or entries with omitted counts.
- `retrieval` and `retrievalKinds` gate the stage. Disabled or executor-less reviews send `retrieval.status` `disabled` or `unavailable`.

## Model transport

- `deadline.ts` shares one `timeoutMs` budget (default 120000) across context, evidence, retrieval, HTTP and corrections. `retrievalTimeoutMs` only shortens retrieval and reserves nothing for the verdict.
- A timeout doesn't prove that I/O stopped. Keep ownership of physical work until it settles (`file-access.ts`, `transport-ownership.ts`, history and notification work). Parent aborts must not become optional-evidence omissions.
- `streaming-assessment.ts` accepts exactly `{ "safe": boolean, "desc": "nonempty text" }` and rejects duplicate keys. SSE success needs `stop`, `[DONE]` and body EOF. Keep terminal usage even for rejected assessments.
- `transport-retry.ts` allows two extra POSTs per stage. Retrieval turns share one allowance. The verdict has its own. Retryable: HTTP 408, 429, 500, 502, 503 and 504, transient network errors and rejected streams. Respect Retry-After. Skip the retry if it doesn't fit the remaining budget. Transport retries resend the identical request. Format corrections keep the exact history plus the failed response and feedback. Clear rejected previews. Never merge streams, extend deadlines, shorten Retry-After or raise `maxOutputTokens`.
- A `length` finish is retryable in retrieval and in streamed verdicts. A non-streamed verdict with any finish other than `stop` fails.
- Evidence is data, not instructions. Never add automation metadata or notices to either model conversation.

## Connection lifecycle

- Startup reads the public client's `server.connected` marker before the first companion RPC. Ignore the native bridge's delayed echo only for that exact event ID. A different marker fences startup and permanently revokes an active generation.
- Startup and reconnect handshakes each get a 10-second budget with 1.5-second attempts and 250 ms backoff. They retry only timeouts, `rpc.unavailable` and recognized transient transport failures, and only with a valid configuration. Settle physical work before each retry. Invalid replies stay manual. Without a companion, history, statistics and notification-only fallback still run.
- Choose the runtime or the fallback once per connection. Never promote the fallback on a duplicate marker or revive an old generation.
- Reconnection admits a fresh composition only when the public client and native markers agree and a fresh scoped handshake completes. Drain the old composition first. Critical native-cache and write work must settle. Optional notification and history cleanup doesn't gate admission. Never mix clients, caches, evidence or approval leases.
- Across reconnection, carry only manual tombstones and identity-bound countdown deadlines, never assessments. Notification continuity carries observed births, visits and announcement attempts for the same client and location. Reminders need fresh native family health first.
- Release an idle event subscriber after 45 seconds without activity. A replayed old marker is not fresh admission. A 2-second health probe can replace a changed companion epoch after critical drain and a new handshake, without a plugin reload.

## UI

- Observe `sidebar.content` and render through `app`. Keep one stable slot root with live and history siblings. Key the live panel by request ID. Changing fragment or view keys remounts Markdown and resets scrolling.
- Show the reviewer panel (live, retained and history) only on the top-level conversation route. Descendant routes show nothing at any terminal width.
- Reveal a hidden sidebar only after an explicit approval-notification click, through the public native command. Never force mouse or sidebar visibility.
- FRAME geometry and hit ownership serve UI behavior and fixture observations only. Never fabricate visible IDs, FRAME events or hit-test proof.
- Sanitize report text and streamed prefixes through `displayText`.
- The panel shows Retrieving, then Evaluating. Retries show Retrying. Asking covers an `ask_context` call. Retrieval phases, including Asking, come before attempt 0 and never advance attempt ordinals. Thinking appears only for streamed verdicts, from the first real reasoning delta before any answer text of the current attempt until its first preview. It never uses a timer and never shows or stores reasoning text. Labels come from `uiText.review` through one table keyed by phase.
- Returning to the root never re-reviews, restarts timers, re-arms canceled requests or brings back finished reports.
- Alt+H (`reviewer.history.toggle`) and Alt+I (`reviewer.instructions`) are registered in global layers so the palette shows them. Alt+H toggles history in base mode on the root route. The palette and `/reviewer-history` (`reviewer.history`) always open the newest report. Never bind Ctrl+H. Leave BS and DEL prompt editing alone.
- Fixed copy lives in `src/ui-text.ts` as named strings or typed formatters that fit the 42-column sidebar. Tests keep their own expected wording.

## History and statistics

- `history-coordinator.ts` joins reviewer attempts with controller facts. Unresolved report text stays in memory.
- Save every completed validated review whose permission is approved or rejected, including Unsafe reports and repeated reviews. Cancellation, interruption or a vanished prompt alone saves nothing. Native `once` without proven attribution is saved as `approved` and refined on exact confirmation. Native `always` is saved as `manual`. A failed fast remainder saves no entry. Its usage and confirmed approval still count.
- History IDs are per review. Approval identities are per permission. Notification targets select that permission's newest saved review, never the conversation's newest entry.
- Storage is `history-v1.sqlite` through the embedded worker, using Bun SQLite in the host and Node SQLite in tests. Never touch the legacy `usage-v1/` to `usage-v4/` directories.
- `review_versions` stores `reviewer_version` and nullable `opencode_version` by review ID. `history-versions.ts` atomically backfills older rows with the fixed reviewer baseline `2.7.0` and unknown OpenCode version. Never advance that baseline on release. Keep the old table and context/payload JSON shapes so older workers can coexist. The reviews insert trigger covers their later writes. New runtime event metadata is captured once by the coordinator from the bundled package manifest and public TUI `context.app.version`, and is stored only on first review admission. Later outcomes or version changes never relabel existing reviews. Versions are database metadata, not UI copy, model evidence or approval gates.
- `local-state.ts` keeps history under the state root when it is safely accessible. Otherwise it uses the private sibling `opencode-reviewer-state`, which stays selected once it exists. Mode and instruction files stay in the state root and share `private-record.ts`. Unsafe or unreadable modes suspend review. Validate the database and its sidecar files with lstat only. Never open them to inspect, because closing can drop another worker's SQLite locks.
- Storage failures show unavailable, never zero. They never gate review or approval.
- `history-statistics.ts` applies deduplicated deltas to lifetime and conversation totals in one transaction. Lifetime reads only precomputed totals and is never rebuilt from detail rows. Deleting details never reduces totals. Manual approvals and rejections count once per permission through the `permission_statistics` ledger. Unattributed `once` stays unclassified.
- Usage is counted per POST, including failed and interrupted ones. Cumulative frames replace earlier values. Token and cost coverage are independent. Unknown is not zero. OpenRouter (exactly `https://openrouter.ai/api/v1`) uses the reported `usage.cost`. Other endpoints use matching host-catalog estimates. Never call billing APIs.
- Count reviews on final controller acceptance and retries on actual non-initial dispatch. Each retrieval turn's first POST is `initial`. Retrieval tool calls count once dispatched to the companion or, for `ask_context`, to session generation, whatever the result. Invalid calls, `finish` and POSTs never count. `retrieval_calls` keeps bounded paging facts for the conversation bootstrap.
- History and statistics resolve ancestry through `HistoryCoordinator.root`, not the review-mode gate, so they work with review disabled. Keep `HistoryRead.settled` ownership after caller timeouts. Drain within 3.5 seconds of lifecycle abort.
- Persistent deletion is off. Live deletion events only invalidate volatile facts. List omissions, 404s, read failures, storage tokens and paths are never deletion authority.
- Normalize older formats internally. Never show UI notices about upgrades, format changes or missing old history.

## Notifications

- Eligibility comes from new events, never startup snapshots or history browsing. Snapshot reconciliation is silent.
- Only the native front-of-queue blocker of each root notifies or reminds. Losing queue position aborts pending delivery. A request resolved while queued never alerts. Handoff sends the next initial notification. Then it waits a full reminder interval.
- Safe requests waiting for eligibility, queue priority or a countdown stay silent. Countdowns are silent. Approval notifications need confirmed automatic success.
- Manual attention keeps working when the review config or the companion is unavailable, without a second UI, model calls or replies.
- Clicks carry the original permission and session identity. Wait for native dialogs to close. Check again for an unfinished fast report. Then select the exact saved entry within a hidden five-second wait. A missing report opens only the conversation. New clicks, route changes and disposal cancel late work.
- `host-native-observations.ts` refreshes roots and seeds, then family rosters, then member metadata, before ancestry checks. An incomplete member excludes its whole family. A failure in one conversation never silences another. Permission and form reads keep separate budgets. Optional form reads stay outside permission admission and fail health closed.
- Delivery stays off approval critical paths. Use owned fixed-purpose processes, never a shell.
- Notification fixtures inject the desktop backend. They don't prove audio, focus or real delivery.

## Diagnostics

Observer, accounting and persistence failures never change review or approval. Diagnostics carry only fixed phase labels, timings and local numeric correlations. Never include prompts, IDs, paths, credentials or model output.

## Writing rules

- Never use em dashes.
- Files in `prompts/` and `contracts/` also never use semicolons or middle dots. The review contract tells the judge the same for desc.
- Model guidance lives in `prompts/`, including the overridable `RETRIEVAL-PROMPT.md` and `CLARIFICATION-PROMPT.md`. Fixed contracts live in `contracts/`. Both are listed in `src/prompt-files.json`. Keep `{{validationError}}` in the correction contract.
- The README covers npm installation, one full config example and user behavior, with no release history.

## Releases

- Bump with `npm version X.Y.Z --no-git-tag-version`, which updates `package.json` and `package-lock.json`. Commit, tag `vX.Y.Z` on that commit and push the tag. Tag, commit and manifests must match. Build metadata is rejected.
- `release.yml` runs on `v*` tag pushes, or on manual dispatch from the default branch with an existing tag. Creating a GitHub release doesn't trigger it. Concurrency uses `queue: max` with cancellation disabled.
- The read-only validation job type-checks and tests the tag. It runs `check:package`. It then runs workflow lint, helper tests and the release smoke tests from a complete policy checkout at `github.workflow_sha`.
- The privileged publish job publishes the exact validated archive. It uses only the fixed policy helpers from a sparse checkout at `github.workflow_sha`. Never build, install dependencies or run package code there.
- Provenance is signed in a time-limited child with pinned npm and Sigstore. `runDetails.metadata.invocationId` names the signing attempt. The workflow-policy source is the first resolved dependency. The release tag and commit are a separate input. Signing errors expose only fixed stages, allowlisted codes and HTTP status numbers. Keep signing bundles outside the artifact directory and TUF's `XDG_DATA_HOME` in the private job cache. Never use trigger identity as a substitute or fall back to unsigned publication.
- Provenance requires the `mightykatun/opencode-reviewer` repository and a GitHub-hosted runner.
- The GitHub release with the verified archive is created before npm publication. Uploads never retry. Only npm's structured HTTP 422 provenance rejection fails at once. Other failures are verified read-only within the wait budget, which must stay below the publish job timeout. Existing versions verify immutable bytes without retagging. Channels follow SemVer in `scripts/npm-publication.mjs`. Never bypass archive verification or republish to fix a delay.
- `ci.yml` is manual. It runs Node 22 and 24 and the `v2-acceptance` profile on the latest V2. Its result never gates or vetoes publication.
- After workflow edits, run `bash scripts/lint-workflows.sh`, which downloads actionlint. Its only ignore covers actionlint's missing support for `queue: max`, which helper tests check separately. Keep actions pinned to verified commit SHAs.
- Offline tests replace signing, crypto and network boundaries. They never request OIDC tokens or write transparency logs. After a build, run `node --test test/release-artifact-smoke.test.mjs`. With the npm version that `test/npm-cli-smoke.test.mjs` requires, run that test too. Neither publishes.
