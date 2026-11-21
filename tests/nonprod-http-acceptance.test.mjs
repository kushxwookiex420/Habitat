import test from "node:test";
import assert from "node:assert/strict";
import {
  startNonproductionHarness,
  api,
  temporaryDatabasePath,
  AX_TOKEN,
  OWNER_DEVICE_ID,
  OWNER_TOKEN,
  TARGET_DEVICE_ID,
  INTRUDER_DEVICE_ID,
  INTRUDER_TOKEN
} from "./helpers/nonprod-harness.mjs";

/**
 * Nonproduction acceptance over real HTTP sockets.
 *
 * Real here: TCP listener, request/response parsing, device bridge routes, pairing and replay
 * protection, heartbeats, command queue, universal engine, Nexus worker, adapter execution, D1
 * repository SQL, SQLite persistence across a process-equivalent restart.
 *
 * Not real here: Cloudflare D1, Render, Home Bridge, and a physical Android phone.
 */

async function mintPairing(baseUrl, deviceId = TARGET_DEVICE_ID) {
  const minted = await api(baseUrl, "/ax/device/pairings", {
    method: "POST", token: AX_TOKEN, body: { deviceId }
  });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  return minted.body.pairing.code;
}

test("1-11. Android-to-Ax command cycle over real HTTP: pairing, heartbeat, tasks, device.status, revocation", async () => {
  const h = await startNonproductionHarness();
  try {
    // 1. A fresh pairing code is accepted exactly once.
    const code = await mintPairing(h.url);
    const paired = await api(h.url, "/device/pair", { method: "POST", body: { deviceId: TARGET_DEVICE_ID, code } });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const deviceToken = paired.body.device?.token;
    assert.ok(typeof deviceToken === "string" && deviceToken.length >= 40, "a real per-device credential is issued");
    assert.equal(JSON.stringify(paired.body).includes("code"), false, "the code itself is never echoed");

    // 2. Replay is rejected when a different device presents the consumed code.
    const replay = await api(h.url, "/device/pair", { method: "POST", body: { deviceId: "android-somewhere-else", code } });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, "pairing_used_other_device");

    // 3. An unissued code is rejected and reveals nothing.
    const bogus = await api(h.url, "/device/pair", {
      method: "POST", body: { deviceId: "android-somewhere-else", code: "x".repeat(43) }
    });
    assert.equal(bogus.status, 401);
    assert.equal(bogus.body.code, "pairing_unknown");

    // 4. An authenticated heartbeat updates the correct device row only.
    const beat = await api(h.url, "/device/heartbeat", {
      method: "POST", token: deviceToken,
      body: { deviceId: TARGET_DEVICE_ID, details: { model: "Galaxy S26 Ultra", batteryPercent: 71, androidSdk: 36 } }
    });
    assert.equal(beat.status, 200, JSON.stringify(beat.body));
    assert.equal(JSON.stringify(beat.body).includes(deviceToken), false, "the token is never returned");
    const devices = await h.deviceRepo.listDevices();
    const target = devices.find(row => row.device_id === TARGET_DEVICE_ID);
    assert.ok(target, "the paired device exists");
    assert.ok(target.last_seen_at, "last_seen_at was recorded");
    assert.equal(target.owner_device_id, OWNER_DEVICE_ID);
    assert.equal(devices.find(row => row.device_id === INTRUDER_DEVICE_ID)?.last_seen_at ?? null, null);

    // A wrong token cannot update that device.
    const spoof = await api(h.url, "/device/heartbeat", {
      method: "POST", token: INTRUDER_TOKEN,
      body: { deviceId: TARGET_DEVICE_ID, details: { model: "spoofed" } }
    });
    assert.equal(spoof.status, 401);

    // 5. Ax accepts an authenticated command and creates a persistent task.
    const submitted = await api(h.url, "/ax/command/tasks", {
      method: "POST", token: AX_TOKEN,
      body: { objective: "nonproduction acceptance runtime health", role: "ax", adapter: "runtime.health", idempotencyKey: "accept-runtime-health" }
    });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const taskId = submitted.body.task.id;
    assert.ok(taskId);

    // A duplicate submission with the same idempotency key must not create a second task.
    const duplicate = await api(h.url, "/ax/command/tasks", {
      method: "POST", token: AX_TOKEN,
      body: { objective: "nonproduction acceptance runtime health", role: "ax", adapter: "runtime.health", idempotencyKey: "accept-runtime-health" }
    });
    assert.equal(duplicate.body.task.id, taskId, "idempotent resubmission returns the same task");

    // 6. An authorized worker claims and executes it.
    await h.bridge.nexus().worker.tick();

    // 7. Results return to Ax and are accurately reported.
    const read = await api(h.url, "/ax/command/tasks/" + taskId, { token: AX_TOKEN });
    assert.equal(read.status, 200);
    assert.equal(read.body.task.status, "done");
    assert.ok(read.body.task.result.evidence.some(line => line.startsWith("runtime:")));
    assert.ok(read.body.task.result.summary.length > 3);

    // 8. No unauthenticated task route is exposed.
    const anonymous = await api(h.url, "/ax/command/tasks");
    assert.equal(anonymous.status, 401);

    // 9. device.status runs as a harmless read-only command through the durable queue.
    const queued = await h.bridge.requestDeviceStatus({ ownerDeviceId: OWNER_DEVICE_ID, targetDeviceId: TARGET_DEVICE_ID });
    assert.equal(queued.ok, true, JSON.stringify(queued));
    const next = await api(h.url, "/device/commands/next?deviceId=" + TARGET_DEVICE_ID, { token: deviceToken });
    assert.equal(next.status, 200);
    assert.equal(next.body.command.type, "device.status");

    const completed = await api(h.url, "/device/commands/" + next.body.command.id + "/result", {
      method: "POST", token: deviceToken,
      body: {
        deviceId: TARGET_DEVICE_ID,
        result: { ok: true, summary: "Habitat Android device is online and responding", details: { model: "Galaxy S26 Ultra" } }
      }
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const stored = await api(h.url, "/ax/device/commands/" + next.body.command.id, { token: AX_TOKEN });
    assert.equal(stored.body.command.status, "completed");
    assert.equal(stored.body.command.result.details.model, "Galaxy S26 Ultra");

    // A command claimed by another device cannot be completed by this one.
    const second = await h.bridge.requestDeviceStatus({ ownerDeviceId: OWNER_DEVICE_ID, targetDeviceId: TARGET_DEVICE_ID });
    assert.equal(second.ok, true);
    const claimed = await api(h.url, "/device/commands/next?deviceId=" + TARGET_DEVICE_ID, { token: deviceToken });
    assert.equal(claimed.body.command.id, second.commandId);
    const foreign = await api(h.url, "/device/commands/" + claimed.body.command.id + "/result", {
      method: "POST", token: INTRUDER_TOKEN,
      body: { deviceId: INTRUDER_DEVICE_ID, result: { ok: true, summary: "forged" } }
    });
    // Authenticated, but not the device that claimed the command: the result is refused and the
    // command stays with its rightful owner.
    assert.equal(foreign.status, 409);
    const stillOwned = await api(h.url, "/ax/device/commands/" + claimed.body.command.id, { token: AX_TOKEN });
    assert.equal(stillOwned.body.command.status, "claimed");
    assert.notEqual(stillOwned.body.command.result?.summary, "forged");

    // 10. A rejected credential cannot poll; only the paired identity can.
    const crossDevice = await api(h.url, "/device/commands/next?deviceId=" + INTRUDER_DEVICE_ID, { token: deviceToken });
    assert.equal(crossDevice.status, 401);

    // 11. Revocation blocks every subsequent request from that phone.
    const revoked = await api(h.url, "/ax/device/" + TARGET_DEVICE_ID + "/revoke", { method: "POST", token: AX_TOKEN });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
    const afterRevoke = await api(h.url, "/device/commands/next?deviceId=" + TARGET_DEVICE_ID, { token: deviceToken });
    assert.equal(afterRevoke.status, 401);
    const heartbeatAfterRevoke = await api(h.url, "/device/heartbeat", {
      method: "POST", token: deviceToken, body: { deviceId: TARGET_DEVICE_ID, details: {} }
    });
    assert.equal(heartbeatAfterRevoke.status, 401);
    const requeue = await h.bridge.requestDeviceStatus({ ownerDeviceId: OWNER_DEVICE_ID, targetDeviceId: TARGET_DEVICE_ID });
    assert.equal(requeue.ok, false, "a revoked device is not a valid command target");
  } finally {
    await h.close();
  }
});

test("12. a restart preserves paired identity, durable tasks, and completion state", async () => {
  const dbPath = temporaryDatabasePath();
  const first = await startNonproductionHarness({ dbPath });
  let deviceToken;
  let taskId;
  try {
    const code = await mintPairing(first.url);
    const paired = await api(first.url, "/device/pair", { method: "POST", body: { deviceId: TARGET_DEVICE_ID, code } });
    assert.equal(paired.status, 200);
    deviceToken = paired.body.device.token;

    const submitted = await api(first.url, "/ax/command/tasks", {
      method: "POST", token: AX_TOKEN,
      body: { objective: "durable restart check", role: "ax", adapter: "runtime.health", idempotencyKey: "restart-durable" }
    });
    assert.equal(submitted.status, 201);
    taskId = submitted.body.task.id;
    await first.bridge.nexus().worker.tick();
  } finally {
    await first.close();
  }

  const second = await startNonproductionHarness({ dbPath, seedOwner: false });
  try {
    // The paired credential still authenticates: the token hash survived, not a session cache.
    const beat = await api(second.url, "/device/heartbeat", {
      method: "POST", token: deviceToken, body: { deviceId: TARGET_DEVICE_ID, details: { model: "Galaxy S26 Ultra" } }
    });
    assert.equal(beat.status, 200, JSON.stringify(beat.body));

    // The completed task is still complete and is not misreported as pending.
    const read = await api(second.url, "/ax/command/tasks/" + taskId, { token: AX_TOKEN });
    assert.equal(read.status, 200);
    assert.equal(read.body.task.status, "done");
    assert.ok(read.body.task.result.evidence.some(line => line.startsWith("runtime:")));

    // A second worker tick on the restarted process does not re-execute the finished task.
    await second.bridge.nexus().worker.tick();
    const again = await api(second.url, "/ax/command/tasks/" + taskId, { token: AX_TOKEN });
    assert.equal(again.body.task.status, "done");
    assert.equal(again.body.task.result.evidence.filter(line => line.startsWith("runtime:")).length,
      read.body.task.result.evidence.filter(line => line.startsWith("runtime:")).length);
  } finally {
    await second.close();
  }
});

test("nonproduction configuration refuses durable device storage when it points at production D1", async () => {
  const { app } = await import("./helpers/http-harness.mjs").then(m => m.createApp());
  const { registerDeviceCommandBridge } = await import("../device-command-bridge.mjs");
  const errors = [];
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_RUNTIME_ENV: "nonproduction",
      HABITAT_D1_DATABASE_ID: "prod-d1-id",
      HABITAT_PRODUCTION_D1_DATABASE_ID: "prod-d1-id",
      CLOUDFLARE_ACCOUNT_ID: "account",
      HABITAT_D1_API_TOKEN: "token",
      HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
      HABITAT_OWNER_DEVICE_ID: OWNER_DEVICE_ID
    },
    handleSignals: false,
    exitOnSignal: false,
    log: { log() {}, warn() {}, error: (...args) => errors.push(args.join(" ")) }
  });
  const status = bridge.status();
  assert.equal(status.ready, false, "no durable storage is mounted");
  assert.equal(status.durable, false);
  assert.equal(status.environment.runtime, "nonproduction");
  assert.equal(status.environment.productionD1Conflict, true);
  const init = await bridge.initialize();
  assert.equal(init.ok, false, "initialization fails closed instead of writing to production D1");
  assert.equal(errors.some(line => line.includes("DEVICE_COMMAND_BRIDGE_ENVIRONMENT_CONFLICT")), true);
});

test("the nonproduction harness never reports LIVE state it has not observed", async () => {
  const h = await startNonproductionHarness();
  try {
    // An owner-device-authenticated status request is refused while no owned phone has checked in.
    const queued = await h.bridge.requestDeviceStatus({ ownerDeviceId: OWNER_DEVICE_ID });
    assert.equal(queued.ok, false);
    assert.equal(queued.code, "no_owned_device_online");
  } finally {
    await h.close();
  }
});
