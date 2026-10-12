# V2 capability verification

Status: Phase 0 blocked on public-API gaps, with real-host reproductions.
Production migration has not started. Guidance is required before changing scope
or beginning upstream host work.

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
- Native root queue and hidden-route coverage/explicit-sidebar-state observation.
- Storage lineage, startup reconciliation and viable public companion architecture.
- Failed-setup/reload ownership and production worker compatibility.

Phase 0 stays open until these requirements have evidence or an explicit blocking
disposition. The successful synthetic probe does not establish production parity.

## Escalation

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
