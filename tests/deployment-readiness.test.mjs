import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { AX_TOKEN, OWNER_DEVICE_ID, api } from "./helpers/nonprod-harness.mjs";

/**
 * Deployment readiness, exercised against the real server.mjs process.
 *
 * Real here: the production entrypoint and its startup order, the environment sealing, /health,
 * the /diagnostics guard and redaction, the device bridge mount decision, and the mounted
 * /ax/device/pairings route.
 *
 * Not real: Render, a deployed hostname, Cloudflare D1 (no call is made because credentials are
 * sealed before any repository initializes), or a phone. Nothing leaves this machine.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function bootServer(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    // Minimal environment: no inherited credentials, only what this test sets.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const base = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("server exited during startup:\n" + output.slice(-3000));
    }
    try {
      const response = await fetch(base + "/health");
      if (response.ok) {
        return {
          base,
          output: () => output,
          async stop() {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            const exited = once(child, "exit");
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            await exited;
            clearTimeout(timer);
          }
        };
      }
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  child.kill("SIGKILL");
  throw new Error("server did not become ready:\n" + output.slice(-3000));
}

const baseEnv = {
  HABITAT_RUNTIME_ENV: "nonproduction",
  HABITAT_SERVICE_NAME: "ax-nexus-habitat-nonprod",
  HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
  HABITAT_OWNER_DEVICE_IDS: OWNER_DEVICE_ID
};

test("a clean nonproduction process reports its identity and does not claim device readiness", async () => {
  const server = await bootServer(baseEnv);
  try {
    const health = await api(server.base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.habitat, "online");
    assert.equal(health.body.environment, "nonproduction");
    assert.equal(health.body.service, "ax-nexus-habitat-nonprod");
    assert.equal(health.body.isolation.databaseConfigured, false);
    assert.equal(health.body.isolation.productionD1Conflict, false);
    assert.equal(health.body.isolation.productionD1Sealed, false);
    assert.equal(health.body.deviceBridge.ready, false);
    assert.equal(health.body.deviceBridge.environment.runtime, "nonproduction");
    assert.equal(health.body.deviceBridge.environment.productionD1Conflict, false);

    const anonymous = await api(server.base, "/diagnostics");
    assert.equal(anonymous.status, 401, "diagnostics must not be public");

    const diagnostics = await api(server.base, "/diagnostics", { token: AX_TOKEN });
    assert.equal(diagnostics.status, 200, JSON.stringify(diagnostics.body));
    assert.equal(diagnostics.body.environment.runtime, "nonproduction");
    assert.equal(diagnostics.body.deviceBridge.storeMounted, false);
    assert.equal(diagnostics.body.deviceBridge.ready, false);
    assert.equal(diagnostics.text.includes(AX_TOKEN), false, "diagnostics must not echo the token");
    assert.equal(diagnostics.text.includes("HABITAT_D1_API_TOKEN"), false);

    // The pairing route is mounted; without a store it fails closed with 503, never 404.
    const pairing = await api(server.base, "/ax/device/pairings", {
      method: "POST", token: AX_TOKEN, body: { deviceId: "android-s26" }
    });
    assert.equal(pairing.status, 503, "pairing must fail closed, not disappear");
    assert.match(String(pairing.body?.error || ""), /unavailable|not ready/i);
  } finally {
    await server.stop();
  }
});

test("a nonproduction process with D1 but no declared production id fails closed at startup", async () => {
  const server = await bootServer({
    ...baseEnv,
    CLOUDFLARE_ACCOUNT_ID: "nonprod-account",
    HABITAT_D1_DATABASE_ID: "unverified-database",
    HABITAT_D1_API_TOKEN: "nonprod-token"
  });
  try {
    const health = await api(server.base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.environment, "nonproduction");
    assert.equal(health.body.isolation.productionDatabaseUndeclared, true);
    assert.equal(health.body.isolation.productionD1Sealed, true, "credentials must be sealed");
    assert.equal(health.body.isolation.databaseConfigured, true);
    assert.equal(health.body.deviceBridge.ready, false, "no durable storage may mount");

    const diagnostics = await api(server.base, "/diagnostics", { token: AX_TOKEN });
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.environment.productionDatabaseUndeclared, true);
    assert.equal(diagnostics.body.deviceBridge.storeMounted, false);

    const pairing = await api(server.base, "/ax/device/pairings", {
      method: "POST", token: AX_TOKEN, body: { deviceId: "android-s26" }
    });
    assert.equal(pairing.status, 503);

    assert.match(server.output(), /HABITAT_ENVIRONMENT_CONFLICT/);
    assert.match(server.output(), /isolation cannot be proven/);
  } finally {
    await server.stop();
  }
});

test("a nonproduction process pointed at the production database is identified and sealed", async () => {
  const server = await bootServer({
    ...baseEnv,
    CLOUDFLARE_ACCOUNT_ID: "nonprod-account",
    HABITAT_D1_DATABASE_ID: "production-database",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "production-database",
    HABITAT_D1_API_TOKEN: "nonprod-token"
  });
  try {
    const health = await api(server.base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.isolation.productionD1Conflict, true);
    assert.equal(health.body.isolation.productionDatabaseUndeclared, false);
    assert.equal(health.body.isolation.productionD1Sealed, true);
    assert.equal(health.body.deviceBridge.ready, false);

    const diagnostics = await api(server.base, "/diagnostics", { token: AX_TOKEN });
    assert.equal(diagnostics.body.environment.productionD1Conflict, true);
    assert.equal(diagnostics.body.deviceBridge.storeMounted, false);

    const next = await api(server.base, "/device/commands/next?deviceId=android-s26", {
      token: "d".repeat(48)
    });
    assert.equal(next.status, 503, "no device route may write to a refused database");

    assert.match(server.output(), /D1 credentials are sealed/);
  } finally {
    await server.stop();
  }
});
