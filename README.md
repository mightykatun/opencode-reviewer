# OpenCode Reviewer

Reviews pending permissions in the [OpenCode](https://github.com/anomalyco/opencode) sidebar using a separate LLM. Reviews
native shell commands, file edits, skill loading, and external-directory access.
MCP and custom-tool requests currently remain manual.
Supports streaming explanations, saved report history and stats, auto-approval, and Linux
desktop notifications (Gnome) with distinct sounds.

This plugin is meant to enable you to run sessions with less frequent input in a safer way. Also giving the reviewer context of specific files the agent might want to run/see/... The review prompts are freely configurable, so you can determine the reviewers behavior very accurately.

> ⚠️ **Disclaimer**
>
> This does not make running agents foolproof and safe! An actor running intrusive commands on your machine will always create attack surface! It just reduces risk, and enables you to get more insight into what your agent is doing.

![](./assets/recording.gif)

For OpenCode V2 on Linux. The plugin checks the server companion's protocol and
each request's data and scope rather than allowing only specific host versions.

## Install and config

Add this entry to the global `~/.config/opencode/cli.json`, or
`$XDG_CONFIG_HOME/opencode/cli.json` when `XDG_CONFIG_HOME` is set.
There is no project-local CLI configuration. OpenCode loads the
[npm package](https://www.npmjs.com/package/opencode-reviewer) from this entry.

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "opencode-reviewer@latest",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "model": "your-model",
        "apiKey": "your-api-key",
        "apiKeyEnv": "OPENCODE_REVIEWER_API_KEY",
        "instructions": "/absolute/path/to/reviewer-prompts",
        "stream": false,
        "reviewBash": true,
        "reviewEdits": true,
        "reviewSkills": true,
        "reviewMcp": false,
        "reviewCustomTools": false,
        "reviewExternalDirectories": false,
        "autoApprove": false,
        "fastMode": false,
        "extraCareful": true,
        "autoApproveDelaySeconds": 15,
        "notify": true,
        "notifySound": true,
        "staleReminderSeconds": 60,
        "notifications": {
          "attention": { "banner": true, "sound": true },
          "unsafe": { "banner": true, "sound": true },
          "question": { "banner": true, "sound": true },
          "approved": { "banner": true, "sound": false },
          "error": { "banner": true, "sound": true },
          "ended": { "banner": true, "sound": true }
        },
        "notificationSoundDirectory": "/absolute/path/to/notification-sounds",
        "formatRetries": 1,
        "maxOutputTokens": 4096,
        "timeoutMs": 30000,
        "maxFiles": 6,
        "maxEvidenceBytes": 131072
      }
    }
  ]
}
```

Only `baseURL` and `model` are required. Use any OpenAI-compatible Chat Completions
endpoint: `/chat/completions` is appended to the base URL. Choose a model available
at that endpoint.

Replace `apiKey`, or remove it and set the variable named by `apiKeyEnv` before
launching OpenCode. The inline key takes precedence. Omit both for an unauthenticated
endpoint. Remove `instructions` to use the built-in prompts and
`notificationSoundDirectory` to use the bundled sounds.

You also need to edit `opencode.json`, as the plugin needs to be informed of states
that are not exposed by TUI APIs:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-reviewer@latest"]
}
```

### Opencode docs

[server config](https://opencode.ai/v2/docs/config),
[CLI config](https://opencode.ai/v2/docs/cli/config) and
[CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli) guides.

## Options reference

These are options inside the plugin's `options` object in global `cli.json`.
Defaults apply only to omitted options. `null` is invalid. Boolean and integer
options require JSON booleans and numbers, not quoted strings. Integer ranges are
inclusive, fractions are invalid, and the maximum safe integer is
9,007,199,254,740,991. Unknown option names are rejected.

| Option | Type | Default | Accepted values and behavior |
| --- | --- | --- | --- |
| `baseURL` | string | Required | HTTP(S) API base URL; `/chat/completions` is appended after removing trailing slashes. Embedded credentials, query strings and fragments are rejected. |
| `model` | string | Required | Nonempty model identifier accepted by the configured endpoint. |
| `apiKey` | string | Unset | Nonempty Bearer token. Takes precedence over `apiKeyEnv`. |
| `apiKeyEnv` | string | Unset | Environment-variable name matching `[A-Za-z_][A-Za-z_0-9]*`. Without an inline key, its value must be set and nonblank when a review runs. Omit both key options for no Authorization header. |
| `instructions` | string | Unset (built-ins) | Absolute, NUL-free directory path containing overrides for the [prompt templates](https://github.com/mightykatun/opencode-reviewer/tree/main/prompts), not inline instructions. Missing named files use built-ins; supplied files must be readable, regular, non-symlink, nonempty UTF-8 text up to 64 KiB. Fixed contracts cannot be overridden. |
| `stream` | boolean | `false` | Request SSE and show provisional rating/text updates. Normal automatic approval waits for a completed, validated report; fast mode can approve on an early Safe rating. Approval rules are described below. |
| `reviewBash` | boolean | `true` | Review native `shell` permissions. The option keeps its existing name. |
| `reviewEdits` | boolean | `true` | Review native `edit`, `write` and `patch` tools, which use the `edit` permission action. |
| `reviewSkills` | boolean | `true` | Review native skill loading using the exact requested ID and full currently registered main instructions. Assumes the selected definition stays unchanged while permission is pending. Missing or ambiguous instructions remain manual. |
| `reviewMcp` | boolean | `false` | MCP-review category switch. V2 MCP collection is currently unsupported; enabling this does not supply missing origin/catalog evidence or permit automatic approval. |
| `reviewCustomTools` | boolean | `false` | Custom-tool review category switch. V2 custom-tool collection is currently unsupported; these requests remain manual. |
| `reviewExternalDirectories` | boolean | `false` | Review directory access independently of operation-review switches. Directory approval can resume the operation without another prompt. |
| `autoApprove` | boolean | `false` | Allow Safe reviews once automatically. Normally waits for completion, validation and the countdown. Works throughout the current conversation, including subagent browsing and hidden/covered reports. Home, dashboards, unrelated conversations and native permission decision editing wait without cancellation. |
| `fastMode` | boolean | `false` | Requires `autoApprove: true`. Approve an eligible, front-of-queue request as soon as a Safe rating is parsed, bypassing the countdown. Respects `stream`; with `stream: false`, waits for the complete validated response. Finish the report and save it in the background after approval. |
| `extraCareful` | boolean | `true` | Include extra-careful guidance when `autoApprove` is enabled. Setting `false` omits that guidance without disabling automatic approval. |
| `autoApproveDelaySeconds` | integer | `15` | `0`–`3600` seconds. Positive values include an extra 200 ms initial grace; `0` skips the wait but keeps the other approval checks. Ignored in fast mode. |
| `notify` | boolean | `true` | Master switch for desktop banners, sounds and reminders. `false` overrides all per-type controls. |
| `notifySound` | boolean | `true` | Master switch for notification audio. `false` silences every type and reminder without disabling enabled banners. |
| `staleReminderSeconds` | integer | `60` | `0` through the maximum safe integer, in seconds. `0` disables reminders; otherwise eligible pending human interactions repeat at this interval, limited to the native front-of-queue blocker per conversation. |
| `notifications` | object | All banners enabled; all sounds enabled except `approved` | Keys: `attention`, `unsafe`, `question`, `approved`, `error`, `ended`. Each entry is an object with optional `banner` and `sound` booleans. Omitted types/fields retain their defaults; unknown types/fields are invalid. Controls also apply to reminders. |
| `notificationSoundDirectory` | string | Unset (bundled sounds) | Absolute, NUL-free path, at most 4096 string code units. Use the six notification type names as basenames: usable `.wav` first, then `.mp3`, then the corresponding bundled sound. |
| `formatRetries` | integer | `1` | `0`–`100` additional assessment-format correction attempts. `0` disables format corrections, not independent transport recovery. |
| `maxOutputTokens` | integer | `4096` | `1` through the maximum safe integer. Sent as `max_tokens` on every reviewer POST, including retries/corrections. Your provider/model enforces its supported output limit. |
| `timeoutMs` | integer | `30000` | `1`–`3600000` milliseconds shared across evidence collection, HTTP requests, retries and corrections; not a fresh budget per POST. |
| `maxFiles` | integer | `6` | `1`–`1000` distinct file candidates per shell/edit review, including unavailable candidates. |
| `maxEvidenceBytes` | integer | `131072` | `1`–`16777216` bytes for command/source content, edit diffs or category-specific JSON evidence. Optional items are omitted whole; oversized mandatory evidence fails analysis. This is not a cap on the full prompt or HTTP request. |

Notification channels are independent: `banner: false, sound: true` is sound-only,
`banner: true, sound: false` is banner-only, both `false` disable that type.
`notify` and `notifySound` take precedence. Invalid notification settings disable
notification.

My LLMs insist on writing a bunch of useless text to my README, so I collapsed them here in case anyone wants to inflict themselves (or more likely their agent) the pain of reading it.

<details>
<summary>Usage</summary>
The sidebar shows Safe, Unsafe, or Analysis unavailable. Explanations support
Markdown and scrolling. If the sidebar is hidden, use OpenCode's Show sidebar
command.

The reviewer panel appears only in the main conversation. Opening any subagent,
including a nested one, hides the panel but does not stop normal or fast auto-approval
within that conversation. A Safe report need not be displayed before approval.
Command selectors, dialogs, report history, other session panels, sidebar hiding,
terminal resizing and disabled mouse tracking do not cancel automation.

Home, dashboard routes and unrelated conversations hold approval until you return
to the request's conversation. A countdown already started keeps its original
deadline; if it expires while waiting, approval can proceed immediately on return
after fresh checks. A review that has never started a countdown starts its full
delay when its conversation becomes eligible.

The plugin doesn't enable mouse tracking or reveal a hidden sidebar unless you
click an approval notification; it checks that the sidebar is absent from the main
conversation before showing it. Hidden automatic reports are saved normally.

Skill reviews use the full main instructions from the server's current registered
skill definition, not a fresh `SKILL.md` read or an invocation-time snapshot. This
assumes that the selected definition stays unchanged while its permission is pending.
The exact skill ID, native call and permission scope must match. Missing, ambiguous
or oversized main instructions remain manual. Supporting files and scripts are not
inspected; their omission alone does not prevent review. Allowing a skill loads its
instructions, not a blanket grant for later tool actions.

MCP and custom-tool reviews remain unsupported in V2 because required origin and
catalog evidence is unavailable. Their switches do not turn those requests into
Safe ratings or automatic approvals.

Code Mode and its tool search stay enabled. Native tool calls can be reviewed when
the reviewer can match them exactly to their permission requests. Nested calls
without an exact match need manual approval. This assumes other installed plugins don't change
what native tools do, replace or alias their executors, or rewrite commands after
the reviewer has captured them.

Subagent reviews include the latest user prompt from the main conversation. The
V2 evidence collector can't get the exact task passed to the requesting subagent,
so it leaves that out rather than guessing from older tasks, sibling requests or
queued follow-ups. Missing optional context doesn't prevent review if the required
operation evidence is verified. Context can't override the review rules.

With streaming enabled, Evaluating and its spinner disappear when a rating arrives.
The rating is provisional until the full response passes validation. A retry
clears the preview and brings back the loading indicator. Normal auto-approval
waits for the full validated report, then the configured countdown.

With `autoApprove: true` and `fastMode: true`, a parsed Safe rating can approve the
request before the streamed report finishes, without a countdown. The request must
be first in OpenCode's permission queue and belong to the currently viewed conversation
or its descendants. The report may be hidden or covered. Without streaming, fast
mode waits for the full validated response, then skips the countdown.

After confirmed fast approval, the live panel shows **Auto-approved; finishing
report…** and stays ahead of newer requests until its report finishes. Hiding the
panel, changing conversations or disabling review does not stop that already-approved
assessment. Normal retries and the original deadline still apply. The panel closes
when the assessment finishes; history saves continue in the background. Only a
completed validated report is saved, including a final Unsafe rating after a retry.
A failed remainder creates no report entry and cannot undo the earlier approval.

Transient connection failures, HTTP 408/429/500/502/503/504 responses, and rejected
assessment streams share up to two internal retries within `timeoutMs`, honoring
server cooldowns. Stream protocol failures and output-token truncation regenerate
the report from a fresh, identical request; previous previews are cleared and never
joined to the next response. Socket failures after text starts, provider error/refusal
events, tool calls, invalid JSON/UTF-8, incomplete SSE framing and resource-limit
failures remain terminal. This recovery is separate from `formatRetries`.
If token-limit errors persist, increase `maxOutputTokens` within your model's limits.
Providers enforce this limit and may include reasoning tokens; the plugin's byte
limits and overall timeout still apply. Retried requests can incur additional
provider charges, and unreported usage remains unknown.

During an auto-approval countdown, click the countdown to allow once immediately,
or Cancel to leave the request manual. Only explicit stop actions, such as Cancel,
disabling review, or native interruption/rejection, stop automation for that request.
Returning, reopening the panel or re-enabling review won't restart a canceled countdown.
Selecting native Allow always or Reject, or editing a rejection reason, holds
approval without cancellation. Returning to Allow once resumes eligibility with
the original countdown deadline. Ambiguous native choice state also waits.
Temporary queue/cache/read failures wait and recover after fresh verification.
Changed or unverifiable requests remain manual. If the plugin can't confirm the
result of a sent approval attempt, it never retries that write.
Cancel remains available during native preparation, until the approval is sent.
Positive countdowns add a 200 ms initial grace and then update on remaining-time
boundaries. A zero-second setting still approves without that grace.

`/reviewer-disable` and `/reviewer-enable` control the current conversation and its
descendants. The setting is saved for resume. Both commands are also in the command
palette. Disabling stops unapproved reviews and countdowns while native permission
controls remain available. Already-approved fast-mode reports finish in the background.
The commands remain available when review configuration or the companion is unavailable;
they save the preference without starting reviews.

At startup, the reviewer waits for the connected server event stream before its first
companion handshake. Connection waiting and retries for timed-out or not-yet-available
handshakes share one 10-second budget. If it remains unavailable, history and notifications still work;
reload the plugin to try again. Invalid handshake data is not retried.

If the server reconnects or the companion is replaced, reviews and auto-approval
stop. Reload the plugin or restart OpenCode to resume. This keeps cached permissions
from the old connection separate from the new one.

### Report history

Use `/reviewer-history` or **Reviewer: Report history** in the command palette to
open the newest saved report for the current conversation and its descendants.
Left/Right or the arrow buttons select older/newer entries; Up/Down and
PageUp/PageDown scroll. Close or Escape closes history. Repeating the command
returns to the newest report. History remains available with review disabled or
invalid reviewer configuration. The history command preserves a hidden sidebar;
clicking an approval notification reveals it and selects that permission's live or saved report.
Keyboard browsing also works with mouse tracking off.

Each entry shows the original report, available usage, model, provider and outcome:
**Auto approved**, **Manually approved**, **Cancelled**, or **Rejected**. Cancelled
records a linked interruption or removed request after automation was cancelled;
it does not prove that the tool never ran. Ambiguous outcomes are omitted, including
native Allow once replies whose submitting client cannot be identified. History
keeps the latest completed report, which can differ from the report that caused
approval in another window.

Opening report history does not hold normal or fast auto-approval for eligible live
requests. Browsing saved reports doesn't itself approve requests or replay notifications.

Reports are saved only after a permission resolution that qualifies for history.
They can contain private text and are kept under OpenCode's local state base:
`$XDG_STATE_HOME`, or `~/.local/state` when unset. Safely accessible history stays
under `opencode/opencode-reviewer/`. If the host directory is unsuitable for private
storage, the plugin uses its private, plugin-owned sibling
`opencode-reviewer-state/opencode-reviewer/` without changing host-directory permissions.
An existing safe sibling database remains in use across restarts. Conversation
enable/disable settings stay in the original OpenCode state directory.
Saved modes require private ownership and a nonreplaceable path; an untrusted or
unreadable mode suspends review rather than silently enabling it.
Deleting a conversation currently leaves its saved history in place. Known live
deletion events invalidate only volatile session state, not saved reports or totals.
A missing list entry or bare 404 cannot prove deletion ownership.
Windows using the same state directory share history, grouped by host directory
and main conversation. Reports not yet saved can be lost on shutdown or during a
prolonged storage failure.

### Usage totals

Token and cost totals appear below completed reports when available. Open
**Reviewer: Statistics** in the command palette for **Lifetime** and **Conversation**
views. Use Tab or click a scope to switch. The dialog opens on Lifetime;
Conversation uses the session selected when opened, resolving its root and all
descendants, including subagents, within the current host-directory scope.
Opening from a descendant shows the same combined conversation totals.
Statistics remain available with review disabled or invalid reviewer configuration.
OpenRouter costs use reported charges; other endpoints use available catalog estimates.
Received usage counts even if a review fails or is interrupted. Unreported charges
are missing from the totals.

Both views show completed reviews, retries, tokens, cost, Safe/Unsafe
percentages, confirmed auto-approvals, and average time to a rating and full report.
Percentages use recorded completed reviews as their denominator. Each validated
review counts once, even without usage data; a fresh review after re-enabling counts
again. Retries count extra API attempts actually dispatched, including format
corrections and transport recovery. Manual approvals are not auto-approvals.
Timings run from evaluation start, including evidence and retries, to the accepted
attempt's first rating and final validated response, excluding countdown
time. Non-streaming reviews use the final response time for both measurements.
Averages use running means and sample counts; stored review details also retain
their individual timings. Both scopes persist in the existing history database
across restart/resume. Conversation totals keep independent roots separate;
Lifetime combines activity across conversations and host directories using the
same state directory. Browsing and switching views do not add usage.

Older retained history can provide a **partial** conversation baseline. Previously
deleted details and usage predating history tracking cannot be attributed or
reconstructed from legacy lifetime aggregates. Once recorded in conversation totals,
deleting report details does not reduce those totals or Lifetime. Storage failures
show unavailable, not zero.

Tokens describe received provider usage, not just the visible explanation. One
report may sum several reviewer POSTs, including format corrections and transport
retries with received usage. Each POST can resend the prompt and evidence;
corrections also include the failed response and feedback. Cached input remains
part of the provider's input-token count. Lifetime and Conversation also retain
received usage from unsuccessful or interrupted reviews, which do not count as
completed reviews. Averages include measured reviews only.

Reviews send the pending request, latest user prompt, project context, and relevant
file snapshots, diffs, registered skill instructions, or tool arguments to your endpoint before approval. Shell
file snapshots can follow symlinks outside the project. Missing evidence is noted
in the report; ratings are advice based on the supplied evidence.
</details>

<details>
<summary>Desktop notifications</summary>
Transient banners have an **Opencode (Session name)** heading and a small status icon: green
checkmark for approvals, orange exclamation mark for attention, red exclamation mark
for Unsafe reviews, purple question mark for questions, red X
for errors, and a neutral code mark for completed responses. GNOME controls the
heading's font weight. The event message appears beneath it, even while the
terminal is focused:

- **Session needs attention:** manual permissions. Reviewed requests
  stay silent during identification, report generation and retries. Final Safe
  reports notify when auto-approval is disabled or canceled, or after failed approval
  is confirmed to remain pending. Waiting for conversation eligibility, native priority
  or an automatic countdown to start does not trigger attention. Disabled/unsupported
  reviews and terminal analysis failures can notify without a report.
- **Unsafe permission needs human approval:** a completed, validated Unsafe review,
  with its own sound. Provisional streamed ratings never notify.
- **Agent has a question:** a pending agent question at the front of the native
  input queue, with its own sound.
- **Reviewer approved a permission:** a silent banner by default, sent after confirmed
  automatic approval, including fast mode while its report is still streaming.
  Positive and zero delays also notify on success; the countdown is silent.
  Opt in with `notifications.approved.sound: true`. Approval sounds are limited to
  one every two seconds, including delayed playback. Sounds from the same session
  wait for the previous player to finish, so successive alerts do not overlap.
- **Session error:** an unrecovered session/provider failure, not a review failure.
- **Session ended:** a completed root-agent response, not a question/permission
  pause or an explicit user interruption. Waits until the conversation's subagents,
  shells and terminals have finished, including work the main agent stopped waiting for.

Permission attention, Unsafe and question notifications, including their reminders,
apply only to the current native input blocker in each visited root conversation.
Requests queued behind it stay silent and are re-evaluated from their current
state when they become actionable. Questions wait behind pending permissions and
earlier questions. A request resolved while queued never sends a delayed alert.
A sequence of permissions that proceeds
through automatic approval stays free of attention notifications. Losing the
actionable position, restarting analysis or entering automatic approval cancels
pending attention delivery and reminders.

Each type's `banner` and `sound` can be controlled independently. For example,
`notifications.approved: { "banner": false, "sound": true }` enables approval sounds without banners;
`notifications.question.sound: false` keeps question banners silent. Set both to
`false` to disable that type. `notify: false` overrides all types and disables
reminders too; `notifySound: false` silences all types and their reminders.
Sound-only delivery does not require a desktop banner or delivery acknowledgement.
Invalid notification settings disable notification work without disabling reviews.

Pending permissions and questions repeat after `staleReminderSeconds`, measured
from actual initial dispatch, even if desktop delivery fails. Capacity waiting
does not start the reminder clock or replace an undelivered initial alert. Reminders replace their
previous banner and append **(Reminder)** to the event text, reusing the same
sound, icon, session heading and click target. Only the native front-of-queue
interaction per root conversation repeats: permissions precede questions, with
the host's session/request ordering. Queued interactions stay silent. Handoff sends
the next eligible request's initial notification, then waits a full interval before
its first reminder. Independent visited conversations
can each remind. The supported V2 host's root input queue includes the full descendant
family, root first and then the host's public family order.

Answering/dismissing a question in OpenCode, resolving a permission, deleting its
session or closing the plugin stops its reminders. Closing/clicking a desktop
banner, activating the terminal or viewing a conversation does not. Countdown
and approval submission remain silent. Approval, error and completed-response
notifications never repeat. Setting `staleReminderSeconds: 0` disables all reminders.

Notifications cover conversations visited in this terminal and their descendants.
Existing pending requests at startup/resume are not replayed or reminded, but still
participate in queue ordering. Clicking can select
the originating GNOME Terminal tab and root conversation. Native input prompts
cover the root and its full descendant family in the supported host. Open dialogs are
left intact; other terminals still receive banners and sounds. Desktop policies
control expiry/history and whether activation actually brings a window forward.
Clicking **Reviewer approved a permission** opens that permission's unfinished
fast-mode report, or its matching saved report if it has completed, revealing the
sidebar if hidden. If a dialog is open, navigation waits until it closes and then
checks whether the report is still live. A clicked live panel closes on completion
like any fast-mode report. A pending save gets up to five seconds; if the report is
unavailable or deleted, the click just opens its conversation rather than a different report.
GNOME Terminal clicks use the desktop activation token to bring the correct tab
forward across workspaces. GNOME may attribute the notification source to Terminal;
the banner heading remains Opencode.

Linux delivery uses `notify-send`, `stdbuf`, and `gdbus`; audio uses `paplay` or `pw-play`.
On Ubuntu, `libnotify-bin`, `coreutils`, `libglib2.0-bin`, and `pulseaudio-utils` provide these
utilities. The MP3 decoder and six default sounds are bundled; FFmpeg is not
required. MP3 and mono/stereo PCM/float WAV files up to 4 MiB and 10 seconds are
normalized toward -20 dBFS RMS with a -3 dBFS peak ceiling before playback.
Custom sounds are loaded on first use; restart after replacing them.
Audio is prepared before showing its banner and played from the normalized cache
with a low-latency buffer; preparation never blocks permission approval.
`stdbuf` makes delivery acknowledgements immediate instead of waiting for
`notify-send` to flush its output when the banner closes.
Delivery is bounded: up to 64 active tickets (48 routine), 256 waiting actionable
episodes, and 128 waiting routine events. A full routine backlog drops new
approval/error/completion events; already admitted events retain their exact
targets. Actionable attention/Unsafe/question work has priority, rotating among
roots; after eight actionable dispatches, waiting routine work gets a turn.
Each root has only its current actionable episode, and waiting reminders coalesce.
The process pool allows 24 children: 20 banners (16 routine), two players, one
withdrawal and one activation. Audio preparation has two actual-operation slots;
audio waiting is bounded to 64 requests. Cancellation and timeouts do not free
physical slots until their operations settle. Queued actionable work is canceled
when its request resolves or loses native queue ownership. Desktop/process
failures remain best-effort and do not delay permission approval.
Disable overlapping notification plugins to avoid duplicate alerts.
</details>

## Development

Use Node.js 24.15.0+ within 24.x, or 22.22.2+ within 22.x, and npm.
Run `npm ci --ignore-scripts`, then `npm run check` for typechecking, source tests,
pure-helper tests and the build. `npm run test:helpers` runs the helper checks
without building or starting OpenCode. Pull-request CI checks both Node versions
and runs a separate representative Linux fixture profile on stock OpenCode
2.0.26 and 2.0.27.
After building, run `node scripts/test-runtime.mjs --profile ci` for that same
profile. Use `node scripts/test-runtime.mjs --list` for the complete runtime
inventory or `node scripts/test-runtime.mjs --plan --profile ci` for a
host-independent plan. Profiles select documented scenario/flag combinations;
interactive desktop checks have separate prerequisites.
See [AGENTS.md](https://github.com/mightykatun/opencode-reviewer/blob/main/AGENTS.md)
for runtime tests and the tag-driven release process.
