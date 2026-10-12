# V2 capability verification

Status: native Code Mode, trusted native-tool installation and visible-root V2 automation approved.
Production migration has not started. Section 3A of the migration plan supersedes
the historical upstream recommendation below; remaining phase 0 gates are open.

## Selected research target

| Component | Exact version |
| --- | --- |
| OpenCode Linux host | 2.0.26 |
| `@opencode/plugin`, `@opencode/client`, `@opencode/theme` | 2.0.26 |
| `@opentui/core`, `@opentui/solid`, `@opentui/keymap` | 0.5.17 |
| `solid-js` | 1.9.15 |
| Host Bun runtime, observed in CLI plugin | 1.4.2 |
| Verification driver Node/npm | 24.21.0 / 12.2.0 |

`npm view @opencode/plugin dist-tags --json` returned `latest: 2.0.26`.
The installed binary reports `opencode v2.0.26`. Renderer and Solid selections
come from the matching host's workspace catalog, not the broader documentation
peer ranges. These are research pins, not a production compatibility claim.

Published integrity values:

- Plugin: `sha512-8fu/WokR5hxGjclLQJKL0PAgsMEfh81MHnUBsJuhcnYUiTJ2ZQPLqSYAhzoYEQu/Vj4M65D3Xx7QS0Q9b9Z4fw==`
- Client: `sha512-0uqhXq6DJYjas3mc4roTyWAmhJpyO2gJaMcenoiA22RXJSOSIwPFho5K4qGmYDJGd5Fvvswh++Nr/wfjaHAYyg==`

Matching source: [9b4ec5714d481559990db0a816d5dec19541a814](https://github.com/anomalyco/opencode/tree/9b4ec5714d481559990db0a816d5dec19541a814).
The local extracted copy is `/tmp/opencode/f32-v2-2.0.26/opencode-2.0.26`.
Released plugin declarations are under
`/tmp/opencode/f32-v2-2.0.26/plugin/package/dist`.

## Executed public-contract probe

### Reproducible host selection for the resumed probes

PATH changed to `opencode v2.0.27` before this continuation. New probes explicitly
use the published, unmodified 2.0.26 binary installed separately:

```sh
npm install --prefix /tmp/opencode/reviewer-host-2.0.26 --ignore-scripts --no-audit --no-fund --save-exact @opencode/cli-linux-x64@2.0.26
```

- Binary: `/tmp/opencode/reviewer-host-2.0.26/node_modules/@opencode/cli-linux-x64/bin/opencode`.
- Version output: `opencode v2.0.26`.
- SHA-256: `d9123b9bcdb0a31f7ab9fe9812b58a9dc1768ad6d97e7b276dff1181813218c9`,
  identical to the earlier research binary.
- Published platform package integrity:
  `sha512-UIA2/1Ik8HaN54C4xp7H+OHgRfq995XUixrX+kLmFs8EPn1fAcmn3OoiN+3c3Vc3jEV/LHmj0Cy1SL6nW4wdGw==`.

### W1 catalog-size and synthetic provider-limit probe

```sh
OPENCODE_BIN=/tmp/opencode/reviewer-host-2.0.26/node_modules/@opencode/cli-linux-x64/bin/opencode node scripts/test-runtime.mjs smoke-v2-catalog.mjs
```

Final run: `.runtime/runtime-run-LiZ15e/results.json`.
Captures, actual model requests and metrics: `.runtime/v2-catalog-Ohn1XO/`.
The preceding catalog-only run also passed at `runtime-run-wHkNkT`.

| Outgoing presentation | Tools | Tool-definition bytes | System-message bytes | Result |
| --- | ---: | ---: | ---: | --- |
| Stock native catalog | 12 | 13,169 | 7,774 | Local model response accepted |
| Direct profile | 16 | 15,358 | 7,774 | Local model response accepted |
| Direct plus 129 synthetic shell-schema tools | 145 | 150,827 | 7,774 | Injected HTTP 400, execution failed, no retry |

The stock-catalog direct presentation adds 2,189 tool-definition bytes (16.6%).
These are measured UTF-8 JSON bytes, not token counts or billing estimates. The
cardinality additions reuse the actual native shell input schema but are synthetic;
they do not represent a user's MCP inventory. The endpoint's 128-tool maximum is
an injected provider contract. No live provider schema/count acceptance, model
quality, pricing or user-specific catalog limit has been established.

The fixture asserts unchanged schemas/descriptions/compatible options, removes
`pinned` and generated `execute`, receives the actual outgoing requests, observes
the terminal failure, and holds a 2.5-second no-tool/no-permission/no-retry window.
It verifies CLI cleanup stops publications. It also bundles the actual production
`review()` and `parseConfig()` into the isolated CLI and exercises streaming and
nonstreaming HTTP against a separate local reviewer endpoint while the profile is
active. Both reports validate; the two reviewer requests have no main-model tools
and do not enter the host's context hooks. This is transport integration, not a
production V2 permission adapter or UI. Executor/error equivalence is tested by
the separate Effect profile below; the catalog-size fixture uses a Promise
transform only for presentation measurements and executes no transformed tool.

Failures retained as evidence:

- `runtime-run-l5BNOD`: startup `--prompt` selected the default Zen model despite
  the fixture model config. New fixtures explicitly create sessions with the public
  client's `{ providerID: "fixture", id: "fixture" }` model reference and reject
  non-loopback model HTTP requests. No real provider credentials were supplied.
- `runtime-run-2D3Xwt`: V2's root CLI rejects `--model`; the explicit client model
  selection above replaces that invalid attempted fixture fix.
- `runtime-run-ZJ7nIv`: a setup-time catalog read precedes bundled browser-tool
  registration. The comparison now snapshots the catalog at activation.
- `runtime-run-goHt5i`: a setup-time profile transform precedes those later browser
  registrations, leaving their Code Mode options intact. Activating after initial
  model dispatch places this fixture transform after initialized registrations.
  This is not an installation-wide final-registration guarantee. Later registrations
  remain part of the W2 audited-profile gate.

### W1 direct identity, snapshots, refresh and error equivalence

```sh
OPENCODE_BIN=/tmp/opencode/reviewer-host-2.0.26/node_modules/@opencode/cli-linux-x64/bin/opencode node scripts/test-runtime.mjs smoke-v2-direct-tools.mjs
```

Final pass: `.runtime/runtime-run-0zBqXY/results.json`.
Captures and full synthetic protocol observations:
`.runtime/v2-direct-tools-tmBhob/results.json`.
The preceding identity/error-only run passed at `runtime-run-7434Yi`.

Verified on the stock host:

- Public Effect `tool.transform` changes only options, preserves the committed
  executor/input/output identities and removes incompatible `pinned` options.
  Context hooks remove generated `execute` without modifying other definitions.
- A real model request retained across profile activation/reload runs its old
  Code Mode executors. Two nested calls still share the outer source ID, explicitly
  remaining ambiguous. New direct calls have distinct content-item IDs.
- Two same-tool direct calls start concurrently with different inputs and identical
  permission scopes. A fixture barrier publishes B before A, reversing model order.
  Exact permission source IDs select the correct running assistant arguments;
  no arrival-order join is used. Directory and shell stages have four separate IDs.
- The 1.5-second pending window proves zero replies, shell writes or MCP execution.
  The original stages and MCP call then require five distinct `once` replies and
  produce exactly two fixture-local shell writes.
- A real MCP `tools/list_changed` SSE notification triggers a fresh `tools/list`,
  changes an existing schema and adds a tool. The profile replays over both
  namespaced entries. Retained old request/catalog values remain unchanged; future
  requests receive the changed schema and new direct tool. Two refreshed calls and
  a retained MCP call after profile disposal bring the total to eight once replies.
- A typed custom failure and actual native missing-file read are executed before
  and after the Effect profile. Their typed `execute.after` errors, durable errors,
  metadata and subsequent model-facing results compare equal.
- A direct model-request snapshot retained across profile/custom registration
  disposal still executes its captured version. Native interruption removes the
  held permission and stops the fixture executor without a third shell write.
- Native `glob`, `grep` and `opencode_models` remain directly callable and return
  independently asserted results. Code Mode catalog `search()` is deliberately
  unavailable while `execute` is removed. After disposal, actual Code Mode search
  finds the refreshed MCP tool and direct MCP presentation disappears.
- CLI disable drains its owned work and stops further publications.

The Promise-profile prototype failed at `runtime-run-0iKV8m` because the expected
typed failure hook was absent. Pinned `packages/plugin/src/promise/adapter.ts:491-502,
624-631` wraps even options-only updates through `Effect.promise`, where a rejection
is a defect. Switching the compatibility transform and typed controls to the
**public Effect API** fixed that probe without weakening its error assertions.
This is an important implementation boundary for any future profile.

Limitations: these custom staged calls intentionally delegate to a known native
shell executor inside the fixture; this does not prove native provenance or final
effective shell arguments. Remote MCP behavior is not frozen by a retained host
snapshot: the fixture server deliberately accepts old inputs after catalog refresh.
Plugin unload/reload is distinct from registration disposal. No installed reviewer
archive, complete capability matrix or live-provider behavior is claimed.

W1's local host probes are verified. The user subsequently selected **native Code
Mode**, so the investigated direct-tool profile will not ship. Its conditional
live-provider release gate is not applicable to that selected presentation, and
no live-provider direct-profile acceptance is claimed. Ambiguous nested calls
remain manual; Code Mode search and native presentation remain available.

The user also accepted the explicit assumption that installed plugins preserve
native tool meanings, do not replace/alias native executors and do not rewrite
commands after evidence capture. This is not host-issued provenance. Additional
MCP mapping/skill snapshot restrictions and remaining lifecycle gates still need
their own disposition. See the plan's execution steering and section 3A.8.

### W2 executed mapping boundaries

```sh
OPENCODE_BIN=/tmp/opencode/reviewer-host-2.0.26/node_modules/@opencode/cli-linux-x64/bin/opencode node scripts/test-runtime.mjs smoke-v2-profile-mapping.mjs
```

Pass: `.runtime/runtime-run-ARUSbK/results.json`.
Protocol observations/captures: `.runtime/v2-profile-mapping-2u0r8w/`.

- Both `a.b/echo` and `a_b/echo` publish identical catalogs; one `a_b_echo` survives.
  Actual endpoint calls identify the surviving server, without assuming ordering.
- An Effect transform replaces that executor while preserving every public
  descriptive field. Subsequent calls return the custom marker instead of MCP.
- A same-object context alias advertises a custom target as `read`. Before-hooks
  and durable tool items say `read`; after-hooks and actual results identify the
  custom target. The native registry `read` entry remains unchanged.
- Held MCP and custom model-request snapshots retain their original executors
  across later replacement, revision reload and disposal. Future requests restore
  the original MCP/native mappings. Nine calls finish with asserted durable and
  model-facing markers; no permission request/reply occurs.
- The fixture uses an initial isolated MCP allow rule. It proves mapping ambiguity,
  not pending-permission provenance or an enforceable installation seal. Existing
  `shadow-shell` results remain the pending native-looking negative control.

Contrary fixture observations were retained: `runtime-run-XkxmXe` showed native
input repair removing non-read-shaped alias arguments before alias resolution;
`runtime-run-vEIESm` showed a custom output without a declared output schema failing
before the expected after-hook. The final fixture uses native read-shaped input
and an explicit custom output schema. `runtime-run-s5tuU6` failed before host startup
because a version check had created non-private state directories; final setup
creates private state ancestors first. None is recorded as a host capability pass.

### W3 executed effective-evidence boundaries

Invoke each scenario with the same pinned host prefix above and
`node scripts/test-runtime.mjs smoke-v2-effective-evidence.mjs <scenario>`:

| Scenario | Runner result | Observations/captures |
| --- | --- | --- |
| `shell-rewrite` | `.runtime/runtime-run-1LYaH4/results.json` | `.runtime/v2-effective-evidence-shell-rewrite-sWDYKS/` |
| `skill-reload` | `.runtime/runtime-run-iQzsxp/results.json` | `.runtime/v2-effective-evidence-skill-reload-fqrRQW/` |
| `moved-location` | `.runtime/runtime-run-13RyMC/results.json` | `.runtime/v2-effective-evidence-moved-location-hQaUpi/` |

All three pass with pending-window checks, zero replies and zero shell execution.
Interruption removes the requests; CLI cleanup stops publications.

- Two concurrent direct shells have distinct exact source IDs and identical parsed
  permission scopes. Their stored arguments precede later tool-hook changes. The
  final shell hook changes command/cwd again, but exposes only command/cwd/env/shell/
  timeout, with no invocation IDs. The fixture deliberately makes pre-shell-hook
  inputs identical and never assigns final rows by timing or command-text joins.
- Description reload after dispatch exposes current definition B while a retained
  outgoing request still contains A. A current catalog is not a pending snapshot.
- A controlled native skill permission-evaluation barrier occurs after selection
  under catalog A. Once the permission is pending, public reload publishes B at
  the same skill ID/path. The request and source item contain no selected content.
  Selection of A relies on pinned native source ordering plus this controlled
  barrier, not a newly exposed public snapshot or pre-approval result.
- Live location-scoped hooks capture A and then B for the same session and relative
  workdir. Captured A remains A after the public session moves to B. This case
  interrupts before moving; active-step moves, observer restart/reconnect and
  workspace/remote filesystem ownership remain unverified.

Initial `runtime-run-nHfNBF` disabled the fixture transform because it incorrectly
required options-object reference identity. The corrected probe requires options
value equality while preserving executor/schema identity; all final scenarios pass.

### W5 executed synthetic visible-root proof

Invoke `smoke-v2-root-presentation.mjs mouse-on` or `mouse-off` through the pinned
runner prefix above. Results:

| Scenario | Runner result | Observations/captures |
| --- | --- | --- |
| `mouse-on` | `.runtime/runtime-run-WKgO7V/results.json` | `.runtime/v2-root-presentation-mouse-on-AJxfju/` |
| `mouse-off` | `.runtime/runtime-run-J5SwNx/results.json` | `.runtime/v2-root-presentation-mouse-off-567g9D/` |

The probe uses a real root sidebar anchor and an app-slot panel at its measured
geometry, actual Markdown highlighting promises, renderer FRAME events and
heading/body/footer hit ownership. Mouse-on establishes matching root proof;
mouse-off establishes none, even when the report is visibly painted. No fixture
changes mouse tracking. A timer never counts as a frame.

Bounded windows verify no proof/panel on direct, sibling and nested descendant
routes; narrow root/descendant hiding; native sidebar hide/show; palette, modal and
permission fullscreen coverage; and fresh proof after restoration. Every case
keeps the same native permission unresolved, with zero replies and shell writes.
Initial `runtime-run-ycNjQu` retained a reactive route object in historical samples;
the fixed probe copies route values at observation time instead of allowing old
samples to change during navigation.

This establishes a public synthetic physical-proof path, not production approval.
Countdown cancellation/non-rearm, normal/fast verification races, retained reports,
production history cover and tabs still require their implementation acceptance
cases. W5's production presentation gate remains open.

### W6 preparation: storage initialization boundary

Pinned source inspection, not a completed lifecycle probe:

- `packages/core/src/plugin/host.ts:609-635` namespaces storage solely by encoded
  plugin ID. Location is not included, so instances at different locations share
  the plugin's keys in the same host database.
- `packages/core/src/kv.ts:36-58` implements storage in the host database. `set`
  is an unconditional upsert. The public `get/set/remove/scan` interface has no
  compare-and-set, insert-if-absent or transaction operation. Concurrent
  read-then-set token initialization is therefore not a verified lineage protocol.
- `dist/app.d.ts` exposes app name/version/channel, not durable database identity.
  A process-global lock would not itself establish cross-process ownership or
  copied-database continuity. Those remain W6 host-test/design gates.
- `packages/plugin/src/host.ts:17-43` resolves server and TUI entries separately,
  preferring `server` then the package root for the server and `tui` for the CLI.
  A single archive file can be targeted by both exports at resolution time, but
  this does not establish that one default module loads in both runtimes. A real
  packed lifecycle test is still required before adopting that package shape.

### W2 preparation: public enforcement boundaries

Source inspection at the pinned commit establishes the following inventory. It
does not close W2's remaining host probes or the trust-model decision.

| Area | Observable/enforceable by the reviewer | Remaining assumption or gap |
| --- | --- | --- |
| Tool registry | Exact surviving IDs, schemas/options and known mismatches | No owner/history/immutable registration token or registry seal; later additions replace IDs |
| Native tools | Most core tools are already direct; five management/resource tools use Code Mode | Defaults are not provenance; `shadow-shell` remains a negative control |
| MCP names | Server-name normalization collisions can be detected | Raw tool-pair collisions and overwritten registrations need an audited inventory |
| Aliases | Request-local context definitions can be observed | Same-object context aliases are resolved after before-hooks; later hooks are not sealed |
| Plugin/config changes | Public plugin/config/MCP change events can invalidate reviewer eligibility | Not a pre-change veto or atomic execution fence; unchanged inventory is not unchanged execution |
| Shell inputs | Before-hooks expose declared input and source IDs | Final shell hook can change command/cwd but exposes no call IDs |

Native defaults: `shell`, `skill`, `subagent`, `read`, `glob`, `grep`, `question`,
`webfetch`, `websearch`, `edit`, `write`, `patch` are direct. The three edit tools
also declare `permission: "edit"`. `opencode_session_rename`,
`opencode_session_move`, `opencode_models`, `opencode_list_mcp_resources`, and
`opencode_read_mcp_resource` use Code Mode; session move is pinned. The model-specific
patch context hook also changes advertised edit/write/patch availability.

MCP effective IDs normalize each server/tool segment to `[A-Za-z0-9_-]`, replacing
other characters with `_`, then concatenate with `_`. `a.b/read` and `a_b/read`
collide; so do `a_b/c` and `a/b_c`. A custom registration can use the same final ID.
Public server inventory plus the surviving tool catalog cannot recover overwritten
raw registrations.

Pinned source references: `packages/core/src/tool.ts:177-204,225-284`,
`tool/runtime.ts:274-279`, `tool/mcp.ts:16-17,40-68,124-142`,
`session/model-request.ts:246-274`, `plugin/hooks.ts:69-94`,
`plugin/tool-input-repair.ts:21-35`, `shell.ts:263-278`,
`packages/schema/src/plugin.ts:10-49`, and public declarations
`dist/promise/tool.d.ts`, `mcp.d.ts`, `shell.d.ts`.

Audited restrictions would therefore be trust assumptions, not authenticated native
origin. A V2 permission-first design should not claim native/custom provenance just
from the requested action, tool name or a matching schema.

### Earlier direct-shell probe

```sh
node scripts/test-runtime.mjs smoke-v2-contracts.mjs
```

Final run: `.runtime/runtime-run-iXmxM4/results.json`, exit 0.
Captures: `.runtime/v2-contracts-EWGPHC/`.
Earlier run before correcting the `server.info` cancellation-options position:
`.runtime/runtime-run-GUo3N7/results.json`, exit 0.

The fixture uses an isolated HOME/XDG/project, supervised standalone V2 host,
local synthetic model endpoint and two observational plugins. It does not load
the reviewer. Only the fixture's F8 command submits a single `once` response to
its own pending `python3 fixture.py` request. The command creates one fixture-local
marker. Before F8, a 2.5-second negative window checks zero writes/replies and no
marker. Disabling the CLI plugin through its isolated global config invokes
cleanup and stops subsequent publications.

Verified facts:

- `Plugin.define` loads CLI and server entries; CLI options arrive in `ctx.options`.
- `ctx.client.session.get` and `session.message.get` return unwrapped objects.
- The pending message is an assistant `content` array with a running tool item.
  Its `id` matches `permission.source.messageID`; the tool call matches `source.id`.
- In **2.0.26**, pagination is `ctx.client.message.list`, and session-scoped
  permission methods are `ctx.client.permission.list/get/reply`. The moving docs
  and online OpenAPI use different grouping in places. Use the released types.
- `permission.request.list({ location })` provides the location-level snapshot.
- Reply input is `{ sessionID, requestID, decision: "once" }`; success resolves
  `undefined`, not `true`. The subsequent event is `permission.replied` with
  `{ sessionID, requestID, reply: "once" }`.
- The missing-session client error has `_tag: "SessionNotFoundError"`,
  `sessionID`, `name` and an Error `message`. JSON serialization omits the Error
  message and exposes no HTTP status. A future deletion adapter must validate
  the actual transport/decoding contract, not transplant V1 response checks.
- `server.info()` returns host version, PID, URLs, `paths.tmp` and capabilities;
  it does not expose the old plugin state-root path.
- Observed lifecycle events include `session.execution.started/succeeded`,
  `session.inbox.enqueued/delivered`, `session.step.*`, `session.tool.*`,
  `session.usage.updated`, `shell.created/exited` and permission events.
- Server `execute.before` records tool name, session, agent, message, call ID and
  input. Permission evaluation records source, action/resources and effect.
  Neither captured event carries invocation cwd or delegation-message identity.
- CLI context exposes no config/settings accessor; dialog exposes
  `show/set/clear/alert/confirm/prompt/select`, no V1 `open/depth`.

### Native-looking custom replacement reproduction

```sh
node scripts/test-runtime.mjs smoke-v2-contracts.mjs shadow-shell
```

Passed: `.runtime/runtime-run-WPxsl2/results.json`.
Captures: `.runtime/v2-contracts-ZeBtzm/`.

A public transform replaces the native `shell` registration with a custom
executor, retaining its schema, options and description. The custom executor
delegates to the captured original solely to preserve the same native permission
and safe marker operation. Observations prove:

- The replacement executor runs once.
- Before/after public catalog data and property names are identical; no origin
  or registration-owner field is added.
- The pending tool name and permission action remain `shell`; source remains
  `{ type: "tool", messageID, id }`.
- The read-only observations issue no reply during the negative window; fixture
  F8 then produces one confirmed once reply and cleanup succeeds.

This is a real example of a custom executor behind native-looking permission and
catalog data. Inspecting function source or assuming reserved native names cannot
replace missing authoritative provenance. The base case is now named `shell`;
the earlier recorded runs used the original `default` scenario name.

### Sidebar-state reproduction

```sh
node scripts/test-runtime.mjs smoke-v2-sidebar-state.mjs
```

Passed: `.runtime/runtime-run-kZDNgM/results.json`.
Captures: `.runtime/v2-sidebar-state-22nUwd/`.
Two isolated hosts run serially; 17 controls each span at least 1.5 seconds and
multiple real frames. There are zero permission requests, replies or execution
events. Both plugin cleanups stop callbacks and balance sidebar mounts/unmounts.

| Actual route/config input | Sidebar slot | Native toggle title | Captured native sidebar |
| --- | --- | --- | --- |
| Child / auto | Absent | Show sidebar | Absent |
| Child / hide | Absent | Show sidebar | Absent |
| Root / auto | Present | Hide sidebar | Present |
| Root / hide | Absent | Show sidebar | Absent |

The two child states also have identical composer mode, no observed session panel
and `ui.panel.current() === undefined`. Root returns independently prove the
host consumed each config change. Shortcut comparisons use deduplicated sets;
unmodified observations retain the host's duplicate registrations.

The documented disk/env alternative was tested too. Native Show can mount the
sidebar before disk changes from hide to auto. With an inline hide setting, native
Show paints the root sidebar while the merged inputs remain hide; remounting the
root hides it again. Independent disk/env reads therefore expose configured inputs,
not the host's committed preference plus local visibility override. These controls
do not establish an atomic replacement for the V1 guard.

## Checks

Continuation checks: `npm run test:helpers` passed all **118** tests after both W1
fixtures and release-policy inputs were added. `node --check` passed for both new
scripts, and `git diff --check` was clean. Exact host results are recorded above.
These are Phase-0 fixture changes; the production V1 test/build/package results
remain their earlier evidence rather than being relabeled as V2 verification.

- `node --test test/runtime-inventory.test.mjs`: 7 passed.
- `npm run test:helpers`: 118 passed, including active-policy sparse dependency
  closure after registering the probe and adding it to release validation inputs.

Implementation history: `c7546e1` adds the contract probe, runtime registration,
release-policy input and execution tracker.

## Source-verified differences awaiting production fixtures

### Native queue

The pinned host's `packages/tui/src/routes/session/index.tsx:198-215,1494-1512`
selects root permissions first, then every cached descendant in
`data.session.family(root)` order, retaining each session's request-array order.
All permissions precede session-family forms, followed by location-global forms.
Deep descendants now participate in the native root queue. Replace V1's
lexicographic root/direct-child comparators rather than retaining their ordering.

`data.session.root()` returns the furthest known ancestor even with incomplete
metadata. It is not proof of complete ancestry. Fresh identity and bounded ancestry
validation must remain independent from native cached queue selection.

### Presentation

**Approved V2 disposition (2026-10-12):** the user selected "require visible-root
presentation". Both normal and fast automatic replies will require physical proof
on the root conversation route; descendants permit no automatic write. This closes
the sidebar-state behavior decision without claiming a new observation capability.
Leaving root presentation after a countdown starts makes that request manual;
returning to root cannot revive it. Never-armed hidden completions may become
eligible after root presentation, with the normal countdown starting then.
Retained fast responses can continue after an already-dispatched approval.

The precise contract and acceptance cases are in `V2-MIGRATION-PLAN.md` section
3A.6 and `AGENTS.md`'s V2 migration section. Root paint/highlighting, queue ownership,
coverage, history cover, fast-mode boundaries and cancellation still need production
V2 verification. No new host test is claimed merely for recording this decision.
The source findings below explain the V1 F34 difference and remain valid.

Released public OpenTUI retains frame events, hit tests, numeric renderable
ownership, geometry, Markdown highlighting and scroll APIs. Mouse-enabled root
paint can use these mechanisms. The prior F32 mouse-disabled limitation remains.
OpenTUI 0.5.17 requires Node >=26.4.0 or Bun >=1.3.0 for renderer execution; current
Node 24 source-policy tests and actual Bun-host tests are different environments.

The pinned native dialog pushes `modal`; descendant browsing pushes `composer`.
Checking for base mode alone would incorrectly stop F34. A `modal` observation can
block an ordinary native dialog, but topmost mode alone is not positive uncovered
proof. Session-panel contributions expose their own fullscreen presentation.
Native permission fullscreen has no corresponding public state getter.

The sidebar still measures 42 columns. Its wide breakpoint uses available width
after vertical tabs, and app placement is affected by horizontal tabs/devtools.
The old root viewport heuristic needs fresh controls.

Effective `session.sidebar` has no public CLI context accessor. Native
`session-frame.tsx:106-129` suppresses descendant sidebars regardless of whether
the preference is `auto` or `hide`. The native toggle title also derives from
actual pane visibility. A server companion cannot observe terminal-local settings.
The real-host reproduction above confirms that these candidate public observations
do not distinguish the two descendant states. A reactive effective-settings/sidebar
API is the direct upstream remedy; no safe same-commit replacement has been proven.

### Persistence and packaging

- History identities currently hash an absolute directory scope. Directory equality
  across servers is not lineage. V2 missing-session errors cannot authorize deletion
  of V1-owned history without a separate continuity proof.
- `server.info()` lacks a stable database identity and local state-root path. Public
  server-plugin storage is namespaced by plugin ID (`core/src/plugin/host.ts:609-635`),
  providing a possible companion-managed identity channel. Concurrent initialization,
  restart and cross-location ownership would need tests before using it.
- Generated client `responseError` discards status for declared errors
  (`packages/client/src/promise/generated/client.ts:342-348`). An offline probe
  compiled that exact source and injected the same not-found JSON under 401 and
  404: both reject with identical properties. Results:
  `.runtime/v2-client-errors/results.json`. This is a synthetic transport control,
  not a claim that the native server sends such a mismatched error. It proves that
  the error object alone cannot satisfy the existing exact-404 maintenance guard.
  Preserve a status-aware boundary or a separately proven server-side absence API.
- `scripts/release-artifact.mjs` pins host 1.18.35 and rejects runtime dependencies.
  Phase 1 must reconcile those checks with the selected V2 dependency/peer strategy.
  A server companion also requires an explicit export/archive decision.

## Pending phase-0 gates

### Evidence blockers found in released contracts and pinned source

1. **No authoritative tool origin.** `packages/schema/src/tool.ts:22-42,92-102`
   and released `dist/promise/tool.d.ts` expose name, schema, executor and options,
   but no built-in/custom/MCP discriminator, registration owner or raw MCP mapping.
   `core/src/tool.ts:177-201` lets transforms replace entries at the same effective
   name. A current catalog name or matching description cannot establish origin.
2. **Nested calls lack a unique permission link.**
   `core/src/codemode/tool.ts:80-108` forwards the unchanged outer tool context to
   nested tools. MCP permission source uses that context's message/call IDs
   (`core/src/tool/mcp.ts:51-63`). Concurrent nested calls can therefore share source,
   action and resources while having different arguments. Arrival order or parsing
   the outer JavaScript cannot establish the required association.
3. **No exact consumed-delegation link.** Assistant messages and step-start events
   lack consumed user/inbox IDs. Prompt hooks expose the admitted user ID, but
   context/model hooks do not expose the new assistant ID. The runner can coalesce
   multiple steering inputs. Selecting the nearest prior user would change the
   required ownership contract (`schema/src/session-event.ts:203-223,328-342`;
   `core/src/session/runner/llm.ts:163-179,205-251`).
4. **No call-bound immutable definition or skill lookup.** Current tool/skill
   catalogs can change after a request captures its executor/selected skill.
   Native skill selection precedes permission publication, but the pending request
   carries no selected instruction snapshot/revision (`core/src/tool/plugin/skill.ts:48-59`).
   Optional generic definitions may be omitted factually; that does not solve
   mandatory native-origin and main-skill-instruction requirements.

The companion alternative was evaluated against public hooks and RPC. A
location-scoped `execute.before` observer can plausibly capture the live base
directory. It lacks final immutable effective input and missed-startup recovery;
the later shell hook exposes command/cwd without session/message/call IDs.
Neither hook supplies missing provenance or nested/delegation identity. Wrapping
executors, rewriting conversation metadata or serializing tool execution would
change the requested read-only architecture and still would not establish origin.

Pending edit previews are available in native `metadata.files`, and public
`skill.list` includes main instruction `content`. Those surfaces remain useful
once provenance and exact selected snapshot ownership are resolved.

Detailed static research and reading inventory:
`/tmp/opencode/v2-evidence-findings.md`. These source-supported conclusions are
separate from the executed direct-shell contract probe above.

### Remaining work, not marked complete

- Immutable invocation location and exact resumed/nested delegation linkage.
- Authoritative native/custom/MCP origin and captured effective definitions.
- Pending edit and skill evidence.
- Native root queue and physical root presentation/coverage under the approved
  visible-root contract; hidden-route approval authority is no longer required.
- Storage lineage, startup reconciliation and viable public companion architecture.
- Failed-setup/reload ownership and production worker compatibility.

Phase 0 stays open until these requirements have evidence or an explicit blocking
disposition. The successful synthetic probe does not establish production parity.

## Historical escalation (superseded by the stock-host plan)

The sidebar/F34 portion was disposed by the user's visible-root choice above.
Upstream work is outside the migration scope. Other capability gaps still require
stock-host evidence or an explicitly reconciled production contract; the original
negative observations below are retained as history.

**Issue in Phase 0**

- **Expected:** public V2 APIs support exact pending-invocation evidence and the
  existing F34 route-only approval exception without weakening origin, identity
  or explicit-hide guards.
- **Found:** latest published/installed 2.0.26 lacks authoritative registration
  provenance, unique nested-call permission linkage and consumed-delegation
  linkage. The tested CLI observations also lack effective sidebar-state authority.
  A read-only companion does not manufacture these facts.
- **Impact:** the required parity gate cannot pass. Renaming the entrypoint or
  casting V2 data into V1 shapes would conceal missing guarantees. Phases 1-6
  remain unstarted.
- **Options:** authorize upstream OpenCode public-API work, then resume against
  a host containing those changes; or explicitly revise the product scope and
  governing contracts for a reduced-capability V2 port. The latter is a behavior
  change, not completion of this plan. Retaining V1 until those APIs exist is
  also possible.

The upstream work should expose a read-only immutable invocation record with:

1. Unique invocation/parent IDs linked to permission IDs, including Code Mode.
2. Host-issued native/custom/MCP registration identity and replacement semantics.
3. Final effective arguments, location/filesystem identity and captured definitions.
4. Consumed user/inbox/delegation identities and the selected skill snapshot.
5. Pending-record retention across client reconnect/plugin reload.
6. A reactive terminal sidebar preference/override/route-suppression API, plus
   supported native coverage state for route-hidden approval checks.
