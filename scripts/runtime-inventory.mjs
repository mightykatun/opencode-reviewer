import assert from "node:assert/strict"
import { smokeScenarios } from "./smoke-scenarios.mjs"
import { permissionScenarios } from "./smoke-stages.mjs"

const host = (scenarios, flags = [], extra = {}) => ({ classification: "production-host", scenarios, default: scenarios[0], flags,
  hostVersion: "1.18.35", requires: ["linux", "git", "tmux", "bundle"], hosts: 1, timeoutMs: 240000, rules: [], ...extra })
const rule = (flag, options) => ({ flag, ...options })
const historyCases = ["covered", "countdown", "navigation", "notification", "dialog", "fullscreen", "hide", "narrow", "manual", "mode", "error", "zero"]

/** All accepted CLI dimensions. Rules describe supported combinations, not an exhaustive run matrix. */
export const runtimeInventory = {
  "smoke.mjs": host(Object.keys(smokeScenarios), ["measure-reuse", "notifications", "approval-sound", "reminders", "network-retry", "seed-lifetime", "fail-after-listen", "plan"], {
    requires: ["linux", "git", "python3", "tmux", "bundle", "source-sqlite"],
    rules: [rule("measure-reuse", { scenarios: ["external"] }), rule("network-retry", { scenarios: ["auto-shell"] }),
      rule("approval-sound", { requires: ["notifications"] }),
      rule("reminders", { requires: ["notifications"], scenarios: ["auto-shell", "auto-zero", "auto-unsafe", "auto-error", "auto-cancel"] })],
  }),
  "smoke-permissions.mjs": host(permissionScenarios, ["auto", "disabled", "correction", "held", "cancel", "unsafe", "error", "native-bash-enabled", "plan",
    "stream", "resource-whitespace", "notifications", "approval-sound", "no-usage", "missing-usage", "unpriced", "storage-error", "stats", "no-extra-careful"], {
    requires: ["linux", "git", "python3", "tmux", "bundle", "source-sqlite"],
    rules: [rule("resource-whitespace", { scenarios: ["mcp-resource"] }), rule("native-bash-enabled", { scenarios: ["custom-bash"] }),
      rule("cancel", { requires: ["auto"], excludes: ["unsafe", "error"] }), rule("no-usage", { excludes: ["missing-usage"] }),
      rule("missing-usage", { requires: ["correction"], excludes: ["error"] }),
      rule("notifications", { excludes: ["disabled"] }), rule("approval-sound", { requires: ["notifications"] })],
  }),
  "smoke-streaming.mjs": host(["complete", "retry", "truncated", "nonstream", "cancel", "manual", "disable", "hidden", "dialog", "narrow", "fullscreen", "error"],
    ["observer-throws", "static", "stats"], { requires: ["linux", "git", "python3", "tmux", "bundle", "source-sqlite"],
      rules: [rule("stats", { scenarios: ["complete", "retry", "truncated", "nonstream"] })] }),
  "smoke-fast-mode.mjs": host(["complete", "retry", "error", "nonstream", "hidden", "dialog"], [], { requires: ["linux", "git", "python3", "tmux", "bundle", "node-sqlite"] }),
  "smoke-session-mode.mjs": host(["default"], ["notifications"], { requires: ["linux", "git", "python3", "tmux", "bundle"] }),
  "smoke-skills.mjs": host(["root", "subagent", "subagent-view", "disabled", "unsafe", "fast"], [], { requires: ["linux", "git", "python3", "tmux", "bundle", "node-sqlite"] }),
  "smoke-subagent-approval.mjs": host(["normal", "zero", "nonstream", "fast", "fast-nonstream", "dialog", "fullscreen", "hide", "unrelated"], [], {
    requires: ["linux", "git", "python3", "tmux", "bundle", "node-sqlite"] }),
  "smoke-evidence.mjs": host(["capture", "prompt-symlink"], [], { requires: ["linux", "git", "python3", "bash", "tmux", "bundle"] }),
  "smoke-approval-geometry.mjs": host(["resize", "initially-short", "history-short", "benign-width", "sidebar-handoff-live", "sidebar-handoff-history"], [], { requires: ["linux", "git", "python3", "tmux", "bundle"] }),
  "smoke-review-admission.mjs": host(["fanout64"], [], { requires: ["linux", "git", "python3", "tmux", "bundle"] }),
  "smoke-mouse-proof.mjs": host(["normal", "fast"], [], { requires: ["linux", "git", "python3", "tmux", "bundle"] }),
  "smoke-v2-mouse-proof.mjs": host(["default"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "python3", "tmux", "babel"] }),
  "smoke-v2-contracts.mjs": host(["shell", "shadow-shell"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-catalog.mjs": host(["default"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "tmux", "source", "esbuild"] }),
  "smoke-v2-direct-tools.mjs": host(["default"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-profile-mapping.mjs": host(["default"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "tmux"] }),
  "smoke-v2-effective-evidence.mjs": host(["shell-rewrite", "skill-reload", "moved-location", "edit-preview"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-root-presentation.mjs": host(["mouse-on", "mouse-off"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "python3", "tmux", "babel"] }),
  "smoke-v2-native-queue.mjs": host(["default"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-delegation.mjs": host(["initial-resume", "coalesced"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "tmux"] }),
  "smoke-v2-companion-package.mjs": host(["default"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "tmux", "npm-pack", "tar", "source"] }),
  "smoke-v2-lifecycle.mjs": host(["default"], [], { hostVersion: "opencode v2.0.26", requires: ["linux", "git", "tmux", "npm-pack", "tar", "bundle"] }),
  "smoke-v2-sidebar-state.mjs": host(["default"], [], { classification: "synthetic-host", hostVersion: "opencode v2.0.26", requires: ["linux", "git", "tmux"] }),
  "smoke-style-retirement.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux", "bundle", "babel"] }),
  "smoke-approval-recovery.mjs": host(["read-error", "read-timeout", "correction-after", "correction-before", "transport-after", "transport-before"], [], {
    requires: ["linux", "git", "python3", "tmux", "bundle"] }),
  "smoke-history.mjs": host(["browse", "scroll", "empty-error", "resume", "shared", "delete", "visibility", "disabled-invalid"], [], {
    hosts: 2, requires: ["linux", "git", "tmux", "bundle", "source-sqlite"] }),
  "smoke-history-auto.mjs": host(historyCases, [], { alias: { entrypoint: "smoke-history-render.mjs", flags: ["production-history"] },
    requires: ["linux", "git", "python3", "tmux", "bundle", "npm-pack", "source-sqlite"] }),
  "smoke-history-render.mjs": host(historyCases, ["production-history"], {
    classification: "synthetic-host", requires: ["linux", "git", "python3", "tmux", "bundle", "npm-pack", "source-sqlite"],
    rules: [{ scenarios: historyCases.filter(s => !["covered", "countdown", "dialog", "fullscreen"].includes(s)), requires: ["production-history"] }],
  }),
  "smoke-history-phase0.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux", "bundle", "npm-pack"] }),
  "smoke-history-storage.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux", "bundle", "npm-pack"] }),
  "smoke-history-lifecycle.mjs": host(["auto-shell", "auto-immediate", "auto-manual", "auto-cancel"], [], {
    optionalArgument: "existing-state-directory", delegates: "smoke.mjs", requires: ["linux", "git", "python3", "tmux", "bundle", "source-sqlite"] }),
  "smoke-history-maintenance.mjs": host(["default"], [], { hosts: 2, requires: ["linux", "git", "tmux", "bundle", "npm-pack", "tar", "source-sqlite"] }),
  "smoke-statistics.mjs": host(["default"], [], { requires: ["linux", "git", "tmux", "bundle", "source-sqlite"] }),
  "smoke-notification-queue.mjs": host(["main", "children", "mixed", "advisory", "disabled", "reentry-manual", "reentry-auto", "reentry-predispatch"], ["stream"], {
    rules: [rule("stream", { scenarios: ["main", "children", "mixed", "advisory", "disabled"] })],
  }),
  "smoke-notification-events.mjs": host(["question", "error", "ended", "cancel", "click"], ["reminders", "queue", "banner-only", "sound-only", "dismiss"], {
    rules: [rule("queue", { requires: ["reminders"] }), rule("banner-only", { excludes: ["sound-only"] }),
      ...["reminders", "queue", "banner-only", "sound-only", "dismiss"].map(flag => rule(flag, { scenarios: ["question"] }))],
  }),
  "smoke-notification-w4.mjs": host(["baseline", "baseline-permission", "question-reconcile", "capacity", "click"], [], { default: undefined, timeoutMs: 360000 }),
  "smoke-notification-desktop.ts": { classification: "interactive", scenarios: ["default"], default: "default", flags: ["all", "sounds", "click", "critical"],
    rules: [], exactlyOne: ["all", "sounds", "click"], requires: ["linux", "desktop-bus", "audio-player", "source", "tsx"], hosts: 0, timeoutMs: 180000 },
  "audit-usage-history.mjs": { classification: "historical", scenarios: ["default"], default: "default", flags: [], rules: [],
    requires: ["git-tag:v0.7.0", "source", "esbuild", "node-sqlite"], hosts: 0, timeoutMs: 60000 },
  ...Object.fromEntries(["smoke-runtime.mjs", "smoke-stages.mjs", "smoke-scenarios.mjs", "smoke-reviewer.mjs", "smoke-lifetime.mjs",
    "smoke-notification-recorder.mjs", "smoke-desktop-playback.mjs", "smoke-observations.mjs", "smoke-ui.mjs", "runtime-inventory.mjs", "runtime-runner.mjs", "test-runtime.mjs"]
    .map(name => [name, { classification: "helper", internal: name === "smoke-runtime.mjs" ? ["--guard <absolute-socket>"]
      : name === "test-runtime.mjs" ? ["--list", "--plan [--profile <name> | <entrypoint> <scenario> <flags>]", "--profile <name>"] : [] }])),
}

export function runtimePlan(entrypoint, args = []) {
  const entry = runtimeInventory[entrypoint]
  assert.ok(entry && entry.classification !== "helper", `Unknown runnable fixture: ${entrypoint}`)
  const positional = args.filter(arg => !arg.startsWith("--")), flags = args.filter(arg => arg.startsWith("--")).map(arg => arg.slice(2))
  const scenario = positional[0] ?? entry.default
  assert.ok(entry.scenarios.includes(scenario), `Unknown scenario for ${entrypoint}: ${scenario}`)
  assert.ok(positional.length <= (entry.optionalArgument ? 2 : entry.scenarios[0] === "default" ? 0 : 1), `Unexpected arguments for ${entrypoint}`)
  assert.equal(new Set(flags).size, flags.length, "Duplicate fixture flag")
  for (const flag of flags) assert.ok(entry.flags.includes(flag), `Unknown ${entrypoint} flag: --${flag}`)
  if (entry.exactlyOne) assert.equal(flags.filter(f => entry.exactlyOne.includes(f)).length, 1, `Choose one of ${entry.exactlyOne.join(", ")}`)
  for (const rule of entry.rules) {
    if (rule.flag && !flags.includes(rule.flag) || !rule.flag && rule.scenarios && !rule.scenarios.includes(scenario)) continue
    if (rule.flag && rule.scenarios) assert.ok(rule.scenarios.includes(scenario), `--${rule.flag} is not supported for ${scenario}`)
    for (const flag of rule.requires ?? []) assert.ok(flags.includes(flag), `${rule.flag ?? scenario} requires --${flag}`)
    for (const flag of rule.excludes ?? []) assert.ok(!flags.includes(flag), `--${rule.flag} excludes --${flag}`)
  }
  const canonicalEntry = entry.alias?.entrypoint ?? entrypoint
  const canonicalFlags = [...flags, ...entry.alias?.flags ?? []].sort()
  const planning = canonicalFlags.includes("plan")
  const classification = planning ? "helper" : canonicalEntry === "smoke-history-render.mjs" && canonicalFlags.includes("production-history") ? "production-host" : entry.classification
  return { id: [canonicalEntry.replace(/\.(mjs|ts)$/, ""), scenario, ...canonicalFlags].join("/"), entrypoint: `scripts/${canonicalEntry}`,
    args: [...(scenario === "default" ? [] : [scenario]), ...positional.slice(1), ...canonicalFlags.map(f => `--${f}`)], scenario,
    flags: canonicalFlags, classification, requires: planning ? [] : entry.requires, hostVersion: planning ? undefined : entry.hostVersion,
    hosts: planning || entrypoint === "smoke-history-lifecycle.mjs" && positional[1] ? 0 : entry.hosts, timeoutMs: entry.timeoutMs }
}

/** Direct fixture execution shares validation; no host, files, or imports with side effects. */
export function runtimeArguments(entrypoint, args = process.argv.slice(2)) { return runtimePlan(entrypoint, args) }

export const runtimeProfiles = {
  f34: [
    ...["normal", "zero", "nonstream", "fast", "fast-nonstream", "dialog", "fullscreen", "hide", "unrelated"]
      .map(scenario => ["smoke-subagent-approval.mjs", scenario]),
    ["smoke-skills.mjs", "subagent-view"], ["smoke-fast-mode.mjs", "hidden"],
    ["smoke-approval-geometry.mjs", "sidebar-handoff-live"], ["smoke-approval-geometry.mjs", "sidebar-handoff-history"],
    ["smoke-history-auto.mjs", "covered"],
  ],
  ci: [
    ["smoke-history-lifecycle.mjs", "auto-shell"],
    ["smoke-approval-geometry.mjs", "resize"],
    ["smoke-fast-mode.mjs", "complete"],
    ["smoke-notification-w4.mjs", "baseline"],
    ["smoke-notification-queue.mjs", "mixed", "--stream"],
    ["smoke-history.mjs", "browse"],
    ["smoke-streaming.mjs", "complete", "--stats"],
  ],
  "w6-affected": [
    ["smoke-history-maintenance.mjs"], ["smoke-statistics.mjs"], ["smoke-history-auto.mjs", "notification"],
    ["smoke-streaming.mjs", "truncated", "--static", "--stats"], ["smoke.mjs", "external"],
    ["smoke.mjs", "auto-external"], ["smoke.mjs", "correction"], ["smoke.mjs", "auto-scroll"],
    ["smoke-permissions.mjs", "external-edit", "--disabled", "--auto", "--held", "--stream", "--stats"],
    ["smoke-session-mode.mjs"], ["smoke-skills.mjs", "root"],
  ],
  "w6-extended": [
    ["smoke-history.mjs", "shared"], ["smoke-history.mjs", "visibility"], ["smoke-history.mjs", "disabled-invalid"],
    ["smoke-history-storage.mjs"], ["smoke-history-phase0.mjs"], ["smoke-notification-events.mjs", "click"],
    ["smoke.mjs", "cancel"], ["smoke.mjs", "edit"], ["smoke-history-auto.mjs", "dialog"],
    ["smoke-notification-w4.mjs", "capacity"],
  ],
}

export function profilePlan(name) {
  assert.ok(Object.hasOwn(runtimeProfiles, name), `Unknown runtime profile: ${name}`)
  return runtimeProfiles[name].map(([file, ...args]) => runtimePlan(file, args))
}
