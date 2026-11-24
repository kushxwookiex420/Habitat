import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
 * Workforce security and recovery v2, adversarial.
 *
 * Every test here is a thing an attacker or a crash can actually do: sign a statement that was never
 * issued, reuse a request, take a credential from another worker, revoke a key mid-flight, or leave an
 * external operation in the one state where a retry would duplicate a real effect.
 */

const quiet = { log() {}, warn() {}, error() {} };
const OWNER_SECRET = "test-owner-key-" + "0".repeat(32);

function sqliteQuery(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    if (/\breturning\b/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
}

function clock(start = "2026-11-24T00:00:00.000Z") {
  let ms = Date.parse(start);
  return {
    now: () => ms,
    iso: () => new Date(ms).toISOString(),
    advance: (delta) => { ms += delta; }
  };
}

async function layer(options = {}) {
  const db = options.db || new DatabaseSync(":memory:");
  const tick = options.tick || clock();
  const query = options.query || sqliteQuery(db);
  const repository = createWorkforceV1Repository({ query, now: tick.iso });
  await repository.initialize();
  const owner = options.owner || createOwnerAttestation({ secret: OWNER_SECRET, now: tick.now });
  const engine = createWorkforceV1({ repository, now: tick.now, log: quiet, ...(options.engine || {}) });
  return { db, tick, query, repository, owner, engine };
}

async function worker(engine, id, overrides = {}) {
  const registered = await engine.registerWorker({
    id,
    label: id,
    specialty: "engineering",
    capabilities: ["engineering"],
    maxConcurrent: 1,
    ...overrides
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return registered.worker;
}

/** A worker that has a credential, the way a real executor would after an out-of-band enrolment. */
const OWNER = Object.freeze({ ok: true, by: "owner:test" });

async function enrolled(engine, owner, id) {
  await worker(engine, id);
  const issued = await engine.issueCredential({ workerId: id, label: id + " key", authorization: OWNER });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const parsed = parseWorkerCredential(issued.secret);
  assert.ok(parsed, "the issued credential parses back to its id and secret");
  return { workerId: id, presented: issued.secret, secret: parsed.secret, credentialId: issued.credential.credentialId };
}

function nonce() {
  return randomBytes(16).toString("hex");
}

/** Sign and authenticate one request in the same step, so a test can vary exactly one field. */
async function authenticate(engine, identity, operation, { body = {}, tick, secret = null, nonceValue = null, timestamp = null, workerId = null } = {}) {
  const at = timestamp ?? tick.now();
  const used = nonceValue || nonce();
  const signedRequest = signWorkerRequest({
    secret: secret || identity.secret,
    operation,
    workerId: workerId || identity.workerId,
    credentialId: identity.credentialId,
    nonce: used,
    timestamp: at,
    body
  });
  return engine.authenticateWorkerRequest({
    presented: identity.presented,
    operation,
    nonce: used,
    timestamp: at,
    signature: signedRequest.signature,
    body
  });
}

test("a forged heartbeat signature is refused and no heartbeat is recorded", async () => {
  const h = await layer();
  const identity = await enrolled(h.engine, h.owner, "worker-forged");
  const before = (await h.engine.worker("worker-forged")).worker.heartbeatAt;
  identity.secret = randomBytes(32).toString("base64url");

  const forged = await authenticate(h.engine, identity, "heartbeat", { tick: h.tick, body: { state: "online" } });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, "worker_signature_invalid");

  const status = await h.engine.worker("worker-forged");
  assert.equal(status.worker.heartbeatAt, before, "a forgery must not move the heartbeat clock");
  h.db.close();
});

test("a signature covers the body: swapping the body invalidates it", async () => {
  const h = await layer();
  const identity = await enrolled(h.engine, h.owner, "worker-body");
  const at = h.tick.now();
  const used = nonce();
  const signature = signWorkerRequest({
    secret: identity.secret,
    operation: "heartbeat",
    workerId: identity.workerId,
    credentialId: identity.credentialId,
    nonce: used,
    timestamp: at,
    body: { state: "online" }
  }).signature;

  const tampered = await h.engine.authenticateWorkerRequest({
    presented: identity.presented,
    operation: "heartbeat",
    nonce: used,
    timestamp: at,
    signature,
    body: { state: "online", detail: "released the deployment" }
  });
  assert.equal(tampered.code, "worker_signature_invalid");

  // The same request also cannot be re-aimed at a different operation.
  const reaimed = await h.engine.authenticateWorkerRequest({
    presented: identity.presented,
    operation: "lease.acquire",
    nonce: nonce(),
    timestamp: at,
    signature,
    body: { state: "online" }
  });
  assert.equal(reaimed.code, "worker_signature_invalid");
  h.db.close();
});

test("a replayed request is refused once the nonce is spent, and the first one succeeds", async () => {
  const h = await layer();
  const identity = await enrolled(h.engine, h.owner, "worker-replay");
  const at = h.tick.now();
  const used = nonce();
  const signature = signWorkerRequest({
    secret: identity.secret,
    operation: "heartbeat",
    workerId: identity.workerId,
    credentialId: identity.credentialId,
    nonce: used,
    timestamp: at,
    body: { state: "online" }
  }).signature;

  const first = await h.engine.authenticateWorkerRequest({
    presented: identity.presented, operation: "heartbeat", nonce: used, timestamp: at, signature, body: { state: "online" }
  });
  assert.equal(first.ok, true, JSON.stringify(first));

  const replay = await h.engine.authenticateWorkerRequest({
    presented: identity.presented, operation: "heartbeat", nonce: used, timestamp: at, signature, body: { state: "online" }
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "worker_request_replayed");

  // A stale timestamp is refused before the nonce is spent, so it cannot burn a future request.
  const old = await authenticate(h.engine, identity, "heartbeat", { tick: h.tick, timestamp: at - 10 * 60_000 });
  assert.equal(old.code, "worker_request_timestamp_invalid");
  h.db.close();
});

test("one worker cannot renew or release another worker's lease", async () => {
  const h = await layer();
  const a = await enrolled(h.engine, h.owner, "worker-owner-a");
  const b = await enrolled(h.engine, h.owner, "worker-owner-b");

  const claimed = await h.engine.acquire({ missionId: "msn_cross", taskId: "msn_cross.t1", workerId: a.workerId, requires: ["engineering"] });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));

  const stolenRenew = await h.engine.renew({ leaseId: claimed.leaseId, workerId: b.workerId });
  assert.equal(stolenRenew.ok, false);
  assert.equal(stolenRenew.code, "lease_not_owned");

  const stolenRelease = await h.engine.release({ leaseId: claimed.leaseId, workerId: b.workerId, state: "released" });
  assert.equal(stolenRelease.ok, false);
  assert.equal(stolenRelease.code, "lease_not_owned");

  const stillMine = await h.engine.lease(claimed.leaseId);
  assert.equal(stillMine.state, "active");
  assert.equal(stillMine.workerId, a.workerId);

  // Cross-worker acquisition of the same task is refused by the lease itself, not by the signature.
  const other = await h.engine.acquire({ missionId: "msn_cross", taskId: "msn_cross.t1", workerId: b.workerId, requires: ["engineering"] });
  assert.equal(other.ok, false);
  assert.equal(other.code, "lease_held");
  h.db.close();
});

test("a stolen credential string alone does not authenticate as a different worker", async () => {
  const h = await layer();
  const a = await enrolled(h.engine, h.owner, "worker-stolen-a");
  const b = await enrolled(h.engine, h.owner, "worker-stolen-b");

  // Attacker holds A's secret but claims B's identity: the signed worker id is part of the statement.
  const impersonation = await authenticate(
    h.engine,
    { ...b, secret: a.secret },
    "heartbeat",
    { tick: h.tick, workerId: b.workerId }
  );
  assert.equal(impersonation.code, "worker_signature_invalid");

  // A malformed credential never reaches the signing step.
  const garbage = await h.engine.authenticateWorkerRequest({
    presented: "axw_not_a_credential", operation: "heartbeat", nonce: nonce(), timestamp: h.tick.now(), signature: "v1,x", body: {}
  });
  assert.equal(garbage.code, "worker_credential_invalid");

  // Parse is strict: the id is what identifies the key, so it cannot be absent.
  assert.equal(parseWorkerCredential("axw__secret"), null);
  h.db.close();
});

test("revocation is immediate and rotation keeps the durable worker identity", async () => {
  const h = await layer();
  const identity = await enrolled(h.engine, h.owner, "worker-rotate");

  const rotated = await h.engine.rotateCredential({
    credentialId: identity.credentialId,
    authorization: OWNER,
    graceMs: 60_000
  });
  assert.equal(rotated.ok, true, JSON.stringify(rotated));
  assert.equal(rotated.credential.workerId, identity.workerId, "rotation must not create a new worker");

  const parsedReplacement = parseWorkerCredential(rotated.secret);
  const replacement = {
    workerId: identity.workerId,
    credentialId: rotated.credential.credentialId,
    presented: rotated.secret,
    secret: parsedReplacement.secret
  };
  const duringGrace = await authenticate(h.engine, identity, "heartbeat", { tick: h.tick });
  assert.equal(duringGrace.ok, true, "the old key keeps working inside the grace window");
  const fresh = await authenticate(h.engine, replacement, "heartbeat", { tick: h.tick });
  assert.equal(fresh.ok, true);

  h.tick.advance(61_000);
  const afterGrace = await authenticate(h.engine, identity, "heartbeat", { tick: h.tick });
  assert.equal(afterGrace.code, "worker_credential_rotated");

  const revoked = await h.engine.revokeCredential({ credentialId: replacement.credentialId, reason: "lost laptop", authorization: OWNER });
  assert.equal(revoked.ok, true);
  const refused = await authenticate(h.engine, replacement, "heartbeat", { tick: h.tick });
  assert.equal(refused.code, "worker_credential_revoked");

  // Revocation is idempotent, and the worker identity itself is untouched.
  const again = await h.engine.revokeCredential({ credentialId: replacement.credentialId, authorization: OWNER });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal((await h.engine.worker("worker-rotate")).worker.state, "online");
  h.db.close();
});

test("registration and revocation need owner authority when strict mode is on, and the statement is bound", async () => {
  const h = await layer({ engine: { requireOwnerAuthorization: true } });
  const anonymous = await h.engine.registerWorker({ id: "worker-strict", capabilities: ["engineering"] });
  assert.equal(anonymous.code, "owner_authorization_required");

  const statement = workforceOwnerStatement({
    operation: "worker.register",
    workerId: "worker-strict",
    detail: capabilitiesFingerprint(["engineering"]) + ":1"
  });
  // The engine receives the exact statement the owner signed; the signature itself was verified above it.
  const signed = h.owner.sign({
    operation: "workforce.worker.register",
    project: "habitat",
    key: "worker-strict",
    kind: "workforce",
    statement,
    tags: [],
    confidence: null
  });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(h.owner.verify({
    operation: "workforce.worker.register",
    project: "habitat",
    key: "worker-strict",
    kind: "workforce",
    statement,
    tags: [],
    confidence: null
  }, signed.attestation).ok, true);
  const accepted = await h.engine.registerWorker({
    id: "worker-strict",
    capabilities: ["engineering"],
    maxConcurrent: 1,
    authorization: { ok: true, by: "owner:test", statement }
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  // The same signature cannot register a different capability set.
  const swapped = await h.engine.registerWorker({
    id: "worker-strict",
    capabilities: ["engineering", "deploy"],
    maxConcurrent: 1,
    authorization: { ok: true, by: "owner:test", statement }
  });
  assert.equal(swapped.code, "owner_authorization_mismatch");

  const refusedRevoke = await h.engine.deregisterWorker({ id: "worker-strict", force: true });
  assert.equal(refusedRevoke.code, "owner_authorization_required");
  h.db.close();
});

test("an unknown outcome is never retried, and only proved non-execution reopens the attempt", async () => {
  const h = await layer();
  await worker(h.engine, "worker-uncertain");
  const lease = await h.engine.acquire({ missionId: "msn_u", taskId: "msn_u.t1", workerId: "worker-uncertain", requires: ["engineering"] });
  assert.equal(lease.ok, true);

  const begun = await h.engine.executionBegin({ missionId: "msn_u", taskId: "msn_u.t1", workerId: "worker-uncertain", attempt: 1, leaseId: lease.leaseId });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  await h.engine.recordOperation({
    idempotencyKey: begun.idempotencyKey,
    missionId: "msn_u",
    taskId: "msn_u.t1",
    workerId: "worker-uncertain",
    provider: "deploy",
    providerReference: "deploy-run-42",
    state: "unknown"
  });
  await h.engine.executionComplete({ idempotencyKey: begun.idempotencyKey, state: "uncertain", result: { reason: "timeout" } });

  const inspected = await h.engine.inspectUncertain({ idempotencyKey: begun.idempotencyKey });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.readOnly, true);
  assert.equal(inspected.operation.providerReference, "deploy-run-42");
  assert.equal(inspected.retryable, false);

  const blocked = await h.engine.executionBegin({ missionId: "msn_u", taskId: "msn_u.t1", workerId: "worker-uncertain", attempt: 2, leaseId: lease.leaseId });
  assert.equal(blocked.code, "outcome_uncertain");

  // Proof is mandatory for any verdict except "unknown".
  const noProof = await h.engine.reconcileUncertain({ idempotencyKey: begun.idempotencyKey, verdict: "not_executed", authorization: OWNER });
  assert.equal(noProof.code, "reconciliation_proof_required");
  assert.equal((await h.engine.execution(begun.idempotencyKey)).state, "uncertain");

  // "unknown" records the inspection and changes nothing.
  const stillUnknown = await h.engine.reconcileUncertain({ idempotencyKey: begun.idempotencyKey, verdict: "unknown", proof: { evidence: "operator looked" }, authorization: OWNER });
  assert.equal(stillUnknown.ok, true);
  assert.equal(stillUnknown.retryable, false);
  assert.equal((await h.engine.execution(begun.idempotencyKey)).state, "uncertain");

  // A confirmed failure keeps the at-most-once boundary.
  const failed = await h.engine.reconcileUncertain({
    idempotencyKey: begun.idempotencyKey,
    verdict: "confirmed_failure",
    proof: { evidence: "provider log shows the deploy failed", reference: "deploy-run-42" },
    authorization: OWNER
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.decision, "hold_uncertain");
  assert.equal((await h.engine.executionBegin({ missionId: "msn_u", taskId: "msn_u.t1", workerId: "worker-uncertain", attempt: 3, leaseId: lease.leaseId })).code, "outcome_uncertain");

  // Proved non-execution turns the attempt into a retryable failure.
  const notExecuted = await h.engine.reconcileUncertain({
    idempotencyKey: begun.idempotencyKey,
    verdict: "not_executed",
    proof: { evidence: "provider reports no operation with this reference", reference: "deploy-run-42" },
    authorization: OWNER
  });
  assert.equal(notExecuted.ok, true, JSON.stringify(notExecuted));
  assert.equal(notExecuted.decision, "requeue");
  assert.equal(notExecuted.retryable, true);
  assert.equal((await h.engine.execution(begun.idempotencyKey)).state, "failed");

  const reopened = await h.engine.executionBegin({ missionId: "msn_u", taskId: "msn_u.t1", workerId: "worker-uncertain", attempt: 4, leaseId: lease.leaseId });
  assert.equal(reopened.ok, true, "a proved non-execution may be attempted again");

  // A later observation cannot downgrade the settled verdict.
  await h.engine.recordOperation({ idempotencyKey: begun.idempotencyKey, missionId: "msn_u", taskId: "msn_u.t1", state: "unknown" });
  assert.equal((await h.engine.operation(begun.idempotencyKey)).state, "not_executed");

  const history = await h.engine.reassignments({ missionId: "msn_u" });
  assert.ok(history.items.some((item) => item.reason === "reconciliation:confirmed_failure"), JSON.stringify(history));
  assert.ok(history.items.some((item) => item.reason === "reconciliation:not_executed" && item.decision === "requeue"));
  h.db.close();
});

test("a crash during execution holds the attempt uncertain instead of reassigning duplicate work", async () => {
  const h = await layer();
  await worker(h.engine, "worker-crash");
  const lease = await h.engine.acquire({ missionId: "msn_crash", taskId: "msn_crash.t1", workerId: "worker-crash", requires: ["engineering"] });
  assert.equal(lease.ok, true);
  const begun = await h.engine.executionBegin({ missionId: "msn_crash", taskId: "msn_crash.t1", workerId: "worker-crash", attempt: 1, leaseId: lease.leaseId });
  assert.equal(begun.ok, true);

  // The process dies: no heartbeat, no release, no outcome.
  h.tick.advance(30 * 60_000);
  const recovered = await h.engine.recover();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.expired, 1);
  assert.equal(recovered.stalled, 1);
  assert.equal((await h.engine.execution(begun.idempotencyKey)).state, "uncertain");

  const queue = await h.engine.recoveryQueue();
  const item = queue.items.find((entry) => entry.leaseId === lease.leaseId);
  assert.ok(item, JSON.stringify(queue));
  assert.equal(item.decision, "hold_uncertain");

  // A crashed executor cannot claim work again until it proves it is alive.
  await h.engine.heartbeat({ id: "worker-crash", state: "online" });

  const history = await h.engine.reassignments({ missionId: "msn_crash" });
  const decision = history.items.find((entry) => entry.leaseId === lease.leaseId);
  assert.ok(decision, JSON.stringify(history));
  assert.equal(decision.decision, "hold_uncertain");
  assert.equal(decision.fromWorker, "worker-crash");
  assert.equal(decision.reason, "lease_expired");

  // The reassigned attempt cannot run: the ledger refuses it.
  const nextLease = await h.engine.acquire({ missionId: "msn_crash", taskId: "msn_crash.t1", workerId: "worker-crash", requires: ["engineering"], attempt: 2 });
  assert.equal(nextLease.ok, true, JSON.stringify(nextLease));
  const duplicate = await h.engine.executionBegin({ missionId: "msn_crash", taskId: "msn_crash.t1", workerId: "worker-crash", attempt: 2, leaseId: nextLease.leaseId });
  assert.equal(duplicate.code, "outcome_uncertain");
  h.db.close();
});

test("a clean expiry before any attempt is requeued, and concurrent sweeps expire it once", async () => {
  const h = await layer();
  await worker(h.engine, "worker-idle");
  const lease = await h.engine.acquire({ missionId: "msn_idle", taskId: "msn_idle.t1", workerId: "worker-idle", requires: ["engineering"] });
  assert.equal(lease.ok, true);
  h.tick.advance(5 * 60_000);

  const second = await layer({ db: h.db, tick: h.tick });
  const results = await Promise.all([
    h.engine.expireAbandonedLeases(),
    second.engine.expireAbandonedLeases()
  ]);
  const total = results.reduce((sum, result) => sum + Number(result.expired || 0), 0);
  assert.equal(total, 1, "exactly one sweep may win the lease");

  const queue = await h.engine.recoveryQueue();
  const item = queue.items.find((entry) => entry.leaseId === lease.leaseId);
  assert.equal(item.decision, "requeue");
  await h.engine.heartbeat({ id: "worker-idle", state: "online" });
  const history = await h.engine.reassignments({ missionId: "msn_idle" });
  assert.equal(history.items.filter((entry) => entry.leaseId === lease.leaseId).length, 1, "one decision per expiry");

  // Requeued work keeps at-most-once: the ledger was never opened, so a new attempt is allowed.
  const nextLease = await h.engine.acquire({ missionId: "msn_idle", taskId: "msn_idle.t1", workerId: "worker-idle", requires: ["engineering"], attempt: 2 });
  assert.equal(nextLease.ok, true, JSON.stringify(nextLease));
  const begun = await h.engine.executionBegin({ missionId: "msn_idle", taskId: "msn_idle.t1", workerId: "worker-idle", attempt: 2, leaseId: nextLease.leaseId });
  assert.equal(begun.ok, true);
  h.db.close();
});

test("a slow but active executor is not reported as stalled, and cannot take more work", async () => {
  const h = await layer({ engine: { stalledAfterMs: 60_000, leaseTtlMs: 30 * 60_000 } });
  await worker(h.engine, "worker-slow");
  const beat = await h.engine.heartbeat({ id: "worker-slow", state: "online" });
  assert.equal(beat.ok, true);
  const lease = await h.engine.acquire({ missionId: "msn_slow", taskId: "msn_slow.t1", workerId: "worker-slow", requires: ["engineering"] });
  assert.equal(lease.ok, true);

  // The heartbeat goes stale while the executor is still renewing its lease.
  h.tick.advance(70_000);
  const renewed = await h.engine.renew({ leaseId: lease.leaseId, workerId: "worker-slow" });
  assert.equal(renewed.ok, true, JSON.stringify(renewed));

  const detail = await h.engine.worker("worker-slow");
  assert.equal(detail.worker.health.status, "active_execution");
  assert.equal(detail.worker.health.stale, false);
  assert.ok(detail.worker.health.activityAgeMs <= 60_000);

  const more = await h.engine.acquire({ missionId: "msn_slow", taskId: "msn_slow.t2", workerId: "worker-slow", requires: ["engineering"] });
  assert.equal(more.ok, false);
  assert.equal(more.code, "worker_executing");

  const stalled = await h.engine.detectStalledWorkers();
  assert.equal(stalled.stalled.includes("worker-slow"), false, "an active executor is not stalled");

  // A worker with the same stale heartbeat and no lease activity is stalled.
  await worker(h.engine, "worker-dead");
  await h.engine.heartbeat({ id: "worker-dead", state: "online" });
  h.tick.advance(70_000);
  const dead = await h.engine.worker("worker-dead");
  assert.equal(dead.worker.health.status, "stalled");
  const sweep = await h.engine.detectStalledWorkers();
  assert.equal(sweep.stalled.includes("worker-dead"), true);
  h.db.close();
});

test("deregistration revokes credentials and records the recovery decision for its leases", async () => {
  const h = await layer();
  const identity = await enrolled(h.engine, h.owner, "worker-retire");
  const lease = await h.engine.acquire({ missionId: "msn_retire", taskId: "msn_retire.t1", workerId: identity.workerId, requires: ["engineering"] });
  assert.equal(lease.ok, true);

  const retired = await h.engine.deregisterWorker({ id: identity.workerId, reason: "hardware lost", force: true });
  assert.equal(retired.ok, true, JSON.stringify(retired));
  assert.equal(retired.credentialsRevoked, 1);

  const after = await authenticate(h.engine, identity, "heartbeat", { tick: h.tick });
  assert.equal(after.code, "worker_credential_revoked");

  const history = await h.engine.reassignments({ missionId: "msn_retire" });
  const decision = history.items.find((entry) => entry.leaseId === lease.leaseId);
  assert.ok(decision, JSON.stringify(history));
  assert.equal(decision.reason, "worker_deregistered");
  assert.equal(decision.decision, "requeue", "no attempt had started, so the task may run elsewhere");

  const status = await h.engine.status();
  assert.equal(status.identity.ready, true);
  assert.equal(status.identity.workersWithCredentials, 0);
  h.db.close();
});
