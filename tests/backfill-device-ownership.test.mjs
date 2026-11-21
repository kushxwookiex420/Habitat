import test from "node:test";
import assert from "node:assert/strict";
import { runBackfill } from "../scripts/backfill-device-ownership.mjs";

function fakeRepository({ preflight } = {}) {
  const calls = { initialize: 0, preflight: 0, backfill: 0, audit: 0 };
  return {
    calls,
    async initialize() { calls.initialize += 1; },
    async preflightOwnership(args) {
      calls.preflight += 1;
      return preflight ? preflight(args) : {
        ok: true,
        action: "assign",
        assigned: true,
        deviceId: args.deviceId,
        ownerDeviceId: args.ownerDeviceId,
        targetRevoked: false
      };
    },
    async backfillOwnership(args) {
      calls.backfill += 1;
      return { ok: true, assigned: true, deviceId: args.deviceId };
    },
    async audit() { calls.audit += 1; }
  };
}

const mapping = {
  devices: [{ deviceId: "existing-phone", ownerDeviceId: "owner-phone" }]
};

test("dry-run performs owner/target preflight but never initializes, maps, or audits", async () => {
  const repository = fakeRepository();
  const result = await runBackfill({
    mapping,
    apply: false,
    repository,
    authorizedOwnerIds: ["owner-phone"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.mode, "dry-run");
  assert.equal(result.summary.requested, 1);
  assert.equal(result.summary.wouldAssign, 1);
  assert.equal(result.summary.assigned, 0);
  assert.equal(result.summary.results[0].dryRun, true);
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 1, backfill: 0, audit: 0 });
});

test("apply uses the same preflight, then maps and audits", async () => {
  const repository = fakeRepository();
  const result = await runBackfill({
    mapping,
    apply: true,
    confirm: "APPLY_DEVICE_OWNERSHIP_BACKFILL",
    repository,
    authorizedOwnerIds: ["owner-phone"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.assigned, 1);
  assert.deepEqual(repository.calls, { initialize: 1, preflight: 1, backfill: 1, audit: 1 });
});

test("dry-run reports an already-assigned mapping without writing", async () => {
  const repository = fakeRepository({
    preflight: args => ({
      ok: true,
      action: "already_assigned",
      assigned: false,
      deviceId: args.deviceId,
      ownerDeviceId: args.ownerDeviceId,
      targetRevoked: false
    })
  });
  const result = await runBackfill({
    mapping,
    apply: false,
    repository,
    authorizedOwnerIds: ["owner-phone"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.alreadyAssigned, 1);
  assert.equal(result.summary.wouldAssign, 0);
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 1, backfill: 0, audit: 0 });
});

test("dry-run reports a missing/inactive/revoked owner and makes no write", async () => {
  const repository = fakeRepository({
    preflight: () => ({ ok: false, code: "owner_revoked", error: "The proposed owner device is revoked." })
  });
  const result = await runBackfill({
    mapping,
    apply: false,
    repository,
    authorizedOwnerIds: ["owner-phone"]
  });
  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.results[0].code, "owner_revoked");
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 1, backfill: 0, audit: 0 });
});

test("dry-run refuses an empty owner allowlist before touching the repository", async () => {
  const repository = fakeRepository();
  const result = await runBackfill({ mapping, apply: false, repository, authorizedOwnerIds: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "owner_authorization_required");
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 0, backfill: 0, audit: 0 });
});

test("invalid mappings are rejected before any repository call", async () => {
  const repository = fakeRepository();
  const result = await runBackfill({
    mapping: { devices: [{ deviceId: "bad id", ownerDeviceId: "owner-phone" }] },
    apply: false,
    repository,
    authorizedOwnerIds: ["owner-phone"]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_id");
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 0, backfill: 0, audit: 0 });
});

test("a partial apply can be rerun without duplicating the already-written mapping", async () => {
  const owners = new Map();
  let secondReady = false;
  const calls = { preflight: 0, backfill: 0, audit: 0 };
  const repository = {
    async initialize() {},
    async preflightOwnership({ deviceId, ownerDeviceId }) {
      calls.preflight += 1;
      if (deviceId === "second-phone" && !secondReady) {
        return { ok: false, code: "owner_revoked", error: "temporarily revoked" };
      }
      if (owners.get(deviceId) === ownerDeviceId) {
        return { ok: true, action: "already_assigned", assigned: false, targetRevoked: false };
      }
      return { ok: true, action: "assign", assigned: true, targetRevoked: false };
    },
    async backfillOwnership({ deviceId, ownerDeviceId }) {
      calls.backfill += 1;
      if (owners.has(deviceId)) return { ok: true, assigned: false, code: "already_owned_same" };
      owners.set(deviceId, ownerDeviceId);
      return { ok: true, assigned: true };
    },
    async audit() { calls.audit += 1; }
  };
  const two = { devices: [
    { deviceId: "first-phone", ownerDeviceId: "owner-phone" },
    { deviceId: "second-phone", ownerDeviceId: "owner-phone" }
  ] };
  const first = await runBackfill({ mapping: two, apply: true, confirm: "APPLY_DEVICE_OWNERSHIP_BACKFILL", repository, authorizedOwnerIds: ["owner-phone"] });
  assert.equal(first.ok, false);
  assert.equal(first.summary.assigned, 1);
  assert.equal(first.summary.failed, 1);
  assert.deepEqual([...owners.entries()], [["first-phone", "owner-phone"]]);

  secondReady = true;
  const rerun = await runBackfill({ mapping: two, apply: true, confirm: "APPLY_DEVICE_OWNERSHIP_BACKFILL", repository, authorizedOwnerIds: ["owner-phone"] });
  assert.equal(rerun.ok, true);
  assert.equal(rerun.summary.alreadyAssigned, 1);
  assert.equal(rerun.summary.assigned, 1);
  assert.deepEqual([...owners.entries()], [["first-phone", "owner-phone"], ["second-phone", "owner-phone"]]);
  assert.equal(calls.backfill, 2, "already-assigned rows do not call the write path again");
});

test("self-ownership is rejected before any repository call", async () => {
  const repository = fakeRepository();
  const result = await runBackfill({
    mapping: { devices: [{ deviceId: "same-phone", ownerDeviceId: "same-phone" }] },
    apply: false,
    repository,
    authorizedOwnerIds: ["same-phone"]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "self_ownership");
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 0, backfill: 0, audit: 0 });
});

test("apply requires the explicit confirmation phrase", async () => {
  const repository = fakeRepository();
  const result = await runBackfill({ mapping, apply: true, repository, authorizedOwnerIds: ["owner-phone"] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "confirmation_required");
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 0, backfill: 0, audit: 0 });
});
