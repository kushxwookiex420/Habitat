import { createMissionEngine, MISSION_FLAG, MISSION_MIGRATION } from "./ax-mission-engine.mjs";
import { createMissionRepository, createD1MissionRepository, MISSION_TABLE_NAMES } from "./d1-mission-repository.mjs";
import { createD1RowQuery } from "./nexus-runtime.mjs";

/**
 * Mission runtime attachment, disabled by default.
 *
 * The flag is independent of the workforce and NEXUS flags. With it off, no mission store is built and
 * no schema is read. With it on, startup refuses rather than half-running when the binding is
 * incomplete, migration 0011 is absent, or there is no workforce to delegate to — a mission engine
 * without workers would only produce plans that look like progress.
 *
 * The runtime never applies DDL: migration 0011 is an operator action.
 */

function flagOn(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

export function missionConfiguration({ env = process.env } = {}) {
  const enabled = flagOn(env?.[MISSION_FLAG]);
  const configured = Boolean(String(env?.CLOUDFLARE_ACCOUNT_ID || "").trim() && String(env?.HABITAT_D1_DATABASE_ID || "").trim() && String(env?.HABITAT_D1_API_TOKEN || "").trim());
  return {
    flag: MISSION_FLAG,
    enabled,
    configured,
    workforceEnabled: flagOn(env?.HABITAT_WORKFORCE_ENABLED),
    nexusRuntimeEnabled: flagOn(env?.NEXUS_RUNTIME_ENABLED),
    detail: enabled
      ? configured
        ? "Missions are enabled; schema and workforce are checked at startup."
        : "Missions are enabled but the D1 binding is incomplete; the runtime will refuse to start."
      : "Missions are disabled (HABITAT_MISSIONS_ENABLED is not \"true\"); no mission store is created."
  };
}

export function createMissionRuntime({
  env = process.env,
  repository = null,
  workforce = null,
  executors = null,
  verifierAgentId = null,
  ownerVerifier = null,
  query = null,
  now = () => new Date().toISOString(),
  log = console,
  maxTasksPerRun = 2
} = {}) {
  const configuration = missionConfiguration({ env });
  const state = { status: configuration.enabled ? (configuration.configured ? "configured" : "unconfigured") : "disabled", initialized: false, schemaReady: null, running: false, lastError: null, steps: 0 };
  let engine = null;
  let initializing = null;

  function resolveQuery() {
    if (typeof query === "function") return query;
    return createD1RowQuery({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: env.HABITAT_D1_DATABASE_ID,
      apiToken: env.HABITAT_D1_API_TOKEN
    });
  }

  function buildStore() {
    if (repository) return repository;
    if (typeof query === "function") return createMissionRepository({ query, now });
    return createD1MissionRepository({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: env.HABITAT_D1_DATABASE_ID,
      apiToken: env.HABITAT_D1_API_TOKEN
    });
  }

  async function initialize() {
    if (!configuration.enabled || !configuration.configured || state.initialized) return status();
    if (initializing) { await initializing; return status(); }
    initializing = (async () => {
      try {
        const store = buildStore();
        const rows = await resolveQuery()("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)", MISSION_TABLE_NAMES);
        const present = new Set((rows || []).map(row => row.name));
        const missing = MISSION_TABLE_NAMES.filter(name => !present.has(name));
        state.schemaReady = missing.length === 0;
        if (!state.schemaReady) {
          state.status = "schema_missing";
          state.lastError = "missing:" + missing.join(",");
          log.warn?.("MISSION_SCHEMA_MISSING", JSON.stringify({ migration: MISSION_MIGRATION, missing }));
          return;
        }
        if (!workforce) {
          state.status = "worker_unavailable";
          state.lastError = "no workforce attached";
          return;
        }
        engine = createMissionEngine({ store, workforce, executors: executors || undefined, verifierAgentId, ownerVerifier, now, log, maxTasksPerRun });
        state.initialized = true;
        state.status = "initialized";
        log.log?.("MISSIONS_INITIALIZED", JSON.stringify({ migration: MISSION_MIGRATION, counts: await engine.status() }));
      } catch (error) {
        state.status = "initialization_failed";
        state.lastError = String(error?.message || error).slice(0, 180);
        log.error?.("MISSIONS_INITIALIZATION_FAILED", state.lastError);
      }
    })();
    try { await initializing; } finally { initializing = null; }
    return status();
  }

  function guard() {
    if (!configuration.enabled) return { ok: false, code: "missions_disabled" };
    if (!configuration.configured) return { ok: false, code: "missions_unconfigured" };
    if (!state.initialized) return { ok: false, code: state.status === "schema_missing" ? "missions_schema_missing" : state.status === "worker_unavailable" ? "missions_worker_unavailable" : "missions_not_initialized" };
    return { ok: true };
  }

  async function intake(spec, options = {}) {
    const allowed = guard();
    if (!allowed.ok) return allowed;
    state.steps += 1;
    const result = await engine.intake(spec, options);
    if (result.ok) state.status = "running";
    return result;
  }

  async function tick() {
    const allowed = guard();
    if (!allowed.ok) return allowed;
    state.steps += 1;
    state.running = true;
    state.status = "running";
    return engine.recover({ limit: Math.max(1, Math.min(5, Number(maxTasksPerRun) || 2)) });
  }

  async function approve(input) {
    const allowed = guard();
    if (!allowed.ok) return allowed;
    return engine.approve(input);
  }

  async function missions({ status = null, limit = 50 } = {}) {
    const allowed = guard();
    if (!allowed.ok) return { ...allowed, missions: [] };
    return { ok: true, missions: await engine.list({ status, limit }) };
  }

  async function mission(id) {
    const allowed = guard();
    if (!allowed.ok) return allowed;
    const found = await engine.get(String(id));
    if (!found) return { ok: false, code: "mission_not_found" };
    return { ok: true, mission: found.record };
  }

  async function status() {
    const counts = state.initialized ? await engine.status() : { total: 0, byStatus: {} };
    return {
      flag: configuration.flag,
      state: state.status,
      enabled: configuration.enabled,
      configured: configuration.configured,
      initialized: state.initialized,
      running: state.running,
      verified: Number(counts.byStatus?.completed || 0) > 0,
      migration: { version: MISSION_MIGRATION, ready: state.schemaReady, expectedTables: MISSION_TABLE_NAMES.length, appliedByRuntime: false },
      workforceEnabled: configuration.workforceEnabled,
      nexusRuntimeEnabled: configuration.nexusRuntimeEnabled,
      counts: { total: counts.total || 0, byStatus: counts.byStatus || {} },
      steps: state.steps,
      lastError: state.lastError,
      detail: describe(state.status)
    };
  }

  return Object.freeze({ status, initialize, intake, tick, approve, missions, mission, configuration: () => ({ ...configuration }) });
}

function describe(status) {
  switch (status) {
    case "disabled": return "Disabled by HABITAT_MISSIONS_ENABLED; no mission store was created.";
    case "unconfigured": return "Enabled but the D1 binding is incomplete; no mission store was created.";
    case "schema_missing": return "Migration " + MISSION_MIGRATION + " is missing; the runtime did not create tables and is not running.";
    case "worker_unavailable": return "No workforce is attached; a mission without workers would only produce plans.";
    case "initialization_failed": return "Mission storage could not be initialized; the runtime is not running.";
    case "running": return "Mission coordination is active.";
    default: return "Mission storage is initialized; no mission has run yet.";
  }
}
