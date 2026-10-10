// Production packed storage adapter proof, isolated from live reviewer/UI integration.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { inspectPackageArchive } from "./release-artifact.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation } from "./smoke-observations.mjs"

runtimeArguments("smoke-history-storage.mjs")

const root = path.resolve(import.meta.dirname, "..")
const host = process.env.OPENCODE_BIN ?? "opencode"
assert.equal(execFileSync(host, ["--version"], { encoding: "utf8" }).trim(), "1.18.35")
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-history-storage-"))
const artifacts = path.join(root, ".runtime/history-storage")
await mkdir(artifacts, { recursive: true })
const project = path.join(temp, "project")
await mkdir(project)
await mkdir(path.join(temp, "config"))
await mkdir(path.join(temp, "untrusted-state"), { mode: 0o770 })
await chmod(path.join(temp, "untrusted-state"), 0o770) // Only this newly created synthetic negative control.
execFileSync("git", ["init", "--quiet", project])
const output = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: root, encoding: "utf8" }))
const pack = Array.isArray(output) ? output[0] : output["opencode-reviewer"]
const { files } = inspectPackageArchive(await readFile(path.join(temp, pack.filename)))
assert.equal(files.size, 5)
// Synthetic host diagnostics only. The packed worker retains its fixed, redacted
// errors; this separate read-only probe identifies runtime/namespace failures.
const diagnosticSource = String.raw`
const {parentPort}=require('node:worker_threads'), fs=require('node:fs'), path=require('node:path');
parentPort.on('message', ({id,file}) => {
  const identity = name => { try { return {type:typeof process[name],value:process[name]?.()} } catch(error) { return {error:String(error)} } };
  const value={platform:process.platform,bun:process.versions.bun,uid:identity('getuid'),euid:identity('geteuid'),environmentKeys:Object.keys(process.env).length,ancestors:[]};
  try { value.kernelUID=fs.readFileSync('/proc/thread-self/status','utf8').split('\n').find(line=>line.startsWith('Uid:')) } catch(error) { value.kernelError=String(error) }
  let current='/';
  for(const part of ['',...path.dirname(file).split('/').filter(Boolean)]) {
    if(part)current=path.join(current,part);
    try { const s=fs.lstatSync(current); value.ancestors.push({path:current,uid:s.uid,mode:s.mode&0o7777,directory:s.isDirectory(),symlink:s.isSymbolicLink()}) }
    catch(error) { value.ancestors.push({path:current,error:error.code}); break }
  }
  try { const db=new(require('bun:sqlite').Database)(':memory:'); try { db.exec('PRAGMA secure_delete=ON'); value.secureDelete=db.prepare('PRAGMA secure_delete').get() } finally { db.close() } }
  catch(error) { value.sqliteError=String(error) }
  parentPort.postMessage({id,value});
});`
const bundle = path.join(temp, "bundle.mjs"), record = path.join(temp, "proof.json"), wrapper = path.join(temp, "storage.mjs")
await writeFile(bundle, files.get("dist/tui.js"))
await writeFile(wrapper, `
import { HistoryStore, historyWorkerSource } from ${JSON.stringify(pathToFileURL(bundle).href)}
import { Worker } from 'node:worker_threads'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { publishObservation } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)}
const context = { scope: '/synthetic', root: 'root', session: 'child', permission: 'permission', review: 'early', category: 'bash', configuredModel: 'configured', provider: 'https://example.com/v1' }
const marker = 'PRIVATE_BUN_REPORT_47a9e9c4_DELETION_PROOF'
const contains = file => ['', '-wal', '-shm', '-journal'].filter(suffix => existsSync(file+suffix)).some(suffix => readFileSync(file+suffix).includes(Buffer.from(marker)))
export default { id: 'history-storage-proof', tui: async api => {
  const result = { packed: true, adapter: 'bun' }
  const stores = [new HistoryStore(api.state.path.state), new HistoryStore(api.state.path.state)]
  const workers = [], databases = []
  let messageID = 0
  const request = (worker, message) => new Promise((resolve,reject) => {
    const id = ++messageID
    const receive = m => { if (m.id !== id) return; clearTimeout(timer); worker.off('message', receive); m.error ? reject(Error(m.error)) : resolve(m.value) }
    const timer = setTimeout(() => { worker.off('message', receive); reject(Error('worker timeout')) }, 8000)
    worker.on('message', receive); worker.postMessage({...message,id})
  })
  const worker = (source=historyWorkerSource) => { const w = new Worker(source, {eval:true,env:{}}); w.on('error',()=>{}); workers.push(w); return w }
  const enqueue = (store, event) => new Promise((resolve,reject) => {
    const timer = setTimeout(() => { off(); fail(); reject(Error('commit timeout')) }, 8000)
    const off = store.onCommit(() => { clearTimeout(timer); off(); fail(); resolve() })
    const fail = store.onWriteFailure(() => { result.writeFailure = true })
    if (!store.admit(event)) { clearTimeout(timer); off(); fail(); reject(Error('admission failed')) }
  })
  api.lifecycle.onDispose(() => Promise.all(stores.map(s => s.dispose())))
  try {
    // The exact embedded production source receives no process environment.
    const probe = worker(), probeFile = api.state.path.state+'/probe/history-v1.sqlite'
    const diagnostics=worker(${JSON.stringify(diagnosticSource)})
    result.runtimeDiagnostics=await request(diagnostics,{file:probeFile})
    await publishObservation(${JSON.stringify(record + ".diagnostics")},result.runtimeDiagnostics)
    const untrusted=worker(), untrustedFile=${JSON.stringify(path.join(temp, "untrusted-state/private/history-v1.sqlite"))}
    try { await request(untrusted,{type:'open',file:untrustedFile,adapter:'bun'}); throw Error('unsafe ancestor accepted') }
    catch(error) { result.untrustedAncestorError=String(error) }
    result.untrustedDatabaseCreated=existsSync(untrustedFile)
    result.environment = await request(probe, {type:'open',file:probeFile,adapter:'bun'})
    const probeEvent = {type:'permissionResolved',context,at:1,outcome:'manual',payload:{safe:true,completedAt:1,desc:marker.repeat(1000)}}
    await request(probe, {type:'apply',writer:'legacy',sequence:1,event:JSON.stringify(probeEvent)})
    await request(probe, {type:'close'})
    // Emulate a pre-policy deleted payload on the actual Bun adapter. Ordinary
    // cleanup must identify, not claim to erase, old freelist plaintext.
    const legacy = new Database(probeFile)
    try { legacy.exec('PRAGMA foreign_keys=ON; DROP TRIGGER history_privacy_delete; DROP TRIGGER history_privacy_replace; DROP TABLE history_privacy; PRAGMA secure_delete=OFF; DELETE FROM history; PRAGMA wal_checkpoint(TRUNCATE)') }
    finally { legacy.close() }
    result.legacyBefore = contains(probeFile)
    await request(probe, {type:'open',file:probeFile,adapter:'bun'})
    result.legacyFreelistScrubSlices = 0
    do {
      result.legacyOrdinary = await request(probe, {type:'cleanup'})
      if (++result.legacyFreelistScrubSlices>30) throw Error('legacy scrub did not settle')
    } while(result.legacyOrdinary.pending)
    result.legacyStillPresent = contains(probeFile)
    result.legacyCompacted = await request(probe, {type:'compactLegacy'})
    result.legacyAfter = contains(probeFile)
    await Promise.all(stores.map((s,i) => enqueue(s, { type:'attemptFinalized', context:{...context,review:'review'+i}, at:1, attempt:'1', usage:{input:2,output:1,cost:0.1} })))
    await enqueue(stores[0], { type:'reviewAccepted', context, at:2, accepted:{safe:true,completedAt:2} })
    const later = {...context,review:'later'}
    await enqueue(stores[1], { type:'reviewAccepted', context:later, at:3, accepted:{safe:false,completedAt:3} })
    await enqueue(stores[0], { type:'approvalConfirmed', context, at:4, approval:'write', automatic:true })
    await enqueue(stores[1], { type:'permissionResolved', context:later, at:5, outcome:'manual', payload:{safe:false,completedAt:3,desc:marker.repeat(1000),reportedModel:'reported'} })
    result.history = await stores[0].query({type:'history',scope:context.scope,root:context.root})
    result.totals = await stores[1].query({type:'totals'})
    const file = api.state.path.state+'/opencode-reviewer/history-v1.sqlite'
    result.markerBefore = contains(file)
    const reader = new Database(file); databases.push(reader)
    reader.exec('BEGIN'); reader.query('SELECT body FROM payloads').get()
    await enqueue(stores[0], {type:'sessionDeleted',context:{scope:context.scope,root:context.root,session:context.root},at:6})
    await enqueue(stores[1], { type:'permissionResolved', context:later, at:7, outcome:'manual', payload:{safe:false,completedAt:3,desc:'Must not resurrect'} })
    result.deleted = await stores[1].query({type:'history',scope:context.scope,root:context.root})
    result.retainedTotals = await stores[0].query({type:'totals'})
    const observer = worker()
    await request(observer, {type:'open',file,adapter:'bun'})
    result.busyCleanup = await request(observer, {type:'cleanup'})
    result.markerWhileBusy = contains(file)
    reader.exec('ROLLBACK')
    // No explicit checkpoint here: production HistoryStore owns the retries.
    const cleanupEnd = Date.now()+10000
    while ((contains(file) || reader.query('SELECT generation>cleaned AS dirty FROM history_privacy').get().dirty) && Date.now()<cleanupEnd)
      await new Promise(resolve=>setTimeout(resolve,20))
    result.markerAfterOwnedRetry = contains(file)
    result.cleanedWhileOpen = !reader.query('SELECT generation>cleaned AS dirty FROM history_privacy').get().dirty
    result.payloadRows = reader.query('SELECT count(*) n FROM payloads').get().n
    result.tombstones = reader.query('SELECT count(*) n FROM tombstones').get().n
    const start = performance.now()
    await Promise.all(stores.map(s => s.dispose(start)))
    result.disposalMs = performance.now()-start
    const reopened = new HistoryStore(api.state.path.state)
    try { result.reopened = await reopened.query({type:'totals'}) } finally { await reopened.dispose() }
  } catch(error) { result.error = String(error) }
  finally { for(const db of databases) { try { db.close() } catch {} }; await Promise.all(stores.map(s => s.dispose())); await Promise.all(workers.map(w=>w.terminate())) }
  await publishObservation(${JSON.stringify(record)}, result)
} }
`)
const runtime = await smokeRuntime(temp)
try {
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ plugin: [wrapper] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  await runtime.start("-d", "-s", "proof", "-x", "160", "-y", "40", "-c", project, "env", ...Object.entries(env).map(([k,v]) => k+"="+v), host, project)
  let proof
  const end = Date.now() + 60000
  while (Date.now() < end) {
    proof = await readObservation(record, { optional: true })
    if (proof) break
    await sleep(100)
  }
  await writeFile(path.join(artifacts, "capture.txt"), runtime.tmux("capture-pane", "-p", "-t", "proof"))
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ proof, temp, packedFiles: [...files.keys()] }, null, 2))
  assert.ok(proof, "compiled host completed storage proof")
  assert.equal(proof.error, undefined)
  assert.equal(proof.untrustedAncestorError, 'Error: invalid')
  assert.equal(proof.untrustedDatabaseCreated, false)
  assert.equal(proof.environment.environmentKeys, 0)
  assert.equal(proof.history.record.payload.safe, false)
  assert.equal(proof.history.record.outcome, "auto")
  assert.equal(proof.history.record.payload.reportedModel, "reported")
  assert.equal(proof.totals.totals.requests, 2)
  assert.equal(proof.totals.totals.safe, 1)
  assert.equal(proof.totals.totals.unsafe, 1)
  assert.equal(proof.totals.totals.activity.autoApproved, 1)
  assert.equal(proof.deleted.total, 0)
  assert.equal(proof.markerBefore, true)
  assert.deepEqual(proof.busyCleanup, {pending:true,legacy:false})
  assert.equal(proof.markerWhileBusy, true)
  assert.equal(proof.markerAfterOwnedRetry, false)
  assert.equal(proof.cleanedWhileOpen, true)
  assert.equal(proof.payloadRows, 0)
  assert.equal(proof.tombstones, 1)
  assert.equal(proof.legacyBefore, true)
  assert.deepEqual(proof.legacyOrdinary, {pending:false,legacy:true})
  assert.ok(proof.legacyFreelistScrubSlices>1)
  assert.equal(proof.legacyStillPresent, true)
  assert.deepEqual(proof.legacyCompacted, {pending:false,legacy:false})
  assert.equal(proof.legacyAfter, false)
  assert.deepEqual(proof.retainedTotals.totals, proof.totals.totals)
  assert.deepEqual(proof.reopened.totals, proof.totals.totals)
  assert.ok(proof.disposalMs < 4000)
  console.log("PASS packed production Bun SQLite adapter, busy-reader cleanup, legacy freelist scrub and residual compaction, two clients, totals, tombstones, reopen and disposal: " + artifacts)
} finally { await runtime.dispose() }
