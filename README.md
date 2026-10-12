# OpenCode Reviewer

> ⚠️ **NOT v2 COMPATIBLE YET**
> 
> I recommend not upgrading opencode to v2 yet as many things are still unstable

Reviews pending permissions in the [OpenCode](https://github.com/anomalyco/opencode) sidebar using a separate LLM. Covers
shell commands, file edits, skill loading, MCP calls, custom tools, and external-directory access.
Supports streaming explanations, saved report history, auto-approval, and Linux
desktop notifications with distinct sounds.

This plugin is meant to enable you to run sessions with less frequent input in a safer way. Also giving the reviewer context of specific files the agent might want to run/see/... The review prompts are freely configurable, so you can determine the reviewers behavior very accurately.

> ⚠️ **Disclaimer**
>
> This does not make running agents foolproof and safe! An actor running intrusive commands on your machine will always create attack surface! It just reduces risk, and enables you to get more insight into what your agent is doing.

![](./assets/recording.gif)

Verified with OpenCode 1.18.35 on Linux. Version **1.0.2** is the final release
compatible with OpenCode V1.

## Install and config

Add this entry to `~/.config/opencode/tui.json` or `.opencode/tui.json`.
OpenCode installs the [npm package](https://www.npmjs.com/package/opencode-reviewer).

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "opencode-reviewer@1.0.2",
      {
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
    ]
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

The connection, credential and directory values above are examples, not defaults.
All boolean, numeric and per-type notification values shown are the defaults.
Restart OpenCode after changing configuration. Reviews run when OpenCode asks for
permission, so set the relevant rules to `ask` in `opencode.json`. Existing `allow`
rules skip review.

## Options reference

These are options inside the plugin's configuration object in `tui.json`.
Defaults apply only to omitted options; `null` is invalid. Boolean and integer
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
| `stream` | boolean | `false` | Request SSE and show provisional rating/text updates. Normal automatic approval waits for a completed, validated report; fast mode can approve on an early Safe rating. Presentation rules are described below. |
| `reviewBash` | boolean | `true` | Review native shell-command permissions. |
| `reviewEdits` | boolean | `true` | Review native `edit`, `write` and `apply_patch` permissions. |
| `reviewSkills` | boolean | `true` | Review native skill-load permissions for dangerous guidance and relevance to the current task. Supplies the host's skill instructions and bounded, directly referenced supporting files within the skill directory. |
| `reviewMcp` | boolean | `false` | Review identifiable MCP tool and resource permissions. |
| `reviewCustomTools` | boolean | `false` | Review permissions requested by registered custom tools. |
| `reviewExternalDirectories` | boolean | `false` | Review directory access independently of operation-review switches. Directory approval can resume the operation without another prompt. |
| `autoApprove` | boolean | `false` | Allow Safe reviews once automatically. Normally waits for completion, validation and the countdown. Root-view rendering is required, including behind report history; same-conversation subagent browsing permits hidden approval. |
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
| `maxFiles` | integer | `6` | `1`–`1000` distinct file candidates per shell/edit/skill review, including unavailable candidates. Skill reviews count the main instructions as one file. |
| `maxEvidenceBytes` | integer | `131072` | `1`–`16777216` bytes for command/source content, edit diffs or category-specific JSON evidence. Skill reviews share this budget between mandatory skill JSON and UTF-8 supporting-file content. Optional items are omitted whole; oversized mandatory evidence fails analysis. This is not a cap on the full prompt or HTTP request. |

Notification channels are independent: `banner: false, sound: true` is sound-only;
`banner: true, sound: false` is banner-only; both `false` disable that type.
`notify` and `notifySound` take precedence. Invalid notification settings disable
notification work without invalidating otherwise valid review settings.

My LLMs insist on writing a bunch of useless text to my README, so I collapsed them here in case anyone wants to inflict themselves (or more likely their agent) the pain of reading it.

<details>
<summary>Usage</summary>
The sidebar shows Safe, Unsafe, or Analysis unavailable. Explanations support
Markdown and scrolling. If the sidebar is hidden, use OpenCode's Show sidebar
command.

The reviewer side panel appears only in the top-level conversation. Browsing its
subagents, including nested subagents, hides the panel while reviews and both normal
and fast automatic approvals continue. Countdown deadlines stay the same, and new
Safe reviews can become eligible while hidden. Return to the top-level conversation
to see the current report or browse saved history.

On the top-level route, automatic approval requires mouse tracking for the host's
painted-panel ownership checks. With mouse tracking disabled there, reports remain
available for manual review.

Skill-load review is enabled by default; set `skill` permissions to `ask` in
`opencode.json` to receive reviews. Its prompt requires both bounded risk and clear
relevance to the current work. A harmless but irrelevant skill is rated Unsafe.
The reviewer receives the exact main instructions from the host's skill catalog,
plus bounded snapshots of directly referenced local files within the skill directory.
It does not execute scripts, follow references in supporting files, expand directory
listings, fetch external URLs, or read supporting files outside that directory.
Built-in skills without a local directory receive instruction-only review.
Customize this guidance with `SKILL-REVIEW-PROMPT.md` in your prompt directory.

For every review category, subagent requests include the latest immediate delegation
linked to the requesting assistant invocation, alongside the genuine root-user prompt.
Resumed subagents use the current delegation; nested subagents include only their
immediate delegation. Missing or over-64-KiB delegation text is noted rather than
replaced with an older task. Both prompts are context for the reviewer, not instructions
that can override its review contract.

With streaming enabled, Evaluating and its spinner disappear when a rating arrives.
The rating remains provisional until the full response is validated. A retry
clears the preview and restores the loading indicator. Normal auto-approval
starts only after the full response is validated and rendered, except that rendering
is not required while the panel is intentionally hidden by same-conversation
subagent browsing.

With `autoApprove: true` and `fastMode: true`, a parsed Safe rating approves the
current eligible permission immediately, without a countdown or waiting for the
rest of a streamed report. Same-conversation subagent browsing also permits fast
approval while the panel is hidden. Explicit sidebar hiding, covering dialogs and
report history prevent fast approval. Without streaming, fast mode waits for the
full validated response and then skips the countdown.

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
or Cancel to leave the request manual. Hiding or covering the panel also cancels
that request's countdown, except when covered by this plugin's report history or
intentionally hidden while browsing the same conversation's subagents. Switching
to an unrelated conversation still cancels it. Returning cannot revive a canceled
request.
Cancel before using native Allow always or rejection
forms; those forms alone do not stop the countdown.
Positive countdowns add a 200 ms initial grace and then update on remaining-time
boundaries. A zero-second setting still approves without that grace.

`/reviewer-disable` and `/reviewer-enable` control the current conversation and its
descendants. The setting is saved for resume. Both commands are also in the command
palette. Disabling stops unapproved reviews and countdowns while native permission
controls remain available. Already-approved fast-mode reports finish in the background.

### Report history

Use `/reviewer-history` or **Reviewer: Report history** in the command palette to
open the newest saved report for the current conversation and its descendants.
Left/Right or the arrow buttons select older/newer entries; Up/Down and
PageUp/PageDown scroll. Close or Escape closes history. Repeating the command
returns to the newest report. History remains available with review disabled or
invalid reviewer configuration. The history command preserves a hidden sidebar;
clicking an approval notification reveals it and selects that permission's live or saved report.

Each entry shows the original report, available usage, model, provider and outcome:
**Auto approved**, **Manually approved**, **Cancelled**, or **Rejected**. Cancelled
records a linked interruption or removed request after automation was cancelled;
it does not prove that the tool never ran. Ambiguous outcomes are omitted, including
native Allow once replies whose submitting client cannot be identified. History
keeps the latest completed report, which can differ from the report that caused
approval in another window.

History can cover an ongoing review without stopping its countdown. A newly
completed Safe review can also start its countdown beneath history after its full
report is rendered. Native dialogs, including the command palette, still cancel an
active countdown; opening history afterward cannot restart it. Browsing saved
reports never approves a request or replays notifications.

Reports are saved only after a qualifying permission resolution. Saved reports
can contain private text and are retained in OpenCode's local state directory
until their conversation is deleted. Deleting a root removes its descendants'
details; deletion missed while OpenCode was closed is reconciled when that host
scope is visited again. Windows using the same state directory share this history,
partitioned by host directory and root conversation. Uncommitted reports can be
lost on shutdown or prolonged storage failure.

### Usage totals

Token and cost totals appear below completed reports when available. Open
**Reviewer: Statistics** in the command palette for **Lifetime** and **Conversation**
views. Use Tab or click a scope to switch. The dialog opens on Lifetime;
Conversation uses the session selected when opened, resolving its root and all
descendants, including subagents, within the current host-directory scope.
Opening from a descendant shows the same combined conversation totals.
OpenRouter
costs use reported charges; other endpoints use available catalog estimates.
Received usage counts even if a review fails or is interrupted. Unreported charges
are missing from the totals.

Both views show completed reviews, retries, tokens, cost, Safe/Unsafe
percentages, confirmed auto-approvals, and average time to a rating and full report.
Percentages use recorded completed reviews as their denominator. Each validated
review counts once, even without usage data; a fresh review after re-enabling counts
again. Retries count extra API attempts actually dispatched, including format
corrections and transport recovery. Manual approvals are not auto-approvals.
Timings run from evaluation start, including evidence and retries, to the accepted
attempt's first rating and final validated response, excluding rendering/countdown
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
file snapshots, diffs, or tool arguments to your endpoint before approval. Shell
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
  is confirmed to remain pending. Waiting for rendering, queue position or an
  automatic countdown to start does not trigger attention. Disabled/unsupported
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
  pause or an explicit user interruption.

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
can each remind. The supported host presents input for roots and direct children;
deeper descendants cannot become a native root-input notification or reminder target.

Answering/dismissing a question in OpenCode, resolving a permission, deleting its
session or closing the plugin stops its reminders. Closing/clicking a desktop
banner, activating the terminal or viewing a conversation does not. Countdown
and approval submission remain silent. Approval, error and completed-response
notifications never repeat. Setting `staleReminderSeconds: 0` disables all reminders.

Notifications cover conversations visited in this terminal and their descendants.
Existing pending requests at startup/resume are not replayed or reminded, but still
participate in queue ordering. Clicking can select
the originating GNOME Terminal tab and root conversation. Native input prompts
cover root/direct-child requests in the supported host. Open dialogs are
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
and runs a separate representative Linux OpenCode 1.18.35 fixture profile.
After building, run `node scripts/test-runtime.mjs --profile ci` for that same
profile. Use `node scripts/test-runtime.mjs --list` for the complete runtime
inventory or `node scripts/test-runtime.mjs --plan --profile ci` for a
host-independent plan. Profiles select documented scenario/flag combinations;
interactive desktop checks and historical replays have separate prerequisites.
See [AGENTS.md](https://github.com/mightykatun/opencode-reviewer/blob/main/AGENTS.md)
for runtime tests and the tag-driven release process.
