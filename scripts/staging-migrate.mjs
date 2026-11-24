#!/usr/bin/env node
/**
 * Guarded application of migrations 0010-0016 to the non-production D1 database.
 *
 * Order of operations is deliberate:
 *  1. validate the target and refuse production before any network request;
 *  2. take a D1 Time Travel bookmark (the recoverable snapshot) and refuse to migrate without one;
 *  3. apply 0010-0016 through the existing verifier (idempotent `IF NOT EXISTS` SQL);
 *  4. verify every expected table/index exists and report the bookmark for restore.
 *
 * The token is read from the environment and never printed. Output is JSON; progress goes to stderr.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { runD1StagingVerification } from "./d1-staging-verify.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
export const FROM_MIGRATION = "0010";
export const EXPECTED_TABLES = Object.freeze([
  "habitat_ax_worker_adapters", "habitat_ax_workers", "habitat_ax_worker_assignments",
  "habitat_ax_worker_results", "habitat_ax_worker_audit", "habitat_ax_missions",
  "habitat_ax_mission_events", "habitat_ax_gateway_clients", "habitat_ax_gateway_nonces",
  "habitat_ax_gateway_audit", "habitat_ax_heartbeat_state", "habitat_ax_heartbeat_events",
  "habitat_ax_heartbeat_deliveries", "habitat_ax_gateway_rate_limits", "habitat_ax_mcp_subscriptions",
  "habitat_ax_mcp_verifications", "habitat_ax_mcp_events", "habitat_ax_mcp_deliveries",
  "habitat_ax_mcp_delivery_leases"
]);
export const EXPECTED_INDEXES = Object.freeze([
  "habitat_ax_workers_specialty", "habitat_ax_worker_assignments_active_task",
  "habitat_ax_worker_assignments_agent", "habitat_ax_worker_results_task",
  "habitat_ax_worker_audit_action", "habitat_ax_missions_status",
  "habitat_ax_mission_events_mission", "habitat_ax_gateway_clients_token",
  "habitat_ax_heartbeat_events_dedupe", "habitat_ax_heartbeat_events_pending",
  "habitat_ax_mcp_subscriptions_identity", "habitat_ax_mcp_events_event_id",
  "habitat_ax_mcp_events_name_seq", "habitat_ax_mcp_deliveries_identity",
  "habitat_ax_mcp_deliveries_due", "habitat_ax_mcp_delivery_leases_expiry"
]);

function trimmed(value) {
  return String(value ?? "").trim();
}

function validate(env) {
  const accountId = trimmed(env.CLOUDFLARE_ACCOUNT_ID);
  const token = trimmed(env.HABITAT_D1_API_TOKEN) || trimmed(env.CLOUDFLARE_API_TOKEN);
  const databaseId = trimmed(env.STAGING_D1_DATABASE_ID);
  const productionId = trimmed(env.PRODUCTION_D1_DATABASE_ID);
  if (!accountId || !token || !databaseId) return { ok: false, code: "missing_configuration", error: "CLOUDFLARE_ACCOUNT_ID, a D1 API token and STAGING_D1_DATABASE_ID are required." };
  if (!ACCOUNT_ID.test(accountId)) return { ok: false, code: "malformed_account_id", error: "CLOUDFLARE_ACCOUNT_ID must be the 32-character account id." };
  if (!UUID.test(databaseId)) return { ok: false, code: "malformed_database_id", error: "The target database id must be a D1 UUID." };
  if (!UUID.test(productionId)) return { ok: false, code: "production_id_unavailable", error: "PRODUCTION_D1_DATABASE_ID must be a D1 UUID; refusing without an isolation guard." };
  if (databaseId === productionId) return { ok: false, code: "staging_is_production", error: "The target equals production. Nothing was sent." };
  return { ok: true, accountId, token, databaseId, productionId };
}

/** GET the current D1 Time Travel bookmark; this is the pre-migration restore point. */
async function readBookmark({ accountId, databaseId, token, fetchImpl }) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/d1/database/" + databaseId + "/time_travel/bookmark";
  let response;
  try {
    response = await fetchImpl(endpoint, { method: "GET", headers: { authorization: "Bearer " + token } });
  } catch (error) {
    return { ok: false, code: "backup_unavailable", error: String(error?.message || error).slice(0, 200) };
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || body?.success === false) {
    const detail = body?.errors?.map((item) => item?.message).filter(Boolean).join("; ") || "HTTP " + response.status;
    return { ok: false, code: "backup_unavailable", error: "Time Travel bookmark failed: " + String(detail).slice(0, 200) };
  }
  const bookmark = String(body?.result?.bookmark || "").trim();
  if (!bookmark) return { ok: false, code: "backup_unavailable", error: "Time Travel bookmark response had no bookmark." };
  return { ok: true, bookmark };
}

export async function runStagingMigration({ env = process.env, fetchImpl = fetch, rootDir = process.cwd(), log = () => {} } = {}) {
  const target = validate(env);
  if (!target.ok) return { ...target, mode: "migrate" };

  const backup = await readBookmark({ ...target, fetchImpl });
  if (!backup.ok) {
    return { ...backup, mode: "migrate", databaseId: target.databaseId, note: "Refused to migrate without a recoverable snapshot; nothing was written." };
  }
  log("bookmark captured (restore point recorded; value redacted from logs)");

  const report = await runD1StagingVerification({ env, mode: "migrate", fromMigration: FROM_MIGRATION, fetchImpl, rootDir, log });
  if (!report.ok) return { ...report, backup: { bookmark: backup.bookmark, takenAt: new Date().toISOString() } };

  const tables = new Set(report.after?.tables || []);
  const indexes = new Set(report.after?.indexes || []);
  const missingTables = EXPECTED_TABLES.filter((name) => !tables.has(name));
  const missingIndexes = EXPECTED_INDEXES.filter((name) => !indexes.has(name));
  const ok = missingTables.length === 0 && missingIndexes.length === 0;
  return {
    ok,
    code: ok ? null : "readiness_schema_incomplete",
    mode: "migrate",
    databaseId: target.databaseId,
    productionIdDiffers: true,
    fromMigration: FROM_MIGRATION,
    applied: report.applied,
    before: report.before,
    after: report.after,
    missingTables,
    missingIndexes,
    backup: { bookmark: backup.bookmark, takenAt: new Date().toISOString(), restore: "POST /accounts/{account_id}/d1/database/{database_id}/time_travel/restore?bookmark=<bookmark>" },
    note: "No token, header, encryption key or credential value appears in this report. Production was never targeted."
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const report = await runStagingMigration({ rootDir: path.resolve(process.cwd()), log: (line) => console.error(line) });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
