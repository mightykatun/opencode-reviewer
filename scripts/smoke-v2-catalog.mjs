// W1 catalog-size and provider-contract probe. No reviewer or live provider.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { build } from "esbuild"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimeArguments, assertV2HostVersion } from "./runtime-inventory.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { readObservation, publishObservation } from "./smoke-observations.mjs"
import promptInventory from "../src/prompt-files.json" with { type: "json" }

runtimeArguments("smoke-v2-catalog.mjs")
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assertV2HostVersion(version)
const root = path.resolve(import.meta.dirname, "..")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime/v2-catalog-"))
const temp = await mkdtemp("/tmp/opencode/reviewer-v2-catalog-")
const project = path.join(temp, "project"), plugin = path.join(temp, "probe")
await mkdir(project)
await mkdir(plugin)
await mkdir(path.join(temp, "config/opencode"), { recursive: true })
execFileSync("git", ["init", "--quiet", project])
const control = path.join(artifacts, "control.json")
const serverObservation = path.join(artifacts, "server.json"), cliObservation = path.join(artifacts, "cli.json")
const publisherImport = JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)
await publishObservation(control, { stage: "baseline" })
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "research-v2-catalog", type: "module",
  exports: { ".": "./server.mjs", "./tui": "./tui.mjs" } }))
const prompts = Object.fromEntries(await Promise.all(Object.entries(promptInventory).map(async ([name, file]) =>
  [name, (await readFile(path.join(root, file), "utf8")).trim()])))
await build({ stdin: { contents: 'export { review } from "./src/reviewer.ts"; export { parseConfig } from "./src/config.ts"',
  resolveDir: root, loader: "ts" }, outfile: path.join(plugin, "reviewer.mjs"), bundle: true,
  platform: "node", format: "esm", target: "es2023", define: { __REVIEW_PROMPTS__: JSON.stringify(prompts) } })
await writeFile(path.join(plugin, "server.mjs"), `
import { Plugin } from '@opencode/plugin'
import { observationPublisher, readObservation } from ${publisherImport}
export default Plugin.define({id:'research.v2.catalog.server', async setup(ctx) {
  const publisher=observationPublisher(${JSON.stringify(serverObservation)})
  const result={stage:'baseline', catalogs:[], contexts:[], before:[], errors:[]}
  const publish=()=>publisher.publish(result)
  let stage='baseline', closed=false, pending
  const snapshot=async()=>result.catalogs.push({stage, tools:await ctx.tool.list()})
  // Copies of a real native schema stress transport cardinality only. They are
  // explicitly synthetic definitions, not a claimed real-world MCP inventory.
  await ctx.tool.transform(editor=>{
    if(stage!=='overflow') return
    const schema=editor.get('shell').input
    for(let i=0;i<129;i++) editor.add({name:'limit_'+i,description:'Synthetic shell-schema cardinality control',
      input:schema, options:{namespace:'catalog',codemode:true},
      execute:async()=>{throw Error('Catalog controls must never execute')}})
  })
  // This catalog-only Promise transform measures presentation. Executor/error
  // equivalence is covered by the Effect profile in smoke-v2-direct-tools.mjs;
  // Promise editor.update wraps executors even for options-only changes.
  const activate=()=>ctx.tool.transform(editor=>{
    for(const tool of editor.list()) editor.update(tool.id,draft=>{
      const {pinned,...options}=draft.options??{}
      draft.options={...options,codemode:false}
    })
  })
  await ctx.session.hook('context',event=>{
    if(event.model.providerID!=='fixture') throw Error('Non-fixture model selected')
    if(stage!=='baseline') delete event.tools.execute
    result.contexts.push({stage,sessionID:event.sessionID,tools:event.tools})
    void publish()
  })
  await ctx.session.hook('title',event=>{event.result='Catalog probe'})
  await ctx.session.hook('http.request',event=>{
    if(new URL(event.request.url).hostname!=='127.0.0.1') throw Error('Non-fixture model endpoint')
  })
  await ctx.tool.hook('execute.before',event=>{result.before.push(event);void publish()})
  await snapshot(); await publish()
  const update=async()=>{
    const command=await readObservation(${JSON.stringify(control)})
    if(closed || command.stage===stage) return
    if(!['direct','overflow'].includes(command.stage)) throw Error('Invalid catalog control')
    if(command.stage==='direct') {
      result.catalogs.push({stage:'before-direct',tools:await ctx.tool.list()})
      await activate()
    }
    stage=command.stage
    await ctx.tool.reload(); await snapshot()
    result.stage=stage; await publish()
  }
  const timer=setInterval(()=>{if(closed||pending)return
    pending=update().catch(error=>{result.errors.push(String(error));void publish()}).finally(()=>{pending=undefined})
  },100)
  return async()=>{closed=true;clearInterval(timer);await pending;result.cleaned=true;await publish();await publisher.close()}
}})
`)
await writeFile(path.join(plugin, "tui.mjs"), `
import { Plugin } from '@opencode/plugin/tui'
import { observationPublisher } from ${publisherImport}
import { review, parseConfig } from './reviewer.mjs'
export default Plugin.define({id:'research.v2.catalog.cli',setup(ctx){
  const publisher=observationPublisher(${JSON.stringify(cliObservation)})
  const result={events:[],errors:[],prompts:0}, tasks=new Set(), abort=new AbortController()
  const publish=()=>publisher.publish(result)
  const stop=ctx.data.listen(({details:event})=>{
    if(result.events.length<256)result.events.push({type:event.type,data:event.data})
    void publish()
  })
  const start=(async()=>{
    const options={signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])}
    const session=await ctx.client.session.create({location:ctx.location??ctx.data.location.default(),
      model:{providerID:'fixture',id:'fixture'}},options)
    ctx.ui.router.navigate({type:'session',sessionID:session.id})
    await ctx.client.session.prompt({sessionID:session.id,text:'Measure the stock tool catalog; do not call tools.'},options)
  })().catch(error=>result.errors.push(String(error))).finally(()=>{tasks.delete(start);void publish()})
  tasks.add(start)
  ctx.keymap.layer(()=>({mode:'global',priority:200,commands:[{bind:'f8',run:()=>{
    const task=(async()=>{
      const route=ctx.ui.router.current()
      if(route.type!=='session')throw Error('Missing fixture session')
      result.prompts++
      await ctx.client.session.prompt({sessionID:route.sessionID,text:'Measure the next catalog; do not call tools.'},
        {signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])})
    })().catch(error=>result.errors.push(String(error))).finally(()=>{tasks.delete(task);void publish()})
    tasks.add(task)
  }},{bind:'f9',run:()=>{
    const task=(async()=>{
      result.reviews=[]
      for(const stream of [false,true])result.reviews.push(await review(
        {kind:'shell',command:'printf fixture',cwd:${JSON.stringify(project)},files:[],limitations:['Synthetic transport-only evidence']},
        parseConfig({baseURL:ctx.options.reviewURL,model:'review-fixture',stream}),abort.signal,{environment:{}}))
    })().catch(error=>result.errors.push(String(error))).finally(()=>{tasks.delete(task);void publish()})
    tasks.add(task)
  }}]}))
  void publish()
  return async()=>{stop();abort.abort();await Promise.allSettled([...tasks]);result.cleaned=true;await publish();await publisher.close()}
}})
`)
const requests = [], errors = []
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    const primary = Array.isArray(body.tools) && body.tools.length > 0
    const rejected = primary && body.tools.length > 128
    requests.push({ url: req.url, body, primary, rejected, bytes: Buffer.byteLength(text) })
    if (rejected) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { type: "invalid_request_error", code: "too_many_tools",
        message: "Synthetic provider contract: at most 128 tools" } }))
      return
    }
    const reviewer = req.url === "/review/chat/completions"
    const message = { role: "assistant", content: reviewer
      ? JSON.stringify({ safe: true, desc: "Separate transport reached its own endpoint." }) : "Catalog measured; no tools called." }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [delta, finish_reason] of [[message, null], [{}, "stop"]])
        res.write(`data: ${JSON.stringify({ id: "catalog", object: "chat.completion.chunk", model: "fixture",
          choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }))
    }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const until = async (label, predicate, timeout = 60000) => {
  const end = Date.now() + timeout
  do {
    assert.deepEqual(errors, [])
    const record = await readObservation(serverObservation, { optional: true })
    const cli = await readObservation(cliObservation, { optional: true })
    if (record) assert.deepEqual(record.errors, [])
    if (cli) assert.deepEqual(cli.errors, [])
    if (record && cli && await predicate(record, cli)) return { record, cli }
    await sleep(100)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${label}`)
}
const primary = () => requests.filter(request => request.primary)
const successes = cli => cli.events.filter(event => event.type === "session.execution.succeeded").length
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const config = { model: "fixture/fixture", update: "disable", plugins: [plugin],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 1000000, output: 1000 } } } } } }
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(config))
  const cli = { animations: false, attention: { notifications: false, sound: false },
    plugins: [{ package: plugin, options: { reviewURL: `http://127.0.0.1:${server.address().port}/review` } }] }
  const cliPath = path.join(temp, "config/opencode/cli.json")
  await writeFile(cliPath, JSON.stringify(cli))
  const launch = ["-d", "-s", "v2-catalog", "-x", "160", "-y", "40", "-c", project,
    host, "--standalone", project]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ version, temp, config, cli, launch, socket: runtime.socket }, null, 2))
  await runtime.start(...launch)
  await until("baseline completion", (_, cli) => primary().length === 1 && successes(cli) === 1)
  assert.ok(primary()[0].body.tools.some(tool => tool.function.name === "execute"))
  for (const stage of ["direct", "overflow"]) {
    await publishObservation(control, { stage })
    await until(`${stage} registry refresh`, record => record.stage === stage)
    runtime.tmux("send-keys", "-t", "v2-catalog", "F8")
    if (stage === "direct") {
      await until("direct completion", (_, cli) => primary().length === 2 && successes(cli) === 2)
      const before = (await readObservation(serverObservation)).contexts.length
      runtime.tmux("send-keys", "-t", "v2-catalog", "F9")
      const { cli: reviewed } = await until("separate reviewer streaming and nonstreaming transport", (_, cli) => cli.reviews?.length === 2)
      assert.ok(reviewed.reviews.every(result => result.safe && result.desc === "Separate transport reached its own endpoint."))
      assert.equal((await readObservation(serverObservation)).contexts.length, before, "reviewer does not enter main-model context hooks")
      const posts = requests.filter(request => request.url === "/review/chat/completions")
      assert.equal(posts.length, 2)
      assert.deepEqual(posts.map(request => request.body.stream), [false, true])
      assert.ok(posts.every(request => request.body.model === "review-fixture" && request.body.tools === undefined && request.body.messages.length === 2))
    }
    else await until("overflow rejected", (_, cli) => primary().length === 3 && cli.events.some(event => event.type === "session.execution.failed"))
  }
  const direct = primary()[1], overflow = primary()[2]
  assert.equal(direct.rejected, false)
  assert.equal(overflow.rejected, true)
  assert.ok(overflow.body.tools.length > 128)
  for (const request of [direct, overflow]) {
    const names = request.body.tools.map(tool => tool.function.name)
    assert.equal(new Set(names).size, names.length)
    assert.ok(!names.includes("execute"))
    for (const tool of request.body.tools) {
      assert.equal(tool.type, "function")
      assert.equal(typeof tool.function.description, "string")
      assert.equal(tool.function.parameters.type, "object")
    }
  }
  const record = await readObservation(serverObservation)
  const baselineCatalog = record.catalogs.find(item => item.stage === "before-direct").tools
  const directCatalog = record.catalogs.find(item => item.stage === "direct").tools
  assert.deepEqual(directCatalog.map(item => item.id), baselineCatalog.map(item => item.id))
  for (const original of baselineCatalog) {
    const changed = directCatalog.find(tool => tool.id === original.id)
    assert.deepEqual(changed.input, original.input)
    assert.equal(changed.description, original.description)
    const { pinned, ...options } = original.options ?? {}
    assert.deepEqual(changed.options, { ...options, codemode: false })
  }
  const negativeEnd = Date.now() + 2500
  do {
    const cli = await readObservation(cliObservation)
    assert.equal(cli.events.some(event => ["permission.asked", "permission.replied", "session.tool.started"].includes(event.type)), false)
    assert.deepEqual((await readObservation(serverObservation)).before, [])
    assert.equal(primary().length, 3, "invalid-request failure is not retried")
    await sleep(100)
  } while (Date.now() < negativeEnd)
  await writeFile(path.join(artifacts, "rejected.txt"), runtime.tmux("capture-pane", "-p", "-t", "v2-catalog"))
  await writeFile(cliPath, JSON.stringify({ ...cli, plugins: ["*", "-research.v2.catalog.cli"] }))
  const { cli: cleaned } = await until("CLI cleanup", (_, cli) => cli.cleaned)
  await sleep(500)
  assert.deepEqual(await readObservation(cliObservation), cleaned)
  const metrics = primary().map((request, index) => ({ stage: ["baseline", "direct", "overflow"][index],
    toolCount: request.body.tools.length, toolBytes: Buffer.byteLength(JSON.stringify(request.body.tools)),
    systemBytes: Buffer.byteLength(JSON.stringify(request.body.messages.filter(message => message.role === "system"))),
    requestBytes: request.bytes, rejected: request.rejected }))
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome: "pass", version, temp, metrics, requests,
    reviewerTransport: "Production review() bundled in isolated CLI; streaming and nonstreaming use independent HTTP, outside host model hooks",
    limitations: ["Stock native catalog with synthetic cardinality additions, not the user's MCP catalog",
      "128-tool rejection is injected by the local endpoint, not verified against a live provider",
      "Byte counts are measured; tokens, billing, real provider schema acceptance and model quality are unmeasured",
      "Catalog-only Promise transform; execution equivalence is tested separately with the public Effect profile"] }, null, 2))
  console.log(`PASS V2 catalog: ${artifacts}\n${JSON.stringify(metrics, null, 2)}`)
} catch (error) {
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, errors, requests }, null, 2))
  try { await writeFile(path.join(artifacts, "failed.txt"), runtime.tmux("capture-pane", "-p", "-t", "v2-catalog")) } catch { /* Host may have exited. */ }
  throw error
} finally {
  await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
