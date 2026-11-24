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
 * Workforce security v2 over real HTTP.
 *
 * The engine tests prove the rules; these prove the boundary. A worker route must not accept a gateway
 * token, a forged signature, a replayed nonce or another worker's lease, and an uncertain operation must
 * only become retryable through an owner-attested verdict that carries provider proof.
 */

const quiet = { log() {}, warn() {}, error() {} };
const OWNER_SECRET = "route-owner-key-" + "0".repeat(32);
const START = Date.parse("2026-11-24T20:00:00.000Z");
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
  const repository = createWorkforceV1Repository({ query, now: () => new Date(NOW).toISOString() });
  await repository.initialize();
  if (!identitySchema) {
    for (const table of ["habitat_ax_workforce_reassignments", "habitat_ax_workforce_operations", "habitat_ax_workforce_auth_nonces", "habitat_ax_workforce_credentials"]) {
      db.exec("DROP TABLE IF EXISTS " + table);
    }
  }
  const owner = createOwnerAttestation({ secret: OWNER_SECRET, now });
  const engine = createWorkforceV1({ repository, now, log: quiet });

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerAxGateway(app, {
    enabled: true,
    repository: gatewayRepository,
    workforceV1: engine,
    ownerVerifier: owner,
    rateLimit: { windowMs: 60_000, max: 600 },
    now,
    log: quiet
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  server.unref();
  return {
    db,
    engine,
    owner,
    repository,
    gatewayRepository,
    server,
    base: "http://127.0.0.1:" + server.address().port,
    async token(scopes) {
      const issued = await issueClientToken({ repository: gatewayRepository, label: "Dashboard", scopes, now: () => new Date(NOW).toISOString() });
      assert.equal(issued.ok, true, JSON.stringify(issued));
      return issued.token;
    },
    close() {
      server.close();
      db.close();
    }
  };
}

function attestation(owner, { operation, workerId = null, credentialId = null, detail = "" }) {
  const statement = workforceOwnerStatement({ operation, workerId, credentialId, detail });
  return owner.sign({
    operation: "workforce." + operation,
    project: "habitat",
    key: workerId || credentialId || "",
    kind: "workforce",
    statement,
    tags: [],
    confidence: null
  }).attestation;
}

async function api(h, method, path, { bearer = null, body = null, headers = null } = {}) {
  const response = await fetch(h.base + path, {
    method,
    headers: {
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      ...(body !== null && !headers ? { "content-type": "application/json", "x-ax-nonce": "n" + randomBytes(8).toString("hex"), "x-ax-timestamp": String(NOW) } : {}),
      ...(headers || {})
    },
    body: body === null ? undefined : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

function sign(identity, operation, body, { nonce = randomBytes(12).toString("hex"), timestamp = NOW, secret = null } = {}) {
  const signature = signWorkerRequest({
    secret: secret || identity.secret,
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

async function enrol(h, writer, id) {
  const capabilities = ["engineering"];
  const registered = await api(h, "POST", "/ax/v1/workforce/workers", {
    bearer: writer,
    body: {
      id,
      capabilities,
      maxConcurrent: 2,
      attestation: attestation(h.owner, { operation: "worker.register", workerId: id, detail: capabilitiesFingerprint(capabilities) + ":2" })
    }
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const issued = await api(h, "POST", "/ax/v1/workforce/credentials", {
    bearer: writer,
    body: { workerId: id, attestation: attestation(h.owner, { operation: "credential.issue", workerId: id }) }
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.json));
  const parsed = parseWorkerCredential(issued.json.secret);
  assert.ok(parsed);
  return { workerId: id, credentialId: issued.json.credential.credentialId, presented: issued.json.secret, secret: parsed.secret };
}

test("a signed lease lifecycle is owned by the credential's worker, and another worker cannot take it over", async () => {
  NOW = START;
  const h = await harness();
  const writer = await h.token(["workforce:read", "workforce:admin"]);
  const a = await enrol(h, writer, "worker-lease-a");
  const b = await enrol(h, writer, "worker-lease-b");

  const acquireBody = { missionId: "msn_http", taskId: "msn_http.t1", requires: ["engineering"] };
  const acquired = await api(h, "POST", "/ax/v1/workforce/leases/acquire", { body: acquireBody, headers: sign(a, "lease.acquire", acquireBody) });
  assert.equal(acquired.status, 200, JSON.stringify(acquired.json));
  assert.equal(acquired.json.lease.workerId, "worker-lease-a");
  assert.equal(acquired.json.workerId, "worker-lease-a");

  // The body cannot claim another worker: identity comes from the credential.
  const claimedOther = await api(h, "POST", "/ax/v1/workforce/leases/acquire", {
    body: { ...acquireBody, taskId: "msn_http.t2", workerId: "worker-lease-b" },
    headers: sign(a, "lease.acquire", { ...acquireBody, taskId: "msn_http.t2", workerId: "worker-lease-b" })
  });
  assert.equal(claimedOther.json.lease.workerId, "worker-lease-a");

  const stolenRenew = await api(h, "POST", "/ax/v1/workforce/leases/" + acquired.json.lease.leaseId + "/renew", {
    body: {},
    headers: sign(b, "lease.renew", {})
  });
  assert.equal(stolenRenew.status, 403);
  assert.equal(stolenRenew.json.code, "lease_not_owned");

  const renewed = await api(h, "POST", "/ax/v1/workforce/leases/" + acquired.json.lease.leaseId + "/renew", {
    body: { ttlMs: 120_000 },
    headers: sign(a, "lease.renew", { ttlMs: 120_000 })
  });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.json));

  // A replay of the same renewal is refused even though the signature is valid.
  const replayHeaders = sign(a, "lease.renew", { ttlMs: 120_000 });
  const firstReplay = await api(h, "POST", "/ax/v1/workforce/leases/" + acquired.json.lease.leaseId + "/renew", { body: { ttlMs: 120_000 }, headers: replayHeaders });
  assert.equal(firstReplay.status, 200);
  const secondReplay = await api(h, "POST", "/ax/v1/workforce/leases/" + acquired.json.lease.leaseId + "/renew", { body: { ttlMs: 120_000 }, headers: replayHeaders });
  assert.equal(secondReplay.status, 409);
  assert.equal(secondReplay.json.code, "worker_request_replayed");

  // A signature issued for one operation cannot be re-aimed at another.
  const reaimed = await api(h, "POST", "/ax/v1/workforce/leases/" + acquired.json.lease.leaseId + "/release", {
    body: { state: "released" },
    headers: sign(a, "lease.renew", { state: "released" })
  });
  assert.equal(reaimed.status, 401);
  assert.equal(reaimed.json.code, "worker_signature_invalid");

  const released = await api(h, "POST", "/ax/v1/workforce/leases/" + acquired.json.lease.leaseId + "/release", {
    body: { state: "released", reason: "done" },
    headers: sign(a, "lease.release", { state: "released", reason: "done" })
  });
  assert.equal(released.status, 200, JSON.stringify(released.json));
  assert.equal(released.json.lease.state, "released");

  // A forged signature on a heartbeat is refused and leaves no trace in the worker record.
  const forged = await api(h, "POST", "/ax/v1/workforce/workers/worker-lease-a/heartbeat", {
    body: { state: "online" },
    headers: sign(a, "heartbeat", { state: "online" }, { secret: randomBytes(32).toString("base64url") })
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.code, "worker_signature_invalid");

  h.close();
});

test("a revoked credential stops signing immediately, and revocation is owner-attested", async () => {
  NOW = START;
  const h = await harness();
  const writer = await h.token(["workforce:read", "workforce:admin"]);
  const a = await enrol(h, writer, "worker-revoked");

  const unattested = await api(h, "POST", "/ax/v1/workforce/credentials/" + a.credentialId + "/revoke", { bearer: writer, body: {} });
  assert.equal(unattested.status, 403);
  assert.equal(unattested.json.code, "owner_attestation_required");

  const revoked = await api(h, "POST", "/ax/v1/workforce/credentials/" + a.credentialId + "/revoke", {
    bearer: writer,
    body: { reason: "stolen laptop", attestation: attestation(h.owner, { operation: "credential.revoke", credentialId: a.credentialId }) }
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  assert.equal(revoked.json.credential.secretKey, undefined);

  const heartbeat = { state: "online" };
  const refused = await api(h, "POST", "/ax/v1/workforce/workers/worker-revoked/heartbeat", { body: heartbeat, headers: sign(a, "heartbeat", heartbeat) });
  assert.equal(refused.status, 401);
  assert.equal(refused.json.code, "worker_credential_revoked");

  const listed = await api(h, "GET", "/ax/v1/workforce/workers/worker-revoked/credentials", { bearer: writer });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.credentials[0].status, "revoked");
  h.close();
});

test("uncertain operations are inspectable read-only and only owner proof makes them retryable", async () => {
  NOW = START;
  const h = await harness();
  const writer = await h.token(["workforce:read", "workforce:admin"]);
  const a = await enrol(h, writer, "worker-uncertain-http");

  const lease = await h.engine.acquire({ missionId: "msn_http_u", taskId: "msn_http_u.t1", workerId: a.workerId, requires: ["engineering"] });
  assert.equal(lease.ok, true, JSON.stringify(lease));
  const begun = await h.engine.executionBegin({ missionId: "msn_http_u", taskId: "msn_http_u.t1", workerId: a.workerId, attempt: 1, leaseId: lease.leaseId });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  await h.engine.recordOperation({
    idempotencyKey: begun.idempotencyKey,
    missionId: "msn_http_u",
    taskId: "msn_http_u.t1",
    workerId: a.workerId,
    provider: "deploy",
    providerReference: "deploy-77",
    state: "unknown"
  });
  await h.engine.executionComplete({ idempotencyKey: begun.idempotencyKey, state: "uncertain" });

  const listed = await api(h, "GET", "/ax/v1/workforce/uncertain?missionId=msn_http_u", { bearer: writer });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.uncertain[0].providerReference, "deploy-77");
  assert.equal(listed.json.uncertain[0].retryable, false);

  const key = encodeURIComponent(begun.idempotencyKey);
  const inspected = await api(h, "GET", "/ax/v1/workforce/uncertain/" + key, { bearer: writer });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.json));
  assert.equal(inspected.json.readOnly, true);
  assert.equal(inspected.json.retryable, false);
  assert.match(String(inspected.json.detail), /do not retry/i);

  const missingProof = await api(h, "POST", "/ax/v1/workforce/uncertain/" + key + "/reconcile", {
    bearer: writer,
    body: { verdict: "not_executed", attestation: attestation(h.owner, { operation: "reconcile", credentialId: begun.idempotencyKey, detail: "not_executed" }) }
  });
  assert.equal(missingProof.status, 422);
  assert.equal(missingProof.json.code, "reconciliation_proof_required");

  const proved = await api(h, "POST", "/ax/v1/workforce/uncertain/" + key + "/reconcile", {
    bearer: writer,
    body: {
      verdict: "not_executed",
      proof: { evidence: "provider has no operation deploy-77", reference: "deploy-77" },
      attestation: attestation(h.owner, { operation: "reconcile", credentialId: begun.idempotencyKey, detail: "not_executed" })
    }
  });
  assert.equal(proved.status, 200, JSON.stringify(proved.json));
  assert.equal(proved.json.retryable, true);
  assert.equal(proved.json.decision, "requeue");

  // The verdict is bound to the operation and to the exact verdict: the same signature cannot claim success.
  const rebound = await api(h, "POST", "/ax/v1/workforce/uncertain/" + key + "/reconcile", {
    bearer: writer,
    body: {
      verdict: "confirmed_success",
      proof: { evidence: "reused" },
      attestation: attestation(h.owner, { operation: "reconcile", credentialId: begun.idempotencyKey, detail: "not_executed" })
    }
  });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.json.code, "owner_attestation_invalid");

  const queue = await api(h, "GET", "/ax/v1/workforce/recovery/queue", { bearer: writer });
  assert.equal(queue.status, 200);
  const history = await api(h, "GET", "/ax/v1/workforce/reassignments?missionId=msn_http_u", { bearer: writer });
  assert.equal(history.status, 200);
  assert.ok(history.json.items.some((item) => item.reason === "reconciliation:not_executed"), JSON.stringify(history.json));
  h.close();
});

test("without migration 0019 the boundary refuses signed worker traffic instead of trusting it", async () => {
  NOW = START;
  const h = await harness({ identitySchema: false });
  const writer = await h.token(["workforce:read", "workforce:admin"]);
  const fake = {
    workerId: "worker-legacy",
    credentialId: "wcr_deadbeefdeadbeef",
    presented: "axw_wcr_deadbeefdeadbeef_" + "a".repeat(43),
    secret: "a".repeat(43)
  };
  const body = { state: "online" };
  const response = await api(h, "POST", "/ax/v1/workforce/workers/worker-legacy/heartbeat", { body, headers: sign(fake, "heartbeat", body) });
  assert.equal(response.status, 503);
  assert.equal(response.json.code, "workforce_identity_schema_missing");

  const status = await api(h, "GET", "/ax/v1/workforce", { bearer: writer });
  assert.equal(status.status, 200);
  assert.equal(status.json.workforce.identity.ready, false);
  h.close();
});
