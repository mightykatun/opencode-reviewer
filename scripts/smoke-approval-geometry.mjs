// Build first. Real OpenCode 1.18.35, production bundle and physical terminal resize.
// Usage: node scripts/smoke-approval-geometry.mjs <registered scenario>
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { smokeRuntime } from "./smoke-runtime.mjs"
import { runtimeArguments } from "./runtime-inventory.mjs"
import { readObservation } from "./smoke-observations.mjs"

const { scenario } = runtimeArguments("smoke-approval-geometry.mjs")
const handoff = scenario === "sidebar-handoff-live" || scenario === "sidebar-handoff-history"
const historyCase = scenario === "history-short" || scenario === "sidebar-handoff-history"
const continuity = handoff || scenario === "benign-width"
const root = path.resolve(import.meta.dirname, "..")
const host = process.env.OPENCODE_BIN ?? "opencode"
const version = execFileSync(host, ["--version"], { encoding: "utf8", timeout: 10000 }).trim()
assert.equal(version, "1.18.35", "fixture requires the pinned host")
const width = 160, tall = 40, short = 8, delay = 12, pollMs = 80
await mkdir(path.join(root, ".runtime"), { recursive: true })
const artifacts = await mkdtemp(path.join(root, ".runtime", `approval-geometry-${scenario}-`))
const temp = await mkdtemp(path.join(tmpdir(), "reviewer-geometry-"))
const project = path.join(temp, "project"), bundle = path.join(temp, "bundle.mjs")
await mkdir(project)
await mkdir(path.join(temp, "config"))
execFileSync("git", ["init", "--quiet", project])
await copyFile(path.join(root, "dist/tui.js"), bundle)
const bundleSHA256 = createHash("sha256").update(await readFile(bundle)).digest("hex")
const observationFile = path.join(artifacts, "observations.json")
const plugin = path.join(temp, "observer.mjs")
await writeFile(plugin, `
import { withHistoryObservations } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { observationPublisher } from ${JSON.stringify(new URL("./smoke-observations.mjs", import.meta.url).href)};
import { CliRenderEvents, TextRenderable } from '@opentui/core';
export default { id: 'approval-geometry-observer', tui: async (api, options) => {
  const records = { renders: [], scenes: [], gates: [], diagnostics: [], asked: [], replies: [], commands: [], errors: [], dropped: 0 };
  const publisher = observationPublisher(${JSON.stringify(observationFile)});
  const previous = new Map();
  const save = () => publisher.publish(records);
  const append = (key, value) => {
    if (records[key].length < 2048) records[key].push(value); else records.dropped++;
    return save();
  };
  // A supported pre-layout frame callback owns a bounded gate. It does not emit
  // FRAME, modify proof, or suppress timers. Only benign-width uses this seam.
  let gate, releaseGate, gateTimer, blocked = false, timerProved = false;
  const releasePaint = reason => {
    if (!releaseGate) return;
    clearTimeout(gateTimer);
    void append('gates', { kind: 'release', reason, at: performance.now(), wallAt: Date.now() });
    const release = releaseGate; releaseGate = undefined; release();
  };
  const armPaint = () => {
    if (${JSON.stringify(scenario)} !== 'benign-width' || gate) return;
    void append('gates', { kind: 'armed', at: performance.now(), wallAt: Date.now() });
    gate = new Promise(resolve => { releaseGate = resolve; });
    gateTimer = setTimeout(() => {
      void append('errors', 'renewed-paint gate timed out'); releasePaint('timeout');
    }, 4000);
    api.renderer.requestRender();
  };
  const resized = () => {
    if (releaseGate && api.renderer.width === 161)
      void append('gates', { kind: 'resize', at: performance.now(), wallAt: Date.now() });
  };
  const beforePaint = async () => {
    if (!gate || !releaseGate) return;
    blocked = true;
    void append('gates', { kind: 'blocked', at: performance.now(), wallAt: Date.now() });
    await gate;
    blocked = false;
  };
  const find = (node, num) => {
    if (node.num === num) return node;
    for (const child of node.getChildren()) { const found = find(child, num); if (found) return found; }
  };
  const heading = (node, text) => {
    if (node instanceof TextRenderable && node.plainText === text) return node;
    for (const child of node.getChildren()) { const found = heading(child, text); if (found) return found; }
  };
  const physicalHeading = node => !!node && !node.isDestroyed && node.visible
    && api.renderer.hitTest(node.x, node.y) === node.num;
  // Every real FRAME is observed independently of LiveReviewPanel's lifetime.
  // A missing report frame must be recorded even if its observer was disposed.
  const scene = () => {
    const live = heading(api.renderer.root, 'Permission analysis');
    const history = heading(api.renderer.root, 'Analysis history');
    const state = { terminalWidth: api.renderer.width, terminalHeight: api.renderer.height,
      live: live?.num, history: history?.num, livePhysical: physicalHeading(live), historyPhysical: physicalHeading(history) };
    const signature = JSON.stringify(state);
    if (previous.get('scene') === signature) return;
    previous.set('scene', signature);
    void append('scenes', { wallAt: Date.now(), ...state });
  };
  const region = node => ({ num: node.num, type: node.constructor.name, x: node.x, y: node.y,
    width: node.width, height: node.height, visible: node.visible, children: node.getChildren().map(region) });
  const observe = event => {
    if (blocked && api.renderer.width === 161 && !timerProved && event.stage === 'presentation' && event.check === 'timer'
      && event.presentation === 'pending' && !event.eligible && event.auto === 'countdown') {
      timerProved = true;
      void append('gates', { kind: 'timer-proof', at: event.at, wallAt: Date.now(), seconds: event.seconds,
        presentation: event.presentation, terminalWidth: api.renderer.width });
    }
    const node = find(api.renderer.root, event.panel);
    const { at, ...state } = event;
    const record = { ...state, terminalWidth: api.renderer.width, terminalHeight: api.renderer.height,
      geometry: node ? region(node) : undefined };
    const signature = JSON.stringify(record);
    if (previous.get(event.stage) === signature) return;
    previous.set(event.stage, signature);
    return append('renders', { at, wallAt: Date.now(), ...record });
  };
  const diagnostic = event => append('diagnostics', { ...event, wallAt: Date.now(),
    terminalWidth: api.renderer.width, terminalHeight: api.renderer.height });
  for (const [event, key] of [['permission.asked', 'asked'], ['permission.replied', 'replies']])
    api.event.on(event, value => { void append(key, { wallAt: Date.now(), ...value.properties }); });
  // Only invokes the public production command. There is no cover/readiness override.
  const off = api.keymap.registerLayer({ priority: 100, mode: 'base', bindings: [{ key: 'f6', cmd: () => {
    api.keymap.dispatchCommand('opencode-reviewer.history');
    void append('commands', { command: 'history', wallAt: Date.now() });
  } }, { key: 'f7', cmd: () => {
    api.keymap.dispatchCommand('session.sidebar.toggle');
    void append('commands', { command: 'sidebar', wallAt: Date.now() });
  } }, { key: 'f8', cmd: () => releaseGate ? releasePaint('fixture') : armPaint() }] });
  await withHistoryObservations(observe, diagnostic)(api, options);
  api.renderer.on(CliRenderEvents.FRAME, scene);
  api.renderer.on(CliRenderEvents.RESIZE, resized);
  api.renderer.setFrameCallback(beforePaint);
  await save();
  api.lifecycle.onDispose(async () => {
    api.renderer.off(CliRenderEvents.FRAME, scene);
    api.renderer.off(CliRenderEvents.RESIZE, resized);
    api.renderer.removeFrameCallback(beforePaint);
    releasePaint('dispose'); off(); save(); await publisher.close();
  });
} };
`)
execFileSync(process.execPath, ["--check", plugin], { stdio: "pipe" })
await writeFile(path.join(project, "fixture.py"), 'from pathlib import Path\nimport time\nwith Path("executions").open("a") as f:\n    f.write(str(time.time_ns() // 1000000) + "\\n")\n')
const desc = "GEOMETRY REPORT. Writes only the requested isolated execution marker."
const calls = [], errors = [], samples = [], milestones = {}
let toolSent = false, releaseReview
const server = createServer(async (req, res) => {
  try {
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ at: Date.now(), url: req.url, body })
    if (req.url === "/review/chat/completions") {
      assert.equal(calls.filter(call => call.url === req.url).length, 1, "exactly one reviewer POST")
      assert.equal(body.stream, false)
      const finish = () => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ safe: true, desc }) }, finish_reason: "stop" }] }))
      }
      if (historyCase || handoff) releaseReview = finish
      else finish()
      return
    }
    assert.equal(req.url, "/main/chat/completions")
    const doTool = !toolSent && body.tools?.some(tool => tool.function?.name === "bash")
    if (doTool) toolSent = true
    const message = doTool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "geometry-fixture", type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "python3 fixture.py", description: "Write isolated geometry marker" }) } }] }
      : { role: "assistant", content: "Geometry fixture finished." }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [delta, finish_reason] of [[message, null], [{}, doTool ? "tool_calls" : "stop"]])
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }))
    }
  } catch (error) { errors.push(String(error)); res.destroy() }
})
const runtime = await smokeRuntime(temp)
const capture = () => runtime.tmux("capture-pane", "-p", "-t", "geometry")
const send = (...keys) => runtime.tmux("send-keys", "-t", "geometry", ...keys)
const data = async () => await readObservation(observationFile, { optional: true }) ?? { renders: [], diagnostics: [], asked: [], replies: [] }
const executions = async () => {
  try { return (await readFile(path.join(project, "executions"), "utf8")).trim().split("\n").filter(Boolean).map(Number) }
  catch (error) { if (error.code === "ENOENT") return []; throw error }
}
const until = async (label, predicate, timeout = 20000) => {
  const end = Date.now() + timeout
  do {
    assert.deepEqual(errors, [], "fixture model server remains healthy")
    const record = await data(), screen = capture()
    if (await predicate(record, screen)) return record
    await sleep(pollMs)
  } while (Date.now() < end)
  throw Error(`Timed out waiting for ${label}: ${scenario}`)
}
const save = async name => {
  await writeFile(path.join(artifacts, name + ".txt"), capture())
  await writeFile(path.join(artifacts, name + ".ansi"), runtime.tmux("capture-pane", "-p", "-e", "-t", "geometry"))
}
const frames = record => record.renders.filter(event => event.stage === "frame")
const assertNoApproval = async record => {
  assert.deepEqual(await executions(), [], "native command must not execute")
  assert.deepEqual(record.replies, [], "native permission must not receive any reply, including once")
  assert.ok(!record.diagnostics.some(event => event.phase === "approval-reply"), "no automatic reply dispatch")
}
const hold = async (label, end, check) => {
  do {
    const record = await data(), screen = capture()
    await assertNoApproval(record)
    check(record, screen)
    const latest = frames(record).at(-1)
    samples.push({ at: Date.now(), label, panel: screen.includes("Permission analysis"), report: screen.includes("GEOMETRY REPORT"),
      cancel: screen.includes("Cancel"), countdown: /Allowed in \d+s/.test(screen), auto: latest?.auto,
      eligible: latest?.eligible, covered: latest?.covered, terminalHeight: latest?.terminalHeight })
    await sleep(pollMs)
  } while (Date.now() < end)
}
const resize = async (height, columns = width, waitForFrame = true) => {
  const at = Date.now()
  runtime.tmux("resize-window", "-t", "geometry", "-x", String(columns), "-y", String(height))
  if (waitForFrame) await until(`actual ${columns}x${height} frame`, record => frames(record).some(event => event.wallAt >= at
    && event.terminalWidth === columns && event.terminalHeight === height))
  return at
}
let outcome = "failed"
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { $schema: "https://opencode.ai/config.json", model: "fixture/fixture", small_model: "fixture/fixture", autoupdate: false,
    permission: { bash: "ask" }, provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: base + "/main", apiKey: "synthetic-only" },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1000 } } } } } }
  const settings = { notify: false, baseURL: base + "/review", model: "fixture", stream: false,
    autoApprove: true, fastMode: false, autoApproveDelaySeconds: delay, timeoutMs: 60000 }
  const tui = path.join(temp, "tui.json")
  await writeFile(tui, JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: "opencode", plugin: [[plugin, settings]] }))
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: path.join(temp, "config"), OPENCODE_TUI_CONFIG: tui,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
  const launch = ["-d", "-s", "geometry", "-x", String(width), "-y", String(scenario === "initially-short" ? short : tall), "-c", project,
    "env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), host, project, "--prompt", "Run python3 fixture.py once to write the isolated execution marker."]
  await writeFile(path.join(artifacts, "setup.json"), JSON.stringify({ scenario, version, bundleSHA256, temp, artifacts, width, tall, short, delay,
    config, settings, launch, supervisorSocket: runtime.socket, supervisorPID: runtime.supervisorPID }, null, 2))
  await runtime.start(...launch)
  if (handoff) {
    await until("pending review before explicit sidebar setup", (record, screen) => releaseReview && record.asked.length === 1
      && screen.includes("Permission analysis"), 90000)
    // The default wide sidebar is auto, not explicit-open. Hide then show through
    // the native public command while the assessment is held and no timer exists.
    send("F7")
    await until("native sidebar hidden", (_, screen) => !screen.includes("Permission analysis"))
    send("F7")
    await until("native sidebar explicitly opened", (_, screen) => screen.includes("Permission analysis"))
  }
  if (historyCase) {
    await until("pending review before production history opens", record => releaseReview && record.asked.length === 1, 90000)
    send("F6")
    await until("actual empty production history", (record, screen) => screen.includes("Analysis history") && screen.includes("No history entries")
      && frames(record).some(event => event.covered && event.history === "ready"))
    await save("history-before-final")
    releaseReview()
  } else if (handoff) releaseReview()
  await until("final validated report", record => record.diagnostics.some(event => event.phase === "final-validation")
    && frames(record).some(event => event.final), 90000)
  if (scenario === "initially-short") {
    milestones.shortAt = Date.now()
    await save("initially-short")
    await hold("initially-short", milestones.shortAt + (delay + 3) * 1000, record => {
      assert.ok(frames(record).every(event => !event.eligible && event.auto !== "countdown"), "short initial layout cannot start a countdown")
      assert.ok(!record.diagnostics.some(event => event.phase === "approval-countdown"), "no countdown diagnostic before grow")
      assert.ok(!frames(record).some(event => event.auto === "cancelled"), "an unstarted countdown must not become permanently canceled")
    })
    await save("initially-short-past-delay")
    milestones.growAt = await resize(tall)
  }
  const started = await until("eligible countdown with valid layout", (record, screen) => frames(record).some(event => event.terminalHeight === tall
    && event.eligible && event.auto === "countdown") && (historyCase || (screen.includes("GEOMETRY REPORT") && /Allowed in \d+s/.test(screen) && screen.includes("Cancel"))))
  const first = frames(started).find(event => event.eligible && event.auto === "countdown")
  milestones.countdownAt = first.wallAt
  await assertNoApproval(started)
  assert.equal(first.terminalHeight, tall)
  assert.equal(first.final, true)
  assert.equal(first.painted, true)
  assert.equal(first.contentMatches, true)
  assert.equal(first.highlighting, false)
  assert.equal(first.streaming, false)
  assert.ok(first.children > 0)
  if (historyCase) {
    assert.equal(first.covered, true, "production history really exercises the cover exception at valid height")
    assert.equal(first.physical, false)
    assert.equal(first.history, "ready")
  }
  await save("countdown-valid-height")
  if (continuity) {
    // Cross timer boundaries in both branches. Approval must still use the
    // original deadline, and actual scene observations must have no missing frame.
    await hold("before-width-change", first.wallAt + 2200, () => {})
    if (!handoff) {
      // Establish the pre-layout gate before SIGWINCH, so even a synchronous
      // resize-triggered render cannot race admission to the fixture gate.
      send("F8")
      await until("public pre-layout frame gate", record => record.gates.some(event => event.kind === "blocked"))
    }
    milestones.widthChangeAt = await resize(tall, handoff ? 120 : 161, handoff)
    if (!handoff) {
      const blocked = await until("real timer callback between RESIZE and renewed FRAME", async record => {
        await assertNoApproval(record)
        assert.deepEqual(record.errors, [])
        assert.ok(!frames(record).some(event => event.terminalWidth === 161), "renewed FRAME must remain gated")
        return record.gates.some(event => event.kind === "timer-proof")
      }, 3500)
      const resized = blocked.gates.find(event => event.kind === "resize")
      const held = blocked.gates.find(event => event.kind === "blocked")
      const timer = blocked.gates.find(event => event.kind === "timer-proof")
      assert.ok(resized && held && timer)
      assert.ok(held.at < resized.at && resized.at < timer.at)
      assert.equal(timer.terminalWidth, 161)
      assert.equal(timer.presentation, "pending")
      assert.ok(!blocked.gates.some(event => event.kind === "release"))
      milestones.unprovenTimerAt = timer.wallAt
      await save("real-timer-before-renewed-paint")
      send("F8")
    }
    await until("renewed physical proof", record => frames(record).some(event => event.wallAt >= milestones.widthChangeAt
      && event.terminalWidth === (handoff ? 120 : 161) && event.eligible && event.auto === "countdown"))
    await save("width-renewed")
    if (handoff) {
      await hold("overlay-countdown", first.wallAt + 4800, (record, screen) => {
        assert.match(screen, historyCase ? /Analysis history/ : /GEOMETRY REPORT/)
        assert.ok(!frames(record).some(event => event.auto === "cancelled" || event.auto === "failed"))
      })
      milestones.wideReturnAt = await resize(tall, width)
      await until("wide renewed physical proof", record => frames(record).some(event => event.wallAt >= milestones.wideReturnAt
        && event.terminalWidth === width && event.eligible && event.auto === "countdown"))
      await save("wide-returned")
    }
    await until("one native once at the original countdown deadline", async record => {
      assert.ok(!frames(record).some(event => event.auto === "cancelled" || event.auto === "failed"))
      return record.replies.length === 1 && (await executions()).length === 1
    }, (delay + 10) * 1000)
    const record = await data(), marker = await executions()
    if (!handoff) {
      const release = record.gates.find(event => event.kind === "release")
      const timer = record.gates.find(event => event.kind === "timer-proof")
      const renewed = frames(record).find(event => event.terminalWidth === 161)
      assert.equal(release?.reason, "fixture", "only a proved callback permits fixture gate release")
      assert.ok(timer.at < release.at && release.at < renewed.at)
    }
    assert.equal(marker.length, 1)
    assert.deepEqual(record.replies.map(reply => reply.reply), ["once"])
    assert.equal(record.replies[0].requestID, record.asked[0].id)
    assert.ok(marker[0] >= first.wallAt + delay * 1000 - 150, "countdown was not shortened")
    assert.ok(marker[0] < first.wallAt + (delay + 2) * 1000, "no countdown/grace restart at either resize")
    const during = frames(record).filter(event => event.wallAt >= first.wallAt && event.wallAt < record.replies[0].wallAt)
    assert.equal(new Set(during.map(event => event.panel)).size, 1, "stable live owner through native slot replacement")
    assert.equal(new Set(during.map(event => event.markdown)).size, 1, "stable Markdown owner")
    const scenes = record.scenes.filter(event => event.wallAt >= first.wallAt && event.wallAt < record.replies[0].wallAt)
    assert.ok(scenes.length > 0)
    assert.ok(scenes.every(event => historyCase ? event.historyPhysical : event.livePhysical), "no missing-report painted frame")
    if (historyCase) {
      assert.equal(new Set(scenes.map(event => event.history)).size, 1, "stable production history owner")
      assert.ok(during.filter(event => event.eligible).every(event => event.covered && !event.physical), "actual history cover proves readiness")
    }
    assert.equal(record.diagnostics.filter(event => event.phase === "approval-reply").length, 1)
    await save("approved-original-deadline")
  } else if (scenario === "initially-short") {
    assert.ok(first.wallAt >= milestones.growAt, "countdown starts only after growing")
    await until("one native once and execution after grow", async record => {
      assert.ok(!frames(record).some(event => event.auto === "cancelled" || event.auto === "failed"),
        "valid grown layout must complete approval, not cancel/fail during the countdown or dispatch transition")
      return record.replies.length === 1 && (await executions()).length === 1
    }, (delay + 15) * 1000)
    await until("native permission resolved", (_, screen) => !screen.includes("Permission required"))
    await sleep(1200)
    const record = await data(), marker = await executions()
    assert.equal(marker.length, 1, "exactly one execution")
    assert.deepEqual(record.replies.map(reply => reply.reply), ["once"])
    assert.equal(record.replies[0].requestID, record.asked[0].id, "reply belongs to the observed permission")
    assert.ok(marker[0] >= first.wallAt + delay * 1000, "growing does not skip the countdown")
    assert.equal(record.diagnostics.filter(event => event.phase === "approval-reply").length, 1)
    assert.ok(!frames(record).some(event => event.auto === "cancelled" || event.auto === "failed"))
    await save("approved-after-grow")
  } else {
    // Leave ample time before the original deadline; a late resize is a fixture failure.
    assert.ok(Date.now() < first.wallAt + (delay - 3) * 1000, "resize must precede original deadline")
    milestones.resizeAt = await resize(short)
    await until("short-height cancellation", record => frames(record).some(event => event.wallAt >= milestones.resizeAt
      && event.terminalHeight === short && event.auto === "cancelled" && !event.eligible))
    await save("short-cancelled")
    await hold("short-past-original-deadline", first.wallAt + (delay + 4) * 1000, record => {
      const latest = frames(record).at(-1)
      assert.equal(latest.terminalHeight, short)
      assert.equal(latest.eligible, false)
      assert.equal(latest.auto, "cancelled")
    })
    await save("short-past-original-deadline")
    milestones.restoreAt = await resize(tall)
    if (scenario === "history-short") {
      await until("history restored", (_, screen) => screen.includes("Analysis history") && screen.includes("No history entries"))
      send("Escape")
    }
    await until("durable cancellation visible after restore", (_, screen) => screen.includes("GEOMETRY REPORT") && screen.includes("Auto-approval canceled"))
    await hold("restored-durable-cancellation", Date.now() + (delay + 3) * 1000, (record, screen) => {
      assert.match(screen, /Auto-approval canceled/)
      assert.doesNotMatch(screen, /Allowed in \d+s/)
      assert.equal(frames(record).at(-1).auto, "cancelled")
    })
    await save("restored-past-new-deadline")
    const record = await data()
    assert.ok(frames(record).filter(event => event.terminalHeight === short).every(event => !event.eligible && event.auto !== "countdown"),
      "every short frame must reject eligibility, including production history cover")
    if (scenario === "history-short") assert.ok(frames(record).some(event => event.terminalHeight === short && event.covered && event.history === "ready"),
      "production history must still cover the short panel, proving geometry independently blocks the cover exception")
    assert.equal(new Set(frames(record).map(event => event.panel)).size, 1, "same live panel spans resize and restoration")
  }
  const record = await data()
  assert.equal(record.asked.length, 1)
  assert.equal(record.diagnostics.filter(event => event.phase === "approval-countdown").length, 1)
  assert.equal(calls.filter(call => call.url === "/review/chat/completions").length, 1)
  assert.deepEqual(record.errors, [])
  assert.equal(record.dropped, 0)
  assert.deepEqual(errors, [])
  outcome = "passed"
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify({ outcome, scenario, version, bundleSHA256, temp, artifacts, milestones,
    nativeReplies: record.replies, executions: await executions(),
    shortCoveredFrames: frames(record).filter(event => event.terminalHeight === short && event.covered).length }, null, 2))
  console.log(`PASS approval-geometry ${scenario}: ${artifacts}`)
} catch (error) {
  await save("failed").catch(() => {})
  const record = await data().catch(() => null)
  await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ outcome, scenario, error: String(error), stack: error.stack, milestones,
    temp, artifacts, errors, observations: record, executions: await executions().catch(() => null) }, null, 2))
  if (record) await writeFile(path.join(artifacts, "frame-summary.json"), JSON.stringify(frames(record).map(({ geometry, ...event }) => event), null, 2))
  console.error(`FAIL approval-geometry ${scenario}: ${artifacts}`)
  throw error
} finally {
  // Own cleanup even if artifact writing fails; only this supervisor's socket is stopped.
  try { await runtime.dispose() } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await writeFile(path.join(artifacts, "screens.json"), JSON.stringify(samples, null, 2))
    await writeFile(path.join(artifacts, "requests.json"), JSON.stringify(calls, null, 2))
  }
}
