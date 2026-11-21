import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCTION,
  NONPRODUCTION,
  inspectD1Isolation,
  resolveRuntimeEnvironment,
  sealProductionD1,
  serviceName
} from "../environment-identity.mjs";
import { createApp, listen, closeServer } from "./helpers/http-harness.mjs";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";
import { api, AX_TOKEN, OWNER_DEVICE_ID } from "./helpers/nonprod-harness.mjs";

/**
 * Nonproduction isolation.
 *
 * Real here: the environment rules, the HTTP listener, the bridge routes and guards, the
 * production-D1 refusal, and the diagnostics response body.
 *
 * Not real: Cloudflare D1, Render, a phone. No production resource is contacted or modified.
 */

function bridgeWith(env) {
  const { app, server } = createApp();
  const errors = [];
  const warnings = [];
  const bridge = registerDeviceCommandBridge(app, {
    env,
    handleSignals: false,
    exitOnSignal: false,
    log: {
      log() {},
      warn: (...args) => warnings.push(args.join(" ")),
      error: (...args) => errors.push(args.join(" "))
    }
  });
  return { app, server, bridge, errors, warnings };
}

test("an explicit HABITAT_RUNTIME_ENV wins and NODE_ENV=production is never an implicit nonproduction", () => {
  assert.equal(resolveRuntimeEnvironment({ HABITAT_RUNTIME_ENV: "nonproduction", NODE_ENV: "production" }), NONPRODUCTION);
  assert.equal(resolveRuntimeEnvironment({ HABITAT_RUNTIME_ENV: "production", NODE_ENV: "development" }), PRODUCTION);
  assert.equal(resolveRuntimeEnvironment({ NODE_ENV: "production" }), PRODUCTION, "fail safe, not fail open");
  assert.equal(resolveRuntimeEnvironment({}), NONPRODUCTION);
});

test("a production D1 conflict is only the exact declared production database id", () => {
  assert.equal(inspectD1Isolation({
    HABITAT_D1_DATABASE_ID: "prod-d1-id",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id"
  }).productionD1Conflict, true);
  assert.equal(inspectD1Isolation({
    HABITAT_D1_DATABASE_ID: "nonprod-d1-id",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id"
  }).productionD1Conflict, false);
  assert.equal(inspectD1Isolation({ HABITAT_D1_DATABASE_ID: "prod-d1-id" }).productionD1Conflict, false);
});

test("sealing removes production D1 credentials from a nonproduction process only", () => {
  const conflicting = {
    HABITAT_RUNTIME_ENV: "nonproduction",
    CLOUDFLARE_ACCOUNT_ID: "account",
    HABITAT_D1_DATABASE_ID: "prod-d1-id",
    HABITAT_D1_API_TOKEN: "token",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id"
  };
  assert.equal(sealProductionD1(conflicting), true);
  assert.equal(conflicting.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(conflicting.HABITAT_D1_DATABASE_ID, undefined);
  assert.equal(conflicting.HABITAT_D1_API_TOKEN, undefined);

  const production = {
    HABITAT_RUNTIME_ENV: "production",
    CLOUDFLARE_ACCOUNT_ID: "account",
    HABITAT_D1_DATABASE_ID: "prod-d1-id",
    HABITAT_D1_API_TOKEN: "token",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id"
  };
  assert.equal(sealProductionD1(production), false);
  assert.equal(production.HABITAT_D1_DATABASE_ID, "prod-d1-id", "production is never sealed");
});

test("the diagnostics endpoint requires the Ax token and names the environment without secrets", async () => {
  const { server, errors } = bridgeWith({
    HABITAT_RUNTIME_ENV: "nonproduction",
    HABITAT_SERVICE_NAME: "ax-nexus-habitat-nonprod",
    HABITAT_D1_DATABASE_ID: "prod-d1-id",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id",
    CLOUDFLARE_ACCOUNT_ID: "account",
    HABITAT_D1_API_TOKEN: "token-should-never-appear",
    HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
    HABITAT_OWNER_DEVICE_ID: OWNER_DEVICE_ID
  });
  const url = await listen(server);
  try {
    const anonymous = await api(url, "/diagnostics");
    assert.equal(anonymous.status, 401, "diagnostics are not public");

    const authorized = await api(url, "/diagnostics", { token: AX_TOKEN });
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
    assert.equal(authorized.body.service, "ax-nexus-habitat-nonprod");
    assert.equal(authorized.body.environment.runtime, "nonproduction");
    assert.equal(authorized.body.environment.production, false);
    assert.equal(authorized.body.environment.productionD1Conflict, true);
    assert.equal(authorized.body.deviceBridge.storeMounted, false);
    assert.equal(authorized.body.deviceBridge.ready, false);

    const raw = authorized.text;
    for (const secret of ["prod-d1-id", "token-should-never-appear", AX_TOKEN]) {
      assert.equal(raw.includes(secret), false, "diagnostics must not leak " + secret);
    }
    assert.equal(errors.some(line => line.includes("DEVICE_COMMAND_BRIDGE_ENVIRONMENT_CONFLICT")), true);
  } finally {
    await closeServer(server);
  }
});

test("a nonproduction process with the production database refuses every device route", async () => {
  const { server } = bridgeWith({
    HABITAT_RUNTIME_ENV: "nonproduction",
    HABITAT_D1_DATABASE_ID: "prod-d1-id",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id",
    CLOUDFLARE_ACCOUNT_ID: "account",
    HABITAT_D1_API_TOKEN: "token",
    HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
    HABITAT_OWNER_DEVICE_ID: OWNER_DEVICE_ID
  });
  const url = await listen(server);
  try {
    const mint = await api(url, "/ax/device/pairings", {
      method: "POST", token: AX_TOKEN, body: { deviceId: "android-s26" }
    });
    assert.equal(mint.status, 503, "pairing codes cannot be minted against production data");

    const pair = await api(url, "/device/pair", {
      method: "POST", body: { deviceId: "android-s26", code: "c".repeat(43) }
    });
    assert.equal(pair.status, 503, "no phone can pair into production data");

    const poll = await api(url, "/device/commands/next?deviceId=android-s26", { token: "x".repeat(48) });
    assert.equal(poll.status, 503, "no command can be claimed from production data");

    const result = await api(url, "/device/commands/dc_missing/result", {
      method: "POST", token: "x".repeat(48), body: { deviceId: "android-s26", result: { ok: true } }
    });
    assert.equal(result.status, 503, "no result can be written to production data");
  } finally {
    await closeServer(server);
  }
});

test("a legitimate production runtime is identified as production and does not mount Nexus", () => {
  const { bridge } = bridgeWith({
    HABITAT_RUNTIME_ENV: "production",
    HABITAT_D1_DATABASE_ID: "prod-d1-id",
    HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id",
    CLOUDFLARE_ACCOUNT_ID: "account",
    HABITAT_D1_API_TOKEN: "token",
    NEXUS_RUNTIME_ENABLED: "true",
    HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
    HABITAT_OWNER_DEVICE_ID: OWNER_DEVICE_ID
  });
  const status = bridge.status();
  assert.equal(status.environment.runtime, "production");
  assert.equal(status.environment.production, true);
  assert.equal(status.environment.productionD1Conflict, false);
  assert.equal(status.environment.nexusEnabled, false);
  assert.equal(status.service, "habitat");
  assert.equal(serviceName({ HABITAT_SERVICE_NAME: "ax-nexus-habitat-nonprod" }), "ax-nexus-habitat-nonprod");
});
