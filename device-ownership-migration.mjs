// Explicit-device ownership backfill for Revision 4.
//
// Legacy Revision 3 devices have no row in habitat_device_ownership. There is no safe way to
// infer an owner from pairing order, last-seen time, device name, or environment defaults. This
// module therefore accepts only an explicit, complete mapping supplied by an operator and refuses
// to invent a default owner.

const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function validBackfillDeviceId(value) {
  return DEVICE_ID.test(String(value || "").trim());
}

/**
 * Validate the operator's JSON mapping before any database write.
 *
 * Accepted shape:
 *   { "devices": [ { "deviceId": "...", "ownerDeviceId": "..." } ] }
 * or a bare array of those objects.
 */
export function validateBackfillInput(input) {
  const rows = Array.isArray(input) ? input : input?.devices;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, code: "mapping_required", error: "An explicit devices array is required." };
  }
  if (rows.length > 5000) {
    return { ok: false, code: "mapping_too_large", error: "A backfill is limited to 5000 devices per run." };
  }
  const assignments = [];
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, code: "invalid_row", error: `Row ${index + 1} must be an object.` };
    }
    const deviceId = String(row.deviceId || "").trim();
    const ownerDeviceId = String(row.ownerDeviceId || "").trim();
    if (!validBackfillDeviceId(deviceId) || !validBackfillDeviceId(ownerDeviceId)) {
      return { ok: false, code: "invalid_id", error: `Row ${index + 1} needs valid deviceId and ownerDeviceId values.` };
    }
    if (deviceId === ownerDeviceId) {
      return { ok: false, code: "self_ownership", error: `Row ${index + 1} cannot make device ${deviceId} its own owner.` };
    }
    if (seen.has(deviceId)) {
      return { ok: false, code: "duplicate_device", error: `Device ${deviceId} appears more than once.` };
    }
    seen.add(deviceId);
    assignments.push({ deviceId, ownerDeviceId });
  }
  return { ok: true, assignments };
}
