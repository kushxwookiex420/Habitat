import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { createWorkforceRepository } from "../d1-workforce-repository.mjs";
import { createMissionRepository } from "../d1-mission-repository.mjs";
import { createGatewayRepository } from "../d1-gateway-repository.mjs";
import { runGatewaySmoke } from "../scripts/ax-gateway-smoke.mjs";
import { createDurableWorkforce } from "../ax-durable-workforce.mjs";
import { createMissionRuntime } from "../ax-mission-runtime.mjs";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";
import { issueClientToken, registerAxGateway } from "../ax-gateway.mjs";
import { createHeartbeatRepository } from "../d1-heartbeat-repository.mjs";
import { createHeartbeatMonitor } from "../ax-heartbeat.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const NOW = Date.parse("2026-11-24T18:00:00.000Z");
const now = () => NOW;
const SECRET = "owner-attestation-test-secret-0123456789";

function queryFrom(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
}

const executors = {
  "coder-adapter": async ({ task }) => ({ result: { status: "completed", evidence: ["done " + task.id], tests: { ran: 1, passed: 1, failed: 0 } } }),
  "verifier-adapter": async () => ({ ok: true, evidence: ["independent 1/1"], tests: { ran: 1, passed: 1, failed: 0 } })
};

async function harness({ gatewayEnabled = true, rateLimit = { windowMs: 60_000, max: 60 } } = {}) {
  const db = new DatabaseSync(":memory:");
  const query = queryFrom(db);
  const missionStore = createMissionRepository({ query, now });
  await missionStore.initialize();
  const workforceRepo = createWorkforceRepository({ query, now });
  const workforce = createDurableWorkforce({
    repository: workforceRepo,
    adapters: [
      { id: "coder-adapter", kind: "coding", execute: async () => ({}), health: async () => ({ status: "healthy" }) },
      { id: "verifier-adapter", kind: "verification", execute: async () => ({}) }
    ],
    now,
    log: quiet
  });
  await workforce.hydrate();
  await workforce.registerAgent({ id: "coder.one", specialty: "coding", adapterId: "coder-adapter", capabilities: ["coding", "tests"], permissions: { allowed: ["coding", "tests"], denied: [] }, availability: { maxConcurrent: 2 } });
  await workforce.registerAgent({ id: "verifier.one", specialty: "verification", adapterId: "verifier-adapter", capabilities: ["verification"], permissions: { allowed: ["verification"], denied: [] }, availability: { maxConcurrent: 2 } });

  const gatewayRepo = createGatewayRepository({ query, now });
  await gatewayRepo.initialize();
  const ownerVerifier = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const heartbeatRepository = createHeartbeatRepository({ query, now });
  await heartbeatRepository.initialize();
  const heartbeat = createHeartbeatMonitor({
    repository: heartbeatRepository,
    missionRuntime: { missions: async ({ limit } = {}) => missionRuntime.missions({ limit }) },
    statusProvider: async () => ({ version: "0.8.6", commit: "test", components: { identity: { name: "Ax" } } }),
    now,
    log: quiet
  });
  const missionRuntime = createMissionRuntime({
    env: { HABITAT_MISSIONS_ENABLED: "true", CLOUDFLARE_ACCOUNT_ID: "a", HABITAT_D1_DATABASE_ID: "d", HABITAT_D1_API_TOKEN: "t" },
    query,
    repository: missionStore,
    workforce,
    executors,
    verifierAgentId: "verifier.one",
    ownerVerifier,
    now: () => new Date(NOW).toISOString(),
    log: quiet
  });
  await missionRuntime.initialize();

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerAxGateway(app, {
    enabled: gatewayEnabled,
    repository: gatewayRepo,
    missionRuntime,
    heartbeat,
    ownerVerifier,
    rateLimit,
    now,
    log: quiet,
    statusProvider: async () => ({
      version: "0.8.6",
      commit: "test",
      uptimeSeconds: 1,
      components: {
        identity: { state: "persistent", name: "Ax", digest: "a".repeat(64), persisted: true, providerIndependent: true },
        workforce: { state: "disabled", enabled: false },
        missions: { state: "running", enabled: true },
        storage: { state: "ready" },
        workers: { execution: { state: "unavailable" } }
      }
    })
  });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  // A failed assertion must not keep the runner alive waiting for a socket that is never closed.
  server.unref();
  const base = "http://127.0.0.1:" + server.address().port;
  return { db, query, gatewayRepo, missionRuntime, heartbeat, heartbeatRepository, ownerVerifier, server, base };
}

async function client(harness, scopes = ["status:read", "missions:read", "missions:write", "missions:approve", "recovery:write", "events:write"], expiresAt = null) {
  const issued = await issueClientToken({ repository: harness.gatewayRepo, label: "ChatGPT", scopes, expiresAt, now: () => new Date(NOW).toISOString() });
  assert.equal(issued.ok, true);
  return issued;
}

function nonce() {
  return { "x-ax-nonce": "n" + NOW.toString(36) + Math.random().toString(36).slice(2), "x-ax-timestamp": String(NOW) };
}

test("the gateway is disabled by default and returns 503 without checking a token", async () => {
  const h = await harness({ gatewayEnabled: false });
  const response = await fetch(h.base + "/ax/v1/status");
  assert.equal(response.status, 503);
  assert.equal((await fetch(h.base + "/ax/v1/openapi.json")).status, 503);
  const body = await response.json();
  assert.equal(body.code, "gateway_disabled");
  h.server.close();
  h.db.close();
});

test("authentication rejects missing, malformed and unknown tokens without leaking details", async () => {
  const h = await harness();
  assert.equal((await fetch(h.base + "/ax/v1/status")).status, 401);
  assert.equal((await fetch(h.base + "/ax/v1/status", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await fetch(h.base + "/ax/v1/status", { headers: { authorization: "Bearer axg_gw-abcdef_" + "x".repeat(40) } })).status, 401);
  h.server.close();
  h.db.close();
});

test("scopes are least-privilege: a read-only client cannot submit a mission", async () => {
  const h = await harness();
  const issued = await client(h, ["status:read"]);
  const response = await fetch(h.base + "/ax/v1/missions", {
    method: "POST",
    headers: { authorization: "Bearer " + issued.token, "content-type": "application/json", ...nonce() },
    body: JSON.stringify({ objective: "Do a thing", acceptanceCriteria: ["It is done"] })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "gateway_scope_required");
  h.server.close();
  h.db.close();
});

test("status is readable and contains no credential", async () => {
  const h = await harness();
  const issued = await client(h, ["status:read"]);
  const response = await fetch(h.base + "/ax/v1/status", { headers: { authorization: "Bearer " + issued.token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.identity.name, "Ax");
  assert.equal(body.delivery.received, true);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /axg_|Bearer|owner-attestation-test/);
  h.server.close();
  h.db.close();
});

test("ChatGPT flow: submit mission, acknowledge, recover, retrieve verified result", async () => {
  const h = await harness();
  const issued = await client(h);
  const headers = { authorization: "Bearer " + issued.token, "content-type": "application/json" };

  const submitted = await fetch(h.base + "/ax/v1/missions", {
    method: "POST",
    headers: { ...headers, ...nonce(), "idempotency-key": "chatgpt-test-1" },
    body: JSON.stringify({ objective: "Add a health check endpoint.", acceptanceCriteria: ["Health returns 200"] })
  });
  assert.equal(submitted.status, 202);
  const accepted = await submitted.json();
  assert.equal(accepted.delivery.received, true);
  assert.equal(accepted.delivery.executed, false);
  assert.match(accepted.missionId, /^msn_/);

  const before = await (await fetch(h.base + "/ax/v1/missions/" + accepted.missionId, { headers })).json();
  assert.equal(before.delivery.executed, false);
  assert.equal(before.mission.status, "planned");

  const recovered = await fetch(h.base + "/ax/v1/recover", { method: "POST", headers: { ...headers, ...nonce() } });
  assert.equal(recovered.status, 200);

  const after = await (await fetch(h.base + "/ax/v1/missions/" + accepted.missionId, { headers })).json();
  assert.equal(after.mission.status, "completed");
  assert.equal(after.delivery.verified, true);
  assert.equal(after.mission.tasks[0].status, "completed");

  const list = await (await fetch(h.base + "/ax/v1/missions", { headers })).json();
  assert.equal(list.count, 1);
  const audit = await (await fetch(h.base + "/ax/v1/audit", { headers })).json();
  assert.ok(audit.entries.some(entry => entry.path === "/ax/v1/missions" && entry.status === 202));
  h.server.close();
  h.db.close();
});

test("a duplicate submission with the same Idempotency-Key returns the same mission", async () => {
  const h = await harness();
  const issued = await client(h);
  const headers = { authorization: "Bearer " + issued.token, "content-type": "application/json" };
  const send = () => fetch(h.base + "/ax/v1/missions", {
    method: "POST",
    headers: { ...headers, ...nonce(), "idempotency-key": "same-request" },
    body: JSON.stringify({ objective: "Duplicate test", acceptanceCriteria: ["Once only"] })
  }).then(response => response.json());
  const first = await send();
  const second = await send();
  assert.equal(second.missionId, first.missionId);
  assert.equal(second.duplicate, true);
  h.server.close();
  h.db.close();
});

test("a replayed nonce is refused even when the body changes", async () => {
  const h = await harness();
  const issued = await client(h);
  const reuse = nonce();
  const headers = { authorization: "Bearer " + issued.token, "content-type": "application/json", ...reuse };
  const first = await fetch(h.base + "/ax/v1/missions", {
    method: "POST", headers, body: JSON.stringify({ objective: "First", acceptanceCriteria: ["a"] })
  });
  assert.equal(first.status, 202);
  const second = await fetch(h.base + "/ax/v1/missions", {
    method: "POST", headers, body: JSON.stringify({ objective: "Second", acceptanceCriteria: ["b"] })
  });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "gateway_nonce_replayed");
  h.server.close();
  h.db.close();
});

test("POST without a nonce or with a stale timestamp is rejected", async () => {
  const h = await harness();
  const issued = await client(h);
  const headers = { authorization: "Bearer " + issued.token, "content-type": "application/json" };
  const noNonce = await fetch(h.base + "/ax/v1/missions", { method: "POST", headers, body: JSON.stringify({ objective: "x", acceptanceCriteria: ["y"] }) });
  assert.equal(noNonce.status, 400);
  const stale = await fetch(h.base + "/ax/v1/missions", {
    method: "POST",
    headers: { ...headers, ...nonce(), "x-ax-timestamp": String(NOW - 60 * 60 * 1000) },
    body: JSON.stringify({ objective: "x", acceptanceCriteria: ["y"] })
  });
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).code, "gateway_timestamp_invalid");
  h.server.close();
  h.db.close();
});

test("expired and revoked clients are refused", async () => {
  const h = await harness();
  const expired = await client(h, ["status:read"], new Date(NOW - 1000).toISOString());
  assert.equal((await fetch(h.base + "/ax/v1/status", { headers: { authorization: "Bearer " + expired.token } })).status, 401);

  const live = await client(h, ["status:read"]);
  await h.gatewayRepo.revokeClient(live.clientId, { at: new Date(NOW).toISOString(), reason: "test" });
  const response = await fetch(h.base + "/ax/v1/status", { headers: { authorization: "Bearer " + live.token } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "gateway_client_revoked");
  h.server.close();
  h.db.close();
});

test("rate limiting is per client", async () => {
  const h = await harness({ rateLimit: { windowMs: 60_000, max: 2 } });
  const issued = await client(h, ["status:read"]);
  const headers = { authorization: "Bearer " + issued.token };
  assert.equal((await fetch(h.base + "/ax/v1/status", { headers })).status, 200);
  assert.equal((await fetch(h.base + "/ax/v1/status", { headers })).status, 200);
  assert.equal((await fetch(h.base + "/ax/v1/status", { headers })).status, 429);
  h.server.close();
  h.db.close();
});

test("approval requires a signed owner attestation and cannot be self-issued by the client", async () => {
  const h = await harness();
  const issued = await client(h);
  const headers = { authorization: "Bearer " + issued.token, "content-type": "application/json" };

  const submitted = await (await fetch(h.base + "/ax/v1/missions", {
    method: "POST",
    headers: { ...headers, ...nonce() },
    body: JSON.stringify({ objective: "Deploy the service to production.", acceptanceCriteria: ["It is deployed"] })
  })).json();
  await fetch(h.base + "/ax/v1/recover", { method: "POST", headers: { ...headers, ...nonce() } });
  const pending = await (await fetch(h.base + "/ax/v1/missions/" + submitted.missionId, { headers })).json();
  assert.equal(pending.mission.status, "approval_required");

  const unsigned = await fetch(h.base + "/ax/v1/missions/" + submitted.missionId + "/decision", {
    method: "POST", headers: { ...headers, ...nonce() }, body: JSON.stringify({ decision: "approve" })
  });
  assert.equal(unsigned.status, 403);

  const signed = h.ownerVerifier.sign({
    operation: "mission.approve", project: "habitat", key: submitted.missionId,
    kind: "approve", statement: "Checked the evidence.", tags: [], confidence: null
  });
  const approved = await fetch(h.base + "/ax/v1/missions/" + submitted.missionId + "/decision", {
    method: "POST",
    headers: { ...headers, ...nonce() },
    body: JSON.stringify({ decision: "approve", attestation: signed.attestation, reason: "Checked the evidence." })
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "completed");
  h.server.close();
  h.db.close();
});

test("the heartbeat endpoint returns the reconnect trigger with current context", async () => {
  const h = await harness();
  const issued = await client(h, ["status:read"]);
  const response = await fetch(h.base + "/ax/v1/heartbeat", { headers: { authorization: "Bearer " + issued.token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.trigger, "AX RECONNECT — HABITAT HEARTBEAT.");
  assert.equal(body.delivery.received, true);
  assert.equal(body.delivery.executed, false);
  assert.ok(Array.isArray(body.missions.active));
  assert.ok(Array.isArray(body.queued));
  h.server.close();
  h.db.close();
});

test("heartbeat acknowledgement needs its own scope and is idempotent", async () => {
  const h = await harness();
  await h.missionRuntime.intake({ objective: "Heartbeat ack test", acceptanceCriteria: ["Event queued"] }, { idempotencyKey: "heartbeat-ack" });
  await h.heartbeat.beat();
  const pending = await h.heartbeatRepository.pendingEvents({});
  assert.ok(pending.length >= 1);
  const ids = [pending[0].id];

  const reader = await client(h, ["status:read"]);
  const denied = await fetch(h.base + "/ax/v1/heartbeat/ack", {
    method: "POST",
    headers: { authorization: "Bearer " + reader.token, "content-type": "application/json", ...nonce() },
    body: JSON.stringify({ eventIds: ids })
  });
  assert.equal(denied.status, 403);

  const writer = await client(h, ["events:write"]);
  const first = await fetch(h.base + "/ax/v1/heartbeat/ack", {
    method: "POST",
    headers: { authorization: "Bearer " + writer.token, "content-type": "application/json", ...nonce() },
    body: JSON.stringify({ eventIds: ids })
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).acknowledged, 1);
  const second = await fetch(h.base + "/ax/v1/heartbeat/ack", {
    method: "POST",
    headers: { authorization: "Bearer " + writer.token, "content-type": "application/json", ...nonce() },
    body: JSON.stringify({ eventIds: ids })
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  h.server.close();
  h.db.close();
});

test("the acceptance runner performs the ChatGPT sequence end to end over HTTP", async () => {
  const h = await harness();
  const issued = await client(h);
  const result = await runGatewaySmoke({ baseUrl: h.base, token: issued.token, now: () => NOW, pollDelayMs: 5, pollAttempts: 10 });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.equal(result.triggerSeen, true);
  assert.equal(result.missionStatus, "completed");
  assert.equal(result.verified, true);
  assert.ok(result.followUpMissionId);
  assert.equal(result.steps.filter(step => !step.ok).length, 0);
  h.server.close();
  h.db.close();
});

test("rate limiting is shared across gateway repository instances on one database", async () => {
  const h = await harness();
  const at = NOW;
  const repoA = createGatewayRepository({ query: h.query, now: () => new Date(at).toISOString() });
  const repoB = createGatewayRepository({ query: h.query, now: () => new Date(at).toISOString() });
  assert.equal((await repoA.consumeRateLimit({ clientId: "shared-client", windowMs: 60_000, max: 2, at })).ok, true);
  assert.equal((await repoB.consumeRateLimit({ clientId: "shared-client", windowMs: 60_000, max: 2, at })).ok, true);
  const third = await repoB.consumeRateLimit({ clientId: "shared-client", windowMs: 60_000, max: 2, at });
  assert.equal(third.ok, false);
  assert.equal(third.shared, true);
  assert.equal(third.count, 3);
  h.server.close();
  h.db.close();
});

test("the OpenAPI document is served for Action import", async () => {
  const h = await harness();
  const response = await fetch(h.base + "/ax/v1/openapi.json");
  assert.equal(response.status, 200);
  const spec = await response.json();
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/ax/v1/missions"]);
  h.server.close();
  h.db.close();
});
