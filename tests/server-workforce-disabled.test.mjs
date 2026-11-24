import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/health");
      if (response.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

test("the real server starts with the workforce disabled and existing routes still answer", async t => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), NEXUS_RUNTIME_ENABLED: "false" };
  delete env.HABITAT_WORKFORCE_ENABLED;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.HABITAT_D1_DATABASE_ID;
  delete env.HABITAT_D1_API_TOKEN;

  const child = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  const healthy = await waitForHealth(port);
  assert.equal(healthy, true, "server did not answer /health; output:\n" + output.slice(-1500));

  const status = await (await fetch("http://127.0.0.1:" + port + "/system/status")).json();
  assert.equal(status.ok, true);
  assert.equal(status.components.workforce.state, "disabled");
  assert.deepEqual(
    [status.components.workforce.enabled, status.components.workforce.configured, status.components.workforce.initialized, status.components.workforce.running, status.components.workforce.verified],
    [false, false, false, false, false]
  );
  assert.equal(status.components.workforce.migration.appliedByRuntime, false);
  assert.equal(status.components.workforce.nexusRuntimeEnabled, false);
  assert.equal(status.components.missions.state, "disabled");
  assert.equal(status.components.missions.enabled, false);
  assert.equal(status.components.missions.migration.appliedByRuntime, false);
  assert.match(status.report, /Missions: DISABLED/);

  for (const route of ["/health", "/workers", "/capabilities", "/system/status", "/continuity/status"]) {
    const response = await fetch("http://127.0.0.1:" + port + route);
    assert.equal(response.status, 200, route + " changed status");
  }

  // The process never reached D1: with no credentials it reports memory-only storage.
  assert.match(output, /TASK_STORAGE: memory-only/);
  assert.doesNotMatch(output, /WORKFORCE_STATUS/);

  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
});
