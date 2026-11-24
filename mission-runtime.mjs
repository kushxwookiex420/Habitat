import os from "node:os";
import path from "node:path";
import { createMissionRepository } from "./d1-mission-repository.mjs";
import { createMissionEngine } from "./ax-mission-engine.mjs";
import { createWorkerExecutors, EXECUTOR_ADAPTERS, WORKER_ADAPTER_KINDS, WORKER_SPECS } from "./worker-executors.mjs";
import { createMissionExecutors, createMissionPipeline } from "./mission-pipeline.mjs";

/**
 * The mission service: the pipeline from `mission-pipeline.mjs` bound to the durable mission store and the
 * already-initialised durable workforce. It does not create a second workforce; the caller passes the one
 * it mounted, and this adds adapters and agents to it.
 *
 * Artifacts are written outside the checkout: a deployment's repository is read-only. The directory must be
 * on persistent storage for artifacts to survive a restart; that requirement is reported as a dependency
 * rather than assumed.
 */

export const MISSION_ENV = Object.freeze({
  artifacts: "HABITAT_MISSION_ARTIFACTS_DIR",
  root: "HABITAT_REPO_ROOT",
  flag: "HABITAT_WORKFORCE_ENABLED"
});

export const MISSION_LIMITS = Object.freeze({
  maxRepairs: 1,
  maxTaskAttempts: 1,
  maxTasksPerRun: 5
});

function resolveArtifactsDir(env) {
  const configured = String(env[MISSION_ENV.artifacts] || "").trim();
  const dir = configured || path.join(os.tmpdir(), "habitat-mission-artifacts");
  return path.resolve(dir);
}

export async function createMissionService({
  workforce,
  query,
  env = process.env,
  rootDir = String(env[MISSION_ENV.root] || "").trim() || process.cwd(),
  now = () => new Date().toISOString(),
  log = console,
  health = null,
  artifactsDir = null
} = {}) {
  if (!workforce || typeof workforce.assign !== "function") throw new Error("createMissionService needs the durable workforce.");
  if (typeof query !== "function") throw new Error("createMissionService needs the D1 query function.");

  const store = createMissionRepository({ query, now });
  const initialized = await store.initialize();
  if (!initialized?.ok) throw new Error("The mission store could not be initialised.");

  const directory = artifactsDir || resolveArtifactsDir(env);
  const kit = createWorkerExecutors({
    rootDir,
    artifactsDir: directory,
    allowExternalArtifacts: true,
    health: health || (async () => ({ status: "ready", checks: { storage: true } })),
    log
  });

  const registered = { adapters: [], agents: [] };
  for (const adapter of EXECUTOR_ADAPTERS) {
    const outcome = await workforce.registerAdapter({
      id: adapter.id,
      kind: WORKER_ADAPTER_KINDS[adapter.id],
      description: "in-process real executor",
      execute: async () => ({ ok: true }),
      health: async () => ({ status: "healthy" })
    });
    registered.adapters.push({ id: adapter.id, ok: outcome.ok, code: outcome.code || null });
  }
  for (const spec of WORKER_SPECS) {
    const outcome = await workforce.registerAgent({
      id: spec.agentId,
      name: spec.specialty,
      specialty: spec.specialty,
      adapterId: spec.adapterId,
      capabilities: spec.capabilities,
      permissions: { allowed: spec.capabilities, denied: ["deploy", "purchase", "publish", "credential"] },
      availability: { maxConcurrent: 2 }
    });
    registered.agents.push({ id: spec.agentId, ok: outcome.ok, code: outcome.code || null });
  }

  const missions = createMissionEngine({
    store,
    workforce,
    executors: createMissionExecutors({ kit }),
    maxAttempts: MISSION_LIMITS.maxTaskAttempts,
    maxTasksPerRun: MISSION_LIMITS.maxTasksPerRun,
    now,
    log
  });

  const escalations = [];
  const pipeline = createMissionPipeline({
    missions,
    store,
    workforce,
    kit,
    maxRepairs: MISSION_LIMITS.maxRepairs,
    escalate: async (event) => {
      escalations.push({ ...event, at: now() });
      log.warn?.("MISSION_ESCALATED", JSON.stringify(event));
    },
    now,
    log
  });

  return Object.freeze({
    submit: (spec) => pipeline.submit(spec),
    run: (missionId, options) => pipeline.run(missionId, options),
    get: async (missionId) => {
      const loaded = await store.get(missionId);
      if (!loaded) return null;
      return loaded.record || loaded;
    },
    list: (options) => store.list(options),
    events: (missionId) => store.events(missionId),
    escalations: () => escalations.slice(),
    status: () => ({
      agents: registered.agents.filter((entry) => entry.ok).length,
      adapters: registered.adapters.filter((entry) => entry.ok).length,
      artifactsDir: directory,
      artifactsPersistent: Boolean(String(env[MISSION_ENV.artifacts] || "").trim()),
      rootDir
    })
  });
}
