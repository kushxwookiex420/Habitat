import { performance } from "node:perf_hooks";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { createSecurityEventService } from "../ax-security-events.mjs";
import { createMemorySecurityEventRepository } from "../ax-security-event-repository.mjs";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";

/**
 * Local latency measurements with bounded data.
 *
 * These numbers describe this machine and in-memory stores. They are not D1, Render, or browser
 * measurements, and the report says so rather than presenting them as production latency.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(3));
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: percentile(values, 100),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(3))
  };
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

export async function runPerformanceCheck() {
  const samples = {};
  const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository() });
  const created = await objectives.create({
    objective: "Latency check objective",
    criteria: ["A child execution is reserved and settled once"],
    key: "perf-" + Date.now(),
    budgetUsd: 1
  });
  const id = created.objective.id;
  await objectives.understand(id, { summary: "Measure bounded local operations." });
  await objectives.plan(id, { steps: [{ objective: "inspect", agent: "engineering" }] });
  await objectives.start(id);

  const dispatch = [];
  for (let index = 0; index < 100; index += 1) {
    const outcome = await timed(() => objectives.reserveExecution(id, { executionId: "perf-run-" + index, estimateUsd: 0.001 }));
    dispatch.push(outcome.ms);
  }
  samples.reservationMs = summarize(dispatch);

  const settle = [];
  for (let index = 0; index < 100; index += 1) {
    const outcome = await timed(() => objectives.settleExecution(id, { executionId: "perf-run-" + index, actualUsd: 0.0001, runId: "run_" + index }));
    settle.push(outcome.ms);
  }
  samples.settlementMs = summarize(settle);

  const reads = [];
  for (let index = 0; index < 200; index += 1) {
    const outcome = await timed(() => objectives.get(id));
    reads.push(outcome.ms);
  }
  samples.repositoryReadMs = summarize(reads);

  const securityRepository = createMemorySecurityEventRepository();
  const security = createSecurityEventService({ repository: securityRepository });
  const appends = [];
  for (let index = 0; index < 200; index += 1) {
    const outcome = await timed(() => security.record({ category: "auth.failure", summary: "perf event " + index }));
    appends.push(outcome.ms);
  }
  samples.securityAppendMs = summarize(appends);
  const verify = [];
  for (let index = 0; index < 20; index += 1) {
    const outcome = await timed(() => security.integrity());
    verify.push(outcome.ms);
  }
  samples.securityVerify200Ms = summarize(verify);

  const ticks = createMemorySchedulerRepository();
  const scheduler = createSchedulerService({ ticks, objectives });
  const tickDurations = [];
  for (let index = 0; index < 20; index += 1) {
    const outcome = await timed(() => scheduler.tick({ trigger: "perf" }));
    tickDurations.push(outcome.ms);
  }
  samples.schedulerTickMs = summarize(tickDurations);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()?.[0]?.model || "unknown",
      cpuCount: os.cpus()?.length || null,
      totalMemoryBytes: os.totalmem(),
      storage: "in-memory repositories; no D1, no network",
      note: "Local bounded measurements only. Not production latency and not a capacity claim."
    },
    samples,
    data: {
      reservations: 100,
      settlements: 100,
      objectiveReads: 200,
      securityEvents: 200,
      schedulerTicks: 20
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runPerformanceCheck();
  await mkdir(path.join(ROOT, "release"), { recursive: true });
  await writeFile(path.join(ROOT, "release", "perf-mission-12.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: report.ok, samples: report.samples, artifact: "release/perf-mission-12.json" }, null, 2));
}
