/**
 * Safe operational diagnostics.
 *
 * The rule this module exists to enforce: a *configured* integration is not a *healthy* one.
 * Provider keys being present says nothing about whether an account works. So every section reports
 * the result of an actual probe (`reachable`, `available`) or an explicit `unchecked`/`not_configured`
 * state — never a green light derived from configuration alone.
 *
 * Nothing here reads or returns a secret. Probes receive live handles, not `env` values; the only
 * environment-derived fields are a bounded commit hash and a version string. Each probe is wrapped so
 * one unreachable subsystem produces a typed `unavailable` section instead of failing the endpoint.
 */

export const DIAGNOSTICS_SCHEMA_VERSION = 1;
const DEFAULT_PROBE_TIMEOUT_MS = 4000;

function clean(value, max) {
  return String(value ?? "").replace(/[^A-Za-z0-9._:+-]/g, "").slice(0, max);
}

/** A readable, bounded probe error. Secrets are removed; the sentence stays legible. */
function safeMessage(value) {
  return String(value ?? "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted]")
    .trim()
    .slice(0, 160);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("probe_timeout")), ms);
    })
  ]);
}

async function probe(fn, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  try {
    return { ok: true, value: await withTimeout(fn(), timeoutMs) };
  } catch (error) {
    return { ok: false, code: safeMessage(error?.message) || "probe_failed" };
  }
}

function resolve(value) {
  try {
    return typeof value === "function" ? value() : value;
  } catch {
    return null;
  }
}

export function createAxDiagnostics({
  env = {},
  version = "unknown",
  project = "habitat",
  engine = null,
  memory = null,
  notifications = null,
  providerConfig = null,
  orchestrator = null,
  presence = null,
  deviceBridge = null,
  sandbox = null,
  // Optional Mission 10 capability report (objectives, agents, incidents). It is awaited because
  // those counts come from durable stores; a failure is reported, never replaced with zeros.
  capabilities = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  now = () => new Date().toISOString()
} = {}) {
  return async function diagnostics() {
    const [databaseProbe, memoryProbe, notificationProbe, sandboxProbe, presenceProbe, deviceProbe] = await Promise.all([
      probe(async () => {
        if (!engine || typeof engine.get !== "function") return { status: "not_configured" };
        // A read of a task id that cannot exist proves the store answers. `not_found` is the healthy
        // answer; a thrown error is an outage.
        const outcome = await engine.get("__habitat_diagnostics_probe__");
        if (outcome?.ok === true) return { status: "reachable" };
        if (outcome?.code === "not_found") return { status: "reachable" };
        return { status: "unreachable", detail: outcome?.code || "unexpected_answer" };
      }, { timeoutMs }),

      probe(async () => {
        if (!memory || typeof memory.stats !== "function") return { status: "not_configured" };
        const stats = await memory.stats({ project });
        return { status: "available", active: Number(stats?.active || 0), deleted: Number(stats?.deleted || 0), kinds: Object.keys(stats?.byKind || {}).length };
      }, { timeoutMs }),

      probe(async () => {
        if (!notifications || typeof notifications.stats !== "function") return { status: "not_configured" };
        const stats = await notifications.stats();
        if (stats?.ok === false) return { status: "unavailable", detail: stats.code || "stats_failed" };
        return { status: "recorded_only", byStatus: stats?.byStatus || {}, total: Number(stats?.total || 0) };
      }, { timeoutMs }),

      probe(async () => {
        if (typeof sandbox !== "function") return { status: "unchecked" };
        const verdict = await sandbox();
        return {
          status: verdict?.available ? "available" : "unavailable",
          available: Boolean(verdict?.available),
          reason: verdict?.reason || null,
          missing: Array.isArray(verdict?.missing) ? verdict.missing.slice(0, 8) : []
        };
      }, { timeoutMs }),

      probe(async () => {
        const runtime = resolve(presence);
        if (!runtime || typeof runtime.presence !== "function") {
          return { executor: { configured: false, started: false, state: "not_mounted" }, heartbeat: null, queue: null, canExecute: false };
        }
        return await runtime.presence();
      }, { timeoutMs }),

      probe(async () => {
        const bridge = resolve(deviceBridge);
        if (!bridge) return { status: "not_configured" };
        const status = typeof bridge.status === "function" ? bridge.status() : bridge;
        return {
          status: status?.ready ? "ready" : "not_ready",
          ready: Boolean(status?.ready),
          durable: Boolean(status?.durable),
          axTokenConfigured: Boolean(status?.axTokenConfigured),
          perDeviceTokens: Boolean(status?.perDeviceTokens)
        };
      }, { timeoutMs })
    ]);

    let capabilityReport = null;
    if (capabilities) {
      try {
        capabilityReport = typeof capabilities === "function" ? await capabilities() : capabilities;
      } catch (error) {
        capabilityReport = { status: "unavailable", detail: safeMessage(error?.message) || "capability_probe_failed" };
      }
    }

    const config = resolve(providerConfig);
    const agent = resolve(orchestrator);
    const providers = config?.summary
      ? {
          enabled: Boolean(config.enabled),
          code: config.code || null,
          configured: config.summary.filter(provider => provider.configured).map(provider => provider.name),
          primary: config.primary ? { name: config.primary.name, model: config.primary.model, configured: Boolean(config.primary.configured) } : null,
          fallbacks: (config.fallbacks || []).map(provider => ({ name: provider.name, model: provider.model, configured: Boolean(provider.configured) })),
          // Configuration is not a health check. No live provider call is made here because that
          // spends money and would make a diagnostics read a cost event.
          health: {
            checked: false,
            note: "Configuration only. No live model call was made; this does not prove the account or quota works."
          }
        }
      : { enabled: false, code: config?.code || "provider_not_configured", configured: [], primary: null, fallbacks: [], health: { checked: false, note: "No provider configuration is available." } };

    const presenceValue = presenceProbe.ok ? presenceProbe.value : null;

    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      generatedAt: now(),
      application: {
        version: clean(version, 32) || "unknown",
        commit: clean(env.HABITAT_COMMIT_SHA, 40) || "unknown",
        runtime: "node",
        node: clean(process.version, 16)
      },
      database: databaseProbe.ok ? databaseProbe.value : { status: "unreachable", detail: databaseProbe.code },
      memory: memoryProbe.ok ? memoryProbe.value : { status: "unavailable", detail: memoryProbe.code },
      providers,
      orchestrator: agent
        ? {
            enabled: Boolean(agent.enabled),
            code: agent.code || null,
            model: agent.model || null,
            budgetUsd: agent.budgetUsd ?? null,
            adapters: Array.isArray(agent.adapters) ? agent.adapters.slice(0, 8) : []
          }
        : { enabled: false, code: "orchestrator_not_mounted", model: null, budgetUsd: null, adapters: [] },
      workers: {
        probe: presenceProbe.ok ? "ok" : "unavailable",
        detail: presenceValue || null
      },
      scheduler: {
        mode: "one_shot_tick",
        mounted: Boolean(presenceValue?.executor?.configured),
        started: Boolean(presenceValue?.executor?.started),
        state: presenceValue?.executor?.state || "unknown",
        canExecute: Boolean(presenceValue?.canExecute)
      },
      sandbox: sandboxProbe.ok ? sandboxProbe.value : { status: "unavailable", detail: sandboxProbe.code },
      notifications: notificationProbe.ok
        ? { ...notificationProbe.value, channels: ["inbox"], externalTransport: false }
        : { status: "unavailable", detail: notificationProbe.code, channels: ["inbox"], externalTransport: false },
      deviceBridge: deviceProbe.ok ? deviceProbe.value : { status: "unavailable", detail: deviceProbe.code },
      capabilities: capabilityReport || { status: "not_configured" },
      secretsExposed: false
    };
  };
}
