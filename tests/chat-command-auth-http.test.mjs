import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Route-level proof that the gate is wired, not merely available:
 *   - an anonymous `ax:` command is refused with 401 and queues nothing;
 *   - status remains public and deterministic;
 *   - a request carrying the owner credential gets past authorization.
 *
 * No D1 credentials are supplied, so the authorized request is expected to fail closed at storage
 * (503) rather than queue. That distinction is the assertion: authorization passed, storage did not.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8177;
const BASE = "http://127.0.0.1:" + PORT;
const BRIDGE = "bridge_test_token_0123456789";

async function waitForServer(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("server did not become ready: " + String(lastError?.message || lastError));
}

test("chat command submission is gated by authorization, status is not", async (t) => {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(PORT),
      HABITAT_AX_BRIDGE_TOKEN: BRIDGE,
      NEXUS_RUNTIME_ENABLED: "false",
      NODE_ENV: "test"
    },
    stdio: "ignore"
  });
  t.after(() => {
    try { child.kill("SIGTERM"); } catch {}
  });

  await waitForServer(BASE + "/health");

  const anonymous = await fetch(BASE + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "ax: inspect the repository state" })
  });
  assert.equal(anonymous.status, 401);
  const anonymousBody = await anonymous.json();
  assert.equal(anonymousBody.commandRouter, "unauthorized");
  assert.match(anonymousBody.response, /AUTHORIZATION REQUIRED/);
  assert.equal(anonymousBody.taskId, undefined);

  const status = await fetch(BASE + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "ask ax system status" })
  });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.deterministic, true);
  assert.equal(statusBody.secretsExposed, false);
  assert.match(statusBody.response, /^AX SYSTEM STATUS/);

  const authorized = await fetch(BASE + "/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + BRIDGE
    },
    body: JSON.stringify({ message: "ax: inspect the repository state" })
  });
  assert.notEqual(authorized.status, 401, "owner credential must pass authorization");
  assert.ok([202, 503].includes(authorized.status), "authorized request either queues or fails closed at storage");
});
