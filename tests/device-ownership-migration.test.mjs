import test from "node:test";
import assert from "node:assert/strict";
import { validateBackfillInput } from "../device-ownership-migration.mjs";

test("ownership backfill accepts only an explicit, complete mapping", () => {
  assert.equal(validateBackfillInput([]).ok, false);
  assert.equal(validateBackfillInput({ devices: [] }).ok, false);
  assert.equal(validateBackfillInput({ devices: [{ deviceId: "phone" }] }).ok, false);
  assert.equal(validateBackfillInput({ devices: [{ deviceId: "bad id", ownerDeviceId: "owner-phone" }] }).ok, false);

  const valid = validateBackfillInput({
    devices: [{ deviceId: "existing-phone", ownerDeviceId: "owner-phone" }]
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.assignments, [{ deviceId: "existing-phone", ownerDeviceId: "owner-phone" }]);
});

test("ownership backfill refuses duplicate devices instead of choosing one", () => {
  const result = validateBackfillInput([
    { deviceId: "existing-phone", ownerDeviceId: "owner-a" },
    { deviceId: "existing-phone", ownerDeviceId: "owner-b" }
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "duplicate_device");
});
