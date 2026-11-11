import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createD1DeviceCommandRepository } from "../d1-device-command-repository.mjs";

function response(result = []) {
  return {
    ok: true,
    status: 200,
    async json() { return { success: true, result }; }
  };
}
function fakeD1() {
  const pairings = new Map();
  const devices = new Map();
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    calls.push({ sql, params });
    let result = [];
    if (sql.startsWith("INSERT INTO habitat_device_pairings")) {
      pairings.set(params[0], { device_id: "*", created_at: params[1], expires_at: params[2], consumed_at: null });
    } else if (sql.startsWith("UPDATE habitat_device_pairings SET consumed_at = ?, device_id = ?")) {
      const row = pairings.get(params[2]);
      if (row && (row.device_id === params[1] || row.device_id === "*") && !row.consumed_at && row.expires_at > params[4]) {
        row.device_id = params[1];
        row.consumed_at = params[0];
        result = [{ results: [{ device_id: row.device_id }] }];
      } else result = [{ results: [] }];
    } else if (sql.startsWith("INSERT INTO habitat_paired_devices")) {
      devices.set(params[0], { device_id: params[0], token_hash: params[1], created_at: params[2], last_seen_at: null, revoked_at: null });
    } else if (sql.startsWith("SELECT token_hash FROM habitat_paired_devices")) {
      const row = devices.get(params[0]);
      result = [{ results: row && !row.revoked_at ? [{ token_hash: row.token_hash }] : [] }];
    } else if (sql.startsWith("SELECT device_id FROM habitat_paired_devices")) {
      const row = devices.get(params[0]);
      result = [{ results: row && !row.revoked_at ? [{ device_id: row.device_id }] : [] }];
    } else if (sql.startsWith("UPDATE habitat_paired_devices SET last_seen_at = ?, device_json = ?")) {
      const row = devices.get(params[2]);
      if (row && !row.revoked_at) { row.last_seen_at = params[0]; row.device_json = params[1]; }
    } else if (sql.startsWith("UPDATE habitat_paired_devices SET last_seen_at")) {
      const row = devices.get(params[1]);
      if (row && !row.revoked_at) row.last_seen_at = params[0];
    } else if (sql.startsWith("SELECT device_id, created_at, last_seen_at, device_json, revoked_at")) {
      result = [{ results: [...devices.values()].map(({device_id,created_at,last_seen_at,device_json,revoked_at}) => ({device_id,created_at,last_seen_at,device_json,revoked_at})) }];
    } else if (sql.startsWith("UPDATE habitat_paired_devices SET revoked_at")) {
      const row = devices.get(params[1]);
      if (row) row.revoked_at = params[0];
    } else if (sql.startsWith("UPDATE habitat_device_pairings SET consumed_at = ? WHERE device_id")) {
      for (const row of pairings.values()) if (row.device_id === params[1] && !row.consumed_at) row.consumed_at = params[0];
    }
    return response(result);
  };
  return { fetchImpl, pairings, devices, calls };
}

test("D1 device repository stores only hashes, supports one-time bootstrap pairing, and revokes devices", async () => {
  const fake = fakeD1();
  const repo = createD1DeviceCommandRepository({
    accountId: "account",
    databaseId: "database",
    apiToken: "test-only-d1-token",
    fetchImpl: fake.fetchImpl
  });
  await repo.initialize();

  const code = "bootstrap-code-that-is-never-stored-raw";
  const codeHash = createHash("sha256").update(code).digest("hex");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await repo.seedBootstrapPairing({ codeHash, createdAt: now, expiresAt: expires });
  assert.equal(fake.pairings.has(codeHash), true);
  assert.equal(JSON.stringify([...fake.pairings.values()]).includes(code), false);

  assert.equal(await repo.consumePairing({ codeHash, deviceId: "s26-ultra", consumedAt: now }), true);
  assert.equal(await repo.consumePairing({ codeHash, deviceId: "other-device", consumedAt: now }), false);

  // Re-seeding the same bootstrap digest must restore a fresh, unused wildcard record.
  const renewedAt = new Date(Date.now() + 1000).toISOString();
  const renewedExpiry = new Date(Date.now() + 11 * 60 * 1000).toISOString();
  await repo.seedBootstrapPairing({ codeHash, createdAt: renewedAt, expiresAt: renewedExpiry });
  assert.equal(fake.pairings.get(codeHash).consumed_at, null);
  assert.equal(fake.pairings.get(codeHash).expires_at, renewedExpiry);
  assert.equal(await repo.consumePairing({ codeHash, deviceId: "s26-ultra", consumedAt: renewedAt }), true);

  const token = "device-token-value-not-persisted-raw";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await repo.registerDevice({ deviceId: "s26-ultra", tokenHash, createdAt: now });
  assert.equal(fake.devices.get("s26-ultra").token_hash, tokenHash);
  assert.equal(JSON.stringify(fake.devices.get("s26-ultra")).includes(token), false);
  assert.equal(await repo.verifyDeviceToken(token, "s26-ultra"), true);
  assert.equal(await repo.verifyDeviceToken("wrong-token", "s26-ultra"), false);

  await repo.touchDevice("s26-ultra", now);
  await repo.updateDeviceInfo("s26-ultra", now, { model: "Galaxy S26 Ultra", batteryPercent: 83 });
  const listed = (await repo.listDevices())[0];
  assert.equal(listed.last_seen_at, now);
  assert.deepEqual(JSON.parse(listed.device_json), { model: "Galaxy S26 Ultra", batteryPercent: 83 });
  assert.equal(await repo.isDevicePaired("s26-ultra"), true);

  await repo.revokeDevice("s26-ultra", now);
  assert.equal(await repo.verifyDeviceToken(token, "s26-ultra"), false);
  assert.equal(await repo.isDevicePaired("s26-ultra"), false);
  assert.ok(fake.calls.every(call => !JSON.stringify(call).includes(token)));
  assert.ok(fake.calls.every(call => !JSON.stringify(call).includes("test-only-d1-token")));
});
