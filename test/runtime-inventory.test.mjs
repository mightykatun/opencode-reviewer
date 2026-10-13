import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { runtimeInventory, runtimePlan, profilePlan, assertRuntimeHostVersion } from "../scripts/runtime-inventory.mjs"
import { smokeScenario, smokeScenarios, runSmokeFamily } from "../scripts/smoke-scenarios.mjs"

const scripts = new URL("../scripts/", import.meta.url)

export async function checkDiscovery(files, read) {
  const discovered = files.filter(file => /^(smoke(?:-|\.)|audit-|runtime-|test-runtime\.)/.test(file)).sort()
  assert.deepEqual(discovered, Object.keys(runtimeInventory).sort(), "Every runtime entrypoint/helper needs an explicit classification")
  for (const file of discovered) {
    const entry = runtimeInventory[file], source = await read(file)
    assert.ok(["production-host", "synthetic-host", "interactive", "historical", "helper"].includes(entry.classification))
    if (entry.classification === "helper") continue
    assert.ok(source.includes(`runtimeArguments("${file}")`), `${file} must validate through its inventoried CLI`)
    const flags = [...source.matchAll(/process\.argv\.includes\(["']--([\w-]+)["']\)|\bflag\(["']([\w-]+)["']\)/g)].map(m => m[1] ?? m[2])
    assert.deepEqual([...new Set(flags)].sort(), [...entry.flags].sort(), `${file} flag declarations and consumers must agree`)
    for (const match of source.matchAll(/\bscenario\s*!?===?\s*["']([\w-]+)["']/g))
      assert.ok(entry.scenarios.includes(match[1]), `${file} has an unregistered scenario branch: ${match[1]}`)
    assert.equal(new Set(entry.scenarios).size, entry.scenarios.length)
    assert.ok(entry.requires.length)
    assert.ok(entry.hosts <= 2)
  }
}

test("runtime discovery covers every entrypoint/helper and exact declared flags", async () => {
  await checkDiscovery(await readdir(scripts), file => readFile(new URL(file, scripts), "utf8"))
})

test("an unclassified new fixture or unregistered flag fails completeness", async () => {
  const files = await readdir(scripts), read = file => readFile(new URL(file, scripts), "utf8")
  await assert.rejects(checkDiscovery([...files, "smoke-forgotten.mjs"], read), /explicit classification/)
  await assert.rejects(checkDiscovery(files, async file => (await read(file)) + (file === "smoke.mjs" ? '\nprocess.argv.includes("--forgotten")' : "")), /flag declarations/)
  await assert.rejects(checkDiscovery(files, async file => (await read(file)) + (file === "smoke.mjs" ? '\nif (scenario === "forgotten") {}' : "")), /unregistered scenario/)
})

test("canonical history aliases identify the same production case and preserve synthetic classification", () => {
  assert.deepEqual(runtimePlan("smoke-history-auto.mjs", ["covered"]), runtimePlan("smoke-history-render.mjs", ["covered", "--production-history"]))
  assert.equal(runtimePlan("smoke-history-render.mjs", ["covered"]).classification, "synthetic-host")
  assert.equal(runtimePlan("smoke-history-phase0.mjs").classification, "synthetic-host")
  assert.equal(runtimePlan("audit-usage-history.mjs").classification, "historical")
  assert.equal(runtimePlan("smoke-notification-desktop.ts", ["--sounds"]).classification, "interactive")
})

test("rules reject unsupported scenario/flag combinations instead of promising a Cartesian matrix", () => {
  for (const [file, ...args] of [
    ["smoke.mjs", "edit", "--network-retry"], ["smoke.mjs", "auto-shell", "--reminders"],
    ["smoke-permissions.mjs", "external-edit", "--resource-whitespace"],
    ["smoke-permissions.mjs", "mcp", "--missing-usage"],
    ["smoke-permissions.mjs", "mcp", "--approval-sound"], ["smoke.mjs", "auto-scroll-success", "--approval-sound"],
    ["smoke-streaming.mjs", "cancel", "--stats"],
    ["smoke-history-render.mjs", "notification"],
    ["smoke-notification-events.mjs", "question", "--queue"],
    ["smoke-notification-events.mjs", "question", "--sound-only", "--banner-only"],
    ["smoke-notification-desktop.ts", "--sounds", "--all"], ["smoke.mjs", "invented"],
    ["smoke.mjs", "external", "--unknown"], ["smoke.mjs", "external", "--notifications", "--notifications"],
  ]) assert.throws(() => runtimePlan(file, args), undefined, `${file} ${args.join(" ")}`)
  assert.equal(runtimePlan("smoke-permissions.mjs", ["external-edit", "--disabled", "--auto", "--held"]).scenario, "external-edit")
})

test("every declared scenario and flag has at least one valid invocation under its rules", () => {
  for (const [file, entry] of Object.entries(runtimeInventory)) {
    if (entry.classification === "helper") continue
    const valid = (scenario, wanted = []) => {
      const flags = new Set(wanted)
      if (entry.exactlyOne && !entry.exactlyOne.some(f => flags.has(f))) flags.add(entry.exactlyOne[0])
      for (let n = 0; n < 4; n++) for (const rule of entry.rules) {
        if (rule.flag ? flags.has(rule.flag) : rule.scenarios?.includes(scenario)) for (const flag of rule.requires ?? []) flags.add(flag)
      }
      try { return runtimePlan(file, [...(scenario === "default" ? [] : [scenario]), ...[...flags].map(f => "--" + f)]) } catch { return undefined }
    }
    for (const scenario of entry.scenarios) assert.ok(valid(scenario), `${file}/${scenario} is unreachable`)
    for (const flag of entry.flags) assert.ok(entry.scenarios.some(s => valid(s, [flag])), `${file}/--${flag} is unreachable`)
  }
})

test("a multi-scenario fixture can retain its default while explicitly selecting advisory review", () => {
  assert.equal(runtimePlan("smoke-v2-invocation.mjs").scenario, "default")
  assert.equal(runtimePlan("smoke-v2-invocation.mjs", ["review"]).scenario, "review")
  assert.throws(() => runtimePlan("smoke-v2-invocation.mjs", ["review", "extra"]), /Unexpected arguments/)
  assert.throws(() => runtimePlan("smoke-v2-invocation.mjs", ["unsupported"]), /Unknown scenario/)
})

test("V2 acceptance includes each production review case exactly once and retains explicit synthetic classifications", () => {
  const cases = profilePlan("v2-acceptance")
  assert.equal(cases.length, 24, "Exact current production/foundation acceptance selection")
  assert.equal(cases.length, new Set(cases.map(value => value.id)).size)
  const reviews = cases.filter(value => value.entrypoint === "scripts/smoke-v2-review.mjs")
  const expectedReviews = ["advisory", "normal", "fast", "normal-mouse-off", "normal-cancel", "normal-descendant", "fast-descendant",
    "normal-history", "normal-history-default-home", "normal-history-cover", "normal-history-keyboard-mouse-off", "fast-history-cover", "fast-notifications",
    "normal-hide", "normal-dialog", "normal-resize", "fast-dialog", "normal-hidden-complete"].sort()
  assert.deepEqual(reviews.map(value => value.scenario).sort(), expectedReviews)
  assert.deepEqual([...runtimeInventory["smoke-v2-review.mjs"].scenarios].sort(), expectedReviews)
  assert.ok(reviews.every(value => value.classification === "production-host"))
  assert.ok(cases.every(value => value.hostVersion === "opencode v2.0.26" && value.hosts <= 2))
  assert.deepEqual(profilePlan("ci").map(value => value.id).sort(), cases.map(value => value.id).sort(),
    "Current CI contains the exact locally verified acceptance selection")
  for (const id of ["smoke-v2-root-presentation/mouse-on", "smoke-v2-root-presentation/mouse-off", "smoke-v2-native-queue/default"])
    assert.equal(cases.find(value => value.id === id)?.classification, "synthetic-host")
  const defaultHome = cases.find(value => value.id === "smoke-v2-review/normal-history-default-home")
  assert.equal(defaultHome.classification, "production-host")
  assert.deepEqual(defaultHome.args, ["normal-history-default-home"])
  assert.ok(defaultHome.requires.includes("bundle"), "Uses the prior build rather than rebuilding implicitly")
  const keyboardMouseOff = cases.find(value => value.id === "smoke-v2-review/normal-history-keyboard-mouse-off")
  assert.equal(keyboardMouseOff.classification, "production-host")
  assert.deepEqual(keyboardMouseOff.args, ["normal-history-keyboard-mouse-off"])
  assert.ok(keyboardMouseOff.requires.includes("bundle"), "Exercises real production history and approvals from the parent's fresh build")
})

test("fixture verification pins are distinct from plugin activation and require one actual binary for the entire run", () => {
  const ci = profilePlan("ci")
  for (const version of ["opencode v2.0.26", "opencode v2.0.27"]) assert.doesNotThrow(() => assertRuntimeHostVersion(ci, version))
  for (const version of ["opencode v2.0.28", "opencode v2.0.27-beta.1", "2.0.27"])
    assert.throws(() => assertRuntimeHostVersion(ci, version), /unsupported/)
  const historical = runtimePlan("smoke-v2-direct-tools.mjs")
  assert.throws(() => assertRuntimeHostVersion([...ci, historical], "opencode v2.0.27"), /unsupported/)
  assert.throws(() => assertRuntimeHostVersion([...ci, runtimePlan("smoke.mjs", ["external"])], "opencode v2.0.26"), /unsupported/)
  const copy = runtimePlan("smoke-v2-review.mjs", ["normal"])
  copy.hostVersions.push("opencode v9.0.0")
  assert.deepEqual(runtimePlan("smoke-v2-review.mjs", ["normal"]).hostVersions, ["opencode v2.0.26", "opencode v2.0.27"])
})

test("listing and all profile planning work with no host, fixture directory, or bundle access", () => {
  const runner = new URL("../scripts/test-runtime.mjs", import.meta.url).pathname
  const env = { PATH: "", HOME: "/missing-fixture-home", OPENCODE_BIN: "/missing-opencode" }
  for (const args of [["--list"], ["--plan", "--profile", "ci"], ["--plan", "--profile", "w6-affected"],
    ["--plan", "smoke-notification-desktop.ts", "--sounds"], ["--plan", "audit-usage-history.mjs"]]) {
    assert.equal(typeof JSON.parse(execFileSync(process.execPath, [runner, ...args], { env, cwd: "/", encoding: "utf8" })), "object")
  }
  const ci = profilePlan("ci")
  for (const file of ["smoke-v2-lifecycle", "smoke-v2-invocation", "smoke-v2-root-presentation", "smoke-v2-native-queue"])
    assert.ok(ci.some(item => item.id.startsWith(file + "/")))
  assert.ok(ci.every(item => item.hostVersion === "opencode v2.0.26" && item.hosts <= 2))
  assert.ok(ci.some(item => item.id === "smoke-v2-invocation/review"))
  const historical = profilePlan("ci-v1")
  for (const file of ["smoke-approval-geometry", "smoke-fast-mode", "smoke-notification-w4", "smoke-history-lifecycle", "smoke-streaming"])
    assert.ok(historical.some(item => item.id.startsWith(file + "/")))
  assert.ok(historical.every(item => item.hostVersion === "1.18.35" && item.hosts <= 2))
})

test("smoke descriptors retain all old scenarios and independent stage expectations", async () => {
  assert.deepEqual(Object.keys(smokeScenarios).sort(), ["correction", "cancel", "error", "stalled-file", "external", "edit", "write", "patch", "edit-cancel",
    "edit-config-error", "edit-disabled", "bash-disabled", "external-disabled", "auto-shell", "auto-cancel", "auto-scroll", "auto-scroll-success", "auto-edit", "auto-external",
    "auto-immediate", "auto-zero", "auto-unsafe", "auto-error", "auto-hide", "auto-dialog", "auto-fullscreen", "auto-narrow", "auto-manual", "auto-initially-hidden"].sort())
  assert.deepEqual(smokeScenario("external-disabled").plan.reviewKinds, [])
  assert.deepEqual(smokeScenario("auto-external").plan.stages.map(s => [s.kind, s.action]), [["external-directory", "countdown"], ["shell", "countdown"]])
  assert.equal(smokeScenario("write").knownPricing, false)
  assert.equal(smokeScenario("auto-scroll").autoDelay, 25)
  assert.equal(smokeScenario("auto-scroll").cancel, true)
  assert.equal(smokeScenario("auto-scroll-success").cancel, undefined)
  assert.equal(runtimePlan("smoke.mjs", ["auto-scroll-success", "--notifications", "--approval-sound"]).classification, "production-host")
  assert.equal(smokeScenario("auto-zero").autoDelay, 0)
  const seen = []
  for (const name of ["edit", "auto-shell", "correction", "auto-scroll"]) await runSmokeFamily(smokeScenario(name), {
    advisory: () => seen.push("advisory"), approval: () => seen.push("approval"), rendering: () => seen.push("rendering"),
  })
  assert.deepEqual(seen, ["advisory", "approval", "rendering", "rendering"])
})
