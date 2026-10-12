# V2 capability verification

Status: Phase 0 in progress. Production migration has not started.

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

## Checks

- `node --test test/runtime-inventory.test.mjs`: 7 passed.
- `npm run test:helpers`: 118 passed, including active-policy sparse dependency
  closure after registering the probe and adding it to release validation inputs.

## Pending phase-0 gates

- Immutable invocation location and exact resumed/nested delegation linkage.
- Authoritative native/custom/MCP origin and captured effective definitions.
- Pending edit and skill evidence.
- Native root queue and hidden-route coverage/explicit-sidebar-state observation.
- Storage lineage, startup reconciliation and viable public companion architecture.
- Failed-setup/reload ownership and production worker compatibility.

Phase 0 stays open until these requirements have evidence or an explicit blocking
disposition. The successful synthetic probe does not establish production parity.
