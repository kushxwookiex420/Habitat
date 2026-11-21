#!/usr/bin/env node
/**
 * ISOLATED LIVE D1 VERIFICATION — run only against a disposable database.
 *
 * Usage (from the Habitat repo root):
 *   CLOUDFLARE_ACCOUNT_ID=... HABITAT_D1_API_TOKEN=... \
 *   NEXUS_D1_TEST_DATABASE_ID=<disposable-db-id> NEXUS_D1_TEST_CONFIRM=isolated \
 *   node scripts/d1-live-test.mjs
 *
 * Safety:
 *  - Refuses to run unless NEXUS_D1_TEST_CONFIRM=isolated.
 *  - Refuses if NEXUS_D1_TEST_DATABASE_ID equals HABITAT_D1_DATABASE_ID.
 *  - Every record it creates is prefixed `itest-<run>-`; cleanup only deletes that prefix.
 *  - It never reads or writes any other task record.
 *
 * This script has NOT been executed in this environment: no D1 credentials are available.
 */

import { randomUUID } from "node:crypto";
import { createD1Query, NEXUS_CLAIM_SQL, NEXUS_RENEW_SQL, NEXUS_REQUEUE_SQL, NEXUS_EXPIRED_SQL, NEXUS_SEIZE_SQL } from "../nexus-runtime.mjs";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";
import { createUniversalCommandEngine } from "../universal-command-engine.mjs";

const env = process.env;
const fail = message => { console.error("REFUSING:", message); process.exit(2); };

if (String(env.NEXUS_D1_TEST_CONFIRM || "") !== "isolated") fail("set NEXUS_D1_TEST_CONFIRM=isolated to confirm this is a disposable database");
const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const apiToken = String(env.HABITAT_D1_API_TOKEN || "").trim();
const databaseId = String(env.NEXUS_D1_TEST_DATABASE_ID || "").trim();
if (!accountId || !apiToken || !databaseId) fail("CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_API_TOKEN and NEXUS_D1_TEST_DATABASE_ID are required");
const productionId = String(env.HABITAT_D1_DATABASE_ID || "").trim();
if (!productionId) fail("HABITAT_D1_DATABASE_ID is required for the isolation comparison");
if (productionId === databaseId) fail("test database id matches the production database id");

const query = createD1Query({ accountId, databaseId, apiToken });
const repository = createD1CommandTaskRepository({ accountId, databaseId, apiToken });
const registry = { get: name => ({ name, roles: ["ax"], availability: { state: "available", detail: "test" } }), approvalRequiredFor: () => ({ required: false, known: true }), summary: () => ({ ok: true, count: 0, tools: [] }) };
const engine = createUniversalCommandEngine({ repository, registry });

const run = "itest-" + Date.now() + "-";
const ids = [];
const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}
function record(label, extra = {}) {
  const id = run + label;
  ids.push(id);
  return {
    id, objective: "isolated D1 verification " + label, role: "ax", status: "queued",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 0, approvals: [], statusHistory: [], result: null, error: null, ...extra
  };
}
const claimParams = (worker, leaseMs, fence) => [worker, new Date(Date.now() + leaseMs).toISOString(), fence, new Date().toISOString(), new Date().toISOString()];
const rows = reply => reply?.[0]?.results || [];
async function retireQueuedTestTask(id) {
  const timestamp = new Date().toISOString();
  await query(
    "UPDATE habitat_command_tasks SET status = 'done', record_json = json_set(record_json, '$.status', 'done', '$.updatedAt', ?), updated_at = ? WHERE id = ?",
    [timestamp, timestamp, id]
  );
}

async function main() {
  console.log("Target D1 database:", databaseId, "(disposable, confirmed isolated)");
  await repository.initialize();
  await query("CREATE TABLE IF NOT EXISTS habitat_nexus_workers (worker_id TEXT PRIMARY KEY NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, state TEXT NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, detail TEXT)");

  // 1. creation and retrieval
  const created = record("create");
  await repository.create(created);
  const fetched = await repository.get(created.id);
  check("task creation and retrieval", fetched?.id === created.id && fetched?.objective === created.objective);
  // The claim SQL intentionally claims the oldest queued task globally; retire this fixture
  // so it cannot be mistaken for the dedicated claim fixture in the next check.
  await retireQueuedTestTask(created.id);

  // 2. claim acquisition (exactly once)
  const claimTask = record("claim");
  await repository.create(claimTask);
  let claimed = rows(await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-a", 60_000, "fence-claim-a")));
  const again = rows(await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-b", 60_000, "fence-claim-b")));
  check("claim acquisition", claimed.length === 1 && again.length === 0, "first=" + claimed.length + " second=" + again.length);
  const claimFence = JSON.parse(claimed[0]?.record_json || "{}").fence;

  // 3. lease renewal
  const renewed = rows(await query(NEXUS_RENEW_SQL, [new Date(Date.now() + 120_000).toISOString(), new Date().toISOString(), new Date().toISOString(), claimTask.id, claimFence]));
  const wrongRenew = rows(await query(NEXUS_RENEW_SQL, [new Date(Date.now() + 120_000).toISOString(), new Date().toISOString(), new Date().toISOString(), claimTask.id, "not-the-fence"]));
  check("lease renewal (owner only)", renewed.length === 1 && wrongRenew.length === 0);

  // 4. lease expiration and takeover
  const expired = record("expire");
  await repository.create(expired);
  const expClaim = rows(await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-a", 200, "fence-exp")));
  await new Promise(resolve => setTimeout(resolve, 300));
  const expiredRows = rows(await query(NEXUS_EXPIRED_SQL, [new Date().toISOString(), new Date(Date.now() - 200).toISOString()]));
  const requeued = rows(await query(NEXUS_REQUEUE_SQL, [1, new Date().toISOString(), new Date().toISOString(), expired.id, "fence-exp"]));
  const takeover = rows(await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-b", 60_000, "fence-take")));
  check("lease expiration and takeover", expClaim.length === 1 && expiredRows.some(row => row.id === expired.id) && requeued.length === 1 && takeover.length === 1);

  // 5. stale completion rejection (A holds old fence, B owns the row)
  const staleTask = record("stale-complete");
  await repository.create(staleTask);
  await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-a", 60_000, "fence-old"));
  await query(NEXUS_REQUEUE_SQL, [1, new Date().toISOString(), new Date().toISOString(), staleTask.id, "fence-old"]);
  await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-b", 60_000, "fence-new"));
  const staleComplete = await engine.complete({ taskId: staleTask.id, verifiedBy: "itest-worker-a", claim: { fence: "fence-old", workerId: "itest-worker-a" }, result: { summary: "stale completion", evidence: ["test"] } });
  const afterStale = await repository.get(staleTask.id);
  check("stale completion rejection", staleComplete.code === "stale_claim" && afterStale?.status === "working" && afterStale?.claimedBy === "itest-worker-b", "code=" + staleComplete.code);

  // 6. stale failure rejection
  const staleFail = await engine.fail({ taskId: staleTask.id, error: "stale failure", by: "itest-worker-a", claim: { fence: "fence-old", workerId: "itest-worker-a" } });
  const afterFail = await repository.get(staleTask.id);
  check("stale failure rejection", staleFail.code === "stale_claim" && afterFail?.status === "working");

  // 7. concurrent completion: exactly one winner
  const conc = record("concurrent");
  await repository.create(conc);
  await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-c", 60_000, "fence-c"));
  const [c1, c2] = await Promise.all([
    engine.complete({ taskId: conc.id, verifiedBy: "itest-worker-c", claim: { fence: "fence-c", workerId: "itest-worker-c" }, result: { summary: "first", evidence: ["a"] } }),
    engine.complete({ taskId: conc.id, verifiedBy: "itest-worker-c", claim: { fence: "fence-c", workerId: "itest-worker-c" }, result: { summary: "second", evidence: ["b"] } })
  ]);
  check("concurrent completion", [c1, c2].filter(outcome => outcome.ok).length === 1, "winners=" + [c1, c2].filter(o => o.ok).length);

  // 8. approval followed by execution
  const appr = record("approval");
  await repository.create(appr);
  const requested = await engine.requestApproval({ taskId: appr.id, reason: "isolated verification", by: "ax" });
  const approved = await engine.approve({ taskId: appr.id, by: "owner" });
  const apprClaim = rows(await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-d", 60_000, "fence-appr")));
  const apprFence = JSON.parse(apprClaim[0]?.record_json || "{}").fence;
  const apprDone = await engine.complete({ taskId: appr.id, verifiedBy: "itest-worker-d", claim: { fence: apprFence, workerId: "itest-worker-d" }, result: { summary: "approved and executed", evidence: ["approval.txt"] } });
  check("approval followed by execution", requested.ok && approved.ok && apprClaim.length === 1 && apprDone.ok, "status=" + (await repository.get(appr.id))?.status);

  // 9. recovery racing completion
  const race = record("race");
  await repository.create(race);
  await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-e", 200, "fence-race"));
  await new Promise(resolve => setTimeout(resolve, 300));
  const [completion, recovery] = await Promise.all([
    engine.complete({ taskId: race.id, verifiedBy: "itest-worker-e", claim: { fence: "fence-race", workerId: "itest-worker-e" }, result: { summary: "raced", evidence: ["a"] } }),
    query(NEXUS_REQUEUE_SQL, [1, new Date().toISOString(), new Date().toISOString(), race.id, "fence-race"])
  ]);
  const raceRow = await repository.get(race.id);
  const recoveryWon = rows(recovery).length === 1;
  check("recovery racing completion", !(completion.ok && recoveryWon) && ((completion.ok && raceRow?.status === "done") || (!completion.ok && raceRow?.status === "queued")), "status=" + raceRow?.status);
  // If recovery wins, it deliberately leaves this task queued. Retire the fixture so the
  // next global claim targets the exhausted-takeover fixture, not this earlier race fixture.
  await retireQueuedTestTask(race.id);

  // 10. exhausted takeover uses the same fence guard
  const exhausted = record("exhausted");
  await repository.create(exhausted);
  await query(NEXUS_CLAIM_SQL, claimParams("itest-worker-f", 200, "fence-ex"));
  await new Promise(resolve => setTimeout(resolve, 300));
  const seized = rows(await query(NEXUS_SEIZE_SQL, ["itest-worker-g", "fence-takeover", new Date().toISOString(), new Date().toISOString(), exhausted.id, "fence-ex"]));
  const seizedAgain = rows(await query(NEXUS_SEIZE_SQL, ["itest-worker-h", "fence-takeover-2", new Date().toISOString(), new Date().toISOString(), exhausted.id, "fence-ex"]));
  check("exhausted takeover is single-winner", seized.length === 1 && seizedAgain.length === 0);

  const failed = results.filter(result => !result.ok);
  console.log("\nSUMMARY: " + (results.length - failed.length) + "/" + results.length + " live D1 checks passed.");
  if (failed.length) process.exitCode = 1;
}

main()
  .catch(error => { console.error("LIVE D1 TEST ERROR:", String(error?.message || error)); process.exitCode = 1; })
  .finally(async () => {
    try {
      for (const id of ids) await query("DELETE FROM habitat_command_tasks WHERE id = ?", [id]);
      console.log("Cleaned up " + ids.length + " isolated test record(s).");
    } catch (error) {
      console.error("CLEANUP FAILED (only prefixed test ids are targeted):", String(error?.message || error));
    }
  });
