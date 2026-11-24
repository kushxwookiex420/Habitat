import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";
import { approvalSigningFields } from "../ax-mission-policy.mjs";
import { buildMissionEnvironment } from "../mission-harness.mjs";

/**
 * Cryptographic approval binding, exercised through the real engine with a real HMAC verifier. Every refusal
 * is also observed through executor spies, so "never executed" is measured.
 */

const ROOT = process.cwd();
const SECRET = "owner-approval-crypto-test-secret-" + "c".repeat(16);
const CRITERIA = ["Repository analysed", "Release prepared"];
const TASK = {
  id: "t2",
  title: "Deploy to production",
  requires: ["engineering"],
  criteria: [1],
  approvalRequired: true,
  action: "deploy release 4.2.0",
  target: "staging",
  params: { region: "iad", replicas: 2 }
};

function clock(start = "2026-11-24T12:00:00.000Z") {
  let value = Date.parse(start);
  return { now: () => new Date(value).toISOString(), advance(ms) { value += ms; } };
}

async function setup({ verifier = null } = {}) {
  const tick = clock();
  const base = await mkdtemp(path.join(os.tmpdir(), "habitat-approval-crypto-"));
  const calls = { byTask: {} };
  const owner = createOwnerAttestation({ secret: SECRET, now: () => Date.parse(tick.now()) });
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(base, "artifacts"),
    dbPath: path.join(base, "db.sqlite"),
    now: tick.now,
    ownerVerifier: owner,
    executorOverrides: {
      "eng.repo": async ({ task }) => {
        calls.byTask[task.id] = (calls.byTask[task.id] || 0) + 1;
        return { result: { status: "completed", evidence: ["spy:" + task.id], changedFiles: [], tests: { ran: 1, passed: 1, failed: 0 } } };
      },
      "verifier.recompute": verifier || (async () => ({ ok: true, evidence: ["verifier:ok"], tests: { ran: 1, passed: 1, failed: 0 } }))
    }
  });
  const close = async () => { env.close(); await rm(base, { recursive: true, force: true }); };
  return { env, owner, calls, tick, close };
}

async function missionRecord(env, missionId) {
  const loaded = await env.missions.get(missionId);
  return loaded?.record || loaded;
}

async function sign(env, owner, missionId, { taskId = "t2", decision = "approve", ownerName = "owner" } = {}) {
  const mission = await missionRecord(env, missionId);
  const approval = mission.approvals.find((item) => (taskId ? item.taskId === taskId : !item.taskId));
  assert.ok(approval, "the approval exists");
  return owner.sign(approvalSigningFields({ mission, approval, decision, owner: ownerName }));
}

async function park(env, spec = {}) {
  const outcome = await env.pipeline.submit({
    objective: spec.objective || "Deploy release 4.2.0 to staging",
    acceptanceCriteria: spec.acceptanceCriteria || ["Repository analysed", "Release prepared"],
    tasks: spec.tasks || [{ id: "t1", title: "Analyse the repository", requires: ["engineering"], criteria: [0] }, TASK]
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const run = await env.pipeline.run(outcome.missionId, { maxRounds: 1 });
  assert.equal(run.status, "approval_required", JSON.stringify(run));
  return outcome.missionId;
}

test("crypto: a correctly signed approval executes the exact task, and only that task", async () => {
  const { env, owner, calls, close } = await setup();
  try {
    const missionId = await park(env);
    const signal = await sign(env, owner, missionId, { taskId: null });
    assert.equal((await env.missions.approve({ missionId, decision: "approve", attestation: signal.attestation })).ok, true);
    const signed = await sign(env, owner, missionId);
    const approved = await env.missions.approve({ missionId, taskId: "t2", decision: "approve", attestation: signed.attestation });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const record = await missionRecord(env, missionId);
    assert.match(record.approvals.find((item) => item.taskId === "t2").signed.statement, /"actionClass":"consequential"/);
    const storedRecord = await missionRecord(env, missionId);
    const storedApproval = storedRecord.approvals.find((item) => item.taskId === "t2");
    const recomputed = approvalSigningFields({ mission: storedRecord, approval: storedApproval, decision: "approve", owner: storedApproval.decidedBy });
    assert.equal(recomputed.statement, storedApproval.signed.statement);
    const run = await env.pipeline.run(missionId, { maxRounds: 2 });
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(calls.byTask.t2, 1);
  } finally { await close(); }
});

test("crypto: unsigned, malformed and tampered attestations fail closed", async () => {
  const { env, owner, calls, close } = await setup();
  try {
    const missionId = await park(env);
    const signal = await sign(env, owner, missionId, { taskId: null });
    await env.missions.approve({ missionId, decision: "approve", attestation: signal.attestation });

    const unsigned = await env.missions.approve({ missionId, taskId: "t2", decision: "approve" });
    assert.equal(unsigned.code, "owner_attestation_required");

    const signed = await sign(env, owner, missionId);
    const tamperedMac = { ...signed.attestation, mac: signed.attestation.mac.replace(/^./, (c) => (c === "a" ? "b" : "a")) };
    const tampered = await env.missions.approve({ missionId, taskId: "t2", decision: "approve", attestation: tamperedMac });
    assert.equal(tampered.ok, false);

    const malformed = await env.missions.approve({ missionId, taskId: "t2", decision: "approve", attestation: { v: 1, keyId: "owner-1", issuedAt: "nope", nonce: "short", mac: "x" } });
    assert.equal(malformed.ok, false);

    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.byTask.t2 || 0, 0, "no invalid attestation executed the task");
    const task = (await missionRecord(env, missionId)).tasks.find((item) => item.id === "t2");
    assert.notEqual(task.status, "completed");
  } finally { await close(); }
});

test("crypto: a signature for one task cannot be replayed onto another task", async () => {
  const { env, owner, calls, close } = await setup();
  try {
    const second = { ...TASK, id: "d2", title: "Deploy release 4.3.0 to production", criteria: [1], dependsOn: [], action: "deploy release 4.3.0", params: { replicas: 3 } };
    const missionId = await park(env, {
      tasks: [
        { id: "t1", title: "Analyse the repository", requires: ["engineering"], criteria: [0] },
        { ...TASK, dependsOn: ["t1"] },
        second
      ]
    });
    const signal = await sign(env, owner, missionId, { taskId: null });
    await env.missions.approve({ missionId, decision: "approve", attestation: signal.attestation });

    const forT2 = await sign(env, owner, missionId, { taskId: "t2" });
    const replayed = await env.missions.approve({ missionId, taskId: "d2", decision: "approve", attestation: forT2.attestation });
    assert.equal(replayed.ok, false);
    assert.match(replayed.code, /owner_attestation_invalid/);

    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.byTask.d2 || 0, 0, "the cross-task replay never executed d2");
  } finally { await close(); }
});

test("crypto: a signature for one mission cannot be replayed onto another mission", async () => {
  const { env, owner, calls, close } = await setup();
  try {
    const firstId = await park(env);
    const secondId = await park(env, { objective: "Deploy release 4.2.1 to staging" });
    assert.notEqual(firstId, secondId);

    const firstSignal = await sign(env, owner, firstId, { taskId: null });
    const secondSignal = await sign(env, owner, secondId, { taskId: null });
    await env.missions.approve({ missionId: firstId, decision: "approve", attestation: firstSignal.attestation });
    await env.missions.approve({ missionId: secondId, decision: "approve", attestation: secondSignal.attestation });

    const forFirst = await sign(env, owner, firstId, { taskId: "t2" });
    const replayed = await env.missions.approve({ missionId: secondId, taskId: "t2", decision: "approve", attestation: forFirst.attestation });
    assert.equal(replayed.ok, false);
    await env.pipeline.run(secondId, { maxRounds: 1 });
    assert.equal(calls.byTask.t2 || 0, 0);
  } finally { await close(); }
});

test("crypto: changing parameters or target after signing invalidates the signature", async () => {
  const { env, owner, calls, close } = await setup();
  try {
    const missionId = await park(env);
    const signal = await sign(env, owner, missionId, { taskId: null });
    await env.missions.approve({ missionId, decision: "approve", attestation: signal.attestation });
    const signed = await sign(env, owner, missionId);

    const loaded = await env.missions.get(missionId);
    loaded.record.tasks.find((item) => item.id === "t2").params = { region: "iad", replicas: 9 };
    assert.equal((await env.missionStore.save(loaded.record, loaded.version)).ok, true);

    const refused = await env.missions.approve({ missionId, taskId: "t2", decision: "approve", attestation: signed.attestation });
    assert.equal(refused.ok, false);

    const loaded2 = await env.missions.get(missionId);
    loaded2.record.tasks.find((item) => item.id === "t2").params = { region: "iad", replicas: 2 };
    loaded2.record.tasks.find((item) => item.id === "t2").target = "production";
    assert.equal((await env.missionStore.save(loaded2.record, loaded2.version)).ok, true);
    const targetRefused = await env.missions.approve({ missionId, taskId: "t2", decision: "approve", attestation: signed.attestation });
    assert.equal(targetRefused.ok, false);

    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.byTask.t2 || 0, 0);
  } finally { await close(); }
});

test("crypto: an expired attestation and an expired approval are both refused", async () => {
  const { env, owner, calls, tick, close } = await setup();
  try {
    const missionId = await park(env);
    const signal = await sign(env, owner, missionId, { taskId: null });
    await env.missions.approve({ missionId, decision: "approve", attestation: signal.attestation });
    const signed = await sign(env, owner, missionId);

    tick.advance(6 * 60_000); // beyond the 5 minute attestation window
    const stale = await env.missions.approve({ missionId, taskId: "t2", decision: "approve", attestation: signed.attestation });
    assert.equal(stale.code, "owner_attestation_expired");

    // A fresh signature over an approval whose stored expiry has passed is still refused.
    const loaded = await env.missions.get(missionId);
    const expiredApproval = loaded.record.approvals.find((item) => item.taskId === "t2");
    expiredApproval.expiresAt = "2020-01-01T00:00:00.000Z";
    assert.equal((await env.missionStore.save(loaded.record, loaded.version)).ok, true);
    const persisted = await missionRecord(env, missionId);
    const fresh = owner.sign(approvalSigningFields({
      mission: persisted,
      approval: persisted.approvals.find((item) => item.taskId === "t2"),
      decision: "approve"
    }));
    const refused = await env.missions.approve({ missionId, taskId: "t2", decision: "approve", attestation: fresh.attestation });
    assert.equal(refused.code, "approval_expired");

    await env.pipeline.run(missionId, { maxRounds: 1 });
    assert.equal(calls.byTask.t2 || 0, 0);
  } finally { await close(); }
});

test("crypto: a signed rejection never executes, and a revocation after a signed grant is refused", async () => {
  const { env, owner, calls, close } = await setup();
  try {
    const rejectId = await park(env);
    const rejectSignal = await sign(env, owner, rejectId, { taskId: null });
    await env.missions.approve({ missionId: rejectId, decision: "approve", attestation: rejectSignal.attestation });
    const rejectTask = await sign(env, owner, rejectId, { decision: "reject" });
    const rejected = await env.missions.approve({ missionId: rejectId, taskId: "t2", decision: "reject", attestation: rejectTask.attestation });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    assert.equal(rejected.status, "rejected");
    await env.pipeline.run(rejectId, { maxRounds: 1 });
    assert.equal(calls.byTask.t2 || 0, 0, "a rejection never executes");

    const revokeId = await park(env, { objective: "Deploy release 5.0.0 to staging" });
    const signal = await sign(env, owner, revokeId, { taskId: null });
    await env.missions.approve({ missionId: revokeId, decision: "approve", attestation: signal.attestation });
    const granted = await sign(env, owner, revokeId);
    assert.equal((await env.missions.approve({ missionId: revokeId, taskId: "t2", decision: "approve", attestation: granted.attestation })).ok, true);
    assert.equal((await env.missions.revoke({ missionId: revokeId, taskId: "t2", reason: "withdrawn" })).ok, true);
    await env.pipeline.run(revokeId, { maxRounds: 1 });
    assert.equal(calls.byTask.t2 || 0, 0);
    assert.equal((await missionRecord(env, revokeId)).tasks.find((item) => item.id === "t2").error, "approval_revoked");
  } finally { await close(); }
});
