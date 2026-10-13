import { test } from "node:test"
import assert from "node:assert/strict"
import { historyWorkerBanner, verifyBundledHistoryWorker } from "../scripts/bundled-history-worker.mjs"
import { archiveFixture } from "./release-fixture.mjs"
import { inspectPackageArchive } from "../scripts/release-artifact.mjs"

const worker = 'throw Error("Never execute worker code during inspection");\n'
const consumer = `var historyWorkerSource = typeof __REVIEWER_HISTORY_WORKER__ === "string" ? __REVIEWER_HISTORY_WORKER__ : "";
var HistoryWorker = class {
  constructor(source = historyWorkerSource) { this.worker = new Worker(source, { eval: true, env: {} }); }
};`
const emit = (inner = consumer) => `${historyWorkerBanner(worker)}
${consumer}
var source = Buffer.from("${Buffer.from(inner).toString("base64")}", "base64").toString("utf8");
new Function("require", "module", "exports", "__REVIEWER_BUNDLED_SOUNDS__", "__REVIEWER_HISTORY_WORKER__", source)(require, module, module.exports, __REVIEWER_BUNDLED_SOUNDS__, __REVIEWER_HISTORY_WORKER__);
export { historyWorkerSource };
throw Error("Never execute package code during inspection");`

const archived = bundle => {
  const files = inspectPackageArchive(archiveFixture()).files
  files.set("dist/tui.js", Buffer.from(bundle))
  const archive = archiveFixture({ entries: [...files].map(([name, content]) => ({ name: `package/${name}`, content })) })
  return inspectPackageArchive(archive).files.get("dist/tui.js").toString("utf8")
}

test("one canonical worker source feeds both real constructors and the fixed loader without evaluation", () => {
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

test("detached exports, constructors, loader arguments and embedded terminal copies fail inspection", () => {
  for (const invalid of [
    emit().replace('source = historyWorkerSource', 'source = "decoy"'),
    emit().replace('new Worker(source,', 'new Worker("decoy",'),
    emit().replace('export { historyWorkerSource };', 'export { HistoryWorker as historyWorkerSource };'),
    emit().replace('module.exports, __REVIEWER_BUNDLED_SOUNDS__, __REVIEWER_HISTORY_WORKER__', 'module.exports, __REVIEWER_BUNDLED_SOUNDS__, "decoy"'),
    emit().replace('"__REVIEWER_HISTORY_WORKER__", source)', '"unexpected", source)'),
    emit().replace('"__REVIEWER_HISTORY_WORKER__", source)', '"__REVIEWER_HISTORY_WORKER__", "decoy")'),
    emit(consumer.replace('source = historyWorkerSource', 'source = "decoy"')),
    emit(`${historyWorkerBanner(worker)}\n${consumer}`),
    emit(`${consumer}\nvar duplicate = ${JSON.stringify(worker)};`),
  ]) {
    assert.throws(() => verifyBundledHistoryWorker(invalid, worker))
    assert.throws(() => verifyBundledHistoryWorker(archived(invalid), worker))
  }
})
