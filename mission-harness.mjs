import { DatabaseSync } from "node:sqlite";
import { createD1CommandTaskRepository } from "./d1-command-task-repository.mjs";
import { createUniversalCommandEngine } from "./universal-command-engine.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { createMissionRepository } from "./d1-mission-repository.mjs";
import { createWorkforceRepository } from "./d1-workforce-repository.mjs";
import { createDurableWorkforce } from "./ax-durable-workforce.mjs";
import { createMissionEngine } from "./ax-mission-engine.mjs";
import { createWorkerExecutors, EXECUTOR_ADAPTERS, WORKER_ADAPTER_KINDS, WORKER_SPECS } from "./worker-executors.mjs";
import { createMissionExecutors, createMissionPipeline, registerMissionWorkforce } from "./mission-pipeline.mjs";

/**
 * The whole mission stack in one place, wired the way a deployment wires it:
 *
 *   SQLite behind the same D1 HTTP shape  →  command task repository + mission store + workforce store
 *   real specialist adapters              →  durable workforce registry
 *   worker executors                      →  mission engine executors
 *   command engine → mission pipeline     →  objective in, verified mission out
 *
 * A deployment swaps the query function for the D1 HTTP client; nothing else changes. This harness is
 * used by the integration tests and by the end-to-end demonstration, so they exercise the same path.
 */
export async function buildMissionEnvironment({
  rootDir = process.cwd(),
  artifactsDir = ".scratch/mission-artifacts",
  health = async () => ({ status: "ready", checks: { storage: true } }),
  now = () => new Date().toISOString(),
  log = { log() {}, warn() {}, error() {} },
  maxTaskAttempts = 1,
  maxRepairs = 1,
  verifierOverride = null,
  dbPath = ":memory:",
  env = {}
} = {}) {
  const db = new DatabaseSync(dbPath);
  // The command-task table is created by the service's migrations; this table matches the columns the
  // repository reads and writes, so the same repository code runs unchanged.
  db.exec("CREATE TABLE IF NOT EXISTS habitat_command_tasks (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const query = async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    const info = statement.run(...params);
    return [{ changes: Number(info.changes || 0) }];
  };

  const missionStore = createMissionRepository({ query, now });
  await missionStore.initialize();
  const workforceRepo = createWorkforceRepository({ query, now });
  await workforceRepo.initialize();

  const workforce = createDurableWorkforce({ repository: workforceRepo, adapters: EXECUTOR_ADAPTERS, now, log });
  const registeredAdapters = [];
  for (const adapter of EXECUTOR_ADAPTERS) {
    const outcome = await workforce.registerAdapter({
      id: adapter.id,
      kind: WORKER_ADAPTER_KINDS[adapter.id],
      description: "in-process real executor",
      execute: async () => ({ ok: true }),
      health: async () => ({ status: "healthy" })
    });
    registeredAdapters.push({ id: adapter.id, ok: outcome.ok, code: outcome.code || null });
  }
  const registeredAgents = registerMissionWorkforce({ workforce, specs: WORKER_SPECS });

  const kit = createWorkerExecutors({ rootDir, artifactsDir, health, log, allowExternalArtifacts: true });
  const executors = {
    ...createMissionExecutors({ kit }),
    ...(verifierOverride ? { "verifier.recompute": verifierOverride } : {})
  };

  const missions = createMissionEngine({
    store: missionStore,
    workforce,
    executors,
    maxAttempts: maxTaskAttempts,
    maxTasksPerRun: 5,
    now,
    log
  });

  // The command repository speaks D1 over HTTP; this shim answers the same shape from SQLite.
  const fetchImpl = async (url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const statement = db.prepare(sql);
    const rows = /^\s*select/i.test(sql) ? statement.all(...params) : (statement.run(...params), []);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
  const commandTasks = createD1CommandTaskRepository({
    accountId: "local-account",
    databaseId: "local-database",
    apiToken: "local-token",
    fetchImpl
  });
  const commandEngine = createUniversalCommandEngine({
    repository: commandTasks,
    registry: createToolRegistry({ env }),
    maxAttempts: 1,
    now
  });

  const escalations = [];
  const pipeline = createMissionPipeline({
    commandEngine,
    missions,
    store: missionStore,
    workforce,
    kit,
    maxRepairs,
    escalate: async (event) => { escalations.push({ ...event, at: now() }); },
    now,
    log
  });

  return {
    db, query, fetchImpl, close: () => db.close(),
    missionStore, workforceRepo, workforce,
    kit, executors, missions, commandTasks, commandEngine, pipeline,
    registeredAdapters, registeredAgents, escalations
  };
}
