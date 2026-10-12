import assert from "node:assert/strict"
import { reviewStagePlan } from "./smoke-stages.mjs"

const advisory = (options = {}) => ({ family: "advisory", ...options })
const approval = (options = {}) => ({ family: "approval", auto: true, ...options })
const rendering = (options = {}) => ({ family: "rendering", ...options })

/** Fixture setup, never production policy. Behavioral assertions remain in the drivers. */
export const smokeScenarios = {
  correction: rendering({ correction: true, withUsage: true, reviewEdits: false, long: true }),
  cancel: advisory({ heldReview: true, initialWidth: 80 }),
  error: advisory({ error: true }),
  "stalled-file": advisory({ unsafe: true, stalled: true }),
  external: advisory({ isExternal: true, unsafe: true }),
  edit: advisory({ isEdit: true, correction: true, withUsage: true, reviewBash: false }),
  write: advisory({ isEdit: true, tool: "write", withUsage: true, unpriced: true }),
  patch: advisory({ isEdit: true, tool: "apply_patch", unsafe: true, withUsage: true }),
  "edit-cancel": advisory({ isEdit: true, heldReview: true }),
  "edit-config-error": advisory({ isEdit: true, configFailure: true, reviewBash: false }),
  "edit-disabled": advisory({ isEdit: true, disabledReview: true, reviewEdits: false }),
  "bash-disabled": advisory({ disabledReview: true, reviewBash: false }),
  "external-disabled": advisory({ isExternal: true, disabledReview: true, reviewBash: false, reviewExternalDirectories: false }),
  "auto-shell": approval({ withUsage: true }),
  "auto-cancel": approval({ cancel: true }),
  "auto-scroll": rendering({ auto: true, scroll: true, cancel: true, withUsage: true, autoDelay: 25, long: true }),
  "auto-scroll-success": rendering({ auto: true, scroll: true, withUsage: true, autoDelay: 25, long: true }),
  "auto-edit": approval({ isEdit: true }),
  "auto-external": approval({ isExternal: true }),
  "auto-immediate": approval({ autoDelay: 15, early: true }),
  "auto-zero": approval({ autoDelay: 0 }),
  "auto-unsafe": approval({ unsafe: true }),
  "auto-error": approval({ error: true }),
  "auto-hide": approval({ visibilityLoss: true }),
  "auto-dialog": approval({ visibilityLoss: true }),
  "auto-fullscreen": approval({ visibilityLoss: true }),
  "auto-narrow": approval({ visibilityLoss: true }),
  "auto-manual": approval({ autoDelay: 15, early: true }),
  "auto-initially-hidden": approval({ initialWidth: 80 }),
}

export function smokeScenario(name) {
  assert.ok(Object.hasOwn(smokeScenarios, name), `Unknown smoke scenario: ${name}`)
  const scenario = { auto: false, isEdit: false, isExternal: false, disabledReview: false,
    heldReview: false, correction: false, withUsage: false, configFailure: false, visibilityLoss: false,
    ...smokeScenarios[name] }
  scenario.autoDelay ??= scenario.visibilityLoss ? 8 : 3
  scenario.initialWidth ??= 160
  scenario.knownPricing = scenario.withUsage && !scenario.unpriced
  scenario.tool ??= scenario.isEdit ? "edit" : "bash"
  scenario.plan = reviewStagePlan(scenario.isExternal
    ? [{ kind: "external-directory", permission: "external_directory" }, { kind: "shell", permission: "bash" }]
    : [{ kind: scenario.isEdit ? "edit" : "shell", permission: scenario.isEdit ? "edit" : "bash" }], {
    reviewBash: scenario.reviewBash ?? true, reviewEdits: scenario.reviewEdits ?? true,
    reviewMcp: false, reviewCustomTools: false, reviewExternalDirectories: scenario.reviewExternalDirectories ?? true,
  }, { auto: scenario.auto, held: scenario.heldReview, correction: scenario.correction,
    unavailable: scenario.configFailure, unsafe: scenario.unsafe, error: scenario.error, cancel: name === "auto-cancel" })
  return scenario
}

/** Named family dispatch keeps the CLI and planning data independent of host setup. */
export async function runSmokeFamily(scenario, { advisory, approval, rendering }) {
  assert.ok(["advisory", "approval", "rendering"].includes(scenario.family))
  return ({ advisory, approval, rendering })[scenario.family]()
}
