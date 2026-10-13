import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { runtimeInventory, runtimeProfiles, runtimePlan, profilePlan, assertRuntimeHostVersion } from "../scripts/runtime-inventory.mjs"

const scripts = new URL("../scripts/", import.meta.url)

export async function checkDiscovery(files, read) {
  const discovered = files.filter(file => /^(smoke(?:-|\.)|audit-|runtime-|test-runtime\.)/.test(file)).sort()
  assert.deepEqual(discovered, Object.keys(runtimeInventory).sort(), "Every runtime entrypoint/helper needs an explicit classification")
  for (const file of discovered) {
    const entry = runtimeInventory[file], source = await read(file)
    assert.ok(["production-host", "synthetic-host", "interactive", "helper"].includes(entry.classification))
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
  await assert.rejects(checkDiscovery(files, async file => (await read(file)) + (file === "smoke-v2-review.mjs" ? '\nprocess.argv.includes("--forgotten")' : "")), /flag declarations/)
  await assert.rejects(checkDiscovery(files, async file => (await read(file)) + (file === "smoke-v2-review.mjs" ? '\nif (scenario === "forgotten") {}' : "")), /unregistered scenario/)
})

test("production, synthetic and interactive fixtures retain explicit classifications", () => {
  assert.equal(runtimePlan("smoke-v2-review.mjs", ["normal-history"]).classification, "production-host")
  assert.equal(runtimePlan("smoke-v2-root-presentation.mjs", ["mouse-off"]).classification, "synthetic-host")
  assert.equal(runtimePlan("smoke-notification-desktop.ts", ["--sounds"]).classification, "interactive")
})

test("rules reject unsupported scenario/flag combinations instead of promising a Cartesian matrix", () => {
  for (const [file, ...args] of [
    ["smoke-v2-review.mjs", "normal-edit", "--auto"],
    ["smoke-v2-review.mjs", "normal", "--unknown"],
    ["smoke-v2-review.mjs", "invented"], ["smoke-v2-review.mjs", "normal", "extra"],
    ["smoke-v2-lifecycle.mjs", "default"],
    ["smoke-notification-desktop.ts"], ["smoke-notification-desktop.ts", "--sounds", "--all"],
    ["smoke-notification-desktop.ts", "--sounds", "--sounds"], ["smoke-notification-desktop.ts", "--critical"],
  ]) assert.throws(() => runtimePlan(file, args), undefined, `${file} ${args.join(" ")}`)
  assert.deepEqual(runtimePlan("smoke-notification-desktop.ts", ["--sounds", "--critical"]).flags, ["critical", "sounds"])
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
  assert.equal(cases.length, 33, "Exact current production/foundation acceptance selection")
  assert.equal(cases.length, new Set(cases.map(value => value.id)).size)
  const reviews = cases.filter(value => value.entrypoint === "scripts/smoke-v2-review.mjs")
  const expectedReviews = ["advisory", "normal", "fast", "normal-mouse-off", "normal-cancel", "normal-descendant", "fast-descendant",
    "normal-history", "normal-history-default-home", "normal-history-cover", "normal-history-keyboard-mouse-off", "fast-history-cover", "fast-notifications",
    "normal-hide", "normal-dialog", "normal-resize", "fast-dialog", "normal-hidden-complete", "normal-route-wait", "normal-decision", "fast-decision", "normal-edit", "normal-directory-edit"].sort()
  assert.deepEqual(reviews.map(value => value.scenario).sort(), expectedReviews)
  assert.deepEqual([...runtimeInventory["smoke-v2-review.mjs"].scenarios].sort(), expectedReviews)
  assert.ok(reviews.every(value => value.classification === "production-host"))
  assert.ok(cases.every(value => value.hostMajor === 2 && value.hosts <= 2))
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
  const notifications = cases.filter(value => value.entrypoint === "scripts/smoke-v2-notifications.mjs")
  assert.deepEqual(notifications.map(value => value.scenario).sort(), ["execution", "forms", "manual-handoff", "unavailable-review"])
  assert.ok(notifications.every(value => value.classification === "production-host" && value.requires.includes("bundle")))
})

test("fixtures accept stable V2 releases without a host-version allowlist", () => {
  const ci = profilePlan("ci")
  for (const version of ["opencode v2.0.28", "opencode v2.99.99"]) assert.doesNotThrow(() => assertRuntimeHostVersion(ci, version))
  for (const version of ["opencode v3.0.0", "opencode v2.0.27-beta.1", "2.0.27"])
    assert.throws(() => assertRuntimeHostVersion(ci, version), /stable OpenCode V2/)
  const historical = runtimePlan("smoke-v2-direct-tools.mjs")
  assert.doesNotThrow(() => assertRuntimeHostVersion([...ci, historical], "opencode v2.99.99"))
})

test("listing and all profile planning work with no host, fixture directory, or bundle access", () => {
  const runner = new URL("../scripts/test-runtime.mjs", import.meta.url).pathname
  const env = { PATH: "", HOME: "/missing-fixture-home", OPENCODE_BIN: "/missing-opencode" }
  for (const args of [["--list"], ...Object.keys(runtimeProfiles).map(name => ["--plan", "--profile", name]),
    ["--plan", "smoke-notification-desktop.ts", "--sounds"], ["--plan", "smoke-v2-invocation.mjs", "review"]]) {
    assert.equal(typeof JSON.parse(execFileSync(process.execPath, [runner, ...args], { env, cwd: "/", encoding: "utf8" })), "object")
  }
  const ci = profilePlan("ci")
  for (const file of ["smoke-v2-lifecycle", "smoke-v2-invocation", "smoke-v2-root-presentation", "smoke-v2-native-queue"])
    assert.ok(ci.some(item => item.id.startsWith(file + "/")))
  assert.ok(ci.every(item => item.hostMajor === 2 && item.hosts <= 2))
  assert.ok(ci.some(item => item.id === "smoke-v2-invocation/review"))
})

test("only V2 host fixtures and profiles remain; permissions selects invocation and native edit stages", () => {
  assert.deepEqual(Object.keys(runtimeProfiles).sort(), ["ci", "v2-acceptance", "v2-permissions"])
  for (const name of ["ci-v1", "f34", "w6-affected", "w6-extended"]) assert.throws(() => profilePlan(name), /Unknown runtime profile/)
  for (const name of ["smoke.mjs", "smoke-permissions.mjs", "audit-usage-history.mjs"]) assert.throws(() => runtimePlan(name), /Unknown runnable fixture/)
  for (const [file, entry] of Object.entries(runtimeInventory)) if (entry.hosts) {
    assert.ok(file.startsWith("smoke-v2-"))
    assert.equal(entry.hostMajor, 2)
  }
  assert.deepEqual(profilePlan("v2-permissions").map(item => item.id), ["smoke-v2-invocation/default", "smoke-v2-invocation/review",
    "smoke-v2-review/normal-edit", "smoke-v2-review/normal-directory-edit"])
})
