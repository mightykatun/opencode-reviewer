// Build first, then use the serial runtime runner. No keyboard input is sent.
// SDK result gates preserve real native pending snapshots; the reviewer uses real HTTP/SSE.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { publishObservation, readObservation } from "./smoke-observations.mjs"
import { smokeRuntime } from "./smoke-runtime.mjs"

const { scenario } = runtimeArguments("smoke-approval-recovery.mjs")
const fast = !scenario.startsWith("read-")
const before = scenario.endsWith("-before")
const transport = scenario.startsWith("transport-")
const root = path.resolve(import.meta.dirname, ".."), host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assert.equal(version, "1.18.35", "fixture requires the pinned host")
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime", `approval-recovery-${scenario}-`))
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-approval-recovery-"))
const project = path.join(temp, "project"), bundle = path.join(temp, "bundle.mjs"), plugin = path.join(temp, "plugin.mjs")
const records = path.join(artifacts, "observations.json"), control = path.join(artifacts, "control.json")
await mkdir(project); await mkdir(path.join(temp, "config"))
execFileSync("git", ["init", "--quiet", project])
await copyFile(path.join(root, "dist/tui.js"), bundle)
const bundleSHA256 = createHash("sha256").update(await readFile(bundle)).digest("hex")
await publishObservation(control, { sequence: 0, action: "idle" })
await writeFile(plugin, `
import { withHistoryObservations } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher, readObservation } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
export default { id: 'approval-recovery-fixture', tui: async (api, options) => {
  const data = { reads: [], writes: [], asked: [], replies: [], notifications: [], diagnostics: [], renders: [],
    errors: [], controls: [], frames: 0, dropped: 0 };
  const publisher = observationPublisher(${JSON.stringify(records)});
  let armed = false, probing = false, sequence = -1, polling, disposed = false, closed = false, signature;
  const readers = new Set();
  const gates = new Set();
  const save = () => { if (!closed) return publisher.publish(data); };
  const append = (key, value) => { if (data[key].length < 4096) data[key].push(value); else data.dropped++; void save(); };
  const release = action => { armed = false; for (const resolve of gates) resolve(action); gates.clear(); };
  const poll = () => {
    if (polling || disposed) return;
    polling = (async () => {
    try {
      const command = await readObservation(${JSON.stringify(control)});
      if (command.sequence > sequence) {
        sequence = command.sequence;
        if (command.action === 'arm') { armed = true; probing = true; }
        else if (['settle', 'fail'].includes(command.action)) release(command.action);
        append('controls', { ...command, at: performance.now() });
      }
      // Static final reports need not animate. Request real frames through the
      // public renderer; geometry, hit testing and eligibility stay production-owned.
      if (probing) api.renderer.requestRender();
    } catch (error) { append('errors', String(error)); }
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const timer = setInterval(poll, 20);
  const permission = new Proxy(api.client.permission, { get(target, key) {
    if (key === 'list') return (...args) => {
      if (disposed) return target.list(...args);
      const worker = (async () => {
      const row = { id: data.reads.length + 1, start: performance.now(), gated: armed };
      // Reserve before the actual SDK call so every read admitted in this wave
      // is held, including independent native-queue refreshes. We assert that a
      // measured approval-verification read lies inside this wave below.
      const gate = armed ? new Promise(resolve => gates.add(resolve)) : undefined;
      append('reads', row);
      const signal = args[1]?.signal;
      const aborted = () => { row.aborted = performance.now(); row.abortReason = signal.reason?.name; void save(); };
      signal?.addEventListener('abort', aborted, { once: true });
      try {
        const result = await target.list(...args);
        row.nativeAt = performance.now(); row.pending = structuredClone(result.data);
        void save();
        const action = gate ? await gate : 'healthy';
        row.action = action;
        if (action === 'fail') throw Object.assign(new Error('Fixture permission GET 503'), { status: 503 });
        return result;
      } catch (error) { row.error = String(error); throw error; }
      finally { signal?.removeEventListener('abort', aborted); row.settled = performance.now(); void save(); }
      })();
      readers.add(worker);
      void worker.then(() => readers.delete(worker), () => readers.delete(worker));
      return worker;
    };
    if (key === 'reply') return (...args) => {
      append('writes', { at: performance.now(), request: args[0] });
      return target.reply(...args);
    };
    return Reflect.get(target, key, target);
  } });
  const wrapped = { ...api, client: new Proxy(api.client, { get(target, key) {
    return key === 'permission' ? permission : Reflect.get(target, key, target);
  } }) };
  for (const [type, key] of [['permission.asked', 'asked'], ['permission.replied', 'replies']])
    api.event.on(type, event => append(key, { at: performance.now(), ...event.properties }));
  await withHistoryObservations(event => {
    const row = { ...event, width: api.renderer.width, height: api.renderer.height };
    if (event.stage === 'frame') { data.frames++; data.lastFrame = row; }
    const { at, ...state } = row, next = JSON.stringify(state);
    if (signature !== next) { signature = next; append('renders', row); }
    else void save();
  }, event => append('diagnostics', event), () => ({
    show: async event => { append('notifications', { ...event, at: performance.now() }); await publisher.flush(); return { close() {} }; },
    dispose() {}
  }))(wrapped, options);
  await save();
  api.lifecycle.onDispose(async () => {
    disposed = true; clearInterval(timer); release('settle');
    await polling; await Promise.allSettled([...readers]);
    await save(); closed = true; await publisher.close();
  });
} };
`)
execFileSync(process.execPath, ["--check", plugin], { stdio: "pipe" })
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nwith Path("executions").open("a") as f:\n    f.write("once\\n")\n')

const calls = [], errors = [], milestones = {}, samples = []
let toolSent = false, first, replacement
const delta = (res, content) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
const finish = res => res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
const reviewCalls = () => calls.filter(call => call.url === "/review/chat/completions")
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ at: Date.now(), url: req.url, body })
    if (req.url === "/review/chat/completions") {
      assert.equal(body.stream, fast)
      const count = reviewCalls().length
      assert.ok(count <= (fast ? 2 : 1), "unexpected extra reviewer attempt")
      if (!fast) {
        first = () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{
          message: { role: "assistant", content: JSON.stringify({ safe: true, desc: "RECOVERED SAFE REPORT" }) }, finish_reason: "stop" }] })) }
      } else {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders()
        if (count === 1) first = {
          preview: () => delta(res, '{"safe":true,"desc":"REJECTED PREVIEW'),
          reject: () => {
            if (transport) { delta(res, '"}'); res.end(); } // Valid JSON, missing SSE stop/DONE.
            else { delta(res, '","extra":1}'); finish(res); } // Format correction, not a network retry.
          },
        }
        else replacement = () => { delta(res, JSON.stringify({ safe: true, desc: "REPLACEMENT SAFE REPORT" })); finish(res) }
      }
      return
    }
    assert.equal(req.url, "/main/chat/completions")
    const main = body.tools?.some(tool => tool.function?.name === "bash"), doTool = main && !toolSent
    if (doTool) toolSent = true
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "recovery-fixture", type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "python3 fixture.py", description: "Write isolated recovery marker" }) } }] }
      : { role: "assistant", content: main ? "Recovery fixture finished." : "Recovery fixture" }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [part, reason] of [[message, null], [{}, doTool ? "tool_calls" : "stop"]])
        res.write(`data: ${JSON.stringify({ id: "fixture", model: "fixture", choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] })) }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "recovery")
const data = async () => await readObservation(records, { optional: true })
const executed = async () => {
  try { return (await readFile(path.join(project, "executions"), "utf8")).trim().split("\n").filter(Boolean) }
  catch (error) { if (error.code === "ENOENT") return []; throw error }
}
const quiet = async d => {
  assert.deepEqual(d.writes, [], "no SDK write from failed verification or rejected preview")
  assert.deepEqual(d.replies, [], "no native permission reply before recovery")
  assert.deepEqual(await executed(), [], "no command execution before recovery")
}
const healthy = d => {
  assert.deepEqual(errors, [])
  if (!d) return
  assert.deepEqual(d.errors, []); assert.equal(d.dropped, 0)
  assert.ok(!d.notifications.some(event => ["attention", "unsafe", "error"].includes(event.kind)), "no false attention during recovery")
}
const until = async (label, check, timeout = 20000) => {
  const end = Date.now() + timeout
  do {
    const d = await data(), screen = capture(); healthy(d)
    if (d && await check(d, screen)) return d
    await sleep(40) // Poll a postcondition, never use elapsed sleep as success evidence.
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${label}: ${scenario}`)
}
let sequence = 0
const command = async action => {
  await publishObservation(control, { sequence: ++sequence, action })
  return until(`control ${action} acknowledgement`, d => d.controls.some(row => row.sequence === sequence))
}
const save = async label => {
  await writeFile(path.join(artifacts, label + ".txt"), capture())
  await writeFile(path.join(artifacts, label + ".ansi"), runtime.tmux("capture-pane", "-p", "-e", "-t", "recovery"))
}
// Negative windows advance actual renderer frames, with the forbidden effects
// checked on every poll. Gates, not wall-clock sleeps, keep the causal boundaries open.
const quietFrames = async label => {
  const start = await data()
  await until(label, async (d, screen) => {
    await quiet(d)
    assert.ok(d.lastFrame?.physical && !d.lastFrame.covered, "live panel remains physically presented")
    assert.match(screen, /Permission analysis/)
    samples.push({ label, frames: d.frames, at: Date.now(), auto: d.lastFrame.auto, physical: d.lastFrame.physical })
    return d.frames >= start.frames + 8
  })
  await save(label)
}
const verifiedWave = (d, accept = () => true) => d.diagnostics.some(event => event.phase === "approval-verification"
  && d.reads.some(read => read.gated && read.settled && event.at >= read.settled
    && event.at - event.duration <= read.start && accept(read)))
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false, permission: { bash: "ask" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } } }
  const settings = { baseURL: base + "/review", model: "fixture", autoApprove: true, fastMode: fast, stream: fast,
    autoApproveDelaySeconds: 0, timeoutMs: 120000, formatRetries: 1, notify: true, notifySound: false, staleReminderSeconds: 0 }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ theme: "opencode", plugin: [[plugin, settings]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  const launch = ["-d", "-s", "recovery", "-x", "160", "-y", "40", "-c", project, "env",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`), host, project, "--prompt", "Run python3 fixture.py once to write the isolated execution marker."]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ scenario, version, bundleSHA256, temp, settings, config, launch,
    supervisorSocket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
  await runtime.start(...launch)
  await until("real pending permission and live panel before rating", (d, screen) => first && d.asked.length === 1
    && d.lastFrame?.physical && screen.includes("Permission analysis") && screen.includes("Permission required"), 90000)
  await command("arm")
  if (fast) first.preview(); else first()
  await until("verification held behind physically presented Safe", async (d, screen) => {
    await quiet(d)
    return d.lastFrame?.auto === "checking" && d.lastFrame.physical && d.lastFrame.eligible && screen.includes("Safe")
      && d.reads.some(read => read.gated && read.nativeAt && !read.settled)
  })
  await save("verification-held")
  if (fast) {
    first.reject()
    await until("real retry clears the rejected Safe preview", async (d, screen) => {
      await quiet(d)
      return replacement && screen.includes("Retrying") && !screen.includes("REJECTED PREVIEW") && !screen.includes("✓ Safe")
    })
    await quietFrames("rejected-preview-held")
    if (before) {
      replacement()
      const d = await until("replacement validated and painted before read settlement", async (d, screen) => {
        await quiet(d)
        return screen.includes("REPLACEMENT SAFE REPORT") && d.lastFrame.final && d.lastFrame.painted
          && d.diagnostics.some(event => event.phase === "final-validation" && event.attempt === 1)
      })
      milestones.replacement = d.diagnostics.find(event => event.phase === "final-validation" && event.attempt === 1).at
      assert.ok(d.reads.filter(read => read.gated).every(read => !read.settled && read.abortReason !== "DeadlineError"), "ordering must precede read deadline")
      await quietFrames("replacement-safe-held")
      await command("settle")
    } else {
      await command("settle")
      await until("old verification actually settled while rating absent", async d => { await quiet(d); return verifiedWave(d) })
      await quietFrames("rejected-preview-settled")
      replacement()
    }
  } else if (scenario === "read-timeout") {
    await until("real approval budget abort while SDK result still held", async d => {
      await quiet(d)
      const held = d.reads.filter(read => read.gated)
      return held.length > 0 && held.every(read => read.nativeAt && read.abortReason === "DeadlineError" && !read.settled)
    })
    await quietFrames("deadline-expired-read-owned")
    await command("settle")
  } else await command("fail")

  await until("one autonomous native once and one execution", async d => d.replies.length === 1 && (await executed()).length === 1, 30000)
  await until("native completion and notification recorder drain", (d, screen) => screen.includes("Recovery fixture finished.")
    && !screen.includes("Permission required") && d.notifications.some(event => event.kind === "approved")
    && d.notifications.some(event => event.kind === "ended"))
  // A fresh, healthy post-resolution read closes the duplicate-write observation
  // window using real host progress rather than a fixed sleep.
  const snapshot = await data(), repliedAt = snapshot.replies[0].at
  await until("post-resolution healthy native refresh", d => d.reads.some(read => !read.gated && read.start > repliedAt && read.settled && !read.error))
  const d = await data(); healthy(d)
  assert.ok(verifiedWave(d), "the gated wave must contain an actual measured approval-verification read")
  assert.equal(d.asked.length, 1)
  assert.deepEqual(d.replies.map(reply => reply.reply), ["once"])
  assert.equal(d.replies[0].requestID, d.asked[0].id)
  assert.deepEqual(d.writes.map(write => write.request.reply), ["once"])
  assert.equal(d.writes[0].request.requestID, d.asked[0].id)
  assert.equal(d.writes[0].request.directory, project)
  assert.deepEqual(await executed(), ["once"])
  assert.equal(d.notifications.filter(event => event.kind === "approved").length, 1)
  assert.equal(reviewCalls().length, fast ? 2 : 1)
  const held = d.reads.filter(read => read.gated)
  assert.ok(held.every(read => read.nativeAt && read.settled && read.pending.some(request => request.id === d.asked[0].id)))
  assert.ok(d.writes[0].at > Math.max(...held.map(read => read.settled)), "no write before held reads settle")
  if (fast) {
    const final = d.diagnostics.find(event => event.phase === "final-validation" && event.attempt === 1)
    assert.ok(final)
    if (before) assert.ok(final.at < Math.min(...held.map(read => read.settled)))
    else assert.ok(final.at > Math.max(...held.map(read => read.settled)))
    assert.ok(held.every(read => read.abortReason !== "DeadlineError" && read.settled - read.start < 5000),
      "F13 must exercise rating invalidation, not read timeout")
    if (transport) assert.deepEqual(reviewCalls()[1].body, reviewCalls()[0].body, "transport retry regenerates exact request")
    else {
      const original = reviewCalls()[0].body.messages, corrected = reviewCalls()[1].body.messages
      assert.deepEqual(corrected.slice(0, original.length), original)
      assert.equal(corrected.length, original.length + 2)
      assert.equal(corrected.at(-2).content, '{"safe":true,"desc":"REJECTED PREVIEW","extra":1}')
    }
  } else {
    assert.ok(d.reads.some(read => !read.gated && read.start > Math.max(...held.map(read => read.settled)) && !read.error && read.settled),
      "fresh healthy read follows the failed/expired verification")
    if (scenario === "read-error") assert.ok(verifiedWave(d, read => read.action === "fail" && read.error.includes("503")))
    else assert.ok(verifiedWave(d, read => read.abortReason === "DeadlineError" && read.aborted < read.settled))
  }
  await save("recovered")
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ scenario, version, bundleSHA256, temp, milestones,
    inputEvents: 0, executions: await executed(), observations: d }, null, 2))
  console.log(`PASS approval-recovery ${scenario}: one native once without input; ${artifacts}`)
} catch (error) {
  await save("failed").catch(() => {})
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, scenario, temp,
    observations: await data().catch(() => null), executions: await executed().catch(() => null), errors }, null, 2))
  throw error
} finally {
  try { await runtime.dispose() } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await writeFile(path.join(artifacts, "requests.json"), JSON.stringify(calls, null, 2))
    await writeFile(path.join(artifacts, "screens.json"), JSON.stringify(samples, null, 2))
  }
}
