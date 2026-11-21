import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const fixture = new URL("./fixtures/habitat-bridge-lifecycle-child.mjs", import.meta.url).pathname;

test("11. repeated SIGTERM through the mounted Habitat bridge drains once and exits 0", async () => {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let signalled = false;
    let timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: "timeout", signal: "SIGKILL", output });
    }, 6000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (!signalled && output.includes("ADAPTER_START")) {
        signalled = true;
        setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 50);
        setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 180);
      }
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });

  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null);
  assert.match(result.output, /NEXUS_RUNTIME: received SIGTERM/);
  assert.match(result.output, /NEXUS_WORKER: stopped \(SIGTERM\)/);
  assert.match(result.output, /ADAPTER_FINISHED/);
  assert.equal((result.output.match(/NEXUS_WORKER: stopped \(SIGTERM\)/g) || []).length, 1);
  assert.doesNotMatch(result.output, /ADAPTER_START[\s\S]*ADAPTER_START/);
});
