#!/usr/bin/env node
// Explicit legacy-device ownership backfill.
//
// Usage:
//   HABITAT_OWNER_DEVICE_IDS=owner-phone node scripts/backfill-device-ownership.mjs --map ./ownership.json
//   HABITAT_OWNER_DEVICE_IDS=owner-phone node scripts/backfill-device-ownership.mjs --map ./ownership.json --apply --confirm APPLY_DEVICE_OWNERSHIP_BACKFILL
//
// Dry-run performs the same owner/target/ownership preflight as apply, but it never calls
// initialize(), never inserts a mapping, and never writes an audit row. Apply initializes the
// additive schema first, then performs the same preflight before each conditional write.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { createD1DeviceCommandRepository } from "../d1-device-command-repository.mjs";
import { validateBackfillInput } from "../device-ownership-migration.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function has(name) {
  return process.argv.includes(name);
}

function configuredOwnerIds() {
  // Use the same deployment allowlist as the runtime. Do not accept an arbitrary CLI allowlist:
  // a mapping must not attach a device to an owner the service does not actually authorize.
  const raw = String(process.env.HABITAT_OWNER_DEVICE_IDS || process.env.HABITAT_OWNER_DEVICE_ID || "");
  return raw.split(",").map(value => value.trim()).filter(Boolean);
}

/**
 * Run a validated backfill. Exported so tests can prove dry-run has no side effects without
 * reaching a real D1 endpoint. Returns a serializable report, not a secret-bearing object.
 */
export async function runBackfill({
  mapping,
  apply = false,
  confirm = null,
  repository,
  authorizedOwnerIds = [],
  assignedAt = new Date().toISOString()
} = {}) {
  const validation = validateBackfillInput(mapping);
  if (!validation.ok) return { ok: false, code: validation.code, error: validation.error, summary: null };
  if (!apply && confirm !== null) {
    return { ok: false, code: "invalid_mode", error: "Do not pass --confirm without --apply.", summary: null };
  }
  if (apply && confirm !== "APPLY_DEVICE_OWNERSHIP_BACKFILL") {
    return { ok: false, code: "confirmation_required", error: "Pass --confirm APPLY_DEVICE_OWNERSHIP_BACKFILL for apply.", summary: null };
  }
  if (!repository || typeof repository.preflightOwnership !== "function") {
    return { ok: false, code: "repository_required", error: "A device repository with preflightOwnership is required.", summary: null };
  }
  const allowed = [...new Set((Array.isArray(authorizedOwnerIds) ? authorizedOwnerIds : String(authorizedOwnerIds || "").split(","))
    .map(value => String(value || "").trim()).filter(Boolean))];
  if (allowed.length === 0) {
    return { ok: false, code: "owner_authorization_required", error: "Set the runtime owner allowlist (HABITAT_OWNER_DEVICE_IDS or HABITAT_OWNER_DEVICE_ID) before mapping ownership.", summary: null };
  }

  // Apply may create the additive schema. Dry-run deliberately skips this: a preflight must not
  // change database structure or rows. If the schema is absent, the read-only preflight fails and
  // the operator must apply the migration separately.
  if (apply) await repository.initialize();

  const results = [];
  for (const assignment of validation.assignments) {
    const preflight = await repository.preflightOwnership({
      deviceId: assignment.deviceId,
      ownerDeviceId: assignment.ownerDeviceId,
      authorizedOwnerIds: allowed
    });
    if (!preflight.ok) {
      results.push({ ...assignment, ok: false, code: preflight.code, error: preflight.error });
      continue;
    }
    if (!apply) {
      results.push({
        ...assignment,
        ok: true,
        dryRun: true,
        action: preflight.action,
        assigned: false,
        wouldAssign: preflight.assigned === true,
        targetRevoked: Boolean(preflight.targetRevoked)
      });
      continue;
    }
    if (preflight.action === "already_assigned") {
      // The read-only preflight already proved the row is correct. Do not perform a redundant
      // conditional write or emit another audit row on a rerun.
      results.push({
        ...assignment,
        ok: true,
        assigned: false,
        code: "already_owned_same",
        existingOwnerDeviceId: assignment.ownerDeviceId,
        targetRevoked: Boolean(preflight.targetRevoked)
      });
      continue;
    }
    const outcome = await repository.backfillOwnership({
      ...assignment,
      assignedAt,
      authorizedOwnerIds: allowed
    });
    if (outcome.ok && outcome.assigned === true) {
      await repository.audit({
        event: "device.ownership.backfilled",
        actorDeviceId: "operator",
        targetDeviceId: assignment.deviceId,
        detail: { ownerDeviceId: assignment.ownerDeviceId }
      });
    }
    results.push({ ...assignment, ...outcome });
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    assignedAt,
    requested: validation.assignments.length,
    assigned: results.filter(row => row.assigned === true).length,
    wouldAssign: results.filter(row => row.wouldAssign === true).length,
    alreadyAssigned: results.filter(row => row.code === "already_owned_same" || row.action === "already_assigned").length,
    failed: results.filter(row => row.ok === false).length,
    results
  };
  return { ok: results.every(row => row.ok !== false), summary };
}

async function main() {
  const mapPath = argument("--map");
  if (!mapPath) {
    console.error("missing --map <explicit-ownership.json>");
    process.exitCode = 2;
    return;
  }
  const raw = await readFile(mapPath, "utf8");
  let input;
  try { input = JSON.parse(raw); } catch {
    console.error("mapping is not valid JSON");
    process.exitCode = 2;
    return;
  }

  const apply = has("--apply");
  const repository = createD1DeviceCommandRepository({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.HABITAT_D1_DATABASE_ID,
    apiToken: process.env.HABITAT_D1_API_TOKEN
  });
  const result = await runBackfill({
    mapping: input,
    apply,
    confirm: argument("--confirm"),
    repository,
    authorizedOwnerIds: configuredOwnerIds()
  });
  if (!result.ok) {
    console.error(result.code + ": " + result.error);
    if (result.summary) console.error(JSON.stringify(result.summary, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result.summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Never echo environment values or D1 credentials.
    console.error("backfill failed: " + String(error?.message || error).slice(0, 300));
    process.exitCode = 1;
  });
}
