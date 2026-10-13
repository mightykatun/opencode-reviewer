import assert from "node:assert/strict"

const host = (scenarios, flags = [], extra = {}) => ({ classification: "production-host", scenarios, default: scenarios[0], flags,
  hostVersion: "opencode v2.0.26", requires: ["linux", "git", "tmux", "bundle"], hosts: 1, timeoutMs: 240000, rules: [], ...extra })
const acceptanceHostVersions = ["opencode v2.0.26", "opencode v2.0.27"]

/** All accepted CLI dimensions. Rules describe supported combinations, not an exhaustive run matrix. */
export const runtimeInventory = {
  "smoke-v2-mouse-proof.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "python3", "tmux", "babel"] }),
  "smoke-v2-contracts.mjs": host(["shell", "shadow-shell"], [], { classification: "synthetic-host", requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-catalog.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux", "source", "esbuild"] }),
  "smoke-v2-direct-tools.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-profile-mapping.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux"] }),
  "smoke-v2-effective-evidence.mjs": host(["shell-rewrite", "skill-reload", "moved-location", "edit-preview"], [], { classification: "synthetic-host", requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-root-presentation.mjs": host(["mouse-on", "mouse-off"], [], { classification: "synthetic-host", hostVersions: acceptanceHostVersions, requires: ["linux", "git", "python3", "tmux", "babel"] }),
  "smoke-v2-native-queue.mjs": host(["default"], [], { classification: "synthetic-host", hostVersions: acceptanceHostVersions, requires: ["linux", "git", "python3", "tmux"] }),
  "smoke-v2-delegation.mjs": host(["initial-resume", "coalesced"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux"] }),
  "smoke-v2-companion-package.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux", "npm-pack", "tar", "source"] }),
  "smoke-v2-lifecycle.mjs": host(["default"], [], { hostVersions: acceptanceHostVersions, requires: ["linux", "git", "tmux", "npm-pack", "tar", "bundle"] }),
  "smoke-v2-invocation.mjs": host(["default", "review"], [], { hostVersions: acceptanceHostVersions, requires: ["linux", "git", "python3", "tmux", "npm-pack", "tar", "bundle"] }),
  "smoke-v2-review.mjs": host(["advisory", "normal", "fast", "normal-mouse-off", "normal-cancel", "normal-descendant", "fast-descendant", "normal-history", "normal-history-default-home", "normal-history-cover", "normal-history-keyboard-mouse-off", "fast-history-cover", "fast-notifications",
    "normal-hide", "normal-dialog", "normal-resize", "fast-dialog", "normal-hidden-complete", "normal-route-wait", "normal-decision", "fast-decision", "normal-edit", "normal-directory-edit"], [], { hostVersions: acceptanceHostVersions, requires: ["linux", "git", "python3", "tmux", "npm-pack", "tar", "bundle", "node-sqlite"] }),
  "smoke-v2-notifications.mjs": host(["manual-handoff", "forms", "execution", "unavailable-review"], [], {
    hostVersions: acceptanceHostVersions,
    requires: ["linux", "git", "python3", "tmux", "npm-pack", "tar", "bundle"], timeoutMs: 360000 }),
  "smoke-v2-sidebar-state.mjs": host(["default"], [], { classification: "synthetic-host", requires: ["linux", "git", "tmux"] }),
  "smoke-notification-desktop.ts": { classification: "interactive", scenarios: ["default"], default: "default", flags: ["all", "sounds", "click", "critical"],
    rules: [], exactlyOne: ["all", "sounds", "click"], requires: ["linux", "desktop-bus", "audio-player", "source", "tsx"], hosts: 0, timeoutMs: 180000 },
  ...Object.fromEntries(["smoke-runtime.mjs", "smoke-reviewer.mjs", "smoke-desktop-playback.mjs", "smoke-observations.mjs", "smoke-ui.mjs", "smoke-v2-review-support.mjs", "runtime-inventory.mjs", "runtime-runner.mjs", "test-runtime.mjs"]
    .map(name => [name, { classification: "helper", internal: name === "smoke-runtime.mjs" ? ["--guard <absolute-socket>"]
      : name === "test-runtime.mjs" ? ["--list", "--plan [--profile <name> | <entrypoint> <scenario> <flags>]", "--profile <name>"] : [] }])),
}

export function runtimePlan(entrypoint, args = []) {
  const entry = runtimeInventory[entrypoint]
  assert.ok(entry && entry.classification !== "helper", `Unknown runnable fixture: ${entrypoint}`)
  const positional = args.filter(arg => !arg.startsWith("--")), flags = args.filter(arg => arg.startsWith("--")).map(arg => arg.slice(2))
  const scenario = positional[0] ?? entry.default
  assert.ok(entry.scenarios.includes(scenario), `Unknown scenario for ${entrypoint}: ${scenario}`)
  assert.ok(positional.length <= (entry.scenarios.length === 1 && entry.scenarios[0] === "default" ? 0 : 1), `Unexpected arguments for ${entrypoint}`)
  assert.equal(new Set(flags).size, flags.length, "Duplicate fixture flag")
  for (const flag of flags) assert.ok(entry.flags.includes(flag), `Unknown ${entrypoint} flag: --${flag}`)
  if (entry.exactlyOne) assert.equal(flags.filter(f => entry.exactlyOne.includes(f)).length, 1, `Choose one of ${entry.exactlyOne.join(", ")}`)
  return { id: [entrypoint.replace(/\.(mjs|ts)$/, ""), scenario, ...[...flags].sort()].join("/"), entrypoint: `scripts/${entrypoint}`,
    args: [...(scenario === "default" ? [] : [scenario]), ...[...flags].sort().map(f => `--${f}`)], scenario,
    flags: [...flags].sort(), classification: entry.classification, requires: entry.requires, hostVersion: entry.hostVersion,
    ...(entry.hostVersions ? { hostVersions: [...entry.hostVersions] } : {}),
    hosts: entry.hosts, timeoutMs: entry.timeoutMs }
}

/** Direct fixture execution shares validation; no host, files, or imports with side effects. */
export function runtimeArguments(entrypoint, args = process.argv.slice(2)) { return runtimePlan(entrypoint, args) }

/** One actual binary version must satisfy every selected host fixture. */
export function assertRuntimeHostVersion(selected, actual) {
  for (const item of selected.filter(item => item.hosts)) {
    assert.ok(item.hostVersion, "Host fixtures must declare their exact default version")
    const allowed = item.hostVersions ?? [item.hostVersion]
    assert.ok(Array.isArray(allowed) && allowed.length && allowed.includes(item.hostVersion), "Host versions must include the exact default version")
    assert.ok(allowed.includes(actual), `${item.id}: host ${actual} is unsupported; expected ${allowed.join(" or ")}`)
  }
}

export const runtimeProfiles = {
  ci: [
    ["smoke-v2-lifecycle.mjs"],
    ["smoke-v2-invocation.mjs"],
    ["smoke-v2-invocation.mjs", "review"],
    ["smoke-v2-review.mjs", "advisory"],
    ["smoke-v2-review.mjs", "normal"],
    ["smoke-v2-review.mjs", "fast"],
    ["smoke-v2-review.mjs", "normal-descendant"],
    ["smoke-v2-root-presentation.mjs", "mouse-on"],
    ["smoke-v2-root-presentation.mjs", "mouse-off"],
    ["smoke-v2-native-queue.mjs"],
    ...["normal-mouse-off", "normal-cancel", "fast-descendant", "normal-history", "normal-history-default-home", "normal-history-cover", "normal-history-keyboard-mouse-off",
      "fast-history-cover", "fast-notifications", "normal-hide", "normal-dialog", "normal-resize", "fast-dialog",
      "normal-hidden-complete", "normal-route-wait", "normal-decision", "fast-decision", "normal-edit", "normal-directory-edit"].map(scenario => ["smoke-v2-review.mjs", scenario]),
    ...["manual-handoff", "forms", "execution", "unavailable-review"].map(scenario => ["smoke-v2-notifications.mjs", scenario]),
  ],
  "v2-permissions": [
    ["smoke-v2-invocation.mjs"], ["smoke-v2-invocation.mjs", "review"],
    ["smoke-v2-review.mjs", "normal-edit"], ["smoke-v2-review.mjs", "normal-directory-edit"],
  ],
}

// Acceptance expands current CI with every production review scenario without
// enrolling unverified additions into CI. Canonical IDs deduplicate exact cases.
runtimeProfiles["v2-acceptance"] = [...new Map([
  ...runtimeProfiles.ci,
  ...runtimeInventory["smoke-v2-review.mjs"].scenarios.map(scenario => ["smoke-v2-review.mjs", scenario]),
].map(([file, ...args]) => [runtimePlan(file, args).id, [file, ...args]])).values()]

export function profilePlan(name) {
  assert.ok(Object.hasOwn(runtimeProfiles, name), `Unknown runtime profile: ${name}`)
  return runtimeProfiles[name].map(([file, ...args]) => runtimePlan(file, args))
}
