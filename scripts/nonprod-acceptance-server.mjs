#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  startNonproductionHarness,
  AX_TOKEN,
  OWNER_TOKEN,
  OWNER_DEVICE_ID,
  TARGET_DEVICE_ID
} from "../tests/helpers/nonprod-harness.mjs";

/**
 * Nonproduction acceptance server for the Android client integration test.
 *
 * This is NOT the Habitat service and is never imported by server.mjs. It mounts the same
 * device-command-bridge handlers, engine, and repositories on a loopback HTTP listener backed by
 * SQLite, and adds one token-gated route that lets a test ask the relay to queue the harmless
 * read-only device.status command without the external Home Bridge.
 *
 * Usage: node scripts/nonprod-acceptance-server.mjs
 * Prints one HABITAT_ACCEPTANCE_SERVER line with the loopback URL and harness credentials.
 */

const acceptanceToken = String(
  process.env.HABITAT_ACCEPTANCE_TOKEN || "acceptance_" + randomBytes(16).toString("hex")
).trim();

const harness = await startNonproductionHarness({ acceptanceToken });

console.log("HABITAT_ACCEPTANCE_SERVER " + JSON.stringify({
  url: harness.url,
  axToken: AX_TOKEN,
  ownerToken: OWNER_TOKEN,
  ownerDeviceId: OWNER_DEVICE_ID,
  targetDeviceId: TARGET_DEVICE_ID,
  acceptanceToken
}));
console.log("HABITAT_ACCEPTANCE_SERVER_READY");

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log("HABITAT_ACCEPTANCE_SERVER_STOPPING " + signal);
  try { await harness.close(); } catch (error) { console.error(String(error?.message || error)); }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
