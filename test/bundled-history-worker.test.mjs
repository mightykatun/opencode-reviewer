import { test } from "node:test"
import assert from "node:assert/strict"
import { assertNoBundledHistoryWorker, historyWorkerBanner, verifyBundledHistoryWorker } from "../scripts/bundled-history-worker.mjs"
import { archiveFixture, fixturePackage } from "./release-fixture.mjs"
import { inspectPackageArchive, packageLayout } from "../scripts/release-artifact.mjs"

const worker = 'throw Error("Never execute worker code during inspection");\n'
const consumer = `var historyWorkerSource = typeof __REVIEWER_HISTORY_WORKER__ === "string" ? __REVIEWER_HISTORY_WORKER__ : "";
var HistoryWorker = class {
  constructor(source = historyWorkerSource) { this.worker = new Worker(source, { eval: true, env: {} }); }
};`
const emit = () => `${historyWorkerBanner(worker)}
${consumer}
export { historyWorkerSource };
throw Error("Never execute package code during inspection");`

const archived = bundle => {
  const layout = packageLayout("2.9.0")
  const files = inspectPackageArchive(archiveFixture({ pkg: fixturePackage("2.9.0") }), layout).files
  assertNoBundledHistoryWorker(files.get("dist/server.js").toString("utf8"))
  files.set("dist/tui.js", Buffer.from(bundle))
  const archive = archiveFixture({ entries: [...files].map(([name, content]) => ({ name: `package/${name}`, content })) })
  return inspectPackageArchive(archive, layout).files.get("dist/tui.js").toString("utf8")
}

test("one canonical worker source feeds the terminal constructor without evaluation", () => {
  assert.throws(() => assertNoBundledHistoryWorker(emit()))
  assert.equal(verifyBundledHistoryWorker(emit(), worker), worker)
  assert.equal(verifyBundledHistoryWorker(archived(emit()), worker), worker)
})

test("missing, duplicate, altered and executable worker mappings cannot pass through decoys", () => {
  const original = emit()
  for (const invalid of [
    original.replace(historyWorkerBanner(worker), ""),
    original + `\n${historyWorkerBanner(worker)}`,
    original.replace(historyWorkerBanner(worker), historyWorkerBanner("replacement")),
    original.replace(historyWorkerBanner(worker), 'const __REVIEWER_HISTORY_WORKER__ = globalThis.execute();'),
    original.replace(historyWorkerBanner(worker), 'const __REVIEWER_HISTORY_WORKER__ = "";'),
    original.replace(historyWorkerBanner(worker), `const __REVIEWER_HISTORY_WORKER__ = ${JSON.stringify(worker).replace('throw', '\\u0074hrow')};`),
    original + `\nconst decoy = ${JSON.stringify(worker)};`,
  ]) {
    assert.throws(() => verifyBundledHistoryWorker(invalid, worker))
    assert.throws(() => verifyBundledHistoryWorker(archived(invalid), worker))
  }
})

test("detached exports, constructors and altered worker options fail inspection", () => {
  for (const invalid of [
    emit().replace('source = historyWorkerSource', 'source = "decoy"'),
    emit().replace('new Worker(source,', 'new Worker("decoy",'),
    emit().replace('export { historyWorkerSource };', 'export { HistoryWorker as historyWorkerSource };'),
    emit().replace("eval: true", "eval: false"),
    emit().replace("eval: true", "eval: true, eval: false"),
    emit().replace("env: {}", "env: process.env"),
  ]) {
    assert.throws(() => verifyBundledHistoryWorker(invalid, worker))
    assert.throws(() => verifyBundledHistoryWorker(archived(invalid), worker))
  }
})
