#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";
import {
  createD1Query,
  createNexusWorker,
  readQueueHealth,
  resolveNexusConfig,
  NEXUS_HEARTBEAT_TABLE_SQL
} from "../nexus-runtime.mjs";
import { createUniversalCommandEngine } from "../universal-command-engine.mjs";
import { createToolRegistry } from "../tool-registry.mjs";
import { buildReadOnlyNexusAdapters, READ_ONLY_ADAPTER_PREFIXES } from "../nexus-adapter-registration.mjs";

/**
 * One-shot Nexus tick.
 *
 * Executes at most one unit of work and exits. It is the scheduler entrypoint: nothing here keeps a
 * process alive, holds a socket, or starts a timer, so it is safe for a Render Cron Job or any other
 * process-per-run scheduler. All state is read from and written to D1, so an interrupted run is
 * recovered by the ordinary lease path on a later tick.
 *
 * Exit codes (a non-zero code is what a scheduler's failure notification reacts to):
 *   0  tick completed and no eligible work is waiting past the stale deadline
 *   1  tick failed — D1 unreachable, schema unavailable, claim failed, or an unexpected error
 *   2  tick completed but the queue is stale: eligible work has waited past
 *      NEXUS_STALE_QUEUE_SECONDS. Throughput or scheduling is the problem, not correctness.
 *   3  not runnable — required D1 configuration missing or invalid, or NEXUS_RUNTIME_ENABLED is not
 *      exactly "true". Nothing was attempted.
 *
 * stdout is exactly one JSON line and contains no credential, so it can be captured as evidence.
 */

const REQUIRED_ENV = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"];
const SCHEMA_VERSION = 1;

export function missingConfiguration(env = {}) {
  return REQUIRED_ENV.filter(key => !String(env?.[key] || "").trim());
}

function commandD1(env) {
  return {
    accountId: String(env.CLOUDFLARE_ACCOUNT_ID || "").trim(),
    databaseId: String(env.HABITAT_D1_DATABASE_ID || "").trim(),
    apiToken: String(env.HABITAT_D1_API_TOKEN || "").trim()
  };
}

function reportOf(extra) {
  return { schemaVersion: SCHEMA_VERSION, ...extra };
}

function configSummary(config) {
  return {
    pollMs: config.pollMs,
    leaseMs: config.leaseMs,
    maxAttempts: config.maxAttempts,
    heartbeatSeconds: config.heartbeatMs / 1000,
    retentionDays: config.retentionDays,
    staleQueueSeconds: config.staleQueueMs / 1000
  };
}

/**
 * Run exactly one tick. Exported for tests: they drive it with a SQLite-backed fetch shim, which is
 * the same code path a deployment takes apart from the network transport.
 */
export async function runTick({ env = process.env, fetchImpl = fetch, rootDir = process.cwd(), log = console } = {}) {
  const startedAt = new Date().toISOString();
  const missing = missingConfiguration(env);
  if (missing.length) {
    return {
      exitCode: 3,
      report: reportOf({
        ok: false,
        state: "disabled",
        reason: "missing_configuration",
        missing,
        tickStartedAt: startedAt,
        finishedAt: new Date().toISOString()
      })
    };
  }

  // One switch for "NEXUS may execute", shared with the mounted runtime. A cron job created by
  // mistake, or left behind after the feature is turned off, must not execute work on its own.
  if (String(env.NEXUS_RUNTIME_ENABLED || "").trim().toLowerCase() !== "true") {
    return {
      exitCode: 3,
      report: reportOf({
        ok: false,
        state: "disabled",
        reason: "NEXUS_RUNTIME_ENABLED is not true",
        tickStartedAt: startedAt,
        finishedAt: new Date().toISOString()
      })
    };
  }

  let config = null;
  try {
    config = resolveNexusConfig(env);
  } catch (error) {
    return {
      exitCode: 3,
      report: reportOf({
        ok: false,
        state: "invalid_configuration",
        reason: String(error?.message || error),
        tickStartedAt: startedAt,
        finishedAt: new Date().toISOString()
      })
    };
  }

  try {
    const d1 = commandD1(env);
    const repository = createD1CommandTaskRepository({ ...d1, fetchImpl });
    const query = createD1Query({ ...d1, fetchImpl });
    // Idempotent DDL: a first run against an empty database is a supported case.
    await repository.initialize();
    await query(NEXUS_HEARTBEAT_TABLE_SQL);

    const engine = createUniversalCommandEngine({ repository, registry: createToolRegistry({ env }) });
    const adapters = buildReadOnlyNexusAdapters({
      rootDir,
      allowedPrefixes: READ_ONLY_ADAPTER_PREFIXES,
      taskRepository: repository,
      d1Query: query
    });
    const worker = createNexusWorker({ repository, engine, query, adapters, ...config, log });

    const tick = await worker.tick();
    const tickFailed = tick?.ok === false;

    let queue = { ok: false, error: "unavailable" };
    try {
      queue = { ok: true, ...(await readQueueHealth(query, { staleAfterMs: config.staleQueueMs })) };
    } catch (error) {
      log.warn?.("NEXUS_TICK: queue read failed: " + String(error?.message || error));
    }
    const staleQueue = queue.ok === true && queue.stale === true;

    return {
      exitCode: tickFailed ? 1 : staleQueue ? 2 : 0,
      report: reportOf({
        ok: !tickFailed,
        state: tickFailed ? "tick_failed" : staleQueue ? "queue_stale" : "ticked",
        workerId: worker.workerId,
        tickStartedAt: startedAt,
        finishedAt: new Date().toISOString(),
        tick,
        counters: worker.counters(),
        queue,
        staleQueue,
        heartbeat: worker.heartbeat(),
        config: configSummary(config)
      })
    };
  } catch (error) {
    return {
      exitCode: 1,
      report: reportOf({
        ok: false,
        state: "failed",
        reason: "tick_error",
        error: String(error?.message || error).slice(0, 500),
        tickStartedAt: startedAt,
        finishedAt: new Date().toISOString(),
        config: configSummary(config)
      })
    };
  }
}

export async function main({ env = process.env, fetchImpl = fetch, rootDir = process.cwd(), stdout = process.stdout, log = console } = {}) {
  const { exitCode, report } = await runTick({ env, fetchImpl, rootDir, log });
  stdout.write(JSON.stringify(report) + "\n");
  return exitCode;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, state: "crashed", error: String(error?.message || error) }) + "\n");
      process.exitCode = 1;
    }
  );
}
