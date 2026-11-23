import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteSchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "scheduler-process.mjs");

async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "habitat-scheduler-"));
  return { directory, filename: path.join(directory, "scheduler.sqlite") };
}

function runProcess(filename, action, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, filename, action, ...args.map(String)], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error("fixture exited " + code + ": " + stderr.slice(-500)));
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      try { resolve(JSON.parse(line)); } catch { reject(new Error("bad fixture output: " + stdout.slice(-500))); }
    });
  });
}

test("a lease held by one process refuses a tick in another process", async () => {
  const { directory, filename } = await workspace();
  try {
    const repo = createSqliteSchedulerRepository({ filename });
    const acquired = await repo.acquire({ tickId: "holder", owner: "parent", ttlMs: 60_000, nowMs: Date.now() });
    assert.equal(acquired.ok, true);
    const blocked = await runProcess(filename, "tick");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "tick_overlap");
    await repo.complete({ tickId: "holder", status: "ok", detail: "released", nowIso: new Date().toISOString() });
    const after = await runProcess(filename, "tick");
    assert.equal(after.ok, true);
    repo.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an expired lease is taken over by another process and the stale holder loses every write", async () => {
  const { directory, filename } = await workspace();
  try {
    const repo = createSqliteSchedulerRepository({ filename });
    const t0 = Date.now();
    const acquired = await repo.acquire({ tickId: "stale-holder", owner: "parent", ttlMs: 1_000, nowMs: t0 });
    assert.equal(acquired.ok, true);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const takeover = await runProcess(filename, "tick");
    assert.equal(takeover.ok, true);

    const heartbeat = await repo.heartbeat({ tickId: "stale-holder", ttlMs: 60_000, nowMs: t0 + 1_200 });
    assert.equal(heartbeat.ok, false);
    assert.equal(heartbeat.code, "lease_lost");
    const complete = await repo.complete({ tickId: "stale-holder", status: "ok", detail: "stale", nowIso: new Date().toISOString() });
    assert.equal(complete.ok, false);
    assert.equal(complete.code, "lease_lost");
    const state = await repo.status();
    assert.notEqual(state.lease?.tickId, "stale-holder");
    repo.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("four processes starting together produce exactly one tick, then state survives restart", async () => {
  const { directory, filename } = await workspace();
  try {
    const startAt = Date.now() + 900;
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => runProcess(filename, "tick", [], {
      FIXTURE_START_AT: String(startAt),
      FIXTURE_TICK_DELAY_MS: "300"
    })));
    assert.equal(outcomes.filter(item => item.ok === true).length, 1, JSON.stringify(outcomes.map(item => item.code || "ok")));
    assert.equal(outcomes.filter(item => item.code === "tick_overlap").length, 3);

    const restarted = await runProcess(filename, "status");
    assert.ok(restarted.lastSuccessAt, "a new process reads the successful tick from disk");
    assert.equal(restarted.tickCount, 1);
    assert.equal(restarted.lease, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missed ticks are detected from durable state after a gap", async () => {
  const { directory, filename } = await workspace();
  try {
    const repo = createSqliteSchedulerRepository({ filename });
    await repo.acquire({ tickId: "old", owner: "fixture", ttlMs: 1_000, nowMs: Date.parse("2026-11-22T11:50:00.000Z") });
    await repo.complete({ tickId: "old", status: "ok", detail: "old", nowIso: "2026-11-22T11:50:00.000Z" });
    const service = createSchedulerService({
      ticks: repo,
      now: () => "2026-11-22T12:00:00.000Z",
      nowMs: () => Date.parse("2026-11-22T12:00:00.000Z"),
      tickIntervalMs: 60_000
    });
    const status = await service.status();
    assert.ok(status.scheduler.missedTicks >= 8);
    assert.equal(status.scheduler.status, "degraded");
    repo.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scheduler tick reconciles a stale reservation but keeps one with a live bound run", async () => {
  let clock = Date.parse("2026-11-22T12:00:00.000Z");
  const now = () => new Date(clock).toISOString();
  const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository(), now });
  const created = await objectives.create({ objective: "Scheduler accounting recovery", criteria: ["No duplicate charge"], key: "sched-rec", budgetUsd: 0.05 });
  const id = created.objective.id;
  await objectives.understand(id, { summary: "Crash after reservation." });
  await objectives.plan(id, { steps: [{ objective: "inspect", agent: "engineering" }] });
  await objectives.start(id);
  await objectives.reserveExecution(id, { executionId: "unbound", estimateUsd: 0.01 });
  await objectives.reserveExecution(id, { executionId: "bound-live", estimateUsd: 0.01 });
  await objectives.linkExecutionRun(id, { executionId: "bound-live", runId: "run_live" });
  clock += 31 * 60_000;

  const ticks = createSqliteSchedulerRepository({ filename: path.join(await mkdtemp(path.join(tmpdir(), "habitat-sched-rec-")), "s.sqlite") });
  const scheduler = createSchedulerService({
    ticks,
    objectives,
    runs: { async getRun(runId) { return runId === "run_live" ? { id: runId } : null; } },
    now,
    nowMs: () => clock
  });
  const tick = await scheduler.tick();
  assert.equal(tick.ok, true);
  assert.equal(tick.reconciledReservations, 1);
  assert.ok(tick.findings.some(item => item.kind === "accounting.reservation_released"));
  const accounting = await objectives.accounting(id);
  assert.equal(accounting.reservedUsd, 0.01);
  assert.equal(accounting.executions.find(row => row.executionId === "unbound").status, "released");
  assert.equal(accounting.executions.find(row => row.executionId === "bound-live").status, "reserved");
  ticks.close();
});
