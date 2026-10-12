# OpenCode V2 migration plan

Status: phase 0 blocked on verified public-API gaps; awaiting scope/upstream guidance.
Prepared: 2026-10-12.
Baseline: `v1.0.2` (`7cd1e561aea594ab9c7a99a32f30568579098747`), the final
OpenCode V1-compatible release. Current `main` also contains a subsequent README
edit. Preserve that work when starting implementation.

## 1. Goal and scope

### Execution tracker

- [x] 1. Read the complete plan and existing completion state.
- [x] 2. Read referenced implementation, fixture, package and workflow files.
- [x] 3. Derive ordered implementation tasks and acceptance gates.
- [ ] 4. Implement sequentially and commit verified increments.
  - [ ] Phase 0: pin and probe public host capabilities; resolve architecture.
    - [x] Inspect exact installed host and released package contracts.
    - [x] Verify direct native request reads/reply, options and unload cleanup.
    - [x] Reproduce custom replacement behind native-looking tool/catalog data.
    - [x] Reproduce descendant auto/hide ambiguity and test disk/env alternatives.
    - [ ] Probe invocation/delegation, catalog provenance and pending evidence.
    - [ ] Probe lifecycle, queue, coverage, scope and reply/error events.
    - [ ] Record findings and resolve mandatory capability gaps.
  - [ ] Phase 1: V2 entrypoint, package, lifecycle and storage scope.
  - [ ] Phase 2: typed host boundary and all evidence categories.
  - [ ] Phase 3: controller, physical presentation and normal/fast/F34 approval.
  - [ ] Phase 4: persistence, accounting, modes and notifications.
  - [ ] Phase 5: fixtures/inventory/CI updated alongside their features.
  - [ ] Phase 6: documentation and installed-archive verification.
- [ ] 5. Verify each phase against its exit criteria before proceeding.
- [x] 6. Record completed items and concrete evidence incrementally.
- [x] 7. Escalate any unresolved mismatch with expected/found/impact/options.

Phase-0 evidence and exact commands are tracked in [V2-CAPABILITIES.md](V2-CAPABILITIES.md).
The first verified probe increment is commit `c7546e1`. Released 2.0.26 contracts
expose gaps in tool provenance, nested invocation identity, delegation linkage
and terminal sidebar-state observation. Real-host direct/replacement and sidebar
reproductions pass, and all 118 helper tests pass. See the capability document's
escalation and exact artifact paths. Phase 0 remains incomplete; later phases
remain gated rather than accepting inferred identities.

Port `opencode-reviewer` to the public OpenCode V2 plugin and client APIs while
preserving its existing review, approval, history, statistics and notification
behavior. Target a separately verified V2 release, with exact dependencies and
real installed-package tests. Recommend the next stable package version be
`2.0.0`, reflecting the host compatibility break; choose the version at release
preparation, not during this planning task.

Keep `v1.0.2` as the V1 installation target. The migration guide's optional
combined V1/V2 export is unnecessary for this release policy.

The principal architectural fact is that this repository is **CLI-only**:
`src/tui.tsx` exports `{ id, tui }`, and `package.json` exposes `./tui`. It does not
return a V1 server-hook map. Therefore use the V2 **CLI** entrypoint and context,
not a mechanical rewrite to server hooks. In particular, the server guide's
`permission.hook("evaluate")` example executes before a pending prompt exists and
can alter allow/ask decisions. It is not a replacement for this plugin's pending
request review and one-time reply lifecycle.

### Documentation read for this plan

The requested migration guide was read in full, including configuration,
entrypoints, context, hooks, request hooks, tools, transforms, events, storage,
dual-version support and verification. Sources accessed on 2026-10-12:

- [V1 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1/)
- [Plugin overview and full API](https://opencode.ai/v2/docs/build/plugins)
- [CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli)
- [General V1 migration](https://opencode.ai/v2/docs/migrate-v1)
- [CLI plugin loading](https://opencode.ai/v2/docs/cli/plugins)
- [CLI settings](https://opencode.ai/v2/docs/cli/config)
- [JavaScript client](https://opencode.ai/v2/docs/build/client)
- [Plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc)
- [Published V2 OpenAPI](https://opencode.ai/v2/openapi.json), with targeted
  inspection of permission, session, message, form, skill and error contracts.

These pages describe a moving V2 target. Re-read relevant pages and verify the
selected release's exported types before coding. The published OpenAPI labels
itself an experimental selected-route surface; missing endpoints there are
questions to investigate, not proof that no public capability exists.

## 2. Preserve these product contracts

Read the current `AGENTS.md` and the final dispositions in the
[V1 release audit](https://github.com/mightykatun/opencode-reviewer/blob/v1.0.2/AUDIT.md)
before implementation. The archived audit is also available with
`git show v1.0.2:AUDIT.md`, even if absent from the working tree. Historical audit
findings are not all outstanding defects. In particular, keep the completed F34
replacement contract, not its superseded earlier proposal.

- Advisory by default; only `autoApprove` enables automatic `once` replies.
  Never write permission rules, send `always`/`reject`, execute commands or apply
  edits. Existing native allows continue to skip pending-request review.
- Deduplicate permission requests, not tool invocations. External-directory and
  operation permissions remain independently reviewed where the host emits both.
- Normal approval requires a completed, validated Safe report and the configured
  monotonic countdown. Fast mode keeps its preview/full-response distinction,
  no countdown, exact request recheck, retained response and once-only write.
- Show live, retained and history panels only on the root conversation route.
  Known same-root descendant browsing deliberately hides the panel while normal
  and fast automation continue. It does not grant queue ownership to deep-only
  requests that are absent from the native root queue.
- Preserve actual painted ownership and normal-mode history-cover proof outside
  the F34 route exception. Cancel, genuine coverage/hiding, unrelated navigation,
  unknown ancestry and uncertain writes retain their blocking/tombstone behavior.
- Keep genuine root-user intent distinct from the exact immediate delegation.
  Preserve invocation-time location, exact mandatory evidence, literal file
  discovery, bounded optional evidence and cancellation ownership.
- Preserve the external OpenAI-compatible reviewer transport, strict assessment
  schema, SSE completion requirements, shared deadline, exact retries and per-POST
  usage. V2 `generate` and request hooks do not replace this transport.
- Preserve transactional history/statistics, ambiguous-approval attribution rules,
  retained fast-report completion, deletion privacy and lifetime totals.
- Keep front-of-queue notification eligibility, event-versus-snapshot distinctions,
  exact notification-click targets and silent countdowns. Mode commands must not
  submit prompts or cause model calls.
- Keep public APIs, the universal OpenTUI JSX build, centralized fixed UI copy,
  embedded assets and the exact five-file package contract. Do not add migration
  or missing-history UI warnings.

## 3. Concrete API migration map

The entries below are migration destinations, not instructions to cast V2 objects
into V1 types. Put schema conversion at a small host boundary and use
reviewer-owned types for the stable policy/controller inputs.

| Current code | V2 destination and required work |
| --- | --- |
| `src/tui.tsx`: `@opencode-ai/plugin/tui`, `{ id, tui(api, options) }` | `Plugin.define({ id: "opencode-reviewer", setup(context) { ... } })` from `@opencode/plugin/tui`; options from `context.options`; return owned-resource cleanup. |
| `@opencode-ai/sdk/v2` imports throughout `src/` and tests | Released V2 uses `@opencode/client`. The old package's `/v2` suffix does **not** mean compatibility with OpenCode V2. Replace wire types and fixtures deliberately. |
| `api.event.on(... event.properties ...)` | CLI `context.data.on` / `data.listen`, with V2 event payloads such as `event.data`; store unsubscribe functions. Server `ctx.event.subscribe` is a different interface. |
| `api.state.session.*` | `context.data.session.*`, including hierarchy, message, pending, permission and form caches with explicit sync/invalidate. Validate cache completeness before treating absence as absence. |
| `api.state.path.directory`, `api.state.path.state` | Establish explicit connected-host/location identity and a supported local storage root. `context.location` can be absent and is not every session's invocation location. There is no documented direct `state.path.state` rename. |
| `api.route.current`, `route.navigate` | `context.ui.router.current()` and `navigate({ type: "session", sessionID })`; account for tabs and plugin/home routes. |
| `api.slots.register`, `sidebar_content`, `props.session_id` | `context.ui.slot({ append: "sidebar.content", render })` and an `app` contribution; documented sidebar input uses `sessionID`. Retain a stable live/history parent. |
| `api.keymap.registerLayer`, `dispatchCommand` | Reactive `context.keymap.layer`, command `id/title/run`, `dispatch`, and target/mode-scoped bindings. Validate native IDs against the chosen release and keybind reference. |
| `api.theme.current`, V1 syntax tokens | V2 semantic `context.theme` tokens; port `appearance.ts`, Markdown styles and all panel/dialog consumers against actual exported types. |
| `api.kv` for animations/sidebar | Read supported V2 settings APIs established in phase 0. CLI config names are `animations` and `session.sidebar`; plugin storage is not a replacement source for host preferences. |
| `api.ui.toast`, `dialog.replace/open/depth` | V2 `toast.show`, `dialog.show/set/clear`; discover a supported coverage/open-state observation. Dialog examples alone do not establish the old depth/open getters. |
| `api.lifecycle.signal/onDispose` | Own an abort controller and idempotent cleanup returned by `setup`; preserve shutdown draining and actual outstanding transaction ownership. Verify setup-failure cleanup as well. |
| `api.client.app.skills` and MCP/provider caches | V2 location-scoped skill/MCP/model/provider APIs; normalize catalog identity and pricing, rather than retaining V1 nesting assumptions. |

### Wire-contract changes already observed

The published OpenAPI provides these concrete starting points. Confirm them with
the pinned client because server-plugin convenience methods and HTTP/client
methods are not necessarily named or wrapped identically.

- `Permission.Request` has `id`, `sessionID`, `action`, `resources`, optional
  `save`, `metadata`, `source`, and `message`. V1 `permission`, `patterns`,
  `always` and `tool` are not its wire shape. A tool source is
  `{ type: "tool", messageID, id }`. Verify `source.id` against the exact
  assistant content item, including ownership and running-state checks.
- Published operations are `permission.request.list` (location-scoped),
  `session.permission.list/get/reply` (session-scoped). Reply requires
  `{ decision: "once" }` in the HTTP body. The server plugin guide instead shows
  `ctx.permission.reply({ ..., reply: "once" })`; resolve that distinction using
  actual CLI client types and a host fixture, not a textual rename.
- Native permission actions include `shell` instead of `bash`, `subagent` instead
  of `task`, and `edit` for writes/patches. Retain the existing public `reviewBash`
  option for shell review unless a separately documented config change is needed.
  Re-establish native tool, MCP and skill origin rules; a matching action/name is
  still insufficient evidence of origin.
- Messages use discriminated `type` values. User messages carry `text` and optional
  files; assistant messages carry `content`, whose tool items use `id`, `name` and
  `state.input`. They are not V1 `{ info, parts }` messages.
- `session.message.list` uses body `cursor.previous/next`, with `order` only on the
  first page and a consistent optional `type` filter. It is not the V1 `before`
  parameter and `x-next-cursor` header. Preserve bounded traversal, loop detection
  and the attachment-only latest-user rule. `session.context` may be model context,
  not complete durable history; establish suitability before using it for intent.
- `Session.Info` exposes `location` and `parentID`. The inspected assistant schema
  does not expose V1 `path.cwd/root` or `parentID`. Recovering invocation-time cwd
  and exact immediate delegation is an explicit investigation, not permission to
  substitute the current location or nearest earlier user text.
- V2 exposes forms and session execution events. Map question and completed-turn
  semantics from pinned event types; do not assume all `question.*`, `session.idle`
  and V1 message events survive unchanged.
- `SessionNotFoundErrorEncoded` is `{ _tag: "SessionNotFoundError", sessionID,
  message }` in the inspected schema. Establish how the client exposes that error
  before replacing `history-maintenance.ts`'s exact V1 envelope validation.

## 4. Implementation sequence

Use small coherent commits. Each phase records its exact host/package version,
commands, results and remaining gaps. Continue dependent work only after the
phase's exit criteria are met.

### Phase 0: pin the host and resolve capability questions

1. Pick an exact supported V2 release and matching `@opencode/plugin`,
   `@opencode/client`, OpenTUI and Solid versions. `2.0.26` is an existing research
   baseline, not a verified production target. Inspect package exports and runtime
   requirements, including Bun/Node SQLite worker behavior.
2. Build isolated, read-only contract probes using the existing runtime supervisor.
   Capture synthetic permissions, messages, delegation/resume, session moves,
   forms, execution outcomes and catalog metadata. Use isolated HOME/XDG and a
   standalone host, never the user's active service or real provider credentials.
3. Resolve and write down the following capability table with public type/source
   references and real observations:

| Question | Required result before the dependent feature is ported |
| --- | --- |
| Where is the exact invocation cwd/worktree recorded? | Immutable invocation identity/location, including a session moved after dispatch. No session-start/current-directory substitution. |
| How is a resumed/nested delegation tied to the invocation? | Exact user/inbox/message ownership, excluding siblings and queued follow-ups. |
| How can the CLI read native/custom/MCP origin and effective tool definitions? | Public catalog provenance or an explicitly scoped public extension. The inspected OpenAPI has no obvious V1 `tool.ids/list` counterpart. |
| Where are pending edit diffs and skill permission arguments? | Host-provided pending evidence and a mandatory catalog instruction snapshot, before execution. |
| What is the native root permission/form queue order? | Verified root/direct-child/deep-child membership and blocker ordering; do not infer it from generic family membership or request arrival alone. |
| What proves root-panel ownership and native coverage? | Real rendered frame/highlight, sidebar state, palette/dialog/fullscreen and history-cover observations, independent of route ancestry. |
| What is the connection/location/storage scope? | Explicit separation of terminal-local resources, server session identity and invocation filesystem. Reconnection or server switching cannot reuse another server's pending IDs or deletion authority. |
| What are exact reply/error/event contracts? | A `once` round trip, resolved-request behavior, missing-session envelope, event ownership and client cancellation behavior. |

4. Prefer a CLI-only port using `context.client` and public caches. If mandatory
   evidence exists only server-side, document the missing field and evaluate a
   minimal public server companion/RPC. Such a companion may collect read-only
   bounded evidence, but must not take over approval decisions or mutate model
   conversations. Read the RPC guide and design loading, location filtering,
   cancellation and startup reconciliation before adding it.
5. A companion changes configuration, exports and potentially packaging. Resolve
   that architecture explicitly against the five-file package/AGENTS constraints
   before implementation; do not silently expand the archive or import host internals.
   If neither public client nor public hooks provide the required evidence, record
   an upstream API blocker. Do not call degraded mandatory evidence full parity.

**Exit:** checked-in capability findings, pinned dependency choice, confirmed
architecture and runnable minimal V2 load/unload probe. This phase prevents an
apparently compiling port from silently reviewing the wrong request or location.

### Phase 1: entrypoint, package and lifecycle shell

Files: `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/build.mjs`,
`src/tui.tsx`, fixture wrappers, and applicable `AGENTS.md` host guidance.

- Adopt the CLI `Plugin.define` entrypoint and preserve the stable plugin ID.
  Keep `./tui` pointing at `dist/tui.js` for the CLI-only architecture.
- Add compatible V2 package dependencies and OpenTUI/Solid peers after checking
  runtime resolution. The CLI guide currently gives OpenTUI `>=0.5.8` and Solid
  `>=1.9.0` examples; do not use those examples as proof of a tested version range.
- Update build externals for the actual `@opencode/*` runtime imports. Preserve
  the universal transform and avoid bundling a second Solid/OpenTUI runtime.
- Rework every exported `with*` fixture seam to the V2 lifecycle; preserve their
  semantics and keep them out of user config. Cleanup owns event unsubscriptions,
  timers, frame listeners, storage workers, subprocesses and transport cancellation.
  Handle partial setup failure and preserve the 3.5-second shutdown-drain budget.
- Establish local state-root resolution and location scoping from phase 0.

**Exit:** installed archive loads with the intended ID/options; disable/reload and
failed setup leave no duplicate slots, listeners, workers or model calls.

### Phase 2: typed host adapter, request identity and evidence

Files: `src/types.ts`, `context.ts`, `classification.ts`, `evaluate.ts`, evidence
collectors, `approval.ts`, `pending-refresh.ts`, and their source tests.

- Introduce focused reviewer-owned request/session/message/catalog projections
  rather than reproducing the entire V1 SDK. Keep original V2 identifiers and
  mandatory scope/arguments losslessly available for fresh comparisons.
- Normalize permission list/get/reply and errors at one boundary. Validate both
  session and location/connection scope, including responses that arrive after
  navigation, mode disable or request resolution.
- Port invocation lookup, pagination, genuine user intent and delegation using
  the phase-0 evidence. Preserve all byte/file/time bounds and whole-item omissions.
- Replace the V1 native-tool registry assumptions and MCP/resource wrapper rules
  with tested V2 origin rules, including Code Mode and namespaced/custom tools.
  Keep disabled categories in native ordering while skipping their review work.
- Port pending edit diff and skill evidence, including built-in skills whose
  filesystem location is unavailable. A required path in one published schema
  does not establish that every actual catalog item has an accessible local tree.
- Preserve shell literal parsing and file access controls. A CLI plugin can be
  attached to a remote server: never read a terminal-local path as evidence for a
  remote invocation merely because its pathname matches. The existing target is
  local Linux; prove co-location for local reads. Record remote evidence support
  separately and resolve any companion requirement before claiming it.

**Exit:** real synthetic V2 payloads pass identity/evidence tests, including changed
arguments, missing linkage, moved sessions, custom tools with native action names,
attachment-only prompts, resumed/nested delegation and all six review categories.

### Phase 3: controller, root-only presentation and approval

Files: `src/controller.ts`, `route-approval.ts`, `review-presentation.ts`,
`live-review-panel.tsx`, `review-description.tsx`, `appearance.ts`, `history-cover.ts`,
`history-view.tsx`, `tui.tsx` and command modules.

- Connect the normalized host to existing admission, mode, queue and approval state
  machines. Preserve fresh identity/native-priority checks immediately before the
  single-flight write, and never retry an invoked approval write.
- Port the existing stable app/sidebar ownership design using public V2 slots.
  The new `session.panel` API is available, but its focus/fullscreen/close lifecycle
  differs: closing disposes contributions and narrow terminals become fullscreen.
  Do not switch presentation models as a shortcut without proving the same product
  behavior and stable Markdown/countdown ownership.
- Port theme, selection, Markdown highlighting and frame proof. Revalidate geometry
  on the chosen host instead of assuming V1's sidebar dimensions or overflow
  heuristic in `routeCovered` still identify V2 native fullscreen.
- Preserve F34 across root, direct child, sibling and nested routes, including
  hidden report completion and root-return handoff. Visibility and queue ownership
  stay independent; no fabricated visible IDs, frames or hit-test results.
- Port history, statistics and enable/disable commands to reactive keymap layers.
  Confirm dialog coverage, modal ownership and cleanup on tab/route changes.
  Notification-click sidebar reveal must use a verified public command.
- Preserve the measured F32 limitation unless the selected host offers a proven
  public replacement. The V1 release audit's V2 reinvestigation and
  `scripts/smoke-v2-mouse-proof.mjs` show that V2.0.26 `hitTest` cannot prove ownership
  with mouse disabled. That release's public Dialog interface also lacks V1's
  open/depth accessors. Logical mounted/visible state, keymap mode and frame IDs
  did not distinguish actual coverage. That probe never loaded the reviewer and
  is not evidence of a completed V2 port. Do not force mouse tracking on.

**Exit:** normal and fast approvals pass real-TUI positive and negative cases;
countdowns, cancellation tombstones, retained streams and root-only display behave
as in F34. Missing root physical proof cannot authorize a write.

### Phase 4: history, statistics, mode persistence and notifications

Files: `src/history-*.ts`, `session-mode*.ts`, `usage.ts`, `lifetime-*.ts*`,
`notification-host.ts`, `notification-order.ts` and notification policy/backend.

- Preserve SQLite history and precomputed totals. The guide's `ctx.storage`
  server API and CLI `context.storage.store/memory` APIs are distinct; durable JSON
  storage is not automatically a replacement for the indexed transactional worker.
  Use host storage only where its scope/semantics fit. Keep old `usage-v1/` through
  `usage-v4/` untouched.
- Specify V1-to-V2 state discovery and session identity continuity before importing
  data. Preserve data even when old sessions cannot be mapped. In particular,
  do not interpret V2 session-not-found as permission to purge V1-owned history.
  Scope maintenance to a proven server/session lineage; test coexistence and
  idempotent restart without rebuilding lifetime totals from detail rows.
- Replace deletion-envelope checks using the exact pinned V2 error shape, HTTP
  identity and requested ID. Bare 404s, unavailable hosts and missing list entries
  still do not prove deletion. Preserve root-first cascading and the dirty gate.
- Rebind history to confirmed V2 permission-resolution and message events. Keep
  ambiguous client attribution conservative, per-POST usage and retained fast
  report persistence distinct from approval confirmation.
- Normalize V2 pricing/catalog tiers and host token/cost events. Do not guess a
  tier or collapse unknown usage to zero. Preserve the exact OpenRouter endpoint
  reported-cost rule for the separate reviewer transport.
- Port question/form and turn outcomes using actual V2 execution identities and
  terminal events, including interrupted turns. Reconcile reconnect snapshots
  without replaying historical attention or repeated permission alerts.
- Keep the existing Linux notification backend initially. V2 `attention.notify`
  is a possible later integration, but its documented shape does not establish
  parity for six custom sounds, click targets, close handles and queue-abort
  behavior. Do not mutate users' host notification settings to suppress duplicates.

**Exit:** clean and existing-state startup, disabled-mode history browsing,
concurrent instances, interrupted saves, deletion reconciliation, usage coverage,
notification queue handoffs and exact history-selection clicks all pass.

### Phase 5: migrate fixtures and CI alongside each feature

Files: `scripts/smoke-*.mjs`, `runtime-inventory.mjs`, `runtime-runner.mjs`,
`test-runtime.mjs`, `scripts/helper-tests.json`, `test/`, `.github/workflows/`.

- Port fixtures as the relevant feature lands; do not postpone all host verification
  to the end. Register exact V2 scenarios and valid flag combinations in the
  authoritative inventory, including a production V2 smoke case distinct from the
  historical synthetic mouse probe.
- Replace V1 fixture plugin exports, APIs, tool names, permission rules, event
  payloads and provider configuration with pinned V2 contracts.
- Use isolated global `cli.json` or `OPENCODE_CLI_CONFIG_CONTENT`, not project
  `tui.json`. Use standalone V2 hosts or precisely owned services, with the existing
  supervisor and at most two concurrent hosts. Do not kill shared services/tmux.
- Retain observation publisher flush/close ownership, painted palette selection
  postconditions and negative no-execution/no-notification windows.
- Preserve historical V1 runs as evidence, clearly classified; do not count them
  toward V2 verification. Update CI's host installation/version assertion and
  representative profiles only after the new host cases run successfully.
- If helper inputs change, update the release workflow's active-policy sparse
  checkout with all transitive files. Preserve read-only validation, immutable
  archive publication, provenance and no-upload-retry policies.

### Phase 6: documentation, package verification and release preparation

- Replace the README install example with one full global CLI config example using
  `$schema: "https://opencode.ai/v2/cli.json"` and
  `plugins: [{ package: "opencode-reviewer@<V2 release>", options: { ... } }]`.
  Preserve all existing option semantics and state the exact verified host.
  Keep permission rules in `opencode.json`, using V2 `shell` action examples.
- Explain that V1 users should stay pinned to `opencode-reviewer@1.0.2`; global V1
  terminal config may auto-migrate, but that does not port the plugin implementation,
  and project-local TUI settings are not migrated to project-local CLI settings.
- Update `AGENTS.md`'s V1 API/host/fixture references with the verified V2 contract
  without relaxing behavioral invariants. Record completed migration evidence here
  or in a focused disposition document. Keep release history out of the README.
- Run source/helper/build and package checks, then test the actual packed artifact
  on the pinned V2 host. Inspect exports, peers, external imports and exactly five
  archive files. No workspace-only resolution or absolute checkout imports.
- Prepare the next version only after parity criteria pass. Publication remains a
  separate release action through the existing verified tag workflow.

## 5. Verification matrix and commands

After implementation, use the selected supported Node/npm versions and run:

```sh
npm ci --ignore-scripts
npm run check
npm run check:package
node --test test/release-artifact-smoke.test.mjs test/npm-cli-smoke.test.mjs
```

The npm CLI smoke requires the verified npm version in maintainer guidance.
Runtime checks require a prior build. Update and inspect the inventory plan before
running the ported profiles with the pinned `OPENCODE_BIN`:

```sh
node scripts/test-runtime.mjs --plan --profile ci
node scripts/test-runtime.mjs --profile ci
node scripts/test-runtime.mjs --profile f34
```

These profile names exist today, but their current production fixtures target V1.
The implementation agent must port/register their V2 invocations before these
commands establish V2 coverage. Required coverage includes:

| Area | Required acceptance cases |
| --- | --- |
| Loading/lifetime | Packed install, options, clean project, restart, reload/disable, partial setup failure, no duplicate subscriptions/workers. |
| Evidence | Native shell/edit/skill, MCP tool/resource, custom/native-looking tool, external-directory stages, exact workdir, source symlinks, oversized mandatory and optional data, catalog failure. |
| Intent/scope | Latest root prompt including attachment-only, child/resume/nested delegation, moved session, different location/server, unknown ancestry, native-disabled blockers. |
| Approval | Normal positive/zero delay, fast stream/nonstream, Safe/Unsafe/errors, exact-request retry, changed arguments, read failure recovery, uncertain write remains manual. |
| F34/presentation | Root/child/sibling/nested routes at wide/narrow widths, hidden completion, root return, history cover, sidebar handoff, Cancel, explicit hide, palette/dialog/fullscreen, unrelated route/tab, mouse-disabled controls. |
| Transport | Truncation, duplicate keys, EOF/stop/DONE, correction history, rejected previews, retained fast reports, terminal usage, total deadline and no overlapping physical reads. |
| Persistence | Existing V1 data preserved, V2 new/restarted state, safe namespace separation, confirmed/ambiguous approval attribution, totals surviving deletion, offline deletion with exact error proof, shutdown drain. |
| Notifications | Snapshot silence, eligible event birth, silent queued/countdown requests, queue loss/handoff/reentry, question/form, success/failure/interruption, click during retained report/save delay/dialog, reconnect. |
| Release | Reproducible bundle, five-file artifact, actual installed package, complete active-policy checkout, provenance/offline publication checks. |

Use independent behavioral expectations in tests. A mock that merely reproduces
the adapter's mapping cannot establish native V2 semantics. Report exact fixture
commands and results; synthetic notification fixtures do not prove audible desktop
playback or focus behavior.

## 6. Completion and handoff checklist

- [x] Exact V2 host/client/plugin/runtime versions and phase-0 findings recorded.
- [ ] Mandatory evidence, location and delegation questions resolved with public APIs.
- [ ] CLI-only or documented companion architecture reconciled with package policy.
- [ ] Production imports and active fixtures no longer rely on V1 API shapes.
- [ ] Pending-request review remains advisory/once-only with unchanged model transport.
- [ ] Real V2 normal/fast/F34 and physical-coverage cases pass.
- [ ] Existing history/totals and mode semantics survive migration and server changes.
- [ ] V2 notifications, forms and execution outcomes pass queue/reconnect tests.
- [ ] Installed-package and CI/release-policy checks pass on the selected host.
- [ ] README and maintainer guidance describe the implemented, verified V2 contract.

For each completed phase, the implementation agent should add its commit ID, exact
test invocations/artifact paths, and any unresolved capability. A missing public
API is a named blocker with a minimal reproduction, not a reason to weaken identity,
approval, evidence or persistence guarantees.
