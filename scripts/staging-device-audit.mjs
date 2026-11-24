#!/usr/bin/env node
/**
 * Read-only audit of the phone-bridge tables in the staging D1 database.
 *
 * Purpose: prove what the live staging service actually knows about the paired phone, without a
 * phone-side credential and without exposing anything sensitive. It selects named columns only, so a
 * token hash, pairing code digest or raw credential can never appear in the report, and it prints no
 * account, database or device identifier in full.
 *
 * It refuses to run against the production database id, matching the service's own staging guard.
 */

import { createHash } from "node:crypto";
import { PRODUCTION_D1_DATABASE_ID } from "../staging-guard.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[0-9a-f]{32}$/i;

function envValue(name) {
  return String(process.env[name] || "").trim();
}

function target() {
  const accountId = envValue("CLOUDFLARE_ACCOUNT_ID");
  const token = envValue("HABITAT_D1_API_TOKEN") || envValue("CLOUDFLARE_API_TOKEN");
  const databaseId = envValue("STAGING_D1_DATABASE_ID");
  if (!ACCOUNT.test(accountId)) return { ok: false, code: "malformed_account_id" };
  if (!UUID.test(databaseId)) return { ok: false, code: "malformed_database_id" };
  if (databaseId.toLowerCase() === PRODUCTION_D1_DATABASE_ID) {
    return { ok: false, code: "staging_is_production_database" };
  }
  if (!token) return { ok: false, code: "missing_d1_token" };
  return { ok: true, accountId, token, databaseId };
}

async function d1Query(targetInfo, sql) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + targetInfo.accountId +
    "/d1/database/" + targetInfo.databaseId + "/query";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + targetInfo.token, "content-type": "application/json" },
    body: JSON.stringify({ sql })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    // Cloudflare's own error codes make a revoked or under-scoped token actionable. They contain no
    // credential, so they are safe to report.
    const detail = Array.isArray(body?.errors)
      ? body.errors.map((entry) => (entry?.code ?? "?") + ":" + String(entry?.message || "").slice(0, 120)).join("; ")
      : "";
    throw new Error("d1 query failed: HTTP " + response.status + (detail ? " (" + detail + ")" : ""));
  }
  return Array.isArray(body?.result) ? body.result.flatMap((item) => item?.results || []) : [];
}

/** A stable, non-reversible label so two rows can be compared without printing a device id. */
function ref(value) {
  return "dev_" + createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function deviceSummary(deviceJson) {
  if (!deviceJson) return null;
  try {
    const parsed = JSON.parse(deviceJson);
    return {
      manufacturer: parsed?.manufacturer || null,
      model: parsed?.model || null,
      androidSdk: parsed?.androidSdk || null,
      androidRelease: parsed?.androidRelease || null,
      appVersion: parsed?.appVersion || null,
      batteryPercent: Number.isInteger(parsed?.batteryPercent) ? parsed?.batteryPercent : null,
      charging: typeof parsed?.charging === "boolean" ? parsed?.charging : null,
      interactive: typeof parsed?.interactive === "boolean" ? parsed?.interactive : null
    };
  } catch {
    return { unparsable: true };
  }
}

function commandSummary(recordJson) {
  if (!recordJson) return null;
  try {
    const parsed = JSON.parse(recordJson);
    const result = parsed?.result && typeof parsed.result === "object" ? parsed.result : null;
    return {
      id: String(parsed?.id || "").slice(0, 12) || null,
      type: parsed?.type || null,
      status: parsed?.status || null,
      createdAt: parsed?.createdAt || null,
      claimedAt: parsed?.claimedAt || null,
      completedAt: parsed?.completedAt || null,
      result: result
        ? { ok: result.ok === true, summary: String(result.summary || "").slice(0, 200) }
        : null
    };
  } catch {
    return { unparsable: true };
  }
}

async function inspectCredential(targetInfo) {
  const out = { present: Boolean(targetInfo.token) };
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { authorization: "Bearer " + targetInfo.token, "content-type": "application/json" }
    });
    const body = await response.json().catch(() => null);
    out.verifyStatus = response.status;
    out.active = body?.success === true && body?.result?.status === "active";
    out.resultStatus = body?.result?.status || null;
    out.expiresOn = body?.result?.expires_on || null;
    out.notBefore = body?.result?.not_before || null;
    out.verifyError = Array.isArray(body?.errors) && body.errors.length
      ? body.errors.map((entry) => (entry?.code ?? "?") + ":" + String(entry?.message || "").slice(0, 80)).join("; ")
      : null;
  } catch (error) {
    out.verifyStatus = 0;
    out.verifyError = String(error?.message || error).slice(0, 120);
  }
  try {
    const metadata = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" + targetInfo.accountId + "/d1/database/" + targetInfo.databaseId,
      { headers: { authorization: "Bearer " + targetInfo.token, "content-type": "application/json" } }
    );
    const body = await metadata.json().catch(() => null);
    out.databaseMetadataStatus = metadata.status;
    out.databaseMetadataError = Array.isArray(body?.errors) && body.errors.length
      ? body.errors.map((entry) => (entry?.code ?? "?") + ":" + String(entry?.message || "").slice(0, 80)).join("; ")
      : null;
  } catch (error) {
    out.databaseMetadataStatus = 0;
    out.databaseMetadataError = String(error?.message || error).slice(0, 120);
  }
  return out;
}

async function safeQuery(targetInfo, sql, report, label) {
  try {
    return await d1Query(targetInfo, sql);
  } catch (error) {
    report.errors.push({ query: label, error: String(error?.message || error).slice(0, 200) });
    return null;
  }
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    target: "staging",
    productionDatabaseIdRefused: true,
    checks: {},
    errors: []
  };

  const targetInfo = target();
  if (!targetInfo.ok) {
    report.ok = false;
    report.blocked = targetInfo.code;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  // Cloudflare reports two very different failures as code 10000 (a rejected credential and a missing
  // route/scope). The token verify endpoint and a metadata read separate them without exposing the
  // token: verify says whether it is active and when it expires; metadata tests the D1 route itself.
  report.credential = await inspectCredential(targetInfo);

  const tables = await safeQuery(
    targetInfo,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'habitat_%' ORDER BY name",
    report,
    "tables"
  );
  report.checks.tables = Array.isArray(tables) ? tables.map((row) => row.name) : null;

  const devices = await safeQuery(
    targetInfo,
    "SELECT device_id, created_at, last_seen_at, revoked_at, device_json FROM habitat_paired_devices ORDER BY created_at DESC LIMIT 20",
    report,
    "paired_devices"
  );
  report.checks.pairedDevices = Array.isArray(devices)
    ? devices.map((row) => ({
      deviceRef: ref(row.device_id),
      pairedAt: row.created_at,
      lastSeenAt: row.last_seen_at || null,
      revoked: Boolean(row.revoked_at),
      device: deviceSummary(row.device_json)
    }))
    : null;
  report.checks.activePairedDevices = Array.isArray(devices)
    ? devices.filter((row) => !row.revoked_at).length
    : null;
  report.checks.devicesSeenInLastHour = Array.isArray(devices)
    ? devices.filter((row) => row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 3_600_000).length
    : null;

  const pairings = await safeQuery(
    targetInfo,
    "SELECT device_id, created_at, expires_at, consumed_at FROM habitat_device_pairings ORDER BY created_at DESC LIMIT 10",
    report,
    "pairings"
  );
  report.checks.pairings = Array.isArray(pairings)
    ? pairings.map((row) => ({
      deviceRef: row.device_id === "*" ? "*" : ref(row.device_id),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at || null
    }))
    : null;

  const commandCounts = await safeQuery(
    targetInfo,
    "SELECT status, COUNT(*) AS count FROM habitat_device_commands GROUP BY status",
    report,
    "command_counts"
  );
  report.checks.commandCounts = Array.isArray(commandCounts) ? commandCounts : null;

  const commands = await safeQuery(
    targetInfo,
    "SELECT record_json FROM habitat_device_commands ORDER BY created_at DESC LIMIT 15",
    report,
    "recent_commands"
  );
  report.checks.recentCommands = Array.isArray(commands)
    ? commands.map((row) => commandSummary(row.record_json))
    : null;

  const completed = await safeQuery(
    targetInfo,
    "SELECT record_json FROM habitat_device_commands WHERE status = 'completed' ORDER BY created_at DESC LIMIT 5",
    report,
    "completed_commands"
  );
  report.checks.completedCommands = Array.isArray(completed)
    ? completed.map((row) => commandSummary(row.record_json))
    : null;

  const heartbeat = await safeQuery(
    targetInfo,
    "SELECT integration, status, last_beat_at, last_seen_at, missed_beats, failures FROM habitat_ax_heartbeat_state",
    report,
    "heartbeat_state"
  );
  report.checks.heartbeatState = Array.isArray(heartbeat) ? heartbeat : null;

  const heartbeatEvents = await safeQuery(
    targetInfo,
    "SELECT status, COUNT(*) AS count FROM habitat_ax_heartbeat_events GROUP BY status",
    report,
    "heartbeat_event_counts"
  );
  report.checks.heartbeatEventCounts = Array.isArray(heartbeatEvents) ? heartbeatEvents : null;

  // A device row plus a completed command is the only durable proof that the phone round-tripped.
  // A report that could not read the database is not a passing audit. The job must go red so a
  // revoked or rotated credential is visible instead of looking like "no devices paired".
  const unauthorized = report.errors.some((entry) => /HTTP 401|HTTP 403/.test(entry.error));
  if (unauthorized) report.blocked = "cloudflare_rejected_d1_token";

  report.summary = {
    credentialActive: report.credential?.active === true,
    credentialExpiresOn: report.credential?.expiresOn || null,
    databaseMetadataStatus: report.credential?.databaseMetadataStatus ?? null,
    pairedDeviceRows: report.checks.pairedDevices?.length,
    activePairedDevices: report.checks.activePairedDevices,
    devicesSeenInLastHour: report.checks.devicesSeenInLastHour,
    commandStatuses: report.checks.commandCounts,
    completedCommands: Array.isArray(report.checks.completedCommands) ? report.checks.completedCommands.length : null,
    heartbeatIntegrations: Array.isArray(report.checks.heartbeatState) ? report.checks.heartbeatState.length : null
  };
  report.ok = report.errors.length === 0;
  if (!report.ok) process.exitCode = 1;

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    fatal: String(error?.message || error).slice(0, 200)
  }, null, 2));
  process.exitCode = 1;
});
