import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Indexed approval-nonce lookup vs the retired JSON scan.
 *
 * Seeds realistic missions (each with approvals and signed nonces), then measures random nonce lookups
 * through the primary-key registry and through the old `record_json LIKE` scan. Prints query plans so the
 * difference is visible, not just timed. Local SQLite is the closest stand-in available without touching D1.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MISSIONS = Number(process.env.BENCH_MISSIONS || 2000);
const APPROVALS = 3;
const LOOKUPS = Number(process.env.BENCH_LOOKUPS || 500);

function randomNonce(index) {
  return "nonce-" + String(index).padStart(8, "0") + "-" + "0123456789abcdef".repeat(2).slice(0, 32);
}

async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = MEMORY");
  db.exec(await readFile(path.join(ROOT, "migrations", "0011_ax_missions.sql"), "utf8"));
  db.exec(await readFile(path.join(ROOT, "migrations", "0017_ax_approval_nonces.sql"), "utf8"));

  const insertMission = db.prepare("INSERT INTO habitat_ax_missions (id, project, status, version, record_json, created_at, updated_at) VALUES (?, 'habitat', 'completed', 1, ?, ?, ?)");
  const insertNonce = db.prepare("INSERT INTO habitat_ax_approval_nonces (nonce, key_id, mission_id, approval_id, task_id, decision, issued_at, expires_at, consumed_at, status) VALUES (?, 'owner-1', ?, ?, ?, 'approve', ?, ?, ?, 'consumed')");
  const at = "2026-11-01T00:00:00.000Z";
  const seeded = [];

  db.exec("BEGIN");
  for (let mission = 0; mission < MISSIONS; mission += 1) {
    const missionId = "msn_" + String(mission).padStart(8, "0");
    const approvals = [];
    for (let index = 0; index < APPROVALS; index += 1) {
      const nonce = randomNonce(mission * APPROVALS + index);
      const approvalId = "apr:" + missionId + ":" + index;
      approvals.push({
        id: approvalId, taskId: index === 0 ? null : "t" + index, status: "approved", decision: "approved",
        decidedBy: "owner", decidedAt: at, expiresAt: "2026-11-01T00:30:00.000Z",
        action: "deploy release " + index, target: "staging", params: { region: "iad", replicas: index + 1 },
        signed: { v: 1, keyId: "owner-1", issuedAt: at, nonce, mac: "mac-" + nonce.slice(0, 12), statement: "{\"v\":1,\"nonce\":\"" + nonce + "\"}" }
      });
      seeded.push(nonce);
    }
    const record = {
      id: missionId, project: "habitat", status: "completed", version: 1,
      objective: "Deploy release " + mission + " with a realistic mission record",
      acceptanceCriteria: ["Repository analysed", "Release prepared"],
      tasks: [{ id: "t1", title: "Analyse the repository" }, { id: "t2", title: "Deploy to production" }],
      approvals, createdAt: at, updatedAt: at
    };
    insertMission.run(missionId, JSON.stringify(record), at, at);
    for (let index = 1; index < APPROVALS; index += 1) {
      insertNonce.run(randomNonce(mission * APPROVALS + index), missionId, "apr:" + missionId + ":" + index, "t" + index, at, "2026-11-01T00:30:00.000Z", at);
    }
  }
  db.exec("COMMIT");

  const indexedPlan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 AS used FROM habitat_ax_approval_nonces WHERE nonce = ? LIMIT 1").all(seeded[0]);
  const legacyPlan = db.prepare("EXPLAIN QUERY PLAN SELECT record_json FROM habitat_ax_missions WHERE record_json LIKE ? LIMIT 5").all('%"nonce":"' + seeded[0] + '"%');

  const indexed = db.prepare("SELECT 1 AS used FROM habitat_ax_approval_nonces WHERE nonce = ? LIMIT 1");
  const legacy = db.prepare("SELECT record_json FROM habitat_ax_missions WHERE record_json LIKE ? LIMIT 5");
  const sample = Array.from({ length: LOOKUPS }, () => seeded[Math.floor(Math.random() * seeded.length)]);

  const time = (fn) => {
    const start = performance.now();
    for (const nonce of sample) fn(nonce);
    return performance.now() - start;
  };
  legacy.all(seeded[0]); // warm page cache for both sides
  const legacyMs = time((nonce) => legacy.all('%"nonce":"' + nonce + '"%'));
  const indexedMs = time((nonce) => indexed.all(nonce));

  const report = {
    environment: "node:sqlite in-memory, local only (not D1)",
    missions: MISSIONS,
    approvalsPerMission: APPROVALS,
    nonceRows: MISSIONS * (APPROVALS - 1),
    lookups: LOOKUPS,
    indexed: { totalMs: Number(indexedMs.toFixed(2)), perLookupMs: Number((indexedMs / LOOKUPS).toFixed(4)), plan: indexedPlan.map((row) => row.detail) },
    legacy: { totalMs: Number(legacyMs.toFixed(2)), perLookupMs: Number((legacyMs / LOOKUPS).toFixed(4)), plan: legacyPlan.map((row) => row.detail) },
    speedup: Number((legacyMs / Math.max(indexedMs, 0.001)).toFixed(1))
  };
  console.log(JSON.stringify(report, null, 2));
  db.close();
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
});
