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

test("apply requires the explicit confirmation phrase", async () => {
  const repository = fakeRepository();
  const result = await runBackfill({ mapping, apply: true, repository, authorizedOwnerIds: ["owner-phone"] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "confirmation_required");
  assert.deepEqual(repository.calls, { initialize: 0, preflight: 0, backfill: 0, audit: 0 });
});
