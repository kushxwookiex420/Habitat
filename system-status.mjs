// Read-only, redacted system status for Habitat/Ax.
//
// The phone asks "ask ax system status" and expects telemetry, not a model's imagination. This
// module builds that answer from values the process actually holds:
//
//   - backend / API: this code ran, so the service answered; routes are reported from the mount
//     facts the caller passes in, not assumed.
//   - authentication: only booleans derived from environment presence. No value, prefix or hash is
//     ever copied into the result.
//   - workers: registered is what the registry holds; running is tasks currently assigned; healthy
//     requires a recent verified run. A worker with no evidence is idle/unverified, never healthy.
//   - execution: the NEXUS executor's own report. A mounted-but-unstarted or disabled executor is
//     reported as unable to execute, because queued objectives would not run.
//
// Nothing here probes the network, writes storage or spends model quota.

import { summarizeWorkforce } from "./ax-workforce-status.mjs";
import { summarizeIdentity } from "./ax-identity-status.mjs";

const HEALTH_WINDOW_MS = 30 * 60 * 1000;
const RUNNING_STATES = new Set(["working", "running", "delegated", "in_progress", "dispatched", "claimed"]);
const VERIFIED_STATES = new Set(["verified", "done", "completed"]);
const UNAVAILABLE_STATES = new Set(["blocked", "unavailable", "adapter_missing", "disabled"]);

export const REQUIRED_CONFIGURATION = Object.freeze([
  { key: "HABITAT_AX_BRIDGE_TOKEN", purpose: "authenticates Ax calls to /ax/command/*" },
  { key: "CLOUDFLARE_ACCOUNT_ID", purpose: "D1 account for durable command tasks and pairing" },
  { key: "HABITAT_D1_DATABASE_ID", purpose: "D1 database holding command tasks and paired devices" },
  { key: "HABITAT_D1_API_TOKEN", purpose: "least-privilege D1 token used by the backend" },
  { key: "HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH", purpose: "one-time first pairing code digest" },
  { key: "HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT", purpose: "expiry for the bootstrap pairing code" },
  { key: "HABITAT_OWNER_DEVICE_ID", purpose: "owner device allowed to close tasks manually" },
  { key: "NEXUS_RUNTIME_ENABLED", purpose: "mounts the executor that claims queued command tasks" },
  { key: "NEXUS_FREE_ONLY", purpose: "restricts the executor to free adapters" },
  { key: "HOME_BRIDGE_URL", purpose: "relay URL used for phone tasks and files" },
  { key: "HOME_BRIDGE_AX_TOKEN", purpose: "relay Ax credential held server-side" },
  { key: "HOME_BRIDGE_BUFF_TOKEN", purpose: "relay Buff credential held server-side" }
]);

function present(env, key) {
  return Boolean(String(env?.[key] ?? "").trim());
}

function registryValues(registry) {
  if (registry instanceof Map) return [...registry.values()];
  if (Array.isArray(registry)) return registry;
  if (registry && typeof registry === "object") return Object.values(registry);
  return [];
}

/**
 * Derive one observed state per registered worker. `healthy` is only returned when a recent task
 * for that worker reached a verified terminal state; registration is never treated as health.
 */
export function classifyWorkers({ registry, tasks = [], now = Date.now(), healthWindowMs = HEALTH_WINDOW_MS } = {}) {
  const history = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const workerId = String(task?.worker || "").trim();
    if (!workerId) continue;
    const state = String(task?.status || "").trim().toLowerCase();
    const at = Date.parse(task?.verifiedAt || task?.completedAt || task?.updatedAt || task?.createdAt || "") || 0;
    const entry = history.get(workerId) || { running: 0, lastAt: 0, lastRunAt: null, lastStatus: null };
    if (RUNNING_STATES.has(state)) entry.running += 1;
    if (at >= entry.lastAt) {
      entry.lastAt = at;
      entry.lastRunAt = task?.verifiedAt || task?.completedAt || task?.updatedAt || task?.createdAt || null;
      entry.lastStatus = state || null;
    }
    history.set(workerId, entry);
  }

  return registryValues(registry).map(worker => {
    const id = String(worker?.id || worker?.name || "worker");
    const observed = history.get(id) || { running: 0, lastAt: 0, lastRunAt: null, lastStatus: null };
    const availability = String(worker?.status || "").trim().toLowerCase();
    const unavailable = UNAVAILABLE_STATES.has(availability);
    let state;
    if (unavailable) state = "unavailable";
    else if (observed.running > 0) state = "running";
    else if (observed.lastAt && now - observed.lastAt <= healthWindowMs && VERIFIED_STATES.has(observed.lastStatus)) state = "healthy";
    else if (observed.lastStatus) state = "unverified";
    else state = "idle";

    return {
      id,
      name: worker?.name || id,
      kind: worker?.kind || "worker",
      model: worker?.model || null,
      // `status` keeps the registry's availability word for older clients; `state` is what was
      // actually observed.
      status: availability || "unknown",
      availability: availability || "unknown",
      state,
      configured: !unavailable,
      running: observed.running,
      healthy: state === "healthy",
      lastRunAt: observed.lastRunAt,
      lastStatus: observed.lastStatus,
      capabilities: Array.isArray(worker?.capabilities) ? worker.capabilities.slice(0, 20) : []
    };
  });
}

export function summarizeWorkerCounts(items = []) {
  return {
    registered: items.length,
    running: items.filter(item => item.state === "running").length,
    healthy: items.filter(item => item.healthy).length,
    unavailable: items.filter(item => item.state === "unavailable").length,
    idle: items.filter(item => item.state === "idle").length,
    unverified: items.filter(item => item.state === "unverified").length
  };
}

function summarizeExecution(execution) {
  if (!execution || execution.configured !== true) {
    return {
      configured: false,
      started: false,
      state: "unavailable",
      canExecute: false,
      liveWorkers: 0,
      queued: null,
      detail: execution?.reason
        ? "Executor not mounted (" + execution.reason + "); queued command objectives will not run."
        : "Executor is not mounted; queued command objectives will not run."
    };
  }
  const started = execution.started === true;
  const liveWorkers = Number(execution.heartbeat?.liveWorkers || execution.liveWorkers || 0) || 0;
  const canExecute = execution.canExecute === true;
  const state = canExecute ? "executing" : started ? "started_unverified" : "not_started";
  return {
    configured: true,
    started,
    state,
    canExecute,
    liveWorkers,
    queued: execution.queue?.queued ?? execution.queue?.pending ?? null,
    claimed: execution.queue?.claimed ?? null,
    heartbeatVerified: execution.heartbeat?.verified === true,
    detail: canExecute
      ? "Executor heartbeat is fresh and can claim queued command tasks."
      : started
        ? "Executor is started but has no verified heartbeat yet; execution is not proven."
        : "Executor is mounted but not started; queued command objectives will not run."
  };
}

function authentication(env, { deviceBridge } = {}) {
  const axToken = Boolean(deviceBridge?.axTokenConfigured) || present(env, "HABITAT_AX_BRIDGE_TOKEN");
  const pairingDurable = deviceBridge?.durable === true;
  const bootstrapCode = present(env, "HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH");
  const ownerDevice = present(env, "HABITAT_OWNER_DEVICE_ID") || present(env, "HABITAT_OWNER_DEVICE_IDS");
  const relayAx = present(env, "HOME_BRIDGE_AX_TOKEN");
  const relayBuff = present(env, "HOME_BRIDGE_BUFF_TOKEN");
  const deviceTokenAuth = deviceBridge?.perDeviceTokens === true;
  const configured = axToken && pairingDurable && deviceTokenAuth;
  return {
    state: configured ? "configured" : axToken || pairingDurable ? "partial" : "unconfigured",
    axBridgeTokenConfigured: axToken,
    devicePairingDurable: pairingDurable,
    perDeviceTokens: deviceTokenAuth,
    bootstrapPairingConfigured: bootstrapCode,
    ownerDeviceConfigured: ownerDevice,
    relayCredentials: { ax: relayAx, buff: relayBuff },
    detail: configured
      ? "Ax calls authenticate with the bridge token; phones authenticate with per-device tokens backed by durable storage."
      : "One or more authentication prerequisites are missing; see requiredConfiguration."
  };
}

function summarizeMissions(input) {
  if (!input || typeof input !== "object") {
    return { state: "not_configured", enabled: false, initialized: false, running: false, verified: false, counts: {}, detail: "No mission runtime is attached to this process." };
  }
  return {
    state: input.state || "not_configured",
    flag: input.flag || "HABITAT_MISSIONS_ENABLED",
    enabled: input.enabled === true,
    configured: input.configured === true,
    initialized: input.initialized === true,
    running: input.running === true,
    verified: input.verified === true,
    migration: { version: input.migration?.version || "0011_ax_missions", ready: input.migration?.ready ?? null, appliedByRuntime: false },
    counts: { total: Number(input.counts?.total || 0), byStatus: { ...(input.counts?.byStatus || {}) } },
    detail: input.detail || "No detail reported."
  };
}

export function buildSystemStatus({
  env = process.env,
  now = Date.now(),
  version = "0.5.0",
  commit = null,
  startedAtMs = null,
  latencyMs = null,
  registry = new Map(),
  tasks = [],
  deviceBridge = {},
  devicePresence = {},
  storage = {},
  providers = {},
  routes = {},
  execution = null,
  workforce = null,
  identity = null,
  missions = null,
  gateway = null,
  heartbeat = null,
  ownerAuthentication = null
} = {}) {
  const items = classifyWorkers({ registry, tasks, now });
  const counts = summarizeWorkerCounts(items);
  const executionReport = summarizeExecution(execution || deviceBridge.nexus);
  const auth = authentication(env, { deviceBridge });
  const storageDurable = storage.taskRepositoryReady === true;
  // Mount facts only. Whether a mounted route is *usable* is reported by the authentication and
  // storage components, so "mounted" is never confused with "ready".
  const apiRoutes = {
    chat: routes.chat !== false,
    systemStatus: true,
    deviceCommands: routes.deviceCommands !== false,
    axCommand: routes.axCommand !== false,
    nexusRuntime: executionReport.configured
  };
  const paired = Number(devicePresence.paired || devicePresence.deviceCount || 0) || 0;
  const lastSeenAt = devicePresence.lastSeenAt || null;
  const recentlySeen = devicePresence.recentlySeen === true;
  const unavailableKeys = REQUIRED_CONFIGURATION
    .filter(entry => !present(env, entry.key))
    .map(entry => entry.key);

  const status = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    version,
    commit: commit || null,
    uptimeSeconds: Number.isFinite(startedAtMs) ? Math.max(0, Math.round((now - startedAtMs) / 1000)) : null,
    secretsExposed: false,
    components: {
      backend: {
        state: "healthy",
        detail: latencyMs == null
          ? "This process answered the status request."
          : "This process answered the status request in " + Math.round(latencyMs) + "ms."
      },
      api: {
        state: Object.values(apiRoutes).every(Boolean) ? "healthy" : "partial",
        routes: apiRoutes,
        detail: "Routes are reported from this process's mount facts; a missing route is reported, never assumed."
      },
      authentication: auth,
      storage: {
        state: storageDurable ? "ready" : "degraded",
        taskRepositoryReady: storageDurable,
        adapter: storageDurable ? "cloudflare-d1" : "process-local",
        durable: storageDurable,
        contentJobsDurable: storage.contentJobRepositoryReady === true,
        dispatchLeaseDurable: storage.dispatchLeaseReady === true,
        secretVaultReady: storage.secretVaultReady === true,
        detail: storageDurable
          ? "Durable D1 task storage is initialized for this process."
          : "Durable storage is not initialized; records may be lost on restart."
      },
      workers: {
        state: counts.unavailable > 0 ? "degraded" : counts.running > 0 || counts.healthy > 0 ? "operational" : "idle",
        counts,
        items,
        execution: executionReport,
        detail: counts.healthy > 0 || counts.running > 0
          ? "Counts reflect tasks this process is holding, not promises from the registry."
          : "Registered workers have no running or verified work right now; they are idle, not healthy."
      },
      device: {
        state: recentlySeen ? "online" : paired > 0 ? "paired_offline" : "unpaired",
        paired,
        recentlySeen,
        lastSeenAt,
        detail: recentlySeen
          ? "A paired phone checked in recently."
          : paired > 0
            ? "Devices are paired but none checked in within the liveness window."
            : "No paired phone is known to this process."
      },
      providers: {
        state: Object.values(providers).some(Boolean) ? "configured" : "unconfigured",
        configured: { ...providers },
        detail: "Provider booleans only; configuration is not proof of a successful inference."
      },
      // Five words that are routinely conflated are reported as five separate facts: configured
      // (binding present), initialized (hydrated from the store), enabled (the operator's flag),
      // running (the scheduler used it since boot) and verified (a result was independently verified).
      workforce: summarizeWorkforce(workforce),
      // Identity and intelligence are reported separately: a provider is not who Ax is.
      identity: summarizeIdentity(identity),
      missions: summarizeMissions(missions),
      gateway: {
        state: gateway?.enabled ? (gateway.repository ? "enabled" : "enabled_unconfigured") : "disabled",
        enabled: gateway?.enabled === true,
        repository: gateway?.repository === true,
        flag: gateway?.flag || "HABITAT_GATEWAY_ENABLED",
        detail: gateway?.enabled
          ? gateway.repository
            ? "Integration gateway is enabled and its storage is available."
            : "Gateway is enabled but its schema or binding is unavailable; requests are refused."
          : "Integration gateway is disabled; every /ax/v1 route answers 503."
      },
      heartbeat: {
        state: heartbeat && heartbeat.enabled !== false ? heartbeat.connection || "unknown" : "disabled",
        enabled: Boolean(heartbeat) && heartbeat.enabled !== false,
        lastBeatAt: heartbeat?.lastBeatAt || null,
        lastSeenAt: heartbeat?.lastSeenAt || null,
        missedBeats: heartbeat?.missedBeats ?? null,
        queue: heartbeat?.queue || null,
        detail: heartbeat && heartbeat.enabled !== false
          ? "Habitat heartbeat is running; the integration has been seen " + (heartbeat.lastSeenAt || "never") + "."
          : "Connection monitor is disabled (HABITAT_HEARTBEAT_ENABLED is not \"true\")."
      },
      ownerAuthentication: {
        state: ownerAuthentication?.verifierConfigured ? (ownerAuthentication.enforce ? "enforced" : "configured_optional") : "not_configured",
        verifierConfigured: ownerAuthentication?.verifierConfigured === true,
        enforce: ownerAuthentication?.enforce === true,
        policy: ownerAuthentication?.policy || "optional",
        activeKeyId: ownerAuthentication?.activeKeyId || null,
        detail: ownerAuthentication?.verifierConfigured
          ? ownerAuthentication.enforce
            ? "Owner attestation is required for owner writes, directives and approvals."
            : "A verifier is configured, supplied attestations are verified, but unsigned route-authenticated owner writes remain allowed."
          : "No owner attestation key is configured; protected owner actions that need it are refused."
      }
    },
    requiredConfiguration: {
      allPresent: unavailableKeys.length === 0,
      missing: unavailableKeys,
      keys: REQUIRED_CONFIGURATION.map(entry => ({
        key: entry.key,
        purpose: entry.purpose,
        configured: present(env, entry.key)
      }))
    },
    // Public payload. Key names are documented configuration names, never values. Task text,
    // device identifiers and per-worker internals are excluded at the source.
    //
    // Policy v2 (reconciliation of the status branches): capability names, the provider model and
    // last-run outcome are published because they are what makes a capability claim checkable, and
    // a check-in timestamp is published because "paired but silent since" is the operational fact.
    // What stays private is content and identity, not the ability to verify a claim.
    redaction: {
      applied: true,
      policyVersion: 2,
      included: ["configuration key names", "worker capability names", "provider model names", "last-run outcome", "device last check-in timestamp"],
      excluded: ["secret values", "task content", "objective and result text", "device identifiers", "device names"]
    },
    limits: [
      "This report does not spend model quota, so it cannot prove inference works.",
      "A configured worker is not a running worker; healthy requires a recent verified run.",
      "Authentication values are reported as booleans only."
    ]
  };
  status.report = formatSystemStatus(status);
  return status;
}

const LABEL = {
  healthy: "HEALTHY",
  disabled: "DISABLED",
  initialized: "INITIALIZED",
  persistent: "PERSISTENT",
  committed_only: "COMMITTED ONLY",
  not_yet_persisted: "NOT YET PERSISTED",
  schema_missing: "SCHEMA MISSING",
  initialization_failed: "INITIALIZATION FAILED",
  not_configured: "NOT CONFIGURED",
  operational: "OPERATIONAL",
  idle: "IDLE",
  degraded: "DEGRADED",
  ready: "READY",
  configured: "CONFIGURED",
  partial: "PARTIAL",
  unconfigured: "UNCONFIGURED",
  online: "ONLINE",
  paired_offline: "PAIRED / OFFLINE",
  unpaired: "UNPAIRED",
  unavailable: "UNAVAILABLE",
  running: "RUNNING",
  unverified: "UNVERIFIED",
  executing: "EXECUTING",
  started_unverified: "STARTED / UNVERIFIED",
  not_started: "NOT STARTED",
  error: "ERROR"
};

function state(value) {
  return LABEL[value] || String(value || "UNKNOWN").toUpperCase();
}

/** Deterministic phone-friendly text. Stable enough to snapshot in tests. */
export function formatSystemStatus(status) {
  const components = status?.components || {};
  const workers = components.workers || { counts: {}, items: [] };
  const counts = workers.counts || {};
  const execution = workers.execution || {};
  const lines = [];
  lines.push("AX SYSTEM STATUS");
  lines.push("Generated: " + (status?.generatedAt || "unknown"));
  lines.push("Backend: " + state(components.backend?.state) + " — " + (components.backend?.detail || "no detail"));
  lines.push(
    "API: " + state(components.api?.state) + " — routes " +
    Object.entries(components.api?.routes || {}).map(([name, mounted]) => name + "=" + (mounted ? "mounted" : "missing")).join(", ")
  );
  const auth = components.authentication || {};
  lines.push(
    "Authentication: " + state(auth.state) + " — axToken=" + (auth.axBridgeTokenConfigured ? "set" : "missing") +
    ", devicePairing=" + (auth.devicePairingDurable ? "durable" : "not durable") +
    ", perDeviceTokens=" + (auth.perDeviceTokens ? "yes" : "no") +
    ", bootstrapCode=" + (auth.bootstrapPairingConfigured ? "set" : "not set") +
    ", ownerDevice=" + (auth.ownerDeviceConfigured ? "set" : "not set")
  );
  const storage = components.storage || {};
  lines.push(
    "Storage: " + state(storage.state) + " — " + (storage.adapter || "unknown") +
    (storage.durable ? " (durable)" : " (not durable)")
  );
  const identity = components.identity;
  if (identity && identity.name) {
    lines.push(
      "Identity: " + identity.name + " " + state(identity.state) +
      " — providerIndependent=" + (identity.providerIndependent ? "yes" : "no") +
      ", persisted=" + (identity.persisted ? "yes" : "no") +
      ", directives=" + (identity.directives?.total ?? 0)
    );
  }
  const missions = components.missions;
  if (missions && missions.flag) {
    lines.push(
      "Missions: " + state(missions.state) +
      " — enabled=" + (missions.enabled ? "yes" : "no") +
      ", initialized=" + (missions.initialized ? "yes" : "no") +
      ", total=" + (missions.counts?.total ?? 0)
    );
  }
  const workforce = components.workforce;
  if (workforce && workforce.flag) {
    lines.push(
      "Workforce: " + state(workforce.state) +
      " — configured=" + (workforce.configured ? "yes" : "no") +
      ", initialized=" + (workforce.initialized ? "yes" : "no") +
      ", enabled=" + (workforce.enabled ? "yes" : "no") +
      ", running=" + (workforce.running ? "yes" : "no") +
      ", verified=" + (workforce.verified ? "yes" : "no")
    );
  }
  lines.push(
    "Workers: " + (counts.registered || 0) + " registered / " +
    (counts.running || 0) + " running / " +
    (counts.healthy || 0) + " healthy / " +
    (counts.unavailable || 0) + " unavailable / " +
    (counts.idle || 0) + " idle / " +
    (counts.unverified || 0) + " unverified"
  );
  for (const item of (workers.items || []).slice(0, 8)) {
    lines.push("  • " + item.id + " — " + state(item.state) + (item.lastRunAt ? " (last " + item.lastStatus + " at " + item.lastRunAt + ")" : " (no run recorded)"));
  }
  lines.push(
    "Execution: " + state(execution.state) + " — " + (execution.detail || "no executor report") +
    (execution.liveWorkers != null ? " liveWorkers=" + execution.liveWorkers : "")
  );
  const device = components.device || {};
  lines.push(
    "Device: " + state(device.state) + " — " + (device.paired || 0) + " paired" +
    (device.lastSeenAt ? ", last check-in " + device.lastSeenAt : ", no check-in recorded")
  );
  const providers = components.providers?.configured || {};
  lines.push(
    "Providers: " + Object.entries(providers).map(([name, isSet]) => name + "=" + (isSet ? "configured" : "missing")).join(", ")
  );
  const required = status?.requiredConfiguration;
  if (required && required.missing?.length) {
    lines.push("Missing configuration: " + required.missing.join(", "));
  }
  lines.push("Not verified here: model inference, worker execution, or a phone round-trip.");
  lines.push("secretsExposed: false");
  return lines.join("\n");
}

/**
 * "ask ax system status", "system status", "backend status", "what is the system status",
 * "show service status". Deliberately narrow: a bare "status" keeps its existing answer.
 */
export function isSystemStatusRequest(message) {
  const normalized = String(message || "")
    .toLowerCase()
    .replace(/[^a-z0-9? ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return (
    /^(?:please\s+)?(?:ask\s+ax\s+(?:for\s+)?)?(?:the\s+)?(?:system|backend|service|platform|habitat)\s+status\b/.test(normalized) ||
    /^(?:please\s+)?(?:ask\s+ax|ax)\s+(?:for\s+)?(?:a\s+)?(?:full\s+)?(?:system\s+|backend\s+)?status\b/.test(normalized) ||
    /^(?:what is|whats|show|give me|report)\s+(?:me\s+)?(?:the\s+)?(?:system|backend|service)\s+status\b/.test(normalized) ||
    /^(?:system|backend)\s+status\s+(?:report|check)\b/.test(normalized)
  );
}

/**
 * Explicit Ax command phrasing only. Implicit chat stays with the model; a command the owner
 * expects to run must be addressed to Ax and bounded, so it cannot silently become a prompt.
 */
export function parseAxCommand(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const prefixed = raw.match(/^(?:ax\s*[:,]\s*|ask\s+ax\s+to\s+)(.+)$/i);
  const invariant = raw.match(/^ax\s+(?:please\s+)?(run|do|execute|check|inspect|verify|report|list|scan|read|explain|summari[sz]e|find)\s+(.+)$/i);
  const objective = (prefixed?.[1] || (invariant ? invariant[1] + " " + invariant[2] : "") || "").trim();
  if (objective.length < 8 || objective.length > 2000) return null;
  return objective;
}

/**
 * Bind only a read-only adapter, and only when the objective clearly names its subject. A task with
 * no adapter cannot be claimed by the Nexus worker, so this is what makes a chat command runnable;
 * a command that matches nothing stays adapter-less and is reported as not runnable, never guessed
 * into a side-effecting tool (none are registered here anyway).
 */
export function inferReadOnlyAdapter(objective) {
  const text = String(objective || "").toLowerCase();
  if (!text) return null;
  if (/\b(repo|repository|code|source|file|files|commit|commits|diff|directory)\b/.test(text)) return "repo.inspect";
  if (/\b(task|tasks|queue|command|commands|job|jobs|objective|objectives)\b/.test(text)) return "task.inspect";
  if (/\b(health|status|worker|workers|runtime|service|backend|probe|diagnostic|diagnostics)\b/.test(text)) return "runtime.health";
  return null;
}
