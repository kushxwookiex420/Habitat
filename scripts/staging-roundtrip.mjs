#!/usr/bin/env node
/**
 * Authenticated phone round trip against Habitat staging.
 *
 * Proves, with evidence, that an authenticated Ax caller can queue a harmless read-only command, that
 * the paired phone claims and executes it, and that the result comes back through the result endpoint.
 * It never prints a credential, and it targets staging only: a production URL is refused.
 *
 * The Ax credential is read from HABITAT_AX_COMMAND_TOKEN and never written to the report; only its
 * presence is reported.
 */

import { createHash } from "node:crypto";

const STAGING_HOST = "habitat-staging-e3ie.onrender.com";
const PRODUCTION_HOST = "habitat-1-szzd.onrender.com";
const COMMAND_TYPE = "device.status";
const DEFAULT_TIMEOUT_SECONDS = 720;
const POLL_MS = 5000;

function ref(value) {
  return "dev_" + createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function envValue(name) {
  return String(process.env[name] || "").trim();
}

function resolveBase() {
  const raw = envValue("STAGING_BASE_URL") || "https://" + STAGING_HOST;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_base_url" };
  }
  if (url.protocol !== "https:") return { ok: false, code: "https_required" };
  if (url.hostname === PRODUCTION_HOST) return { ok: false, code: "refuses_production" };
  if (url.hostname !== STAGING_HOST) return { ok: false, code: "not_the_staging_host" };
  return { ok: true, origin: url.origin };
}

async function call(origin, path, { method = "GET", token = null, body = null, timeoutMs = 45_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(origin + path, {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, ok: response.ok, json, text: json ? null : text.slice(0, 300) };
  } catch (error) {
    return { status: 0, ok: false, json: null, text: "network: " + String(error?.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    target: "staging",
    commandType: COMMAND_TYPE,
    credentialPresent: Boolean(envValue("HABITAT_AX_COMMAND_TOKEN")),
    steps: {},
    command: null,
    result: null,
    ok: false
  };

  const base = resolveBase();
  if (!base.ok) {
    report.blocked = base.code;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  report.origin = base.origin;

  const token = envValue("HABITAT_AX_COMMAND_TOKEN");
  if (!token) {
    report.blocked = "ax_credential_missing";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  // 1. Wake the service and confirm it is the staging build.
  const health = await call(base.origin, "/health", { timeoutMs: 120_000 });
  report.steps.health = { status: health.status, commit: health.json?.commit || null };
  if (!health.ok) {
    report.blocked = "service_unreachable";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  // 2. Authenticated device list: proves the credential works before anything is queued.
  const devices = await call(base.origin, "/ax/device/devices", { token });
  report.steps.devices = { status: devices.status, count: Array.isArray(devices.json?.devices) ? devices.json.devices.length : null };
  if (devices.status === 401) {
    report.blocked = "ax_credential_rejected";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!devices.ok) {
    report.blocked = "device_list_failed";
    report.steps.devices.body = devices.json || devices.text;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const all = Array.isArray(devices.json?.devices) ? devices.json.devices : [];
  const live = all.filter((device) => !device.revoked);
  const requested = envValue("DEVICE_ID");
  const chosen = requested
    ? live.find((device) => device.deviceId === requested)
    : live.sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0))[0];

  report.steps.devices.paired = all.length;
  report.steps.devices.active = live.length;
  if (!chosen) {
    report.blocked = "no_paired_device";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  report.steps.devices.selected = {
    deviceRef: ref(chosen.deviceId),
    lastSeenAt: chosen.lastSeenAt || null,
    model: chosen.deviceInfo?.model || null,
    appVersion: chosen.deviceInfo?.appVersion || null
  };

  // 3. Queue the harmless read-only command.
  const queued = await call(base.origin, "/ax/device/commands", {
    method: "POST",
    token,
    body: { deviceId: chosen.deviceId, type: COMMAND_TYPE, payload: {} }
  });
  report.steps.enqueue = { status: queued.status, code: queued.json?.code || null };
  if (queued.status !== 202 || !queued.json?.command?.id) {
    report.blocked = queued.json?.code || "enqueue_failed";
    report.steps.enqueue.body = queued.json || queued.text;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  const commandId = queued.json.command.id;
  report.command = {
    id: commandId,
    type: queued.json.command.type,
    status: queued.json.command.status,
    expiresAt: queued.json.command.expiresAt,
    queuedAt: new Date().toISOString()
  };

  // 4. Wait for the phone to claim and report. A closed app falls back to a periodic job, so the
  // window is generous; the report states exactly how long it waited.
  const timeoutSeconds = Number(envValue("ROUNDTRIP_TIMEOUT_SECONDS")) || DEFAULT_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus = null;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const read = await call(base.origin, "/ax/device/commands/" + encodeURIComponent(commandId), { token });
    if (read.ok && read.json?.command) {
      const command = read.json.command;
      lastStatus = command.status;
      if (command.status === "completed" || command.status === "failed" || command.status === "cancelled") {
        report.command.status = command.status;
        report.command.completedAt = command.completedAt || null;
        report.command.attempts = command.attempts ?? null;
        report.result = command.result || null;
        break;
      }
    }
    await sleep(POLL_MS);
  }

  report.steps.wait = {
    polls,
    waitedSeconds: Math.round((Date.now() - Date.parse(report.command.queuedAt)) / 1000),
    lastObservedStatus: report.command.status || lastStatus
  };

  if (report.command.status === "completed" && report.result?.ok === true) {
    report.ok = true;
    report.verified = {
      roundTrip: true,
      deviceModelFromPhone: report.result?.details?.model || null,
      summary: report.result?.summary || null
    };
  } else {
    report.blocked = report.command.status === "queued" ? "device_did_not_claim" : "command_did_not_complete";
  }

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    generatedAt: new Date().toISOString(),
    fatal: String(error?.message || error).slice(0, 300)
  }, null, 2));
  process.exitCode = 1;
});
