# OpenCode V2 migration plan

Status: W1 local-host probes verified; visible-root V2 automation approved; remaining phase 0 gates open.
Prepared: 2026-10-12.
Revised: 2026-10-12, following the user's requirement that upstream changes are unavailable.
Baseline: `v1.0.2` (`7cd1e561aea594ab9c7a99a32f30568579098747`), the final
OpenCode V1-compatible release. Current `main` also contains a subsequent README
edit. Preserve that work when starting implementation.

## 1. Goal and scope

### Execution tracker

Current execution tasks (resumed 2026-10-12; completed reading gates retained):

- [x] Read the complete revised plan and locate the first unchecked increment.
- [x] Preserve the existing plan edits and audit deletion as pre-existing work.
- [x] Derive the following ordered work and verification gates.
- [x] W1: direct-tool compatibility on unmodified 2.0.26, with live-provider acceptance deferred to the explicit release gate below.
  - [x] Register supervised synthetic fixtures and their active-policy inputs.
  - [x] Prove parallel reverse-order permission identity and independent stages.
  - [x] Verify error/cancellation, MCP refresh/disposal and retained old snapshots.
  - [x] Measure stock direct catalog size and injected provider-limit behavior.
  - [x] Establish representative provider/catalog acceptance or an explicit release gate.
  - [x] Run fixture and helper checks and record exact artifacts.
  - [x] Commit the verified W1 fixture increment (`test: verify stock V2 direct-tool compatibility probes`).
- [ ] W2: establish controlled-profile restrictions and obtain trust-model decision.
- [ ] W3: prove location/effective evidence and obtain per-kind scope decisions.
- [ ] W4: prove delegation subset and obtain remaining representation decisions.
- [ ] W5: prove presentation/coverage and obtain descendant-route decision.
  - [x] User selected visible-root presentation for V2 automatic approval.
  - [ ] Verify root physical proof and descendant cancellation/return behavior.
- [ ] W6: prove lineage/absence and packed companion lifecycle/configuration.
- [ ] W7: reconcile approved contracts before any dependent production port.
- [ ] Implement and verify Phases 1-6 sequentially against their existing exits.
- [ ] Keep evidence/checkmarks current and commit verified increments.
- [ ] Escalate unresolved gates with Expected/Found/Impact/Options.

The task-list and Edit tools are not exposed in this session. This hierarchical
tracker is maintained with the available patch tool instead.

### Execution steering: product goal

During W1, the user clarified the intended adaptation:

> adapt to v2 to keep the original goal: feed things that need human approval to a
> reviewer to try and valdate them automatically if deemed safe

That goal takes precedence over mechanical V1 API parity. The user repeated this
answer when asked about an audited-installation trust model; they did not select
one of the offered profile restrictions or identify a provider/catalog acceptance
target. Preserve this direction without recording unselected restrictions as
approved. Favor a V2-native pending-permission review design, preserving exact
request ownership, validated Safe results and once-only replies. If a V1-specific
contract prevents that design, state the concrete replacement contract before
dependent production work. The probes below remain evidence, not a requirement
to ship every investigated workaround.

On 2026-10-12 the user explicitly selected **"require visible-root presentation"**.
Section 3A.6 records the approved V2 replacement for F34's hidden-route approval
exception. This closes the route-choice decision, not the presentation test gate.

- [x] 1. Read the complete plan and existing completion state.
- [x] 2. Read referenced implementation, fixture, package and workflow files.
- [x] 3. Derive ordered implementation tasks and acceptance gates.
- [ ] 4. Implement sequentially and commit verified increments.
  - [ ] Phase 0: pin and probe public host capabilities; resolve architecture.
    - [x] Inspect exact installed host and released package contracts.
    - [x] Verify direct native request reads/reply, options and unload cleanup.
    - [x] Reproduce custom replacement behind native-looking tool/catalog data.
    - [x] Reproduce descendant auto/hide ambiguity and test disk/env alternatives.
    - [x] Plan stock-host workarounds for each blocker, without an upstream dependency.
    - [ ] Execute the stock-host probes in section 3A in order.
    - [ ] Resolve the explicit architecture/behavior decisions in section 3A.8.
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
escalation and exact artifact paths. Its upstream recommendation is historical:
section 3A below replaces that recommendation with a stock-host investigation and
decision sequence. The recorded negative observations remain valid. Phase 0 remains
incomplete; proposed workarounds are not verified capabilities.

Port `opencode-reviewer` to the public OpenCode V2 plugin and client APIs while
preserving its existing review, approval, history, statistics and notification
behavior. Target a separately verified V2 release, with exact dependencies and
real installed-package tests. Use an unmodified published host: no OpenCode fork,
local host patch, private imports, binary patching, or dependency on upstream
acceptance. Full parity remains the goal, not an established result. Where the
stock host cannot support it, obtain an explicit behavior decision before changing
the corresponding contract. Recommend the next stable package version be
`2.0.0`, reflecting the host compatibility break; choose the version at release
preparation, not during this planning task.

Keep `v1.0.2` as the V1 installation target. The migration guide's optional
combined V1/V2 export is unnecessary for this release policy.

The starting architecture of this repository is **CLI-only**:
`src/tui.tsx` exports `{ id, tui }`, and `package.json` exposes `./tui`. It does not
return a V1 server-hook map. Keep reviewer policy, transport, UI and replies in the
V2 CLI entrypoint. Evaluate a public server companion and an opt-in direct-tool
compatibility profile as described in section 3A. They are additions requiring
verification, not a mechanical rewrite to server hooks. In particular, the server guide's
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

These are the baseline acceptance requirements. Section 3A identifies proposed
stock-host exceptions and the decisions required to adopt them. An unchecked
proposal does not override these requirements or `AGENTS.md`.

Read the current `AGENTS.md` and the final dispositions in the
[V1 release audit](https://github.com/mightykatun/opencode-reviewer/blob/v1.0.2/AUDIT.md)
before implementation. The archived audit is also available with
`git show v1.0.2:AUDIT.md`, even if absent from the working tree. Historical audit
findings are not all outstanding defects. F34's completed contract remains the V1
baseline; the approved V2 route behavior is specified in section 3A.6.

- Advisory by default; only `autoApprove` enables automatic `once` replies.
  Never write permission rules, send `always`/`reject`, execute commands or apply
  edits. Existing native allows continue to skip pending-request review.
- Deduplicate permission requests, not tool invocations. External-directory and
  operation permissions remain independently reviewed where the host emits both.
- Normal approval requires a completed, validated Safe report and the configured
  monotonic countdown. Fast mode keeps its preview/full-response distinction,
  no countdown, exact request recheck, retained response and once-only write.
- Show live, retained and history panels only on the root conversation route.
  In V2, both normal and fast automatic replies require visible-root presentation;
  descendant browsing grants neither presentation nor native queue ownership.
- Preserve actual painted ownership and normal-mode history-cover proof at the
  root. V2 has no F34 hidden-route exception. Cancel, genuine coverage/hiding,
  descendant or unrelated navigation, unknown ancestry and uncertain writes retain
  their blocking/tombstone behavior under section 3A.6.
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
- The released 2.0.26 client uses `permission.request.list` (location-scoped) and
  `permission.list/get/reply` (session-scoped), although moving documentation groups
  some operations differently. Reply requires
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
- Released 2.0.26 `message.list` uses body `cursor.previous/next`, with `order` only on the
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

## 3A. Stock-host recovery strategy

### 3A.1 Scope, architecture and evidence standard

The user cannot make upstream changes. The migration must be installable on an
unmodified, pinned, published OpenCode release. Do not turn the earlier proposal
for a host compatibility patch into a release prerequisite or ask the user to
maintain a custom OpenCode build.

Recommended candidate architecture:

1. **CLI reviewer:** retains admission, configuration switches, model transport,
   normal/fast state machines, rendering, history and one-time replies.
2. **Public server companion:** supplies bounded evidence through authenticated,
   location-scoped RPC and maintains records it actually observed. It never
   decides permissions, executes proposed operations, or alters user messages.
3. **Opt-in compatibility profile:** presents selected tools as direct tools via
   public transforms. This changes main-model tool presentation and therefore
   must be separately configured and documented. It is not the read-only collector.

First test this design in isolated fixtures. Do not enable it in the user's active
configuration while investigating. A companion alone does not solve missing
provenance, nested identity, final shell inputs, or selected skill ownership.

For every capability record one of: verified equivalent, verified only within a
stated compatibility profile, permitted optional omission, or unresolved mandatory
gap. Keep request identity, evidence completeness, and presentation eligibility
separate. Optional evidence omission alone is not a new automatic-approval veto.
Missing mandatory arguments or unproven request linkage cannot authorize a review
as though the facts were known.

### 3A.2 Blocker 1: authoritative native/custom/MCP identity

**Target:** preserve category switches and select evidence by the actual executor,
including custom tools requesting native-looking permission names.

**Candidate stock-host workaround:** a controlled compatibility profile with an
explicit, audited mapping for the pinned native tools and approved MCP/custom
registrations. Inventory the actual supported plugins, transforms, aliases and
MCP name normalization. Require collision-free mappings, no built-in replacements,
and no unaccounted executor or definition rewrites within that profile.

This is an installation constraint, not host-issued provenance. Neither matching
descriptions nor an unchanged inventory proves that a replacement did not occur.
Determine which restrictions the public APIs can actually enforce or detect; list
the remainder as trust assumptions. Do not advertise automatic detection of every
unsupported transform or silently classify an unknown request as native.

- [ ] Probe the controlled native, custom and MCP mappings, including sanitized
  name collisions, aliases, registration reload and native-looking custom actions.
- [ ] Reuse `shadow-shell` as a negative control. It must either be excluded by a
  genuinely enforced profile boundary or demonstrate the profile's documented
  reliance on audited configuration. A name/schema comparison is not a passing fix.
- [ ] Decide whether the user accepts the controlled-profile trust model.
- [ ] If not, retain this as an unresolved mandatory gap for affected categories;
  propose an explicit reduced category contract rather than inventing provenance.

**Parity disposition:** conditional on a restricted installation; unrestricted
native/custom/MCP parity on 2.0.26 remains unproven.

### 3A.3 Blocker 2: Code Mode nested-call identity

**Preferred workaround to test first:** use public `tool.transform` to set
`options.codemode: false` for the supported tools, preserving all other compatible
options, schemas and executors. Account for the `pinned` option's incompatibility
with the direct-tool option shape. Remove generated `execute` from primary outgoing
tool definitions through the public context hook so the model uses direct calls.
Do not write permission rules or alter conversation text to do this.

Direct calls can retain normal host parallelism; each has a distinct assistant
content-item ID. Keep permission-request IDs distinct when a direct invocation
produces directory and operation stages. This solves only nested correlation,
not provenance or final effective argument capture.

- [x] Verify transform order, catalog refresh, namespaced MCP tools, registration
  disposal, context hooks and model-facing definitions on the pinned host.
- [x] Execute two parallel direct calls to the same tool with different inputs and
  identical permission scopes; reverse permission publication order deliberately.
- [x] Prove one-to-one source/argument matching, separate directory stages and
  unchanged cancellation/error propagation without serializing execution.
- [ ] Test model/provider tool-count and schema limits with a representative real
  catalog. Direct exposure can increase prompt size and cost; record the impact.
- [x] Test profile activation/reload with an old model-request snapshot retained.
  Never relabel its nested calls as direct. Missing exact linkage stays unavailable.
- [x] Verify the profile does not remove the reviewer's separate transport or
  interfere with native search/discovery beyond its documented presentation change.

W1 evidence: `smoke-v2-direct-tools.mjs` passed in
`.runtime/runtime-run-0zBqXY/results.json`; `smoke-v2-catalog.mjs` passed in
`.runtime/runtime-run-LiZ15e/results.json`. The Effect profile preserves committed
executors and typed error behavior; the Promise options-update adapter does not
establish that guarantee. Native `glob`, `grep` and model discovery were exercised.
Code Mode tool search is intentionally unavailable while `execute` is removed and
returns on disposal. Real provider/schema acceptance and user catalog cost remain
unverified. Details and earlier contrary observations are in `V2-CAPABILITIES.md`.
`npm run test:helpers`: 118 passed after the final fixture updates; both new scripts
pass `node --check`, and `git diff --check` is clean.

**W1 release gate:** if W7 adopts direct-tool presentation, V2 publication remains
blocked until an explicitly selected representative provider/model and real catalog
accept the full outgoing schemas and tool count in streaming and nonstreaming runs.
Record the exact model/provider, catalog composition, definition bytes, available
usage/cost and errors, plus native discovery and separate reviewer transport results.
The injected local limit is not provider acceptance. No live provider was selected
or authorized for these synthetic probes. This explicit deferred release gate closes
the W1 investigation increment only; the unchecked live-provider test above and the
direct-profile adoption decision remain open. If W7 chooses native presentation,
record that disposition instead of treating untested direct presentation as supported.

**Decision:** accept direct-tool presentation as the V1-like compatibility route,
or retain native Code Mode and explicitly restrict review of ambiguously linked
calls. Do not parse outer JavaScript, match by arrival order, or serialize tools
as an implicit workaround. Any batching facility must receive the same analysis.

### 3A.4 Blocker 3: exact immediate delegation

**Candidate workaround:** a companion records public prompt-admission, delivered
inbox and step observations, with exact session/message IDs, in a reconciled
ledger. Inspect whether the pinned runner's public causal ordering plus durable
message state proves an association for a defined subset of calls. Observing an
admission or temporal proximity alone does not prove consumption by a step.

- [ ] Probe initial child delegation, tool-only continuation, resumed child,
  nested child, sibling child, queued follow-up and multiple coalesced steers.
- [ ] Probe retry, compaction, duplicate/concurrent admission and observer reload.
- [ ] Distinguish delivered genuine user input from synthetic user-role messages.
- [ ] Only populate exact delegation when ownership is demonstrated. Preserve root
  intent separately, including the latest attachment-only prompt behavior.
- [ ] If exact linkage is unavailable, use the existing factual optional-context
  omission path where permitted. Do not insert an older or nearest user message.

If multiple consumed inputs can be proven, propose an ordered delegation/steering
collection rather than pretending they have one V1 parent. That representation
requires a user decision and corresponding prompt/evidence tests. Do not mutate
message metadata, force delivery mode, or serialize subagents to create a link.

**Parity disposition:** simple proven associations may be recoverable; exact
resumed/coalesced linkage remains an experiment. Explicitly accepting omission is
a feature change, not full delegation parity or a blanket ban on subagent review.

### 3A.5 Blocker 4: invocation location and immutable effective evidence

**Candidate workaround:** maintain a bounded server-side evidence ledger for
continuously observed direct calls. Capture the location-scoped companion's
directory/project/workspace at invocation, not the CLI path or current session
placement. Index by connection/companion epoch, location, session, assistant and
call IDs, with separate permission links. Serve immutable copies through RPC.

Treat the evidence kinds separately:

| Evidence | Stock-host approach | Remaining condition |
| --- | --- | --- |
| Base invocation location | Capture in the location-scoped execution observer | Prove moved-session behavior and execution filesystem scope. |
| Direct tool arguments | Read exact source item and compare with captured execution input | A before-hook is not a final boundary if a later hook can rewrite input. |
| Effective tool definition | Capture the definition associated with a proven registration snapshot | Current `tool.list()` is not proof; omit optional definitions if binding fails. |
| Shell command/cwd | Establish unmodified behavior in the controlled profile | Final shell hook lacks call IDs; prohibit unsupported rewriting only through an accepted profile restriction, never a timing join. |
| Edit previews | Consume exact pending `metadata.files` | Require valid classification/linkage; no full target reads to replace previews. |
| Main skill instructions | Resolve a proven selected catalog snapshot | Stable current content is insufficient if selection/reload can race. |

- [ ] Probe a moved session, late argument rewrite, concurrent shells, registry
  replacement between model dispatch and permission, and skill reload after selection.
- [ ] Evaluate executor instrumentation only if observation cannot capture the
  boundary. It would be a separate architecture decision because it changes tool
  registrations. It must preserve arguments, results, signals and execution count,
  and cannot by itself prove origin or the native skill's internal selection.
- [ ] Investigate whether a no-reload/no-rewriting compatibility profile can be
  enforced using supported APIs. If merely assumed, record that explicitly for
  the same controlled-installation decision as provenance.
- [ ] Never replace the native skill executor or pin a different skill selection
  silently. If exact mandatory main instructions remain unavailable, leave that
  review unsupported pending an explicit category-scope decision.
- [ ] Subscribe before reconciliation, use a bounded sequence/revision protocol,
  and recheck the pending request after evidence lookup. Filter RPC by location.
- [ ] Retain observed records through CLI reconnect and all pending permission
  stages. Test companion unload/restart independently: lost records are unknown,
  not reconstructed from newer catalogs. Persist only if lifecycle/privacy and
  cleanup semantics are explicitly designed and tested.
- [ ] Preserve deadlines, abort propagation, whole-item limits, descriptor/symlink
  checks and actual I/O ownership. An evidence RPC accepts scoped identities, not
  arbitrary executable code or unrestricted paths.

**Parity disposition:** live location capture and bounded evidence transport are
plausible. Mandatory final arguments, native skill snapshots and recovery after
missed capture remain per-kind gates; a companion is not a universal solution.

### 3A.6 Blocker 5: sidebar hiding versus descendant suppression

The existing 17-control probe disproves the tested equivalence between public
observations and effective sidebar preference. Disk/env polling, remembered root
visibility, command titles and intercepting one toggle do not restore that fact.
Do not repeat those as a new solution without identifying a new observable.

**Decision: option 1 approved on 2026-10-12.** The user selected
"require visible-root presentation". The alternatives below retain the decision
context; option 2 is not the selected V2 contract.

1. **Physical-visibility-only automation:** keep root-only rendering and automatic
   approval on a proven root panel, but stop automatic approval during descendant
   browsing. Apply genuine visibility-loss/cancellation semantics consistently;
   do not quietly pause then rearm a canceled request. This preserves the explicit
   hide guard but removes F34's continuation behavior.
2. **Reviewer-owned background continuation:** introduce an explicit reviewer
   preference/command that controls automation while browsing descendants. Native
   sidebar hiding would no longer be the authoritative off-switch on those routes.
   Cancel/mode disable remain authoritative. This retains part of the browsing
   workflow but changes the existing product contract and requires user approval.

Option 2 still needs independently proven dialog/fullscreen coverage. A new
preference cannot manufacture that proof; if coverage cannot be distinguished,
background continuation remains unavailable. Neither option is full F34 parity.
The approved V2 contract is:

- The current route must be the proven root conversation, with actual reviewer
  presentation ownership. Merely being on a root route does not prove visibility.
  Native dialogs/fullscreen, sidebar hiding, unowned frames and unknown ancestry
  still block a write. Do not force mouse tracking or sidebar visibility.
- Both normal and fast mode make zero automatic replies on direct, sibling or
  nested descendant routes. Source-session ancestry and native queue priority
  remain independent: a descendant request may be approved when it belongs to the
  root's native queue and is physically presented on the root route.
- Normal mode still requires the completed validated Safe report, final Markdown
  highlighting, matching paint and configured countdown. Losing root presentation
  after the countdown starts permanently makes that request manual. Returning to
  root, remounting or re-enabling must not restart or rearm it.
- An assessment may finish while browsing descendants. If automation was never
  armed and no cancellation/uncertain-write tombstone exists, it may first become
  eligible after returning to a proven root presentation. Normal mode starts its
  countdown then; elapsed hidden time does not satisfy the delay.
- Fast mode retains its configured preview/full-response requirement and no
  countdown, but its fresh verification and write boundaries require actual root
  visibility. All existing cancellation and uncertain-write guards still apply.
- Evaluation and already-dispatched retained fast responses can continue while
  route-hidden; this does not permit a new automatic approval write. Preserve their
  usage/history finalization and existing abort conditions.
- The separate normal-mode production-history-cover exception remains root-scoped
  and requires actual hit-test proof. Fast mode still has no history-cover exception.

Acceptance must cover root -> child/sibling/nested -> root during countdown and
fresh verification, newly completed reports while hidden, normal positive/zero
delay and fast stream/nonstream behavior, no writes on descendant routes, genuine
root covers/hiding, canceled-request non-rearm and retained response completion.
V1 F34 hidden-approval successes become explicit V2 behavior differences, not
passing parity tests. Root frame/coverage verification is still pending.

- [x] Dispose the hidden-route sidebar-state gap through the approved visible-root contract.
- [ ] Test root frames/highlighting, modal/native fullscreen, tabs, narrow widths,
  history cover and mouse-disabled controls independently from sidebar state.
- [x] Obtain the chosen route contract before porting F34 behavior.
- [ ] Retain root-only live/history display and all cancellation/uncertain-write
  tombstones. Never force sidebar visibility, navigate to root to probe state,
  fabricate frames, or replace native approval dialogs.

### 3A.7 History lineage, deletion proof and package feasibility

These are adapter tasks with concrete stock-host candidates:

- [ ] Evaluate a durable random namespace in server-plugin storage as the reviewer
  lineage identity. Inspect actual storage lifetime/location/database scope first.
  Test concurrent first initialization across locations, process restart, copied
  storage and database replacement. A read-then-set race is not an acceptable
  initialization protocol. A random token alone does not prove database continuity.
- [ ] Keep process/connection epochs separate from durable lineage. Do not derive
  lineage from a URL, PID or directory string. Preserve V1 history until an explicit
  continuity mapping exists; V2 absence never deletes unrelated V1-owned rows.
- [ ] Prove either a status-preserving authenticated transport for session reads
  or a server-companion absence RPC using the direct server error contract. The
  latter must distinguish exact typed not-found from auth/transport/plugin errors
  and validate session ID and lineage. Keep healthy reconciliation and dirty gates.
- [ ] Do not recreate a client by guessing credentials or rediscovering a different
  service. Determine what the connected context actually exposes before proposing
  a custom-fetch transport. Reuse connected-client RPC when appropriate.
- [ ] Repeat genuine absence, injected 401/404 envelopes, disconnect, cross-server
  and stale-response controls. If deletion authority is unresolved, retain data;
  an interim lack of offline deletion is an explicit privacy/behavior decision.
- [ ] Prototype companion packaging before porting production code. First test a
  single-file arrangement preserving the five-file archive and supported default
  exports, without eager CLI-only imports on the server. Do not assume it works.
  If separate `dist/server.js` is required, obtain an explicit six-file-package
  exception and update artifact/release checks together during implementation.
- [ ] Specify server-plugin plus global CLI-plugin configuration and ownership.
  Test standalone/shared service, multiple locations and multiple terminals, with
  no duplicated collection, RPC registrations, usage or approval writes.

### 3A.8 Ordered execution and decision gates

Run these increments serially; commit verified fixture/adapter increments and
record exact artifacts. Proposed new fixture names are not existing commands.

| Order | Deliverable | Go/no-go result |
| --- | --- | --- |
| W1 | Direct-tool compatibility fixture | Exact identity under parallel calls, stage separation, refresh and retained old snapshots; catalog cost/limits measured. |
| W2 | Provenance/profile fixture and compatibility inventory | State enforceable restrictions and trust assumptions; obtain controlled-profile decision. |
| W3 | Location/effective-evidence ledger fixture | Per-kind final-input/snapshot ownership and reconnect behavior proven, or explicit category decisions recorded. |
| W4 | Delegation fixture | Exact subset established; omission or multi-input representation explicitly decided for the remainder. |
| W5 | Presentation/coverage fixture | Prove root behavior and the approved visible-root contract in section 3A.6, including descendant no-write and cancellation controls. |
| W6 | Lineage/absence and packed companion fixture | Durable ownership, deletion proof, lifecycle and package/configuration shape verified. |
| W7 | Reconciled production contract | All required decisions recorded; capability document and applicable maintainer contracts aligned before Phase 1. |

Decision record (checked only when explicitly supplied):

- [ ] Accept opt-in direct-tool presentation and its model-context cost.
- [ ] Accept a controlled-installation provenance/evidence trust model, if needed.
- [ ] Approve any executor instrumentation, packaging exception or additional setup.
- [ ] Accept precise delegation omissions/multiple-input representation, if needed.
- [x] Choose the descendant-route behavior: require visible-root presentation (2026-10-12).
- [ ] Approve any remaining category or offline-maintenance limitation explicitly.

For a failed gate, report Expected/Found/Impact/Options with the smallest concrete
behavior choice. Continue independent probes, but do not begin dependent production
work or silently mark full parity complete. There is no fallback to upstream work.
If no acceptable stock-host scope exists, record that outcome and preserve the
working V1 release rather than publishing a misleading compatibility claim.

## 4. Implementation sequence

Use small coherent commits. Each phase records its exact host/package version,
commands, results and remaining gaps. Continue dependent work only after the
phase's exit criteria are met.

### Phase 0: pin the host and resolve capability questions

1. Pick an exact supported V2 release and matching `@opencode/plugin`,
   `@opencode/client`, OpenTUI and Solid versions. `2.0.26` is an existing research
   baseline, not a verified production target. Inspect package exports and runtime
   requirements, including Bun/Node SQLite worker behavior.
2. Build isolated contract probes using the existing runtime supervisor. Keep
   observation probes read-only; run profile transforms and any approved
   instrumentation only in their dedicated synthetic fixtures.
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

4. Execute W1-W6 in section 3A using public APIs. Evaluate the companion and
   compatibility profile separately: collection stays observational; direct-tool
   transforms change model-facing tools only under the approved profile. Keep
   permission decisions and once replies in the CLI. Design location filtering,
   cancellation, retained records and startup reconciliation before production use.
5. A companion changes configuration, exports and potentially packaging. Resolve
   that architecture explicitly against the five-file package/AGENTS constraints
   before implementation; do not silently expand the archive or import host internals.
   If neither public client nor public hooks provide the required evidence, record
   the stock-host limitation and obtain the specific scope decision from section
   3A.8. Upstream work, a fork and a patched binary are outside this plan.

**Exit:** checked-in capability findings, pinned dependency choice, confirmed
architecture, completed W1-W7 dispositions and runnable minimal V2 load/unload
probe. Update the capability document's historical escalation with the chosen
stock-host disposition, without deleting contrary evidence. This phase prevents an
apparently compiling port from silently reviewing the wrong request or location.

### Phase 1: entrypoint, package and lifecycle shell

Files: `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/build.mjs`,
`src/tui.tsx`, fixture wrappers, and applicable `AGENTS.md` host guidance.

- Adopt the CLI `Plugin.define` entrypoint and preserve the stable plugin ID.
  Keep `./tui` pointing at `dist/tui.js`; add the companion entrypoint only through
  the packed layout approved at W6. Enforce the chosen exact archive inventory.
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
- Implement companion/profile setup, version handshake, location-scoped RPC,
  evidence epochs and idempotent cleanup as approved in W7. Missing or mismatched
  companion state must never be silently replaced with terminal-local evidence.

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
  with tested W2 classification and W1 direct-call rules, including namespaced/custom
  tools and old/unsupported Code Mode snapshots. Apply approved profile restrictions
  explicitly; do not present an audited mapping as authoritative host provenance.
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
attachment-only prompts, resumed/nested delegation and all six review categories,
with any W7-approved omission/category exceptions independently asserted. Report
equivalence separately from intentional compatibility-profile behavior changes.

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
- Implement the approved visible-root contract in section 3A.6 across root, direct
  child, sibling and nested routes. Hidden completion cannot approve or consume a
  countdown; root return cannot revive canceled work. Preserve retained responses.
  Visibility and queue ownership stay independent; no fabricated visible IDs,
  frames or hit-test results. Retain V1 F34 hidden-approval cases as documented V2
  behavior differences rather than labeling them passing parity tests.
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
countdowns, cancellation tombstones, retained streams and root-only display obey
the approved visible-root contract. Missing root physical proof cannot authorize
a write; both normal and fast descendant-route approval remain blocked.

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
  W6 may instead establish an authoritative typed server-side absence RPC; do not
  require HTTP status for that different boundary without first defining its proof.
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
- Include the approved companion's server configuration and explicit compatibility
  profile setup when required. Describe direct-tool presentation, supported plugin
  restrictions and any approved route/evidence differences as user behavior, without
  adding migration warnings to the UI or claiming unrestricted V1 parity.
- Explain that V1 users should stay pinned to `opencode-reviewer@1.0.2`; global V1
  terminal config may auto-migrate, but that does not port the plugin implementation,
  and project-local TUI settings are not migrated to project-local CLI settings.
- Update `AGENTS.md`'s V1 API/host/fixture references with the verified V2 contract
  and only the behavior exceptions explicitly approved at W7. Record those decisions
  before the dependent implementation, not retroactively. Record migration evidence here
  or in a focused disposition document. Keep release history out of the README.
- Run source/helper/build and package checks, then test the actual packed artifact
  on the pinned unmodified V2 host. Inspect exports, peers, external imports and the
  exact W6-approved archive inventory (five files unless an exception was approved).
  No workspace-only resolution or absolute checkout imports.
- Prepare the next version only after the approved compatibility criteria pass,
  with remaining differences documented accurately. Publication remains a
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
| Visible-root presentation | Root/child/sibling/nested routes at wide/narrow widths; zero descendant automatic replies; countdown cancellation and non-rearm on root return; first eligibility after hidden completion; retained responses; root history cover, sidebar handoff, Cancel, explicit hide, palette/dialog/fullscreen, unrelated route/tab and mouse-disabled controls. |
| Transport | Truncation, duplicate keys, EOF/stop/DONE, correction history, rejected previews, retained fast reports, terminal usage, total deadline and no overlapping physical reads. |
| Persistence | Existing V1 data preserved, V2 new/restarted state, safe namespace separation, confirmed/ambiguous approval attribution, totals surviving deletion, offline deletion with exact error proof, shutdown drain. |
| Notifications | Snapshot silence, eligible event birth, silent queued/countdown requests, queue loss/handoff/reentry, question/form, success/failure/interruption, click during retained report/save delay/dialog, reconnect. |
| Release | Reproducible bundle, five-file artifact, actual installed package, complete active-policy checkout, provenance/offline publication checks. |
| Stock-host profile | W1-W6 fixtures, direct parallel calls, catalog limits/refresh, old snapshots, controlled classification assumptions, companion loss/reconnect, approved route differences, exact approved package inventory. |

The matrix incorporates the approved visible-root replacement for V1 F34. W7 must
explicitly annotate any other approved changed expectations before implementation.
Do not quietly delete a negative control or count manual behavior as equivalent
automatic behavior.

Use independent behavioral expectations in tests. A mock that merely reproduces
the adapter's mapping cannot establish native V2 semantics. Report exact fixture
commands and results; synthetic notification fixtures do not prove audible desktop
playback or focus behavior.

## 6. Completion and handoff checklist

- [x] Exact V2 host/client/plugin/runtime versions and phase-0 findings recorded.
- [x] No-upstream constraint and blocker-by-blocker stock-host plan recorded.
- [ ] W1-W7 verified/disposed with explicit architecture and behavior decisions.
- [ ] Mandatory evidence, location and delegation questions resolved with public APIs.
- [ ] CLI-only or documented companion architecture reconciled with package policy.
- [ ] Production imports and active fixtures no longer rely on V1 API shapes.
- [ ] Pending-request review remains advisory/once-only with unchanged model transport.
- [ ] Real V2 normal/fast and physical-coverage cases pass under the approved
  visible-root contract, accurately documenting the V1 F34 behavior difference.
- [ ] Existing history/totals and mode semantics survive migration and server changes.
- [ ] V2 notifications, forms and execution outcomes pass queue/reconnect tests.
- [ ] Installed-package and CI/release-policy checks pass on the selected host.
- [ ] README and maintainer guidance describe the implemented, verified V2 contract.

For each completed phase, the implementation agent should add its commit ID, exact
test invocations/artifact paths, and any unresolved capability. A missing public
API is a named stock-host limitation with a minimal reproduction. Resolve it through
a verified public workaround or an explicit scope decision, never an inferred
identity, an unsupported completion claim or a hidden upstream dependency.
