/**
 * Runtime environment identity and production-database isolation.
 *
 * Both server.mjs and the device command bridge read these helpers, so the service, the health
 * endpoint, and the diagnostics endpoint can never disagree about which environment they are.
 *
 * The rules are deliberately conservative:
 * - An explicit HABITAT_RUNTIME_ENV of "production" or "nonproduction" is authoritative.
 * - Without it, NODE_ENV=production is treated as production (fail-safe), never as nonproduction.
 * - "production D1 conflict" means this process is configured with the exact database id declared
 *   as production. A nonproduction process in that state must not write anywhere.
 */

export const PRODUCTION = "production";
export const NONPRODUCTION = "nonproduction";

export function resolveRuntimeEnvironment(env = process.env) {
  const configured = String(env.HABITAT_RUNTIME_ENV || "").trim().toLowerCase();
  if (configured === PRODUCTION || configured === NONPRODUCTION) return configured;
  const nodeEnvironment = String(env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnvironment === "production" ? PRODUCTION : NONPRODUCTION;
}

export function inspectD1Isolation(env = process.env) {
  const productionDatabaseId = String(env.HABITAT_PRODUCTION_D1_DATABASE_ID || "").trim();
  const configuredDatabaseId = String(env.HABITAT_D1_DATABASE_ID || "").trim();
  return {
    productionDatabaseId,
    configuredDatabaseId,
    productionDatabaseConfigured: Boolean(productionDatabaseId),
    databaseConfigured: Boolean(configuredDatabaseId),
    productionD1Conflict: Boolean(productionDatabaseId && configuredDatabaseId === productionDatabaseId)
  };
}

export function serviceName(env = process.env) {
  return String(env.HABITAT_SERVICE_NAME || "").trim() || "habitat";
}

/**
 * A nonproduction process may not hold production D1 credentials at all. Removing them from the
 * process environment is the only enforcement that also covers repositories created later
 * (tasks, content jobs, secret vault, Nexus), not just the ones constructed at startup.
 *
 * Returns true when credentials were sealed.
 */
export function sealProductionD1(env = process.env) {
  const environment = resolveRuntimeEnvironment(env);
  const isolation = inspectD1Isolation(env);
  if (environment === PRODUCTION || !isolation.productionD1Conflict) return false;
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]) {
    delete env[key];
  }
  return true;
}
