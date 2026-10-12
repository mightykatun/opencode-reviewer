import { test } from "node:test"
import assert from "node:assert/strict"
import { executeFixture } from "../scripts/runtime-runner.mjs"
import { execFileSync } from "node:child_process"

const alive = pid => {
  try { return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z") }
  catch { return false }
}

test("runner records child failure and both output streams without converting it to success", async () => {
  const lines = []
  const result = await executeFixture(process.execPath, ["-e", 'console.log("out"); console.error("err"); process.exitCode=7'], {
    timeoutMs: 3000, output: (chunk, channel) => lines.push([channel, String(chunk).trim()]),
  })
  assert.equal(result.code, 7); assert.equal(result.timedOut, false)
  assert.deepEqual(lines.toSorted(), [["stderr", "err"], ["stdout", "out"]])
})

for (const mode of ["abort", "timeout", "early exit"]) test(`runner ${mode} kills an owned wrapper and its uncooperative child, not another fixture`, { timeout: 10000 }, async () => {
  const abort = new AbortController(), survivorAbort = new AbortController()
  const fixtureReady = Promise.withResolvers(), survivorReady = Promise.withResolvers()
  let parent, nested, survivor, run, output = "", survivorOutput = ""
  const survivorRun = executeFixture(process.execPath, ["-e", 'console.log(process.pid); setInterval(()=>{},1000)'], {
    timeoutMs: 8000, graceMs: 50, signal: survivorAbort.signal, output: chunk => {
      survivorOutput += chunk
      if (survivorOutput.includes("\n")) { survivor = Number(survivorOutput.trim()); survivorReady.resolve() }
    },
  })
  try {
    await Promise.race([survivorReady.promise, survivorRun.then(() => assert.fail("unrelated fixture exited before its readiness handshake"))])
    const descendant = `process.on('SIGTERM',()=>{console.log('descendant still owns stdout'); console.error('descendant still owns stderr')});
    process.send(process.pid); setInterval(()=>{},1000);`
    const code = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    // Deliberately take longer to become ready than the post-ready timeout.
    setTimeout(()=>{
      const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});
      child.once('message',pid=>console.log(JSON.stringify({parent:process.pid,child:pid})));
      ${mode === "early exit" ? "child.once('message',()=>process.exit(7));" : ""}
    },600);
    setInterval(()=>{},1000);`
    run = executeFixture(process.execPath, ["-e", code], { timeoutMs: mode === "timeout" ? 100 : 3000, graceMs: 100,
      startupTimeoutMs: 3000, ready: fixtureReady.promise,
      signal: abort.signal, output: chunk => {
        output += chunk
        if (!nested && output.includes("\n")) {
          ({ parent, child: nested } = JSON.parse(output.split("\n")[0]))
          fixtureReady.resolve()
        }
      },
    })
    await Promise.race([
      fixtureReady.promise,
      run.then(() => assert.fail("owned fixture exited before its readiness handshake")),
    ])
    assert.ok(parent && nested && survivor)
    if (mode === "abort") abort.abort()
    const result = await run
    assert.equal(result.code, mode === "early exit" ? 7 : null)
    assert.equal(result.signal, mode === "early exit" ? null : "SIGKILL")
    assert.equal(result.timedOut, mode === "timeout")
    assert.equal(result.interrupted, mode === "abort")
    assert.match(output, /descendant still owns stdout/, "stdout stays owned after wrapper exit until group escalation closes it")
    assert.match(output, /descendant still owns stderr/, "stderr stays owned through cleanup too")
    assert.equal(alive(parent), false); assert.equal(alive(nested), false)
    assert.equal(alive(survivor), true)
  } finally { abort.abort(); survivorAbort.abort(); await Promise.all([run, survivorRun]) }
})

test("a missing readiness handshake has a bounded startup deadline", async () => {
  const result = await executeFixture(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    ready: new Promise(() => {}), startupTimeoutMs: 100, timeoutMs: 3000, graceMs: 50,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.interrupted, false)
})

test("pre-aborted runs dispatch no child and spawn failures remain errors", async () => {
  await assert.rejects(executeFixture(process.execPath, ["-e", 'throw Error("must not run")'], {
    signal: AbortSignal.abort(new Error("stopped")), timeoutMs: 1000,
  }), /stopped/)
  await assert.rejects(executeFixture("/nonexistent-fixture-executable", [], { timeoutMs: 1000 }), /ENOENT/)
})
