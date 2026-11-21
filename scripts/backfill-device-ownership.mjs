#!/usr/bin/env node
// Explicit legacy-device ownership backfill.
//
// Usage:
//   node scripts/backfill-device-ownership.mjs --map ./ownership.json
//   node scripts/backfill-device-ownership.mjs --map ./ownership.json --apply --confirm APPLY_DEVICE_OWNERSHIP_BACKFILL
//
// The mapping is operator-authored. This script never derives ownership from pairing order,
// device names, last-seen times, or environment defaults.

import { readFile } from "node:fs/promises";
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
  const validation = validateBackfillInput(input);
  if (!validation.ok) {
    console.error(validation.code + ": " + validation.error);
    process.exitCode = 2;
    return;
  }

  const apply = has("--apply");
  if (apply && argument("--confirm") !== "APPLY_DEVICE_OWNERSHIP_BACKFILL") {
    console.error("refusing apply: pass --confirm APPLY_DEVICE_OWNERSHIP_BACKFILL");
    process.exitCode = 2;
    return;
  }

  const repository = createD1DeviceCommandRepository({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.HABITAT_D1_DATABASE_ID,
    apiToken: process.env.HABITAT_D1_API_TOKEN
  });
  await repository.initialize();

  const results = [];
  for (const assignment of validation.assignments) {
    if (!apply) {
      results.push({ ...assignment, dryRun: true });
      continue;
    }
    const outcome = await repository.backfillOwnership(assignment);
    if (outcome.ok) {
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
    requested: validation.assignments.length,
    assigned: results.filter(row => row.assigned === true).length,
    skipped: results.filter(row => row.assigned !== true && row.dryRun !== true).length,
    results
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  // Never echo environment values or D1 credentials.
  console.error("backfill failed: " + String(error?.message || error).slice(0, 300));
  process.exitCode = 1;
});
