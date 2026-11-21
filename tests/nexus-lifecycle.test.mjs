import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";

const fixture = new URL("./fixtures/lifecycle-child.mjs", import.meta.url).pathname;

function runLifecycle(mode, { signalOn = null, doubleSignal = false } = {}) {
  return new Promise(resolve => {
    const marker = "/tmp/nexus-lifecycle-" + mode + "-" + process.pid + ".marker";
    try { fs.unlinkSync(marker); } catch {}
    const child = spawn(process.execPath, [fixture, marker, mode], { stdio: ["ignore", "pipe", "pipe"] });
    const started = Date.now();
    let signalledAt = null;
    let output = "";
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (signalOn && !signalledAt && output.includes(signalOn)) {
        signalledAt = Date.now();
        setTimeout(() => process.kill(child.pid, "SIGTERM"), 50);
        if (doubleSignal) setTimeout(() => { try { process.kill(child.pid, "SIGTERM"); } catch {} }, 150);
      }
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.on("exit", (code, signal) => resolve({
      code, signal, output,
      elapsedMs: Date.now() - started,
      afterSignalMs: signalledAt ? Date.now() - signalledAt : null,
      marker: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
      markerExists: fs.existsSync(marker)
    }));
  });
}

test("SIGTERM during initialization is handled, never starts the worker", async () => {
  const result = await runLifecycle("init-signal", { signalOn: "STORE_INIT_START" });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, /NEXUS_RUNTIME: received SIGTERM/);
  assert.doesNotMatch(result.output, /ADAPTER_START_1/, "no adapter may run");
  assert.equal(result.markerExists, false);
  assert.ok(result.afterSignalMs < 1000, "shutdown before the 2s store init resumed");
});

test("one SIGTERM after initialization waits for the in-flight task", async () => {
  const result = await runLifecycle("late-single", { signalOn: "TICK2_ISSUED" });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(result.afterSignalMs >= 500, "drained the 600ms adapter");
  assert.equal(result.marker, "adapter-1-completed");
  assert.match(result.output, /NEXUS_WORKER: stopped \(SIGTERM\)/);
  assert.match(result.output, /COMPLETE_COUNT 1/);
});

test("two SIGTERMs during a drain do not interrupt shutdown and complete once", async () => {
  const result = await runLifecycle("late-double", { signalOn: "TICK2_ISSUED", doubleSignal: true });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null, "second signal was absorbed, not a default terminate");
  assert.ok(result.afterSignalMs >= 500, "drain was not aborted");
  assert.equal(result.marker, "adapter-1-completed");
  assert.match(result.output, /NEXUS_WORKER: stopped \(SIGTERM\)/);
  assert.equal((result.output.match(/COMPLETE_COUNT 1/g) || []).length, 1);
  assert.doesNotMatch(result.output, /COMPLETE_COUNT 2/);
});

test("repeated concurrent shutdown requests are idempotent", async () => {
  const result = await runLifecycle("stop-twice");
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, /WORKER_STARTED false/);
  assert.equal((result.output.match(/NEXUS_WORKER: stopped \(probe-stop\)/g) || []).length, 2);
});

test("shutdown during initialization prevents worker startup", async () => {
  const result = await runLifecycle("init-shutdown");
  assert.equal(result.code, 0);
  assert.match(result.output, /"started":false/);
  assert.match(result.output, /"reason":"shutting_down"/);
  assert.match(result.output, /WORKER_STARTED false/);
  assert.match(result.output, /IS_STOPPED true/);
  assert.match(result.output, /ADAPTER_CALLS 0/);
});
