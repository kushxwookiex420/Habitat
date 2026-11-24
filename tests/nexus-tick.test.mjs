import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runTick } from "../scripts/nexus-tick.mjs";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";

/**
 * The scheduler entrypoint, exercised through its real code path with SQLite behind the D1 HTTP
 * shape. Everything below the transport is production code: repository, engine, worker, adapters,
 * queue health and exit-code selection.
 *
 * This is NOT a live Cloudflare D1 test and proves nothing about a deployment.
 */

const CREDS = {
  CLOUDFLARE_ACCOUNT_ID: "acct-tick",
  HABITAT_D1_DATABASE_ID: "db-tick-0001",
  HABITAT_D1_API_TOKEN: "d1_token_tick_" + "x".repeat(20),
  NEXUS_RUNTIME_ENABLED: "true"
};

const quiet = { log() {}, warn() {}, error() {} };

function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const urls = [];
  const fetchImpl = async (url, init = {}) => {
    urls.push(String(url));
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
  const repository = createD1CommandTaskRepository({
    accountId: CREDS.CLOUDFLARE_ACCOUNT_ID,
    databaseId: CREDS.HABITAT_D1_DATABASE_ID,
    apiToken: CREDS.HABITAT_D1_API_TOKEN,
    fetchImpl
  });
  return { db, urls, fetchImpl, repository };
}

function queuedTask(id, { adapter = "runtime.health", ageSeconds = 0 } = {}) {
  const at = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return {
    id,
    objective: "report runtime health",
    role: "ax",
    requestedBy: "ax",
    status: "queued",
    adapter,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
    history: []
  };
}

test("one tick claims and executes eligible work, then reports it", async () => {
  const d1 = sqliteD1();
  await d1.repository.initialize();
  await d1.repository.create(queuedTask("cmd_tick_1"));

  const { exitCode, report } = await runTick({ env: { ...CREDS }, fetchImpl: d1.fetchImpl, log: quiet });

  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(report.ok, true);
  assert.equal(report.state, "ticked");
  assert.equal(report.tick.ok, true);
  assert.equal(report.tick.claimed, 1, "exactly one task was claimed");
  assert.equal(report.tick.completed, 1, "the adapter ran and completion was recorded");
  assert.equal(report.queue.eligible, 0, "the queue is drained");
  assert.equal(report.staleQueue, false);

  const stored = await d1.repository.get("cmd_tick_1");
  assert.equal(stored.status, "done");
  assert.equal(stored.adapter, "runtime.health");
  assert.ok(stored.result.evidence.some(line => line.startsWith("runtime:")), "the adapter's own evidence is stored");

  // The report is additive evidence, not a claim: it names no credential.
  assert.equal(JSON.stringify(report).includes(CREDS.HABITAT_D1_API_TOKEN), false);
  assert.equal(d1.urls.every(url => url.includes(CREDS.HABITAT_D1_DATABASE_ID)), true);
});

test("a second tick on an empty queue claims nothing and still succeeds", async () => {
  const d1 = sqliteD1();
  await d1.repository.initialize();
  await d1.repository.create(queuedTask("cmd_tick_2"));

  await runTick({ env: { ...CREDS }, fetchImpl: d1.fetchImpl, log: quiet });
  const second = await runTick({ env: { ...CREDS }, fetchImpl: d1.fetchImpl, log: quiet });

  assert.equal(second.exitCode, 0);
  assert.equal(second.report.tick.ok, true);
  assert.equal(second.report.tick.claimed, 0);
  assert.equal(second.report.queue.eligible, 0);
});

test("a task that names no adapter is left for a human and does not count as stale work", async () => {
  const d1 = sqliteD1();
  await d1.repository.initialize();
  await d1.repository.create({ ...queuedTask("cmd_no_adapter"), adapter: null });

  const { exitCode, report } = await runTick({ env: { ...CREDS }, fetchImpl: d1.fetchImpl, log: quiet });

  assert.equal(exitCode, 0);
  assert.equal(report.tick.claimed, 0);
  assert.equal(report.queue.eligible, 0, "not claimable by design");
  assert.equal(report.queue.blocked, 1, "reported, not silently ignored");
  const stored = await d1.repository.get("cmd_no_adapter");
  assert.equal(stored.status, "queued", "an adapter-less row is never executed");
});

test("a tick that leaves eligible work waiting past the deadline exits 2 (operational alarm)", async () => {
  const d1 = sqliteD1();
  await d1.repository.initialize();
  // Two old, claimable tasks: one tick can take only one, so the backlog is still stale afterwards.
  await d1.repository.create(queuedTask("cmd_stale_1", { ageSeconds: 3600 }));
  await d1.repository.create(queuedTask("cmd_stale_2", { ageSeconds: 3000 }));

  const { exitCode, report } = await runTick({
    env: { ...CREDS, NEXUS_STALE_QUEUE_SECONDS: "60" },
    fetchImpl: d1.fetchImpl,
    log: quiet
  });

  assert.equal(exitCode, 2, JSON.stringify(report));
  assert.equal(report.ok, true, "the tick itself succeeded — throughput is the problem");
  assert.equal(report.state, "queue_stale");
  assert.equal(report.staleQueue, true);
  assert.equal(report.queue.stale, true);
  assert.ok(report.queue.oldestEligibleAgeSeconds >= 60);
  assert.equal(report.queue.eligible, 1);
});

test("missing D1 configuration exits 3 without contacting anything", async () => {
  let contacted = 0;
  const fetchImpl = async () => { contacted += 1; throw new Error("must not be called"); };

  const { exitCode, report } = await runTick({ env: {}, fetchImpl, log: quiet });

  assert.equal(exitCode, 3);
  assert.equal(report.ok, false);
  assert.equal(report.state, "disabled");
  assert.equal(report.reason, "missing_configuration");
  assert.deepEqual(report.missing.sort(), ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_API_TOKEN", "HABITAT_D1_DATABASE_ID"].sort());
  assert.equal(contacted, 0, "a disabled tick makes no request");
});

test("a tick with execution disabled exits 3 and executes nothing", async () => {
  let contacted = 0;
  const fetchImpl = async () => { contacted += 1; throw new Error("must not be called"); };
  const { exitCode, report } = await runTick({
    env: { ...CREDS, NEXUS_RUNTIME_ENABLED: "false" },
    fetchImpl,
    log: quiet
  });

  assert.equal(exitCode, 3);
  assert.equal(report.ok, false);
  assert.equal(report.state, "disabled");
  assert.match(report.reason, /NEXUS_RUNTIME_ENABLED/);
  assert.equal(contacted, 0, "a disabled tick makes no request");
});

test("an invalid worker setting exits 3 and explains which variable", async () => {
  const { exitCode, report } = await runTick({
    env: { ...CREDS, NEXUS_HEARTBEAT_SECONDS: "5" },
    fetchImpl: async () => { throw new Error("must not be called"); },
    log: quiet
  });

  assert.equal(exitCode, 3);
  assert.equal(report.state, "invalid_configuration");
  assert.match(report.reason, /NEXUS_HEARTBEAT_SECONDS/);
});

test("an unreachable database exits 1 with the real error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, async json() { return { success: false, errors: [{ message: "down" }] }; } });

  const { exitCode, report } = await runTick({ env: { ...CREDS }, fetchImpl, log: quiet });

  assert.equal(exitCode, 1, JSON.stringify(report));
  assert.equal(report.ok, false);
  assert.equal(report.state, "failed");
  assert.match(report.error, /D1 command query failed|HTTP 503/);
});

test("the CLI prints one JSON line and uses the same exit code", async () => {
  const child = spawn(process.execPath, ["scripts/nexus-tick.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", HABITAT_D1_DATABASE_ID: "", HABITAT_D1_API_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  await new Promise(resolve => child.on("close", resolve));

  assert.equal(child.exitCode, 3);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, "stdout is a single JSON line");
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.state, "disabled");
});
