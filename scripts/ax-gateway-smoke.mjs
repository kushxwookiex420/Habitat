#!/usr/bin/env node
/**
 * End-to-end acceptance runner for the Ax ↔ Habitat gateway.
 *
 * This is the same sequence ChatGPT must perform: status → submit mission → read it back → acknowledge
 * acceptance → recover bounded work → retrieve the verified result → submit a follow-up → fetch the
 * reconnect heartbeat. It proves the HTTP path; it cannot prove that ChatGPT itself is connected.
 *
 * Usage:
 *   AX_GATEWAY_BASE_URL=https://habitat.example.com \
 *   AX_GATEWAY_TOKEN=axg_... \
 *   node scripts/ax-gateway-smoke.mjs
 *
 * The token is read from the environment so it never appears in a process listing or a log line.
 */

import { randomBytes } from "node:crypto";

const TRIGGER = "AX RECONNECT — HABITAT HEARTBEAT.";

function nonce() {
  return randomBytes(18).toString("base64url");
}

export async function runGatewaySmoke({
  baseUrl,
  token,
  fetchImpl = fetch,
  now = () => Date.now(),
  pollAttempts = 8,
  pollDelayMs = 250,
  prefix = "smoke-" + now().toString(36)
} = {}) {
  if (!baseUrl || !token) return { ok: false, code: "base_url_and_token_required", steps: [] };
  const origin = String(baseUrl).replace(/\/$/, "");
  const steps = [];
  const record = (name, ok, detail = {}) => steps.push({ name, ok, ...detail });

  async function request(method, path, body = null, { idempotencyKey = null } = {}) {
    const headers = { authorization: "Bearer " + token };
    if (body !== null) headers["content-type"] = "application/json";
    if (method !== "GET") {
      headers["x-ax-nonce"] = nonce();
      headers["x-ax-timestamp"] = String(now());
    }
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetchImpl(origin + path, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, payload };
  }

  const status = await request("GET", "/ax/v1/status");
  record("status", status.status === 200 && status.payload?.ok === true, { http: status.status, habitat: status.payload?.habitat || null });
  if (status.status !== 200) return { ok: false, code: "status_failed", steps, triggerSeen: false };

  const objective = "Harmless gateway acceptance check " + prefix + ".";
  const submitted = await request("POST", "/ax/v1/missions", {
    objective,
    acceptanceCriteria: ["A mission record exists and reports its verification state."]
  }, { idempotencyKey: prefix });
  const missionId = submitted.payload?.missionId || null;
  record("submit", submitted.status === 202 && Boolean(missionId), {
    http: submitted.status,
    missionId,
    duplicate: submitted.payload?.duplicate === true,
    delivery: submitted.payload?.delivery || null
  });
  if (!missionId) return { ok: false, code: "submit_failed", steps, triggerSeen: false };

  const acknowledged = await request("POST", "/ax/v1/recover");
  record("acknowledge_and_recover", acknowledged.status === 200, { http: acknowledged.status, code: acknowledged.payload?.code || null });

  let mission = null;
  let verified = false;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    const read = await request("GET", "/ax/v1/missions/" + encodeURIComponent(missionId));
    mission = read.payload?.mission || null;
    if (read.status === 200 && mission) {
      record("retrieve", true, { http: read.status, status: mission.status, delivery: read.payload?.delivery || null });
      if (read.payload?.delivery?.verified === true || ["completed", "failed", "blocked", "approval_required"].includes(mission.status)) { verified = read.payload?.delivery?.verified === true; break; }
    }
    await new Promise(resolve => setTimeout(resolve, pollDelayMs));
  }
  if (!mission) return { ok: false, code: "retrieve_failed", steps, triggerSeen: false, missionId };

  const followUp = await request("POST", "/ax/v1/missions", {
    objective: "Follow-up to " + missionId + ": report the verified outcome.",
    acceptanceCriteria: ["The follow-up is accepted and linked to the prior mission."],
    requirements: ["Reference " + missionId]
  }, { idempotencyKey: prefix + "-follow" });
  record("follow_up", followUp.status === 202 && Boolean(followUp.payload?.missionId), { http: followUp.status, missionId: followUp.payload?.missionId || null });

  const heartbeat = await request("GET", "/ax/v1/heartbeat");
  const triggerSeen = heartbeat.payload?.trigger === TRIGGER;
  record("heartbeat", heartbeat.status === 200 && triggerSeen, {
    http: heartbeat.status,
    trigger: heartbeat.payload?.trigger || null,
    connection: heartbeat.payload?.connection || null,
    queued: Array.isArray(heartbeat.payload?.queued) ? heartbeat.payload.queued.length : null
  });

  const eventIds = (heartbeat.payload?.queued || []).map(event => event.id).filter(Boolean).slice(0, 5);
  let acknowledgedEvents = null;
  if (heartbeat.status === 200 && eventIds.length) {
    const ack = await request("POST", "/ax/v1/heartbeat/ack", { eventIds });
    acknowledgedEvents = { http: ack.status, acknowledged: ack.payload?.acknowledged ?? null };
    record("acknowledge_events", ack.status === 200 || ack.status === 403, acknowledgedEvents);
  }

  const ok = steps.every(step => step.ok) && Boolean(missionId);
  return {
    ok,
    code: ok ? "gateway_smoke_passed" : "gateway_smoke_failed",
    origin,
    missionId,
    followUpMissionId: followUp.payload?.missionId || null,
    missionStatus: mission.status,
    verified,
    triggerSeen,
    delivery: { received: true, executed: mission.status !== "planned", verified },
    acknowledgedEvents,
    steps,
    note: ok
      ? "HTTP path verified from this runner. ChatGPT itself has not been tested by this command."
      : "One or more steps failed; see steps."
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith("ax-gateway-smoke.mjs");
if (isMain) {
  const result = await runGatewaySmoke({
    baseUrl: process.env.AX_GATEWAY_BASE_URL,
    token: process.env.AX_GATEWAY_TOKEN
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
