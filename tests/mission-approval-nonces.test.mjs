import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createMissionRepository, NONCE_TABLE } from "../d1-mission-repository.mjs";
import { createMissionEngine } from "../ax-mission-engine.mjs";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";
import { buildMissionEnvironment } from "../mission-harness.mjs";

/**
 * Durable approval nonce registry (migration 0017). Uniqueness in the database, not an application check,
 * is the replay boundary; expiry marks rows instead of deleting them; a failed mission write releases only
 * the row this request consumed.
 */

const ROOT = process.cwd();
const CRITERIA = ["Repository analysed", "Release prepared"];
const TASKS = [
  { id: "t1", title: "Analyse the repository", requires: ["engineering"], criteria: [0] },
  {
    id: "t2", title: "Deploy to production", requires: ["engineering"], criteria: [1], dependsOn: ["t1"],
    approvalRequired: true, action: "deploy release 7.0.0", target: "staging", params: { region: "iad", replicas: 2 }
  }
];

function sqliteQuery(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "habitat-nonce-registry-" + process.pid + "-"));
}

function nonce(n, label = "n") {
  return label + "-" + String(n).padStart(4, "0") + "-" + "a".repeat(24);
}

test("migration 0017 creates the registry with unique nonce and lookup indexes", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = await readFile(path.join(ROOT, "migrations", "0017_ax_approval_nonces.sql"), "utf8");
  db.exec(sql);
  db.exec(sql); // repeat-safe
  const columns = db.prepare("PRAGMA table_info(" + NONCE_TABLE + ")").all();
  assert.deepEqual(columns.map((row) => row.name).sort(), [
    "approval_id", "consumed_at", "decision", "expires_at", "issued_at", "key_id",
    "mission_id", "nonce", "revoke_reason", "revoked_at", "status", "task_id"
  ]);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(NONCE_TABLE).map((row) => row.name);
  for (const name of ["habitat_ax_approval_nonces_mission", "habitat_ax_approval_nonces_approval", "habitat_ax_approval_nonces_expiry"]) {
    assert.ok(indexes.includes(name), "missing index " + name);
  }
  const insert = db.prepare("INSERT INTO " + NONCE_TABLE + " (nonce, key_id, mission_id, approval_id, task_id, decision, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run(nonce(1), "k1", "msn_a", "apr_a", "t2", "approve", "2026-01-01T00:00:00Z");
  assert.throws(() => insert.run(nonce(1), "k1", "msn_b", "apr_b", "t3", "approve", "2026-01-01T00:00:00Z"), /UNIQUE|PRIMARY/);
  assert.throws(() => insert.run(nonce(2), "k1", "msn_a", "apr_a", "t2", "maybe", "2026-01-01T00:00:00Z"), /CHECK/);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM " + NONCE_TABLE + " WHERE nonce = ?").all(nonce(1));
  assert.match(JSON.stringify(plan), /USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY|sqlite_autoindex/i);
  db.close();
});

test("registry enforces duplicate, concurrent, cross-mission and cross-approval rejection", async () => {
  const db = new DatabaseSync(":memory:");
  const repo = createMissionRepository({ query: sqliteQuery(db) });
  await repo.initialize();
  const entry = { nonce: nonce(10), keyId: "owner-1", missionId: "msn_a", approvalId: "apr_a", taskId: "t2", decision: "approve" };
  assert.equal((await repo.consumeNonce(entry)).ok, true);

  const duplicate = await repo.consumeNonce(entry);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "owner_attestation_replayed");

  assert.equal((await repo.consumeNonce({ ...entry, nonce: nonce(11), missionId: "msn_b" })).ok, true);
  const crossMission = await repo.consumeNonce({ ...entry, missionId: "msn_b" });
  assert.equal(crossMission.code, "owner_attestation_replayed");

  assert.equal((await repo.consumeNonce({ ...entry, nonce: nonce(12), approvalId: "apr_other" })).ok, true);
  const crossApproval = await repo.consumeNonce({ ...entry, approvalId: "apr_other" });
  assert.equal(crossApproval.code, "owner_attestation_replayed");

  // Race: 25 callers attempt the same fresh nonce at once; exactly one row may exist.
  const racing = await Promise.all(Array.from({ length: 25 }, () => repo.consumeNonce({ ...entry, nonce: nonce(13) })));
  assert.equal(racing.filter((item) => item.ok).length, 1, "exactly one concurrent consume wins");
  assert.equal(racing.filter((item) => !item.ok && item.code === "owner_attestation_replayed").length, 24);
  assert.equal(await repo.nonceUsed(nonce(13)), true);
  db.close();
});

test("a consumed nonce survives restart and stays replay-protected", async () => {
  const dir = await tempDir();
  const dbPath = path.join(dir, "registry.sqlite");
  try {
    const first = new DatabaseSync(dbPath);
    const repoA = createMissionRepository({ query: sqliteQuery(first) });
    await repoA.initialize();
    assert.equal((await repoA.consumeNonce({ nonce: nonce(20), missionId: "msn_a", approvalId: "apr_a", decision: "approve" })).ok, true);
    first.close();

    const second = new DatabaseSync(dbPath);
    const repoB = createMissionRepository({ query: sqliteQuery(second) });
    assert.deepEqual(await repoB.verifySchema(), { ok: true, missing: [], expected: 3 });
    assert.equal(await repoB.nonceUsed(nonce(20)), true);
    const again = await repoB.consumeNonce({ nonce: nonce(20), missionId: "msn_a", approvalId: "apr_a", decision: "approve" });
    assert.equal(again.code, "owner_attestation_replayed");
    assert.equal((await repoB.nonceRecord(nonce(20))).status, "consumed");
    second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("expiry marks rows for cleanup without reopening replay", async () => {
  const db = new DatabaseSync(":memory:");
  const repo = createMissionRepository({ query: sqliteQuery(db) });
  await repo.initialize();
  await repo.consumeNonce({ nonce: nonce(30), missionId: "msn_a", approvalId: "apr_a", decision: "approve", expiresAt: "2026-01-01T00:01:00Z" });
  await repo.consumeNonce({ nonce: nonce(31), missionId: "msn_a", approvalId: "apr_b", decision: "approve", expiresAt: "2030-01-01T00:01:00Z" });
  const cleanup = await repo.expireNonces("2026-06-01T00:00:00Z");
  assert.equal(cleanup.expired, 1);
  assert.equal((await repo.nonceRecord(nonce(30))).status, "expired");
  assert.equal((await repo.nonceRecord(nonce(31))).status, "consumed");
  assert.equal(await repo.nonceUsed(nonce(30)), true, "expired rows still refuse replay");
  assert.equal((await repo.consumeNonce({ nonce: nonce(30), missionId: "msn_a", approvalId: "apr_a", decision: "approve" })).code, "owner_attestation_replayed");
  db.close();
});

async function missionSetup(dir) {
  const owner = createOwnerAttestation({ secret: "registry-secret-" + "s".repeat(24) });
  const calls = { t2: 0 };
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(dir, "artifacts"),
    dbPath: path.join(dir, "mission.sqlite"),
    ownerVerifier: owner,
    executorOverrides: {
      "eng.repo": async ({ task }) => {
        if (task.id === "t2") calls.t2 += 1;
        return { result: { status: "completed", evidence: ["spy:" + task.id], changedFiles: [], tests: { ran: 1, passed: 1, failed: 0 } } };
      },
      "verifier.recompute": async () => ({ ok: true, evidence: ["verifier:ok"], tests: { ran: 1, passed: 1, failed: 0 } })
    }
  });
  return { env, owner, calls, close: () => env.close() };
}

async function pendingMission(env, key) {
  const created = await env.pipeline.submit({
    objective: "Deploy release 7.0.0", acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "registry-" + key
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const missionId = created.missionId;
  await env.pipeline.run(missionId);
  const loaded = await env.missions.get(missionId);
  const signal = loaded.record.approvals.find((item) => !item.taskId);
  const task = loaded.record.approvals.find((item) => item.taskId === "t2");
  return { missionId, signal, task };
}

async function signDecision(owner, env, missionId, entry, decision = "approve") {
  const { approvalSigningFields } = await import("../ax-mission-policy.mjs");
  const record = (await env.missions.get(missionId)).record;
  const fields = approvalSigningFields({ mission: record, approval: entry, decision, owner: "owner" });
  return owner.sign(fields).attestation;
}

async function decide(owner, env, missionId, entry, decision = "approve") {
  const attestation = await signDecision(owner, env, missionId, entry, decision);
  return env.missions.approve({ missionId, decision, approvalId: entry.id, attestation });
}

test("revocation is audited in the registry while the mission record stops execution", async () => {
  const dir = await tempDir();
  const h = await missionSetup(dir);
  try {
    const { missionId, signal, task } = await pendingMission(h.env, "revoked");
    assert.equal((await decide(h.owner, h.env, missionId, signal)).ok, true);
    const granted = await decide(h.owner, h.env, missionId, task);
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const record = await h.env.missionStore.nonceRecord(granted.mission.approvals.find((item) => item.taskId === "t2").signed.nonce);
    assert.equal(record.status, "consumed");
    const revoked = await h.env.missions.revoke({ missionId, taskId: "t2", reason: "owner withdrew" });
    assert.equal(revoked.ok, true);
    const after = await h.env.missionStore.nonceRecord(record.nonce);
    assert.equal(after.status, "revoked");
    assert.equal(after.revoke_reason, "owner withdrew");
    await h.env.pipeline.run(missionId);
    assert.equal(h.calls.t2, 0);
    assert.equal((await h.env.missions.get(missionId)).record.tasks.find((item) => item.id === "t2").error, "approval_revoked");
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a failed mission write releases the nonce, and a failed release keeps it spent", async () => {
  const dir = await tempDir();
  const h = await missionSetup(dir);
  try {
    const { missionId, signal } = await pendingMission(h.env, "rollback");
    const signed = { attestation: await signDecision(h.owner, h.env, missionId, signal) };

    const failing = createMissionEngine({
      store: { ...h.env.missionStore, save: async () => ({ ok: false, code: "mission_conflict" }) },
      workforce: h.env.workforce,
      executors: h.env.executors,
      ownerVerifier: h.owner
    });
    const refused = await failing.approve({ missionId, decision: "approve", approvalId: signal.id, attestation: signed.attestation });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "mission_conflict");
    assert.equal(await h.env.missionStore.nonceUsed(signed.attestation.nonce), false, "compensating rollback released the nonce");

    // The verifier spends its nonce locally too, so a rollback cannot make the same signature reusable. A
    // fresh signature over the same statement is what a clean retry looks like.
    const retried = await h.env.missions.approve({
      missionId, decision: "approve", approvalId: signal.id,
      attestation: await signDecision(h.owner, h.env, missionId, signal)
    });
    assert.equal(retried.ok, true, "a fresh signed decision is retryable after rollback: " + JSON.stringify(retried));

    const { missionId: secondId, signal: secondSignal } = await pendingMission(h.env, "rollback-2");
    const secondSigned = { attestation: await signDecision(h.owner, h.env, secondId, secondSignal) };
    const noRelease = createMissionEngine({
      store: {
        ...h.env.missionStore,
        save: async () => ({ ok: false, code: "mission_conflict" }),
        releaseNonce: async () => { throw new Error("registry unavailable"); }
      },
      workforce: h.env.workforce,
      executors: h.env.executors,
      ownerVerifier: h.owner
    });
    const stranded = await noRelease.approve({ missionId: secondId, decision: "approve", approvalId: secondSignal.id, attestation: secondSigned.attestation });
    assert.equal(stranded.ok, false);
    assert.equal(await h.env.missionStore.nonceUsed(secondSigned.attestation.nonce), true, "a failed release fails closed");
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});

test("two independent runtime instances cannot consume the same approval nonce", async () => {
  const dir = await tempDir();
  const first = await missionSetup(dir);
  const secondDb = new DatabaseSync(path.join(dir, "mission.sqlite"));
  try {
    const { missionId, task: approval } = await pendingMission(first.env, "two-instances");
    const attestation = await signDecision(first.owner, first.env, missionId, approval);

    // A second runtime instance: its own database connection and its own repository over the same file.
    const secondStore = createMissionRepository({ query: sqliteQuery(secondDb) });
    assert.deepEqual(await secondStore.verifySchema(), { ok: true, missing: [], expected: 3 });
    const secondEngine = createMissionEngine({
      store: secondStore,
      workforce: first.env.workforce,
      executors: first.env.executors,
      ownerVerifier: first.owner
    });

    const results = await Promise.all([
      first.env.missions.approve({ missionId, decision: "approve", approvalId: approval.id, attestation }),
      secondEngine.approve({ missionId, decision: "approve", approvalId: approval.id, attestation })
    ]);
    assert.equal(results.filter((item) => item.ok).length, 1, "exactly one instance wins: " + JSON.stringify(results.map((item) => item.code || "ok")));
    assert.ok(results.some((item) => !item.ok), "the other instance cannot accept the same nonce");
    assert.equal((await first.env.missionStore.nonceRecord(attestation.nonce)).status, "consumed");
    const stored = (await first.env.missions.get(missionId)).record;
    assert.equal(stored.approvals.filter((item) => item.id === approval.id && item.status === "approved").length, 1);
  } finally {
    secondDb.close();
    await first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry storage failure fails the decision closed", async () => {
  const db = new DatabaseSync(":memory:");
  const broken = createMissionRepository({
    query: async (sql, params = []) => {
      if (/INSERT INTO habitat_ax_approval_nonces/i.test(sql)) throw new Error("D1 unavailable");
      return sqliteQuery(db)(sql, params);
    }
  });
  await assert.rejects(() => broken.consumeNonce({ nonce: nonce(40), missionId: "msn_a", decision: "approve" }), /D1 unavailable/);
  db.close();
});
