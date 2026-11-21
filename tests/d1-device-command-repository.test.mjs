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
  const owners = new Map();
  const pairingOwners = new Map();
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    calls.push({ sql, params });
    let result = [];
    if (sql.startsWith("PRAGMA table_info(habitat_device_pairings)")) {
      result = [{ results: [
        { name: "code_hash" }, { name: "device_id" }, { name: "created_at" },
        { name: "expires_at" }, { name: "consumed_at" }, { name: "recovery_at" }
      ] }];
    } else if (sql.startsWith("INSERT INTO habitat_device_pairings")) {
      const existing = pairings.get(params[0]);
      if (sql.includes("ON CONFLICT(code_hash)")) {
        // Bootstrap insert: preserve a consumed row exactly as SQLite's partial upsert does.
        if (!existing) {
          pairings.set(params[0], { device_id: "*", created_at: params[1], expires_at: params[2], consumed_at: null, recovery_at: null });
        } else if (!existing.consumed_at) {
          existing.created_at = params[1];
          existing.expires_at = params[2];
        }
      } else {
        pairings.set(params[0], { device_id: params[1], created_at: params[2], expires_at: params[3], consumed_at: null, recovery_at: null });
      }
    } else if (sql.startsWith("INSERT INTO habitat_pairing_owners")) {
      pairingOwners.set(params[0], params[1]);
    } else if (sql.startsWith("INSERT INTO habitat_device_ownership")) {
      if (sql.includes("DO NOTHING")) {
        if (!owners.has(params[0])) owners.set(params[0], params[1]);
      } else if (sql.includes("WHERE EXISTS")) {
        if (devices.has(params[3]) && !owners.has(params[4])) {
          owners.set(params[0], params[1]);
          result = [{ results: [{ device_id: params[0] }] }];
        } else result = [{ results: [] }];
      } else {
        owners.set(params[0], params[1]);
      }
    } else if (sql.startsWith("INSERT INTO habitat_security_audit")) {
      result = [{ results: [] }];
    } else if (sql.startsWith("SELECT owner_device_id FROM habitat_device_ownership")) {
      result = [{ results: owners.has(params[0]) ? [{ owner_device_id: owners.get(params[0]) }] : [] }];
    } else if (sql.startsWith("SELECT p.code_hash")) {
      const row = pairings.get(params[0]);
      result = [{ results: row ? [{ ...row, code_hash: params[0], owner_device_id: pairingOwners.get(params[0]) || null }] : [] }];
    } else if (sql.startsWith("SELECT d.device_id")) {
      result = [{ results: [...devices.values()].map(row => ({ ...row, owner_device_id: owners.get(row.device_id) || null })) }];
    } else if (sql.startsWith("UPDATE habitat_device_pairings SET consumed_at = ?, device_id = ?")) {
      const row = pairings.get(params[2]);
      if (row && (row.device_id === params[1] || row.device_id === "*") && !row.consumed_at && row.expires_at > params[4]) {
        row.device_id = params[1];
        row.consumed_at = params[0];
        result = [{ results: [{ device_id: row.device_id }] }];
      } else result = [{ results: [] }];
    } else if (sql.startsWith("UPDATE habitat_device_pairings SET recovery_at")) {
      const row = pairings.get(params[1]);
      if (row && row.device_id === params[2] && row.consumed_at && !row.recovery_at && row.consumed_at >= params[3]) {
        row.recovery_at = params[0];
        result = [{ results: [{ code_hash: params[1] }] }];
      } else result = [{ results: [] }];
    } else if (sql.startsWith("INSERT INTO habitat_paired_devices")) {
      const existing = devices.get(params[0]);
      devices.set(params[0], {
        device_id: params[0],
        token_hash: params[1],
        created_at: params[2],
        last_seen_at: null,
        revoked_at: existing?.revoked_at || null
      });
    } else if (sql.startsWith("SELECT revoked_at FROM habitat_paired_devices")) {
      const row = devices.get(params[0]);
      result = [{ results: row ? [{ revoked_at: row.revoked_at }] : [] }];
    } else if (sql.startsWith("UPDATE habitat_paired_devices SET revoked_at = NULL")) {
      const row = devices.get(params[0]);
      if (row && row.revoked_at) { row.revoked_at = null; row.token_hash = ""; result = [{ results: [{ device_id: params[0] }] }]; }
      for (const [codeHash, pairing] of pairings) {
        if (pairing.device_id === params[0] || pairingOwners.get(codeHash) === params[0]) pairings.delete(codeHash);
      }
    } else if (sql.startsWith("DELETE FROM habitat_device_pairings WHERE code_hash")) {
      pairings.delete(params[0]);
    } else if (sql.startsWith("DELETE FROM habitat_device_pairings WHERE device_id")) {
      for (const [codeHash, pairing] of pairings) {
        if (pairing.device_id === params[0] || pairingOwners.get(codeHash) === params[0]) pairings.delete(codeHash);
      }
    } else if (sql.startsWith("DELETE FROM habitat_pairing_owners WHERE owner_device_id")) {
      for (const [codeHash, owner] of pairingOwners) if (owner === params[0]) pairingOwners.delete(codeHash);
    } else if (sql.startsWith("SELECT token_hash FROM habitat_paired_devices")) {
      const row = devices.get(params[0]);
      result = [{ results: row && !row.revoked_at ? [{ token_hash: row.token_hash }] : [] }];
    } else if (sql.startsWith("SELECT device_id FROM habitat_paired_devices")) {
      const row = devices.get(params[0]);
      result = [{ results: row && !row.revoked_at && row.token_hash ? [{ device_id: row.device_id }] : [] }];
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
  return { fetchImpl, pairings, devices, owners, pairingOwners, calls };
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
  const ownerDeviceId = "owner-phone";
  await repo.seedBootstrapPairing({ codeHash, createdAt: now, expiresAt: expires, ownerDeviceId });
  assert.equal(fake.pairings.has(codeHash), true);
  assert.equal(JSON.stringify([...fake.pairings.values()]).includes(code), false);

  assert.equal(await repo.consumePairing({ codeHash, deviceId: "s26-ultra", consumedAt: now }), true);
  assert.equal(await repo.consumePairing({ codeHash, deviceId: "other-device", consumedAt: now }), false);

  // H4: restarting the process and re-seeding the same bootstrap digest must not reactivate a
  // consumed code, restore its wildcard binding, or make it usable again.
  const renewedAt = new Date(Date.now() + 1000).toISOString();
  const renewedExpiry = new Date(Date.now() + 11 * 60 * 1000).toISOString();
  await repo.seedBootstrapPairing({ codeHash, createdAt: renewedAt, expiresAt: renewedExpiry, ownerDeviceId });
  assert.equal(fake.pairings.get(codeHash).consumed_at, now);
  assert.equal(fake.pairings.get(codeHash).device_id, "s26-ultra");
  assert.equal(await repo.consumePairing({ codeHash, deviceId: "s26-ultra", consumedAt: renewedAt }), false);
  assert.equal(await repo.consumePairing({ codeHash, deviceId: "second-device", consumedAt: renewedAt }), false);

  const token = "device-token-value-not-persisted-raw";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await repo.registerDevice({ deviceId: "s26-ultra", tokenHash, createdAt: now, ownerDeviceId });
  assert.equal(fake.devices.get("s26-ultra").token_hash, tokenHash);
  assert.equal(JSON.stringify(fake.devices.get("s26-ultra")).includes(token), false);
  assert.equal(await repo.verifyDeviceToken(token, "s26-ultra"), true);
  assert.equal(await repo.verifyDeviceToken("wrong-token", "s26-ultra"), false);

  await repo.touchDevice("s26-ultra", now);
  await repo.updateDeviceInfo("s26-ultra", now, { model: "Galaxy S26 Ultra", batteryPercent: 83 });
  const listed = (await repo.listDevices())[0];
  assert.equal(listed.last_seen_at, now);
  assert.deepEqual(JSON.parse(listed.device_json), { model: "Galaxy S26 Ultra", batteryPercent: 83 });
  assert.equal(listed.owner_device_id, ownerDeviceId);
  assert.equal(await repo.getDeviceOwner("s26-ultra"), ownerDeviceId);
  assert.equal(await repo.isDevicePaired("s26-ultra"), true);

  await repo.revokeDeviceOwned("s26-ultra", "another-owner", now);
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), false, "a non-owner cannot revoke");
  assert.equal(await repo.revokeDeviceOwned("s26-ultra", ownerDeviceId, now), true);
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), true);

  await repo.revokeDevice("s26-ultra", now);
  assert.equal(await repo.verifyDeviceToken(token, "s26-ultra"), false);
  assert.equal(await repo.isDevicePaired("s26-ultra"), false);
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), true);
  assert.equal(fake.pairings.size, 0, "revocation invalidates every pairing code for the device");

  // Re-registration must not clear revocation.
  const replacementToken = "replacement-token-not-persisted-raw";
  const replacementHash = createHash("sha256").update(replacementToken).digest("hex");
  await repo.registerDevice({ deviceId: "s26-ultra", tokenHash: replacementHash, createdAt: now, ownerDeviceId });
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), true);
  assert.equal(await repo.verifyDeviceToken(replacementToken, "s26-ultra"), false);

  assert.equal(await repo.unrevokeDevice("s26-ultra", "someone-else"), false);
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), true);
  await repo.unrevokeDevice("s26-ultra", ownerDeviceId);
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), false);
  assert.equal(await repo.isDevicePaired("s26-ultra"), false);
  assert.equal(await repo.verifyDeviceToken(replacementToken, "s26-ultra"), false);

  const freshToken = "fresh-token-after-recovery-not-persisted-raw";
  await repo.registerDevice({ deviceId: "s26-ultra", tokenHash: createHash("sha256").update(freshToken).digest("hex"), createdAt: now, ownerDeviceId });
  assert.equal(await repo.isDevicePaired("s26-ultra"), true);
  assert.equal(await repo.verifyDeviceToken(freshToken, "s26-ultra"), true);

  // H6: explicit legacy ownership backfill never guesses and never overwrites an owner.
  fake.devices.set("legacy-phone", { device_id: "legacy-phone", token_hash: "legacy-hash", created_at: now, last_seen_at: null, revoked_at: null });
  assert.equal(await repo.getDeviceOwner("legacy-phone"), null);
  assert.deepEqual(await repo.backfillOwnership({ deviceId: "legacy-phone", ownerDeviceId, assignedAt: now }), { ok: true, assigned: true });
  assert.equal(await repo.getDeviceOwner("legacy-phone"), ownerDeviceId);
  const again = await repo.backfillOwnership({ deviceId: "legacy-phone", ownerDeviceId: "different-owner", assignedAt: now });
  assert.equal(again.ok, false);
  assert.equal(again.code, "already_owned");
  assert.equal(again.existingOwnerDeviceId, ownerDeviceId);
  const unpaired = await repo.backfillOwnership({ deviceId: "never-paired", ownerDeviceId, assignedAt: now });
  assert.equal(unpaired.ok, false);
  assert.equal(unpaired.code, "device_not_paired");

  // H7: break-glass recovery is explicit and revokes the old credential; it never returns a token.
  await repo.revokeDevice("s26-ultra", now);
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), true);
  assert.equal(await repo.unrevokeDeviceByBreakGlass("s26-ultra"), true);
  assert.equal(await repo.isDeviceRevoked("s26-ultra"), false);
  assert.equal(await repo.isDevicePaired("s26-ultra"), false, "break-glass requires fresh pairing");
  const auditResult = await repo.audit({ event: "device.break_glass.unrevoked", targetDeviceId: "s26-ultra" });
  assert.equal(auditResult.ok, true);

  assert.ok(fake.calls.every(call => !JSON.stringify(call).includes(token)));
  assert.ok(fake.calls.every(call => !JSON.stringify(call).includes("test-only-d1-token")));
});

test("concurrent ownership registration keeps the first owner and first credential", async () => {
  const fake = fakeD1();
  const repo = createD1DeviceCommandRepository({
    accountId: "account", databaseId: "database", apiToken: "test-only-d1-token", fetchImpl: fake.fetchImpl
  });
  await repo.initialize();
  const now = new Date().toISOString();
  const firstToken = createHash("sha256").update("first-owner-token").digest("hex");
  const secondToken = createHash("sha256").update("second-owner-token").digest("hex");
  assert.equal(await repo.registerDevice({ deviceId: "raced", tokenHash: firstToken, createdAt: now, ownerDeviceId: "owner-a" }), true);
  assert.equal(await repo.registerDevice({ deviceId: "raced", tokenHash: secondToken, createdAt: now, ownerDeviceId: "owner-b" }), false);
  assert.equal(await repo.getDeviceOwner("raced"), "owner-a");
  assert.equal(await repo.verifyDeviceToken("first-owner-token", "raced"), true);
  assert.equal(await repo.verifyDeviceToken("second-owner-token", "raced"), false);
});

test("a failed ownership write compensates the pairing insert instead of leaving an orphan code", async () => {
  const fake = fakeD1();
  let failOnce = true;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (failOnce && body.sql.startsWith("INSERT INTO habitat_pairing_owners")) {
      failOnce = false;
      return { ok: false, status: 500, async json() { return { success: false }; } };
    }
    return fake.fetchImpl(url, init);
  };
  const repo = createD1DeviceCommandRepository({
    accountId: "account", databaseId: "database", apiToken: "test-only-d1-token", fetchImpl
  });
  await repo.initialize();
  await assert.rejects(repo.createPairing({
    codeHash: createHash("sha256").update("partial-code").digest("hex"),
    deviceId: "launcher",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ownerDeviceId: "owner-phone"
  }));
  assert.equal(fake.pairings.size, 0, "the failed owner insert must not leave an ownerless pairing");
});
