import assert from "node:assert/strict"
import { test } from "node:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectEvidence, discover } from "../src/evidence.js"

const limits = { maxEvidenceBytes: 65536, maxFiles: 8 }
const signal = () => new AbortController().signal

test("Jupyter launch, conversion and execution capture only named notebook inputs", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-notebook-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = JSON.stringify({ cells: [{ cell_type: "code", source: ["print('hello')\n"], outputs: [] }],
    metadata: {}, nbformat: 4, nbformat_minor: 5 }) + "\n"
  for (const name of ["book.ipynb", "second.ipynb", "generated.ipynb"]) await writeFile(`${dir}/${name}`, source)
  await writeFile(`${dir}/config.py`, "# only config, not imported notebook\n")
  await writeFile(`${dir}/settings.json`, "{\"debug\":false}\n")
  const command = "jupyter lab book.ipynb < settings.json; jupyter notebook second.ipynb; "
    + "jupyter nbconvert --config config.py --to notebook --execute book.ipynb second.ipynb --output generated.ipynb; "
    + "jupyter execute book.ipynb --output generated.ipynb"
  const result = await collectEvidence({ command, cwd: dir, userPrompt: "Inspect" }, limits, signal())
  assert.deepEqual(result.files.map(file => file.filename), ["book.ipynb", "settings.json", "second.ipynb", "config.py"])
  assert.equal(result.files[0]?.contents, source)
  assert.ok(result.files.every(file => file.status === "captured"))
  assert.equal(result.files.find(file => file.filename === "generated.ipynb"), undefined)
})

test("Jupyter options, indirect notebooks and browser-only launches remain unclaimed", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-notebook-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const marker = `${dir}/not-executed`
  for (const command of ["jupyter lab", "jupyter lab build notebook.ipynb",
    "jupyter lab --notebook-dir elsewhere notebook.ipynb",
    "jupyter lab notebook.ipynb --ServerApp.root_dir=elsewhere",
    "jupyter nbconvert --to notebook --output generated.ipynb *.ipynb",
    "jupyter execute 'notebook*.ipynb'", "jupyter lab https://example.test/book.ipynb",
    `jupyter lab "$(touch ${marker}; printf notebook.ipynb)"`,
    "jupyter nbconvert --config config.py --unknown notebook.ipynb",
    "jupyter lab notebook.ipynb another.ipynb"] ) {
    const result = discover(command, dir)
    assert.deepEqual(result.references, [], command)
    assert.ok(result.limitations.length, command)
  }
  await assert.rejects(access(marker))
  assert.deepEqual(discover("jupyter nbconvert --stdin < book.ipynb > generated.ipynb", dir).references,
    [{ filename: "book.ipynb", cwd: dir, executable: false }])
  assert.deepEqual(discover("./book.ipynb", dir).references,
    [{ filename: "./book.ipynb", cwd: dir, executable: true }])
  assert.deepEqual(discover("cd notebooks && jupyter lab book.ipynb", dir).references,
    [{ filename: "book.ipynb", cwd: `${dir}/notebooks`, executable: false }])
  assert.deepEqual(discover("cd notebooks; jupyter lab book.ipynb", dir).references,
    [{ filename: "book.ipynb", cwd: null, executable: false }])
})

test("Jupyter notebooks use existing UTF-8 and evidence limits without parsing or running cells", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-notebook-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const invalidJson = '{"cells": [not JSON]\n'
  await writeFile(`${dir}/bad.ipynb`, invalidJson)
  await writeFile(`${dir}/binary.ipynb`, Buffer.from([0xff, 0xfe, 0xfd]))
  const small = await collectEvidence({ command: "jupyter lab bad.ipynb; jupyter execute binary.ipynb", cwd: dir, userPrompt: "Inspect" }, limits, signal())
  assert.equal(small.files[0]?.contents, invalidJson)
  assert.equal(small.files[0]?.status, "captured")
  assert.match(small.files[1]!.status, /not valid UTF-8/)
  const direct = await collectEvidence({ command: "./bad.ipynb", cwd: dir, userPrompt: "Inspect" }, limits, signal())
  assert.match(direct.files[0]!.status, /not identifiable as supported script source/)
  assert.equal(direct.files[0]!.contents, undefined)
  const large = '{\n' + '  "outputs": "' + 'x'.repeat(6000) + '",\n'
    + '  "cell_type": "code",\n  "source": [\n    "print(42)"\n  ]\n' + '  "metadata": {},\n'.repeat(40) + '}\n'
  await writeFile(`${dir}/large.ipynb`, large)
  const excerpt = await collectEvidence({ command: "jupyter nbconvert --to notebook large.ipynb", cwd: dir, userPrompt: "Inspect" },
    { maxFiles: 1, maxEvidenceBytes: 1100 }, signal())
  assert.equal(excerpt.files[0]?.status, "excerpt")
  assert.match(excerpt.files[0]!.contents!, /"cell_type": "code"/)
  assert.match(excerpt.files[0]!.contents!, /"source": \[/)
  assert.ok(Buffer.byteLength(excerpt.files[0]!.contents!) <= 1100 - Buffer.byteLength("jupyter nbconvert --to notebook large.ipynb"))
  assert.match(excerpt.files[0]!.contents!, /missing \d+ more lines/)
})
