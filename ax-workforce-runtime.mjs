import { createWorkforceRepository, createD1WorkforceRepository, WORKFORCE_DDL } from "./d1-workforce-repository.mjs";
import { createWorkforceV1Repository, createD1WorkforceV1Repository, WORKFORCE_V1_MIGRATION, WORKFORCE_V1_TABLE_NAMES } from "./d1-workforce-v1-repository.mjs";
import { createWorkforceV1 } from "./ax-workforce-v1.mjs";
import { createD1RowQuery } from "./nexus-runtime.mjs";
import { createDurableWorkforce } from "./ax-durable-workforce.mjs";
import { createWorkforceIntake } from "./ax-workforce-intake.mjs";
import { createWorkforceRunner } from "./ax-workforce-runner.mjs";
import { createMissionService } from "./mission-runtime.mjs";

/**
 * Workforce runtime attachment.
 *
 * This module decides whether the workforce runs at all, and refuses to run in a half-configured
 * state. The states are deliberate and are reported separately, because they mean different things:
 *
 *   disabled            the flag is off — no database is touched, no store is created
 *   unconfigured        the flag is on but the D1 binding is incomplete
 *   schema_missing      the binding works but migration 0010 has not been applied
 *   initialization_failed  the store answered, but hydration failed
 *   initialized         agents and any in-flight assignments were loaded from the store
 *   running             a scheduler step has actually used intake or the runner since boot
 *
 * It never creates the workforce tables itself: applying a migration is an operator action with a
 * backup and a post-check, not something a web process does on startup. A missing migration is a
 * safe refusal, not an error to paper over.
 *
 * `HABITAT_WORKFORCE_ENABLED` is independent of `NEXUS_RUNTIME_ENABLED`. Entrance is not activation:
 * both must be authorized separately, and neither implies the other.
 */

export const WORKFORCE_FLAG = "HABITAT_WORKFORCE_ENABLED";
export const WORKFORCE_MIGRATION = "0010_ax_workforce";

export const WORKFORCE_STATUS_KEYS = Object.freeze([
  "HABITAT_WORKFORCE_ENABLED",
  "CLOUDFLARE_ACCOUNT_ID",
  "HABITAT_D1_DATABASE_ID",
  "HABITAT_D1_API_TOKEN"
]);

export const WORKFORCE_TABLE_NAMES = Object.freeze([
  "habitat_ax_worker_adapters",
  "habitat_ax_workers",
  "habitat_ax_worker_assignments",
  "habitat_ax_worker_results",
  "habitat_ax_worker_audit"
]);

function flagOn(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

export function workforceConfiguration({ env = process.env } = {}) {
  const enabled = flagOn(env?.[WORKFORCE_FLAG]);
  const credentials = {
    accountId: Boolean(String(env?.CLOUDFLARE_ACCOUNT_ID || "").trim()),
    databaseId: Boolean(String(env?.HABITAT_D1_DATABASE_ID || "").trim()),
    apiToken: Boolean(String(env?.HABITAT_D1_API_TOKEN || "").trim())
  };
  const configured = Object.values(credentials).every(Boolean);
  return {
    flag: WORKFORCE_FLAG,
    enabled,
    configured,
    credentials,
    // Independent, and reported so one flag is never mistaken for the other.
    nexusRuntimeEnabled: flagOn(env?.NEXUS_RUNTIME_ENABLED),
    detail: !enabled
      ? "Workforce is disabled (" + WORKFORCE_FLAG + " is not \"true\"); no store is created and no task is delegated."
      : configured
        ? "Workforce is enabled and the D1 binding is complete; schema and hydration are checked at startup."
        : "Workforce is enabled but the D1 binding is incomplete; it will refuse to run rather than fall back to memory."
  };
}

/** Read-only schema inspection. Safe to call before any write and useful as a migration preflight. */
export async function inspectWorkforceSchema({ query } = {}) {
  if (typeof query !== "function") throw new Error("inspectWorkforceSchema needs a query function.");
  const placeholders = WORKFORCE_TABLE_NAMES.map(() => "?").join(", ");
  const rows = await query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" + placeholders + ")",
    WORKFORCE_TABLE_NAMES
  );
  const present = new Set((rows || []).map(row => row.name));
  const missing = WORKFORCE_TABLE_NAMES.filter(name => !present.has(name));
  return {
    migration: WORKFORCE_MIGRATION,
    ok: missing.length === 0,
    present: WORKFORCE_TABLE_NAMES.filter(name => present.has(name)),
    missing,
    expectedTables: WORKFORCE_TABLE_NAMES.length
  };
}

/**
 * Default adapters are plan-only on purpose. A deployment with no code executor must not claim it
 * changed code, so the implementer reports `partial` with its plan as evidence, and no verification
 * executor exists to turn that into `verified`.
 */
function defaultAdapters() {
  return [
    {
      id: "habitat-planner",
      kind: "coding",
      description: "Plan-only worker: proposes an approach and executes nothing.",
      execute: async () => ({ ok: true }),
      health: async () => ({ status: "healthy" })
    },
    {
      id: "habitat-verifier",
      kind: "verification",
      description: "Evidence checker without an execution runtime.",
      execute: async () => ({ ok: true })
    }
  ];
}

function defaultExecutors() {
  return {
    "habitat-planner": async ({ taskId, assignment }) => ({
      result: {
        status: "partial",
        evidence: [
          "plan-only: no code executor is attached to this deployment",
          "task=" + taskId + " assignment=" + (assignment?.id || "unknown")
        ],
        changedFiles: [],
        tests: { ran: 0, passed: 0, failed: 0 },
        costCents: 0
      }
    })
  };
}

function safeMessage(error, limit = 180) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").trim().slice(0, limit);
}

export async function inspectWorkforceV1Schema({ query } = {}) {
  if (typeof query !== "function") throw new Error("inspectWorkforceV1Schema needs a query function.");
  const rows = await query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" + WORKFORCE_V1_TABLE_NAMES.map(() => "?").join(", ") + ")",
    WORKFORCE_V1_TABLE_NAMES
  );
  const present = new Set((rows || []).map(row => row.name));
  const missing = WORKFORCE_V1_TABLE_NAMES.filter(name => !present.has(name));
  return { migration: WORKFORCE_V1_MIGRATION, ok: missing.length === 0, missing, expectedTables: WORKFORCE_V1_TABLE_NAMES.length };
}

export function createWorkforceRuntime({
  env = process.env,
  query = null,
  repository = null,
  // Durable lease store (0018). Separate from the agent store so a deployment can run the workforce with
  // leases absent; it then reports the gap instead of pretending the guarantee exists.
  leasesRepository = null,
  adapters = null,
  executors = null,
  verifierAgentId = null,
  // Mission pipeline: a prebuilt provider, or built from this runtime's durable workforce when the flag is on.
  missions = null,
  rootDir = null,
  artifactsDir = null,
  now = () => new Date().toISOString(),
  log = console,
  budgetCents = null,
  costPerTaskCents = 0,
  maxPerRun = 2,
  maxConcurrent = 2
} = {}) {
  const configuration = workforceConfiguration({ env });
  const state = {
    status: configuration.enabled ? (configuration.configured ? "configured" : "unconfigured") : "disabled",
    initialized: false,
    schemaReady: null,
    schemaMissing: [],
    leasesReady: null,
    leasesMissing: [],
    leasesError: null,
    recoveredAssignments: 0,
    missionReady: false,
    missionError: null,
    steps: 0,
    lastError: null,
    lastStepAt: null,
    schemaCheckedAt: null
  };
  let durable = null;
  let workforceV1 = null;
  let missionProvider = missions;
  let intake = null;
  let runner = null;
  let initializing = null;

  function resolveQuery() {
    if (typeof query === "function") return query;
    return createD1RowQuery({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: env.HABITAT_D1_DATABASE_ID,
      apiToken: env.HABITAT_D1_API_TOKEN
    });
  }

  function buildRepository() {
    if (repository) return repository;
    if (typeof query === "function") return createWorkforceRepository({ query, now });
    return createD1WorkforceRepository({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: env.HABITAT_D1_DATABASE_ID,
      apiToken: env.HABITAT_D1_API_TOKEN
    });
  }

  async function initialize() {
    if (!configuration.enabled) return status();
    if (!configuration.configured) return status();
    if (state.initialized) return status();
    if (initializing) { await initializing; return status(); }

    initializing = (async () => {
      try {
        const store = buildRepository();
        const schema = await inspectWorkforceSchema({ query: resolveQuery() });
        state.schemaCheckedAt = now();
        state.schemaReady = schema.ok;
        state.schemaMissing = schema.missing;
        if (!schema.ok) {
          state.status = "schema_missing";
          log.warn?.("WORKFORCE_SCHEMA_MISSING", JSON.stringify({ migration: schema.migration, missing: schema.missing }));
          return;
        }

        // Durable leases are their own migration: a database that has 0010 but not 0018 still runs the
        // workforce, and reports that execution safety is not yet enforced rather than failing startup.
        try {
          const leaseSchema = await inspectWorkforceV1Schema({ query: resolveQuery() });
          state.leasesReady = leaseSchema.ok;
          state.leasesMissing = leaseSchema.missing;
          if (leaseSchema.ok) {
            const leaseStore = leasesRepository || (typeof query === "function"
              ? createWorkforceV1Repository({ query, now })
              : createD1WorkforceV1Repository({
                  accountId: env.CLOUDFLARE_ACCOUNT_ID,
                  databaseId: env.HABITAT_D1_DATABASE_ID,
                  apiToken: env.HABITAT_D1_API_TOKEN
                }));
            workforceV1 = createWorkforceV1({
              repository: leaseStore,
              // Registration from this process is the owner's own bootstrap; anything arriving over HTTP
              // still needs the owner attestation enforced in the gateway.
              requireOwnerAuthorization: true,
              // The engine measures lease age in milliseconds; this runtime's clock is ISO for the store.
              now: () => { const parsed = Date.parse(now()); return Number.isFinite(parsed) ? parsed : Date.now(); },
              log
            });
          } else {
            log.warn?.("WORKFORCE_LEASE_SCHEMA_MISSING", JSON.stringify({ migration: WORKFORCE_V1_MIGRATION, missing: leaseSchema.missing }));
          }
        } catch (leaseError) {
          state.leasesReady = false;
          state.leasesError = safeMessage(leaseError);
          log.warn?.("WORKFORCE_LEASE_SCHEMA_CHECK_FAILED", state.leasesError);
        }

        durable = createDurableWorkforce({ repository: store, adapters: adapters || defaultAdapters(), now, log });
        // Hydrate before registering defaults: a stored worker's health and revision are observed
        // state, and re-registering it on every boot would reset a known-unavailable worker to
        // "unknown" and make the runner try a provider that was already marked down.
        const hydrated = await durable.hydrate({ force: true });
        await registerDefaultAgents(durable);
        if (workforceV1) await registerWorkers(workforceV1, durable);
        const recovered = durable.assignments().filter(item => item.state === "active");
        state.recoveredAssignments = recovered.length;
        intake = createWorkforceIntake({ workforce: durable, now, budgetCents, costPerTaskCents });
        runner = createWorkforceRunner({
          workforce: durable,
          executors: executors || defaultExecutors(),
          verifierAgentId: verifierAgentId || "verifier.workforce",
          maxPerRun,
          now,
          log
        });
        // The mission pipeline is mounted on the workforce that was just hydrated. A mission failure must
        // not take the workforce down with it, so it is reported separately and its routes answer 503.
        try {
          if (!missionProvider) {
            missionProvider = await createMissionService({
              workforce: durable,
              leases: workforceV1,
              query: resolveQuery(),
              env,
              ...(rootDir ? { rootDir } : {}),
              ...(artifactsDir ? { artifactsDir } : {}),
              now,
              log
            });
          }
          state.missionReady = true;
          log.log?.("MISSION_RUNTIME_READY", JSON.stringify({ ...(missionProvider.status?.() || {}), leases: workforceV1 !== null }));
        } catch (missionError) {
          state.missionReady = false;
          state.missionError = safeMessage(missionError);
          log.warn?.("MISSION_RUNTIME_FAILED", state.missionError);
        }
        state.initialized = true;
        state.status = "initialized";
        log.log?.("WORKFORCE_INITIALIZED", JSON.stringify({
          agents: hydrated.agents,
          assignments: hydrated.assignments,
          recovered: recovered.length,
          results: hydrated.results,
          leases: workforceV1 !== null
        }));
      } catch (error) {
        state.status = "initialization_failed";
        state.lastError = safeMessage(error);
        log.error?.("WORKFORCE_INITIALIZATION_FAILED", state.lastError);
      }
    })();
    try { await initializing; } finally { initializing = null; }
    return status();
  }

  async function registerDefaultAgents(workforce) {
    if (workforce.agent("coder.workforce")) return;
    await workforce.registerAgent({
      id: "coder.workforce",
      name: "Workforce planner",
      specialty: "coding",
      adapterId: "habitat-planner",
      capabilities: ["coding", "tests"],
      permissions: { allowed: ["coding", "tests", "plan"], denied: ["deploy", "publish", "approve"] },
      limits: { maxTaskCents: 0 },
      workspace: { isolation: "none" },
      availability: { maxConcurrent }
    });
    await workforce.registerAgent({
      id: "verifier.workforce",
      name: "Workforce verifier",
      specialty: "verification",
      adapterId: "habitat-verifier",
      capabilities: ["verification"],
      permissions: { allowed: ["verification"], denied: ["coding", "approve"] },
      availability: { maxConcurrent: 1 }
    });
  }

  /**
   * Mirror the registered agents into the lease layer. A worker is only revived on boot if it was not
   * explicitly deregistered: starting a process is not owner consent to undo a deregistration.
   */
  async function registerWorkers(leases, workforce) {
    for (const agent of workforce.agents()) {
      try {
        const existing = await leases.worker(agent.id);
        if (existing.ok && existing.worker.state === "deregistered") continue;
        const registered = await leases.registerWorker({
          id: agent.id,
          label: agent.name,
          specialty: agent.specialty,
          adapterId: agent.adapterId,
          capabilities: agent.capabilities,
          maxConcurrent: agent.availability?.maxConcurrent || 1,
          accepting: agent.availability?.accepting !== false,
          trusted: true
        });
        if (!registered.ok) log.warn?.("WORKFORCE_V1_REGISTRATION_FAILED", JSON.stringify({ workerId: agent.id, code: registered.code }));
      } catch (error) {
        log.warn?.("WORKFORCE_V1_REGISTRATION_FAILED", JSON.stringify({ workerId: agent.id, error: safeMessage(error) }));
      }
    }
  }

  function availability() {
    if (!configuration.enabled) return { ok: false, code: "workforce_disabled" };
    if (!configuration.configured) return { ok: false, code: "workforce_unconfigured" };
    if (!state.initialized) {
      return { ok: false, code: state.status === "schema_missing" ? "workforce_schema_missing" : "workforce_not_initialized" };
    }
    return { ok: true };
  }

  async function intakeFinding(finding) {
    const guard = availability();
    if (!guard.ok) return { ...guard, refused: true };
    state.steps += 1;
    state.lastStepAt = now();
    try {
      const outcome = await intake.intake(finding);
      if (outcome.ok) state.status = "running";
      return outcome;
    } catch (error) {
      state.lastError = safeMessage(error);
      log.error?.("WORKFORCE_INTAKE_FAILED", state.lastError);
      return { ok: false, code: "intake_failed" };
    }
  }

  async function runPending() {
    const guard = availability();
    if (!guard.ok) return { ...guard, refused: true };
    state.steps += 1;
    state.lastStepAt = now();
    try {
      const summary = await runner.runOnce();
      if (summary.attempted > 0) state.status = "running";
      return summary;
    } catch (error) {
      state.lastError = safeMessage(error);
      log.error?.("WORKFORCE_RUN_FAILED", state.lastError);
      return { ok: false, code: "runner_failed" };
    }
  }

  function status() {
    const results = durable ? durable.results() : [];
    const assignments = durable ? durable.assignments() : [];
    const verified = results.filter(item => item.status === "verified").length;
    const pendingApproval = results.filter(item => item.status === "verified" && item.approved !== true).length;
    const enabled = configuration.enabled;
    const initialized = state.initialized;
    return {
      flag: configuration.flag,
      enabled,
      configured: configuration.configured,
      initialized,
      running: state.steps > 0 && initialized,
      verified: verified > 0,
      state: state.status,
      migration: {
        version: WORKFORCE_MIGRATION,
        checked: state.schemaCheckedAt !== null,
        ready: state.schemaReady,
        missing: state.schemaMissing,
        // The runtime never applies the migration; this is what an operator must do first.
        appliedByRuntime: false,
        ddlStatements: WORKFORCE_DDL.length
      },
      recoveredAssignments: state.recoveredAssignments,
      leases: {
        attached: workforceV1 !== null,
        ready: state.leasesReady,
        migration: WORKFORCE_V1_MIGRATION,
        missing: state.leasesMissing,
        error: state.leasesError,
        enforced: workforceV1 !== null
      },
      counts: {
        agents: durable ? durable.agents().length : 0,
        assignments: assignments.length,
        active: assignments.filter(item => item.state === "active").length,
        results: results.length,
        verified,
        approvalRequired: pendingApproval
      },
      steps: state.steps,
      lastStepAt: state.lastStepAt,
      lastError: state.lastError,
      nexusRuntimeEnabled: configuration.nexusRuntimeEnabled,
      detail: describe(state, configuration, verified)
    };
  }

  return Object.freeze({
    status,
    initialize,
    intake: intakeFinding,
    run: runPending,
    configuration: () => ({ ...configuration }),
    hasIntake: () => typeof intake === "function",
    hasRunner: () => typeof runner === "function",
    missions: () => missionProvider,
    workforceV1: () => workforceV1,
    missionStatus: () => ({
      ready: state.missionReady,
      error: state.missionError,
      detail: missionProvider && typeof missionProvider.status === "function" ? missionProvider.status() : null
    })
  });
}

function describe(state, configuration, verified) {
  switch (state.status) {
    case "disabled":
      return "Disabled by " + WORKFORCE_FLAG + "; nothing was read from D1 and no task will be delegated.";
    case "unconfigured":
      return "Enabled but the D1 binding is incomplete; no in-memory fallback is used.";
    case "schema_missing":
      return "Migration " + WORKFORCE_MIGRATION + " has not been applied to this database; the workforce did not start and will not create tables itself.";
    case "initialization_failed":
      return "The workforce store could not be hydrated (" + (state.lastError || "unknown error") + "); it is not running.";
    case "running":
      return verified
        ? "Coordination is active and at least one independently verified result is stored, pending owner approval."
        : "Coordination is active; a scheduler step has used the workforce since boot.";
    default:
      return configuration.enabled
        ? "Initialized from the store; no scheduler step has used the workforce yet."
        : "Disabled.";
  }
}
