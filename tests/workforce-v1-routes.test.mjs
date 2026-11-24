import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { createGatewayRepository } from "../d1-gateway-repository.mjs";
import { issueClientToken, registerAxGateway } from "../ax-gateway.mjs";
import { createWorkforceV1Repository } from "../d1-workforce-v1-repository.mjs";
import { createWorkforceV1 } from "../ax-workforce-v1.mjs";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";
import {
  capabilitiesFingerprint,
  parseWorkerCredential,
  signWorkerRequest,
  workforceOwnerStatement
} from "../ax-worker-auth.mjs";

/**
 * Habitat workforce contract over real HTTP.
 *
 * The routes are the dashboard's only source of truth, so what is checked here is the shape an operator
 * will rely on: status totals, worker details, live assignments, heartbeat ages, recovery history and the
 * mission-to-worker link. Registration and revocation are owner-attested; heartbeats and every lease
 * operation are signed by the worker's own credential.
 */

const quiet = { log() {}, warn() {}, error() {} };
const OWNER_SECRET = "gateway-test-owner-key-" + "0".repeat(24);
const START = Date.parse("2026-11-24T18:00:00.000Z");
let NOW = START;
const now = () => NOW;

function sqliteQuery(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    if (/\breturning\b/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
}

async function harness({ identitySchema = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const query = sqliteQuery(db);
  const gatewayRepository = createGatewayRepository({ query, now: () => new Date(NOW).toISOString() });
  await gatewayRepository.initialize();
  const leasesRepository = createWorkforceV1Repository({ query, now: () => new Date(NOW).toISOString() });
  await leasesRepository.initialize();
  if (!identitySchema) {
    for (const table of ["habitat_ax_workforce_reassignments", "habitat_ax_workforce_operations", "habitat_ax_workforce_auth_nonces", "habitat_ax_workforce_credentials"]) {
      db.exec("DROP TABLE IF EXISTS " + table);
    }
  }
  const owner = createOwnerAttestation({ secret: OWNER_SECRET, now });
  const leases = createWorkforceV1({ repository: leasesRepository, now, log: quiet });

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerAxGateway(app, {
    enabled: true,
    repository: gatewayRepository,
    workforceV1: leases,
    ownerVerifier: owner,
    rateLimit: { windowMs: 60_000, max: 600 },
    now,
    log: quiet,
    statusProvider: async () => ({ version: "test", components: { workforce: { state: "running" } } })
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  server.unref();
  return { db, leases, gatewayRepository, owner, server, base: "http://127.0.0.1:" + server.address().port };
}

async function token(h, scopes) {
  const issued = await issueClientToken({ repository: h.gatewayRepository, label: "Dashboard", scopes, now: () => new Date(NOW).toISOString() });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return issued.token;
}

function attestation(owner, { operation, workerId = null, credentialId = null, detail = "" }) {
  const statement = workforceOwnerStatement({ operation, workerId, credentialId, detail });
  const signed = owner.sign({
    operation: "workforce." + operation,
    project: "habitat",
    key: workerId || credentialId || "",
    kind: "workforce",
    statement,
    tags: [],
    confidence: null
  });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  return signed.attestation;
}

function signedWorkerHeaders(identity, operation, body) {
  const timestamp = NOW;
  const nonce = randomBytes(12).toString("hex");
  const signature = signWorkerRequest({
    secret: identity.secret,
    operation,
    workerId: identity.workerId,
    credentialId: identity.credentialId,
    nonce,
    timestamp,
    body
  }).signature;
  return {
    "content-type": "application/json",
    "x-ax-worker-credential": identity.presented,
    "x-ax-signature": signature,
    "x-ax-nonce": nonce,
    "x-ax-timestamp": String(timestamp)
  };
}

async function call(h, method, path, { bearer = null, body = null, headers = null } = {}) {
  const response = await fetch(h.base + path, {
    method,
    headers: {
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      ...(body !== null && method !== "GET" && !headers ? { "content-type": "application/json", "x-ax-nonce": "n" + randomBytes(8).toString("hex"), "x-ax-timestamp": String(NOW) } : {}),
      ...(headers || {})
    },
    body: body === null ? undefined : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

async function enrol(h, writer, id) {
  const capabilities = ["engineering", "repo_analysis"];
  const registered = await call(h, "POST", "/ax/v1/workforce/workers", {
    bearer: writer,
    body: {
      id,
      label: "Engineering " + id,
      specialty: "engineering",
      capabilities,
      maxConcurrent: 2,
      attestation: attestation(h.owner, {
        operation: "worker.register",
        workerId: id,
        detail: capabilitiesFingerprint(capabilities) + ":2"
      })
    }
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const issued = await call(h, "POST", "/ax/v1/workforce/credentials", {
    bearer: writer,
    body: { workerId: id, attestation: attestation(h.owner, { operation: "credential.issue", workerId: id }) }
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.json));
  const parsed = parseWorkerCredential(issued.json.secret);
  assert.ok(parsed);
  return {
    workerId: id,
    credentialId: issued.json.credential.credentialId,
    presented: issued.json.secret,
    secret: parsed.secret
  };
}

test("every workforce route refuses an unauthenticated caller", async () => {
  const h = await harness();
  for (const route of ["/ax/v1/workforce", "/ax/v1/workforce/workers", "/ax/v1/workforce/assignments", "/ax/v1/workforce/health", "/ax/v1/workforce/recovery", "/ax/v1/workforce/uncertain", "/ax/v1/workforce/recovery/queue", "/ax/v1/workforce/reassignments"]) {
    const response = await call(h, "GET", route);
    assert.equal(response.status, 401, route);
    assert.equal(response.json.code, "gateway_token_required");
  }
  h.server.close();
  h.db.close();
});

test("registration needs the admin scope and an owner attestation that matches the request", async () => {
  const h = await harness();
  const reader = await token(h, ["workforce:read"]);
  const writer = await token(h, ["workforce:read", "workforce:admin"]);
  const body = { id: "worker-a", capabilities: ["engineering"], maxConcurrent: 1 };

  const forbidden = await call(h, "POST", "/ax/v1/workforce/workers", { bearer: reader, body: { ...body, attestation: attestation(h.owner, { operation: "worker.register", workerId: "worker-a", detail: capabilitiesFingerprint(["engineering"]) + ":1" }) } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, "gateway_scope_required");

  const unattested = await call(h, "POST", "/ax/v1/workforce/workers", { bearer: writer, body });
  assert.equal(unattested.status, 403);
  assert.equal(unattested.json.code, "owner_attestation_required");

  // A signature for different capabilities cannot be reused to register a wider worker.
  const widened = await call(h, "POST", "/ax/v1/workforce/workers", {
    bearer: writer,
    body: {
      id: "worker-a",
      capabilities: ["engineering", "deploy"],
      maxConcurrent: 1,
      attestation: attestation(h.owner, { operation: "worker.register", workerId: "worker-a", detail: capabilitiesFingerprint(["engineering"]) + ":1" })
    }
  });
  // The gateway re-derives the statement from the body, so the mismatch is caught before the engine runs.
  assert.equal(widened.status, 403);
  assert.equal(widened.json.code, "owner_attestation_invalid");

  const registered = await call(h, "POST", "/ax/v1/workforce/workers", {
    bearer: writer,
    body: { ...body, attestation: attestation(h.owner, { operation: "worker.register", workerId: "worker-a", detail: capabilitiesFingerprint(["engineering"]) + ":1" }) }
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  assert.equal(registered.json.worker.id, "worker-a");
  assert.equal(registered.json.created, true);
  assert.match(String(registered.json.authorizedBy), /^owner:/);
  h.server.close();
  h.db.close();
});

test("registration, signed heartbeats, status, assignments, recovery and mission links are served with the right scopes", async () => {
  NOW = START;
  const h = await harness();
  const reader = await token(h, ["workforce:read"]);
  const writer = await token(h, ["workforce:read", "workforce:admin"]);
  const identity = await enrol(h, writer, "worker-a");

  const worker = await call(h, "GET", "/ax/v1/workforce/workers/worker-a", { bearer: reader });
  assert.equal(worker.status, 200);
  assert.equal(worker.json.worker.health.status, "healthy");
  assert.equal(worker.json.assignments.length, 0);
  assert.equal(worker.json.credentials.length, 1);
  assert.equal(worker.json.credentials[0].secretKey, undefined, "the verification key is never returned by a read");

  const unknown = await call(h, "GET", "/ax/v1/workforce/workers/worker-missing", { bearer: reader });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, "worker_unknown");

  const lease = await h.leases.acquire({ taskId: "msn_dash.t1", missionId: "msn_dash", workerId: "worker-a", requires: ["engineering"] });
  assert.equal(lease.ok, true);

  const status = await call(h, "GET", "/ax/v1/workforce", { bearer: reader });
  assert.equal(status.status, 200);
  assert.equal(status.json.workforce.workers.total, 1);
  assert.equal(status.json.workforce.activeAssignments.count, 1);
  assert.equal(status.json.workforce.activeAssignments.items[0].missionId, "msn_dash");
  assert.equal(status.json.workforce.migration, "0018_ax_workforce_v1");
  assert.equal(status.json.workforce.identityMigration, "0019_ax_workforce_identity");
  assert.equal(status.json.workforce.identity.ready, true);
  assert.equal(status.json.workforce.leases.active, 1);

  const assignments = await call(h, "GET", "/ax/v1/workforce/assignments", { bearer: reader });
  assert.equal(assignments.json.count, 1);
  assert.equal(assignments.json.assignments[0].workerId, "worker-a");

  const linked = await call(h, "GET", "/ax/v1/workforce/missions/msn_dash", { bearer: reader });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.json.workers, ["worker-a"]);
  assert.equal(linked.json.tasks[0].taskId, "msn_dash.t1");
  assert.equal(linked.json.tasks[0].active, true);

  // The heartbeat is signed by the worker itself, and the dashboard reads the derived health.
  const beatBody = { state: "online" };
  const beaten = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/heartbeat", {
    body: beatBody,
    headers: signedWorkerHeaders(identity, "heartbeat", beatBody)
  });
  assert.equal(beaten.status, 200, JSON.stringify(beaten.json));
  assert.equal(beaten.json.health.status, "healthy");
  assert.equal(beaten.json.workerId, "worker-a");

  NOW = START + 5 * 60_000;
  const stale = await call(h, "GET", "/ax/v1/workforce/health", { bearer: reader });
  assert.equal(stale.status, 200);
  assert.equal(stale.json.health.unresponsiveWorkers, 1);
  assert.equal(stale.json.workers.byHealth.stalled, 1);
  assert.equal(stale.json.heartbeat[0].workerId, "worker-a");
  assert.equal(stale.json.heartbeat[0].status, "stalled");

  // Recovery history is queryable per mission and survives the sweep.
  const swept = await h.leases.expireAbandonedLeases();
  assert.equal(swept.ok, true);
  const recovery = await call(h, "GET", "/ax/v1/workforce/recovery?missionId=msn_dash", { bearer: reader });
  assert.equal(recovery.status, 200);
  assert.ok(recovery.json.events.some((event) => event.kind === "lease.expired"), JSON.stringify(recovery.json));

  const queue = await call(h, "GET", "/ax/v1/workforce/recovery/queue", { bearer: reader });
  assert.equal(queue.status, 200);
  assert.equal(queue.json.items.some((item) => item.missionId === "msn_dash" && item.decision === "requeue"), true, JSON.stringify(queue.json));
  const reassigned = await call(h, "GET", "/ax/v1/workforce/reassignments?missionId=msn_dash", { bearer: reader });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.json.items[0].reason, "lease_expired");

  // A stalled worker is told to come back: a signed heartbeat restores availability before the next claim.
  const recalled = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/heartbeat", {
    body: beatBody,
    headers: signedWorkerHeaders(identity, "heartbeat", beatBody)
  });
  assert.equal(recalled.status, 200);
  assert.equal(recalled.json.health.status, "healthy");

  // Deregistration is refused while a live lease exists, and allowed with force; it revokes credentials.
  const second = await h.leases.acquire({ taskId: "msn_dash.t2", missionId: "msn_dash", workerId: "worker-a", requires: ["engineering"] });
  assert.equal(second.ok, true, JSON.stringify(second));
  const guarded = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/deregister", {
    bearer: writer,
    body: { reason: "maintenance", attestation: attestation(h.owner, { operation: "worker.revoke", workerId: "worker-a" }) }
  });
  assert.equal(guarded.status, 409);
  assert.equal(guarded.json.code, "worker_has_active_leases");
  const forced = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/deregister", {
    bearer: writer,
    body: { reason: "retired", force: true, attestation: attestation(h.owner, { operation: "worker.revoke", workerId: "worker-a" }) }
  });
  assert.equal(forced.status, 200, JSON.stringify(forced.json));
  assert.equal(forced.json.worker.state, "deregistered");
  assert.equal(forced.json.credentialsRevoked, 1);

  const afterRetirement = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/heartbeat", {
    body: beatBody,
    headers: signedWorkerHeaders(identity, "heartbeat", beatBody)
  });
  assert.equal(afterRetirement.status, 401);
  assert.equal(afterRetirement.json.code, "worker_credential_revoked");

  // The audit names the authenticated worker, not the client token.
  const auditor = await token(h, ["status:read"]);
  const audit = await call(h, "GET", "/ax/v1/audit?limit=20", { bearer: auditor });
  assert.equal(audit.status, 200);
  assert.ok(audit.json.entries.some((entry) => entry.detail?.workerId === "worker-a"), JSON.stringify(audit.json.entries.slice(0, 3)));

  h.server.close();
  h.db.close();
});

test("a worker whose signed heartbeat names a different worker is refused", async () => {
  const h = await harness();
  const writer = await token(h, ["workforce:read", "workforce:admin"]);
  const a = await enrol(h, writer, "worker-identity-a");
  const b = await enrol(h, writer, "worker-identity-b");
  const body = { state: "online" };

  const mismatch = await call(h, "POST", "/ax/v1/workforce/workers/worker-identity-b/heartbeat", {
    body,
    headers: signedWorkerHeaders(a, "heartbeat", body)
  });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.code, "worker_identity_mismatch");
  assert.equal(mismatch.json.authenticatedWorkerId, "worker-identity-a");

  const own = await call(h, "POST", "/ax/v1/workforce/workers/worker-identity-b/heartbeat", {
    body,
    headers: signedWorkerHeaders(b, "heartbeat", body)
  });
  assert.equal(own.status, 200);
  h.server.close();
  h.db.close();
});

test("the workforce routes answer 503 when no lease layer is attached", async () => {
  const db = new DatabaseSync(":memory:");
  const query = sqliteQuery(db);
  const gatewayRepository = createGatewayRepository({ query, now });
  await gatewayRepository.initialize();
  const app = express();
  app.use(express.json());
  registerAxGateway(app, { enabled: true, repository: gatewayRepository, workforceV1: null, now, log: quiet });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  server.unref();
  const base = "http://127.0.0.1:" + server.address().port;
  const issued = await issueClientToken({ repository: gatewayRepository, label: "Dashboard", scopes: ["workforce:read"], now: () => new Date(NOW).toISOString() });
  const response = await fetch(base + "/ax/v1/workforce", { headers: { authorization: "Bearer " + issued.token } });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "workforce_leases_not_attached");
  server.close();
  db.close();
});
